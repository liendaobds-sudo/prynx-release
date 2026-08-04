# Báo cáo Deep Audit W1 — Kích thước, đơn vị và PDF PageBox

> Ngày audit: 2026-08-04 · Baseline code: `1bf8621` · Phạm vi: W1-U01 · Phần 2–7 giữ bằng chứng baseline; mục 9 ghi kết quả sau khi user duyệt sửa toàn bộ finding.

## 1. Tóm tắt điều hành

Audit dọc và các vòng review chéo đã xác nhận sáu lỗi; tất cả đã được sửa trên worktree:

| Mã | Trạng thái | Mức | Finding | Effort |
|---|---|---:|---|---|
| `§W1.PB1` | `[CONFIRMED]` · đã sửa | P1 | Crop thủ công ánh xạ sai vùng khi PDF có `/Rotate=90/270`. | M |
| `§W1.PB2` | `[CONFIRMED]` · đã sửa | P2 | Viewer primary PDFium và HTTP fallback chọn PageBox khác nhau. | M |
| `§W1.PB3` | `[CONFIRMED]` · đã sửa | P1 | `/UserUnit` bị áp lặp ở N-Up/Booklet, làm sai khổ và số placement. | M |
| `§W1.PB4` | `[CONFIRMED]` · đã sửa | P1 | Range/all sao chép tọa độ raw nên sai vùng khi các trang có rotation khác nhau. | M |
| `§W1.PB5` | `[CONFIRMED]` · đã sửa | P1 | Crop/auto-trim dùng file gốc, bỏ state reorder/delete/duplicate/rotation chưa bake. | M |
| `§W1.PB6` | `[CONFIRMED]` · đã sửa | P1 | Viewer, PageBox, Crop và bleed hiểu `/UserUnit` không đồng nhất. | L |

W1 vẫn giữ mức toàn wave là `AUTO`: các nhánh trọng yếu đã đạt `ARTIFACT`, nhưng chưa thao tác lại toàn ma trận trên app desktop thật nên chưa thể nâng `RUNTIME`.

## 2. Phương pháp và audit unit

- `W1-U01-A`: tạo tài liệu số lẻ mm → PDF bytes → parse lại.
- `W1-U01-B`: Crop UI → page-box route → hard-crop writer → mở lại.
- `W1-U01-C`: Viewer metadata Rust/PDFium → HTTP fallback.
- `W1-U01-D`: PageBox/rotate/UserUnit → preview N-Up → output.

Mỗi finding được kiểm reachability, producer/consumer và phép biến đổi đơn vị. Artifact hoặc harness độc lập được ưu tiên hơn dữ liệu preview.

## 3. Finding chi tiết

### `§W1.PB1` — Crop thủ công sai vùng trên trang xoay

**Trạng thái:** `[CONFIRMED]` · **P1** · Effort M.

Đường sống:

`AcrobatToolbar` → `LivePageFrame` → `CropDialog` → `/preflight/crop-regions` → `PageBoxesEngine._physical_crop_page()` → PDF tải về/mở lại.

Bằng chứng:

- `desktop/src/components/workspace/CropDialog.tsx:560-576` lấy CropBox raw rồi ánh xạ trực tiếp mọi fraction hiển thị.
- `desktop/src/lib/cropDialogGeometry.ts:55-66` chỉ đổi gốc top-left → bottom-left; không đảo `/Rotate`.
- `backend/app/core/page_boxes.py:113-169` đã có phép ánh xạ rotate-aware đúng nhưng chỉ được dùng ở đường dò mép pixel.
- `backend/app/api/routes/preflight.py:1065` đăng ký route sống; writer hard-crop nằm tại `backend/app/core/page_boxes.py:727-781`.
- Hợp đồng `CropDialog` không mang intrinsic rotation của trang, nên frontend không đủ dữ liệu để đảo phép xoay.

Tái hiện độc lập:

- MediaBox `200×100 pt`, `/Rotate=90`.
- Người dùng chọn nửa trên của trang nhìn thấy `100×200 pt`.
- Mapping UI hiện tại: `[0,50,200,100]`.
- Mapping rotate-aware: `[0,0,100,100]`.

Hai hình chữ nhật khác cả vị trí lẫn kích thước; writer reachable sẽ crop vùng khác với lựa chọn của người dùng. Test hiện tại chỉ kiểm frontend không xoay và helper backend riêng lẻ, chưa khóa UI → writer → reopen cho `/Rotate`.

