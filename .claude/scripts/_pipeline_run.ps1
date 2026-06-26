# _pipeline_run.ps1 - Pipeline 完整執行（「開工」hook 觸發用）
# 依序執行 analysis → coding → qa，輸出 stdout 供 Claude context 注入

. (Join-Path $PSScriptRoot "_common.ps1")

if (-not $env:ODOO_PASSWORD) {
    Write-Host "[ERROR] 環境變數 ODOO_PASSWORD 未設定，Pipeline 中止。" -ForegroundColor Red
    exit 1
}

# ============================================================
# Loop Counter 管理（防死循環）
# max loop_count = 20；task_reentries 由 BackToConfirm 寫入 system/_reentry_count
# ============================================================
$counterFile = Join-Path $script:PLAN_DIR "_LOOP_COUNTER.json"
$loopCount   = 0
$startedAt   = Get-Date -Format 'o'

if (Test-Path $counterFile) {
    try {
        $existing  = Get-Content $counterFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $startedAt = $existing.run_started_at
        $loopCount = [int]$existing.loop_count + 1
    } catch {}
}

# 讀取各任務的重入次數（由 BackToConfirm 持久化到 system/_reentry_count）
$taskReentries = @{}
Get-ChildItem $script:PLAN_DIR -Recurse -Filter "_reentry_count" -ErrorAction SilentlyContinue | ForEach-Object {
    $tid = Split-Path (Split-Path $_.FullName -Parent) -Leaf
    if ($tid -match '^task_(odoo_|service_)?\d+$') {
        try { $taskReentries[$tid] = [int](Get-Content $_.FullName -Raw -EA SilentlyContinue) } catch {}
    }
}

# Loop 上限（可由環境變數覆蓋，方便 debug）
$maxLoops    = if ($env:PIPELINE_MAX_LOOPS)    { [int]$env:PIPELINE_MAX_LOOPS }    else { 20 }
$maxReentries = if ($env:PIPELINE_MAX_REENTRIES) { [int]$env:PIPELINE_MAX_REENTRIES } else { 2 }

