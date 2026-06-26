# _sync.ps1 - 雙來源 Odoo 任務同步（不啟動 pipeline）
. (Join-Path $PSScriptRoot "_common.ps1")

Initialize-PipelineDirs

Write-Host "[SYNC] 同步 Odoo 任務..." -ForegroundColor Cyan

$odooDisableFlag = Join-Path $script:PLAN_DIR "_ODOO_DISABLED"
if (Test-Path $odooDisableFlag) {
    Write-Host "[SKIP] Odoo 同步已停用（刪除 _ODOO_DISABLED 可重新啟用）" -ForegroundColor DarkGray
    exit 0
}

$allDirs = @($script:START_DIR, $script:CONFIRM_DIR, $script:ANALYSIS_DIR, $script:CODING_DIR, $script:FINAL_DIR, $script:STOP_DIR)

# 來源 1（odoo）skip list：task_N 和 task_odoo_N
$odooSkipIds = @()
foreach ($dir in $allDirs) {
    if (Test-Path $dir) {
        Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -match '^task_(?:odoo_)?(\d+)$') { $odooSkipIds += $matches[1] }
        }
    }
}
$odooSkipStr = ($odooSkipIds | Select-Object -Unique) -join ","

# 來源 2（service）skip list
$serviceSkipIds = @()
foreach ($dir in $allDirs) {
    if (Test-Path $dir) {
        Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -match '^task_service_(\d+)$') { $serviceSkipIds += $matches[1] }
        }
    }
}
$serviceSkipStr = ($serviceSkipIds | Select-Object -Unique) -join ","

# 來源 2（service）stop skip list
$serviceStopIds = @()
if (Test-Path $script:STOP_DIR) {
    Get-ChildItem $script:STOP_DIR -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -match '^task_service_(\d+)$') { $serviceStopIds += $matches[1] }
    }
}
$serviceStopStr = ($serviceStopIds | Select-Object -Unique) -join ","

$pyScript1 = Join-Path $script:CLAUDE_DIR "tools\curl.py"
$pyScript2 = Join-Path $script:CLAUDE_DIR "tools\curl_service.py"

# 來源 1：odoo（project.task）
if ($env:ODOO_PASSWORD) {
    try {
        $out = python $pyScript1 $script:ODOO_URL $script:ODOO_DB $script:ODOO_USERNAME $env:ODOO_PASSWORD $script:ODOO_USER_ID $script:START_DIR "task_odoo_" $odooSkipStr 2>&1
        $out | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Odoo 來源 1 同步失敗，exit: $LASTEXITCODE" -ForegroundColor Yellow }
    } catch {
        Write-Host "[WARN] Odoo 來源 1 同步例外: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "[SKIP] ODOO_PASSWORD 未設定，略過來源 1 同步" -ForegroundColor DarkGray
}

# 來源 2：service（service.question.feedback）
if ($env:ODOO_SERVICE_PASSWORD) {
    try {
        $out = python $pyScript2 $script:ODOO_SERVICE_URL $script:ODOO_SERVICE_DB $script:ODOO_SERVICE_USERNAME $env:ODOO_SERVICE_PASSWORD $script:ODOO_SERVICE_USER_ID $script:START_DIR "task_service_" $serviceSkipStr $serviceStopStr 2>&1
        $out | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Odoo 來源 2 同步失敗，exit: $LASTEXITCODE" -ForegroundColor Yellow }
    } catch {
        Write-Host "[WARN] Odoo 來源 2 同步例外: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "[SKIP] ODOO_SERVICE_PASSWORD 未設定，略過來源 2 同步" -ForegroundColor DarkGray
}

Write-Host "[SYNC] 完成" -ForegroundColor Green
