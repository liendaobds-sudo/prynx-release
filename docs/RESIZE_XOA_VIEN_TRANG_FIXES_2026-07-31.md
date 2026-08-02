# NHẬT KÝ SỬA RESIZE + XÓA VIỀN TRẮNG

**Ngày:** 2026-07-31  
**Báo cáo gốc:** `BAO_CAO_AUDIT_RESIZE_XOA_VIEN_TRANG_2026-07-31.md`

## Lô 1 — Trang xoay và event loop

- `backend/app/core/page_boxes.py` — §A.1: bake `/Rotate` vào content và biến đổi
  đồng bộ các page box trước khi tạo mirror; bỏ nhánh chỉ nới box nhưng không vẽ.
- `backend/app/api/routes/preflight.py` — §C.2: chạy auto-trim và mirror-bleed bằng
  `run_in_threadpool`, không chặn event loop; không thay đổi phạm vi `pdfium_guard()`.
- `backend/tests/test_mirror_bleed_origin.py` — regression pixel cho 90/180/270°,
  yêu cầu cả bốn cạnh mirror có mực và output đã chuẩn hóa `/Rotate=0`.

**Verify:** `16 passed` cho mirror/auto-trim; `py_compile` hai file backend đạt;
`git diff --check` sạch.


## Lô 2 — Parity nền solid ở backend

- `backend/app/workers/pdf_tools_engine.py` — §B.1: nhận mode/màu nền và vẽ
  rectangle trước nội dung ở vector; raster dùng cùng RGB thay cho canvas trắng.
- `backend/app/api/routes/pdf_tools.py` — §B.1: route resize nhận
  `bg_fill_mode/bg_fill_color` với mặc định tương thích ngược.
- `backend/tests/test_resize_smart.py` — regression pixel cùng màu nền cho cả
  đường xobject và raster.

**Verify:** `35 passed, 1 skipped` cho resize engine/route; `py_compile` đạt;
`git diff --check` sạch.


## Lô 3 — Hợp đồng frontend và geometry nhiều trang

- `PageResizer.ts` / `PageResizerTool.tsx` — §B.2: dùng chung
  `BackgroundFillMode`; solid vẽ trước nhánh trang trắng, loại bỏ `solid/color` lệch nhau.
- `processHandlers.ts` — §A.2/A.3/C.1: dùng working PDF đã bake; tính bleed lớn
  nhất trên toàn bộ trang được chọn có xét `/Rotate`; giữ scale 1 cho
  `center_no_scale`; fail-closed khi mở nền lỗi.
- `api.ts` — §B.1: truyền mode/màu qua backend.
- `preprocSlice.ts` — mặc định state thực khớp lựa chọn mirror đang hiển thị.

**Verify:** `npm run typecheck` đạt; `22 passed` cho PreprocessEngine;
`git diff --check` sạch.


## Lô 4 — Phạm vi trang cho inpaint/image và test frontend

- `sticker_engine.py` / route `pdf_tools.py` — §A.4: thêm `process_pages`
  1-based; trang ngoài phạm vi được append nguyên bản; chỉ tắt fan-out khi thật sự
  xử lý subset, còn “Tất cả trang” giữ nguyên song song theo hồ sơ phần cứng.
- `processHandlers.ts` — gửi cùng danh sách trang cho inpaint/image.
- `test_sticker_page_canvas.py` — route parser + engine giữ trang ngoài phạm vi.
- `preprocessEngine.test.ts` — solid tạo content nền cho cả trang trắng.

**Verify:** `7 passed` backend; `23 passed` frontend; `npm run typecheck`
và `py_compile` đạt; `git diff --check` sạch.


## Lô 5 — Chốt hành vi bleed 0

- `backend/app/core/page_boxes.py` — chỉ bake `/Rotate` khi `bleed_pt > 0`;
  bleed 0 hoặc không chọn cạnh giữ nguyên content, góc xoay và khổ trang.
- `backend/tests/test_mirror_bleed_origin.py` — regression cho 90/180/270°,
  xác nhận `/Rotate`, bytes `/Contents` và `MediaBox` không bị rewrite khi bleed 0.

**Verify:** `15 passed` cho riêng mirror-bleed; bộ backend kết hợp đạt
`120 passed, 1 skipped`; `py_compile` và `git diff --check` trên hai file vừa sửa đạt.


## Xác minh tổng hợp cuối

- Backend: `120 passed, 1 skipped` cho hợp đồng API, auto-trim, mirror-bleed,
  resize vector/raster và phạm vi trang của sticker engine.
