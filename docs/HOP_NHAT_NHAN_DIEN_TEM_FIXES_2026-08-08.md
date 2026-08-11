# Nhận diện tem và hoàn nguyên UI — nhật ký triển khai

**Ngày:** 2026-08-08  
**Nguồn:** `BAO_CAO_AUDIT_HOP_NHAT_NHAN_DIEN_TEM_2026-08-08.md`  
**Trạng thái:** Đã rút lại UI một nguồn thống nhất; giữ nguyên pipeline nhận diện, khử bóng và hình học mới. Vẫn chờ nghiệm thu runtime cuối trên ứng dụng desktop.

## Quyết định UX cuối ngày 2026-08-08

- Khôi phục hai lựa chọn nguồn quen thuộc: **PDF/PNG đã có biên** và **Ảnh AI nhiều tem**.
- Mặc định mở **PDF/PNG đã có biên** và render trực tiếp `StickerTool`, vì vậy các lựa chọn
  **Bế tem nhãn / Xén vuông góc**, Đường cắt, Offset và Bù xén vẫn hiện đầy đủ.
- Khôi phục nguyên bố cục tab **Bế tem nhãn** theo commit `89a9048`: hai nhóm
  **1. Đường cắt (Dieline)** và **2. Tràn lề & Đặc ruột**, Offset bước 0,5 mm,
  kiểu góc, Crop, Đặc ruột/Bỏ nền trắng và tóm tắt hình học. Chỉ giữ phần tích hợp
  engine/race-safety mới ở phía sau giao diện.
- Workspace nhận diện chỉ được mount khi người dùng chủ động chọn **Ảnh AI nhiều tem**.
  Chọn nguồn chỉ tạo preview; `inspect/detect` chỉ chạy sau nút thao tác của người dùng.
- Gỡ tuyến riêng `prynx-sticker-source-files`. Mở/thả một PDF hoặc ảnh trở lại luồng tài liệu
  bình thường, không bị tab tem đang active hút vào và không tự nhận diện.
- Trạng thái nguồn được dùng chung theo `tabId`, nên panel phải chọn nguồn AI thì vùng xem AI mới
  phủ lên viewer. Không dùng `productType` để quyết định lớp workspace.
- Không hoàn tác inspector, state machine session, output settings, bảo toàn CutContour, khử bóng,
  Alpha/C2, Offset, Crop hoặc các sửa hình học đã đo.

## Lô 1 — Dừng tự quét và tạo cổng xác nhận

### Thay đổi

1. `stickerSheetStore.ts`
   - Thêm trạng thái `source-ready` và action `selectSource`.
   - Chọn nguồn chỉ lưu file, tạo URL preview gốc và thu hồi tài nguyên của nguồn cũ.
   - `analyze` chỉ dùng nguồn đã chọn và chặn click lặp khi request đang chạy.
   - Kết quả stale không được ghi đè tab mới; session stale được đóng.
   - Export lỗi về muộn không được hồi sinh tab đã dispose.

2. `StickerCutlineTool.tsx`
   - File ảnh do picker/native drop truyền vào chỉ đi qua `selectSource`.
   - Không còn effect tự gọi `/sticker-sheet/analyze` khi chuyển sang mode ảnh.

3. `StickerSheetPanel.tsx`
   - Bỏ warmup AI khi panel mount.
   - Chọn file chỉ tạo trạng thái `source-ready`.
   - Thêm nút **Nhận diện tem** làm cổng duy nhất bắt đầu phân tích.

4. `StickerSheetWorkspace.tsx`
   - Bổ sung finding trong lúc triển khai: picker và dropzone trung tâm cũng từng gọi
     `analyze` trực tiếp dù chưa được liệt kê ở báo cáo ban đầu.
   - Hai đường này đã chuyển sang `selectSource` và workspace hiển thị ảnh gốc với nhãn
     **Ảnh gốc · chưa nhận diện**.

### Bằng chứng tự động

