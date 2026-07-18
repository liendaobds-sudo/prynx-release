#requires -version 5
# PrynX - Cua so quan ly phat hanh (WinForms). Luu UTF-8 BOM de hien tieng Viet dung.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$CONFIG = Join-Path $ROOT "publisher.config.json"
$KEY_FILE = "$env:USERPROFILE\.tauri\prynx.key"

# ---- Doc/ghi cau hinh (nho repo + version) ----
$cfg = @{ Repo = ""; Version = "1.0.1" }
if (Test-Path $CONFIG) {
    try { $j = Get-Content $CONFIG -Raw | ConvertFrom-Json; if ($j.Repo) { $cfg.Repo = $j.Repo }; if ($j.Version) { $cfg.Version = $j.Version } } catch {}
}
function Save-Config { @{ Repo = $txtRepo.Text; Version = $txtVer.Text } | ConvertTo-Json | Set-Content $CONFIG -Encoding utf8 }

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

# ---- Form ----
$form = New-Object System.Windows.Forms.Form
$form.Text = "PrynX — Quản lý phát hành"
$form.Size = New-Object System.Drawing.Size(640, 640)
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

New-Label "Phiên bản mới:" 15 18 | Out-Null
$txtVer = New-Box 150 15 120; $txtVer.Text = $cfg.Version

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

# ---- Tuy chon build nhanh ----
$chkSkipNuitka = New-Object System.Windows.Forms.CheckBox
$chkSkipNuitka.Text = "Build nhanh: bỏ qua biên dịch backend (chỉ khi KHÔNG sửa code Python)"
$chkSkipNuitka.Location = New-Object System.Drawing.Point(15, 192)
$chkSkipNuitka.Width = 595; $chkSkipNuitka.Checked = $false
$form.Controls.Add($chkSkipNuitka)

# ---- Hang nut quan ly ----
$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = "Kiểm tra GitHub"; $btnCheck.Location = New-Object System.Drawing.Point(15, 226); $btnCheck.Width = 150
$form.Controls.Add($btnCheck)

$btnLogin = New-Object System.Windows.Forms.Button
$btnLogin.Text = "Đăng nhập GitHub"; $btnLogin.Location = New-Object System.Drawing.Point(175, 226); $btnLogin.Width = 150
$form.Controls.Add($btnLogin)

$btnList = New-Object System.Windows.Forms.Button
$btnList.Text = "Xem bản đã phát hành"; $btnList.Location = New-Object System.Drawing.Point(335, 226); $btnList.Width = 170
$form.Controls.Add($btnList)

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

# ---- Log ----
$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(15, 318); $txtLog.Width = 595; $txtLog.Height = 250
$txtLog.Multiline = $true; $txtLog.ScrollBars = "Vertical"; $txtLog.ReadOnly = $true
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27); $txtLog.ForeColor = [System.Drawing.Color]::White
$txtLog.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($txtLog)

function Log($msg) { $txtLog.AppendText((Get-Date -Format "HH:mm:ss") + "  " + $msg + "`r`n") }

# ---- Kiem tra ban dau ----
if (-not (Test-Path $KEY_FILE)) { Log "[CANH BAO] Khong thay khoa ky: $KEY_FILE" } else { Log "[OK] Co khoa ky updater." }
Log "Nhap phien ban + repo, roi bam PHAT HANH. Lan dau hay bam 'Kiem tra GitHub'."

# ---- Su kien ----
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

$btnLocal.Add_Click({
    if (-not $txtVer.Text.Trim()) {
        [System.Windows.Forms.MessageBox]::Show("Nhap phien ban moi (vd 1.0.0-beta.12) truoc khi build.", "Thieu phien ban")
        return
    }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Build NOI BO v$($txtVer.Text) (test truoc, KHONG upload)?`r`nTao file cai dat trong Ban_Phat_Hanh\`r`nQua trinh co the mat 10-20 phut (chay trong cua so rieng).",
        "Xac nhan build noi bo", [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($ok -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    Save-Config
    $buildScript = Join-Path $ROOT "build_production.ps1"
    $skipArg = if ($chkSkipNuitka.Checked) { " -SkipNuitka" } else { "" }
    # PHAI truyen -Version: build_production doc tauri.conf; truoc day Build NỘI BỘ
    # bo qua o phien ban -> installer van mang version cu (vd go .12 van ra .11).
    $verArg = " -Version `"$($txtVer.Text.Trim())`""
    # KHONG -Release: build installer local, khong ky updater, khong upload.
    $argList = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$buildScript`"$verArg$skipArg"
    Start-Process powershell -ArgumentList $argList
    Log "Da khoi chay build NOI BO v$($txtVer.Text) trong cua so rieng. File cai dat se nam trong Ban_Phat_Hanh\."
})

$btnPublish.Add_Click({
    if (-not $txtVer.Text) { [System.Windows.Forms.MessageBox]::Show("Nhap phien ban truoc.", "Thieu thong tin"); return }
    if (-not $txtRepo.Text) { [System.Windows.Forms.MessageBox]::Show("Nhap repo phat hanh truoc.", "Thieu thong tin"); return }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Phat hanh phien ban " + $txtVer.Text + " len " + $txtRepo.Text + " ?`r`nQua trinh build co the mat 10-20 phut (chay trong cua so rieng).",
        "Xac nhan phat hanh", [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($ok -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    Save-Config
    # Truyen mat khau qua bien moi truong (khong qua dong lenh)
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $txtPwd.Text
    $notes = $txtNotes.Text -replace '"', "'"
    $relScript = Join-Path $ROOT "release_update.ps1"
    $skipArg = if ($chkSkipNuitka.Checked) { " -SkipNuitka" } else { "" }
    # KHONG truyen -ReleaseRepo: release_update.ps1 tu suy tu endpoint (nguon chan ly duy nhat).
    $argList = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$relScript`" -Version `"$($txtVer.Text)`" -Notes `"$notes`"$skipArg"
    Start-Process powershell -ArgumentList $argList
    Log "Da khoi chay build+phat hanh trong cua so rieng. Theo doi tien do o cua so do."
})

# Ep form noi len foreground khi hien (neu khong, no co the bi cua so khac che
# -- console goi bang -WindowStyle Hidden nen form khong tu gianh foreground).
$form.Add_Shown({
    $form.TopMost = $true
    $form.Activate()
    $form.BringToFront()
    $form.TopMost = $false
})
[void]$form.ShowDialog()
