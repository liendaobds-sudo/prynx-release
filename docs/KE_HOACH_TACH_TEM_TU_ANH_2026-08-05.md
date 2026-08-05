# Kế hoạch triển khai “Tách tem từ ảnh AI” — 2026-08-05

> Trạng thái: **KẾ HOẠCH — CHƯA TRIỂN KHAI**.
> Chỉ bắt đầu sửa mã sau khi chủ dự án duyệt kế hoạch này.

## 1. Kết luận kiến trúc

Tính năng nằm trong công cụ **Bù xén - Tạo đường cắt**, dưới chế độ mới
**Ảnh AI nhiều tem**. Không đưa vào Edit PDF và không tạo một trình sửa vector tổng quát.

Pipeline đề xuất:

```text
JPG/PNG phẳng
    ↓
BiRefNet-lite ONNX hiện có tạo mask gợi ý
    ↓
OpenCV: ước lượng nền → giữ viền trắng → loại bóng → tách từng tem
    ↓
Mask Quick Fix: Xóa bóng / Giữ lại / Gộp với tem
    ↓
Engine CutContour hiện có: offset mm → làm mượt Bézier → guard hình học
    ↓
PNG trong suốt từng tem / PDF nhiều trang / Mở trong Bình tem bế
```

MVP **không thêm model SAM, PyTorch hoặc dịch vụ cloud**. Lô 0 đã chứng minh
BiRefNet-lite là model phù hợp: nhận đúng 9/9 tem ở mọi ngưỡng thử 32–224; ISNet tách
sai thành 21–57 mảnh. Vì vậy BiRefNet-lite là mặc định, còn ISNet không được dùng để
tự động chốt đường cắt. Cả hai tiếp tục chạy bằng ONNX Runtime hiện có.

## 2. Bằng chứng từ code hiện tại

- Card `Bù xén - Tạo đường cắt` đã dùng quyền `prepress.cutline` và route vào
  `focusFeature: sticker`: `desktop/src/lib/toolRegistry.ts:329-338`.
- Panel hiện tại được gắn ở `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx:253`.
- Ảnh mở trong workspace hiện bị chuyển ngay thành PDF:
  `desktop/src/components/ImpositionTab.tsx:454` và `:1284`. Vì vậy luồng mới phải giữ
  ảnh gốc riêng trong store của chế độ tách tem, không lấy lại raster từ PDF đã chuyển.
- PrynX đã có endpoint tách nền ở `backend/app/api/routes/pdf_tools.py:1608-1779`,
  gồm kiểm bộ nhớ, ICC/EXIF, heavy-job scheduler, GPU→CPU fallback và warmup.
- ISNet chạy ONNX tại `backend/app/workers/isnet_engine.py:103`; BiRefNet tại
  `backend/app/workers/birefnet_engine.py:124`.
- `onnxruntime==1.24.4` đã được pin trong `backend/requirements.txt:79`.
- Model ISNet đã được kiểm hash và đưa vào bản đóng gói tại
  `build_production.ps1:761-783`, nên MVP không làm tăng model/runtime mới.
- Engine CutContour sản xuất hiện có là `StickerEngine.process_pdf()` tại
  `backend/app/workers/sticker_engine.py:2844-2852`; bản sửa Alpha hiện đã có guard
  topology, khoảng cách biên và Bézier.
- Tách nền và tạo đường cắt là hai quyền Pro khác nhau. Endpoint mới sẽ dùng
  **`prepress.cutline`**, vì đây là một chế độ của công cụ đường cắt; không bắt người dùng
  phải đồng thời có entitlement `util.bgremover` chỉ vì tái sử dụng engine nội bộ.

## 3. Phạm vi MVP

### Có trong MVP

1. Nhận một ảnh JPG/PNG chứa nhiều tem không chồng lên nhau.
2. Tự phát hiện số lượng tem và đánh số từng tem.
3. Giữ phần artwork và viền trắng có chủ đích.
4. Loại nền và vùng bóng đổ/mockup bên ngoài viền tem.
5. Gộp chi tiết rời gần tem chính như tia sét, ngôi sao hoặc icon trang trí.
6. Ba thao tác sửa nhanh:
   - **Xóa bóng**;
   - **Giữ lại**;
   - **Gộp với tem**.