- Frontend: `npm run typecheck` đạt; `23 passed` cho PreprocessEngine.
- Ca tái hiện trang thường + trang `/Rotate=90`: trước sửa trang xoay có `83,7%`
  viền trắng; sau sửa cả hai trang đều còn `0,000` tỷ lệ viền trắng.
- Kiểm tra toàn working tree hiện còn báo một dòng trắng cuối file tại
  `backend/app/api/routes/export.py:610`; đây là thay đổi ngoài phạm vi resize và
  không được sửa trong đợt này. Diff riêng các file resize vừa chạm sạch.
- Chưa chạy lại chuỗi thao tác trên ứng dụng desktop thật; mức bằng chứng hiện tại
  là mức 2 (test tự động), cần kiểm tay file thực tế để đạt mức 3.

## Lô 6 — Tăng tốc xóa viền trắng

- `backend/app/core/page_boxes.py` — §RT.1: copy bitmap thẳng sang NumPy, đóng
  handle PDFium ngay trong khóa; tạo mask trắng bằng OpenCV 2D và lấy bbox hợp trực
  tiếp từ `connectedComponentsWithStats`, không quét toàn ảnh lại cho từng nhãn.
  Log chi tiết từng trang được hạ về debug.
- `desktop/src/lib/processHandlers.ts` — §RT.2: tài liệu sạch dùng local-path đã
  được gate bởi `getWorkingSourcePath`, bỏ lượt đọc toàn PDF vào V8, parse pdf-lib
  và multipart upload đầu tiên; tài liệu có edit/order/rotation vẫn dùng baked bytes.
- Bổ sung regression parity thuật toán cũ, trang trắng, RGB/RGBA, bốn góc xoay,
  local-path cho file sạch và baked-byte cho file bẩn.

### Benchmark cố định

PDF A4 12 trang ở 200 DPI, trộn trang thường và `/Rotate=90`, cùng dữ liệu đầu vào:

| Phiên bản | Tổng thời gian | Trung bình/trang |
|---|---:|---:|
| Trước tối ưu | `1,0541s` | `87,84ms` |
| Sau tối ưu | `0,3505s` | `29,21ms` |

Nhanh hơn **3,01× end-to-end** trong engine auto-trim. Không đổi DPI 200, ngưỡng
trắng 248, morphology, diện tích lọc nhiễu hoặc bất kỳ cap/worker nào.

**Verify:** backend `129 passed, 1 skipped`; frontend `28 passed`; `npm run typecheck`,
`py_compile` và `git diff --check` trên bốn file tối ưu đều đạt.

**Còn lại:** file trung gian auto-trim → mirror → resize vẫn có thể đi vòng
backend → WebView → backend. Muốn bỏ hoàn toàn cần một pipeline backend hợp nhất;
không gộp vào lô nhỏ này để tránh đổi hợp đồng nhiều endpoint cùng lúc.

## Lô 7 — Sửa 404 khi mở nền inpaint/image (2026-08-01)

- Runtime báo `POST /api/sticker-dieline → 404`; OpenAPI sidecar xác nhận route
  canonical là `/api/pdf-tools/sticker-dieline` vì router `pdf_tools` mang prefix
  `/pdf-tools`.
- `desktop/src/lib/processHandlers.ts` — §RT.3: sửa call site mở nền từ
  `/sticker-dieline` thành `/pdf-tools/sticker-dieline`.
- `desktop/src/lib/processHandlers.test.ts` — dựng PDF thật, chạy nhánh inpaint,
  kiểm tra URL và FormData để khóa lỗi lệch prefix.

**Verify:** frontend `29 passed`; `npm run typecheck` đạt; backend API contract
`56 passed`. `/api/vdp/fonts` vẫn có trong OpenAPI; lỗi `ERR_CONNECTION_RESET`
quan sát cùng thời điểm là kết nối thoáng qua, không phải route bị thiếu.

## Lô 8 — Khôi phục hợp đồng checkbox auto-trim (2026-08-01)

- Runtime cho thấy bỏ tick “Tự động xén viền trắng” nhưng UI nền và bước
  mirror/inpaint/image vẫn hoạt động. Nguyên nhân: cả UI lẫn bước 0b chỉ gate theo
  `scaleMode`, còn mode/màu nền vẫn được truyền vào resize cuối độc lập checkbox.
- `PageResizerTool.tsx` — §RT.4: chỉ hiện “Màu nền vùng trống” khi auto-trim bật
  và scale mode là `fit`/`center_no_scale`.
- `processHandlers.ts` — dùng cùng `backgroundFillEnabled`: checkbox tắt thì không
  gọi dịch vụ mở nền, backend nhận mode `white`, frontend nhận `bgFillMode`
  undefined; màu đã lưu không tác động output.
