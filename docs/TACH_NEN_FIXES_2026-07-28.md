# Nhật ký sửa Tách nền AI — 2026-07-28

Đối chiếu báo cáo gốc: `docs/BAO_CAO_AUDIT_TACH_NEN_2026-07-28.md`.

## Trạng thái

Các phát hiện §BG.01–§BG.09 đã được xử lý trong phạm vi code có thể kiểm chứng tự động.
Tính năng đã chuyển từ **NO-GO do lỗi runtime** sang **READY FOR MANUAL QA**. Build NSIS/release
thật chưa chạy trong lượt này; build script đã có fail-fast model hash + smoke inference.

## Lô A — DirectML và lỗi 500

- `birefnet_engine.py`, `isnet_engine.py`: cấu hình `ORT_SEQUENTIAL`, tắt memory pattern và
  khóa `Run` theo đúng từng DirectML session. CPU/CUDA và variant khác không bị khóa, bảo toàn
  công suất máy mạnh.
- GPU lỗi/OOM chuyển session sang CPU bên trong cùng critical section, loại race `_force_cpu`.
- Test giả lập session không cho concurrent `Run`; thử thật hai tác vụ chồng nhau đều hoàn tất.

## Lô B — Model và release

- Thêm `model_cache.py`: tải `.part`, SHA-256, `fsync`, `os.replace`, khóa liên tiến trình;
  model cache cụt/sai hash bị xóa và tải lại.
- Chốt hash ISNet, BiRefNet-lite và BiRefNet-full.
- `build_production.ps1` bundle ISNet để chế độ Nhanh chạy offline; kiểm hash và smoke inference
  trước Nuitka. BiRefNet vẫn tải theo nhu cầu nhưng qua cache atomic có kiểm hash.
- Khai ISNet trong `scripts/bundled_components.json`.

## Lô C — Hợp đồng ảnh in

- Backend upload nhận TIFF/BMP thống nhất với picker frontend.
- Áp EXIF orientation trước inference; chuyển ICC về sRGB có quản lý; giữ ICC/DPI đầu ra.
- Alpha nguồn được nhân với mask AI, không làm sống lại vùng vốn trong suốt.
- Bỏ hard-cap 6000 px. Máy dưới 16 GB được giảm theo RAM khả dụng và UI nhận warning; máy
  từ 16 GB không bị hạ âm thầm, chỉ từ chối rõ ràng khi RAM còn trống thực sự không đủ.
- Response trả kích thước/warning bằng header cho frontend.

## Lô D — UI và state

- Warmup được gộp thành một promise theo model; xử lý thật chờ warmup đang chạy thay vì tranh
  chấp cùng session.
- Đổi model/Edge Shift/màu nền/Auto-Crop thu hồi blob cũ và đưa item về `pending`.
- Khóa thiết lập trong lúc chạy, thêm nút Hủy, `finally` luôn dọn trạng thái.
- Parse `detail` từ API; không dán raw JSON lên canvas.
- Mở UI chọn nền trong suốt/trắng/đen/màu tùy chọn.
- Shared image store thu hồi object URL khi thay/xóa/undo/reset.
- Upscale dùng fallback snapshot ổn định, hết cảnh báo React `getSnapshot`.

## Test và bằng chứng

- `python -m pytest backend/tests`: **1546 passed, 22 skipped**.
- Test Tách nền/model mới: **11 passed**.
- Frontend `npm run typecheck`: **PASS**.
- Frontend `npm run test`: **140 files passed; 1202 passed, 2 skipped**.
- ESLint riêng các file frontend đã sửa: **PASS**.
- Lint toàn kho vẫn đỏ do baseline ngoài phạm vi: **1516 errors, 111 warnings**; không có lỗi
  trong các file Tách nền/Upscale/shared store đã sửa.
- Smoke thật qua HTTP route, ISNet + DirectML, ảnh JPG 700×437: **HTTP 200**, output RGBA PNG
  700×437, 209337 byte, khoảng **5,19 giây cold start**.
- Hai test API từng timeout khi chạy đồng thời với lint + full pytest đã chạy lại cô lập:
  **3/3 PASS**; đây là nghẽn tài nguyên của cách chạy verify, không phải hồi quy.

## QA tay còn phải làm trước release

1. Chạy `run_dev.bat`, thử lần lượt Nhanh / Chất lượng cao / Tóc-lông-kính.
2. Thử hai tab Tách nền cùng lúc và đổi model khi warmup.
3. Soi ảnh tóc, lông, kính, cạnh sản phẩm trên nền caro/trắng/đen.
4. Thử TIFF/BMP, JPEG EXIF xoay, CMYK/ICC và ảnh 300 DPI.
5. Chạy `build_production.ps1`, cài artifact và thử máy không có cache `~/.u2net` để xác nhận
   ISNet offline; thử tải BiRefNet lần đầu và ngắt mạng giữa chừng rồi chạy lại.
