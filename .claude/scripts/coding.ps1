# coding.ps1 - 實作階段主程式（Step 4）
# PS1 僅負責機械工作（檔案管理）；AI 呼叫由 Claude terminal 非同步執行

. (Join-Path $PSScriptRoot "_common.ps1")

Initialize-PipelineDirs

Write-Host "[STEP 4] 準備實作任務（analysis/ → coding/）..." -ForegroundColor Cyan

$agentDir      = if ($env:PIPELINE_AGENTS_DIR) { $env:PIPELINE_AGENTS_DIR } else { Join-Path $script:CLAUDE_DIR "agents" }
$tomlPath      = Join-Path $agentDir "senior-software-engineer.toml"
$mdPath        = Join-Path $agentDir "senior-software-engineer.md"
$agentPath     = if (Test-Path $tomlPath) { $tomlPath } else { $mdPath }
$agentRaw      = Get-Content $agentPath -Raw -Encoding UTF8
$agentTemplate = if ($agentPath -like "*.toml") { Get-TomlPromptContent $agentRaw } else { $agentRaw -replace '(?s)^---.*?---\r?\n', '' }

# Module 序列鎖：收集 coding/ 中已有活動任務的模組（不重複處理同一模組）
$activeModules = @{}
Get-ChildItem $script:CODING_DIR -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $yamlPath = Join-Path $_.FullName "analysis.yaml"
    if (Test-Path $yamlPath) {
        try {
            $p = ConvertFrom-Yaml (Get-Content $yamlPath -Raw -Encoding UTF8)
            if ($p['module']) { $activeModules[$p['module']] = $true }
        } catch {}
    }
}

$analysisTasks = Get-ChildItem $script:ANALYSIS_DIR -Directory -ErrorAction SilentlyContinue

