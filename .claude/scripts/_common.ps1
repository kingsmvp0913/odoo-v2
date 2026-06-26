# _common.ps1 - 共用函數庫

# ============================================================
# 路徑常數
# ============================================================
$script:CLAUDE_DIR       = Split-Path -Parent $PSScriptRoot
$script:ROOT             = Split-Path -Parent $script:CLAUDE_DIR
$script:ONLINE_ADDONS_DIR = if ($env:ONLINE_ADDONS_DIR) { $env:ONLINE_ADDONS_DIR } elseif ($IsLinux) { "/online_addons" } else { "C:\online_addons" }

$script:PLAN_DIR     = Join-Path $script:ROOT "kingsmvpsplan"

$script:START_DIR    = Join-Path $script:PLAN_DIR "start"
$script:CONFIRM_DIR  = Join-Path $script:PLAN_DIR "confirm"
$script:ANALYSIS_DIR = Join-Path $script:PLAN_DIR "analysis"
$script:CODING_DIR   = Join-Path $script:PLAN_DIR "coding"
$script:FINAL_DIR    = Join-Path $script:PLAN_DIR "final"
$script:STOP_DIR     = Join-Path $script:PLAN_DIR "stop"

$script:PIPELINE_WAITING     = Join-Path $script:PLAN_DIR "_PIPELINE_WAITING"
$script:PROJECT_VERSION_MAP_PATH = Join-Path $script:CLAUDE_DIR "project_version_map.json"

# ============================================================
# Odoo 連線常數
# ============================================================
$script:ODOO_URL      = "https://odoo.ideaxpress.biz"
$script:ODOO_DB       = "odoo"
$script:ODOO_USERNAME = "steven.lin@ideaxpress.biz"
$script:ODOO_USER_ID  = if ($env:ODOO_USER_ID) { [int]$env:ODOO_USER_ID } else { 79 }

# 來源 2（service）— URL/DB/USERNAME 寫死，密碼從 env var 讀
$script:ODOO_SERVICE_URL      = "https://service.ideaxpress.biz"
$script:ODOO_SERVICE_DB       = "service"
$script:ODOO_SERVICE_USERNAME = "steven.lin@ideaxpress.biz"
$script:ODOO_SERVICE_USER_ID  = if ($env:ODOO_SERVICE_USER_ID) { [int]$env:ODOO_SERVICE_USER_ID } else { 139 }

# ============================================================
# 編碼設定
# ============================================================
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

# ============================================================
# 檔案鎖（真正排他鎖：持有 handle 直到 Release-Lock）
# ============================================================
$script:LockHandles = @{}

