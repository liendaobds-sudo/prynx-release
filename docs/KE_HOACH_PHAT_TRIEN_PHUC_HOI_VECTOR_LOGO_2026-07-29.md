# Kế hoạch phát triển — Phục hồi & Vector hóa Logo

**Ngày lập:** 2026-07-29  
**Trạng thái:** Chờ duyệt triển khai  
**Tên hiển thị đề xuất:** Phục hồi & Vector hóa Logo  
**Tên module:** `logo_rebuild`  
**Feature entitlement:** `util.logo_rebuild`  
**Báo cáo khảo sát liên quan:** `docs/BAO_CAO_KHAO_SAT_TAI_DUNG_LOGO_2026-07-29.md`

---

## 1. Mục tiêu sản phẩm

Xây dựng một công cụ chạy cục bộ trong PrynX để biến ảnh chụp logo thành artwork có thể chỉnh sửa
và sử dụng cho in ấn. Phiên bản đầu tiên tập trung vào logo phẳng hoặc gần phẳng, còn đủ thông tin
đường biên và có từ 1–12 màu chính.

Luồng sử dụng mục tiêu:

```text
Nhập ảnh
  → chọn vùng logo
  → sửa phối cảnh
  → giảm ảnh hưởng nền vải/ánh sáng
  → giảm màu
  → vector hóa
  → chỉnh màu và path
  → kiểm tra chất lượng
  → xuất SVG/PDF/PNG
```

Tính năng phải chạy offline. API AI, tài khoản đám mây và GPU không phải yêu cầu bắt buộc.

---

## 2. Phạm vi phiên bản

### 2.1 MVP

MVP phải hỗ trợ:

- nhập PNG, JPG, WebP và TIFF;
- xử lý EXIF orientation và ICC đầu vào;
- crop vùng logo;
- hiệu chỉnh phối cảnh bằng bốn điểm;
- cân bằng ánh sáng cơ bản;
- tạo bảng màu từ 1–12 màu;
- vector hóa ảnh màu thành SVG;
- xem trước ảnh gốc và vector ở mức phóng đại lớn;
- đổi màu từng vùng;
- xóa path không mong muốn;
- điều chỉnh độ làm mượt và ngưỡng loại chi tiết nhỏ;
- lưu project để mở lại;
- xuất SVG và PNG nền trong suốt;
- báo điểm chất lượng và cảnh báo ảnh không phù hợp.

### 2.2 Phiên bản 1

Sau khi MVP đạt tiêu chí nghiệm thu:

- xuất PDF vector theo kích thước vật lý;
- chọn kích thước đầu ra bằng mm;
- kiểm tra profile màu và cảnh báo gamut;
- chỉnh node Bézier cơ bản;
- gộp/tách vùng đơn giản;
- undo/redo;
- OCR tiếng Việt và tiếng Anh để gợi ý nội dung chữ;
- kiểm tra độ phức tạp path;
- bộ preset theo loại logo.

### 2.3 Ngoài phạm vi ban đầu

Không cam kết tự động phục hồi chính xác:

- logo bị che khuất hoặc mất phần lớn hình học;
- logo bị rách, bong hoặc chỉ còn rất ít pixel;
- hình thêu cần tái dựng cấu trúc sợi;
- bề mặt vải nhăn mạnh hoặc biến dạng phi tuyến;
- logo ảnh chụp, tram hoặc chuyển sắc phức tạp;
- font thương hiệu chính xác chỉ từ ảnh;
- artwork nhiều lớp kiểu Illustrator.

Các trường hợp trên phải được phát hiện và cảnh báo, không được trả kết quả với thông điệp gây hiểu
nhầm rằng logo đã được khôi phục chính xác.

---

## 3. Quyết định kỹ thuật

