# BÁO CÁO AUDIT LÀM NÉT KHI ZOOM VIEWER — 2026-08-07

## 1. Phạm vi và trạng thái duyệt

Audit tập trung vào thời gian từ lúc người dùng dừng zoom đến lúc vùng đang nhìn đạt độ nét cuối,
không thay đổi pipeline màu, PNG lossless hay độ phân giải cuối. Người dùng đã duyệt hướng sửa
trong task hiện tại bằng phản hồi `ok làm đi`.

## 2. Baseline có bằng chứng

- `LivePageFrame.tsx`: tile sắc của viewport chờ cố định `180 ms` sau lần zoom cuối.
- Ảnh nền toàn trang chờ `250 ms`, nhưng ở zoom cao vẫn có thể xin bitmap tới ngân sách cạnh dài
  `6000 px`; PDFium chạy tuần tự nên công việc nền đang bị che có thể chặn tile viewport ưu tiên 0.
- Scheduler native chỉ chạy một render PDFium cùng lúc vì PDFium dùng khóa toàn cục. Tăng concurrency
  không tạo song song thật và có nguy cơ hồi quy an toàn.
- Log runtime hiện có cho thấy tile sau khi bắt đầu thường mất khoảng `35–225 ms`, ca nặng khoảng
  `835 ms`; độ chờ `180 ms` hiện tại bị cộng thêm trước các số này.
- Chế độ màu chính xác PPE chỉ render full-page để tránh đường nối/đổi hue giữa các tile. DPI hiện
  dùng giá trị gần như duy nhất cho từng tỷ lệ zoom, làm các lần chỉnh zoom nhỏ khó dùng lại cache.

## 3. Findings

### `§ZOOM.1` — `[CONFIRMED]` P1 — debounce tile sắc dài hơn cần thiết

`180 ms` giúp tránh hàng trăm render trung gian nhưng làm cảm giác nét lên chậm. Viewer đã gom thay
đổi Ctrl+Wheel theo khung hình và giữ bitmap cũ bằng CSS trong lúc zoom, nên có thể hạ về `90 ms`
mà vẫn không render theo từng wheel event.

### `§ZOOM.2` — `[CONFIRMED]` P1 — nền full-page cạnh tranh với vùng nhìn

Ở zoom cao, tile viewport mới là lớp quyết định độ nét thấy được. Tiếp tục dựng nền active tới
`6000 px` tạo công việc PDFium lớn nhưng ngay sau đó bị tile viewport che. Nền chỉ cần đủ để không
trắng/chớp trong lúc tile sắc đến.

### `§ZOOM.3` — `[CONFIRMED]` P2 — DPI accurate phân mảnh cache

Khóa cache PPE chứa DPI. Công thức `round(96 × scale)` tạo nhiều khóa cho các mức zoom gần nhau.
Lượng tử hóa đi lên theo nấc nhỏ cho phép dùng lại PNG đã có; DPI chọn phải không thấp hơn nhu cầu
hiển thị để ảnh cuối chỉ bị thu nhỏ, không bị phóng mờ.

## 4. Phương án đã duyệt

1. Tile viewport nét: hạ settle `180 → 90 ms`, vẫn render đúng `zoom × DPR`, ưu tiên 0.
2. Khi tile viewport hoạt động: nền full-page active giữ tối đa `2 × DPR`; trang không active giữ
   chính sách nhẹ hiện có. Chế độ accurate và zoom thấp không bị cap mới.
3. Accurate PPE: đưa DPI lên bucket `12 DPI`, giữ nguyên FOGRA39, PNG lossless và full-page parity.
4. Không tăng concurrency PDFium, không giảm chất lượng PNG, không hard-cap độ nét cuối theo máy.

## 5. Tiêu chí nghiệm thu

- Tile viewport bắt đầu sau `90 ms`, không còn cộng `180 ms` cố định.
- Ở zoom cao, nền active không vượt `2 × DPR`; tile cuối vẫn đúng `zoom × DPR`.
- Ảnh cũ tiếp tục phủ trang trong khi zoom/render, không tạo màn trắng.
- DPI accurate cùng bucket được tái dùng và luôn bằng hoặc lớn hơn DPI yêu cầu trong miền hợp lệ.
- TypeScript, test policy/render màu, toàn bộ Vitest và production build đều qua.
- Cảm giác zoom trong cửa sổ Tauri thật được ghi riêng là kiểm tra runtime; không suy diễn chỉ từ unit test.

## 6. Kết quả triển khai và verify

- `§ZOOM.1`: settle tile viewport đã giảm `180 → 90 ms`; priority 0 và scale cuối
  `zoom × DPR` được giữ nguyên.
- `§ZOOM.2`: nền active chỉ cap `2 × DPR` khi tile viewport thật sự hoạt động. Zoom thấp,
  trang accurate và mọi trường hợp chưa có tile sắc thay thế vẫn giữ nguyên renderZoom.
- `§ZOOM.3`: DPI PPE được bo đi lên theo nấc `12 DPI`; các mức chuẩn không render dư và
  các mức Ctrl+Wheel gần nhau dùng chung khóa cache.
- `npm.cmd run typecheck`: đạt.
- Test mục tiêu policy + accurate renderer: `2 files`, `18 tests` đạt.
- Toàn bộ frontend: `206 files` đạt; `1967 tests` đạt; `2 tests` bỏ qua theo thiết kế.
- Production frontend build: đạt (`tsc --noEmit` + `vite build`).

**Mức bằng chứng:** `STATIC + TEST + BUILD`. Chưa gắn nhãn `RUNTIME` cho cảm giác zoom của
bản sửa mới cho đến khi mở đúng PDF trong cửa sổ Tauri thật và quan sát/thống kê log sau sửa.
