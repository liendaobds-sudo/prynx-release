# BÁO CÁO AUDIT & KẾ HOẠCH HỢP NHẤT NHẬN DIỆN TEM — 2026-08-08

> Trạng thái: **KẾ HOẠCH — CHỜ DUYỆT, CHƯA SỬA PRODUCTION**.

## 1. Mục tiêu sản phẩm

Người dùng chỉ chọn một đầu vào thuộc nhóm PDF hoặc ảnh in. Ứng dụng tự xác định
nguồn biên phù hợp, tự biết có một hay nhiều tem và cuối cùng đưa mọi trường hợp
vào cùng một engine bù xén/CutContour.

Không còn yêu cầu người dùng chọn trước:

- “PDF/PNG đã có biên”;
- “Ảnh AI nhiều tem”;
- một tem hay nhiều tem;
- dùng Alpha, khử nền thường hay AI.

Những khái niệm trên trở thành chiến lược nội bộ của bộ nhận diện, không phải lựa
chọn nghiệp vụ trên giao diện.

## 2. Quyết định UX bắt buộc

### 2.1 Không tự quét sau khi chọn file

Sau khi chọn file, ứng dụng chỉ:

1. giữ file nguồn;
2. hiện preview nguyên bản;
3. đọc nhẹ loại file, DPI, Alpha/tài nguyên PDF và CutContour có sẵn;
4. đề xuất phương pháp nhận diện nhưng chưa vẽ hoặc áp đường biên.

BiRefNet, khử nền, connected-components và sinh đường cắt chỉ chạy khi người dùng
bấm **Nhận diện tem**. Không warmup model khi chỉ mở panel.

### 2.2 Kết quả nhận diện chưa phải kết quả đường cắt

Sau nhận diện, giao diện hiện overlay mask và số tem. Người dùng có thể:

- Xóa vùng thừa/bóng;
- Giữ lại chi tiết;
- Gộp vùng với tem;
- Hoàn tác/làm lại;
- chọn **Nhận diện lại** nếu muốn ép chạy phương pháp khác ở phần nâng cao.

Chỉ khi bấm **Xác nhận vùng tem**, mask mới trở thành đầu vào cho bảng Offset,
bù xén, góc, đặc ruột, màu bù xén và xuất CutContour.

## 3. Bằng chứng từ code hiện tại

| Mã | Mức | Bằng chứng | Kết luận |
|---|---|---|---|
| §UNIFIED.1 | P1 | `StickerCutlineTool.tsx:40-46` | Effect tự gọi `actions.analyze()` khi tab AI nhận `sourceImageFile`; đây là nguyên nhân “chưa làm gì đã quét biên”. |
| §UNIFIED.2 | P1 | `StickerSheetPanel.tsx:62-64` | Chọn file trong panel cũng gọi analyze ngay, không có trạng thái chờ xác nhận. |
| §UNIFIED.3 | P1 | `StickerSheetPanel.tsx:40-45` | Model AI được warmup ngay khi panel mount, dù người dùng chưa bấm nhận diện. |
| §UNIFIED.4 | P1 | `stickerSheetStore.ts:13,40,142` | Frontend lưu `mode = existing | ai-sheet`; state đang mô tả cách xử lý kỹ thuật thay vì mục tiêu người dùng. |
| §UNIFIED.5 | P1 | `StickerCutlineTool.tsx:98-106` | Hai mode mount hai panel khác nhau, tạo hai UX và hai vòng đời riêng. |
| §UNIFIED.6 | P1 | `StickerTool.tsx:255-304` và `stickerSheetStore.ts:96-102` | Thiết lập đầu ra bị chia đôi: luồng thường có đầy đủ góc/đặc ruột/màu/crop, luồng AI chỉ có DPI/offset/bleed. |
| §UNIFIED.7 | P1 | `sticker_sheet_export.py:266-288` | Export AI đã gọi chung `StickerEngine`, nhưng hardcode `alpha/preserve/fill_holes/contour`; UI chung chưa truyền được đầy đủ ý định. |
| §UNIFIED.8 | P1 | `sticker_sheet.py:43,65,123` | API nhận diện chỉ nhận ảnh raster và từ chối PDF, trái mục tiêu “một đầu vào”. |
| §UNIFIED.9 | P2 | `StickerCutlineTool.tsx:56` | Sau export AI, code đổi mode về `existing`; session mask và thiết lập không còn một vòng đời thống nhất. |
| §UNIFIED.10 | P2 | `StickerTool.tsx:436` và `stickerSheetApi.ts:100` | Hai frontend API đi hai endpoint riêng, khiến cùng một kết quả CutContour có hai hợp đồng và hai cách báo lỗi. |

