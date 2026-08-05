# Nhật ký triển khai Tách tem từ ảnh — 2026-08-05

## Lô 0 — Baseline trên ảnh mẫu

Nguồn cục bộ: `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`, 1313×1198 px, JPG RGB,
không có DPI và ICC.

| Model | CPU | Số component qua ngưỡng Alpha 32–224 | Kết luận |
|---|---:|---:|---|
| ISNet | 2,4771 s | 21–57 | Không đủ ổn định; chia một tem thành nhiều mảnh |
| BiRefNet-lite | 12,4077 s | 9 ở mọi ngưỡng | Đạt cổng ảnh mẫu |

Soi trực tiếp overlay ngưỡng 128 xác nhận BiRefNet-lite giữ viền trắng và đặt biên ở
mép trong của bóng mockup. Artifact nghiên cứu nằm ở
`tmp/research/sticker_sheet_baseline/` và không được commit vì chứa ảnh khách hàng.

## Lô 1 — Engine phân tích ảnh

File production:

- `backend/app/workers/sticker_sheet_engine.py`;
- `backend/tests/test_sticker_sheet_engine.py`.

Quyết định:

1. BiRefNet-lite là mặc định theo số đo Lô 0.
2. OpenCV lọc component nhỏ, đánh số theo hàng và loại alpha thấp nằm xa silhouette.
3. Mask giữ đúng kích thước nguồn; kết quả mang label-map, uncertainty-map và chỉ số
   confidence để UI chỉ dẫn người dùng tới vùng cần kiểm tra.
4. Không thêm dependency/model mới và chưa nối API/UI trong lô này.

Verify:

- `test_sticker_sheet_engine.py`: 8 passed;
- regression Tách nền cũ: 9 passed;
- chạy production engine trên ảnh mẫu: 9/9 instance, hậu xử lý OpenCV 0,377 s.

## Lô 2 — Session và API

File:

- `backend/app/core/sticker_sheet_session.py`;
- `backend/app/schemas/sticker_sheet.py`;
- `backend/app/api/routes/sticker_sheet.py`;
- `backend/app/main.py`;
- `backend/tests/test_sticker_sheet_api.py`.

Thay đổi:

1. `POST /api/sticker-sheet/analyze` nhận upload hoặc đường dẫn ảnh tuyệt đối, chạy qua
   heavy-job scheduler và trả manifest  instance.
2. Preview, label-map RGB và uncertainty-map được phục vụ bằng endpoint có entitlement
   `prepress.cutline`.
3. Mask full-resolution được materialize dưới `RESULTS_DIR/sticker_sheet_sessions`;
   store RAM chỉ giữ metadata nhẹ.
4. Session TTL 30 phút, dọn idempotent khi đóng tab và từ chối dọn ngoài root.
5. Warmup riêng dùng cùng entitlement CutContour, không buộc quyền Tách nền.

Verify:

- engine + API: 14 passed;
- hợp đồng route toàn backend: 60 passed;
- `py_compile`: đạt.

## Lô 3A-3B — Tách thao tác view, giữ màu preview và ẩn chi tiết kỹ thuật

Finding: `§AI2.UI1`, `§AI2.VIEW1`, `§AI2.COLOR1` trong báo cáo audit lần 2.

Thay đổi:

1. Workspace có hai chế độ rõ ràng: **Di chuyển** và **Sửa vùng tem**. Space tạm thời
   chuyển sang hand, chuột giữa luôn pan; wheel pan và Ctrl+wheel zoom tại vị trí con trỏ.
2. Pan dùng transform qua `requestAnimationFrame`, không ghi bitmap/pan theo từng pixel vào
   React state và không gọi backend.
3. Overlay chỉ vẽ biên instance/vùng cần kiểm tra; Alpha trong lòng tem bằng 0 nên artwork
   không còn bị ám màu.
4. Bỏ tên model, OpenCV và timing từng tầng khỏi UI. Trạng thái lần đầu đổi thành
   “PrynX đang khởi động engine”.
5. Thêm i18n Việt/Anh và test tab nền/Space/hand không sinh stroke.

Verify:

- Workspace + Panel + mask protocol: 8/8 pass.
- i18n catalog + toàn bộ test phạm vi Lô 3A-3B: 11/11 pass.