7. Undo/redo các thao tác mask.
8. Chọn kích thước vật lý bằng DPI hoặc chiều rộng toàn ảnh; không âm thầm coi pixel là mm.
9. Chọn offset đường cắt, bleed và mức làm mượt theo mm.
10. Xuất:
    - ZIP PNG trong suốt, mỗi tem một file;
    - PDF nhiều trang, mỗi tem một trang có CutContour;
    - mở PDF kết quả trực tiếp trong **Bình tem bế**.

### Chưa làm trong MVP

- Không xử lý chắc chắn các tem chồng lấn lên nhau hoặc bị che khuất.
- Không kéo node Bézier bằng tay.
- Không biến Mask Quick Fix thành Edit PDF thứ hai.
- Không chạy AI cloud và không gửi ảnh khách hàng ra ngoài máy.
- Chưa xử lý hàng loạt nhiều ảnh đầu vào trong cùng một lượt.

## 4. Engine nhận diện từng tem

### 4.1 Mask gợi ý từ AI

Mặc định gọi BiRefNet-lite hiện có để lấy alpha gợi ý. Đây chỉ là một tín hiệu, không
được dùng thẳng làm đường cắt vì model tách nền phổ thông có thể giữ bóng hoặc ăn mất
viền trắng. ISNet chỉ được giữ làm fallback có cảnh báo, không phải chế độ production
khuyến nghị cho ảnh nhiều tem.

### 4.2 Phân tích nền và bóng bằng OpenCV

Engine mới dự kiến đặt tại `backend/app/workers/sticker_sheet_engine.py`:

1. Ước lượng màu/độ sáng nền từ các dải biên ảnh trong không gian Lab.
2. Tạo **lõi artwork** từ màu, độ tương phản và cạnh mạnh.
3. Khôi phục **vỏ viền trắng** bao quanh lõi, có giới hạn khoảng cách và biên kín.
4. Xác định **bóng** là vùng ít bão hòa, chuyển sắc mềm, nằm ngoài vỏ tem và còn nối với nền.
5. Dùng connected-components để tạo instance; dùng watershed chỉ khi hai cụm chạm nhau.
6. Gán chi tiết rời cho tem gần nhất bằng khoảng cách, kích thước và hướng tương đối.
7. Sinh `confidence_map`; chỉ những vùng mơ hồ mới được tô cảnh báo để người dùng kiểm tra.

### 4.3 Chuyển mask thành CutContour

Mask cuối cùng được xử lý ở độ phân giải gốc, sau đó đi qua engine Alpha hiện có:

- offset và bleed dùng mm vật lý;
- giữ topology/lỗ;
- không self-intersection;
- fitted cubic Bézier có guard;
- fallback an toàn nếu fitter không đạt ngân sách sai lệch.

Không viết lại thuật toán CutContour trong engine tách tem.

## 5. Thiết kế UI

### 5.1 Vị trí

Giữ `activeDashboardTool = sticker`. Đầu panel **Bù xén - Tạo đường cắt** thêm lựa chọn:

- **PDF/PNG đã có biên** — hành vi hiện tại;
- **Ảnh AI nhiều tem** — workspace chuyên dụng mới.

Không thêm một card sản phẩm độc lập trong MVP. Sau này có thể thêm shortcut
“Tách tem từ ảnh” trên Home nhưng vẫn mở đúng `focusFeature: sticker` và chế độ này.

### 5.2 Mask Quick Fix

Workspace giữa màn hình hiển thị ảnh, mask màu và số thứ tự tem. Thanh công cụ chỉ gồm:

- Xóa bóng;
- Giữ lại;
- Gộp với tem;
- Hoàn tác / Làm lại;
- Điểm cần kiểm tra tiếp theo.

Không đưa pixel/mask lớn vào React state. Store chỉ giữ manifest, lựa chọn và danh sách
stroke/hint. Canvas/OffscreenCanvas giữ bitmap; Web Worker xử lý ROI sau `pointerup`.
Không gọi backend trong lúc rê chuột.

Mục tiêu tương tác:

- preview dài tối đa khoảng 2.000 px;
- pan/zoom/cọ đạt 60 FPS trên máy mục tiêu;
- cập nhật ROI sau nhả chuột ≤150 ms với ảnh mẫu;
- toàn bộ edit được lưu bằng tọa độ chuẩn hóa để áp lại lên ảnh gốc khi xuất.