foreach ($taskDir in $analysisTasks) {
    $taskName         = $taskDir.Name
    $taskLock         = Join-Path $taskDir.FullName "process.lock"
    $finalDone        = Join-Path (Get-SystemDir $taskDir.FullName) ".final_done"
    $implementDone    = Join-Path (Get-SystemDir $taskDir.FullName) ".implement_done"
    $analysisYamlPath = Join-Path $taskDir.FullName "analysis.yaml"

    if (Test-HasBlocker $taskDir.FullName) {
        Write-Host "[BLOCKER] $taskName 已有 blocker 檔案，跳過（需人工處理）" -ForegroundColor Red
        continue
    }

    # P0-03: done marker 存在但 pending 殘留 → 補完原子協議，不重新執行
    Resolve-CrashState -taskDir $taskDir.FullName -stage "coding" -doneMarker ".implement_done"

    if (-not (Test-Path $finalDone))  { continue }
    if (Test-Path $implementDone)     { continue }

    # 已有 pending prompt，等待 Claude 處理（超過 30 分鐘則清除重新排隊）
    if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt")) {
        if (Test-PendingStale $taskDir.FullName) {
            Clear-StalePending $taskDir.FullName
        } else {
            Write-Host "[WAIT] $taskName - Claude 實作中" -ForegroundColor DarkGray
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

        # ALREADY_IMPLEMENTED / NO_CHANGE_NEEDED：無需任何程式碼變更，直接寫 .implement_done + 自動 QA PASS，跳過 QA agent
        $skipCoding  = ($yamlContent -match 'ALREADY_IMPLEMENTED') -or ($yamlContent -match 'NO_CHANGE_NEEDED')
        $skipReason  = if ($yamlContent -match 'NO_CHANGE_NEEDED') { "分析確認無需修改" } else { "需求已實作" }
        if ($skipCoding) {
            Atomic-WriteFile $implementDone "" | Out-Null

            # 自動 QA PASS：無新代碼，直接寫 qa_report.yaml + .qa_done，略過 QA agent
            $logDir     = Get-LogDir    $taskDir.FullName
            $sysDir     = Get-SystemDir $taskDir.FullName
            $qaReport   = "status: PASSED`nchecked_at: `"$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')`"`nitems: []`nissues:`n  - severity: warning`n    description: `"SKIP-QA: $skipReason — no new code written; code quality checks not applicable`"`n    suggestion: `"`"`n"
            Atomic-WriteFile (Join-Path $logDir  "qa_report.yaml") $qaReport | Out-Null
            Atomic-WriteFile (Join-Path $sysDir  ".qa_done")        ""         | Out-Null

            Release-Lock $taskLock
            $dest = Join-Path $script:CODING_DIR $taskName
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            try {
                Move-Item $taskDir.FullName $script:CODING_DIR -Force
                Write-Host "[SKIP-CODING] $taskName $skipReason → coding/ (自動 QA PASS)" -ForegroundColor Cyan
            } catch {
                Write-Host "[ERROR] $taskName Move 失敗: $_" -ForegroundColor Red
                Remove-Item $implementDone -Force -ErrorAction SilentlyContinue
            }
            continue
        }

        if (-not (Test-YamlComplete $analysisYamlPath)) {
            $blockerPath = Join-Path (Get-SystemDir $taskDir.FullName) "blocker.spec.txt"
            $blockerMsg = "technical_specification 不完整（缺少 odoo_models 欄位或 technical_specification 區塊），無法開始實作。請重新產生規格。"
            Atomic-WriteFile $blockerPath $blockerMsg | Out-Null
            Write-Host "[BLOCKER] $taskName YAML 規格不完整，已寫入 blocker.spec.txt" -ForegroundColor Red
            continue
        }

        # Module 序列鎖：同一模組只允許一個活動任務
        if ($activeModules.ContainsKey($moduleName)) {
            Write-Host "[QUEUE] $taskName - 模組 $moduleName 序列等待（已有活動任務），下輪處理" -ForegroundColor DarkYellow
            continue
        }
        $activeModules[$moduleName] = $true

        $modulePath  = Get-ModulePath -moduleName $moduleName -odooVersion $odooVersion -projectName $projectName
        $destTaskDir = Join-Path $script:CODING_DIR $taskName

        Write-Host "[INFO] $taskName → $modulePath" -ForegroundColor DarkCyan

        # WIKI-CACHE 注入：在 Agent prompt 中 prepend 模組相關 wiki 內容
        $wikiCache = Get-WikiCache -moduleName $moduleName -odooVersion $odooVersion -projectName $projectName

        # [建議1] 萃取 technical_specification 區塊直接注入，省 agent Read 整份 yaml
        $techSpec    = Get-YamlSection -yaml $yamlContent -key 'technical_specification'
        $specBlock   = if ($techSpec) {
            "【SPECIFICATION】`n$techSpec"
        } else {
            "【SPECIFICATION】`n讀取 $($destTaskDir)\analysis.yaml 取得完整規格。"
        }

        # [建議2] 模組存在狀態 + 現有檔名清單，省 agent 探測性 ls/find
        $moduleExists      = Test-Path $modulePath
        $moduleStatusBlock = if ($moduleExists) {
            $existingFiles = Get-ChildItem $modulePath -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '\.pyc$' -and $_.FullName -notmatch '__pycache__' } |
                ForEach-Object { ($_.FullName.Substring($modulePath.Length) -replace '^[/\\]+', '').Replace('\', '/') }
            $fileList = if ($existingFiles) { ($existingFiles -join "`n") } else { "(空目錄)" }
            "【MODULE STATUS】exists=true`n【EXISTING FILES】`n$fileList"
        } else {
            "【MODULE STATUS】exists=false（新模組，從零建立）"
        }

        $fullPrompt = (Get-McpBudgetBlock) + $wikiCache + $agentTemplate +
            "`n`n【TASK DIRECTORY】`n$destTaskDir" +
            "`n`n$specBlock" +
            "`n`n【OUTPUT PATH】`n$modulePath" +
            "`n`n$moduleStatusBlock" +
            "`n`n【RULES】`n1. 依【MODULE STATUS】決定修改現有模組或建新模組；若 exists=true，先讀取【EXISTING FILES】列出的檔案再修改`n2. 依規格寫入所有實作檔案`n3. 完成後依序：(a) 寫入 system/.implement_done 到【TASK DIRECTORY】(b) 將 system/pending_prompt.txt 內容寫入 log/done_prompt.txt，然後刪除 system/pending_prompt.txt（移動不是複製，來源必須刪除）(c) 刪除 system/.pending_coding flag"

        Write-PendingPrompt -taskDir $taskDir.FullName -stage "coding" -prompt $fullPrompt

        Release-Lock $taskLock
        $rollback = @(
            (Join-Path (Get-SystemDir $taskDir.FullName) 'pending_prompt.txt'),
            (Join-Path (Get-SystemDir $taskDir.FullName) '.pending_coding')
        )
        if (Safe-MoveWithRollback $taskDir.FullName $script:CODING_DIR $rollback) {
            Write-Host "[OK] $taskName → coding/ (等待 Claude 實作)" -ForegroundColor Green
        } else {
            Write-Host "[ERROR] $taskName 無法移至 coding/，pending 已清除" -ForegroundColor Red
        }
    } catch {
        Write-Host "[ERROR] ${taskName}: $_" -ForegroundColor Red
    } finally {
        if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
    }
}

Open-ClaudeTerminal
Write-Host "`n[coding.ps1 完成]" -ForegroundColor Green