| Hạng mục | Quyết định |
|---|---|
| Vectorizer | Spike và benchmark VTracer trước; chỉ tích hợp sau khi qua cổng chất lượng |
| License | Ưu tiên MIT/Apache-2.0; không kích hoạt Potrace GPL trong bản thương mại |
| Cách chạy | CPU/offline là mặc định |
| GPU | Tùy chọn cho các bước nâng cao sau MVP |
| Định dạng trung tâm | SVG + project JSON |
| Đơn vị vật lý | mm |
| OCR | Chỉ gợi ý nội dung chữ, không tự thay outline bằng font đoán |
| Upscale AI | Tùy chọn, tắt mặc định vì có thể làm sai nét chữ |
| Tách nền AI | Tùy chọn, không coi kết quả là mask logo tuyệt đối |
| UI | Workspace riêng, không mở rộng preview raster dùng chung |
| Hiệu năng | Chỉ giảm chất lượng/worker theo RAM máy yếu; máy từ 16 GB giữ đầy đủ năng lực |

Nguồn vectorizer tham khảo:

- VTracer: <https://github.com/visioncortex/vtracer>
- SVGcode: <https://github.com/tomayac/SVGcode>
- Inkscape trace workflow: <https://gitlab.com/inkscape/inkscape>
- LIVE Layer-wise Image Vectorization:  
  <https://github.com/Picsart-AI-Research/LIVE-Layerwise-Image-Vectorization>

---

## 4. Kiến trúc mục tiêu

### 4.1 Luồng dữ liệu

```text
LogoRebuildWorkspace
  → logoRebuildStore
  → authenticatedFetch multipart
  → /api/logo-rebuild/preview
  → heavy_job_scheduler
  → chuẩn hóa ảnh
  → sửa phối cảnh
  → cân bằng ánh sáng
  → lượng tử hóa màu
  → VTracer adapter
  → hậu xử lý hình học
  → báo cáo chất lượng
  → SVG + preview PNG + manifest
  → workspace chỉnh sửa
  → /api/logo-rebuild/export
  → SVG/PDF/PNG/project JSON
```

### 4.2 Frontend

Thư mục đề xuất:

```text
desktop/src/components/logo-rebuild/
  LogoRebuildWorkspace.tsx
  LogoRebuildToolbar.tsx
  LogoRebuildPreview.tsx
  LogoRebuildVectorCanvas.tsx
  LogoRebuildColorPanel.tsx
  LogoRebuildQualityPanel.tsx
  LogoRebuildExportDialog.tsx
  logoRebuildStore.ts
  types.ts
  api.ts
```

Workspace gồm bốn khu vực:

1. Ảnh gốc: crop, zoom, pan và bốn điểm phối cảnh.
2. Preview vector: so sánh trước/sau, nền caro và mức phóng đại 100–800%.
3. Bảng điều chỉnh: palette, độ mượt, despeckle và độ phức tạp.
4. Kiểm tra chất lượng: điểm tổng, cảnh báo và khuyến nghị xử lý.

Không sửa `imageBatch/store.ts` thành kiểu dữ liệu tổng hợp raster/vector. Chỉ tái sử dụng helper nhập
file và hành vi zoom/pan nếu phù hợp.

### 4.3 Backend

Thư mục đề xuất:

```text
backend/app/api/routes/logo_rebuild.py
backend/app/schemas/logo_rebuild.py
backend/app/workers/logo_rebuild/
  preprocess.py
  perspective.py
  illumination.py
  palette.py
  vectorize.py
  postprocess.py
  quality.py
  manifest.py
```

Trách nhiệm:

- route chỉ xác thực, parse tham số, lên lịch job và trả kết quả;
- pipeline ảnh nằm trong worker/core;
- mọi tham số phải có schema và giới hạn hợp lệ;
- lỗi nghiệp vụ trả thông báo tiếng Việt có hành động khắc phục;
- không trả stacktrace cho người dùng;
- tác vụ nặng đi qua `heavy_job_scheduler`;
- profile chất lượng chỉ giảm trên máy RAM thấp theo quy tắc chung của PrynX.

### 4.4 Rust/native

Chưa thêm Rust trong lô đầu. Sau spike, nếu VTracer đạt:

- pin phiên bản crate;
- tạo adapter nhận bitmap đã chuẩn hóa;
- trả SVG hoặc mô hình path trung gian;
- thêm license vào `THIRD_PARTY_NOTICES.md`;
- kiểm tra đường build dev bằng maturin;
- kiểm tra đường build production bằng Nuitka + Tauri.

---

## 5. Hợp đồng dữ liệu

### 5.1 Project JSON