## 4. Luồng người dùng đích

```text
Chọn/thả PDF, PNG, JPG, JPEG, WebP, BMP hoặc TIFF
        ↓
Preview nguyên bản + kiểm tra nhẹ nguồn
        ↓
Nút “Nhận diện tem”
        ↓
Ứng dụng tự chọn chiến lược, không hỏi mode
        ↓
Overlay mask + “Đã nhận diện N tem” + vùng cần kiểm tra
        ↓
Sửa mask (nếu cần)
        ↓
“Xác nhận vùng tem”
        ↓
Bảng thiết lập bù xén/CutContour chung
        ↓
Preview đường cắt → Xuất PDF/PNG
```

Phần nâng cao có thể cho phép **Nhận diện lại bằng AI**, **Dùng Alpha**, hoặc
**Dùng biên có sẵn**, nhưng mặc định không bắt người dùng hiểu các lựa chọn này.

## 5. Bộ chọn chiến lược tự động

Ứng dụng không chạy AI cưỡng bức. Thứ tự ưu tiên:

1. **CutContour hợp lệ có sẵn**
   - giữ vector gốc;
   - báo “Đã phát hiện đường cắt có sẵn”;
   - chỉ dựng lại khi người dùng chọn Nhận diện lại.
2. **PDF/vector có silhouette đáng tin cậy**
   - dùng geometry/vector;
   - raster mask chỉ phục vụ overlay/sửa nhanh, không thay vector nguồn im lặng.
3. **PNG/TIFF/WebP có Alpha sạch**
   - dùng Alpha làm mask chính;
   - connected-components tự quyết định một hay nhiều tem.
4. **Ảnh nền đồng nhất hoặc nền trắng đơn giản**
   - dùng thuật toán nền/màu deterministic hiện có;
   - không nạp model AI nếu confidence đủ cao.
5. **Ảnh mockup, bóng đổ, nền phức tạp hoặc confidence thấp**
   - chạy BiRefNet-lite;
   - hậu xử lý bóng/viền trắng;
   - trả uncertainty để người dùng kiểm tra.
6. **Không đủ bằng chứng**
   - không tự bịa đường cắt;
   - giữ preview gốc và yêu cầu người dùng quét Giữ lại/Xóa vùng hoặc Nhận diện lại.

Số lượng tem luôn được suy ra sau khi có mask/geometry; không tồn tại mode “một
tem” và “nhiều tem”.

## 6. State machine frontend thống nhất

Loại bỏ `StickerSourceMode`. Mỗi tab có một state machine:

| Trạng thái | Ý nghĩa | Hành động hợp lệ |
|---|---|---|
| `empty` | Chưa có nguồn | Chọn file |
| `source-ready` | Có preview gốc, chưa quét | Nhận diện tem, đổi file |
| `inspecting` | Đang kiểm tra nhẹ Alpha/vector/DPI | vẫn hiện preview gốc, có thể hủy |
| `detecting` | Đang chạy chiến lược nhận diện đã chọn tự động | Hủy |
| `mask-review` | Có mask gợi ý, chưa chốt | Sửa, undo/redo, nhận diện lại, xác nhận |
| `mask-confirmed` | Mask/geometry đã được người dùng chốt | chỉnh toàn bộ thiết lập bù xén |
| `exporting` | Đang tạo artifact | Hủy/đợi, không nhận event từ tab nền |
| `error` | Lỗi có thể khôi phục | thử lại, đổi file, sửa thủ công |

Các action chính:

- `selectSource(tabId, file)` — tuyệt đối không analyze;
- `inspectSource(tabId)` — kiểm tra nhẹ, không tạo overlay;
- `detectStickers(tabId, strategy='auto')` — thao tác có chủ ý;
- `confirmMask(tabId)`;
- `updateOutputSettings(tabId, settings)`;
- `exportResult(tabId, format)`;
- `resetSource` và `disposeTab` phải hủy request, thu hồi URL và đóng session.

## 7. Hợp đồng dữ liệu chuẩn hóa

Mọi chiến lược trả cùng một cấu trúc logic:

```text
StickerSourceSession
  source_kind: pdf | raster
  boundary_source: existing-cut | vector | alpha | simple-bg | ai | manual
  strategy_confidence: 0..1
  needs_review: boolean
  pages[]
    source_page
    instances[]
      id, bbox, area, confidence, uncertainty
    preview_asset
    labels_asset
    uncertainty_asset
    vector_geometry_ref?   # giữ vector thật khi có
  physical_size / dpi
  output_settings
```

Mask bitmap không đưa vào React state. Store chỉ giữ manifest, URL asset, edit chuẩn
hóa và settings; bitmap tiếp tục nằm trong canvas/session backend.

