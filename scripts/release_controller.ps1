#requires -version 5
# ASCII bootstrap marker: Windows PowerShell 5 requires this file to stay UTF-8 BOM.
# PrynX - controller build/release nền. Lưu UTF-8 BOM để PowerShell 5 đọc tiếng Việt đúng.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("internal", "publish")]
    [string]$Mode,
    [string]$Version = "",
    [string]$NotesBase64 = "",
    [string]$StateRoot = "",
    [string]$SigningPasswordPath = "",
    # Chỉ phục vụ regression test controller; GUI không truyền tham số này.
    [string]$CommandPath = ""
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$mutexName = ""
$mutex = $null
$ownsMutex = $false
$runDirectory = $null
$statusPath = $null
$logPath = $null
$childProcess = $null
$logWriter = $null
$signingPassword = ""
$startedAtUtc = [DateTime]::UtcNow
$stopwatch = [Diagnostics.Stopwatch]::StartNew()

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 8
    $tempPath = "$Path.$PID.tmp"
    $backupPath = "$Path.$PID.bak"
    [IO.File]::WriteAllText($tempPath, $json, [Text.UTF8Encoding]::new($false))
    $lastError = $null
    try {
        for ($attempt = 1; $attempt -le 100; $attempt++) {
            try {
                if ([IO.File]::Exists($Path)) {
                    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
                    [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
                }
                else {
                    [IO.File]::Move($tempPath, $Path)
                }
                return
            }
            catch [IO.IOException] {
                $lastError = $_.Exception
            }
            catch [UnauthorizedAccessException] {
                $lastError = $_.Exception
            }
            if ($attempt -lt 100) { Start-Sleep -Milliseconds 50 }
        }
        throw "Không thể cập nhật file trạng thái sau 5 giây: $Path. $($lastError.Message)"
    }
    finally {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-RunStatus {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowNull()][Nullable[int]]$ExitCode = $null,
        [AllowNull()][Nullable[int]]$ChildPid = $null
    )

    if ([string]::IsNullOrWhiteSpace($statusPath)) { return }
    $status = [ordered]@{
        schema = 1
        runId = Split-Path -Leaf $runDirectory
        mode = $Mode
        version = $Version
        state = $State
        stage = $Stage
        message = $Message
        controllerPid = $PID
        childPid = $ChildPid
        startedAtUtc = $startedAtUtc.ToString("o")
        updatedAtUtc = [DateTime]::UtcNow.ToString("o")
        durationSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
        exitCode = $ExitCode
        logPath = $logPath
    }
    Write-JsonAtomic -Path $statusPath -Value $status
    Write-JsonAtomic -Path (Join-Path $StateRoot "latest.json") -Value $status
}

function Test-ProcessAlive {
    param([AllowNull()][Nullable[int]]$ProcessId)

    if ($null -eq $ProcessId -or $ProcessId -le 0) { return $false }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Start-PowerShellChild {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    function Quote-ProcessArgument([string]$Value) {
        if ($null -eq $Value) { return '""' }
        if ($Value -notmatch '[\s"]') { return $Value }
        $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
        return '"' + $escaped + '"'
    }

    # ProcessStartInfo giữ được exit code thật ngay cả khi stdout/stderr được redirect.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = "powershell.exe"
    $startInfo.Arguments = (@($Arguments | ForEach-Object {
        Quote-ProcessArgument ([string]$_)
    }) -join ' ')
    $startInfo.WorkingDirectory = $ROOT
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Không khởi động được tiến trình PowerShell con." }
        return $process
    }
    catch {
        $process.Dispose()
        throw
    }
}

function Get-StageFromLog {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "Khởi động" }
    try {
        $tail = (Get-Content -LiteralPath $Path -Tail 120 -ErrorAction Stop) -join "`n"
    } catch { return "Đang chạy" }
    if ($tail -match '(?m)\[5/5\]|BUILD COMPLETE') { return "Đóng gói bộ cài" }
    if ($tail -match '(?m)\[4/5\]') { return "Build giao diện" }
    if ($tail -match '(?m)\[3/5\]') { return "Tính mã toàn vẹn" }
    if ($tail -match '(?m)\[2/5\]') { return "Chuẩn bị sidecar" }
    if ($tail -match '(?m)\[1/5\]') { return "Biên dịch backend" }
    if ($tail -match '(?m)\[0/5\]|\[QA\]') { return "Kiểm thử phát hành" }
    if ($tail -match '(?i)release .*upload|phat hanh xong|tao/cap nhat release') { return "Tải bản phát hành" }
    if ($tail -match '(?i)runtime smoke|runtime verifier|installed-artifact') { return "Nghiệm thu bản cài" }
    return "Đang chạy"
}