```json
{
  "version": 1,
  "source": {
    "width_px": 2400,
    "height_px": 1800,
    "color_space": "sRGB"
  },
  "transform": {
    "crop": [120, 80, 2100, 1500],
    "perspective_points": null
  },
  "settings": {
    "color_count": 6,
    "smoothing": 0.5,
    "despeckle_area_px": 8,
    "illumination_correction": true
  },
  "palette": [],
  "layers": [],
  "text_candidates": [],
  "quality": {},
  "warnings": []
}
```

Mọi version mới phải có migration hoặc báo không tương thích rõ ràng.

### 5.2 API preview

```http
POST /api/logo-rebuild/preview
Content-Type: multipart/form-data
```

Đầu vào:

- file;
- crop;
- bốn điểm phối cảnh nếu có;
- số màu;
- smoothing;
- despeckle;
- tùy chọn cân bằng ánh sáng;
- preset chất lượng.

Đầu ra:

```json
{
  "job_id": "uuid",
  "status": "completed",
  "svg": "<svg>...</svg>",
  "preview_url": "/api/results/...",
  "palette": [
    {"id": "color_1", "hex": "#E53935", "area_ratio": 0.42}
  ],
  "quality": {
    "score": 0.86,
    "blur_score": 0.91,
    "edge_confidence": 0.84,
    "path_complexity": 0.38
  },
  "warnings": []
}
```

### 5.3 API export

```http
POST /api/logo-rebuild/export
Content-Type: application/json
```

Đầu vào:

- project;
- định dạng;
- chiều rộng/chiều cao mm;
- nền;
- DPI đối với raster;
- profile màu nếu hỗ trợ.

Đầu ra:

```json
{
  "files": [
    {"format": "svg", "path": "logo.svg"},
    {"format": "png", "path": "logo.png"}
  ],
  "physical_size_mm": {
    "width": 180,
    "height": 120
  }
}
```

---

## 6. Pipeline xử lý ảnh

### Bước 1 — Chuẩn hóa đầu vào

- kiểm tra MIME và chữ ký file;
- giới hạn kích thước hợp lý theo RAM;
- xoay theo EXIF;
- chuyển ICC có kiểm soát về sRGB;
- giữ alpha nếu có;
- tính điểm blur và độ phân giải hữu dụng.

### Bước 2 — Chọn vùng và sửa phối cảnh

- crop thủ công;
- bốn điểm phối cảnh;
- lưu ma trận biến đổi vào project;
- cho phép chỉnh lại mà không mất ảnh gốc.

MVP chỉ dùng homography. Mesh warp cho nếp nhăn phi tuyến thuộc R&D sau v1.

### Bước 3 — Cân bằng nền và ánh sáng

- ước lượng trường sáng tần số thấp;
- cân bằng kênh sáng;
- lọc texture có kiểm soát;
- không làm mờ đường biên chữ;
- luôn cho xem preview trước khi áp dụng.

### Bước 4 — Lượng tử hóa màu

- đề xuất số màu tự động;
- cho phép chọn 1–12 màu;
- gộp màu gần nhau theo khoảng cách màu;
- giữ bảng màu có thể chỉnh sửa;
- cảnh báo nếu gradient bị ép thành quá ít màu.

### Bước 5 — Vector hóa

- chuyển bitmap đã chuẩn hóa sang VTracer;
- ánh xạ cấu hình UI sang tham số engine;
- lưu cấu hình đầy đủ vào project;
- đảm bảo cùng input/cấu hình cho kết quả tái lập.

### Bước 6 — Hậu xử lý

- bỏ path có diện tích quá nhỏ;
- làm sạch path trùng;
- phát hiện path rỗng hoặc không hợp lệ;
- giảm node trong sai số cho phép;
- không tự gộp các vùng khác màu;
- giữ thứ tự layer ổn định.

### Bước 7 — OCR gợi ý

- OCR vùng có khả năng là chữ;
- trả text, bounding box và confidence;
- không tự thay outline;
- cảnh báo người dùng đối chiếu tên thương hiệu.

### Bước 8 — Kiểm tra chất lượng

Quality score gồm:

- độ nét đầu vào;
- độ tin cậy đường biên;
- mức ổn định palette;
- độ phức tạp path;
- tỷ lệ vùng quá nhỏ;
- sai khác raster giữa ảnh đã xử lý và SVG render lại.

