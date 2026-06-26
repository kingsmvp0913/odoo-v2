# analysis.ps1 - 需求分析階段主程式（Steps 1–3b）
# PS1 僅負責機械工作（檔案管理）；AI 呼叫由 Claude terminal 非同步執行

. (Join-Path $PSScriptRoot "_common.ps1")

if (-not $env:ODOO_PASSWORD) {
    Write-Host "[ERROR] 環境變數 ODOO_PASSWORD 未設定" -ForegroundColor Red
    exit 1
}

Initialize-PipelineDirs

$agentDir      = if ($env:PIPELINE_AGENTS_DIR) { $env:PIPELINE_AGENTS_DIR } else { Join-Path $script:CLAUDE_DIR "agents" }
$tomlPath      = Join-Path $agentDir "requirements-analyst.toml"
$mdPath        = Join-Path $agentDir "requirements-analyst.md"
$agentPath     = if (Test-Path $tomlPath) { $tomlPath } else { $mdPath }
$agentRaw      = Get-Content $agentPath -Raw -Encoding UTF8
$agentTemplate = if ($agentPath -like "*.toml") { Get-TomlPromptContent $agentRaw } else { $agentRaw -replace '(?s)^---.*?---\r?\n', '' }

# ============================================================
# STEP 1: 同步 Odoo 任務 → start/task_N/original.txt
# ============================================================
Write-Host "[STEP 1] 同步 Odoo 任務..." -ForegroundColor Cyan

$odooDisableFlag = Join-Path $script:PLAN_DIR "_ODOO_DISABLED"
if (Test-Path $odooDisableFlag) {
    Write-Host "[SKIP] Odoo 同步已停用（刪除 _ODOO_DISABLED 可重新啟用）" -ForegroundColor DarkGray
} else {
    $allDirs = @($script:START_DIR, $script:CONFIRM_DIR, $script:ANALYSIS_DIR, $script:CODING_DIR, $script:FINAL_DIR, $script:STOP_DIR)

    # 建立來源 1（odoo）skip list：同時識別 task_N（舊）和 task_odoo_N（新）
    $odooSkipIds = @()
    foreach ($dir in $allDirs) {
        if (Test-Path $dir) {
            Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Name -match '^task_(?:odoo_)?(\d+)$') { $odooSkipIds += $matches[1] }
            }
        }
    }
    $odooSkipStr = ($odooSkipIds | Select-Object -Unique) -join ","

    # 建立來源 2（service）skip list
    $serviceSkipIds = @()
    foreach ($dir in $allDirs) {
        if (Test-Path $dir) {
            Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Name -match '^task_service_(\d+)$') { $serviceSkipIds += $matches[1] }
            }
        }
    }
    $serviceSkipStr = ($serviceSkipIds | Select-Object -Unique) -join ","

    $pyScript1 = Join-Path $script:CLAUDE_DIR "tools\curl.py"
    $pyScript2 = Join-Path $script:CLAUDE_DIR "tools\curl_service.py"

    # 來源 1：odoo（ideaxpress，project.task）
    try {
        $out = python $pyScript1 $script:ODOO_URL $script:ODOO_DB $script:ODOO_USERNAME $env:ODOO_PASSWORD $script:ODOO_USER_ID $script:START_DIR "task_odoo_" $odooSkipStr 2>&1
        $out | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Odoo 來源 1 同步失敗，exit: $LASTEXITCODE" -ForegroundColor Yellow }
    } catch {
        Write-Host "[WARN] Odoo 來源 1 同步例外: $_" -ForegroundColor Yellow
    }

    # 來源 2：service（service.question.feedback，若未設定密碼則略過）
    if ($env:ODOO_SERVICE_PASSWORD) {
        try {
            $out = python $pyScript2 $script:ODOO_SERVICE_URL $script:ODOO_SERVICE_DB $script:ODOO_SERVICE_USERNAME $env:ODOO_SERVICE_PASSWORD $script:ODOO_SERVICE_USER_ID $script:START_DIR "task_service_" $serviceSkipStr 2>&1
            $out | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Odoo 來源 2 同步失敗，exit: $LASTEXITCODE" -ForegroundColor Yellow }
        } catch {
            Write-Host "[WARN] Odoo 來源 2 同步例外: $_" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[SKIP] ODOO_SERVICE_PASSWORD 未設定，略過來源 2 同步" -ForegroundColor DarkGray
    }
}