# 檢查 loop_count 上限
if ($loopCount -gt $maxLoops) {
    $firstPending = Get-ChildItem $script:PLAN_DIR -Recurse -Filter "pending_prompt.txt" `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    $blockerContent = @"
blocker_type: loop
task_id: unknown
timestamp: $(Get-Date -Format 'o')
loop_count: $loopCount
limit: $maxLoops
limit_exceeded: loop_count
reason: |
  Pipeline 循環次數超過安全上限 (loop_count=$loopCount > $maxLoops)，自動停止以防死循環。
  run_started_at: $startedAt
last_pending_tasks:
  - $(if ($firstPending) { $firstPending.FullName } else { 'none' })
action_required: |
  1. 確認任務是否有循環觸發條件
  2. 手動解決問題後刪除此 blocker 檔案
  3. 刪除 _LOOP_COUNTER.json 重置計數器
  4. 重新執行 pipeline
"@
    if ($firstPending) {
        $taskDir = Split-Path (Split-Path $firstPending.FullName -Parent) -Parent
        $sysDir  = Join-Path $taskDir "system"
        if (-not (Test-Path $sysDir)) { New-Item -ItemType Directory -Force $sysDir | Out-Null }
        [System.IO.File]::WriteAllText(
            (Join-Path $sysDir "blocker.loop.txt"),
            $blockerContent,
            [System.Text.Encoding]::UTF8
        )
        Write-Host "[CRITICAL] blocker.loop.txt 已寫入: $sysDir" -ForegroundColor Red
    }
    Write-Host "[CRITICAL] Pipeline loop_count=$loopCount 超過上限 $maxLoops，中止。" -ForegroundColor Red
    # 清除 WAITING flag 避免 Claude 再度觸發
    Remove-Item $script:PIPELINE_WAITING -Force -ErrorAction SilentlyContinue
    Remove-Item $counterFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# 檢查各任務重入次數上限
foreach ($tid in @($taskReentries.Keys)) {
    if ($taskReentries[$tid] -gt $maxReentries) {
        $reentryDirs = Get-ChildItem $script:PLAN_DIR -Recurse -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $tid }
        $taskDir = if ($reentryDirs) { $reentryDirs[0].FullName } else { $null }
        $blockerMsg = @"
blocker_type: loop
task_id: $tid
timestamp: $(Get-Date -Format 'o')
loop_count: $loopCount
task_reentries: $($taskReentries[$tid])
limit: $maxReentries
limit_exceeded: task_reentry
reason: |
  $tid 已從 QA 失敗退回 $($taskReentries[$tid]) 次，超過上限 $maxReentries。
  任務可能陷入反覆 BackToConfirm → rework 循環。
action_required: |
  1. 查看任務目錄內的 log/qa_report.yaml 和 analysis.yaml
  2. 手動修正根本原因後刪除此 blocker 檔案與 system/_reentry_count
  3. 刪除 _LOOP_COUNTER.json 重置計數器
  4. 重新執行 pipeline
"@
        if ($taskDir) {
            $sysDir = Join-Path $taskDir "system"
            if (-not (Test-Path $sysDir)) { New-Item -ItemType Directory -Force $sysDir | Out-Null }
            [System.IO.File]::WriteAllText(
                (Join-Path $sysDir "blocker.loop.txt"),
                $blockerMsg,
                [System.Text.Encoding]::UTF8
            )
            Write-Host "[WARN] $tid 重入次數=$($taskReentries[$tid]) 超過 $maxReentries，已升級為 blocker.loop.txt" -ForegroundColor Yellow
        }
    }
}

# 儲存更新後的計數器
$counterObj = [PSCustomObject]@{
    run_started_at = $startedAt
    loop_count     = $loopCount
}
try { $counterObj | ConvertTo-Json -Depth 5 | Out-File $counterFile -Encoding UTF8 -Force } catch {}

Write-Host "=== Pipeline 開工 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan
Write-Host "[LOOP] loop_count=$loopCount / $maxLoops，run_started_at=$startedAt" -ForegroundColor DarkCyan

# ============================================================
# Git Pull（第一輪才執行：只 pull 待處理任務用到的 repo）
# ============================================================
if ($loopCount -eq 0) {
    Write-Host "`n[GIT-PULL] 掃描待處理任務的 repo..." -ForegroundColor Cyan

    # 收集所有 stage 下任務需要的 repo 路徑
    $repoTasks = @{}  # repo_path -> [taskDir, ...]
    $stageDirs = @($script:CONFIRM_DIR, $script:ANALYSIS_DIR, $script:CODING_DIR)
    foreach ($stageDir in $stageDirs) {
        if (-not (Test-Path $stageDir)) { continue }
        Get-ChildItem $stageDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^task_(odoo_|service_)?\d+$' } |
            ForEach-Object {
                $taskDir  = $_.FullName
                $yamlPath = Join-Path $taskDir "analysis.yaml"
                if (-not (Test-Path $yamlPath)) { return }
                $yc = Get-Content $yamlPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if (-not $yc) { return }
                $parsed = ConvertFrom-Yaml $yc
                $ov = $parsed['odoo_version']
                if (-not $ov) { return }
                $pn = $parsed['project_name']
                $repoPath = Get-OnlineAddonsRoot -odooVersion $ov -projectName $pn
                if (-not (Test-Path (Join-Path $repoPath ".git"))) { return }
                if (-not $repoTasks.ContainsKey($repoPath)) { $repoTasks[$repoPath] = @() }
                $repoTasks[$repoPath] = @($repoTasks[$repoPath]) + $taskDir
            }
    }

    if ($repoTasks.Count -eq 0) {
        Write-Host "  [SKIP] 目前無可判斷 repo 的待處理任務" -ForegroundColor DarkGray
    } else {
        $pullFailedRepos = @()
        foreach ($repoPath in $repoTasks.Keys) {
            $repoName = Split-Path $repoPath -Leaf
            Write-Host "  git pull: $repoPath" -ForegroundColor DarkCyan
            $output = git -C $repoPath pull 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [ERROR] git pull 失敗 ($repoName):`n  $($output -join "`n  ")" -ForegroundColor Red
                $pullFailedRepos += $repoPath
                foreach ($tDir in @($repoTasks[$repoPath])) {
                    $tName  = Split-Path $tDir -Leaf
                    $sysDir = Get-SystemDir $tDir
                    if (-not (Test-Path $sysDir)) { New-Item -ItemType Directory -Force $sysDir | Out-Null }
                    $errText = ($output -join "`n  ") -replace "'", "''"
                    $bc = "blocker_type: git`ntask_id: $tName`ntimestamp: $(Get-Date -Format 'o')`nrepo: '$repoPath'`nerror: |`n  $errText`naction_required: |`n  git pull $repoName 失敗，請手動更新後刪除此 blocker，重新執行「開工」"
                    Atomic-WriteFile (Join-Path $sysDir "blocker.git.txt") $bc | Out-Null
                    Write-Host "  [BLOCKER] $tName 已標記 blocker.git.txt" -ForegroundColor Yellow
                }
            } else {
                Write-Host "  OK $repoName" -ForegroundColor Green
            }
        }

        if ($pullFailedRepos.Count -gt 0) {
            Write-Host "`n[GIT-PULL] 警告：以下 repo pull 失敗，相關任務已標記 blocker，其餘任務繼續執行：" -ForegroundColor Yellow
            $pullFailedRepos | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
            Write-Host ""
        } else {
            Write-Host "[GIT-PULL] 全部同步完成`n" -ForegroundColor Green
        }
    }
}

