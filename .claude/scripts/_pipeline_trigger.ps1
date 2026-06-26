[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$json = [Console]::In.ReadToEnd()
try {
    $prompt = ($json | ConvertFrom-Json).prompt
} catch {
    exit 0
}
if ($prompt -match 'codex開工') {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    pwsh -NoProfile -File "$scriptDir\..\..\.codex\scripts\_pipeline_run_codex.ps1"
} elseif ($prompt -match '開工') {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    pwsh -NoProfile -File "$scriptDir\_pipeline_run.ps1"
} elseif ($prompt -match '同步') {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    pwsh -NoProfile -File "$scriptDir\_sync.ps1"
}
