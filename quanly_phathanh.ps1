#requires -version 5
# PrynX - Cua so quan ly phat hanh (WinForms). Luu UTF-8 BOM de hien tieng Viet dung.
param([switch]$ShowBuildTerminal)

$ErrorActionPreference = "Stop"

# SEC (audit 2026-09-04 §SEC.24-R6): launcher GUI phải xóa và từ chối
# secret/routing/transport override trước cả Add-Type lẫn dot-source. Windows PowerShell
# 5.1 có thể sinh compiler child khi guard nạp type native; không để child sớm
# kế thừa token hoặc authority do process cha cài vào.
function Get-PrynXGuiForbiddenEnvironmentVariableNames {
    $environment = [Environment]::GetEnvironmentVariables(
        [EnvironmentVariableTarget]::Process
    )
    $names = New-Object System.Collections.Generic.HashSet[string] `
        ([System.StringComparer]::OrdinalIgnoreCase)
    $secretNames = @(
        "PRYNX_SUPABASE_SECRET_KEY",
        "PRYNX_SUPABASE_SERVICE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY",
        "PRYNX_TAURI_SIGNING_KEY_FILE",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
    )
    foreach ($key in @($environment.Keys)) {
        $name = [string]$key
        if ($name -match '^(?i:GIT_|GH_)' -or $name -iin @(
                "GITHUB_TOKEN",
                "GITHUB_ENTERPRISE_TOKEN",
                "XDG_CONFIG_HOME",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
                "CURL_CA_BUNDLE",
                "REQUESTS_CA_BUNDLE",
                "BROWSER"
            ) -or $name -iin $secretNames) {
            $null = $names.Add($name)
        }
    }
    return @($names | Sort-Object)
}

function Clear-PrynXGuiForbiddenEnvironmentVariables {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($name in $Names) {
        # Env provider xóa hẳn key cả trên Windows PowerShell 5.1 lẫn pwsh;
        # SetEnvironmentVariable(..., $null) có runtime chỉ để lại chuỗi rỗng.
        Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
    }
}

function Assert-PrynXGuiChildEnvironmentClean {
    $unexpected = @(Get-PrynXGuiForbiddenEnvironmentVariableNames)
    if ($unexpected.Count -gt 0) {
        Clear-PrynXGuiForbiddenEnvironmentVariables -Names $unexpected
        throw "SEC: PrynX da xoa va tu choi secret/Git/GitHub environment/transport override: $($unexpected -join ', ')."
    }
}

Assert-PrynXGuiChildEnvironmentClean

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SECRET_STORE_SCRIPT = Join-Path $ROOT "scripts\release_secret_store.ps1"
$SECRET_SETUP_SCRIPT = Join-Path $ROOT "scripts\setup_release_secrets.ps1"
$RELEASE_CONTROLLER = Join-Path $ROOT "scripts\release_controller.ps1"
$RELEASE_LOG_TERMINAL = Join-Path $ROOT "scripts\watch_release_run.ps1"
$EXECUTABLE_GUARD = Join-Path $ROOT "scripts\release_executable_guard.ps1"
$RELEASE_STATE_ROOT = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "PrynX\release-runs"
. $SECRET_STORE_SCRIPT
. $EXECUTABLE_GUARD

$KEY_FILE = Resolve-PrynXUpdaterSigningKeyPath

$script:PrynXGuiPowerShellLease = $null
$script:PrynXGuiCmdLease = $null
$script:PrynXGuiGitHubCliLease = $null
$script:PrynXGuiNotepadLease = $null

function Get-PrynXGuiExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("WindowsPowerShell", "Cmd", "GitHubCli", "Notepad")]
        [string]$Kind
    )

    $lease = switch ($Kind) {
        "WindowsPowerShell" { $script:PrynXGuiPowerShellLease }
        "Cmd" { $script:PrynXGuiCmdLease }
        "GitHubCli" { $script:PrynXGuiGitHubCliLease }
        "Notepad" { $script:PrynXGuiNotepadLease }
    }
    if ($null -eq $lease) {
        $lease = Open-PrynXTrustedReleaseExecutableLease -Kind $Kind
        switch ($Kind) {
            "WindowsPowerShell" { $script:PrynXGuiPowerShellLease = $lease }
            "Cmd" { $script:PrynXGuiCmdLease = $lease }
            "GitHubCli" { $script:PrynXGuiGitHubCliLease = $lease }
            "Notepad" { $script:PrynXGuiNotepadLease = $lease }
        }
    }
    return $lease.Path
}

# ---- NGUON CHAN LY DUY NHAT: suy repo phat hanh tu endpoint updater trong tauri.conf.json ----
# Khong cho go tay (tranh phat hanh nham repo -> client khong nhan update).
function Get-EndpointRepo {
    $confPath = Join-Path $ROOT "desktop\src-tauri\tauri.conf.json"
    $configFull = Assert-PrynXNoReparsePointInPathComponents -Path $confPath
    if (-not (Test-Path -LiteralPath $configFull -PathType Leaf)) {
        throw "Khong thay tauri.conf.json: $confPath"
    }

    $conf = Get-Content -LiteralPath $configFull -Raw | ConvertFrom-Json -ErrorAction Stop
    $endpoints = @($conf.plugins.updater.endpoints)
    if ($endpoints.Count -ne 1) {
        throw "tauri.conf.json phai co dung mot plugins.updater.endpoints."
    }
    # Không Trim: khoảng trắng/delimiter dư phải bị coi là config không canonical.
    $endpoint = [string]$endpoints[0]
    $endpointSyntaxMatch = [regex]::Match(
        $endpoint,
        '^(?i:https://github\.com)/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases/latest/download/latest\.json\z',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (-not $endpointSyntaxMatch.Success) {
        throw "Endpoint updater khong dung canonical GitHub release URI: $endpoint"
    }

    $uri = $null
    if ([string]::IsNullOrWhiteSpace($endpoint) -or
        -not [System.Uri]::TryCreate($endpoint, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "Endpoint updater khong phai absolute URI hop le: $endpoint"
    }
    if (-not [string]::Equals(
            $uri.Scheme,
            "https",
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            $uri.DnsSafeHost,
            "github.com",
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not $uri.IsDefaultPort -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "Endpoint updater phai dung HTTPS tren github.com va khong co authority/query/fragment phu: $endpoint"
    }

    $owner = $endpointSyntaxMatch.Groups[1].Value
    $repo = $endpointSyntaxMatch.Groups[2].Value
    if ($owner -in @(".", "..") -or $repo -in @(".", "..")) {
        throw "Endpoint updater co owner/repo khong hop le: $endpoint"
    }
    return $owner + "/" + $repo
}
try {
    $DerivedRepo = Get-EndpointRepo
}
catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Không xác minh được repo phát hành từ tauri.conf.json.`r`n$($_.Exception.Message)",
        "Cấu hình phát hành không hợp lệ"
    ) | Out-Null
    throw
}
$script:PrynXGuiReleaseRepo = $DerivedRepo

function Get-SourceVersion {
    $confPath = Join-Path $ROOT "desktop\src-tauri\tauri.conf.json"
    if (-not (Test-Path -LiteralPath $confPath -PathType Leaf)) { return "" }
    try {
        $version = [string](Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json).version
        if ($version -match '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\z') {
            return $version
        }
    } catch {}
    return ""
}
$SourceVersion = Get-SourceVersion

# ---- Form ----
$form = New-Object System.Windows.Forms.Form
$form.Text = "PrynX — Quản lý phát hành"
$form.Size = New-Object System.Drawing.Size(640, 700)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

function New-Label($text, $x, $y, $w) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.AutoSize = $true
    if ($w) { $l.AutoSize = $false; $l.Width = $w }
    $form.Controls.Add($l); return $l
}
function New-Box($x, $y, $w, $pwd) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y); $t.Width = $w
    if ($pwd) { $t.UseSystemPasswordChar = $true }
    $form.Controls.Add($t); return $t
}

# UIUX (audit 2026-08-13 §BR.11): phiên bản public phải được chuẩn bị, đồng bộ và
# commit trong source trước. Ô này chỉ hiển thị nguồn thật, không còn giả làm thao tác bump version.
New-Label "Phiên bản đã chuẩn bị trong mã nguồn:" 15 18 | Out-Null
$txtVer = New-Box 300 15 120; $txtVer.Text = $SourceVersion; $txtVer.ReadOnly = $true

New-Label "Repo phát hành (TỰ ĐỘNG từ tauri.conf.json):" 15 50 | Out-Null
$txtRepo = New-Box 320 47 290
# Endpoint updater canonical là nguồn duy nhất; không fallback sang text/config có thể đổi repo.
$txtRepo.Text = $script:PrynXGuiReleaseRepo
$txtRepo.ReadOnly = $true

New-Label "Mật khẩu khóa ký (bỏ trống nếu không đặt):" 15 82 | Out-Null
$txtPwd = New-Box 300 79 200 $true

New-Label "Ghi chú bản cập nhật (tùy chọn):" 15 114 | Out-Null
$txtNotes = New-Object System.Windows.Forms.TextBox
$txtNotes.Location = New-Object System.Drawing.Point(15, 136); $txtNotes.Width = 595; $txtNotes.Height = 50
$txtNotes.Multiline = $true; $form.Controls.Add($txtNotes)

# ---- Hang nut quan ly ----
$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = "Kiểm tra GitHub"; $btnCheck.Location = New-Object System.Drawing.Point(165, 226); $btnCheck.Width = 140
$form.Controls.Add($btnCheck)

$btnLogin = New-Object System.Windows.Forms.Button
$btnLogin.Text = "Đăng nhập GitHub"; $btnLogin.Location = New-Object System.Drawing.Point(315, 226); $btnLogin.Width = 130
$form.Controls.Add($btnLogin)

$btnList = New-Object System.Windows.Forms.Button
$btnList.Text = "Xem bản đã phát hành"; $btnList.Location = New-Object System.Drawing.Point(455, 226); $btnList.Width = 155
$form.Controls.Add($btnList)

$btnSecrets = New-Object System.Windows.Forms.Button
$btnSecrets.Text = "Cấu hình khóa"; $btnSecrets.Location = New-Object System.Drawing.Point(15, 226); $btnSecrets.Width = 140
$form.Controls.Add($btnSecrets)

# ---- Nut build NOI BO (khong upload) ----
$btnLocal = New-Object System.Windows.Forms.Button
$btnLocal.Text = "Build NỘI BỘ  (test trước, không upload)"
$btnLocal.Location = New-Object System.Drawing.Point(15, 264); $btnLocal.Width = 290; $btnLocal.Height = 42
$btnLocal.BackColor = [System.Drawing.Color]::FromArgb(39, 39, 42); $btnLocal.ForeColor = [System.Drawing.Color]::White
$btnLocal.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnLocal)

# ---- Nut phat hanh chinh ----
$btnPublish = New-Object System.Windows.Forms.Button
$btnPublish.Text = "PHÁT HÀNH  (build + ký + lên GitHub)"
$btnPublish.Location = New-Object System.Drawing.Point(320, 264); $btnPublish.Width = 290; $btnPublish.Height = 42
$btnPublish.BackColor = [System.Drawing.Color]::FromArgb(79, 70, 229); $btnPublish.ForeColor = [System.Drawing.Color]::White
$btnPublish.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnPublish)

# ---- Trạng thái build nền ----
# UIUX (audit 2026-08-21 §NGS.2): lấp khoảng trống của checkbox corpus đã bỏ.
$lblRunState = New-Label "Trạng thái: Sẵn sàng" 15 316 410
$lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(55, 65, 81)

$btnOpenLog = New-Object System.Windows.Forms.Button
$btnOpenLog.Text = "Mở log"
$btnOpenLog.Location = New-Object System.Drawing.Point(455, 310); $btnOpenLog.Width = 155
$btnOpenLog.Enabled = $false
$form.Controls.Add($btnOpenLog)

# ---- Log ----
$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(15, 348); $txtLog.Width = 595; $txtLog.Height = 260
$txtLog.Multiline = $true; $txtLog.ScrollBars = "Vertical"; $txtLog.ReadOnly = $true
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27); $txtLog.ForeColor = [System.Drawing.Color]::White
$txtLog.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($txtLog)

function Log($msg) { $txtLog.AppendText((Get-Date -Format "HH:mm:ss") + "  " + $msg + "`r`n") }

$script:LastRunId = ""
$script:LastRunState = ""
$script:LastRunLogPath = ""

function Get-ReleaseRunStatus {
    $latestPath = Join-Path $RELEASE_STATE_ROOT "latest.json"
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return $null }
    try {
        $stream = New-Object IO.FileStream(
            $latestPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        )
        try {
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
            try { return $reader.ReadToEnd() | ConvertFrom-Json }
            finally { $reader.Dispose() }
        }
        finally { $stream.Dispose() }
    }
    catch { return $null }
}

function Test-ProcessAlive($processId) {
    if ($null -eq $processId -or [int]$processId -le 0) { return $false }
    return $null -ne (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue)
}

function Set-BuildControlsEnabled([bool]$enabled) {
    $btnLocal.Enabled = $enabled
    $btnPublish.Enabled = $enabled
}

function Refresh-ReleaseRunStatus {
    $status = Get-ReleaseRunStatus
    if ($null -eq $status) {
        $lblRunState.Text = "Trạng thái: Sẵn sàng"
        Set-BuildControlsEnabled $true
        return
    }

    $script:LastRunLogPath = [string]$status.logPath
    $btnOpenLog.Enabled = -not [string]::IsNullOrWhiteSpace($script:LastRunLogPath) -and
        (Test-Path -LiteralPath $script:LastRunLogPath -PathType Leaf)
    $isControllerAlive = Test-ProcessAlive $status.controllerPid
    $isRunning = [string]$status.state -in @("starting", "running") -and $isControllerAlive
    Set-BuildControlsEnabled (-not $isRunning)

    if ($isRunning) {
        $elapsed = [TimeSpan]::FromSeconds([double]$status.durationSeconds)
        $lblRunState.Text = "Đang chạy: $($status.stage) — $($elapsed.ToString('hh\:mm\:ss'))"
        $lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(180, 83, 9)
    }
    elseif ([string]$status.state -eq "succeeded") {
        $lblRunState.Text = "Hoàn tất: $($status.message)"
        $lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(21, 128, 61)
    }
    elseif ([string]$status.state -in @("failed", "blocked")) {
        $lblRunState.Text = "Thất bại: $($status.message)"
        $lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    }
    else {
        $lblRunState.Text = "Đã gián đoạn: controller không còn chạy. Mở log để kiểm tra."
        $lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
    }

    if ($script:LastRunId -ne [string]$status.runId -or
        $script:LastRunState -ne [string]$status.state) {
        $script:LastRunId = [string]$status.runId
        $script:LastRunState = [string]$status.state
        Log ("[BUILD] " + $lblRunState.Text)
    }
}

function New-SigningPasswordPackage([string]$password) {
    if ([string]::IsNullOrEmpty($password)) { return "" }
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($password)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $path = Join-Path ([IO.Path]::GetTempPath()) ("PrynXSigning-" + [guid]::NewGuid().ToString("N") + ".dpapi")
        [IO.File]::WriteAllText($path, [Convert]::ToBase64String($protected), [Text.Encoding]::ASCII)
        return $path
    }
    finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}

function Start-HiddenPowerShell {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    function Quote-ProcessArgument([string]$value) {
        if ($null -eq $value) { return '""' }
        if ($value -notmatch '[\s"]') { return $value }
        return '"' + ([regex]::Replace($value, '(\\*)"', '$1$1\"')) + '"'
    }

    Assert-PrynXGuiChildEnvironmentClean
    # Windows PowerShell 5 Start-Process lỗi nếu môi trường có đồng thời Path/PATH.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Get-PrynXGuiExecutablePath -Kind "WindowsPowerShell"
    $startInfo.Arguments = (@($Arguments | ForEach-Object {
        Quote-ProcessArgument ([string]$_)
    }) -join ' ')
    $startInfo.WorkingDirectory = $ROOT
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($startInfo)
}

function Start-ReleaseLogTerminal {
    param([Parameter(Mandatory = $true)][int]$ControllerPid)

    if (-not (Test-Path -LiteralPath $RELEASE_LOG_TERMINAL -PathType Leaf)) {
        throw "Thiếu trình theo dõi terminal: $RELEASE_LOG_TERMINAL"
    }
    Assert-PrynXGuiChildEnvironmentClean

    function Quote-ProcessArgument([string]$value) {
        if ($null -eq $value) { return '""' }
        if ($value -notmatch '[\s"]') { return $value }
        return '"' + ([regex]::Replace($value, '(\\*)"', '$1$1\"')) + '"'
    }

    $arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RELEASE_LOG_TERMINAL,
        "-StateRoot", $RELEASE_STATE_ROOT, "-ControllerPid", [string]$ControllerPid
    )
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Get-PrynXGuiExecutablePath -Kind "WindowsPowerShell"
    $startInfo.Arguments = (@($arguments | ForEach-Object {
        Quote-ProcessArgument ([string]$_)
    }) -join ' ')
    $startInfo.WorkingDirectory = $ROOT
    # UIUX (audit 2026-08-14 §BR.13): terminal chỉ theo dõi log; đóng nó không giết controller/build.
    $startInfo.UseShellExecute = $true
    $startInfo.CreateNoWindow = $false
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    return [Diagnostics.Process]::Start($startInfo)
}

function Start-ReleaseController {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("internal", "publish")][string]$Mode,
        [string]$Version = "",
        [string]$Notes = "",
        [string]$SigningPassword = ""
    )

    Refresh-ReleaseRunStatus
    if (-not $btnLocal.Enabled) {
        [System.Windows.Forms.MessageBox]::Show(
            "Một lượt build/phát hành đang chạy. Hãy đợi hoàn tất hoặc mở log để theo dõi.",
            "Build đang chạy") | Out-Null
        return $false
    }
    if (-not (Test-Path -LiteralPath $RELEASE_CONTROLLER -PathType Leaf)) {
        [System.Windows.Forms.MessageBox]::Show("Thiếu release controller: $RELEASE_CONTROLLER", "Không thể build") | Out-Null
        return $false
    }

    $passwordPackage = ""
    try {
        $args = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RELEASE_CONTROLLER,
            "-Mode", $Mode, "-StateRoot", $RELEASE_STATE_ROOT
        )
        if ($Mode -eq "publish") {
            $notesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Notes))
            $args += @("-Version", $Version, "-NotesBase64", $notesBase64)
            $passwordPackage = New-SigningPasswordPackage $SigningPassword
            if (-not [string]::IsNullOrWhiteSpace($passwordPackage)) {
                $args += @("-SigningPasswordPath", $passwordPackage)
            }
        }
        # UIUX (audit 2026-08-13 §BR.03/10/12): controller ẩn sống độc lập với GUI,
        # giữ mutex, log/status và mã thoát; đóng form không giết build.
        $controllerProcess = Start-HiddenPowerShell -Arguments $args
        if ($null -eq $controllerProcess) { throw "Không khởi động được release controller." }
        if ($ShowBuildTerminal) {
            try {
                $terminalProcess = Start-ReleaseLogTerminal -ControllerPid $controllerProcess.Id
                if ($null -eq $terminalProcess) { throw "Không khởi động được terminal theo dõi." }
            }
            catch {
                Log ("[CẢNH BÁO] Build vẫn chạy nhưng không mở được terminal: " + $_.Exception.Message)
            }
        }
        Set-BuildControlsEnabled $false
        $lblRunState.Text = "Đang khởi động controller..."
        if ($ShowBuildTerminal) {
            Log "Đã khởi động build nền và mở terminal theo dõi riêng."
        }
        else {
            Log "Đã khởi động build nền. Có thể đóng cửa sổ này; mở lại vẫn xem được trạng thái."
        }
        return $true
    }
    catch {
        if ($passwordPackage -and (Test-Path -LiteralPath $passwordPackage)) {
            Remove-Item -LiteralPath $passwordPackage -Force -ErrorAction SilentlyContinue
        }
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Không thể khởi động build") | Out-Null
        return $false
    }
}

function Test-ReleaseSecretStoreReady {
    if (Test-Path -LiteralPath (Resolve-PrynXReleaseSecretStorePath) -PathType Leaf) { return $true }
    Log "[LOI] Chua co kho khoa phat hanh DPAPI."
    [System.Windows.Forms.MessageBox]::Show(
        "Chưa có khóa phát hành an toàn. Bấm 'Cấu hình khóa', nhập sb_secret_ mới rồi thử lại.",
        "Thiếu khóa phát hành") | Out-Null
    return $false
}

function Get-PrynXGuiGitHubConfigurationDirectory {
    $appData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::ApplicationData
    )
    if ([string]::IsNullOrWhiteSpace($appData) -or
        -not [System.IO.Path]::IsPathRooted($appData)) {
        throw "Windows không trả về ApplicationData hợp lệ cho GitHub CLI."
    }
    $appDataFull = Assert-PrynXNoReparsePointInPathComponents -Path $appData
    $configDirectory = Assert-PrynXNoReparsePointInPathComponents -Path (
        Join-Path $appDataFull "GitHub CLI"
    )
    if (Test-Path -LiteralPath $configDirectory) {
        if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
            throw "Đường dẫn cấu hình GitHub CLI không phải thư mục: $configDirectory"
        }
    }
    else {
        $null = [System.IO.Directory]::CreateDirectory($configDirectory)
    }
    $configDirectory = Assert-PrynXNoReparsePointInPathComponents -Path $configDirectory

    # Login là đường duy nhất được phép khởi tạo config sạch. Wrapper release
    # sau đó lease cả hai file và không chấp nhận file thiếu/reparse/hardlink.
    foreach ($fileName in @("config.yml", "hosts.yml")) {
        $filePath = Join-Path $configDirectory $fileName
        if (-not (Test-Path -LiteralPath $filePath)) {
            $stream = $null
            try {
                $stream = [System.IO.File]::Open(
                    $filePath,
                    [System.IO.FileMode]::CreateNew,
                    [System.IO.FileAccess]::Write,
                    [System.IO.FileShare]::None
                )
            }
            finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        }
    }
    return $configDirectory
}

function Start-PrynXGitHubLogin {
    param(
        [Parameter(Mandatory = $true)][string]$GitHubCliPath,
        [Parameter(Mandatory = $true)][string]$CmdPath
    )

    Assert-PrynXGuiChildEnvironmentClean
    Assert-PrynXGitEnvironmentAuthority
    Assert-PrynXGitHubTransportEnvironmentAuthority
    $configDirectory = Get-PrynXGuiGitHubConfigurationDirectory

    # Wrapper kiểm effective config và từ chối http_unix_socket trước khi mở
    # phiên đăng nhập tương tác. Exit code auth status không phải lỗi ở đây vì
    # nút này được dùng chính khi máy chưa có credential.
    $null = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $GitHubCliPath `
        -Command "auth" `
        -Arguments @("status", "--hostname", "github.com")

    $controlledNames = @(
        "GH_CONFIG_DIR",
        "GH_PROMPT_DISABLED",
        "GH_NO_UPDATE_NOTIFIER",
        "GH_NO_EXTENSION_UPDATE_NOTIFIER",
        "GH_FORCE_TTY",
        "GH_DEBUG",
        "DEBUG"
    )
    $snapshot = @{}
    foreach ($name in $controlledNames) {
        $value = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        $snapshot[$name] = @{
            Exists = $null -ne $value
            Value = if ($null -ne $value) { [string]$value } else { $null }
        }
    }

    try {
        [Environment]::SetEnvironmentVariable(
            "GH_CONFIG_DIR",
            $configDirectory,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            "GH_PROMPT_DISABLED",
            "1",
            [EnvironmentVariableTarget]::Process
        )
        foreach ($name in @(
                "GH_NO_UPDATE_NOTIFIER",
                "GH_NO_EXTENSION_UPDATE_NOTIFIER"
            )) {
            [Environment]::SetEnvironmentVariable(
                $name,
                "1",
                [EnvironmentVariableTarget]::Process
            )
        }
        foreach ($name in @("GH_FORCE_TTY", "GH_DEBUG", "DEBUG")) {
            Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
        }

        # /d tắt Command Processor AutoRun. GH_PROMPT_DISABLED giữ device flow
        # phi tương tác: chỉ in URL/code, không mở browser, dò Git hay sinh khóa SSH.
        $loginCommand = '""' + $GitHubCliPath +
            '" auth login --hostname github.com --git-protocol https' +
            ' --web --skip-ssh-key"'
        return Start-Process `
            -FilePath $CmdPath `
            -ArgumentList @("/d", "/s", "/k", $loginCommand) `
            -PassThru
    }
    finally {
        foreach ($name in $controlledNames) {
            $value = if ($snapshot[$name].Exists) {
                [string]$snapshot[$name].Value
            }
            else {
                $null
            }
            if ($snapshot[$name].Exists) {
                [Environment]::SetEnvironmentVariable(
                    $name,
                    $value,
                    [EnvironmentVariableTarget]::Process
                )
            }
            else {
                Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
            }
        }
    }
}