- `npm.cmd run typecheck`: đạt.
- `npx.cmd vitest run src/components/preprocess-tools/StickerCutlineTool.test.tsx src/components/preprocess-tools/StickerSheetPanel.test.tsx src/components/preprocess-tools/StickerSheetWorkspace.test.tsx src/components/preprocess-tools/stickerSheetStore.test.ts`: 4 file, 21/21 test đạt.
- Full Vitest: 204/206 file đạt, 1.970 test đạt và 2 test bỏ qua. Ba ca API ngoài
  phạm vi bị timeout/giẫm mock khi chạy toàn bộ song song; chạy riêng hai file đó đạt 4/4.
- ESLint riêng 8 file sửa: đạt. ESLint toàn repo vẫn thất bại do backlog có sẵn
  (1.546 lỗi/cảnh báo), không nằm trong phạm vi Lô 1.
- Các ca đã khóa: chọn nguồn không gọi analyze, nút nhận diện gọi đúng một lần, tab nền
  không tự gọi, đổi nguồn loại kết quả stale, reset/dispose thu hồi tài nguyên, export lỗi
  về muộn không hồi sinh tab.

### Cổng nghiệm thu runtime

Chưa tuyên bố hoàn tất Lô 1 ở mức runtime. Cần kiểm tra trên app Windows thật:

1. mở công cụ Bù xén → Ảnh AI nhiều tem;
2. chọn hoặc thả một ảnh;
3. xác nhận workspace chỉ hiện ảnh gốc và chưa có overlay/tiến trình AI;
4. bấm **Nhận diện tem**, xác nhận lúc này tiến trình mới bắt đầu;
5. đổi tab rồi quay lại, bảo đảm không phát sinh lần nhận diện thứ hai.

## Lô 2 — Inspector chung cho PDF và ảnh

### Thay đổi

1. Thêm `sticker_source_inspector.py`:
   - nhận PDF, PNG, JPG/JPEG, WebP, BMP và TIFF;
   - đọc CutContour/DeviceN/Separation, vector, raster, Alpha, DPI và số trang;
   - tạo preview trang đầu có khóa PDFium;
   - không nạp AI, không chạy connected-components và không tạo CutContour.

2. Thêm endpoint `POST /api/sticker-sheet/inspect`:
   - nhận upload hoặc đường dẫn local tuyệt đối;
   - từ chối traversal, symlink cuối và định dạng ngoài allowlist;
   - chạy inspector trong thread thường, không chiếm heavy-job slot.

3. Session mới có stage `inspected`:
   - lưu bản sao nguồn và preview dưới thư mục session TTL hiện có;
   - trả nguồn biên đề xuất, confidence, cờ cần kiểm tra và metadata từng trang;
   - chặn export bằng HTTP 409 cho tới khi session có mask đã xác nhận.

### Bằng chứng tự động

- Baseline trước sửa: `test_sticker_sheet_api.py` đạt 13/13.
- Sau sửa và rà chéo artifact: `py_compile` 4 module đạt;
  `test_sticker_sheet_api.py` đạt 30/30; bộ trích CutContour/PDF source đạt 20/20.
- Ca mới khóa: PNG Alpha với DPI X/Y khác nhau, PDF có CutContour, PDF vector nhiều
  trang, local path/traversal, PDF hỏng, preview asset và cấm export trước nhận diện.
- Các test inspector gắn model AI bằng hàm ném lỗi; toàn bộ vẫn đạt, chứng minh bước
  inspect không gọi model.

### Hardening sau rà chéo

- Không còn suy CutContour từ resource/layer khai báo suông. Inspector gọi bộ trích
  contour thật đang dùng cho máy cắt và chỉ xác nhận khi path đã được paint.
- Fixture Corel thật `PL_SR_Cutline_Combined_1` nhận đúng 75 contour; resource
  CutContour không dùng nhận 0.
- PDF trộn trang có/không có đường cắt trả `manual`, `needs_review=true` và cảnh báo
  `mixed-boundary-sources` thay vì coi cả file là chắc chắn.
- Vector chỉ dựa trên path thật; font, text và Form chứa ảnh không tự động trở thành
  silhouette vector.
- Bổ sung khóa cho Alpha palette, Alpha toàn mờ, EXIF xoay với DPI lệch trục, thiếu
  DPI không bịa kích thước mm, MIME sai đuôi, TIFF nhiều frame, symlink và TTL.

## Lô 3 — Pipeline nhận diện ưu tiên dữ liệu chắc chắn