## Lô 4 — Tái sử dụng ảnh đang mở

Finding: `§AI2.ROUTE1`.

- `ImpositionTab` giữ `sourceImageFile` trước khi chuẩn hóa ảnh thành PDF một trang.
- Ảnh nguồn được truyền có type qua `ImposerDashboard` và `PreprocessingRouter` tới
  `StickerCutlineTool`.
- Khi tab active đổi sang **Ảnh AI nhiều tem**, ảnh hiện tại được analyze tự động nếu người
  dùng chưa chọn nguồn khác. Tab nền tuyệt đối không tự chạy.
- File PDF mở trực tiếp không bị coi nhầm là ảnh nguồn.

Verify Lô 4:

- Auto-source active/background + store/workspace: 9/9 pass.
- TypeScript typecheck: đạt.

## Lô 5 — Giữ màu nguồn và kích thước vật lý

Finding: `§AI2.COLOR1`, `§AI2.SIZE1`.

1. Model chỉ cung cấp Alpha; RGB production/preview luôn lấy từ ảnh nguồn đã chuẩn hóa.
2. Ảnh không DPI dùng cùng quy ước 72 DPI của cửa mở ảnh, không còn bị thu nhỏ 4,1667 lần.
3. DPI X và DPI Y được giữ độc lập từ metadata ảnh tới PNG/PDF; UI không cho sửa tay để tránh
   vô tình đổi sai kích thước vật lý. Ảnh không có metadata dùng quy ước 72 DPI của cửa mở ảnh.
4. Padding crop đổi từ 3 px cố định sang 0,25 mm rồi mới quy đổi theo DPI từng trục.
5. Artifact test mở lại PDF và đo MediaBox cho DPI 300x150.

Verify:

- Engine màu nguồn: 9/9 pass.
- API/export/page box: 10/10 pass.
- Store/Panel/routing: 11/11 pass.
- TypeScript typecheck: đạt.

## Lô 6 — Contour thích nghi giữ góc nhọn

Finding: `§AI2.CUT1`.

1. Đường Alpha của chế độ Ảnh AI dùng cửa sổ theo mm để nhận diện góc quay có ý nghĩa,
   khóa cả góc lồi lẫn góc lõm làm neo rồi fit Bézier riêng từng span trơn. Hai span kề
   nhau có tiếp tuyến độc lập tại neo nên đỉnh sao/notch không bị bo cùn.
2. Mọi candidate vẫn phải qua topology, Hausdorff tối đa 0,12 mm và safe-envelope; không
   tăng `simplify` toàn contour.
3. Nếu span khóa góc không qua guard trên contour quá gợn, engine thử bộ fit toàn ring cũ
   có cùng guard trước khi rơi về Catmull một-cubic-mỗi-node.
4. Chính sách mới là tùy chọn và chỉ được bật trong `sticker_sheet_export.py`; các công cụ
   Alpha hiện có giữ mặc định cũ. Tham số được truyền đủ qua worker nhiều tiến trình.

Artifact thật 9 tem:

- 9 trang, 9/9 trang có spot color `CutContour`, không trang nào dùng line fallback;
- số cubic từng trang: `43, 39, 99, 55, 59, 58, 45, 56, 53`;
- trang 1 giảm từ 152 xuống 43 cubic; trang 9 giảm từ 162 xuống 53 cubic;
- contour khó nhất từng rơi về 168 cubic/31 đoạn ngắn dưới 0,2 mm, sau fallback có guard
  còn 59 cubic/0 đoạn ngắn;
- toàn bộ artifact chỉ còn 2 đoạn dưới 0,2 mm trên 2 trang, mỗi trang một đoạn; không đổi
  MediaBox/TrimBox và render Poppler không thấy self-intersection hay gãy viền;
- phân tích 10,078 giây, export 2,887 giây ở lượt đo cuối.

Verify:

- fixture sao khóa đủ 10 góc lồi/lõm;
- regression contour tròn, fallback có guard và PDF thật: đạt;
- toàn bộ `test_sticker_engine_e2e.py`: 82/82 pass.

## Lô 7 — Giải phóng GPU trước khi fallback CPU

Finding: `§AI2.RUNTIME1`.