## 6. Hợp đồng backend đề xuất

Tạo router riêng `backend/app/api/routes/sticker_sheet.py`, đăng ký rõ trong `main.py`:

### `POST /api/sticker-sheet/analyze`

Đầu vào: JPG/PNG, model, ngưỡng bóng và tùy chọn ghép chi tiết.
Đầu ra: `session_id`, kích thước ảnh, preview, label-map 8-bit, uncertainty-map và danh sách
instance (`id`, bbox, diện tích, confidence, nhóm gợi ý).

### `POST /api/sticker-sheet/{session_id}/export`

Đầu vào: danh sách stroke/hint chuẩn hóa, ánh xạ gộp tem, DPI/kích thước vật lý,
offset, bleed và loại đầu ra. Backend áp edit ở độ phân giải gốc rồi xuất artifact.

### `DELETE /api/sticker-sheet/{session_id}`

Dọn session khi đóng tab. Session đặt dưới `RESULTS_DIR`, TTL 30 phút và dọn lười ở mỗi
request; không giữ ảnh gốc/mask full-resolution lâu dài trong RAM.

Hai tác vụ analyze/export chạy qua `run_heavy_in_threadpool`. Không thêm hard-cap cho máy
≥16 GB; DirectML tiếp tục dùng lock theo session ONNX hiện có. Không có lời gọi PDFium
trong luồng phân tích ảnh. Khi tạo/kiểm PDF thì mọi lời gọi PDFium trong thread phải giữ
`pdfium_guard()`.

## 7. Dữ liệu và kích thước vật lý

Ảnh JPG AI thường không có DPI đáng tin cậy. Trước khi xuất PDF, UI bắt buộc hiển thị:

- kích thước pixel nguồn;
- DPI đọc được, nếu có;
- kích thước vật lý suy ra;
- trường sửa DPI hoặc chiều rộng toàn ảnh.

Nếu không có metadata, có thể gợi ý 300 DPI nhưng phải ghi rõ đây là giá trị giả định.
Mọi offset/bleed/CutContour tiếp tục dùng mm; px chỉ tồn tại trong tầng mask/render.

## 8. Chia lô triển khai

Mỗi lô tối đa 5 file và phải verify xong mới sang lô sau.

### Lô 0 — Prototype và corpus, chưa nối UI — ĐẠT ẢNH MẪU

- Dùng ảnh mẫu cục bộ `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`.
- BiRefNet-lite CPU: **12,4077 giây**, nhận đúng **9/9** ở mọi ngưỡng 32–224.
- ISNet CPU: **2,4771 giây** nhưng tách sai thành **21–57** mảnh; bị loại khỏi mặc định.
- Artifact: `tmp/research/sticker_sheet_baseline/` (cục bộ, không commit ảnh khách hàng).
- Mở rộng lên tối thiểu 20 ảnh mockup; ảnh khách hàng không commit vào Git.
- Chốt thuật toán/threshold bằng số đo trước khi viết API production.

### Lô 1 — Engine phân tích ảnh

Dự kiến:

- `backend/app/workers/sticker_sheet_engine.py`;
- `backend/tests/test_sticker_sheet_engine.py`;
- fixture tổng hợp nhỏ không có dữ liệu khách hàng.

Verify: instance count, topology, shadow leakage, white-border retention, determinism.

### Lô 2 — Session và API

Dự kiến tối đa 5 file:

- `backend/app/core/sticker_sheet_session.py`;
- `backend/app/schemas/sticker_sheet.py`;
- `backend/app/api/routes/sticker_sheet.py`;
- `backend/app/main.py`;
- `backend/tests/test_sticker_sheet_api.py`.

Verify: upload/path security, entitlement, TTL, hủy job, thiếu model, RAM warning.

### Lô 3 — Store, Canvas và Web Worker

Dự kiến tối đa 5 file:

- store per-tab của tách tem;
- Mask Quick Fix workspace;
- Web Worker xử lý ROI;
- test store;
- test worker/hit-test.

Verify: không chứa bitmap trong React state, cleanup object URL/worker, undo/redo,
tab nền không nhận sự kiện.

