# OUT FONT — NHẬT KÝ SỬA CHỮA

**Ngày:** 2026-07-27  
**Báo cáo audit:** `docs/BAO_CAO_BO_SUNG_AUDIT_OUT_FONT_2026-07-27.md`  
**Phạm vi:** toàn bộ finding §4.1–§4.3 của `OUTLINE_FONTS`; Telemetry “95% job/30 ngày” đã được chủ dự án loại khỏi phạm vi.

## 1. Kết quả

Đã xử lý hết các finding OUT FONT đã xác minh. Luồng “Khóa Font” hiện chạy theo nguyên tắc **fail-closed**: chỉ giao output khi không còn text sống và kết quả in đã vượt hậu kiểm từng trang; nếu thiếu font gốc hoặc không chứng minh được tính tương đương thì action dừng và không trả file thay thế rủi ro.

Không triển khai Telemetry và không dùng Telemetry làm tiêu chí chặn.

## 2. Các lô sửa

### Lô 1 — Engine và chốt an toàn (4 file)

- `backend/app/core/outline_text.py`
  - Duyệt Form XObject ngay cả khi trang không có `/Resources/Font` riêng.
  - Loại trạng thái dùng chung giữa các request khi duyệt Form.
  - Hỗ trợ đúng `Tr=0..7`: fill, stroke, fill+stroke, invisible và text clipping.
  - Text clipping được gom trong `BT…ET`, áp dụng đúng tại `ET`.
  - `q/Q` lưu và khôi phục đầy đủ CTM cùng text state; stream mất cân bằng bị từ chối.
  - Hậu kiểm mọi trang thay vì chỉ trang 1; thêm IoU theo ô cục bộ để sai lệch chữ nhỏ không bị nền trắng pha loãng.
  - Kiểm tra lại `count_live_text()` trước khi chấp nhận output native.
- `backend/app/core/outline_fonts.py`
  - Phát hiện font chưa nhúng qua cây tài nguyên, gồm Form XObject và annotation appearance stream.
  - Chỉ miễn đúng Base-14; không coi mọi Type1 thiếu descriptor là Base-14.
  - PDF lỗi/không đọc được trả lỗi thay vì giả định “không thiếu font”.
- `backend/app/core/action_engine.py`
  - Mọi lỗi phát hiện/nhúng font đều dừng an toàn.
  - Sau nhúng font, so lại với input để phát hiện trường hợp font bị thay thế.
  - Output Ghostscript phải đồng thời không còn text sống và vượt hậu kiểm hình ảnh từng trang.
  - Output không đạt bị loại khỏi kết quả và được dọn khỏi đĩa.
- `backend/app/core/preflight_rules/structure.py`
  - Bỏ cam kết “an toàn 100%”; mô tả đúng cơ chế hậu kiểm và điều kiện dừng.

### Lô 2 — Hồi quy (2 file)

- `backend/tests/test_outline_text_native.py`
  - Thêm fixture Form chỉ có font trong resource riêng.
  - Bao phủ đủ tám text rendering mode `Tr=0..7`.
  - Bắt sai khác ở trang 2, sai khác chữ nhỏ trên trang lớn và khôi phục text state qua `q/Q`.
- `backend/tests/test_outline_fonts_hardening.py`
  - Kiểm tra fail-closed khi thiếu font, khi `skip_embed` không an toàn, khi font nằm trong Form và khi PDF hỏng.

### Lô 3 — UI/i18n (4 file)

- `desktop/src/components/PreflightTab.tsx`
- `desktop/src/components/preprocess-tools/PreflightTool.tsx`
- `desktop/src/i18n/locales/vi.json`
- `desktop/src/i18n/locales/en.json`

UI nay ghi rõ “Hậu kiểm từng trang”, đồng thời thông báo action sẽ dừng khi thiếu font gốc, còn text sống hoặc hình in thay đổi. Không còn chuỗi “an toàn 100%”/“100% safe” trong `backend/` và `desktop/`.