1. Session DirectML lỗi được tháo khỏi cache và đóng nếu runtime hỗ trợ `close()`.
2. Tham chiếu local được bỏ, tài nguyên được thu gom trước khi nạp session CPU; không còn
   thời điểm giữ đồng thời model GPU lỗi và model CPU đang tạo.
3. CPU fallback vẫn sticky như trước và không thêm hard-cap/worker-limit cho máy mạnh.

Verify:

- test lifecycle chứng minh thứ tự `gpu_closed -> gc -> cpu_created`;
- nhóm engine tách nền: 5/5 pass;
- engine/API Ảnh AI + fallback: 24/24 pass.

## Verify tổng hợp sau audit lần 2

- Backend E2E tạo đường cắt: 82/82 pass.
- Backend engine/API Ảnh AI + tách nền: 24/24 pass.
- Frontend đúng phạm vi: 5 file test, 16/16 pass.
- TypeScript typecheck: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending Windows đã biết.
- Không build installer, không chạy pipeline phát hành.

## Lô 8 — Follow-up runtime: UI, kích thước, smoothing ảnh lớn và điều hướng

Phản ánh runtime ngày 2026-08-05:

1. Xóa hoàn toàn dòng “Lần đầu có thể lâu hơn…” khỏi trạng thái phân tích.
2. Xóa cảnh báo DPI literal cũ tự mâu thuẫn `300 DPI` với state `72 DPI`. Panel chỉ hiển thị
   số pixel gốc, khổ vật lý theo DPI đang chọn và cam kết đúng phạm vi: không downsample;
   PNG trong suốt dùng nén lossless. JPG/TIFF phải được đóng gói lại thành PNG vì đầu ra cần Alpha,
   nhưng artwork không bị nội suy/phóng-thu khi crop từng tem.
3. Nút **Tạo PDF có đường cắt** chỉ cập nhật file làm việc; không đổi mode và không tự mở
   `sticker_imposer`. Test khóa trạng thái `ai-sheet` sau export.
4. Profile làm mượt Alpha giờ lấy cả đường chéo vật lý và kích thước một pixel nguồn. Candidate
   vẫn phải giữ topology, nằm trong Alpha và qua Hausdorff có cap 0,75 mm. Nếu fit trực tiếp
   thất bại, engine thử các anchor lùi thích nghi từ mạnh đến nhẹ; không còn một ngưỡng 0,12 mm
   áp cho mọi khổ ảnh.
5. Fallback DirectML → CPU tháo trực tiếp `InferenceSession._sess` trước khi tạo CPU session.
   Đây là native handle thật của ONNX Runtime; chỉ xóa cache Python/`gc.collect()` chưa đủ.

Baseline artifact thật 9 tem, xuất 72 DPI:

- trước: `554–1.165` cubic/trang; trang 3 và 5 rơi về `1.649/964` đoạn thẳng;
- sau: `140–490` cubic/trang; `0` đoạn thẳng và `0` đoạn ngắn dưới 0,2 mm trên cả 9 trang;
- trang 1: `754 → 155` cubic; trang 2: `554 → 140`; trang 5: `964 line → 275 cubic`;
- render Poppler giữ artwork và góc sao nhọn, không thấy self-intersection.

Verify:

- Backend E2E tạo đường cắt: 83/83 pass.
- Backend Ảnh AI/API/fallback: 25/25 pass.
- Frontend đúng phạm vi + i18n: 20/20 pass.
- TypeScript typecheck: đạt.
- Runtime native: cưỡng bức `8007000E`, DirectML được hủy, CPU session nạp thành công và trả
  RGBA đúng `1313 × 1198`.
- Không build installer.

## Lô 9 — Follow-up export 500, DPI UI và thao tác wheel

Phản ánh runtime ngày 2026-08-05, session `0cef39d75a21497e88663573d16e10b2`:

1. Xóa hoàn toàn hai ô `DPI X`/`DPI Y`. DPI vẫn được lấy tự động từ metadata ảnh hoặc mặc định
   72 DPI để giữ đúng kích thước; người dùng chỉ còn chỉnh Offset và Tràn lề.
2. Thay React `onWheel` bằng listener native `{ passive: false }`; pan/zoom không còn gọi
   `preventDefault()` bên trong passive listener của WebView2.