function Acquire-Lock {
    param(
        [string]$LockPath,
        [int]$TimeoutSeconds = 300
    )
    $startTime = Get-Date
    while ($true) {
        try {
            $handle = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
            $script:LockHandles[$LockPath] = $handle
            return $true
        } catch {
            if ((Get-Date) - $startTime -gt [TimeSpan]::FromSeconds($TimeoutSeconds)) {
                Write-Host "[LOCK] 逾時無法取得: $LockPath" -ForegroundColor Red
                return $false
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Release-Lock {
    param([string]$LockPath)
    if ($script:LockHandles.ContainsKey($LockPath)) {
        try { $script:LockHandles[$LockPath].Close(); $script:LockHandles[$LockPath].Dispose() } catch {}
        $script:LockHandles.Remove($LockPath)
    }
    Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}

# ============================================================
# 目錄初始化
# ============================================================
function Initialize-PipelineDirs {
    @($script:START_DIR, $script:CONFIRM_DIR, $script:ANALYSIS_DIR, $script:CODING_DIR, $script:FINAL_DIR, $script:STOP_DIR) | ForEach-Object {
        if (-not (Test-Path $_)) { New-Item -ItemType Directory -Force $_ | Out-Null }
    }
}

# ============================================================
# 模組路徑函數
# ============================================================
function Get-OnlineAddonsRoot {
    param([string]$odooVersion, [string]$projectName = $null, [string]$moduleName = $null)
    if (-not [string]::IsNullOrWhiteSpace($projectName)) {
        $dirEntry = Get-ProjectDir -projectName $projectName
        if ($null -eq $dirEntry) {
            Write-Host "[WARN] project_dir_map 找不到 '$projectName'，直接用 project_name 當目錄名（可能錯誤）" -ForegroundColor Yellow
            $dirEntry = $projectName
        }

        # 陣列：掃描找到模組實際所在目錄；找不到則用第一個（新模組預設）
        if ($dirEntry -is [System.Array] -or $dirEntry -is [System.Collections.IList]) {
            $dirs = @($dirEntry)
            if ($moduleName) {
                foreach ($d in $dirs) {
                    $candidate = Join-Path $script:ONLINE_ADDONS_DIR $d
                    if (Test-Path (Join-Path $candidate $moduleName)) {
                        return $candidate
                    }
                }
            }
            # 找不到 → 回退第一個目錄
            $dirName = $dirs[0]
        } else {
            $dirName = "$dirEntry"
        }

        $p = Join-Path $script:ONLINE_ADDONS_DIR $dirName
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force $p | Out-Null }
        return $p
    }
    $major = $odooVersion -replace '\.0$', ''
    $p = Join-Path $script:ONLINE_ADDONS_DIR $major
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force $p | Out-Null }
    return $p
}

function Get-ModulePath {
    param([string]$moduleName, [string]$odooVersion, [string]$projectName = $null)
    return Join-Path (Get-OnlineAddonsRoot -odooVersion $odooVersion -projectName $projectName -moduleName $moduleName) $moduleName
}

# ============================================================
# YAML 序列化（支援巢狀物件與物件陣列）
# ============================================================
function Format-YamlScalar {
    param($val)
    if ($null -eq $val) { return 'null' }
    if ($val -is [bool]) { return $val.ToString().ToLower() }
    if ($val -is [int] -or $val -is [long] -or $val -is [double]) { return "$val" }
    $s = "$val"
    if ($s -eq '' -or $s -match '[\r\n]' -or $s -match '^\s|\s$' -or $s -match '[:#\[\]{}&*!|>''"%@`]') {
        return "'" + ($s -replace "'", "''") + "'"
    }
    return $s
}

function Write-YamlObject {
    param($obj, [int]$indent, [string]$prefix = '')
    $sp = ' ' * $indent
    $lines = @()
    $props = if ($obj -is [hashtable]) { $obj.GetEnumerator() } else { $obj.PSObject.Properties }
    $first = $true
    foreach ($p in $props) {
        $lead = if ($first -and $prefix) { "$prefix$($p.Name)" } else { "$sp$($p.Name)" }
        $v = $p.Value
        if ($null -eq $v) {
            $lines += "${lead}: null"
        } elseif ($v -is [hashtable] -or $v -is [PSCustomObject]) {
            $lines += "${lead}:"
            $lines += Write-YamlObject $v ($indent + 2)
        } elseif ($v -is [System.Collections.IList]) {
            $lines += "${lead}:"
            foreach ($item in $v) {
                if ($null -eq $item) {
                    $lines += "$sp  - null"
                } elseif ($item -is [hashtable] -or $item -is [PSCustomObject]) {
                    $lines += Write-YamlObject $item ($indent + 4) "$sp  - "
                } else {
                    $lines += "$sp  - $(Format-YamlScalar $item)"
                }
            }
        } else {
            $lines += "${lead}: $(Format-YamlScalar $v)"
        }
        $first = $false
    }
    return $lines
}

function ConvertTo-Yaml {
    param($obj)
    if ($null -eq $obj) { return 'null' }
    if ($obj -is [hashtable] -or $obj -is [PSCustomObject]) {
        return (Write-YamlObject $obj 0) -join "`n"
    }
    return Format-YamlScalar $obj
}

# ============================================================
# YAML 反序列化（萃取關鍵欄位，支援 CRLF）
# ============================================================
function ConvertFrom-Yaml {
    param([string]$yaml)
    $result = @{}

    if ($yaml -match '(?m)^execution_mode:\s*["'']?(\w+)["'']?\s*$') { $result['execution_mode'] = $matches[1] }
    # \s* — supports both root-level and indented module fields; strip surrounding quotes
    if ($yaml -match '(?m)^\s*module:\s*["'']?([^"''\r\n]+?)["'']?\s*$') { $result['module'] = $matches[1].Trim() }
    # Strip surrounding single or double quotes; handle both indented and root-level
    if ($yaml -match '(?m)^(?:\s+)?odoo_version:\s*["'']?([^"''\r\n]+?)["'']?\s*$') {
        $result['odoo_version'] = $matches[1].Trim()
    }
    if ($yaml -match '(?m)^(?:\s+)?project_name:\s*["'']?([^"''\r\n]+?)["'']?\s*$') {
        $val = $matches[1].Trim()
        # project_name: null in YAML becomes the string "null" via regex — convert to $null
        $result['project_name'] = if ($val -eq 'null') { $null } else { $val }
    }
    if ($yaml -match '(?m)^status:\s*["'']?(\w+)["'']?\s*$') { $result['status'] = $matches[1] }

    $result['has_null_answer']      = [regex]::IsMatch($yaml, "(?m)^\s*user_answer:\s*(null|`"`"|''|)?\s*$")
    $result['has_any_answer']       = [regex]::IsMatch($yaml, '(?m)^\s*user_answer:\s*\S')
    $result['is_mode_b']            = ($result['execution_mode'] -eq 'MODE_B')
    $result['is_complete']          = [regex]::IsMatch($yaml, '(?m)^\s*is_complete:\s*true\s*$')
    $result['has_qa_failure_hint']  = [regex]::IsMatch($yaml, '_qa_failure_hint:')
    if ($yaml -match "(?m)^_qa_failure_hint:\s*'((?:[^']|'')*)'\s*$") {
        $result['_qa_failure_hint'] = $matches[1] -replace "''", "'"
    }

    return $result
}

# ============================================================
# YAML 區塊萃取（抓頂層 key 到下一個頂層 key 為止）
# 用於將 technical_specification / clarification_channel 等區塊
# 直接注入 pending_prompt，讓 agent 不需 Read 整份 analysis.yaml
# ============================================================
function Get-YamlSection {
    param([string]$yaml, [string]$key)
    # 頂層 key 頂格，縮排內容直到下一個頂格 key 或 EOF
    if ($yaml -match "(?ms)^(${key}:.*?)(?=\r?\n\S|\z)") {
        return $matches[1].TrimEnd()
    }
    return $null  # fallback: 呼叫方改回讀檔指示
}

# ============================================================
# 原子性寫檔
# ============================================================
function Atomic-WriteFile {
    param([string]$path, [string]$content)
    try {
        $dir = Split-Path $path -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
        $tmp = "$path.tmp"
        [System.IO.File]::WriteAllText($tmp, $content, [System.Text.Encoding]::UTF8)
        Move-Item -Force $tmp $path
        return $true
    } catch {
        Remove-Item "$path.tmp" -Force -ErrorAction SilentlyContinue
        return $false
    }
}

# ============================================================
# 子目錄路徑 helpers
# ============================================================
function Get-SystemDir { param([string]$taskDir); Join-Path $taskDir "system" }
function Get-LogDir    { param([string]$taskDir); Join-Path $taskDir "log" }

# ============================================================
# Pipeline Pending Prompt（寫入後由 Claude 非同步執行）
# ============================================================
function Write-PendingPrompt {
    param([string]$taskDir, [string]$stage, [string]$prompt)
    $sysDir = Get-SystemDir $taskDir
    Atomic-WriteFile (Join-Path $sysDir "pending_prompt.txt") $prompt | Out-Null
    Atomic-WriteFile (Join-Path $sysDir ".pending_$stage") "" | Out-Null
}

# ============================================================
# Stale Pending 偵測（Agent 崩潰保護）
# ============================================================
function Test-PendingStale {
    param([string]$taskDir, [int]$AgeMinutes = 30)
    $pendingPath = Join-Path (Get-SystemDir $taskDir) "pending_prompt.txt"
    if (-not (Test-Path $pendingPath)) { return $false }
    $age = (Get-Date) - (Get-Item $pendingPath).LastWriteTime
    return $age.TotalMinutes -gt $AgeMinutes
}

function Clear-StalePending {
    param([string]$taskDir)
    $taskName = Split-Path $taskDir -Leaf
    $sysDir = Get-SystemDir $taskDir
    Write-Host "[STALE] $taskName system/pending_prompt.txt 超過 30 分鐘，清除重新排隊" -ForegroundColor Yellow
    Remove-Item (Join-Path $sysDir "pending_prompt.txt") -Force -ErrorAction SilentlyContinue
    Get-ChildItem $sysDir -Filter ".pending_*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Test-HasBlocker {
    param([string]$taskDir)
    return [bool](Get-ChildItem (Get-SystemDir $taskDir) -Filter "blocker.*.txt" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# ============================================================
# Crash 修復（P0-03）：done marker 存在但 pending 殘留時補完原子協議
# ============================================================
function Resolve-CrashState {
    param([string]$taskDir, [string]$stage, [string]$doneMarker)
    $sysDir        = Get-SystemDir $taskDir
    $logDir        = Get-LogDir    $taskDir
    $doneFlag      = Join-Path $sysDir $doneMarker
    $pendingFlag   = Join-Path $sysDir ".pending_$stage"
    $pendingPrompt = Join-Path $sysDir "pending_prompt.txt"
    if (-not (Test-Path $doneFlag)) { return }
    if (-not (Test-Path $pendingFlag) -and -not (Test-Path $pendingPrompt)) { return }
    $taskName = Split-Path $taskDir -Leaf
    Write-Host "[CRASH-FIX] $taskName $stage crash 殘留，補完原子協議" -ForegroundColor Yellow
    if (Test-Path $pendingPrompt) {
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
        Move-Item $pendingPrompt (Join-Path $logDir 'done_prompt.txt') -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $pendingFlag -Force -ErrorAction SilentlyContinue
}

# ============================================================
# YAML 完整性驗證（防止空規格進入實作階段）
# ============================================================
function Test-YamlComplete {
    param([string]$yamlPath)
    if (-not (Test-Path $yamlPath)) { return $false }
    $content = Get-Content $yamlPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $content) { return $false }
    $hasTechSpec = $content -match '(?m)^technical_specification:'
    $hasModel    = ($content -match '(?m)\bmodel_name:\s*\S') -or ($content -match '(?m)odoo_models:')
    return $hasTechSpec -and $hasModel
}

# ============================================================
# 開啟 Claude Terminal（PS1 結束後觸發 AI 處理）
# ============================================================
function Open-ClaudeTerminal {
    # Hook 模式：Claude 已在執行，不開新 terminal
    if ($env:PIPELINE_HOOK_MODE -eq "1") {
        Write-Host "[PIPELINE] Hook 模式，略過開啟新 Terminal" -ForegroundColor DarkGray
        return
    }

    $pendingFiles = Get-ChildItem $script:PLAN_DIR -Recurse -Filter "pending_prompt.txt" -ErrorAction SilentlyContinue
    if (-not $pendingFiles -or $pendingFiles.Count -eq 0) {
        Write-Host "[PIPELINE] 無待處理 AI 任務" -ForegroundColor DarkGray
        return
    }

    Write-Host "[PIPELINE] $($pendingFiles.Count) 個任務等待 AI 處理，開啟 Claude..." -ForegroundColor Magenta

    # 寫入等待標記（含 ISO 時間戳，供 TTL 判斷），Claude 讀到後自動處理 pending 任務
    Atomic-WriteFile $script:PIPELINE_WAITING (Get-Date -Format 'o') | Out-Null

    # 優先用 Windows Terminal，否則開新 PowerShell 視窗
    if (Get-Command "wt" -ErrorAction SilentlyContinue) {
        Start-Process "wt" -ArgumentList @(
            "new-tab", "--startingDirectory", "`"$script:ROOT`"", "--", "claude"
        )
    } else {
        Start-Process "pwsh" -ArgumentList @(
            "-NoExit", "-Command", "Set-Location `"$script:ROOT`"; claude"
        ) -WindowStyle Normal
    }
}

# ============================================================
# 專案版本映射 & 目錄映射
# ============================================================
$script:ProjectVersionMap = $null
$script:ProjectDirMap     = $null

function Load-ProjectVersionMap {
    if ($null -ne $script:ProjectVersionMap) { return $script:ProjectVersionMap }
    $script:ProjectVersionMap = @{}
    $script:ProjectDirMap     = @{}
    if (Test-Path $script:PROJECT_VERSION_MAP_PATH) {
        try {
            $j = Get-Content $script:PROJECT_VERSION_MAP_PATH -Raw -Encoding UTF8 | ConvertFrom-Json
            $j.project_version_map.PSObject.Properties | ForEach-Object { $script:ProjectVersionMap[$_.Name] = $_.Value }
            if ($j.project_dir_map) {
                $j.project_dir_map.PSObject.Properties | ForEach-Object { $script:ProjectDirMap[$_.Name] = $_.Value }
            }
            Write-Host "[CONFIG] 載入 project_version_map.json，共 $($script:ProjectVersionMap.Count) 個專案，$($script:ProjectDirMap.Count) 個目錄對應" -ForegroundColor DarkCyan
        } catch {
            Write-Host "[WARN] 無法解析 project_version_map.json: $_" -ForegroundColor Yellow
        }
    }
    return $script:ProjectVersionMap
}

function Get-ProjectVersion {
    param([string]$projectName)
    $map = Load-ProjectVersionMap
    if ($map.ContainsKey($projectName)) { return $map[$projectName] }
    return $null
}

function Get-ProjectDir {
    param([string]$projectName)
    Load-ProjectVersionMap | Out-Null
    if ($script:ProjectDirMap -and $script:ProjectDirMap.ContainsKey($projectName)) {
        return $script:ProjectDirMap[$projectName]
    }
    return $null
}

# ============================================================
# WIKI 快取注入（供 PS1 在寫入 pending_prompt 前 prepend）
# ============================================================
function Get-WikiCache {
    param([string]$moduleName = $null, [string]$odooVersion, [string]$projectName = $null, [string[]]$keywords = $null)
    $hasModule   = -not [string]::IsNullOrWhiteSpace($moduleName)
    $hasKeywords = $keywords -and $keywords.Count -gt 0
    if (-not $hasModule -and -not $hasKeywords) { return "" }

    $addonsRoot = Get-OnlineAddonsRoot -odooVersion $odooVersion -projectName $projectName -moduleName $moduleName

    $wikiPath = [IO.Path]::Combine($addonsRoot, 'graphify-out', 'wiki', 'index.md')
    if (-not (Test-Path $wikiPath)) { return "" }

    try {
        $lines = Get-Content $wikiPath -Encoding UTF8
        if ($hasModule) {
            $matched = @($lines | Where-Object { $_ -match [regex]::Escape($moduleName) })
            if ($matched.Count -eq 0) { return "" }
            $block = ($matched | Select-Object -First 60) -join "`n"
        } else {
            $pattern = ($keywords | ForEach-Object { [regex]::Escape($_) }) -join '|'
            $matched = @($lines | Where-Object { $_ -match $pattern })
            if ($matched.Count -eq 0) { return "" }
            $block = ($matched | Select-Object -First 120) -join "`n"
        }
        return "[WIKI-CACHE]`n$block`n[/WIKI-CACHE]`n`n"
    } catch { return "" }
}

# ============================================================
# TOML Agent 檔案解析（供 Codex pipeline 讀取 .codex/agents/*.toml）
# ============================================================

function Get-TomlValue {
    param([string]$toml, [string]$section, [string]$key)
    if ([string]::IsNullOrEmpty($section)) {
        # Root-level key（Codex 官方格式：key = "value" 頂層）
        if ($toml -match "(?m)^$([regex]::Escape($key))\s*=\s*`"([^`"]*)`"") {
            return $matches[1]
        }
    } else {
        # Section key（舊格式：[section]\nkey = "value"）
        if ($toml -match "(?ms)\[$([regex]::Escape($section))\][^\[]*?^$([regex]::Escape($key))\s*=\s*`"([^`"]*)`"") {
            return $matches[1]
        }
    }
    return $null
}

function Get-TomlPromptContent {
    param([string]$toml)
    # Codex 官方格式：developer_instructions = """...""" 頂層多行字串
    if ($toml -match '(?ms)^developer_instructions\s*=\s*"""\s*\r?\n(.*?)\r?\n"""') {
        return $matches[1]
    }
    # 向下相容舊格式：[prompt].content = """..."""
    if ($toml -match '(?s)\[prompt\][^\[]*?content\s*=\s*"""\s*\r?\n(.*?)\r?\n"""') {
        return $matches[1]
    }
    return $null
}

# ============================================================
# MCP Budget 區塊（注入 pending_prompt.txt，防 session 內無限重試）
# ============================================================
function Get-McpBudgetBlock {
    return "[MCP-BUDGET]`nserena_queries_remaining: 3`non_serena_tool_use_error: write system/blocker.agent.txt immediately → STOP. Do NOT retry.`non_budget_exhausted: write system/blocker.agent.txt immediately → STOP.`ncontext7_on_failure: skip silently, proceed with available context.`n[/MCP-BUDGET]`n`n"
}

# ============================================================
# 現有模組快取
# ============================================================
$script:RepoModulesCache = $null

function Get-ExistingModules {
    if ($null -ne $script:RepoModulesCache) { return $script:RepoModulesCache }
    $all = @()
    if (Test-Path $script:ONLINE_ADDONS_DIR) {
        Get-ChildItem $script:ONLINE_ADDONS_DIR -Directory | ForEach-Object {
            $all += Get-ChildItem $_.FullName -Directory | Select-Object -ExpandProperty Name
        }
    }
    $script:RepoModulesCache = $all | Select-Object -Unique
    return $script:RepoModulesCache
}

# ============================================================
# Odoo 訊息發送
# ============================================================
function Send-OdooTaskMessage {
    param([string]$taskDirName, [string]$message)

    # service 來源尚未啟用通知，直接略過
    if ($taskDirName -match '_service_') { return }

    if (-not $env:ODOO_PASSWORD) { return }
    $disableFlag = Join-Path $script:PLAN_DIR "_ODOO_DISABLED"
    if (Test-Path $disableFlag) { Write-Host "[SKIP] Odoo 通知已停用" -ForegroundColor DarkGray; return }
    $py = Join-Path $script:CLAUDE_DIR "tools\send_message.py"
    if (-not (Test-Path $py)) { return }

    # 支援 task_123、task_odoo_123 兩種格式
    if ($taskDirName -match '^task_(?:odoo_)?(\d+)$') {
        $tid = [int]$matches[1]
    } else {
        Write-Host "[WARN] Send-OdooTaskMessage: 無法解析 task ID from '$taskDirName'" -ForegroundColor Yellow
        return
    }

    $r = python $py $script:ODOO_URL $script:ODOO_DB $script:ODOO_USERNAME $env:ODOO_PASSWORD $tid $message 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Odoo 訊息失敗: $r" -ForegroundColor Yellow }
}

# ============================================================
# 退回機制（4-B：若分析已完成則保留分析成果回 analysis/；否則完整退回 confirm/）
# ============================================================
function BackToConfirm {
    param([string]$taskDir, [string]$reason, [string]$stage)

    $taskName = Split-Path $taskDir -Leaf

    # 移動前先釋放 process.lock
    $lockPath = Join-Path $taskDir "process.lock"
    if ($script:LockHandles.ContainsKey($lockPath)) { Release-Lock $lockPath }
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue

    # 判斷分析是否已完整（有 technical_specification 或 analysis_result）
    $yamlPath         = Join-Path $taskDir "analysis.yaml"
    $analysisComplete = $false
    if (Test-Path $yamlPath) {
        $yc = Get-Content $yamlPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($yc -match 'technical_specification:' -or $yc -match 'analysis_result:') {
            $analysisComplete = $true
        }
    }

    if ($analysisComplete) {
        # ── Smart Rollback：保留 .analysis_done + .answer_done，退回 analysis/ ──
        $destDir = Join-Path $script:ANALYSIS_DIR $taskName
        if (Test-Path $destDir) { Remove-Item $destDir -Recurse -Force }
        try {
            Move-Item $taskDir $script:ANALYSIS_DIR -Force
        } catch {
            Write-Host "[ERROR] BackToConfirm (Smart) Move-Item 失敗: $_" -ForegroundColor Red
            return
        }

        $destSysDir = Get-SystemDir $destDir
        $destLogDir = Get-LogDir    $destDir
        # 只清除 final 之後的 markers（保留 .analysis_done .answer_done）
        @('.final_done', '.implement_done', '.qa_done', '.low_confidence',
          '.pending_final', '.pending_coding', '.pending_qa',
          'pending_prompt.txt',
          'blocker.spec.txt', 'blocker.tech.txt', 'blocker.agent.txt', 'blocker.loop.txt') | ForEach-Object {
            Remove-Item (Join-Path $destSysDir $_) -Force -ErrorAction SilentlyContinue
        }
        @('done_prompt.txt', 'qa_report.yaml', 'agent_error.txt') | ForEach-Object {
            Remove-Item (Join-Path $destLogDir $_) -Force -ErrorAction SilentlyContinue
        }

        $reentryFile = Join-Path $destSysDir '_reentry_count'
        $count = 0
        if (Test-Path $reentryFile) { try { $count = [int](Get-Content $reentryFile -Raw -EA SilentlyContinue) } catch {} }
        Atomic-WriteFile $reentryFile ([string]($count + 1)) | Out-Null
        Increment-TotalReentry $destSysDir $taskName | Out-Null

        # P1-01: QA 失敗退回時注入 _qa_failure_hint，防止 MODE_B SHORTCUT 跳過修正直接複製舊規格
        if ($stage -eq "QA" -and (Test-Path $yamlPath)) {
            try {
                $yc = Get-Content $yamlPath -Raw -Encoding UTF8
                if ($yc -notmatch '_qa_failure_hint:') {
                    $hint = $reason -replace "'", "''"
                    $yc  = $yc.TrimEnd() + "`n_qa_failure_hint: '$hint'`n"
                    Atomic-WriteFile $yamlPath $yc | Out-Null
                }
            } catch {}
        }

        $content = "退回時間: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n退回階段: $stage`n退回原因: $reason`n`n[Smart Rollback] 分析成果已保留（.analysis_done + .answer_done），從 final 規格階段重試，無需重跑分析。"
        Atomic-WriteFile (Join-Path $destLogDir 'back_reason.txt') $content | Out-Null

        Write-Host "[BACK-SMART] $taskName 從 $stage → analysis/（保留分析，省重跑）原因: $reason" -ForegroundColor Yellow
    } else {
        # ── 完整退回 confirm/（分析尚未完成，需從頭來過）──
        $confirmTaskDir = Join-Path $script:CONFIRM_DIR $taskName
        if (Test-Path $confirmTaskDir) { Remove-Item $confirmTaskDir -Recurse -Force }
        try {
            Move-Item $taskDir $script:CONFIRM_DIR -Force
        } catch {
            Write-Host "[ERROR] BackToConfirm Move-Item 失敗: $_" -ForegroundColor Red
            return
        }

        $confirmSysDir = Get-SystemDir $confirmTaskDir
        $confirmLogDir = Get-LogDir    $confirmTaskDir
        @('.analysis_done', '.answer_done', '.final_done', '.implement_done', '.qa_done',
          '.pending_analysis', '.pending_final', '.pending_coding', '.pending_qa',
          'pending_prompt.txt',
          'blocker.spec.txt', 'blocker.tech.txt', 'blocker.agent.txt', 'blocker.loop.txt') | ForEach-Object {
            Remove-Item (Join-Path $confirmSysDir $_) -Force -ErrorAction SilentlyContinue
        }
        @('done_prompt.txt', 'back_reason.txt', 'qa_report.yaml', 'agent_error.txt') | ForEach-Object {
            Remove-Item (Join-Path $confirmLogDir $_) -Force -ErrorAction SilentlyContinue
        }

        $reentryFile = Join-Path $confirmSysDir '_reentry_count'
        $count = 0
        if (Test-Path $reentryFile) { try { $count = [int](Get-Content $reentryFile -Raw -EA SilentlyContinue) } catch {} }
        Atomic-WriteFile $reentryFile ([string]($count + 1)) | Out-Null
        Increment-TotalReentry $confirmSysDir $taskName | Out-Null

        $content = "退回時間: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n退回階段: $stage`n退回原因: $reason`n`n請修正後重新填寫 analysis.yaml 中的 user_answer。"
        Atomic-WriteFile (Join-Path $confirmLogDir 'back_reason.txt') $content | Out-Null

        Write-Host "[BACK] $taskName 從 $stage 退回 confirm/  原因: $reason" -ForegroundColor Yellow
    }
}

# ============================================================
# 全域退回計數器（QA 失敗 + 低信心度退回合計）
# ============================================================
function Increment-TotalReentry {
    param([string]$sysDir, [string]$taskName)
    $totalFile  = Join-Path $sysDir '_total_reentry_count'
    $totalCount = 0
    if (Test-Path $totalFile) { try { $totalCount = [int](Get-Content $totalFile -Raw -EA SilentlyContinue) } catch {} }
    $totalCount++
    Atomic-WriteFile $totalFile ([string]$totalCount) | Out-Null
    $maxTotal = if ($env:PIPELINE_MAX_TOTAL_REENTRY) { [int]$env:PIPELINE_MAX_TOTAL_REENTRY } else { 6 }
    if ($totalCount -gt $maxTotal) {
        $bMsg = "blocker_type: loop`ntask_id: $taskName`ntimestamp: $(Get-Date -Format 'o')`ntotal_reentry_count: $totalCount`nlimit: $maxTotal`nreason: |`n  任務總退回次數（QA失敗＋低信心度合計）$totalCount 次超過上限 $maxTotal，需人工確認需求後手動刪除 system/_total_reentry_count 再觸發。"
        Atomic-WriteFile (Join-Path $sysDir 'blocker.loop.txt') $bMsg | Out-Null
        Write-Host "[BLOCKER] $taskName 總退回 $totalCount 次超過上限 $maxTotal → blocker.loop.txt" -ForegroundColor Red
        return $true
    }
    return $false
}

# ============================================================
# 新訊息偵測 helpers
# ============================================================
function Get-LastMessageTs {
    param([string]$originalTxt)
    if (-not (Test-Path $originalTxt)) { return $null }
    $content = Get-Content $originalTxt -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $content) { return $null }
    # 取所有 [YYYY-MM-DD HH:MM:SS] 中最大值（含 append 後的 detected-at 時間戳，防重複偵測）
    $allTs = [regex]::Matches($content, '\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]') |
        ForEach-Object { $_.Groups[1].Value }
    if (-not $allTs) { return $null }
    return ($allTs | Sort-Object -Descending | Select-Object -First 1)
}

function Get-OdooSourceParams {
    param([string]$taskName)
    if ($taskName -match '^task_service_') {
        return @{
            URL      = $script:ODOO_SERVICE_URL
            DB       = $script:ODOO_SERVICE_DB
            Username = $script:ODOO_SERVICE_USERNAME
            Password = $env:ODOO_SERVICE_PASSWORD
            Model    = "service.question.feedback"
        }
    }
    return @{
        URL      = $script:ODOO_URL
        DB       = $script:ODOO_DB
        Username = $script:ODOO_USERNAME
        Password = $env:ODOO_PASSWORD
        Model    = "project.task"
    }
}

# ============================================================
# 安全移動（失敗時自動清除已寫入的 rollback 檔案）
# ============================================================
function Safe-MoveWithRollback {
    param([string]$src, [string]$destDir, [string[]]$rollbackFiles = @())
    $destPath = Join-Path $destDir (Split-Path $src -Leaf)
    if (Test-Path $destPath) { Remove-Item $destPath -Recurse -Force -ErrorAction SilentlyContinue }
    try {
        Move-Item $src $destDir -Force -ErrorAction Stop
        return $true
    } catch {
        Write-Host "[ROLLBACK] Move 失敗，清除殘留: $_" -ForegroundColor Red
        foreach ($f in $rollbackFiles) {
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
        return $false
    }
}