### Thay đổi

1. Thêm `sticker_source_pipeline.py`:
   - thứ tự tự động CutContour thật → vector → Alpha → nền đơn giản → AI;
   - deterministic đủ tin cậy không nạp AI; confidence thấp hoặc mask không còn component hợp lệ
     phải đi tiếp tới AI;
   - PDF render dưới `pdfium_guard()`, giữ đúng kích thước vật lý có `/UserUnit`;
   - máy từ 16 GB RAM giữ đủ 300 DPI, chỉ máy dưới 16 GB mới giảm cạnh phân tích;
   - contour lồng nhau dùng quy tắc chẵn-lẻ để không lấp mất lỗ.

2. Session inspect được nâng tại chỗ, giữ nguyên `session_id`:
   - `inspected → detecting → mask-review → mask-ready`;
   - detect có reservation độc quyền, promote ghi artifact vào vùng tạm rồi mới công bố;
   - confirm đồng thời idempotent;
   - file PDF giữ ở `source_path`, ảnh raster dùng cho review/export nằm ở
     `analysis_source.png`;
   - bản sao nguồn không kế thừa mtime cũ của file khách hàng.

3. Thêm endpoint:
   - `POST /api/sticker-sheet/{session_id}/detect`;
   - `POST /api/sticker-sheet/{session_id}/confirm`;
   - export tiếp tục trả 409 trước khi mask được xác nhận.

### Hardening sau hai lượt rà chéo

- Alpha chỉ được coi là biên thật khi cả vùng nền và vùng hình đều có diện tích đáng kể; một pixel
  trong suốt không còn làm đường cắt ôm cả trang.
- Nền gradient confidence 0,30 không chặn AI; lỗi OpenCV và hậu xử lý deterministic đều fallback
  có kiểm soát thay vì trả 500.
- PDF có SMask đi đúng nhánh Alpha; `/UserUnit` không còn làm kích thước vật lý lệch 2×.
- Hai request detect đồng thời chỉ một request được chạy model/ghi artifact; promote lỗi giữa chừng
  khôi phục preview và stage inspect.
- Export session PDF đọc `analysis_source_path`, không còn cố mở `source.pdf` bằng Pillow.

### Bằng chứng tự động

- `py_compile` các module Lô 3: đạt.
- Pipeline/session: 15/15 test đạt.
- API + pipeline + bộ trích CutContour/PDF source: 70/70 test đạt.
- Ca khóa mới gồm: gradient thấp confidence, component vụn, Alpha giả một pixel, PDF UserUnit,
  cap theo RAM, contour lồng, PDF SMask, reservation detect, promote/confirm đồng thời, rollback,
  mtime session và PDF detect → confirm → export thật.

### Việc chủ đích để Lô sau

- `vector_geometry_ref` hiện giữ tham chiếu tới PDF/trang gốc; Lô 7 phải dùng nó để bảo toàn
  CutContour/vector thật khi export thay vì dựng lại từ mask raster.
- Phiên bản edit/fingerprint của mask sẽ được chốt cùng UI review và hợp đồng export Lô 5/7.
- `/analyze` cũ vẫn mở `mask-ready` để tương thích luồng cũ cho tới khi frontend thống nhất hoàn toàn;
  luồng mới `/inspect → /detect → /confirm` luôn phải qua gate xác nhận.

## Lô 4–6 — Thử nghiệm một đầu vào thống nhất (đã rút lại ở tầng UI)

> Phần dưới ghi lại thử nghiệm đã triển khai để truy vết. Các mô tả “xóa lựa chọn nguồn” và
> “native drop vào nguồn tem” không còn là hành vi hiện tại; quyết định cuối nằm ở mục trên.

### Thay đổi

- Xóa lựa chọn nguồn `PDF/PNG đã có biên` và `Ảnh AI nhiều tem`; người dùng chỉ còn chọn
  `Bế tem nhãn` hoặc `Xén vuông góc`.
- Picker, DOM drop và Tauri native drop cùng đưa PDF/ảnh vào trạng thái `source-ready`.
  Chọn file chỉ hiện preview gốc; model/connected-components chỉ chạy sau nút
  **Tạo đường cắt và bù xén**.