# ---- Kiem tra ban dau ----
if (-not (Test-Path -LiteralPath $KEY_FILE -PathType Leaf)) {
    Log "[CANH BAO] Khong thay tep khoa ky: $KEY_FILE"
} else {
    Log "[OK] Co tep khoa ky updater; build se xac minh identity va quyen truy cap."
}
if (Test-Path -LiteralPath (Resolve-PrynXReleaseSecretStorePath)) {
    Log "[OK] Co kho khoa Supabase ma hoa DPAPI."
} else {
    Log "[CANH BAO] Chua cau hinh Supabase sb_secret_ cho may build."
}
Log "Phiên bản được đọc từ mã nguồn. Hãy đồng bộ và commit trước khi PHÁT HÀNH."

# ---- Su kien ----
$btnSecrets.Add_Click({
    try {
        Assert-PrynXGuiChildEnvironmentClean
        $powerShellPath = Get-PrynXGuiExecutablePath -Kind "WindowsPowerShell"
        Start-Process -FilePath $powerShellPath -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", ('"' + $SECRET_SETUP_SCRIPT + '"')
        ) | Out-Null
        Log "Da mo cua so cau hinh khoa. Sau khi nhap xong co the build lai ngay."
    }
    catch { Log ("[LOI] " + $_.Exception.Message) }
})