## 8. Chia lô triển khai

Mỗi lô tối đa 5 file và phải verify xong trước khi sang lô kế tiếp.

### Lô 1 — Dừng tự quét, tạo cổng xác nhận UX

Phạm vi dự kiến:

1. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`;
2. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`;
3. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`;
4. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`;
5. `desktop/src/components/preprocess-tools/stickerSheetStore.test.ts`.

Thay đổi:

- chọn file chỉ gọi `selectSource`;
- bỏ effect tự analyze;
- bỏ warmup khi mount;
- thêm `source-ready` và nút **Nhận diện tem**;
- AI warmup/analyze chỉ bắt đầu sau click;
- giữ mode cũ tạm thời để lô này không đổi backend.

Gate:

- chọn file không gọi `/analyze`;
- click Nhận diện gọi đúng một lần;
- tab nền không tự gọi;
- đổi file/hủy request không nhận kết quả stale;
- reset/dispose đóng đúng session.

### Lô 2 — Inspector backend nhận cả PDF và ảnh

Phạm vi dự kiến:

1. `backend/app/workers/sticker_source_inspector.py` (mới);
2. `backend/app/schemas/sticker_sheet.py`;
3. `backend/app/api/routes/sticker_sheet.py`;
4. `backend/app/core/sticker_sheet_session.py`;
5. `backend/tests/test_sticker_sheet_api.py`.

Thay đổi:

- endpoint chuẩn bị nguồn nhận PDF và các định dạng raster hiện có;
- inspect CutContour, vector/raster, Alpha, DPI và số trang;
- chưa chạy BiRefNet và chưa sinh contour;
- trả chiến lược đề xuất + confidence + preview/session;
- đường local path/upload giữ kiểm tra symlink, traversal và entitlement hiện có.

Gate: ma trận PDF có/không CutContour, PNG có/không Alpha, JPG, PDF nhiều trang,
file lỗi, DPI không vuông và session TTL.

### Lô 3 — Orchestrator nhận diện tự động

Phạm vi dự kiến:

1. `backend/app/workers/sticker_source_pipeline.py` (mới);
2. `backend/app/api/routes/sticker_sheet.py`;
3. `backend/app/schemas/sticker_sheet.py`;
4. `backend/tests/test_sticker_source_pipeline.py` (mới);
5. `backend/tests/test_sticker_sheet_api.py`.

Thay đổi:

- triển khai thứ tự existing-cut → vector → Alpha → simple-bg → AI;
- connected-components tự xác định số tem;
- chiến lược deterministic đủ confidence không nạp AI;
- AI chỉ fallback và trả uncertainty;
- giữ `boundary_source` để artifact/debug biết đường đến từ đâu.

Gate: cùng một hình ở PNG Alpha, JPG nền trắng và JPG mockup phải tạo cùng topology
và kích thước vật lý trong dung sai; không AI hóa lại CutContour tốt.

### Lô 4 — Store/API frontend thống nhất

Phạm vi dự kiến:

1. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`;
2. `desktop/src/lib/stickerSheetApi.ts`;
3. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`;
4. `desktop/src/components/preprocess-tools/stickerSheetStore.test.ts`;
5. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`.

Thay đổi:

- bỏ `StickerSourceMode` khỏi state;
- áp state machine mục 6;
- một upload nhận PDF và ảnh;
- UI không biết engine chọn Alpha/vector/AI cho tới khi manifest trả về;
- giữ mọi request/session theo `tabId`.

Gate: multi-tab, native path/upload, abort/stale response, object URL và session cleanup.

### Lô 5 — Workspace review mask không chứa thiết lập đầu ra trùng lặp

Phạm vi dự kiến:

1. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`;
2. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.tsx`;
3. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.test.tsx`;
4. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`;
5. `desktop/src/i18n/locales/vi.json`.

Thay đổi:

- panel trở thành bước preview/nhận diện/review mask;
- không còn tiêu đề “Ảnh AI nhiều tem”;
- hiện nguồn biên app đã chọn và confidence bằng ngôn ngữ dễ hiểu;
- nút Xác nhận vùng tem là gate cứng;
- không vẽ CutContour trước gate.

Gate: keyboard/focus, pan/zoom/brush, undo/redo, một tem/nhiều tem, vùng uncertainty.

### Lô 6 — Bảng thiết lập CutContour dùng chung

Phạm vi dự kiến:

1. `desktop/src/components/preprocess-tools/StickerOutputSettings.tsx` (mới);
2. `desktop/src/components/preprocess-tools/StickerTool.tsx`;
3. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`;
4. `desktop/src/components/preprocess-tools/StickerTool.test.ts`;
5. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`.

Thay đổi:

- tách UI Offset/góc/đặc ruột/crop/bù xén/màu thành component controlled dùng chung;
- cùng một settings object cho mọi nguồn;
- nguồn Alpha/AI chỉ quyết định giá trị hợp lệ, không hardcode một bảng riêng;
- recipe preference cũ tiếp tục đọc được.

Gate: parity payload giữa nguồn Alpha sẵn và Alpha do AI tạo; không mất bất kỳ tùy
chọn sản xuất hiện có nào.

### Lô 7 — Export chung, bỏ hardcode AI

Phạm vi dự kiến:

1. `backend/app/schemas/sticker_sheet.py`;
2. `backend/app/workers/sticker_sheet_export.py`;
3. `backend/app/api/routes/sticker_sheet.py`;
4. `desktop/src/lib/stickerSheetApi.ts`;
5. `backend/tests/test_sticker_sheet_api.py`.

Thay đổi:

- export nhận đầy đủ corner/fill holes/crop/bleed color/shape policy;
- mọi nguồn gọi cùng `StickerEngine` và cùng policy spline C2 hiện có;
- PDF có CutContour tốt được giữ nguyên nếu người dùng không yêu cầu tạo lại;
- route `/pdf-tools/sticker-dieline` giữ tương thích cho recipe/luồng cũ.

Gate: parse content stream PDF thật, kiểm Spot Color CutContour, Alpha/SMask, page
box, DPI/mm, số tem, không lệnh ngắn và độ liên tục đường cong.

### Lô 8 — Xóa mode cũ và verify runtime

Phạm vi dự kiến:

1. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`;
2. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`;
3. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`;
4. `desktop/src/i18n/locales/vi.json`;
5. `docs/HOP_NHAT_NHAN_DIEN_TEM_FIXES_2026-08-08.md`.

Thay đổi:

- xóa hai nút mode và dead state;
- xóa hành vi export xong tự chuyển `existing`;
- cập nhật log triển khai;
- smoke test trên app Windows thật.

Gate cuối: typecheck, vitest liên quan, pytest engine/sheet/API, lint, render PDF 600
DPI và kiểm tay trên app thật.

## 9. Ma trận nghiệm thu đầu vào

1. PDF đã có CutContour.
2. PDF vector chưa có CutContour.
3. PDF raster một trang và nhiều trang.
4. PNG Alpha một tem.
5. PNG Alpha nhiều tem.
6. JPG nền trắng một tem.
7. JPG nền trắng nhiều tem.
8. JPG mockup có bóng/nền phức tạp.
9. Ảnh không có DPI và ảnh DPI X/Y khác nhau.
10. File không nhận diện đủ tin cậy.

Với từng ca phải khóa:

- chiến lược app chọn;
- số instance và topology;
- viền trắng/bóng;
- kích thước mm;
- settings chung;
- artifact PDF sau writer;
- không tự chạy trước click Nhận diện;
- không thay biên có sẵn im lặng.

## 10. Rủi ro và cách khóa

| Rủi ro | Cách khóa |
|---|---|
| AI làm xấu PNG Alpha/vector sạch | ưu tiên nguồn đáng tin cậy; AI chỉ fallback hoặc người dùng ép Nhận diện lại |
| UI “không auto” nhưng backend vẫn chạy ngầm | test network: select file không được gọi analyze/warmup/detect |
| Mất thiết lập StickerTool hiện có | component settings dùng chung + payload parity test |
| Recipe cũ hỏng | giữ `/pdf-tools/sticker-dieline` và test recipe runner |
| Kết quả preview khác PDF | nghiệm thu bằng content stream + render artifact, không chỉ overlay |
| RAM tăng do AI warmup | warmup chỉ sau hành động detect; giữ heavy scheduler và chính sách phần cứng hiện có |
| Tab nền ghi đè tab đang dùng | mọi action/session mang tabId; abort + stale-response guard |
| Sai kích thước ảnh không DPI | luôn hiện và cho xác nhận DPI/mm trước export |
| Tự nhận diện thất bại nhưng vẫn tạo đường | confidence gate; không đủ bằng chứng thì bắt review/manual |

## 11. Chốt duyệt đề xuất

Đề xuất duyệt toàn bộ kiến trúc trên, nhưng triển khai trước **Lô 1** để loại ngay UX
tự quét mà không đợi refactor backend hoàn tất. Sau khi user nghiệm thu Lô 1 trên app
thật, tiếp tục Lô 2–3 cho bộ nhận diện nguồn, rồi mới xóa mode ở Lô 4–8.

