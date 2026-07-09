#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=== odoo-v2 系統套件安裝 (Windows) ===" -ForegroundColor Cyan

function Install-WingetPackage($id, $displayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "找不到 winget，請手動安裝 $displayName" -ForegroundColor Red
        exit 1
    }
    Write-Host "安裝 $displayName..." -ForegroundColor Yellow
    winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-WingetPackage "Git.Git" "Git" }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Install-WingetPackage "Python.Python.3.12" "Python 3.12" }
$chromeCandidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
)
if (-not ($chromeCandidates | Where-Object { Test-Path $_ })) { Install-WingetPackage "Google.Chrome" "Google Chrome" }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { Install-WingetPackage "astral-sh.uv" "uv" }
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { Install-WingetPackage "PostgreSQL.PostgreSQL" "PostgreSQL" }

# 重新整理 PATH（winget 裝完當前 session 讀不到新 PATH）
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 安裝失敗，請手動安裝後重跑：https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

node (Join-Path $Root "scripts\setup.js") @args