Điểm số chỉ để hướng dẫn, không phải chứng nhận artwork giống bản gốc.

---

## 7. Kế hoạch triển khai theo giai đoạn

### Giai đoạn 0 — Corpus và tiêu chí chuẩn

**Thời gian:** 2–3 ngày công  
**Mục tiêu:** có dữ liệu đủ để đo thay vì đánh giá cảm tính.

Công việc:

- thu thập 30–50 ảnh ban đầu;
- chia nhóm phẳng, nghiêng, nền vải, chữ, nhiều màu và thất bại;
- lưu vector gốc nếu có;
- xác định kích thước logo thật;
- lập bảng metadata;
- tạo script/bộ lệnh render SVG về PNG để so sánh;
- chốt tiêu chí đạt.

Đầu ra:

- corpus có cấu trúc;
- bảng ground truth;
- danh sách ảnh không được dùng vì bản quyền/không rõ nguồn;
- baseline chất lượng.

**Cổng duyệt G0:** corpus đại diện cho ảnh khách hàng thực tế.

### Giai đoạn 1 — Spike VTracer

**Thời gian:** 3–5 ngày công  
**Mục tiêu:** quyết định GO/NO-GO cho engine.

Công việc:

- thử CLI/Python/Rust theo khả năng đóng gói;
- chạy ma trận tham số 2/4/8/12 màu;
- đo thời gian, RAM, số path, số node và kích thước SVG;
- kiểm tra ảnh chữ nhỏ;
- kiểm tra build Windows;
- lập bảng so sánh cấu hình.

Tiêu chí qua cổng:

- logo 1–4 màu đạt tối thiểu 90% corpus mục tiêu;
- logo 5–12 màu đạt tối thiểu 75–80%;
- không làm biến dạng rõ ràng chữ còn nét;
- không tạo lượng path rác không thể chỉnh;
- thời gian preview chấp nhận được trên CPU;
- license và cách đóng gói hợp lệ.

Đầu ra:

- báo cáo spike;
- preset mặc định;
- quyết định tích hợp Rust/Python;
- danh sách trường hợp phải từ chối.

**Cổng duyệt G1:** chỉ bắt đầu UI/backend sản phẩm khi engine đạt.

### Giai đoạn 2 — Backend MVP

**Thời gian:** 5–7 ngày công

Công việc:

- schema project và request/response;
- route preview;
- chuẩn hóa ảnh;
- perspective transform;
- palette;
- adapter VTracer;
- hậu xử lý;
- quality report;
- test API và test file lỗi.

Đầu ra:

- API preview ổn định;
- SVG có thể mở bằng browser/Inkscape;
- lỗi được phân loại;
- log không chứa dữ liệu ảnh nhạy cảm.

**Cổng duyệt G2:** backend chạy hết corpus và không crash.

### Giai đoạn 3 — Workspace frontend

**Thời gian:** 5–7 ngày công

Công việc:

- đăng ký tool;
- store riêng;
- nhập file;
- crop và bốn điểm phối cảnh;
- preview SVG;
- so sánh trước/sau;
- palette editor;
- smoothing/despeckle controls;
- quality panel;
- trạng thái chạy, lỗi và hủy job.

Đầu ra:

- workflow hoàn chỉnh từ nhập ảnh đến preview;
- không ảnh hưởng Tách nền/Upscale;
- text UI đi qua i18n;
- không hardcode px làm kích thước vật lý.

**Cổng duyệt G3:** người dùng không kỹ thuật hoàn thành workflow mà không cần hướng dẫn code.

### Giai đoạn 4 — Lưu project và export

**Thời gian:** 3–5 ngày công

Công việc:

- project JSON;
- mở lại project;
- xuất SVG;
- xuất PNG trong suốt;
- manifest nhiều artifact;
- kiểm tra kích thước mm;
- PDF vector cho v1;
- cập nhật third-party notices.

Đầu ra:

- project mở lại không thay đổi hình học;
- SVG/PDF có kích thước vật lý đúng;
- file mở được bằng phần mềm phổ biến.

**Cổng duyệt G4:** file xuất dùng được trong quy trình tiền kỳ in thử.