### Lô 4 — Gắn vào Bù xén - Tạo đường cắt

Tách thành hai commit nhỏ nếu test làm vượt 5 file:

- thêm lựa chọn chế độ trong `StickerTool`;
- truyền `tabId` qua `PreprocessingRouter`;
- mount workspace chuyên dụng trong `ImpositionTab`;
- cập nhật routing policy nếu cần;
- khóa regression mở tool/picker/drop/tab nền.

### Lô 5 — Export và tái sử dụng CutContour

- áp edit full-resolution;
- xuất PNG từng tem;
- dựng PDF nhiều trang giữ alpha/SMask;
- gọi engine Alpha hiện có để thêm CutContour;
- nối hành động “Mở trong Bình tem bế”.

Verify bằng cách parse content stream PDF thật, không chỉ nhìn preview.

### Lô 6 — i18n, hướng dẫn và đóng gói nội bộ

- text UI vào `desktop/src/i18n/vi.json` và `en.json`;
- cập nhật trợ giúp công cụ;
- chạy typecheck/vitest/pytest/lint phạm vi;
- chạy runtime trên app thật;
- build Nuitka + installer **nội bộ** để kiểm tra ONNX/model/module mới.

Không tạo tag/release và không tải installer lên GitHub trước khi người dùng nghiệm thu.

## 9. Tiêu chí nghiệm thu

### Chất lượng

- Ảnh mẫu phải nhận đúng **9/9 tem**.
- Không để bóng mockup trở thành đường cắt nhìn thấy rõ ở kích thước in.
- Không ăn mất viền trắng liên tục quanh tem.
- Chi tiết rời được gán đúng hoặc được đánh dấu “cần kiểm tra”, không tự mất im lặng.
- CutContour không self-intersection, không đổi topology ngoài sửa chủ đích.
- Kích thước PDF/PNG khớp DPI hoặc kích thước mm người dùng đã xác nhận.

### Hiệu năng

- Không có hard-cap vô điều kiện trên máy ≥16 GB.
- Ảnh mẫu sau warmup: mục tiêu analyze ≤3 giây với GPU, ≤8 giây với CPU hiện đại.
- Corpus ảnh tới 12 MP: mục tiêu P90 ≤10 giây GPU, ≤30 giây CPU.
- Cọ/pan/zoom không gọi backend và không làm React rerender theo từng pixel.

### Kiểm thử cuối

1. Backend unit/integration/golden đạt.
2. Frontend typecheck + vitest liên quan đạt trên Windows.
3. Runtime thật: nạp ảnh mẫu → 9 tem → sửa một vùng bóng → xuất PDF.
4. Mở PDF trong Bình tem bế, kiểm kích thước và nhận diện đủ từng CutContour.
5. Build nội bộ Nuitka/Tauri và lặp lại smoke trên bản cài đặt.

## 10. Rủi ro chính và cách khóa

| Rủi ro | Cách khóa |
|---|---|
| AI ăn mất viền trắng | AI chỉ làm gợi ý; OpenCV khôi phục vỏ trắng và có công cụ Giữ lại |
| Bóng dính vào tem | phân loại shadow band + uncertainty-map + Xóa bóng theo ROI |
| Chi tiết rời bị thành tem riêng | graph gán theo khoảng cách/kích thước; vùng mơ hồ bắt người dùng xác nhận |
| Edit chậm như Edit PDF | Canvas bitmap + Web Worker + ROI; không SVG hàng nghìn node, không backend khi rê |
| Sai kích thước in | bắt xác nhận DPI/mm trước export; mm là đơn vị nguồn chân lý |
| Bản đóng gói thiếu model/DLL | tái dùng ISNet/ONNX self-test và chạy smoke trên installer nội bộ |
| Hồi quy Tách nền hiện tại | không sửa hành vi endpoint cũ ở MVP; test engine cũ vẫn bắt buộc chạy |

## 11. Chốt đề xuất để duyệt

Đề xuất bắt đầu bằng **Lô 0**. Chỉ khi ảnh mẫu đạt 9/9 và mask loại bóng đủ tốt mới
đầu tư UI/API production. Nếu prototype không đạt, dừng ở báo cáo số đo và điều chỉnh
thuật toán/model; không xây giao diện quanh một engine chưa chứng minh được chất lượng.
