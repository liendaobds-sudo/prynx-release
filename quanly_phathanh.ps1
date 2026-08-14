#requires -version 5
# PrynX - Cua so quan ly phat hanh (WinForms). Luu UTF-8 BOM de hien tieng Viet dung.
param([switch]$ShowBuildTerminal)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$CONFIG = Join-Path $ROOT "publisher.config.json"
$KEY_FILE = "$env:USERPROFILE\.tauri\prynx.key"
$SECRET_STORE_SCRIPT = Join-Path $ROOT "scripts\release_secret_store.ps1"
$SECRET_SETUP_SCRIPT = Join-Path $ROOT "scripts\setup_release_secrets.ps1"
$RELEASE_CONTROLLER = Join-Path $ROOT "scripts\release_controller.ps1"
$RELEASE_LOG_TERMINAL = Join-Path $ROOT "scripts\watch_release_run.ps1"
$RELEASE_STATE_ROOT = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "PrynX\release-runs"
. $SECRET_STORE_SCRIPT

# ---- Đọc cấu hình phát hành; GUI không sửa file tracked khi bấm build/publish ----
$cfg = @{ Repo = "" }
if (Test-Path $CONFIG) {
    try { $j = Get-Content $CONFIG -Raw | ConvertFrom-Json; if ($j.Repo) { $cfg.Repo = $j.Repo } } catch {}
}

# ---- NGUON CHAN LY DUY NHAT: suy repo phat hanh tu endpoint updater trong tauri.conf.json ----
# Khong cho go tay (tranh phat hanh nham repo -> client khong nhan update).
function Get-EndpointRepo {
    $confPath = Join-Path $ROOT "desktop\src-tauri\tauri.conf.json"
    if (-not (Test-Path $confPath)) { return "" }
    try {
        $conf = Get-Content $confPath -Raw | ConvertFrom-Json
        $ep = [string]$conf.plugins.updater.endpoints[0]
        if ($ep -match 'github\.com/([^/]+/[^/]+)/releases') { return $Matches[1] }
    } catch {}
    return ""
}
$DerivedRepo = Get-EndpointRepo

function Get-SourceVersion {
    $confPath = Join-Path $ROOT "desktop\src-tauri\tauri.conf.json"
    if (-not (Test-Path -LiteralPath $confPath -PathType Leaf)) { return "" }
    try {
        $version = [string](Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json).version
        if ($version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
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
# Suy tu endpoint updater -> chi doc (single source of truth). Fallback config cu neu khong doc duoc.
if ($DerivedRepo) { $txtRepo.Text = $DerivedRepo; $txtRepo.ReadOnly = $true }
else { $txtRepo.Text = $cfg.Repo }

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

# ---- Lua chon tai dung QA PDF cho PHAT HANH ----
$chkReuseNoGs = New-Object System.Windows.Forms.CheckBox
$chkReuseNoGs.Text = "Dùng lại kiểm tra PDF 18×16 đã đạt (chỉ khi dấu vân tay còn khớp)"
$chkReuseNoGs.Location = New-Object System.Drawing.Point(15, 310)
$chkReuseNoGs.Width = 595
$chkReuseNoGs.Checked = $false
$form.Controls.Add($chkReuseNoGs)

# ---- Trạng thái build nền ----
$lblRunState = New-Label "Trạng thái: Sẵn sàng" 15 340 410
$lblRunState.ForeColor = [System.Drawing.Color]::FromArgb(55, 65, 81)

$btnOpenLog = New-Object System.Windows.Forms.Button
$btnOpenLog.Text = "Mở log"
$btnOpenLog.Location = New-Object System.Drawing.Point(455, 334); $btnOpenLog.Width = 155
$btnOpenLog.Enabled = $false
$form.Controls.Add($btnOpenLog)

# ---- Log ----
$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(15, 372); $txtLog.Width = 595; $txtLog.Height = 236
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
    $chkReuseNoGs.Enabled = $enabled
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

    # Windows PowerShell 5 Start-Process lỗi nếu môi trường có đồng thời Path/PATH.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = "powershell.exe"
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
    $startInfo.FileName = "powershell.exe"
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
        [switch]$ReusePassedNoGs,
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
            if ($ReusePassedNoGs) { $args += "-ReusePassedNoGs" }
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

# ---- Kiem tra ban dau ----
if (-not (Test-Path $KEY_FILE)) { Log "[CANH BAO] Khong thay khoa ky: $KEY_FILE" } else { Log "[OK] Co khoa ky updater." }
if (Test-Path -LiteralPath (Resolve-PrynXReleaseSecretStorePath)) {
    Log "[OK] Co kho khoa Supabase ma hoa DPAPI."
} else {
    Log "[CANH BAO] Chua cau hinh Supabase sb_secret_ cho may build."
}
Log "Phiên bản được đọc từ mã nguồn. Hãy đồng bộ và commit trước khi PHÁT HÀNH."

# ---- Su kien ----
$btnSecrets.Add_Click({
    Start-Process powershell -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", ('"' + $SECRET_SETUP_SCRIPT + '"')
    )
    Log "Da mo cua so cau hinh khoa. Sau khi nhap xong co the build lai ngay."
})

$btnCheck.Add_Click({
    Log "Dang kiem tra GitHub CLI..."
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { Log "[LOI] Chua co GitHub CLI. Cai: winget install GitHub.cli"; return }
    Log ("gh: " + ((& gh --version 2>&1 | Select-Object -First 1) -join ""))
    $st = (& gh auth status 2>&1 | Out-String)
    Log $st.Trim()
})

$btnLogin.Add_Click({
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { Log "[LOI] Chua co GitHub CLI. Cai: winget install GitHub.cli"; return }
    Log "Mo cua so dang nhap GitHub (lam theo huong dan trong cua so do)..."
    Start-Process cmd -ArgumentList "/k", "gh auth login"
})

$btnList.Add_Click({
    if (-not $txtRepo.Text) { Log "[!] Nhap repo truoc."; return }
    Log ("Cac ban da phat hanh tren " + $txtRepo.Text + ":")
    $out = (& gh release list --repo $txtRepo.Text 2>&1 | Out-String)
    if ([string]::IsNullOrWhiteSpace($out)) { Log "(chua co ban nao / hoac chua dang nhap)" } else { Log $out.Trim() }
})

$btnOpenLog.Add_Click({
    if (-not [string]::IsNullOrWhiteSpace($script:LastRunLogPath) -and
        (Test-Path -LiteralPath $script:LastRunLogPath -PathType Leaf)) {
        Start-Process notepad.exe -ArgumentList ('"' + $script:LastRunLogPath + '"')
    }
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
    if (-not $txtRepo.Text) { [System.Windows.Forms.MessageBox]::Show("Nhap repo phat hanh truoc.", "Thieu thong tin"); return }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Phát hành phiên bản đã commit " + $version + " lên " + $txtRepo.Text + " ?`r`nHệ thống sẽ kiểm tra GitHub trước khi build. Một lượt đầy đủ gần đây mất khoảng 60-110 phút.",
        "Xác nhận phát hành", [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($ok -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    if (-not (Test-ReleaseSecretStoreReady)) { return }
    [void](Start-ReleaseController -Mode publish -Version $version -Notes $txtNotes.Text `
        -ReusePassedNoGs:$chkReuseNoGs.Checked -SigningPassword $txtPwd.Text)
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
[void]$form.ShowDialog()
