# Kiem tra file nguon con dung UTF-8 va con dau tieng Viet hay khong.
# Ly do ton tai: Set-Content cua PowerShell 5.1 ghi ANSI, lam mat dau tieng Viet
# ma van compile duoc -> loi im lang.
$files = @(
    "print_engine\src\geom.rs",
    "print_engine\src\image\filters.rs",
    "print_engine\src\color\space.rs",
    "print_engine\src\color\icc.rs",
    "print_engine\src\image\sampler.rs",
    "print_engine\src\content\interp.rs",
    "print_engine\src\page.rs",
    "print_engine\examples\plate_stats.rs",
    "scripts\ppe_golden_compare.py",
    "scripts\gen_third_party_notices.py",
    "native\src\print_engine_py.rs"
)
foreach ($f in $files) {
    if (-not (Test-Path $f)) { Write-Host "$f -- KHONG TON TAI"; continue }
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $high = 0
    foreach ($b in $bytes) { if ($b -gt 127) { $high++ } }
    try {
        $enc = New-Object System.Text.UTF8Encoding($false, $true)
        $null = $enc.GetString($bytes)
        $utf8 = "UTF8-OK"
    } catch {
        $utf8 = "KHONG-UTF8"
    }
    Write-Host ("{0,-46} highbytes={1,-7} {2}" -f $f, $high, $utf8)
}