### `§W1.PB2` — Viewer primary và fallback trả kích thước khác nhau

**Trạng thái:** `[CONFIRMED]` · **P2** · Effort M.

Đường sống:

`usePdfLoader` → Tauri `get_pdf_metadata` → nếu lỗi thì `/api/imposition/pdf-meta` → canvas/status/overlay Viewer.

Bằng chứng:

- Primary và fallback nằm cùng đường bắt lỗi tại `desktop/src/hooks/viewer/usePdfLoader.ts:327-406`.
- Tauri command reachable tại `desktop/src-tauri/src/lib.rs:777` và được đăng ký trong invoke handler.
- HTTP route `/pdf-meta` reachable tại `backend/app/api/routes/document_tools.py:382-384`.
- Fallback dùng `effective_imposition_box()` (`backend/app/core/imposition_page_box.py:10-31`), policy dành cho bình bản: CropBox chênh nhỏ bị thay bằng MediaBox.
- Viewer primary PDFium dùng kích thước trang nhìn thấy, không dùng policy bình bản này.

Artifact harness độc lập tạo PDF:

- MediaBox `200×100 pt`.
- CropBox `[3,3,197,97]`, kích thước nhìn thấy `194×94 pt`.
- Primary PDFium: `194×94 pt`.
- HTTP fallback hiện tại: `200×100 pt`.

Khi command Rust lỗi, cùng file có thể đổi khổ canvas/overlay dù người dùng không đổi tài liệu. Test loader hiện chỉ mock primary và chưa có ca fallback PageBox.

### `§W1.PB3` — `/UserUnit` có dấu hiệu lệch giữa preview và N-Up

**Trạng thái sau tái hiện:** `[CONFIRMED]` · **P1** · đã sửa.

Bằng chứng trace:

- Metadata đọc `/UserUnit` rồi nhân vào kích thước tại `backend/app/api/routes/document_tools.py:312-345`.
- N-Up dùng `resolve_guillotine_trim()` tại `backend/app/workers/mixed_guillotine_adapter.py:51-92`; resolver lấy kích thước box raw.
- N-Up engine gọi resolver tại `backend/app/workers/nup_engine.py:502`, `2318` và `2532`.

Harness với MediaBox `100×50 pt`, `/UserUnit=2`:

- Metadata frontend: `200×100 pt`.
- N-Up resolver: `100×50 pt`.

Artifact N-Up sau đó xác nhận hai PDF vật lý tương đương tạo `16` và `4` placement. Sau sửa, cả hai tạo `4`, raster giống tuyệt đối; PlanExecutor cũng chuẩn hóa đúng một lần cho booklet, phase-2 và trang bìa tách riêng.

## 4. Hành vi đã loại khỏi finding

- `[EXPECTED]` PageBox không khai báo rơi về MediaBox và kèm cờ `has_* = false` theo schema.
- `[DISPROVED]` N-Up bỏ qua `/Rotate` nói chung: canonicalization và test parity hiện đã phủ 0/90/180/270.
- `[EXPECTED]` Response PageBox làm tròn `0,01 mm` ở tầng hiển thị/API.
- `[DISPROVED]` Tạo PDF kích thước `147,1×51,3 mm` bị ép số nguyên: test parse lại PDF bytes đang giữ số lẻ.

## 5. Corpus artifact bắt buộc

Tạo tám PDF có marker vector `TL/TR/BL/BR` và bốn màu góc:

1. MediaBox số lẻ mm, rotate 0.
2. Cùng khổ, rotate 90.
3. CropBox chênh nhỏ, thiếu Trim/Bleed, rotate 270.
4. CropBox logic lệch gốc trên MediaBox lớn, rotate 0.
5. Cùng CropBox logic, rotate 90.
6. Media/Crop/Bleed/Trim khác nhau, bất đối xứng, rotate 180.
7. `/UserUnit=2`, rotate 0.
8. PDF nhiều trang gom các biến thể trên.

Mỗi writer/consumer phải được so bằng pikepdf raw boxes, PDFium raster, metadata Rust, metadata HTTP và mở lại Viewer. Dung sai vector tối đa `0,01 mm`.

## 6. Đề xuất lô sửa — chờ duyệt