## 3. Kiểm chứng

- Test trọng điểm OUT FONT + Preflight: **30 passed, 16 skipped**.
- Toàn bộ backend: **1370 passed, 16 skipped, 6 warnings** trong 206,55 giây.
- TypeScript typecheck: **đạt**.
- Toàn bộ Vitest: **1079 passed, 2 skipped, 3 failed**. Ba lỗi còn lại đều thuộc khuôn `auto_bottom` (`goldenMaster`, `regression`, `foldPrintOutward`), không thuộc các file OUT FONT/UI của đợt sửa này; không cập nhật golden snapshot ngoài phạm vi.
- `py_compile`: **đạt** cho bốn module backend đã sửa.
- `git diff --check`: **đạt** cho toàn bộ file trong phạm vi.
- Không còn tệp patch/fixture tạm do đợt sửa tạo ra.

Các ca phụ thuộc font tùy chọn được skip trên máy hiện tại; nhánh fail-closed tương ứng vẫn có test độc lập. Corpus 33 PDF nêu trong kế hoạch không có trong checkout nên không thể tái lập chỉ số 22/33 ở đợt này.

## 4. Trạng thái finding

| Finding | Trạng thái sau sửa |
|---|---|
| §4.1 — bỏ qua text trong Form XObject | Đã sửa và có hồi quy |
| §4.2 — sai `Tr`, chỉ verify trang 1, nền trắng pha loãng sai lệch | Đã sửa và có hồi quy |
| §4.3 — fallback có rủi ro nhưng UI hứa tuyệt đối | Đã chuyển fail-closed và sửa UI/i18n |
| Telemetry “95% job/30 ngày” | Loại khỏi phạm vi theo quyết định chủ dự án |
## 5. Bổ sung 2026-07-28 — file `HDKK NAME CARD.pdf`

### Nguyên nhân

- `pikepdf` parse số canh chữ thập phân trong mảng `TJ` thành `Decimal`, nhưng
  parser chỉ nhận `int`/`float`, nên nhánh native từ chối oan.
- Font CFF name-keyed được phép bỏ toán tử `charset` để dùng ISOAdobe mặc định;
  đường đọc CFF trần chưa gắn mặc định này nên không đọc được font chỉ chứa
  `.notdef` và `space`.
- Sau khi hai lỗi parser được mô phỏng sửa, màu CMYK trong content stream giữ
  nguyên nhưng so-kẽm toàn trang vẫn vượt ngưỡng do text hinting biến mất:
  viền path đậm thêm tối đa 1 px trên trang có nhiều chữ nhỏ.

### Sửa chữa

- Nhận `Decimal` ở `TJ`, `/Differences` và các mảng số PDF liên quan.
- Dùng `_deref()` cho `/W` thay vì gọi `resolve()` trên Array trực tiếp.
- Gắn ISOAdobe mặc định cho CFF name-keyed không khai `charset`.
- Nhánh object-level phải giữ nguyên chữ ký toán tử/trạng thái màu và vượt lưới
  mất/thêm/lệch mực cục bộ. Chỉ nhánh này được bỏ qua ngưỡng mean/coverage toàn
  trang khi sai biệt nằm trong viền 1 px; nhánh GS vẫn giữ chốt cũ.
- Test parity backend không còn đọc `PreflightTab.tsx` đã xoá; nguồn UI duy nhất
  là `PreflightTool.tsx`.

### Xác minh

- Nhóm OUT FONT: **53 passed, 1 skipped**.
- Nhóm Action/Preflight/no-GS: **100 passed**.
- Toàn bộ backend: **1.469 passed, 1 skipped, 6 warnings**.
- Chạy `ActionEngine` trên file thực tế với GS bị tắt:
  `success=true`, `engine=pikepdf`, `glyphs=522`, `live_text=0`, `gs_calls=0`.
