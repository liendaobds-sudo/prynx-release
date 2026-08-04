# Nhật ký sửa PDF PageBox — 2026-08-04

> Phạm vi: Deep Audit W1 · Findings `§W1.PB1`–`§W1.PB6` · Không build hoặc phát hành GitHub.

## `§W1.PB1` — Crop thủ công trên trang có `/Rotate`

**Trạng thái:** đã sửa trên worktree · bằng chứng `ARTIFACT` · còn chờ kiểm runtime trong app.

### Nguyên nhân gốc

Khung crop được vẽ theo trang mà PDF.js/PDFium đã áp `/Rotate`, nhưng frontend đổi
tỉ lệ hiển thị thẳng sang CropBox gốc như trang luôn có góc xoay 0°. Với trang
`200×100 pt`, `/Rotate=90`, chọn nửa trên vì vậy bị gửi thành
`[0,50,200,100]` thay vì `[0,0,100,100]`.

Artifact baseline mở lại thành `50×200 pt` và lẫn hai nửa nội dung; vùng đúng mở
lại thành `100×100 pt` và chỉ giữ đúng nửa người dùng chọn.

### Thay đổi

- `backend/app/core/page_boxes.py`: trả góc `/Rotate` nội tại đã chuẩn hóa cùng 5 PageBox.
- `backend/app/schemas/preflight.py`: khóa field `rotation` trong hợp đồng response.
- `desktop/src/lib/cropDialogGeometry.ts`: thêm ánh xạ xuôi/ngược cho 0/90/180/270;
  kích thước và căn chỉnh dùng hướng người dùng đang nhìn thấy.
- `desktop/src/components/workspace/CropDialog.tsx`: dùng rotation ở preview,
  edge-processing, kích thước chính xác và request crop cuối.
- Test frontend khóa bốn góc; test backend tạo PDF bốn màu, crop, mở lại và raster
  artifact thật ở cả bốn góc.

### Verify

- Frontend crop: `5` file test, `32` test đạt; trong đó interaction test khóa body
  `/crop-regions` của `/Rotate=90` thành `[0,0,100,100]`.
- Frontend typecheck: đạt.
- Backend PageBox/crop: `28` test đạt.
- Artifact 0/90/180/270: đúng kích thước hiển thị và đúng vùng màu.
- Không cập nhật snapshot/golden.

### Còn thiếu

- Chưa thao tác lại trên app desktop thật: mở PDF có `/Rotate=90`, vẽ một vùng bất
  đối xứng, Apply rồi đối chiếu file mở lại. Vì vậy chưa nâng lên `RUNTIME`.

## Các lô tiếp theo đã hoàn tất

### `§W1.PB2` — parity metadata Viewer

- HTTP fallback dùng cùng visible PageBox với primary PDFium.
- Test ép nhánh fallback khóa kích thước và từng trang.

### `§W1.PB3` — canonical page space cho N-Up và PlanExecutor

- Bake `/UserUnit`, `/Rotate` và gốc MediaBox đúng một lần, xóa `/UserUnit` sau bake.
- Dùng cùng file canonical cho booklet thường, phase-2 và trang bìa tách riêng.
- Lỗi chuẩn hóa hoặc `/Rotate` không hợp lệ dừng an toàn; không xuất âm thầm.
- Logic canonicalization được tách khỏi `nup_engine.py` sang module riêng để giữ ratchet kiến trúc.

### `§W1.PB4` — Crop range/all trên trang xoay hỗn hợp

- Gửi thêm vùng theo hệ hiển thị và đảo riêng theo `/Rotate` của từng trang.
- Giữ cùng kích thước/vị trí vật lý, kể cả các trang có `/UserUnit` khác nhau.

### `§W1.PB5` — Crop dùng working PDF

- Reorder/delete/duplicate/rotation được materialize strict trước upload.
- Crop dùng số trang trong PDF đã bake; fraction được đổi giữa hệ Viewer và artifact.
- Auto-trim dùng cùng callback working PDF; lỗi materialize không fallback file gốc.

### `§W1.PB6` — `/UserUnit` xuyên backend và Viewer native

- `page_boxes.py` đổi đúng hai chiều raw unit ↔ mm vật lý cho get/set/crop/detect/auto-trim/bleed.
- Ngưỡng dò mép, DPI render, margin và structural score bất biến theo `/UserUnit`.
- Structural score bỏ sàn `1.0` raw unit; ca cực trị `/UserUnit=1/100` khóa cùng một boundary vật lý.
- Viewer native cache `/UserUnit` theo trang, nhân metadata và render scale đúng một lần cho full-page/tile.
- Cache tài liệu và tile mang identity `size + mtime (+ creation time)`; thay PDF cùng đường dẫn không còn lấy document/JPEG cũ.
- Rust đọc bytes một lần, parse `lopdf` trước rồi mới chuyển buffer sang PDFium; giới hạn giải nén chỉ áp cho máy `<8 GB`/`<16 GB`, máy `≥16 GB` hoặc không xác định RAM không bị cap.
- Lỗi parser hoặc lệch số trang giữa `lopdf` và PDFium dừng an toàn; metadata đọc kích thước thật của cả trang sau mốc 2.000.

### Verify tổng hợp

- Frontend: typecheck đạt; `51/51` test liên quan đạt; full Vitest đạt `1.857`, skip `2`; cổng ngân sách lint đạt.
- Backend: re-review PageBox/Crop/auto-trim đạt `53/53`; full pytest cuối đạt `2.238`, skip `4`.
- Rust Tauri: `cargo test --lib --offline` đạt `56/56`; `cargo check --offline --locked` đạt.
- ESLint tuyệt đối còn nợ nền toàn repo (`1.438` error, `104` warning); lô này không tăng ngân sách và không tự nâng trần.
- Không cập nhật golden/snapshot; không build release, không push hoặc phát hành GitHub.