### Giai đoạn 5 — Ổn định và nghiệm thu

**Thời gian:** 3–5 ngày công

Công việc:

- regression test;
- golden outputs;
- kiểm thử máy RAM thấp và máy mạnh;
- kiểm thử ảnh rất lớn;
- kiểm thử hủy job;
- kiểm thử build production;
- hướng dẫn sử dụng;
- danh sách hạn chế đã biết.

**Cổng duyệt G5:** đạt tiêu chí MVP và không có P0/P1 mở.

---

## 8. Chia lô sửa mã

Mỗi lô tối đa 5 file, verify xong mới sang lô kế tiếp.

### Lô A — Schema và feature skeleton

- schema backend;
- route skeleton;
- mount router;
- entitlement backend;
- entitlement frontend.

Verify:

- import/compile backend;
- test quyền tính năng;
- route trả lỗi có cấu trúc.

### Lô B — Tiền xử lý ảnh

- preprocess;
- perspective;
- illumination;
- test preprocess;
- fixture ảnh.

Verify:

- EXIF;
- ICC;
- ảnh alpha;
- crop;
- homography;
- ảnh hỏng.

### Lô C — Vectorizer và quality

- VTracer adapter;
- palette;
- postprocess;
- quality;
- test engine.

Verify:

- deterministic output;
- SVG hợp lệ;
- path không NaN;
- benchmark RAM/thời gian.

### Lô D — Workspace shell

- tool registry;
- router mapping;
- workspace;
- store;
- API client.

Verify:

- typecheck;
- điều hướng;
- loading/error/cancel;
- không ảnh hưởng tool hiện có.

### Lô E — Preview và controls

- vector canvas;
- crop/perspective overlay;
- color panel;
- quality panel;
- i18n.

Verify:

- zoom/pan;
- preview 800%;
- đổi palette;
- accessibility cơ bản.

### Lô F — Export

- export API;
- manifest;
- SVG emitter;
- PNG renderer;
- project serializer.

Verify:

- round-trip project;
- kích thước mm;
- tên file;
- mở bằng công cụ ngoài.

### Lô G — PDF và hoàn thiện v1

- PDF vector;
- ICC options;
- OCR suggestions;
- editor cơ bản;
- test/golden tương ứng.

---

## 9. Ma trận kiểm thử

| Nhóm | Ca kiểm thử |
|---|---|
| File | PNG/JPG/WebP/TIFF, alpha, EXIF xoay, ICC lạ, file hỏng |
| Hình học | Crop, bốn điểm, góc rất xiên, vùng chọn ngoài ảnh |
| Màu | 1/2/4/8/12 màu, màu gần nhau, gradient, nền trong suốt |
| Chữ | Chữ lớn, chữ nhỏ, serif, sans-serif, chữ Việt có dấu |
| Vải | Cotton phẳng, bóng nhẹ, texture rõ, nhăn nhẹ |
| Vector | Path rỗng, path nhỏ, nhiều node, SVG lớn |
| Export | SVG, PNG, project JSON, PDF v1, kích thước mm |
| Hiệu năng | <8 GB, 8–15 GB, ≥16 GB RAM |
| Hủy lỗi | Hủy job, timeout, thiếu engine, hết RAM có kiểm soát |
| Tương thích | Browser preview, Inkscape, Illustrator/PDF viewer nếu có |

Golden output chỉ cập nhật khi thay đổi thuật toán là chủ đích và đã soi diff.

---

## 10. Tiêu chí nghiệm thu MVP

### Chức năng

- hoàn thành luồng nhập ảnh → preview → đổi màu → xuất SVG;
- project JSON mở lại cho kết quả tương đương;
- SVG phóng to không vỡ;
- PNG xuất nền trong suốt;
- bốn điểm phối cảnh hoạt động ổn định;
- cảnh báo rõ khi ảnh không phù hợp.

### Chất lượng

- nhóm logo 1–4 màu đạt tối thiểu 90% corpus mục tiêu;
- nhóm 5–12 màu đạt tối thiểu 75–80%;
- không tự thay chữ outline bằng font đoán;
- không có path NaN hoặc SVG không parse được;
- sai khác kích thước vật lý dưới ngưỡng được chốt trong spike.

