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

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)

    $config = [ordered]@{
        DATABASE_URL = $databaseUrl
        JWT_SECRET   = $secret
        PORT         = 3939
    }
    $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Host "Config saved: $configPath" -ForegroundColor Green
} else {
    Write-Host "Config already exists, skipping: $configPath" -ForegroundColor Yellow
}

# 5. Load config and set env vars
$config = Get-Content $configPath | ConvertFrom-Json
$env:DATABASE_URL = $config.DATABASE_URL
$env:JWT_SECRET   = $config.JWT_SECRET
$env:PORT         = $config.PORT

# 6. Start server and open browser
Write-Host ""
Write-Host "Starting AI Dev at http://localhost:$($config.PORT) ..." -ForegroundColor Cyan
Start-Process "http://localhost:$($config.PORT)/setup.html"
node (Join-Path $Root "app\server\index.js")
