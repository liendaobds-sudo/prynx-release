#requires -version 5
# PrynX - terminal theo dõi trực tiếp một lượt build/phát hành đang chạy.
param(
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][int]$ControllerPid,
    [ValidateRange(50, 5000)][int]$PollMilliseconds = 250,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "PrynX - Build và phát hành"

function Read-CurrentRunStatus {
    $latestPath = Join-Path $StateRoot "latest.json"
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return $null }
    try {
        $status = Get-Content -LiteralPath $latestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$status.controllerPid -ne $ControllerPid) { return $null }
        return $status
    }
    catch { return $null }
}

$status = $null
$attachDeadline = [DateTime]::UtcNow.AddSeconds(30)
while ($null -eq $status -and [DateTime]::UtcNow -lt $attachDeadline) {
    $status = Read-CurrentRunStatus
    if ($null -eq $status) { Start-Sleep -Milliseconds $PollMilliseconds }
}
if ($null -eq $status) {
    throw "Không tìm thấy trạng thái của lượt build vừa khởi động (controller PID $ControllerPid)."
}

$modeLabel = if ([string]$status.mode -eq "publish") { "PHÁT HÀNH" } else { "BUILD NỘI BỘ" }
$Host.UI.RawUI.WindowTitle = "PrynX - $modeLabel"
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " PrynX - $modeLabel" -ForegroundColor Cyan
Write-Host (" Bắt đầu: " + [string]$status.startedAtUtc)
Write-Host " Đóng cửa sổ này không làm dừng build." -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor DarkGray

$logPath = [string]$status.logPath
while (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
    $status = Read-CurrentRunStatus
    if ($null -eq $status -or [string]$status.state -notin @("starting", "running")) { break }
    Start-Sleep -Milliseconds $PollMilliseconds
}

$stream = $null
$exitCode = 1
try {
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $stream = New-Object IO.FileStream(
            $logPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        )
        $decoder = [Text.Encoding]::UTF8.GetDecoder()
        $bytes = New-Object byte[] 16384
        $chars = New-Object char[] ([Text.Encoding]::UTF8.GetMaxCharCount($bytes.Length))

        while ($true) {
            while (($readCount = $stream.Read($bytes, 0, $bytes.Length)) -gt 0) {
                $charCount = $decoder.GetChars($bytes, 0, $readCount, $chars, 0, $false)
                if ($charCount -gt 0) { [Console]::Write($chars, 0, $charCount) }
            }

            $status = Read-CurrentRunStatus
            if ($null -eq $status) {
                Write-Host "`nKhông còn đọc được trạng thái của lượt build." -ForegroundColor Red
                break
            }
            if ([string]$status.state -notin @("starting", "running")) {
                break
            }
            Start-Sleep -Milliseconds $PollMilliseconds
        }
    }

    if ($null -ne $status -and [string]$status.state -notin @("starting", "running")) {
        if ($stream) {
            # Đọc nốt phần cuối được ghi cùng lúc với trạng thái kết thúc.
            Start-Sleep -Milliseconds $PollMilliseconds
            while (($readCount = $stream.Read($bytes, 0, $bytes.Length)) -gt 0) {
                $charCount = $decoder.GetChars($bytes, 0, $readCount, $chars, 0, $false)
                if ($charCount -gt 0) { [Console]::Write($chars, 0, $charCount) }
            }
        }
        $exitCode = if ($null -eq $status.exitCode) { 1 } else { [int]$status.exitCode }
        $color = if ($exitCode -eq 0) { "Green" } else { "Red" }
        Write-Host "`n============================================================" -ForegroundColor DarkGray
        Write-Host ([string]$status.message) -ForegroundColor $color
        Write-Host ("Mã thoát: " + $exitCode) -ForegroundColor $color
    }
}
finally {
    if ($stream) { $stream.Dispose() }
}

if (-not $NoPause) { [void](Read-Host "Nhấn Enter để đóng cửa sổ") }
exit $exitCode