- Giữ mode/màu cũ trong state để khi người dùng tick lại không mất lựa chọn.
- Regression gồm ca UI ẩn/hiện, ca dương auto-trim bật gọi inpaint và ca âm
  auto-trim tắt có 0 request mở nền dù state còn lưu `inpaint/#ff0000`.

**Verify:** frontend `32 passed`; `npm run typecheck` và scoped
`git diff --check` đạt.

## Lô 9 — Lấy mẫu màu sâu mặc định 0,5 mm (2026-08-01)

- Không thêm thông số vào UI; Resize dùng cố định `0,5 mm` theo quyết định sản phẩm.
- Không dùng thẳng `edge_bite_mm=0.5`: hợp đồng cũ còn co footprint và clip mất
  artwork sát mép. Resize giữ `edge_bite_mm=0` để không xén thêm nội dung.
- `processHandlers.ts` — §RT.5: nhánh auto-trim + inpaint/image gửi tham số riêng
  `edge_sample_inset_mm=0.5` để chỉ dịch nguồn lấy màu vào trong.
- `pdf_tools.py` / `sticker_engine.py`: truyền tham số qua cả luồng tuần tự và
  worker song song; tách vị trí lấy mẫu khỏi clip vector/co footprint raster;
  sanitize giá trị hữu hạn trong khoảng `0..5 mm`.
- Mirror giữ hợp đồng riêng hiện tại; không gửi một thông số mà endpoint chưa hỗ trợ.
- Checkbox auto-trim tắt vẫn không gọi dịch vụ mở nền, nên độ sâu lấy mẫu không
  tác động lên tài liệu trong trường hợp này.
- Regression render dải đen `0,25 mm` sát mép: bleed lấy màu đỏ ở sâu `0,5 mm`
  nhưng dải đen gốc vẫn còn nguyên, cho cả `image` và `inpaint`.

**Verify:** frontend Resize `9 passed`; backend sticker `68 passed`, auto-trim
`10 passed`; `npm run typecheck`, `py_compile` và scoped
`git diff --check` đều đạt.

## Lô 10 — Bỏ dilation thừa khi kéo nền rectangle (2026-08-01)

- PDF runtime gần nhất có `23` trang, `18,362 MB`; một trang hẹp làm mức mở nền
  chung tăng tới `31 mm`, khiến spinner “Đang kéo dãn mép…” kéo dài nhiều phút.
- `cProfile` trên đúng trang 14 ghi nhận hai lần `cv2.dilate` chiếm `44,909 s`,
  trong khi render `0,104 s`, kéo màu `0,479 s`, nén `0,117 s`. Nhánh rectangle
  inpaint/trajectory không đọc mask `band`, nên toàn bộ dilation lớn bị bỏ phí.
- `sticker_engine.py` — §RT.6: chỉ dựng `band` cho `image` và inpaint contour;
  rectangle inpaint/trajectory cùng solid bỏ qua phép dilation theo bán kính bleed.
- Regression chặn mọi kernel dilation lớn hơn `3×3` trong rectangle inpaint.
- Không giảm DPI, không đổi thuật toán kéo màu và không thêm cap worker/RAM.

### Benchmark trên đúng PDF runtime, trang 14, bleed 31 mm, 300 DPI

| Phiên bản | Wall-clock | Output |
|---|---:|---:|
| Trước tối ưu | `46,415 s` | `20,461 MB` |
| Sau tối ưu | `1,170 s` | `20,461 MB` |

- Nhanh hơn **39,7×** cho trang tái hiện.
- Cả file 23 trang ở chế độ tuần tự cưỡng bức hoàn tất `21,352 s`; runtime bình
  thường trên máy mạnh vẫn giữ đa tiến trình theo hồ sơ phần cứng.
- Render trước/sau tại scale 2: cùng kích thước, `0` pixel đổi, max diff `0`.
- `preview-layout 422` trong console là hợp đồng riêng: PDF 4 trang gồm khổ
  `96×60 mm` và `100×100 mm`, không phải nguyên nhân spinner của Resize.

**Verify:** backend sticker `93 passed`; regression baseline đỏ rồi xanh;
`py_compile` và scoped `git diff --check` đạt.

## Lô 11 — Pipeline Resize + kéo nền hợp nhất (2026-08-01)

Quyết định sản phẩm mới thay thế hợp đồng checkbox ở **Lô 8**:
`autoTrimBefore` chỉ còn là cờ preset cũ; khi người dùng đã chọn
`mirror` / `image` / `inpaint`, engine tự dò mép nội dung và tạo nền, không
phụ thuộc cờ auto-trim.