### Hiệu năng

- preview không khóa UI;
- tác vụ nặng đi qua scheduler;
- có thể hủy;
- máy RAM ≥16 GB không bị hard-cap chất lượng/worker;
- máy RAM thấp được giảm tải có cảnh báo phù hợp.

### Pháp lý và đóng gói

- không kích hoạt Potrace GPL trong sản phẩm;
- mọi dependency mới có license được ghi nhận;
- build dev và production chứa đúng artifact cần thiết;
- không bắt buộc API AI hoặc gửi ảnh ra ngoài.

---

## 11. Rủi ro và biện pháp

| Rủi ro | Mức | Biện pháp |
|---|---:|---|
| Nếp nhăn làm sai hình học | Cao | Giới hạn MVP, cảnh báo, R&D mesh warp sau |
| Texture vải biến thành path | Cao | Lọc texture, despeckle, quality score |
| Chữ nhỏ bị méo | Cao | Preview phóng đại, OCR cảnh báo, không tự thay font |
| SVG quá nhiều node | Trung bình | Simplify có sai số và cảnh báo complexity |
| Màu sai do ánh sáng | Trung bình | Cân bằng sáng + palette chỉnh tay |
| AI upscale bịa nét | Trung bình | Tắt mặc định, chỉ chạy khi người dùng chọn |
| License dependency | Cao | Chốt MIT/Apache, audit trước tích hợp |
| Build Rust/Nuitka phức tạp | Trung bình | Spike packaging trước khi viết UI lớn |
| Tính năng quá giống editor đồ họa | Cao | Giữ editor MVP ở mức sửa cần thiết cho in |

---

## 12. Yêu cầu phần cứng

### Tối thiểu

- CPU 4 nhân;
- RAM 8 GB;
- còn trống 2 GB;
- không yêu cầu GPU.

Máy dưới 8 GB:

- giảm kích thước preview;
- giới hạn số job đồng thời;
- cảnh báo khi ảnh quá lớn;
- không tự bật upscale AI.

### Khuyến nghị

- CPU 6–8 nhân;
- RAM 16 GB;
- SSD;
- GPU không bắt buộc.

Máy từ 16 GB trở lên phải chạy đầy đủ chất lượng, không đặt hard-cap vô điều kiện.

---

## 13. Ước lượng

| Mốc | Thời gian |
|---|---:|
| Corpus + spike | 5–8 ngày công |
| Backend MVP | 5–7 ngày công |
| Workspace frontend | 5–7 ngày công |
| Export + project | 3–5 ngày công |
| Ổn định + nghiệm thu | 3–5 ngày công |
| Tổng MVP | 19–29 ngày công |
| V1 có PDF/ICC/editor tốt hơn | Tổng 23–35 ngày công |
| R&D sửa nhăn phi tuyến/font nâng cao | Thêm 15–30 ngày công |

Ước lượng cho một kỹ sư toàn thời gian, chưa tính thời gian chờ ảnh khách hàng và duyệt thủ công.

---

## 14. Mốc quyết định

1. **Duyệt kế hoạch:** xác nhận phạm vi MVP và tiêu chí corpus.
2. **Sau G0:** xác nhận bộ ảnh đủ đại diện.
3. **Sau G1:** quyết định GO/NO-GO với VTracer.
4. **Sau G2:** duyệt chất lượng engine trước khi đầu tư UI đầy đủ.
5. **Sau G3:** duyệt workflow với người dùng không kỹ thuật.
6. **Sau G4:** duyệt file in thử.
7. **Sau G5:** quyết định phát hành MVP hoặc giữ beta.

---

## 15. Bước tiếp theo sau khi duyệt

Chỉ triển khai hai việc đầu tiên:

1. tạo corpus 30–50 ảnh có phân nhóm và ground truth;
2. thực hiện spike VTracer, benchmark chất lượng, tốc độ, RAM, license và đóng gói.

Chưa viết workspace sản phẩm trước khi G1 đạt. Nếu VTracer không đạt, dừng để đánh giá engine thay thế
hoặc thu hẹp phạm vi thay vì tiếp tục xây UI trên một nền vector hóa chưa đủ chất lượng.