# ============================================================
# STEP 2: start/ → confirm/（寫 pending prompt，不等 AI）
# ============================================================
Write-Host "`n[STEP 2] 準備初始分析任務（start/ → confirm/）..." -ForegroundColor Cyan

$lock2 = Join-Path $script:PLAN_DIR "global_analysis.lock"
if (-not (Acquire-Lock $lock2 300)) {
    Write-Host "[SKIP] 無法取得 STEP 2 全域鎖" -ForegroundColor Yellow
} else {
    try {
        $startTasks = Get-ChildItem $script:START_DIR -Directory -Exclude "README.md" -ErrorAction SilentlyContinue

        foreach ($taskDir in $startTasks) {
            $taskName     = $taskDir.Name
            $originalTxt  = Join-Path $taskDir.FullName "original.txt"
            $analysisDone = Join-Path (Get-SystemDir $taskDir.FullName) ".analysis_done"

            if (Test-HasBlocker $taskDir.FullName) {
                Write-Host "[BLOCKER] $taskName 已有 blocker 檔案，跳過（需人工處理）" -ForegroundColor Red
                continue
            }

            if (-not (Test-Path $originalTxt)) {
                # 空目錄清理：無任何檔案代表是搬移殘留的空殼，直接刪除
                $hasFiles = Get-ChildItem $taskDir.FullName -Recurse -File -ErrorAction SilentlyContinue
                if (-not $hasFiles) {
                    Remove-Item $taskDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
                    Write-Host "[CLEAN] $taskName 空目錄已清除" -ForegroundColor DarkGray
                } else {
                    Write-Host "[SKIP] $taskName 缺少 original.txt" -ForegroundColor Yellow
                }
                continue
            }

            # 已分析完但未移動（上次意外中斷的容錯）
            if (Test-Path $analysisDone) {
                # P1-02: 補移前先修復可能的 crash 殘留（done marker 存在但 pending 未清）
                Resolve-CrashState -taskDir $taskDir.FullName -stage "analysis" -doneMarker ".analysis_done"
                $taskLock = Join-Path $taskDir.FullName "process.lock"
                if (Acquire-Lock $taskLock 300) {
                    try {
                        $dest = Join-Path $script:CONFIRM_DIR $taskName
                        if (-not (Test-Path $dest)) {
                            Release-Lock $taskLock
                            Move-Item $taskDir.FullName $script:CONFIRM_DIR -Force
                            Write-Host "[MOVE] $taskName 補移到 confirm/" -ForegroundColor DarkCyan
                        }
                    } finally {
                        if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
                    }
                }
                continue
            }

            # 已有 pending prompt，等待 Claude 處理（超過 30 分鐘則清除重新排隊）
            if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt")) {
                if (Test-PendingStale $taskDir.FullName) {
                    Clear-StalePending $taskDir.FullName
                } else {
                    Write-Host "[WAIT] $taskName - Claude 分析中（system/pending_prompt.txt 存在）" -ForegroundColor DarkGray
                    continue
                }
            }

            $taskLock = Join-Path $taskDir.FullName "process.lock"
            if (-not (Acquire-Lock $taskLock 300)) {
                Write-Host "[SKIP] $taskName 已被鎖定" -ForegroundColor Yellow
                continue
            }

            try {
                $req = Get-Content $originalTxt -Raw -Encoding UTF8

                $taskProject = $null
                if ($req -match '---project---\s*[\r\n]+([^\r\n]+)') { $taskProject = $matches[1].Trim() }
                if (-not $taskProject) {
                    Write-Host "[SKIP] $taskName 缺少 ---project--- 欄位" -ForegroundColor Yellow
                    continue
                }

                $odooVersion = Get-ProjectVersion $taskProject
                if (-not $odooVersion) {
                    Write-Host "[CONFIG] $taskName - 專案「$taskProject」未設定版本，請更新 project_version_map.json" -ForegroundColor Red
                    continue
                }

                $currentTime  = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
                $destTaskDir  = Join-Path $script:CONFIRM_DIR $taskName   # 任務移動後的路徑
                $prompt = $agentTemplate `
                    -replace '__CASE_ID__', $taskName `
                    -replace '__CURRENT_TIME__', $currentTime

                # 從需求文字萃取關鍵字供 wiki 過濾（去 HTML tag 後依標點切詞）
                $rawText  = $req -replace '<[^>]+>', ' '
                $keywords = @(
                    ($rawText -split '[、,，。；：\s\r\n]+') |
                    Where-Object { $_.Length -ge 2 -and $_ -notmatch '^\d+$' } |
                    Select-Object -Unique -First 10
                )
                $wikiCache = Get-WikiCache -odooVersion $odooVersion -projectName $taskProject -keywords $keywords

                $fullPrompt = $prompt + $wikiCache +
                    "`n`n【SYSTEM CONFIRMED】odoo_version = `"$odooVersion`" — 固定事實，不得質疑。" +
                    "`n`n【TASK DIRECTORY】`n$destTaskDir" +
                    "`n`n【USER BUSINESS REQUIREMENT】`n<user_requirement>`n$req`n</user_requirement>" +
                    "`n`n將 analysis.yaml 和 system/.analysis_done 寫入【TASK DIRECTORY】，完成後依序：(a) 將 system/pending_prompt.txt 內容寫入 log/done_prompt.txt，然後刪除 system/pending_prompt.txt（移動不是複製，來源必須刪除）(b) 刪除 system/.pending_analysis。" +
                    "`n`n" + (Get-McpBudgetBlock)

                Write-PendingPrompt -taskDir $taskDir.FullName -stage "analysis" -prompt $fullPrompt

                Release-Lock $taskLock

                $dest = Join-Path $script:CONFIRM_DIR $taskName
                if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
                try {
                    Move-Item $taskDir.FullName $script:CONFIRM_DIR -Force
                    # Windows Move-Item 偶爾留下空殼目錄，強制清除
                    Remove-Item $taskDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
                    Write-Host "[OK] $taskName → confirm/ (等待 Claude 初始分析)" -ForegroundColor Green
                } catch {
                    # 搬移失敗：回滾 pending，避免任務目錄分裂（start/ 與 confirm/ 各一份）
                    Remove-Item (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt") -Force -ErrorAction SilentlyContinue
                    Remove-Item (Join-Path (Get-SystemDir $taskDir.FullName) ".pending_analysis")  -Force -ErrorAction SilentlyContinue
                    Write-Host "[ERROR] $taskName 搬移失敗（已回滾 pending）：$_" -ForegroundColor Red
                }
            } catch {
                Write-Host "[ERROR] STEP 2 ${taskName}: $_" -ForegroundColor Red
            } finally {
                if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
            }
        }
    } finally {
        Release-Lock $lock2
    }
}

