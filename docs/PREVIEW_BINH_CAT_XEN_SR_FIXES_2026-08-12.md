# Nhật ký sửa log đối chiếu Preview ↔ kết quả Bình cắt xén S&R

Ngày: 2026-08-12  
Finding: `§SRPARITY.1`

## Phạm vi đã làm

- Mỗi tab/tài liệu sinh một `traceId`; mỗi request preview có `requestId` riêng.
- Frontend ghi rõ preview đang chờ, đã áp dụng, stale, hủy hoặc lỗi; lúc bấm Bình gửi
  snapshot preview đã thật sự hiển thị sang backend.
- Backend ghi các mốc `job.accepted`, kết quả solver preview/export, số placement trước
  va chạm và số placement cuối ngay trước khi vẽ PDF, cùng `traceId` và `jobId`.
- Log chỉ chứa allowlist thông số hình học và trạng thái. Không ghi đường dẫn file, nội
  dung PDF, license/HWID, mã đơn hàng, report, shape props hay cấu hình boong đầy đủ.
- Mã đối chiếu có ký tự lạ/xuống dòng bị loại bỏ để tránh chèn dòng log giả.
- Ở bước gắn log ban đầu, chưa thay đổi solver, bố cục hay file PDF đầu ra.

## Nơi xem log

- Log luôn có trong bản chạy mới: `%APPDATA%\PrynX\logs\app.log` với prefix
  `[IMPOSITION-DIAG]`.
- Khi bật `PRYNX_PERF=1`, timeline chi tiết frontend + backend nằm tại
  `%APPDATA%\PrynX\logs\preview_perf.log`.

## Kiểm thử

- Backend: `22 passed` — gồm ca `330 × 480 mm`, thành phẩm `149,1 × 53,3 mm`,
  bleed `2 mm`, hở bài `2 mm`:
  - `splitGap=0 mm` → preview `17`, export/log/PDF `17`.
  - `splitGap=2 mm` → preview `16`, export/log/PDF `16`.
- Frontend: `35 passed` cho GridPreview và payload xuất N-Up.
- TypeScript typecheck: đạt.
- Python compile: đạt.
- `git diff --check`: đạt.

## Trạng thái

Đã hoàn tất lớp log chẩn đoán và dùng log thực tế để xác định lỗi.

## Kết quả đọc log và bản sửa

- Trace thực tế cho thấy preview cuối cùng nhận bleed `2 mm` và tính `16 con/tờ`, nhưng
  backend xuất file vẫn lấy `TrimBox` nhúng trong PDF — hộp này tương đương bleed
  `3 mm` — nên tính thành `17 con/tờ`.
- Quy tắc được chốt: bleed người dùng chọn trên UI là nguồn duy nhất. `TrimBox` nhúng
  trong PDF không được ghi đè giá trị này.
- Backend nay lấy `MediaBox` (hoặc `CropBox` khi đó thật sự là trang logic trên canvas
  lớn), sau đó trừ đúng bleed UI ở bốn cạnh cho cả solver và renderer.
- Hồi quy đúng cấu hình thực tế đã đạt:
  - UI bleed `2 mm` → preview/export cùng `16 con/tờ`.
  - UI bleed `3 mm` → preview/export cùng `17 con/tờ`.
- Bộ test backend liên quan: `33 passed`; `git diff --check`: đạt.

Trạng thái: đã sửa xong nguyên nhân lệch preview ↔ PDF ở ca bleed `2/3 mm`.
