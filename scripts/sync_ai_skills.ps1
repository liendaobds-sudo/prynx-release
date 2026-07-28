# Dong bo bo skill AI: ban goc .agents\skills  ->  ban sao .claude\skills
# Chay tu goc repo:  powershell -ExecutionPolicy Bypass -File scripts\sync_ai_skills.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root ".agents\skills"
$dst  = Join-Path $root ".claude\skills"

if (-not (Test-Path $src)) { Write-Error "Khong thay $src"; exit 1 }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# Copy de (khong xoa skill rieng chi co ben .claude, neu ban tung tao them)
Get-ChildItem -Directory $src | ForEach-Object {
    $target = Join-Path $dst $_.Name
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -Path (Join-Path $_.FullName "*") -Destination $target -Recurse -Force
    Write-Host ("da dong bo: " + $_.Name)
}
Write-Host "Xong. Ban goc: .agents\skills — sua o do roi chay lai script nay."