3. HTTP 500 có detail `(error)` được xác định là `cv2.error`. Export giữ raster dò biên 300 DPI
   vì thử 72/150 DPI làm tem sao rơi về 662/968 đoạn thẳng. Phép đo mép trắng có fallback NumPy;
   engine dọn artifact dang dở, thu gom bộ nhớ và thử lại đúng một lần. Nếu vẫn lỗi thì trả thông
   báo nghiệp vụ 422 thay vì 500 kỹ thuật.
4. Dòng 403 `localfile.localhost/.../5764603.jpg` không thuộc export: file Recent/source cũ đó không
   còn trên Desktop. React DevTools và lazy-image intervention chỉ là thông tin của chế độ dev.

Runtime đúng luồng API với file thật `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`:

- phân tích nhận đủ 9 tem;
- export HTTP 200 trong 10,080 giây ở lượt đo cuối, tạo PDF 9 trang;
- cả 9 trang có CutContour; `140–490` cubic/trang và tổng line fallback bằng `0`;
- render Poppler trang 1, 3 và 5 giữ màu artwork, contour kín và bám góc lõm/nhọn.

Verify:

- Frontend đúng phạm vi: 5 file test, 18/18 pass; i18n chạy riêng ở gate cuối.
- Backend Ảnh AI/API/fallback: 27/27 pass, gồm retry engine và fallback mép trắng khi `cv2.error`.
- TypeScript typecheck: đạt.
- Không build installer, không commit, không push.

## Lô 10 — Hiển thị PDF kết quả sau export

Phản ánh runtime: loading kết thúc nhưng vùng xem vẫn giữ workspace chỉnh mask, khiến PDF đã commit
thành công bị che hoàn toàn và người dùng tưởng không có file kết quả.

1. Chỉ sau khi `onFileFixed` commit xong blob/path, submode chuyển từ `ai-sheet` sang `existing` để
   lớp chỉnh mask biến mất và PDF CutContour hiện ngay trong viewer.
2. Đây không phải điều hướng sang `sticker_imposer`/Bình tem bế; `activeDashboardTool` vẫn là
   công cụ Bù xén — Tạo đường cắt.
3. Session AI và edits không bị xóa. Người dùng có thể chọn lại **Ảnh AI nhiều tem** để sửa tiếp.
4. Toast hiển thị tên file kết quả và số tem đã tạo.

Verify:

- regression component: commit nhận đúng blob/name/path rồi mode mới đổi sang `existing`;
- frontend đúng phạm vi + i18n: 21/21 pass;
- TypeScript typecheck: đạt;
- không build installer, không commit, không push.

## Lô 11 — Làm mượt contour theo nhiều thang đo cho ảnh khổ lớn

Phản ánh runtime: đường cắt ở ảnh có kích thước vật lý lớn vẫn chia thành nhiều cubic ngắn,
trông gãy dù profile Hausdorff đã tăng theo khổ.

1. Fitter không còn suy hướng tiếp tuyến từ đúng một cạnh pixel. Hướng ở span cong được
   ước lượng từ một dải biên bằng trục chính; góc chỉ được khóa khi cùng chiều quay còn tồn
   tại ở các cửa sổ lớn hơn. Bậc raster cục bộ vì vậy không trở thành góc giả.
2. Span ngắn giữa các notch giữ fitter tương thích; chỉ span đủ dài mới dùng tiếp tuyến đa
   tỉ lệ. Candidate dày node luôn được so với nhánh tương thích và lấy kết quả ít đoạn hơn.
3. Khi đường cắt đã lùi vào Alpha, engine đi thẳng qua anchor có headroom thay vì fit trực
   tiếp rồi chắc chắn bị safe-envelope loại. Contour nhiều notch có fallback simplify theo
   ngân sách vật lý, làm mượt Catmull–Rom nhưng khóa tay nắm độc lập ở mọi góc lồi/lõm.
4. Mọi nhánh mới vẫn bắt buộc giữ topology, không tự cắt, nằm trong safe-envelope và không
   vượt cap Hausdorff 0,75 mm. Không tăng DPI, không thêm worker/cap tài nguyên.

Regression contour tròn 72 DPI ở `50/200/500/1.000 mm` còn lần lượt `4/8/8/18` cubic;
fixture 96 đỉnh lồi/lõm còn đúng 96 cubic, giữ toàn bộ notch và qua safe-envelope.

