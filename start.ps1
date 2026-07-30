#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

$configPath = Join-Path $Root "data\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "Error: data/config.json not found. Please run install.ps1 first." -ForegroundColor Red
    exit 1
}

try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "Error: data/config.json is corrupt. Please run install.ps1 again." -ForegroundColor Red
    exit 1
}

if (-not $config.JWT_SECRET) {
    Write-Host "Error: JWT_SECRET missing from config.json." -ForegroundColor Red
    exit 1
}

$env:JWT_SECRET    = $config.JWT_SECRET
$env:PORT          = if ($config.PORT) { $config.PORT } else { 3939 }
if ($config.DATABASE_URL)     { $env:DATABASE_URL     = $config.DATABASE_URL }
if ($config.ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = $config.ANTHROPIC_API_KEY }
if ($config.APP_SECRET)       { $env:APP_SECRET       = $config.APP_SECRET }
# 測試區埠範圍（選用）：未設定則沿用程式預設 8069-20068，行為不變。
if ($config.PROJECT_PORT_MIN) { $env:PROJECT_PORT_MIN = $config.PROJECT_PORT_MIN }
if ($config.PROJECT_PORT_MAX) { $env:PROJECT_PORT_MAX = $config.PROJECT_PORT_MAX }

# 有缺才裝：pull 到新增相依（如 archiver）後直接啟動會 MODULE_NOT_FOUND；
# 比對 npm 的 hidden lockfile 與 package-lock.json，缺標記或 lockfile 較新才補裝，相依已滿足則秒過。
$appDir = Join-Path $Root "app"
$marker = Join-Path $appDir "node_modules\.package-lock.json"
$lock   = Join-Path $appDir "package-lock.json"
$needInstall = -not (Test-Path $marker)
if (-not $needInstall -and (Test-Path $lock) -and `
    (Get-Item $lock).LastWriteTime -gt (Get-Item $marker).LastWriteTime) {
    $needInstall = $true
}
if ($needInstall) {
    Write-Host "偵測到相依有異動，執行 npm install..." -ForegroundColor Yellow
    Push-Location $appDir
    npm install --prefer-offline
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host "Error: npm install 失敗。" -ForegroundColor Red; exit 1 }
    Pop-Location
}

$port = if ($config.PORT) { $config.PORT } else { 3939 }

# 埠占用預檢：先開瀏覽器再啟動，會讓「重複執行」看起來像成功了——瀏覽器照樣跳出來、
# 連到的其實是前一個 server，而這次啟動已經失敗。index.js 現在會自己結束並印原因，
# 但那行訊息一閃即逝，容易被當成正常。在這裡先擋掉，訊息才留得住。
# 取不到 Get-NetTCPConnection（舊系統）時安靜略過，index.js 那道守衛仍會把關。
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $pids = ($busy | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Write-Host "Error: 埠 $port 已被占用（PID $pids）——server 應該已經在跑了。" -ForegroundColor Red
    Write-Host "       要重啟請先結束那個行程：Stop-Process -Id $pids -Force" -ForegroundColor Yellow
    exit 1
}

Start-Process "http://localhost:$port"
node (Join-Path $Root "app\server\index.js")
