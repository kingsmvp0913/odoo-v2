# qa.ps1 - 品管階段主程式（Steps 5–6）
# PS1 僅負責機械工作；AI QA 由 Claude terminal 非同步執行

. (Join-Path $PSScriptRoot "_common.ps1")

Initialize-PipelineDirs

$agentDir      = if ($env:PIPELINE_AGENTS_DIR) { $env:PIPELINE_AGENTS_DIR } else { Join-Path $script:CLAUDE_DIR "agents" }
$tomlPath      = Join-Path $agentDir "qa-analyst.toml"
$mdPath        = Join-Path $agentDir "qa-analyst.md"
$agentPath     = if (Test-Path $tomlPath) { $tomlPath } else { $mdPath }
$agentRaw      = Get-Content $agentPath -Raw -Encoding UTF8
$agentTemplate = if ($agentPath -like "*.toml") { Get-TomlPromptContent $agentRaw } else { $agentRaw -replace '(?s)^---.*?---\r?\n', '' }

# ============================================================
# STEP 5: coding/ → 寫 QA pending prompt（不等 AI）
# Module 序列鎖：同一模組只啟動一個 QA 任務
# ============================================================
Write-Host "[STEP 5] 準備 QA 任務..." -ForegroundColor Cyan

$qaModulePending = @{}
$codingTasks = Get-ChildItem $script:CODING_DIR -Directory -ErrorAction SilentlyContinue

foreach ($taskDir in $codingTasks) {
    $taskName         = $taskDir.Name
    $taskLock         = Join-Path $taskDir.FullName "process.lock"
    $implementDone    = Join-Path (Get-SystemDir $taskDir.FullName) ".implement_done"
    $qaDone           = Join-Path (Get-SystemDir $taskDir.FullName) ".qa_done"
    $analysisYamlPath = Join-Path $taskDir.FullName "analysis.yaml"

    if (Test-HasBlocker $taskDir.FullName) {
        Write-Host "[BLOCKER] $taskName 已有 blocker 檔案，跳過（需人工處理）" -ForegroundColor Red
        continue
    }

    # P0-03: done marker 存在但 pending 殘留 → 補完原子協議，不重新執行
    Resolve-CrashState -taskDir $taskDir.FullName -stage "qa" -doneMarker ".qa_done"

    if (-not (Test-Path $implementDone)) { continue }
    if (Test-Path $qaDone)               { continue }

    # 已有 pending prompt，等待 Claude 處理（超過 30 分鐘則清除重新排隊）
    if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt")) {
        if (Test-PendingStale $taskDir.FullName) {
            Clear-StalePending $taskDir.FullName
        } else {
            Write-Host "[WAIT] $taskName - Claude QA 中" -ForegroundColor DarkGray
            continue
        }
    }

    if (-not (Test-Path $analysisYamlPath)) {
        Write-Host "[ERROR] $taskName 缺少 analysis.yaml" -ForegroundColor Red; continue
    }

    if (-not (Acquire-Lock $taskLock 300)) {
        Write-Host "[SKIP] $taskName 已被鎖定" -ForegroundColor Yellow; continue
    }

    try {
        $yamlContent = Get-Content $analysisYamlPath -Raw -Encoding UTF8
        $parsed      = ConvertFrom-Yaml $yamlContent

        $moduleName  = $parsed['module']
        $odooVersion = $parsed['odoo_version']
        $projectName = $parsed['project_name']

        if (-not $moduleName) {
            Write-Host "[ERROR] $taskName 無法解析 module 名稱" -ForegroundColor Red; continue
        }

        # NO_CHANGE_NEEDED 快速路徑：直接寫 .qa_done，跳過 QA agent（0 tokens）
        if ($yamlContent -match 'NO_CHANGE_NEEDED') {
            $logDir2  = Get-LogDir    $taskDir.FullName
            $sysDir2  = Get-SystemDir $taskDir.FullName
            $qaRpt    = "status: PASSED`nchecked_at: `"$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')`"`nitems: []`nissues:`n  - severity: warning`n    description: `"SKIP-QA: NO_CHANGE_NEEDED — no code written; QA not applicable`"`n    suggestion: `"`"`n"
            Atomic-WriteFile (Join-Path $logDir2 "qa_report.yaml") $qaRpt | Out-Null
            Atomic-WriteFile (Join-Path $sysDir2 ".qa_done")        ""     | Out-Null
            Release-Lock $taskLock
            Write-Host "[SKIP-QA] $taskName NO_CHANGE_NEEDED → 自動 QA PASS，跳過 QA agent" -ForegroundColor Cyan
            continue
        }

        # Module 序列鎖：同一模組只允許一個 QA 任務並行
        if ($qaModulePending.ContainsKey($moduleName)) {
            Write-Host "[QUEUE] $taskName - 模組 $moduleName QA 序列等待，下輪處理" -ForegroundColor DarkYellow
            continue
        }
        $qaModulePending[$moduleName] = $true

        $modulePath = Get-ModulePath -moduleName $moduleName -odooVersion $odooVersion -projectName $projectName
        Write-Host "[INFO] $taskName 準備 QA: $modulePath" -ForegroundColor DarkCyan

        # [建議3] 萃取 technical_specification 區塊直接注入，省 agent Read 整份 yaml
        $techSpec  = Get-YamlSection -yaml $yamlContent -key 'technical_specification'
        $specBlock = if ($techSpec) {
            "【SPECIFICATION】`n$techSpec"
        } else {
            "【SPECIFICATION】`n讀取 $analysisYamlPath（fallback）。"
        }

        # [建議2] 模組現有檔名清單，省 agent 探測性 find
        $moduleExists      = Test-Path $modulePath
        $moduleStatusBlock = if ($moduleExists) {
            $existingFiles = Get-ChildItem $modulePath -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '\.pyc$' -and $_.FullName -notmatch '__pycache__' } |
                ForEach-Object { ($_.FullName.Substring($modulePath.Length) -replace '^[/\\]+', '').Replace('\', '/') }
            $fileList = if ($existingFiles) { ($existingFiles -join "`n") } else { "(空目錄)" }
            "【MODULE FILES】`n$fileList"
        } else {
            "【MODULE FILES】（模組目錄不存在）"
        }

        $fullPrompt = (Get-McpBudgetBlock) + $agentTemplate +
            "`n`n【TASK DIRECTORY】`n$($taskDir.FullName)" +
            "`n`n$specBlock" +
            "`n`n【IMPLEMENTATION PATH】`n$modulePath" +
            "`n`n$moduleStatusBlock" +
            "`n`n完成後依序：(a) 寫入 log/qa_report.yaml 和 system/.qa_done 到【TASK DIRECTORY】(b) 將 system/pending_prompt.txt 內容寫入 log/done_prompt.txt，然後刪除 system/pending_prompt.txt（移動不是複製，來源必須刪除）(c) 刪除 system/.pending_qa flag。"

        Write-PendingPrompt -taskDir $taskDir.FullName -stage "qa" -prompt $fullPrompt
        Write-Host "[OK] $taskName → 等待 Claude QA 檢查" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] STEP 5 ${taskName}: $_" -ForegroundColor Red
    } finally {
        Release-Lock $taskLock
    }
}