$btnCheck.Add_Click({
    Log "Dang kiem tra GitHub CLI..."
    try {
        Assert-PrynXGuiChildEnvironmentClean
        $ghPath = Get-PrynXGuiExecutablePath -Kind "GitHubCli"
        $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ghPath)
        $version = if (-not [string]::IsNullOrWhiteSpace($versionInfo.ProductVersion)) {
            [string]$versionInfo.ProductVersion
        }
        else {
            [string]$versionInfo.FileVersion
        }
        Log ("gh: " + $version)
        $authResult = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $ghPath `
            -Command "auth" `
            -Arguments @("status", "--hostname", "github.com")
        $authText = (@($authResult.Output) | ForEach-Object { [string]$_ }) -join "`r`n"
        if ($authResult.ExitCode -ne 0) {
            Log ("[LOI] GitHub CLI chưa xác thực cho github.com. " + $authText.Trim())
        }
        elseif (-not [string]::IsNullOrWhiteSpace($authText)) {
            Log $authText.Trim()
        }
        else {
            Log "[OK] GitHub CLI đã xác thực cho github.com."
        }
    }
    catch { Log ("[LOI] " + $_.Exception.Message) }
})

$btnLogin.Add_Click({
    try {
        $ghPath = Get-PrynXGuiExecutablePath -Kind "GitHubCli"
        $cmdPath = Get-PrynXGuiExecutablePath -Kind "Cmd"
        Log "Mo cua so dang nhap GitHub (lam theo huong dan trong cua so do)..."
        $process = Start-PrynXGitHubLogin `
            -GitHubCliPath $ghPath `
            -CmdPath $cmdPath
        if ($null -eq $process) {
            throw "Không mở được tiến trình đăng nhập GitHub."
        }
    }
    catch { Log ("[LOI] " + $_.Exception.Message); return }
})