- `resize_background_engine.py` — §A.2/A.3/B.1: mỗi trang đi theo một pipeline
  `dò contentBox → fit/center_no_scale → lấp vùng trống → đặt artwork vector`.
  Nền raster có SMask nằm dưới Form XObject; artwork gốc không bị raster hóa.
- Giữ độ lẹm lấy mẫu cố định `0,5 mm`, không thêm UI. `fit` sai số âm
  cực nhỏ và `center_no_scale` tràn một trục đều vẫn lấp đúng gap trục kia.
- PERF §RT.9/RT.11: zero RGB nằm sâu dưới `SMask=0`, giữ halo 2 px;
  crop ngay trong PDFium phần artwork nằm ngoài canvas. Bỏ cap DPI 600 và cap
  render 8×; không hạ chất lượng âm thầm trên máy mạnh.
- `pdf_tools_engine.py`: dynamic background luôn đi đường vector, kể cả khi
  `mode=raster`; DPI 0 dựng riêng lớp nền 300 DPI, DPI dương giữ giá trị chọn.
- Route `/pdf-tools/resize` nhận `file_path` cho tài liệu desktop sạch. File 100–500 MB
  không còn phải materialize và upload qua WebView; route không xóa file gốc.
- `processHandlers.ts`: xóa hẳn chuỗi upload → mirror/sticker-dieline → download
  → resize fill. Dynamic mode chỉ gọi `/resize` một lần và giữ nguyên
  `fit` / `center_no_scale`; `fill` / `stretch` không chạy mode nền đang bị ẩn.
- UI chỉ hiện chọn nền ở `fit` và `center_no_scale`; solid giữ luồng cũ.

### Benchmark trên PDF runtime đã báo lỗi

PDF 4 trang gồm khổ `96×60 mm` và `100×100 mm`, resize về `100×100 mm`,
mode `inpaint`, nền 300 DPI:

- Pipeline hợp nhất: `0,354 s`, output `0,065 MB`.
- Tỷ lệ pixel trắng ở bốn mép theo từng trang: `[0,0%, 0,0%, 0,0%, 0,0%]`.

### Verify

- Backend: `51 passed, 1 skipped` cho resize smart, route cũ + `file_path`, ba mode
  nền, 0/90/180/270°, CropBox lệch gốc, subset, trang trắng và overflow.
- Frontend: `17 passed` cho một request dynamic, file sạch/bẩn, legacy flag,
  `fill/stretch`, solid và visibility; `npm run typecheck` đạt.
- `py_compile` ba file backend đạt.
- Chưa chạy lại chuỗi thao tác trong app desktop thật; bằng chứng hiện tại
  ở mức 2 (test tự động + benchmark worker trên file runtime).

## Lô 12 — Xóa line trắng tại mối nối nền (2026-08-01)

- Fixture opaque có halo gần trắng tái hiện đúng lỗi: một hàng ranh giới có
  `100%` pixel gần trắng dù vùng ngoài đã được lấp nền. Nguyên nhân là halo nằm
  trong Form artwork; lớp Image + SMask ở dưới không thể che pixel opaque đó.
- `resize_background_engine.py` — §A.4: giữ vùng bảo hiểm cố định `0,5 mm`, không
  thêm UI. Thứ tự lớp trở thành `Image nền → Form vector → cùng Image cleanup`;
  lần vẽ cuối chỉ thêm một content stream nhỏ và tái sử dụng resource ảnh/SMask,
  không nhân đôi ảnh nền hay raster hóa artwork.
- Mask cleanup không phủ cứng cả dải `0,5 mm`: chỉ phủ pixel gần trắng gây
  halo/anti-alias, có guard căn hàng nhỏ trong chính dải này. Barcode, hairline và
  dải mực màu thật sát mép vẫn lấy từ Form vector; cạnh không có gap không bị phủ.
- Chi phí mới chỉ quét tối đa bốn strip rộng `0,5 mm`, không quét thêm toàn trang,
  không giảm DPI và không thêm cap trên máy mạnh.
- Regression dựng cả artwork ngang/dọc, ba mode `mirror/image/inpaint`, render lại
  ở `600 DPI`; line gần trắng phải dưới `2%`. Fixture đối chứng có dải đỏ thật
  `0,25 mm` sát mép phải giữ ít nhất hai hàng phủ màu trên `90%`.

**Verify:** test riêng nền động `23 passed`; ma trận resize smart + route + nền
động `59 passed, 1 skipped`; `py_compile` và kiểm tra trailing whitespace đạt.