# ============================================================
# Blocker Resume（人工修完後 touch system/.blocker_resolved 重啟）
# ============================================================
Write-Host "`n[RESUME] 掃描 .blocker_resolved 標記..." -ForegroundColor Cyan
$resolvedCount = 0
Get-ChildItem $script:PLAN_DIR -Recurse -Filter ".blocker_resolved" -ErrorAction SilentlyContinue | ForEach-Object {
    $sysDir   = Split-Path $_.FullName -Parent
    $taskDir  = Split-Path $sysDir -Parent
    $taskName = Split-Path $taskDir -Leaf

    # P1-03: 排除 final/ 與 stop/ 目錄（歸檔/停止任務不應被 resume 掃描）
    if ($taskDir -like "*$($script:FINAL_DIR)*" -or $taskDir -like "*$($script:STOP_DIR)*") {
        Write-Host "[SKIP] $taskName 在 final/ 或 stop/，忽略 .blocker_resolved" -ForegroundColor DarkGray
        return
    }

    $blockers = Get-ChildItem $sysDir -Filter "blocker.*.txt" -ErrorAction SilentlyContinue
    $refused  = $false
    foreach ($b in @($blockers)) {
        # P0-02: blocker.loop → 計數器未重置則拒絕 resume，防止立即再觸發上限
        if ($b.Name -eq 'blocker.loop.txt') {
            if (Test-Path $counterFile) {
                try {
                    $cf = Get-Content $counterFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ([int]$cf.loop_count -gt $maxLoops) {
                        Write-Host "[REFUSE] $taskName blocker.loop resume 被拒：_LOOP_COUNTER.json 計數未重置（loop_count=$($cf.loop_count) > $maxLoops），請先刪除 _LOOP_COUNTER.json" -ForegroundColor Red
                        $refused = $true
                    }
                } catch {}
            }
        }
        # P0-02: blocker.spec → 警告 analysis.yaml 若未更新
        if ($b.Name -eq 'blocker.spec.txt' -and -not $refused) {
            $yamlPath = Join-Path $taskDir "analysis.yaml"
            if ((Test-Path $yamlPath) -and (Test-Path $b.FullName)) {
                if ((Get-Item $yamlPath).LastWriteTime -le $b.LastWriteTime) {
                    Write-Host "[WARN] $taskName blocker.spec resume：analysis.yaml mtime 未更新，規格可能未修補" -ForegroundColor Yellow
                }
            }
        }
        if (-not $refused) {
            Remove-Item $b.FullName -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $refused) {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        Write-Host "[RESUME] $taskName blocker 已清除，重新加入佇列" -ForegroundColor Green
        $resolvedCount++
    }
}
if ($resolvedCount -eq 0) { Write-Host "[RESUME] 無需恢復的任務" -ForegroundColor DarkGray }

# 設定 hook 模式，讓子程序的 Open-ClaudeTerminal 略過開新 terminal
$env:PIPELINE_HOOK_MODE = "1"

Write-Host "`n--- STEP 1-3: 需求分析 (analysis.ps1) ---" -ForegroundColor Yellow
pwsh -NoProfile -File (Join-Path $PSScriptRoot "analysis.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ABORT] analysis.ps1 失敗 (exit $LASTEXITCODE)，中止 pipeline。" -ForegroundColor Red
    Remove-Item env:PIPELINE_HOOK_MODE -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}

Write-Host "`n--- STEP 4: 實作 (coding.ps1) ---" -ForegroundColor Yellow
pwsh -NoProfile -File (Join-Path $PSScriptRoot "coding.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ABORT] coding.ps1 失敗 (exit $LASTEXITCODE)，中止 pipeline。" -ForegroundColor Red
    Remove-Item env:PIPELINE_HOOK_MODE -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}

Write-Host "`n--- STEP 5-6: QA (qa.ps1) ---" -ForegroundColor Yellow
pwsh -NoProfile -File (Join-Path $PSScriptRoot "qa.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ABORT] qa.ps1 失敗 (exit $LASTEXITCODE)，中止 pipeline。" -ForegroundColor Red
    Remove-Item env:PIPELINE_HOOK_MODE -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}

Remove-Item env:PIPELINE_HOOK_MODE -ErrorAction SilentlyContinue

# 統計待 Claude 處理的任務（排除 final/ 與 stop/，與 Resume 掃描一致）
$pendingFiles = Get-ChildItem $script:PLAN_DIR -Recurse -Filter "pending_prompt.txt" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike "*$($script:STOP_DIR)*" -and $_.FullName -notlike "*$($script:FINAL_DIR)*" }
$pendingCount = if ($pendingFiles) { @($pendingFiles).Count } else { 0 }