function Read-SigningPassword {
    if ([string]::IsNullOrWhiteSpace($SigningPasswordPath)) { return "" }
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedPath = [IO.Path]::GetFullPath($SigningPasswordPath)
    if (-not $resolvedPath.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Từ chối đọc mật khẩu khóa ký ngoài thư mục Temp."
    }
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Không tìm thấy gói mật khẩu khóa ký tạm thời."
    }
    try {
        $protected = [Convert]::FromBase64String([IO.File]::ReadAllText($resolvedPath).Trim())
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try { return [Text.Encoding]::UTF8.GetString($plainBytes) }
        finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    }
    finally {
        Remove-Item -LiteralPath $resolvedPath -Force -ErrorAction SilentlyContinue
    }
}

function Remove-SigningPasswordPackage {
    if ([string]::IsNullOrWhiteSpace($SigningPasswordPath)) { return }
    try {
        $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $resolvedPath = [IO.Path]::GetFullPath($SigningPasswordPath)
        if ($resolvedPath.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedPath -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

$terminalState = "failed"
$terminalStage = "Khởi động"
$terminalMessage = "Controller dừng trước khi khởi chạy tiến trình con."
$terminalExitCode = 1

try {
    if ([string]::IsNullOrWhiteSpace($StateRoot)) {
        $StateRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "PrynX\release-runs"
    }
    $StateRoot = [IO.Path]::GetFullPath($StateRoot)
    New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

    # BUILD (audit 2026-08-14 §BR.14): probe regression dùng CommandPath phải có
    # mutex theo StateRoot riêng; nếu dùng mutex production, QA chạy bên trong build
    # sẽ tự chặn chính hai test controller. GUI không bao giờ truyền CommandPath.
    $mutexScope = if ([string]::IsNullOrWhiteSpace($CommandPath)) { $ROOT } else { $StateRoot }
    $mutexName = "Global\PrynX-BuildRelease-" + (
        [Convert]::ToBase64String(
            [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($mutexScope).ToLowerInvariant())
        ) -replace '[^A-Za-z0-9]', ''
    )
    $mutex = New-Object Threading.Mutex($false, $mutexName)
    try { $ownsMutex = $mutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) {
        $latestPath = Join-Path $StateRoot "latest.json"
        if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) {
            $blocked = [ordered]@{
                schema = 1
                runId = "blocked-" + [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
                mode = $Mode
                version = $Version
                state = "blocked"
                stage = "Khởi động"
                message = "Một lượt build/phát hành khác của repo này đang chạy."
                controllerPid = $PID
                childPid = $null
                startedAtUtc = $startedAtUtc.ToString("o")
                updatedAtUtc = [DateTime]::UtcNow.ToString("o")
                durationSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
                exitCode = 1
                logPath = $null
            }
            Write-JsonAtomic -Path $latestPath -Value $blocked
        }
        $terminalMessage = "Một lượt build/phát hành khác của repo này đang chạy."
        throw $terminalMessage
    }

    # BUILD (audit 2026-08-13 §BR.03/10/12): controller là chủ duy nhất của run ID,
    # mutex, log/status và exit code; script build cũ chạy ở process con độc lập.
    $runId = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    $runDirectory = Join-Path $StateRoot $runId
    New-Item -ItemType Directory -Path $runDirectory -ErrorAction Stop | Out-Null
    $statusPath = Join-Path $runDirectory "status.json"
    $logPath = Join-Path $runDirectory "build.log"
    Write-RunStatus -State "starting" -Stage "Khởi động" -Message "Đang chuẩn bị tiến trình build nền."

    if ([string]::IsNullOrWhiteSpace($CommandPath)) {
        if ($Mode -eq "internal") {
            $CommandPath = Join-Path $ROOT "build_production.ps1"
        }
        else {
            if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
                throw "Phiên bản phát hành không phải SemVer hợp lệ."
            }
            $CommandPath = Join-Path $ROOT "release_update.ps1"
        }
    }
    $CommandPath = [IO.Path]::GetFullPath($CommandPath)
    if (-not (Test-Path -LiteralPath $CommandPath -PathType Leaf)) {
        throw "Không tìm thấy script cần chạy: $CommandPath"
    }

    $signingPassword = Read-SigningPassword
    if (-not [string]::IsNullOrEmpty($signingPassword)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $signingPassword
    }
    $invokeParameters = [ordered]@{}
    if ($Mode -eq "publish") {
        $invokeParameters.Version = $Version
        $invokeParameters.Notes = if ([string]::IsNullOrWhiteSpace($NotesBase64)) {
            ""
        } else {
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($NotesBase64))
        }
    }
    $invokeParametersBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes([string]($invokeParameters | ConvertTo-Json -Compress))
    )
    $commandPathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($CommandPath))
    $encodedCommand = @"