- Luồng frontend được chốt thành
  `idle → source-ready → inspecting → detecting → mask-review → confirming → mask-ready → exporting`.
- Chỉ tab active, đúng `tabId` và đúng công cụ tem mới nhận native drop. Tab nền, tab đã đóng,
  chế độ Xén vuông góc và batch nhiều file không được hút nhầm nguồn.
- `StickerOutputSettingsPanel` luôn hiện ngay khi mở công cụ để người dùng chỉnh Offset, kiểu góc,
  lấp lỗ, crop, bù xén, kiểu màu và CMYK trước khi xử lý; giữ tương thích các khóa `ps_sticker_*`.
- CutContour thật và Alpha sạch tự xác nhận sau khi người dùng chạy. Chỉ nguồn phải suy biên
  (`vector`, nền ảnh hoặc AI) mới dừng ở bước **Xác nhận vùng tem**; export vẫn chỉ mở sau khi
  vùng cắt đã sẵn sàng.
- Đã xóa hẳn khối JSX thiết lập tem legacy từng bị ẩn bằng hàm luôn trả `false`.
- Nguồn PDF chọn tường minh được truyền đúng sang Xén vuông góc, không bị
  `getWorkingFile()` âm thầm thay bằng tài liệu cũ. Ảnh chỉ được chuẩn hóa thành PDF khi người dùng
  thật sự chuyển sang Xén vuông góc; ảnh mở từ Home dùng lại bản PDF đã chuẩn hóa.
- Chuyển loại gia công bị khóa trong lúc Xén đang xử lý. Export tem giữ trạng thái `exporting`
  cho tới khi `onFileFixed` commit xong vào workspace; source/settings/edit không thể chen vào giữa.
- Native drop trong lúc confirm/export không còn bị nuốt im lặng: workflow giữ nguyên và UI báo
  người dùng thả lại sau khi tác vụ hiện tại hoàn tất.

### Bằng chứng giao diện

- Ảnh báo lỗi UI cũ được tạo lúc 13:04:46, trước khi source hợp nhất được sửa lúc 14:45:41.
- Cửa sổ debug vẫn giữ trang cũ trong RAM vì Vite cổng 5173 đã tắt. Sau khi khởi động lại
  Vite từ đúng `D:\pdfcompare`, module runtime không còn hai selector nguồn và WebView đã kết nối lại.
- `StickerCutlineTool` có test dương/âm cho file đang mở, native drop đúng tab, tab nền và
  Xén vuông góc; nhận file không gọi inspect/detect cho tới thao tác người dùng.

### Sửa hồi quy UX sau phản hồi thực tế

- Nguyên nhân: bảng thiết lập từng bị đặt bên trong điều kiện `maskConfirmed`, đồng thời nút
  **Nhận diện tem** được hiện vô điều kiện cho mọi nguồn `source-ready`.
- Đã đưa bảng **Đường cắt/Bù xén** ra trước cổng xử lý; lựa chọn của người dùng được giữ nguyên
  tới payload export.
- Nút thao tác trở lại đúng ý nghĩa nghiệp vụ **Tạo đường cắt và bù xén**. Nguồn có biên chắc chắn
  không còn bắt xác nhận mask thủ công; nguồn chưa chắc chắn vẫn giữ bước review để tránh xuất dao sai.
- Không thay thuật toán C2, fairing hoặc hợp đồng hình học đã đo trên bộ 9 tem.

## Lô 7 — Giữ CutContour thật và parity khi phải dựng lại

- PDF một trang có CutContour thật được sao chép byte-for-byte khi bật
  **Giữ nguyên đường cắt vector có sẵn**.
- PDF nhiều trang chỉ giữ đúng trang đã nhận diện, gồm page box, `/Rotate`, `/UserUnit` và
  content stream; không đi qua extractor/RDP/polyline.
- Khi người dùng chủ động đổi Offset, bù xén, góc hoặc crop, export truyền đủ thiết lập tới
  `StickerEngine`; `crop_to_sticker=false` giữ canvas/tọa độ nguồn; `png_zip` vẫn lossless.
- `Offset 0` của chế độ `original` không còn bị mượn quy tắc lùi Alpha legacy `0,15 mm`.

