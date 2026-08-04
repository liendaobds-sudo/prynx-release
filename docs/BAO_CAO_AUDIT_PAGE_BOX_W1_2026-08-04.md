# Báo cáo Deep Audit W1 — Kích thước, đơn vị và PDF PageBox

> Ngày audit: 2026-08-04 · Baseline code: `1bf8621` · Phạm vi: W1-U01 · Chưa sửa finding trong báo cáo này.

## 1. Tóm tắt điều hành

Audit dọc các đường tạo/đọc/crop/bình PDF xác nhận hai lỗi và giữ một nghi vấn cần artifact N-Up:

| Mã | Trạng thái | Mức | Finding | Effort |
|---|---|---:|---|---|
| `§W1.PB1` | `[CONFIRMED]` | P1 | Crop thủ công ánh xạ sai vùng khi PDF có `/Rotate=90/270`. | M |
| `§W1.PB2` | `[CONFIRMED]` | P2 | Viewer primary PDFium và HTTP fallback chọn PageBox khác nhau. | M |
| `§W1.PB3` | `[SUSPECTED]` | — | `/UserUnit` được metadata nhân vào kích thước nhưng N-Up resolver dùng box raw. | M |

W1 vẫn ở mức `AUTO` cho toàn wave: có nhiều test/artifact lát cắt nhưng corpus PageBox × rotate × UserUnit × mọi consumer chưa hoàn chỉnh. Không finding nào được sửa trước chốt duyệt.

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

**Trạng thái:** `[SUSPECTED]` · chưa xếp severity.

Bằng chứng trace:

- Metadata đọc `/UserUnit` rồi nhân vào kích thước tại `backend/app/api/routes/document_tools.py:312-345`.
- N-Up dùng `resolve_guillotine_trim()` tại `backend/app/workers/mixed_guillotine_adapter.py:51-92`; resolver lấy kích thước box raw.
- N-Up engine gọi resolver tại `backend/app/workers/nup_engine.py:502`, `2318` và `2532`.

Harness với MediaBox `100×50 pt`, `/UserUnit=2`:

- Metadata frontend: `200×100 pt`.
- N-Up resolver: `100×50 pt`.

Đây là chênh lệch hợp đồng đã tái hiện, nhưng chưa tạo/raster/reopen PDF N-Up thật nên chưa nâng thành bug xác nhận.

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
