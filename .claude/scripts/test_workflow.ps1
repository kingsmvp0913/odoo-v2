# test_workflow.ps1
# 用途：模擬 pipeline 中知識檢索路徑的可用性，估算 token 浪費
# 使用方式：
#   pwsh .claude/scripts/test_workflow.ps1                      # 自動掃描現有任務目錄
#   pwsh .claude/scripts/test_workflow.ps1 -Module sale -Version 17.0 -Project null

param(
    [string]$Module,          # 手動指定模組名稱
    [string]$Version,         # 手動指定 Odoo 版本
    [string]$Project,         # 手動指定專案名稱（可 null）
    [switch]$AutoScan         # 自動掃描 analysis/ 與 coding/ 目錄（預設行為）
)

. (Join-Path $PSScriptRoot "_common.ps1")

$planDir = $script:PLAN_DIR  # 從 _common.ps1 繼承（kingsmvpsplan/ 在 repo 根層）

function Test-SerenaPort {
    param([int]$Port = 8080, [int]$TimeoutMs = 2000)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $async = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
        $wait = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($wait) {
            $tcp.EndConnect($async)
            $tcp.Close()
            return $true
        } else {
            $tcp.Close()
            return $false
        }
    } catch {
        return $false
    }
}

function Get-WikiInfo {
    param($moduleName, $odooVersion, $projectName)
    $addonsRoot = Get-OnlineAddonsRoot -odooVersion $odooVersion -projectName $projectName -moduleName $moduleName
    $wikiDir = Join-Path $addonsRoot "graphify-out" "wiki"
    $indexFile = Join-Path $wikiDir "index.md"
    $moduleFile = Join-Path $wikiDir "$moduleName.md"
    
    $info = [PSCustomObject]@{
        Exists = $false
        IndexExists = $false
        ModuleFileExists = $false
        Lines = 0
        ModuleLines = 0
        Sample = ""
    }
    
    if (Test-Path $indexFile) {
        $info.IndexExists = $true
        $content = Get-Content $indexFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        $info.Lines = ($content -split "`n").Count
        if ($content -match $moduleName) {
            $info.Exists = $true
            # 擷取前5行作為樣本
            $sampleLines = $content -split "`n" | Select-Object -First 5
            $info.Sample = $sampleLines -join "`n"
        }
    }
    
    if (Test-Path $moduleFile) {
        $info.ModuleFileExists = $true
        $moduleContent = Get-Content $moduleFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        $info.ModuleLines = ($moduleContent -split "`n").Count
        if (-not $info.Exists) { $info.Exists = $true }
        if ([string]::IsNullOrEmpty($info.Sample)) {
            $sampleLines = $moduleContent -split "`n" | Select-Object -First 10
            $info.Sample = $sampleLines -join "`n"
        }
    }
    
    return $info
}

function Estimate-TokenWaste {
    param(
        $wikiInfo,
        [bool]$serenaAvailable
    )
    # 基礎浪費（每次 loop 約 35k tokens）
    $baseWaste = 35000
    
    if ($wikiInfo.Exists -and $wikiInfo.ModuleFileExists -and $wikiInfo.ModuleLines -gt 20) {
        # wiki 完整且模組專屬檔案存在，內容豐富
        if ($serenaAvailable) {
            return 5000   # 很低
        } else {
            return 12000  # 中等
        }
    } elseif ($wikiInfo.Exists) {
        # 只有 index 匹配，沒有詳細內容
        if ($serenaAvailable) {
            return 18000
        } else {
            return 28000
        }
    } else {
        # 完全沒有 wiki
        if ($serenaAvailable) {
            return 25000
        } else {
            return 40000
        }
    }
}

function Write-ColorOutput {
    param($Color, $Text)
    Write-Host $Text -ForegroundColor $Color
}

# ============================================================
# 主程式
# ============================================================
Write-Host "`n=== 知識檢索可用性診斷 ===" -ForegroundColor Cyan

$serenaOk = Test-SerenaPort
if ($serenaOk) {
    Write-ColorOutput -Color Green "✓ Serena 服務 (port 8080) 正常"
} else {
    Write-ColorOutput -Color Red "✗ Serena 服務無法連線 (port 8080)"
}