1. **Lô PB1, tối đa 4 file:** đưa intrinsic rotation vào hợp đồng CropDialog; dùng helper rotate-aware chung; thêm test 0/90/180/270 và artifact reopen.
2. **Lô PB2, tối đa 4 file:** tách policy metadata Viewer khỏi policy bình bản hoặc làm hai nhánh cùng trả visible PageBox; thêm test forced-fallback.
3. **PB3 chưa sửa:** trước hết tạo N-Up artifact `/UserUnit=2`, parse/raster/reopen; chỉ chuyển `[CONFIRMED]` nếu output thật sai.

## 7. Verify đã chạy

- Frontend: typecheck đạt; `1.837` test đạt, `2` skip.
- Backend toàn phần sau refactor ratchet: `2.185` đạt, `4` skip.
- Harness W1 độc lập tái hiện cả ba chênh lệch nêu trên.
- Chưa thao tác Crop/Viewer/N-Up trên app cài đặt; mức runtime còn thiếu.

**Chốt:** dừng ở báo cáo, chưa sửa finding. Cần user duyệt thứ tự lô.

## 8. Phụ lục phát hiện trong lúc sửa PB1

### `§W1.PB4` — Áp dụng range/all sai vùng khi các trang có `/Rotate` khác nhau

**Trạng thái:** `[CONFIRMED]` · **P1** · Effort M · đã sửa.

Frontend gửi một danh sách `rects_mm` trong hệ CropBox raw của trang tham chiếu,
backend sau đó dùng nguyên các offset raw này cho mọi trang trong `pages`. Với tài
liệu hai trang cùng nội dung bốn màu, trang 1 xoay 0° và trang 2 xoay 90°:

- chọn góc trên-trái trang 1 tương ứng màu xanh lá;
- Apply cho cả hai trang tạo page 1 màu xanh lá đúng;
- page 2 cũng thành màu xanh lá, trong khi góc trên-trái nhìn thấy của page 2 là màu đỏ.

Artifact đã raster xác nhận đây là sai vùng thật, không phải khác biệt metadata.
Cần chốt semantics cho trang khác kích thước trước khi sửa: cùng khung nhìn theo tỉ lệ,
hay cùng kích thước/vị trí vật lý trên từng hướng hiển thị. Không được tiếp tục sao chép
tọa độ raw giữa các rotation.

### `§W1.PB5` — Trạng thái trang chưa materialize có thể không đi vào Crop

**Trạng thái sau artifact:** `[CONFIRMED]` · **P1** · đã sửa.

Crop chuẩn bị file từ nguồn gốc trong Viewer, trong khi thứ tự/xoay trang có thể đang
chỉ tồn tại trong state chưa ghi ra PDF. Cần trace và tạo artifact cho chuỗi
reorder/rotate trong Viewer → Crop → reopen trước khi gọi đây là bug. Artifact sau đó
xác nhận trang đã xóa quay lại và crop sai page/rotation; bản sửa dùng working PDF strict,
ánh xạ lại fraction cho đủ 16 tổ hợp rotation và dừng nếu không materialize được.

## 9. Kết quả sau khi duyệt sửa

- `PB1/PB4`: Crop theo đúng hệ hiển thị của từng trang; artifact raster 0/90/180/270 và mixed rotation đạt.
- `PB2`: metadata Viewer primary/fallback cùng policy PageBox nhìn thấy; forced-fallback test đạt.
- `PB3`: N-Up và PlanExecutor canonicalize `/UserUnit`, `/Rotate`, gốc MediaBox đúng một lần; đầu vào không hợp lệ dừng an toàn.
- `PB5`: Crop và auto-trim dùng PDF làm việc đã bake reorder/delete/duplicate/rotation; không fallback file gốc.
- `PB6`: API PageBox/Crop/detect/auto-trim/bleed dùng mm vật lý; structural score bỏ sàn raw-unit và đã khóa artifact cực trị `/UserUnit=1/100`; Viewer native nhân `/UserUnit` đúng một lần, invalid cache khi file cùng path đổi identity, đọc bytes một lần, RAM-gate giải nén, fail-closed khi parser lệch và đọc đúng metadata sau trang 2.000.
- Bằng chứng cuối: frontend typecheck + `51` test liên quan đạt; full Vitest `1.857` đạt, `2` skip; backend full `2.238` đạt, `4` skip; Rust Tauri `56/56` test đạt và `cargo check --offline --locked` đạt; ngân sách lint đạt.
- Chưa chạy thao tác app desktop thật hoặc build release; trạng thái cao nhất của các luồng có artifact là `ARTIFACT`, không phải `RUNTIME`.