`$ErrorActionPreference = "Stop"
`$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
`$commandPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$commandPathBase64'))
`$invokeParametersJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$invokeParametersBase64'))
`$invokeParametersObject = `$invokeParametersJson | ConvertFrom-Json
`$invokeParameters = @{}
`$invokeParametersObject.PSObject.Properties | ForEach-Object {
    `$invokeParameters[[string]`$_.Name] = `$_.Value
}
`$global:LASTEXITCODE = 0
& `$commandPath @invokeParameters
exit `$global:LASTEXITCODE
"@
    $childArgs = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($encodedCommand))
    )
    try {
        $env:PYTHONIOENCODING = "utf-8"
        $env:DOTNET_CLI_UI_LANGUAGE = "en-US"
        $childProcess = Start-PowerShellChild -Arguments $childArgs
    }
    finally {
        Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue
        Remove-Item Env:DOTNET_CLI_UI_LANGUAGE -ErrorAction SilentlyContinue
    }

    $stdoutTask = $childProcess.StandardOutput.ReadLineAsync()
    $stderrTask = $childProcess.StandardError.ReadLineAsync()
    $stdoutEnded = $false
    $stderrEnded = $false
    $logWriter = New-Object IO.StreamWriter($logPath, $false, [Text.UTF8Encoding]::new($false))
    $logWriter.AutoFlush = $true
    $statusInterval = [Diagnostics.Stopwatch]::StartNew()
    Write-RunStatus -State "running" -Stage "Khởi động" `
        -Message "Build đang chạy nền; có thể đóng cửa sổ quản lý." -ChildPid $childProcess.Id
    try {
        while (-not $childProcess.HasExited -or -not $stdoutEnded -or -not $stderrEnded) {
            while (-not $stdoutEnded -and $stdoutTask.IsCompleted) {
                $line = $stdoutTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $stdoutEnded = $true
                }
                else {
                    $logWriter.WriteLine($line)
                    $stdoutTask = $childProcess.StandardOutput.ReadLineAsync()
                }
            }
            while (-not $stderrEnded -and $stderrTask.IsCompleted) {
                $line = $stderrTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $stderrEnded = $true
                }
                else {
                    $logWriter.WriteLine("[STDERR] $line")
                    $stderrTask = $childProcess.StandardError.ReadLineAsync()
                }
            }
            if ($statusInterval.ElapsedMilliseconds -ge 1000) {
                $stage = Get-StageFromLog -Path $logPath
                Write-RunStatus -State "running" -Stage $stage `
                    -Message "Build đang chạy nền." -ChildPid $childProcess.Id
                $statusInterval.Restart()
            }
            Start-Sleep -Milliseconds 100
        }
    }
    finally {
        $logWriter.Dispose()
        $logWriter = $null
    }
    $childProcess.WaitForExit()

    $exitCodeValue = $childProcess.ExitCode
    if ($null -eq $exitCodeValue) {
        throw "Không đọc được mã thoát của tiến trình build; từ chối báo thành công mơ hồ."
    }
    $terminalExitCode = [int]$exitCodeValue
    $terminalStage = Get-StageFromLog -Path $logPath
    if ($terminalExitCode -eq 0) {
        $terminalState = "succeeded"
        $terminalMessage = if ($Mode -eq "publish") { "Phát hành đã hoàn tất." } else { "Build nội bộ đã hoàn tất." }
    }
    else {
        $terminalState = "failed"
        $terminalMessage = "Tiến trình build dừng với mã lỗi $terminalExitCode. Mở log để xem chi tiết."
    }
}
catch {
    $terminalState = "failed"
    $terminalMessage = $_.Exception.Message
    $terminalExitCode = if ($terminalExitCode -eq 0) { 1 } else { $terminalExitCode }
    if ($logPath) {
        if ($logWriter) {
            $logWriter.WriteLine("[CONTROLLER ERROR] " + $terminalMessage)
        }
        else {
            Add-Content -LiteralPath $logPath -Value ("[CONTROLLER ERROR] " + $terminalMessage) -Encoding UTF8
        }
    }
}
finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue
    Remove-Item Env:DOTNET_CLI_UI_LANGUAGE -ErrorAction SilentlyContinue
    if ($logWriter) { $logWriter.Dispose(); $logWriter = $null }
    Remove-SigningPasswordPackage
    if ($statusPath) {
        $terminalChildPid = $null
        if ($childProcess -and (Test-ProcessAlive $childProcess.Id)) {
            $terminalChildPid = $childProcess.Id
        }
        Write-RunStatus -State $terminalState -Stage $terminalStage -Message $terminalMessage `
            -ExitCode $terminalExitCode -ChildPid $terminalChildPid
    }
    if ($childProcess) {
        $childProcess.Dispose()
    }
    $signingPassword = $null
    if ($ownsMutex -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}

exit $terminalExitCode