$tasksToCheck = @()
if ($AutoScan -or ($null -eq $Module -and $null -eq $Version)) {
    # 自動掃描模式
    $dirs = @("analysis", "coding")
    foreach ($sub in $dirs) {
        $taskRoot = Join-Path $planDir $sub
        if (Test-Path $taskRoot) {
            Get-ChildItem $taskRoot -Directory | ForEach-Object {
                $yaml = Join-Path $_.FullName "analysis.yaml"
                if (Test-Path $yaml) {
                    try {
                        $content = Get-Content $yaml -Raw -Encoding UTF8
                        $parsed = ConvertFrom-Yaml $content
                        $mod = $parsed['module']
                        $ver = $parsed['odoo_version']
                        $proj = $parsed['project_name']
                        if ($mod -and $ver) {
                            $tasksToCheck += [PSCustomObject]@{
                                Task = $_.Name
                                Module = $mod
                                Version = $ver
                                Project = $proj
                            }
                        }
                    } catch {}
                }
            }
        }
    }
    if ($tasksToCheck.Count -eq 0) {
        Write-ColorOutput -Color Yellow "未發現任何 analysis.yaml，請手動指定參數："
        Write-ColorOutput -Color White "  pwsh test_workflow.ps1 -Module <name> -Version <ver> [-Project <proj>]"
        exit 1
    }
} else {
    $tasksToCheck += [PSCustomObject]@{
        Task = "manual"
        Module = $Module
        Version = $Version
        Project = $Project
    }
}

$totalWaste = 0
$anyWikiMissing = $false
$anySerenaIssue = $false

foreach ($task in $tasksToCheck) {
    Write-Host "`n--- 任務: $($task.Task) | 模組: $($task.Module) | 版本: $($task.Version) ---" -ForegroundColor Yellow
    
    $wiki = Get-WikiInfo -moduleName $task.Module -odooVersion $task.Version -projectName $task.Project
    
    if ($wiki.Exists) {
        if ($wiki.ModuleFileExists) {
            Write-ColorOutput -Color Green "✓ Wiki 完整（模組專屬檔案存在，${$wiki.ModuleLines} 行）"
        } else {
            Write-ColorOutput -Color Yellow "△ Wiki 部分存在（僅 index.md 匹配，無 $($task.Module).md）"
            $anyWikiMissing = $true
        }
        if ($wiki.Sample) {
            Write-Host "  樣本內容（前5行）：" -ForegroundColor DarkGray
            Write-Host ($wiki.Sample -split "`n" | ForEach-Object { "    $_" }) -ForegroundColor DarkGray
        }
    } else {
        Write-ColorOutput -Color Red "✗ Wiki 不存在（未找到 $($task.Module) 相關內容）"
        $anyWikiMissing = $true
    }
    
    if (-not $serenaOk) {
        $anySerenaIssue = $true
    }
    
    $waste = Estimate-TokenWaste -wikiInfo $wiki -serenaAvailable $serenaOk
    $totalWaste += $waste
    Write-Host "  預估每次 loop token 浪費: $waste" -ForegroundColor Cyan
}

Write-Host "`n=== 總結 ===" -ForegroundColor Cyan
if ($anyWikiMissing) {
    Write-ColorOutput -Color Red "⚠️ 警告：Graphify wiki 不完整，將導致 Agent 大量依賴 Serena 或盲猜"
    Write-ColorOutput -Color Yellow "   建議執行 Graphify 重新產生 wiki："
    Write-ColorOutput -Color White "     cd C:\online_addons; python -m graphify.core --regen"
}
if (-not $serenaOk) {
    Write-ColorOutput -Color Red "⚠️ 警告：Serena 服務未啟動，Agent 將無法取得程式碼符號資訊"
    Write-ColorOutput -Color Yellow "   啟動方式（擇一）："
    Write-ColorOutput -Color White "     1. Serena Desktop 應用程式"
    Write-ColorOutput -Color White "     2. `"serena start`" 命令（需安裝 serena CLI）"
    Write-ColorOutput -Color White "     3. 修改 .claude/settings.json 移除 serena MCP 伺服器"
}
if ($anyWikiMissing -or (-not $serenaOk)) {
    Write-ColorOutput -Color Yellow "`n預期每個任務平均 loop 次數：2 ~ 3 次"
    Write-ColorOutput -Color Yellow "預期每個任務總 token 浪費：約 $totalWaste ~ $($totalWaste * 1.5)"
    Write-ColorOutput -Color Cyan "優化建議："
    Write-ColorOutput -Color White "  1. 確保 Graphify wiki 已產生且包含模組專屬 .md 檔案"
    Write-ColorOutput -Color White "  2. 啟動 Serena 服務，並驗證 MCP 連線（port 8080）"
    Write-ColorOutput -Color White "  3. 若無法啟用 Serena，請在 prompt 中提示 Agent 避免使用，或降低 Serena 查詢上限"
} else {
    Write-ColorOutput -Color Green "✓ 所有知識檢索路徑正常，預計 token 浪費極低"
}

Write-Host "`n[診斷完成]" -ForegroundColor DarkGray