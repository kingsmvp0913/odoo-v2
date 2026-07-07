#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=== AI Dev Setup ===" -ForegroundColor Cyan

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Node.js 20 LTS..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js install failed. Please install manually: https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

# 2. Install dependencies
Write-Host "Installing packages..." -ForegroundColor Yellow
Set-Location (Join-Path $Root "app")
npm install --prefer-offline
Set-Location $Root

# 3. Create data directory
$dataDir = Join-Path $Root "data"
New-Item -ItemType Directory -Force $dataDir | Out-Null

# 4. PostgreSQL connection setup
$configPath = Join-Path $dataDir "config.json"

if (-not (Test-Path $configPath)) {
    Write-Host ""
    Write-Host "=== PostgreSQL Connection Setup ===" -ForegroundColor Cyan
    Write-Host "(Press Enter to accept defaults in brackets)" -ForegroundColor Gray

    $pgHost = if ($env:PG_HOST) { $env:PG_HOST } else {
        $v = Read-Host "PG_HOST [localhost]"
        if ([string]::IsNullOrWhiteSpace($v)) { "localhost" } else { $v }
    }

    $pgPort = if ($env:PG_PORT) { $env:PG_PORT } else {
        $v = Read-Host "PG_PORT [5432]"
        if ([string]::IsNullOrWhiteSpace($v)) { "5432" } else { $v }
    }

    $pgDb = if ($env:PG_DB) { $env:PG_DB } else {
        $v = Read-Host "PG_DB [aidev]"
        if ([string]::IsNullOrWhiteSpace($v)) { "aidev" } else { $v }
    }

    $pgUser = if ($env:PG_USER) { $env:PG_USER } else {
        Read-Host "PG_USER"
    }

    $pgPassword = if ($env:PG_PASSWORD) { $env:PG_PASSWORD } else {
        Read-Host "PG_PASSWORD"
    }

    $databaseUrl = "postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDb}"

    function New-RandomSecret {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        [Convert]::ToBase64String($bytes)
    }

    # ANTHROPIC_API_KEY 供資料庫查詢 AI 功能使用（可留空稍後補）
    $apiKey = if ($env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY } else {
        Read-Host "ANTHROPIC_API_KEY (optional, Enter to skip)"
    }

    $config = [ordered]@{
        DATABASE_URL = $databaseUrl
        JWT_SECRET   = New-RandomSecret
        APP_SECRET   = New-RandomSecret
        PORT         = 3939
    }
    if (-not [string]::IsNullOrWhiteSpace($apiKey)) { $config.ANTHROPIC_API_KEY = $apiKey }
    $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Host "Config saved: $configPath" -ForegroundColor Green
} else {
    Write-Host "Config already exists, skipping: $configPath" -ForegroundColor Yellow
}

# 5. Load config and set env vars
$config = Get-Content $configPath | ConvertFrom-Json

# 既有安裝缺 APP_SECRET 時補產（缺它會讓可逆加密／E2E 憑證功能直接 500）
if (-not $config.APP_SECRET) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $config | Add-Member -NotePropertyName APP_SECRET -NotePropertyValue ([Convert]::ToBase64String($bytes)) -Force
    $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Host "APP_SECRET generated and saved." -ForegroundColor Green
}

$env:DATABASE_URL = $config.DATABASE_URL
$env:JWT_SECRET   = $config.JWT_SECRET
$env:APP_SECRET   = $config.APP_SECRET
$env:PORT         = $config.PORT
if ($config.ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = $config.ANTHROPIC_API_KEY }

# 6. Start server and open browser
Write-Host ""
Write-Host "Starting AI Dev at http://localhost:$($config.PORT) ..." -ForegroundColor Cyan
Start-Process "http://localhost:$($config.PORT)/setup.html"
node (Join-Path $Root "app\server\index.js")
