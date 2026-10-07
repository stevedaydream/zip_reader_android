# 產生版本更新內容：抓上一個 tag 之後的 commit 標題，寫到 CHANGELOG.md 最上方
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-notes.ps1 -Version 0.2.7
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = "Stop"
# git 輸出為 UTF-8，避免中文 commit 標題亂碼
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$lastTag = git describe --tags --abbrev=0 2>$null
$range = if ($lastTag) { "$lastTag..HEAD" } else { "HEAD" }

$lines = git log $range --no-merges --pretty=format:"%s" |
    Where-Object { $_ -and $_ -notmatch '^chore: bump version' -and $_ -notmatch '^docs:' } |
    ForEach-Object { "- $_" }
if (-not $lines) { $lines = @("- 小幅修正與改進") }

$date = Get-Date -Format "yyyy-MM-dd"
$section = "## v$Version（$date）`n`n" + ($lines -join "`n") + "`n"

$path = Join-Path (Get-Location) "CHANGELOG.md"
$enc = New-Object System.Text.UTF8Encoding($false)
$header = "# 更新紀錄`n`n"
$old = if (Test-Path $path) { [System.IO.File]::ReadAllText($path, $enc) -replace '^# 更新紀錄\r?\n\r?\n', '' } else { "" }
[System.IO.File]::WriteAllText($path, $header + $section + "`n" + $old, $enc)

Write-Output "上一版：$(if ($lastTag) { $lastTag } else { '（無）' })"
Write-Output $section