# ============================================================
# STEP 3a: confirm/ → analysis/（無 AI，檢查答案完整性）
# ============================================================
Write-Host "`n[STEP 3a] 檢查 confirm/ 答案完整性..." -ForegroundColor Cyan

$lock3a = Join-Path $script:PLAN_DIR "global_answer_check.lock"
if (-not (Acquire-Lock $lock3a 300)) {
    Write-Host "[SKIP] 無法取得 STEP 3a 全域鎖" -ForegroundColor Yellow
} else {
    try {
        $confirmTasks = Get-ChildItem $script:CONFIRM_DIR -Directory -ErrorAction SilentlyContinue

        foreach ($taskDir in $confirmTasks) {
            $taskName     = $taskDir.Name
            $taskLock     = Join-Path $taskDir.FullName "process.lock"
            $analysisDone = Join-Path (Get-SystemDir $taskDir.FullName) ".analysis_done"
            $answerDone   = Join-Path (Get-SystemDir $taskDir.FullName) ".answer_done"
            $yamlPath     = Join-Path $taskDir.FullName "analysis.yaml"

            if (Test-HasBlocker $taskDir.FullName) {
                Write-Host "[BLOCKER] $taskName 已有 blocker 檔案，跳過（需人工處理）" -ForegroundColor Red
                continue
            }

            # 特例：.final_done 已存在於 confirm/（Agent 跳過正常路徑直接寫入，如 ALREADY_IMPLEMENTED）
            # 補齊缺失 markers → 推進到 analysis/，讓 coding.ps1 接手
            $sysDir3a = Get-SystemDir $taskDir.FullName
            if (Test-Path (Join-Path $sysDir3a ".final_done")) {
                if (Acquire-Lock $taskLock 300) {
                    try {
                        if (-not (Test-Path $analysisDone)) { Atomic-WriteFile $analysisDone "" | Out-Null }
                        if (-not (Test-Path $answerDone))   { Atomic-WriteFile $answerDone   "" | Out-Null }
                        Release-Lock $taskLock
                        $dest = Join-Path $script:ANALYSIS_DIR $taskName
                        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
                        Move-Item $taskDir.FullName $script:ANALYSIS_DIR -Force
                        Write-Host "[PROMOTE] $taskName confirm/ 發現 .final_done，補齊 markers → analysis/" -ForegroundColor Cyan
                    } catch {
                        Write-Host "[ERROR] $taskName PROMOTE 失敗: $_" -ForegroundColor Red
                        if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
                    }
                }
                continue
            }

            # AI 尚未處理（.analysis_done 不存在）→ 跳過
            if (-not (Test-Path $analysisDone)) { continue }
            if (Test-Path $answerDone) { continue }
            # AI 正在處理中（system/pending_prompt.txt 存在）→ 超過 30 分鐘則清除重新排隊，否則跳過
            # P1-04: 補充 stale 偵測（與 STEP 2 / STEP 3b 行為一致）
            if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) 'pending_prompt.txt')) {
                if (Test-PendingStale $taskDir.FullName) { Clear-StalePending $taskDir.FullName }
                else { continue }
            }
            if (-not (Test-Path $yamlPath)) { Write-Host "[WARN] $taskName 缺少 analysis.yaml" -ForegroundColor Yellow; continue }

            if (-not (Acquire-Lock $taskLock 300)) {
                Write-Host "[SKIP] $taskName 已被鎖定" -ForegroundColor Yellow
                continue
            }

            try {
                $yaml   = Get-Content $yamlPath -Raw -Encoding UTF8
                $parsed = ConvertFrom-Yaml $yaml

                $noQuestions = -not [regex]::IsMatch($yaml, '(?m)^\s*user_answer:')
                $allAnswered = $noQuestions -or (-not $parsed['has_null_answer'] -and $parsed['has_any_answer'])

                if (-not $allAnswered) {
                    # ── 新訊息偵測：若收到人工留言，重新排隊更新分析問題 ──
                    $newMsgHandled = $false
                    $originalTxt  = Join-Path $taskDir.FullName "original.txt"
                    $lastKnownTs  = Get-LastMessageTs $originalTxt
                    if ($lastKnownTs) {
                        $srcParams = Get-OdooSourceParams $taskName
                        if ($srcParams.Password -and ($taskName -match '^task_(?:service_|odoo_)?(\d+)$')) {
                            $numericId   = $matches[1]
                            $pyCheck     = Join-Path $script:CLAUDE_DIR "tools\check_new_messages.py"
                            $newMsgRaw   = python $pyCheck $srcParams.URL $srcParams.DB $srcParams.Username $srcParams.Password $srcParams.Model $numericId $lastKnownTs 2>$null
                            $newMsgLines = @($newMsgRaw | Where-Object { $_ -match '^\[NEW_MSG\]' })
                            if ($newMsgLines.Count -gt 0) {
                                $appendBlock = "`n`n[NEW_MESSAGES detected at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')]`n" + ($newMsgLines -join "`n")
                                $existing    = Get-Content $originalTxt -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                                Atomic-WriteFile $originalTxt ($existing + $appendBlock) | Out-Null

                                $wikiCache    = Get-WikiCache -moduleName ($parsed['module']) -odooVersion ($parsed['odoo_version']) -projectName ($parsed['project_name'])
                                $clarSection  = Get-YamlSection -yaml $yaml -key 'clarification_channel'
                                $inferSection = Get-YamlSection -yaml $yaml -key 'inferred_target'
                                $clarPart     = if ($clarSection)  { $clarSection }  else { $yaml }
                                $inferPart    = if ($inferSection) { "`n`n$inferSection" } else { "" }
                                $newMsgBlock  = ($newMsgLines | ForEach-Object { $_ -replace '^\[NEW_MSG\]\s*', '' }) -join "`n"

                                $rePrompt = $agentTemplate `
                                    -replace '__CASE_ID__', $taskName `
                                    -replace '__CURRENT_TIME__', (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")

                                $fullPrompt = $wikiCache + $rePrompt +
                                    "`n`n【SYSTEM CONFIRMED】odoo_version = `"$($parsed['odoo_version'])`" — 固定事實，不得質疑。" +
                                    "`n`n【TASK DIRECTORY】`n$($taskDir.FullName)" +
                                    "`n`n【EXISTING ANALYSIS】`n<existing_analysis>`n$clarPart$inferPart`n</existing_analysis>" +
                                    "`n`n【NEW MESSAGES】`n<new_messages>`n$newMsgBlock`n</new_messages>" +
                                    "`n`n此任務已完成初始分析（MODE_A）。請根據新訊息更新 clarification_channel：`n" +
                                    "1. 保留所有現有條目，不得刪除或覆蓋已填寫的 user_answer`n" +
                                    "2. 若新訊息已直接回答某個 user_answer: null 的問題，填入答案`n" +
                                    "3. 若新訊息帶來新的不確定性，在現有條目後新增問題（id 繼續遞增）`n" +
                                    "4. 若新訊息未帶來任何新資訊，保持現有 clarification_channel 不變`n`n" +
                                    "更新 analysis.yaml（保留完整 YAML 結構），重寫 system/.analysis_done。" +
                                    "完成後依序：(a) 將 system/pending_prompt.txt 寫入 log/done_prompt.txt，然後刪除 system/pending_prompt.txt（移動不是複製，來源必須刪除）(b) 刪除 system/.pending_analysis。" +
                                    "`n`n" + (Get-McpBudgetBlock)

                                Write-PendingPrompt -taskDir $taskDir.FullName -stage "analysis" -prompt $fullPrompt
                                Write-Host "[MSG-UPDATE] $taskName - $($newMsgLines.Count) 條新訊息，重新排隊分析" -ForegroundColor Cyan
                                $newMsgHandled = $true
                            }
                        }
                    }
                    if (-not $newMsgHandled) {
                        Write-Host "[WAIT] $taskName - 等待填寫 user_answer" -ForegroundColor DarkGray
                    }
                    continue
                }

                Atomic-WriteFile $answerDone "" | Out-Null

                Release-Lock $taskLock
                $dest = Join-Path $script:ANALYSIS_DIR $taskName
                if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
                Move-Item $taskDir.FullName $script:ANALYSIS_DIR -Force
                Write-Host "[OK] $taskName 答案完整 → analysis/" -ForegroundColor Green
            } catch {
                Write-Host "[ERROR] STEP 3a ${taskName}: $_" -ForegroundColor Red
            } finally {
                if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
            }
        }
    } finally {
        Release-Lock $lock3a
    }
}

