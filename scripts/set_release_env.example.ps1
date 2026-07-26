# ============================================================================
# set_release_env.example.ps1  —  MẪU (an toàn commit)
#
# CÁCH DÙNG:
#   1. Copy file này thành  scripts\set_release_env.ps1  (bản thật, đã .gitignore)
#   2. Điền 2 secret Supabase từ Dashboard (xem link bên dưới)
#   3. Dot-source NGAY TRƯỚC KHI build, trong cùng cửa sổ PowerShell:
#          . .\scripts\set_release_env.ps1
#          .\build_production.ps1 -Release
#
# LƯU Ý BẢO MẬT:
#   - set_release_env.ps1 (bản thật) chứa service_role key dạng plaintext.
#     KHÔNG commit, KHÔNG chia sẻ. Đã được .gitignore.
#   - build_production.ps1 tự xoá PRYNX_DIELINE_KEY_B64 khỏi env sau maturin,
#     nhưng 3 biến dưới đây vẫn còn trong phiên PowerShell → đóng cửa sổ sau khi build.
# ============================================================================

# ---- 1 + 2: Supabase (lấy tại Dashboard → Project Settings → API) ----
#   Project: ryvyuxjgdcvoxujqmggm
#   URL trang lấy key:
#   https://supabase.com/dashboard/project/ryvyuxjgdcvoxujqmggm/settings/api
#
#   - PRYNX_SUPABASE_URL         = mục "Project URL"
#   - PRYNX_SUPABASE_SERVICE_KEY = mục "Project API keys" → dòng **service_role**
#                                  (KHÔNG phải anon / publishable)
$env:PRYNX_SUPABASE_URL         = "https://ryvyuxjgdcvoxujqmggm.supabase.co"
$env:PRYNX_SUPABASE_SERVICE_KEY = "<DÁN service_role KEY VÀO ĐÂY>"

# ---- 3: Khoá ký updater (đã có sẵn ở máy, KHÔNG passphrase) ----
#   File khớp pubkey nhúng trong app đã xác minh: ~/.tauri/prynx.key
$env:TAURI_SIGNING_PRIVATE_KEY          = Get-Content "$HOME\.tauri\prynx.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

Write-Host "Release env set. PRYNX_SUPABASE_URL=$env:PRYNX_SUPABASE_URL" -ForegroundColor Green
if ($env:PRYNX_SUPABASE_SERVICE_KEY -like "*DÁN*") {
    Write-Host "  CẢNH BÁO: PRYNX_SUPABASE_SERVICE_KEY chưa điền — build sẽ từ chối khoá dieline." -ForegroundColor Yellow
}