$btnList.Add_Click({
    try {
        Assert-PrynXGuiChildEnvironmentClean
        $ghPath = Get-PrynXGuiExecutablePath -Kind "GitHubCli"
        $repoAuthority = "github.com/$script:PrynXGuiReleaseRepo"
        Log ("Cac ban da phat hanh tren " + $script:PrynXGuiReleaseRepo + ":")
        $listResult = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $ghPath `
            -Command "release" `
            -Arguments @("list", "--repo", $repoAuthority)
        $listText = (@($listResult.Output) | ForEach-Object { [string]$_ }) -join "`r`n"
        if ($listResult.ExitCode -ne 0) {
            Log ("[LOI] Không đọc được danh sách release. " + $listText.Trim())
        }
        elseif ([string]::IsNullOrWhiteSpace($listText)) {
            Log "(chua co ban nao)"
        }
        else {
            Log $listText.Trim()
        }
    }
    catch { Log ("[LOI] " + $_.Exception.Message) }
})

$btnOpenLog.Add_Click({
    try {
        if (-not [string]::IsNullOrWhiteSpace($script:LastRunLogPath) -and
            (Test-Path -LiteralPath $script:LastRunLogPath -PathType Leaf)) {
            Assert-PrynXGuiChildEnvironmentClean
            $notepadPath = Get-PrynXGuiExecutablePath -Kind "Notepad"
            Start-Process `
                -FilePath $notepadPath `
                -ArgumentList ('"' + $script:LastRunLogPath + '"') | Out-Null
        }
    }
    catch { Log ("[LOI] " + $_.Exception.Message) }
})