# ============================================================
# STEP 3b: analysis/ 產生 MODE_B 最終規格（寫 pending prompt）
# ============================================================
Write-Host "`n[STEP 3b] 準備 MODE_B 最終規格任務..." -ForegroundColor Cyan

$lock3b = Join-Path $script:PLAN_DIR "global_recheck.lock"
if (-not (Acquire-Lock $lock3b 300)) {
    Write-Host "[SKIP] 無法取得 STEP 3b 全域鎖" -ForegroundColor Yellow
} else {
    try {
        $analysisTasks = Get-ChildItem $script:ANALYSIS_DIR -Directory -ErrorAction SilentlyContinue

        foreach ($taskDir in $analysisTasks) {
            $taskName        = $taskDir.Name
            $taskLock        = Join-Path $taskDir.FullName "process.lock"
            $answerDone      = Join-Path (Get-SystemDir $taskDir.FullName) ".answer_done"
            $finalDone       = Join-Path (Get-SystemDir $taskDir.FullName) ".final_done"
            $lowConfidence   = Join-Path (Get-SystemDir $taskDir.FullName) ".low_confidence"
            $yamlPath        = Join-Path $taskDir.FullName "analysis.yaml"

            if (Test-HasBlocker $taskDir.FullName) {
                Write-Host "[BLOCKER] $taskName 已有 blocker 檔案，跳過（需人工處理）" -ForegroundColor Red
                continue
            }

            # LOW-CONFIDENCE 退回：agent 信心度 < 0.9 → 刪 .answer_done，搬回 confirm/ 重新等待答覆
            if (Test-Path $lowConfidence) {
                if (Acquire-Lock $taskLock 300) {
                    try {
                        Remove-Item $lowConfidence -Force -ErrorAction Stop
                        Remove-Item $answerDone    -Force -ErrorAction SilentlyContinue
                        Release-Lock $taskLock
                        $dest = Join-Path $script:CONFIRM_DIR $taskName
                        if (Test-Path $dest) {
                            Write-Host "[WARN] $taskName confirm/ 已有同名目錄，覆蓋前備份為 $($dest).bak" -ForegroundColor Yellow
                            $bakPath = "$dest.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
                            Move-Item $dest $bakPath -Force -ErrorAction SilentlyContinue
                        }
                        Move-Item $taskDir.FullName $script:CONFIRM_DIR -Force
                        # BUG-8/BUG-10：計數緊接 Move-Item 之後（先計數再寫日誌，確保例外不漏計）
                        $confirmSysDir = Get-SystemDir (Join-Path $script:CONFIRM_DIR $taskName)
                        $lowconfFile   = Join-Path $confirmSysDir '_lowconf_count'
                        $lcc = 0
                        if (Test-Path $lowconfFile) { try { $lcc = [int](Get-Content $lowconfFile -Raw -EA SilentlyContinue) } catch {} }
                        $lcc++
                        Atomic-WriteFile $lowconfFile ([string]$lcc) | Out-Null
                        Increment-TotalReentry $confirmSysDir $taskName | Out-Null
                        $maxLowConf = if ($env:PIPELINE_MAX_LOWCONF) { [int]$env:PIPELINE_MAX_LOWCONF } else { 3 }
                        if ($lcc -gt $maxLowConf) {
                            $bMsg = "blocker_type: spec`ntask_id: $taskName`ntimestamp: $(Get-Date -Format 'o')`nlowconf_count: $lcc`nlimit: $maxLowConf`nreason: |`n  任務已低信心度退回 $lcc 次（上限 $maxLowConf），需求描述可能存在根本模糊。請確認需求後手動刪除 system/_lowconf_count 再觸發。"
                            Atomic-WriteFile (Join-Path $confirmSysDir 'blocker.spec.txt') $bMsg | Out-Null
                            Write-Host "[BLOCKER] $taskName low-conf 次數 $lcc 超過上限 $maxLowConf → blocker.spec.txt" -ForegroundColor Red
                        }
                        # 寫入退回原因（可觀測性日誌，不影響狀態機）
                        $logDir = Get-LogDir (Join-Path $script:CONFIRM_DIR $taskName)
                        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
                        $backContent = "退回時間: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n退回階段: MODE_B`n退回原因: Agent 信心度 < 0.9，新增澄清問題，等待使用者補充答覆。`n`n請填寫 analysis.yaml 中 clarification_channel 的新 user_answer 後重新觸發。"
                        Atomic-WriteFile (Join-Path $logDir 'back_reason.txt') $backContent | Out-Null
                        Write-Host "[LOW-CONF] $taskName MODE_B 信心不足 → confirm/（已寫 log/back_reason.txt）" -ForegroundColor Yellow
                    } catch {
                        Write-Host "[ERROR] $taskName low-confidence 退回失敗: $_" -ForegroundColor Red
                        if ($script:LockHandles.ContainsKey($taskLock)) { Release-Lock $taskLock }
                    }
                } else {
                    Write-Host "[WARN] $taskName low-confidence 無法取得鎖，下輪重試" -ForegroundColor Yellow
                }
                continue
            }

            if (-not (Test-Path $answerDone)) { continue }
            if (Test-Path $finalDone) { continue }

            # 已有 pending prompt，等待 Claude 處理（超過 30 分鐘則清除重新排隊）
            if (Test-Path (Join-Path (Get-SystemDir $taskDir.FullName) "pending_prompt.txt")) {
                if (Test-PendingStale $taskDir.FullName) {
                    Clear-StalePending $taskDir.FullName
                } else {
                    Write-Host "[WAIT] $taskName - Claude 生成 MODE_B 中" -ForegroundColor DarkGray
                    continue
                }
            }

            if (-not (Test-Path $yamlPath)) { Write-Host "[WARN] $taskName 缺少 analysis.yaml" -ForegroundColor Yellow; continue }

            if (-not (Acquire-Lock $taskLock 300)) {
                Write-Host "[SKIP] $taskName 已被鎖定" -ForegroundColor Yellow
                continue
            }

            try {
                $currentYaml = Get-Content $yamlPath -Raw -Encoding UTF8
                $parsed      = ConvertFrom-Yaml $currentYaml

                # NO_CHANGE_NEEDED 快速路徑：直接寫 .final_done，跳過 MODE_B agent（0 tokens）
                if ($currentYaml -match 'NO_CHANGE_NEEDED') {
                    Atomic-WriteFile $finalDone "" | Out-Null
                    Write-Host "[AUTO-FINAL] $taskName 偵測到 NO_CHANGE_NEEDED → 直接 .final_done，跳過 MODE_B agent" -ForegroundColor Cyan
                    Release-Lock $taskLock
                    continue
                }

                $currentTime = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
                $prompt = $agentTemplate `
                    -replace '__CASE_ID__', $taskName `
                    -replace '__CURRENT_TIME__', $currentTime

                # STEP 3b 不搬移任務目錄（仍留在 analysis/）；coding.ps1 STEP 4 才會搬到 coding/
                # WIKI-CACHE 注入：此時 module 已由初始分析填入 analysis.yaml
                $wikiCache = Get-WikiCache -moduleName $parsed['module'] -odooVersion $parsed['odoo_version'] -projectName $parsed['project_name']

                $yamlForAgent = if ($parsed['has_qa_failure_hint']) {
                    # QA 失敗退回：精準注入 inferred_target + _qa_failure_hint + technical_specification
                    # 省去 clarification_channel 歷史問答（~500-800 tokens）
                    $techSpec     = Get-YamlSection -yaml $currentYaml -key 'technical_specification'
                    $inferSection = Get-YamlSection -yaml $currentYaml -key 'inferred_target'
                    $hintVal      = $parsed['_qa_failure_hint']
                    $hintEsc      = "$hintVal" -replace "'", "''"
                    $inferPart    = if ($inferSection) { "$inferSection`n`n" }           else { "" }
                    $hintPart     = if ($hintVal)      { "_qa_failure_hint: '$hintEsc'`n`n" } else { "" }
                    $specPart     = if ($techSpec)     { $techSpec }                     else { $currentYaml }
                    $injected     = "$inferPart$hintPart$specPart"
                    Write-Host "[TOKEN-WARN] $taskName QA 退回 final，精準注入 ~$([int]($injected.Length/3.5)) tokens（vs 整份 ~$([int]($currentYaml.Length/4)) tokens）" -ForegroundColor DarkYellow
                    "<analysis_yaml>`n$injected`n</analysis_yaml>"
                } else {
                    # 正常路徑：只傳問題區塊 + 確認事實
                    $clarSection = Get-YamlSection -yaml $currentYaml -key 'clarification_channel'
                    $inferSection = Get-YamlSection -yaml $currentYaml -key 'inferred_target'
                    $clarPart   = if ($clarSection) { $clarSection } else { $currentYaml }
                    $inferPart  = if ($inferSection) { "`n`n$inferSection" } else { "" }
                    "<analysis_yaml>`n$clarPart$inferPart`n</analysis_yaml>"
                }

                $fullPrompt = (Get-McpBudgetBlock) + $wikiCache + $prompt +
                    "`n`n【TASK DIRECTORY】`n$($taskDir.FullName)" +
                    "`n`n【EXISTING ANALYSIS WITH USER ANSWERS】`n$yamlForAgent" +
                    "`n`n使用者答案已填寫完畢。產生 MODE_B 完整 technical_specification，更新【TASK DIRECTORY】內的 analysis.yaml 並寫入 system/.final_done。完成後依序：(a) 寫入 system/.final_done (b) 將 system/pending_prompt.txt 內容寫入 log/done_prompt.txt，然後刪除 system/pending_prompt.txt（移動不是複製，來源必須刪除）(c) 刪除 system/.pending_final。"

                Write-PendingPrompt -taskDir $taskDir.FullName -stage "final" -prompt $fullPrompt
                Write-Host "[OK] $taskName → 等待 Claude 生成 MODE_B 規格" -ForegroundColor Green
            } catch {
                Write-Host "[ERROR] STEP 3b ${taskName}: $_" -ForegroundColor Red
            } finally {
                Release-Lock $taskLock
            }
        }
    } finally {
        Release-Lock $lock3b
    }
}

# ============================================================
# 狀態摘要 + 開啟 Claude Terminal
# ============================================================
Write-Host "`n=== Pipeline 任務狀態摘要 ===" -ForegroundColor Cyan
$stageMap = [ordered]@{
    start    = $script:START_DIR
    confirm  = $script:CONFIRM_DIR
    analysis = $script:ANALYSIS_DIR
    coding   = $script:CODING_DIR
}
$total = 0
foreach ($stage in $stageMap.Keys) {
    $dir = $stageMap[$stage]
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem $dir -Exclude "README.md" -ErrorAction SilentlyContinue | ForEach-Object {
        $hasPending = Test-Path (Join-Path (Get-SystemDir $_.FullName) "pending_prompt.txt")
        $suffix = if ($hasPending) { " [待 Claude]" } else { "" }
        Write-Host ("  [{0,-10}]  {1}{2}" -f $stage, $_.Name, $suffix) -ForegroundColor White
        $total++
    }
}
if ($total -eq 0) { Write-Host "  (目前無任何待處理任務)" -ForegroundColor DarkGray }

Open-ClaudeTerminal
Write-Host "`n[analysis.ps1 完成]"
