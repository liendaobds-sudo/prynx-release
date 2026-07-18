# Hướng dẫn nhanh — PDF Utilities (Phase B)

| Tool (Home) | Việc làm | Engine |
|-------------|----------|--------|
| **Khóa / Mở khóa PDF** | Mật khẩu AES, quyền in/copy; gỡ khóa | pikepdf |
| **Metadata PDF** | Sửa Title/Author… hoặc xóa hết Info | pikepdf |
| **Chèn Nền & Đóng Dấu** | Watermark + **preset chữ ký** (ảnh/text) | pdf-lib (FE) |
| **Nén / Tối ưu PDF** | Downsample, grayscale, strip meta | Ghostscript |
| **Quản lý trang** | Xoay / xóa / nhân bản / chèn / extract | viewer + pdf-lib |
| **Tách file PDF** | Theo dải / số trang / extract | backend + FE |
| **Ghép & Trộn PDF** | Ghép nối, xen kẽ, nhóm size | CombineTab |

## Không làm nhầm

- **Chữ ký preset** ≠ chữ ký số PAdES/certificate.
- **Metadata clear** ≠ nén Optimize (strip meta lúc nén là tùy chọn riêng).
- **Copy/move cross-file**: chuột phải thumbnail, không phải tab Quản lý trang.

## Free/Pro

Scaffold `desktop/src/lib/license/features.ts` + `backend/app/core/feature_entitlements.py`.
`FEATURE_GATING_ENABLED = false` → **không chặn** tool hiện tại.
