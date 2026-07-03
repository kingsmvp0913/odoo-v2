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

$port = if ($config.PORT) { $config.PORT } else { 3939 }
Start-Process "http://localhost:$port"
node (Join-Path $Root "app\server\index.js")