$btnLocal.Add_Click({
    $version = Get-SourceVersion
    $txtVer.Text = $version
    if ([string]::IsNullOrWhiteSpace($version)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Không đọc được phiên bản hợp lệ từ tauri.conf.json. Hãy chuẩn bị mã nguồn rồi mở lại.",
            "Thiếu phiên bản")
        return
    }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Build NỘI BỘ v$version (kiểm thử, KHÔNG upload)?`r`nTạo file cài đặt trong Ban_Phat_Hanh\`r`nMột lượt đầy đủ gần đây mất khoảng 60-110 phút (chạy trong cửa sổ riêng).",
        "Xác nhận build nội bộ", [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($ok -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    if (-not (Test-ReleaseSecretStoreReady)) { return }
    # UIUX (audit 2026-08-13 §BR.11): build đúng version hiện có trong source;
    # không truyền -Version để build script sửa tracked files giữa phiên.
    # KHONG -Release: build installer local, khong ky updater, khong upload.
    # BUILD (audit 2026-08-04 BLD.04): installer noi bo luon bien dich sidecar
    # cung source voi frontend; khong con duong QA voi backend cu.
    [void](Start-ReleaseController -Mode internal -Version $version)
})

$btnPublish.Add_Click({
    $version = Get-SourceVersion
    $txtVer.Text = $version
    if ([string]::IsNullOrWhiteSpace($version)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Không đọc được phiên bản hợp lệ từ tauri.conf.json. Hãy chuẩn bị, đồng bộ và commit mã nguồn trước.",
            "Thiếu phiên bản")
        return
    }
    if ([string]::IsNullOrWhiteSpace($script:PrynXGuiReleaseRepo)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Không xác minh được repo phát hành canonical.",
            "Thiếu thông tin"
        ) | Out-Null
        return
    }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Phát hành phiên bản đã commit " + $version + " lên " + $script:PrynXGuiReleaseRepo + " ?`r`nHệ thống sẽ kiểm tra GitHub trước khi build. Một lượt đầy đủ gần đây mất khoảng 60-110 phút.",
        "Xác nhận phát hành", [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($ok -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    if (-not (Test-ReleaseSecretStoreReady)) { return }
    [void](Start-ReleaseController -Mode publish -Version $version -Notes $txtNotes.Text `
        -SigningPassword $txtPwd.Text)
    $txtPwd.Clear()
})

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 2000
$statusTimer.Add_Tick({ Refresh-ReleaseRunStatus })
$statusTimer.Start()
$form.Add_FormClosed({ $statusTimer.Stop(); $statusTimer.Dispose() })

# Ep form noi len foreground khi hien (neu khong, no co the bi cua so khac che
# -- console goi bang -WindowStyle Hidden nen form khong tu gianh foreground).
$form.Add_Shown({
    Refresh-ReleaseRunStatus
    $form.TopMost = $true
    $form.Activate()
    $form.BringToFront()
    $form.TopMost = $false
})
try {
    [void]$form.ShowDialog()
}
finally {
    Close-PrynXReleaseExecutableLease -Lease $script:PrynXGuiNotepadLease
    Close-PrynXReleaseExecutableLease -Lease $script:PrynXGuiGitHubCliLease
    Close-PrynXReleaseExecutableLease -Lease $script:PrynXGuiCmdLease
    Close-PrynXReleaseExecutableLease -Lease $script:PrynXGuiPowerShellLease
}