# ============================================================
# STEP 6: 依 QA 報告移至 final/ 或退回 confirm/（無 AI）
# ============================================================
Write-Host "`n[STEP 6] 處理 QA 結果..." -ForegroundColor Cyan

$codingTasks2 = Get-ChildItem $script:CODING_DIR -Directory -ErrorAction SilentlyContinue

foreach ($taskDir in $codingTasks2) {
    $taskName     = $taskDir.Name
    $taskLock     = Join-Path $taskDir.FullName "process.lock"
    $qaDone       = Join-Path (Get-SystemDir $taskDir.FullName) ".qa_done"
    $qaReportPath = Join-Path (Get-LogDir    $taskDir.FullName) "qa_report.yaml"

    if (-not (Test-Path $qaDone))       { continue }
    if (-not (Test-Path $qaReportPath)) { continue }

    # 若 system/pending_prompt.txt 仍存在（QA 尚未完成），跳過（超過 30 分鐘則清除）
    if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt")) {
        if (Test-PendingStale $taskDir.FullName) {
            Clear-StalePending $taskDir.FullName
        } else {
            Write-Host "[WAIT] $taskName - Claude QA 尚未完成" -ForegroundColor DarkGray
            continue
        }
    }

    if (-not (Acquire-Lock $taskLock 300)) {
        Write-Host "[SKIP] $taskName 已被鎖定" -ForegroundColor Yellow; continue
    }

    try {
        $qaReport = Get-Content $qaReportPath -Raw -Encoding UTF8
        $parsed   = ConvertFrom-Yaml $qaReport
        $status   = $parsed['status']

        if ($status -eq "PASSED") {
            Release-Lock $taskLock
            $dest = Join-Path $script:FINAL_DIR $taskName
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            Move-Item $taskDir.FullName $script:FINAL_DIR -Force
            Write-Host "[OK] $taskName QA 通過 → final/" -ForegroundColor Green

            # if ($taskName -match '^task_(odoo_|service_)?\d+$') {
            #     Send-OdooTaskMessage -taskDirName $taskName -message "<p>【Pipeline】任務已完成，請查看 final/$taskName/</p>"
            # }
        } else {
            # 從 issues: 區塊取得第一個 description（支援單行與 block scalar |/>）
            $reason = $null
            $afterIssues = if ($qaReport -match '(?s)issues:\s*(.*)') { $matches[1] } else { "" }
            if ($afterIssues -match '(?m)^\s*description:\s*"?([^"\r\n]+?)"?\s*$') {
                # 單行格式：description: "text"
                $reason = $matches[1].Trim().Trim('"').Trim("'")
            } elseif ($afterIssues -match '(?m)^\s*description:\s*[|>][-+]?\s*[\r\n]+((?:[ \t]+[^\r\n]+[\r\n]*)+)') {
                # block scalar 格式：description: |\n  text\n  more text
                $reason = ($matches[1] -split '[\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ' '
                if ($reason.Length -gt 120) { $reason = $reason.Substring(0, 117) + '...' }
            }
            # BUG-6：description 解析失敗時注入整個 issues 區塊，確保 agent 下輪有具體失敗資訊
            if (-not $reason) {
                $issuesRaw = $afterIssues.Trim()
                $reason    = if ($issuesRaw.Length -gt 400) { $issuesRaw.Substring(0, 397) + '...' } else { $issuesRaw }
                if (-not $reason) { $reason = "qa_report issues 區塊為空，請查看 log/qa_report.yaml" }
            }

            Release-Lock $taskLock
            BackToConfirm -taskDir $taskDir.FullName -reason $reason -stage "QA"
        }
    } catch {
        Write-Host "[ERROR] STEP 6 ${taskName}: $_" -ForegroundColor Red
    } finally {
        if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
    }
}

Open-ClaudeTerminal
Write-Host "`n[qa.ps1 完成]" -ForegroundColor Green
