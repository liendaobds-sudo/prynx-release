# NHẬT KÝ SỬA UPSCALE — 2026-07-28

Đối chiếu: `docs/BAO_CAO_AUDIT_UPSCALE_2026-07-28.md`.

## Lô A1 — Tính đúng đắn

- Bỏ hard-cap 2.000 px và thay bằng kiểm tra RAM khả dụng trước decode/inference.
- Backend nhận `scale_factor` 2/4; ×2 được hậu xử lý xác định tại backend.
- Đổi tùy chọn sẽ hủy kết quả cũ, không lưu nhầm ảnh của cấu hình trước.
- Cho phép `.tif`; tên đầu ra dùng stem đầy đủ.

## Lô A2 — Dữ liệu in

- Chuẩn hóa EXIF orientation trước AI.
- Giữ ICC, DPI và alpha cho đầu ra PNG.
- CMYK có ICC được chuyển sang sRGB có quản lý màu; CMYK/16-bit có cảnh báo rõ.
- TIFF trong Tauri chỉ đổi PNG để xem trước, bytes gửi backend vẫn là TIFF gốc.
- GIF động bị từ chối rõ thay vì âm thầm lấy frame đầu.

## Lô A3 — Model và phát hành

- Khóa SHA-256 model ở runtime và build.
- Build chạy smoke inference thật; model thiếu/sai/hỏng sẽ chặn phát hành.
- Bổ sung nguồn, checksum và toàn văn BSD-3-Clause vào NOTICE tự sinh.

## Lô B — Chất lượng và trải nghiệm

- Nâng tile padding từ 16 lên 40 theo kết quả seam test.
- Tile theo RAM: máy <8 GB dùng 256, 8–16 GB dùng 384, máy ≥16 GB giữ 512.
- Thêm model `RealESRGAN_x4plus` RRDBNet 23 khối (~67 MB) làm chế độ Chất lượng.
- Giữ `realesr-general-x4v3` làm chế độ Nhanh cho máy yếu.
- Không fallback giữa hai model; lựa chọn UI được gửi thẳng vào API.
- Thêm hủy batch phía client, cảnh báo warmup, kích thước/model/hệ số trên preview.
- Sửa nội dung giới thiệu để cảnh báo AI có thể suy đoán chi tiết và yêu cầu kiểm tra chữ/logo ở 100%.

## Kiểm thử đã chạy

- `pytest backend/tests/test_upscale.py -q`: 8 passed.
- `npm.cmd run typecheck`: đạt.
- Smoke inference CPU cho cả `general` và `quality`: đạt.
- `gen_third_party_notices.py --check`: đạt.
- PowerShell parse `build_production.ps1`: đạt.

- Toàn backend: **1.455 passed, 22 skipped**.
- Toàn frontend: **1.150 passed, 2 skipped**.
- Lint toàn kho: chưa xanh do nợ kỹ thuật cũ (**1.526 errors, 116 warnings**); lint các file chạm trong đợt không phát sinh warning mới, typecheck vẫn đạt.