Artifact 9 tem lấy từ file thật, giữ quy ước ảnh không metadata là 72 DPI:

- trước: `140–490` cubic/trang, tổng `2.312` cubic;
- sau: `105–188` cubic/trang, tổng `1.310` cubic, giảm `43,3%`;
- trang khó nhất: `490 → 164` cubic; cả 9/9 trang có CutContour và `0` line fallback;
- lượt tuần tự cưỡng bức một worker: `11,777 giây` cho 9 trang; đây là baseline bảo thủ,
  không áp cap vào runtime máy mạnh;
- render Poppler trang 1, 3 và 8 cho thấy span cong mượt, các đỉnh/notch vẫn sắc và không có
  self-intersection hay vùng lấn ra bóng.

Verify:

- `test_sticker_engine_e2e.py`: 85/85 pass;
- `test_cutline_contour.py`: 11/11 pass;
- Ảnh AI/API/fallback liên quan: 27/27 pass;
- không build installer, không commit, không push.

## Lô 12 — Làm mượt thích ứng cho PDF/PNG đã có biên

Phản ánh follow-up: profile đa tỉ lệ của Lô 11 mới chỉ được bật ở luồng **Ảnh AI nhiều tem**;
chế độ thường `PDF/PNG đã có biên` vẫn simplify cố định 0,20 mm nên tem 72 DPI khổ lớn còn hàng
nghìn node raster.

1. Route thường chỉ bật policy thích ứng khi đúng tổ hợp contour giữ nguyên góc: có đường cắt,
   không phải Xén vuông góc, không selection object và không tái dựng hình chuẩn. Các chế độ khác
   giữ nguyên legacy.
2. Engine suy ra kích thước pixel nguồn bằng `pikepdf` khi trang chắc chắn chỉ có đúng một XObject
   ảnh phủ kín CropBox. Trang vector, nhiều ảnh, biến dạng không đều hoặc file nhiều trang có DPI
   không nhất quán trả `None`; không gọi thêm PDFium và không đoán metadata.
3. Fitter riêng của chế độ thường simplify theo ngân sách mm trước rồi mới fit từng span. Góc lồi/lõm
   có neo độc lập; candidate bắt buộc giữ topology, hợp lệ và có Hausdorff tối đa 0,45 mm — bảo thủ
   hơn cap 0,75 mm của luồng loại bóng Ảnh AI.
4. Candidate không giảm được ít nhất 15% node, geometry nhiều mảng không phù hợp hoặc bất kỳ guard
   nào thất bại sẽ quay về đúng `simplify(0,20 mm) + preserve-corner` cũ. PDF nguồn đã định nghĩa
   `CutContour` luôn bị hạ về legacy để thay đổi này không tái diễn giải khuôn vector có sẵn.
5. Policy và DPI suy ra được truyền qua worker nhiều tiến trình. Không thêm worker, không tăng DPI,
   không build installer.

Artifact PNG 72 DPI khổ `1.000 × 1.000 px` (~352,8 mm), nền trắng, tem tròn:

- legacy: `3.407` đoạn thẳng, `1,207 giây`;
- adaptive: `16` cubic, `0` đoạn thẳng, `1,158 giây`;
- MediaBox và TrimBox giữ nguyên; render Poppler cho thấy đường tròn mượt, không self-intersection.

Artifact sao 72 DPI khổ lớn:

- `22` cubic, `0` đoạn thẳng, `1,174 giây`;
- cả 5 đỉnh lồi và 5 góc lõm giữ sắc; TrimBox không đổi.

Ca PDF phức tạp có 760 mảng rời được guard trả ngay về legacy: thời gian `75,897 giây`, cùng
`17.647` đoạn thẳng như baseline thay vì vượt quá 180 giây khi thử dùng thẳng fitter Ảnh AI.

Verify:

- test mới DPI 72/300, vector/nhiều ảnh, tròn 500 mm, sao lồi/lõm, fallback và route gate: 11/11 pass;
- toàn bộ `test_sticker_engine_e2e.py`: 96/96 pass;
- `test_cutline_contour.py`: 11/11 pass;
- route/canvas/parallel fallback: 49/49 pass;
- `git diff --check`: đạt; chỉ có cảnh báo line-ending Windows đã biết;
- không build installer, không commit, không push.