if ($pendingCount -gt 0) {
    [System.IO.File]::WriteAllText(
        $script:PIPELINE_WAITING,
        (Get-Date -Format 'o'),
        [System.Text.Encoding]::UTF8
    )
    Write-Host "`n=== Pipeline 機械工作完成 ===" -ForegroundColor Cyan
    Write-Host "待 Claude 處理: $pendingCount 個任務" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "[CLAUDE-ACTION-REQUIRED]" -ForegroundColor Magenta
    Write-Host "直接 spawn 下列 Agent，stage 與 agent 已確認，勿再探索檔案：" -ForegroundColor Magenta
    Write-Host ""
    foreach ($f in $pendingFiles) {
        $taskDir  = Split-Path (Split-Path $f.FullName -Parent) -Parent
        $taskId   = Split-Path $taskDir -Leaf
        $sysDir   = Join-Path $taskDir "system"
        $stageDir = Split-Path (Split-Path $taskDir -Parent) -Leaf

        $stage = switch ($stageDir) {
            "confirm"  { "analysis" }
            "analysis" { "final" }
            "coding"   {
                # 優先用 done marker 交叉驗證（防 crash 後 .pending_* 遺失導致 spawn 錯 agent）
                $implementDone = Join-Path $sysDir ".implement_done"
                $qaDoneFile    = Join-Path $sysDir ".qa_done"
                if ((Test-Path $implementDone) -and -not (Test-Path $qaDoneFile)) {
                    "qa"
                } else {
                    $flag = Get-ChildItem $sysDir -Filter ".pending_*" -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($flag -and $flag.Name -eq ".pending_qa") { "qa" } else { "coding" }
                }
            }
            default    { "unknown" }
        }
        $agent = switch ($stage) {
            "analysis" { "requirements-analyst" }
            "final"    { "requirements-analyst" }
            "coding"   { "senior-software-engineer" }
            "qa"       { "qa-analyst" }
            default    { "unknown" }
        }
        Write-Host "  task_id=$taskId  stage=$stage  agent=$agent" -ForegroundColor White
        Write-Host "  prompt=$($f.FullName)" -ForegroundColor DarkGray
        Write-Host ""
    }
    Write-Host "每個 Agent 自行完成原子協議（done marker → mv pending_prompt.txt → 刪 .pending_* flag）。" -ForegroundColor Yellow
    Write-Host "全部完成後執行 pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot '_pipeline_run.ps1')`" 推進 Pipeline。" -ForegroundColor Yellow
} else {
    Remove-Item $script:PIPELINE_WAITING -Force -ErrorAction SilentlyContinue
    Remove-Item $counterFile -Force -ErrorAction SilentlyContinue
    Write-Host "`n=== Pipeline 完成，無待處理任務 ===" -ForegroundColor Green
}

# ============================================================
# Pipeline Run Summary（每次 run 結束寫入統計）
# ============================================================
$runEndTime  = Get-Date -Format 'o'
$summaryDir  = Join-Path $script:PLAN_DIR "log"
if (-not (Test-Path $summaryDir)) { New-Item -ItemType Directory -Force $summaryDir | Out-Null }

$summaryLines = @(
    "run_id: '$startedAt'",
    "run_ended_at: '$runEndTime'",
    "loop_count: $loopCount",
    "tasks_pending_ai: $pendingCount",
    "tasks_in_pipeline:"
)
$stageRoots = @($script:CONFIRM_DIR, $script:ANALYSIS_DIR, $script:CODING_DIR)
foreach ($root in $stageRoots) {
    if (-not (Test-Path $root)) { continue }
    $stageName = Split-Path $root -Leaf
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^task_(odoo_|service_)?\d+$' } | ForEach-Object {
        $hasBlocker = [bool](Get-ChildItem (Join-Path $_.FullName "system") -Filter "blocker.*.txt" -ErrorAction SilentlyContinue | Select-Object -First 1)
        $hasPending = Test-Path (Join-Path $_.FullName "system" "pending_prompt.txt")
        $st = if ($hasBlocker) { "blocker" } elseif ($hasPending) { "pending_ai" } else { "idle" }
        $summaryLines += "  - task_id: '$($_.Name)'"
        $summaryLines += "    stage: '$stageName'"
        $summaryLines += "    status: '$st'"
    }
}
Atomic-WriteFile (Join-Path $summaryDir "pipeline_run_summary.yaml") ($summaryLines -join "`n") | Out-Null
Write-Host "[SUMMARY] 已寫入 log/pipeline_run_summary.yaml" -ForegroundColor DarkCyan