## Hardening trên đúng ảnh khách hàng — 9 tem nền gần trắng

Input: `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`.

### Sai nguồn nhận diện 49 → 9

- Trước guard, auto chọn `simple-bg` với confidence `0,9643` nhưng thân tem trắng gần màu nền;
  mask chỉ còn bóng, chữ và artwork rời, tạo 49 component.
- Thêm guard topology chỉ cho nhánh auto: nhiều component nhỏ nằm lồng trong bbox vỏ lớn làm
  `simple-bg` bị coi là không an toàn và pipeline đi tiếp tới AI. Không morphology/ghép vùng nên
  không tự đổi quỹ đạo.
- Sau sửa, auto chọn `ai`, nhận đúng 9 tem, confidence `0,7746`; BiRefNet-lite và hậu xử lý mất
  khoảng 15 giây ở lần nạp model đầu tiên.
- Khử bóng thực sự chạy trên đủ 9/9 tem; tỷ lệ biên trắng tăng từ `0,583–0,861` lên `0,956–1,000`.

### CutContour hình chữ nhật → silhouette C2

Nguyên nhân gốc: export đã chuyển vùng tem duyệt thành PNG RGBA nhưng gọi `cut_mode=original`;
engine chỉ render nền trong suốt khi `cut_mode=alpha`, nên Alpha bị composite thành cả trang và
`Shape detected: RECTANGLE (Area ratio: 1.00)`.

Bản sửa tách hai hợp đồng:

- `alpha_source_mode` quyết định **nguồn hình học** là Alpha đã duyệt;
- `cut_mode` chỉ quyết định **vị trí dao/bù xén**;
- `original + Offset 0` dùng Alpha nhưng không tự lùi `0,15 mm`;
- Offset âm/dương đều chỉ được áp đúng một lần; fairing không cộng inset nội bộ. Hợp đồng này được
  khóa riêng ở 72/150/300 DPI;
- chế độ Alpha legacy giữ nguyên ngưỡng/fairing cũ; fairing DPI cao chỉ bật cho mask pipeline đã duyệt;
- cờ mới được truyền đủ qua nhánh tuần tự và ProcessPool nhiều trang.

Đo trên cùng artifact 9 trang ở 300 DPI:

| Đại lượng | Trước sửa | Sau sửa |
|---|---:|---:|
| IoU trung bình với mask | 0,8151 | 0,9828 |
| Diện tích đường cắt lớn hơn mask | 23,1% | 1,68% |
| Sai lệch biên P95 lớn nhất | 5,844 mm | 0,254 mm |
| Hausdorff lớn nhất | 7,894 mm | 0,479 mm |
| Đoạn cực ngắn `<0,25 mm` | 72 | 0 |
| Khớp gãy `>1°` | 108 | 0 |
| Góc nối lớn nhất | 60,06° | 0,048° |
| Trang nghi hình chữ nhật toàn trang | 9 | 0 |

Ca runtime đúng mặc định 72 DPI của ảnh thiếu metadata cũng đạt 9/9 trang, không có đoạn cực ngắn,
không có khớp gãy, IoU trung bình `0,9870`; sai lệch P95 lớn nhất `0,706 mm` tương ứng khoảng hai
pixel nguồn 72 DPI. Không tuyên bố đã kiểm trên máy bế vật lý.

## Ma trận kiểm thử cuối

- Backend pipeline/session/export + inspector: 54/54.
- Bộ trích CutContour/PDF source: 20/20; tổng ma trận hợp nhất: 74/74.
- Hồi quy Alpha/C2 của `StickerEngine`: 21/21.
- Frontend hoàn nguyên nguồn/luồng tem/routing/settings: 67/67; typecheck đạt; ESLint phạm vi
  file tem/routing đạt; `git diff --check` đạt.
- Full Vitest sau hoàn nguyên UI tem bế: 210/210 file, 2.013 test đạt, 2 test bỏ qua.
- Bổ sung test render `StickerTool` thật để khóa hai nhóm UI cũ; không còn dùng chuỗi giả
  từ mock wrapper làm bằng chứng giao diện.
- Frontend production bundle: `npm run build` đạt; `desktop/dist` đã được tạo lại sau hoàn nguyên UI.
