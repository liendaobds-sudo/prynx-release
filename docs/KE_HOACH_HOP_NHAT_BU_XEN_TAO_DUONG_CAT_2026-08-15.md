# Kế hoạch hợp nhất Bù xén – Tạo đường cắt — 2026-08-15

> Trạng thái: **DỰ THẢO — CHỜ DUYỆT, chưa sửa mã production**
> Baseline: commit `248ac95`
> Audit liên quan: `W2-U04`, `W2-U04-XEPTEM`, §UNIFIED.1–10, §XEPTEM.1–3

## 1. Mục tiêu

Hợp nhất hai lựa chọn nguồn hiện tại:

- `PDF/PNG đã có biên`;
- `Ảnh AI nhiều tem`.

thành **một luồng người dùng duy nhất** trong công cụ **Bù xén – Tạo đường cắt**.

Người dùng chỉ chọn file và mục tiêu gia công; ứng dụng tự chọn cách lấy biên. “AI nhiều tem”
trở thành chiến lược nội bộ/fallback và công cụ nâng cao, không còn là một mode bắt người dùng
phải hiểu.

### Phạm vi hợp nhất

- PDF, PNG, JPG/JPEG, WebP, BMP, TIFF;
- một tem, nhiều tem, nhiều trang;
- Alpha, nền trắng/vector, AI và CutContour có sẵn;
- sửa mask, khử bóng, các thanh kéo bám biên/bo/lọc chi tiết;
- Offset, bù xén, kiểu góc, lấp lỗ, màu bù xén, crop;
- xuất một tấm, PDF từng tem và ZIP PNG;
- giữ đúng tab, thumbnail, page order, native drop và recipe cũ.

### Không gộp trong lượt đầu

`Bế tem nhãn` và `Xén vuông góc` vẫn là **hai mục tiêu hình học** trong cùng công cụ. Luồng
nhận diện tem áp dụng cho `Bế tem nhãn`; các điều khiển riêng của `Xén vuông góc` (cạnh bù xén,
edge bite, lật gương, dải màu và n-up) tiếp tục dùng route/engine hiện tại cho đến khi parity
được chứng minh.

Không xóa ngay route tương thích `/api/pdf-tools/sticker-dieline`, không viết lại
`StickerEngine`, không thay đổi solver bình tem/CNC trong đợt hợp nhất nguồn.

## 2. Nguyên tắc bất biến

1. **Không chạy AI khi chỉ chọn file.** Chọn file chỉ tạo preview và inspect nhẹ.
2. **Không raster hóa biên có sẵn.** Chỉ giữ CutContour vector khi extractor xác nhận path đã
   được vẽ thật; generic vector không tự nhận là đường dao.
3. **Không ép AI toàn trang.** Với nhiều artwork, deterministic proposal tạo các vùng trước;
   AI toàn trang chỉ là fallback. Nếu cần silhouette đẹp hơn, AI sẽ được cân nhắc theo từng ROI
   ở một lô riêng.
4. **Không mất thông số.** Mọi thanh kéo và nút hiện có của AI vẫn tồn tại; chỉ thu gọn khi
   chưa có mask hoặc khi không có tác dụng với nguồn đang giữ nguyên vector.
5. **Không reset thiết lập khi đổi chiến lược.** Settings thuộc tab; đổi `auto`/AI/refine không
   xóa Offset, bù xén, góc, crop, edit hay page order.
6. **Không đổi hành vi Xén vuông góc trong lô hợp nhất nguồn.** Nhánh rectangle phải giữ payload,
   bleed sides, edge bite, màu và page canvas hiện tại.
7. **Fail-closed khi thiếu bằng chứng.** Không đủ confidence thì giữ preview gốc, báo lý do và
   yêu cầu review/nhận diện lại; không tự tạo đường cắt âm thầm.
8. **Máy mạnh không bị cap mới.** Nhánh AI/render vẫn đi qua scheduler và hồ sơ RAM hiện có;
   chỉ máy yếu mới giảm theo policy dự án.
9. **Mọi event mang owner.** Request, asset, edit và native drop phải gắn `tabId` + session/page;
   tab nền hoặc tab đã đóng không được ghi kết quả.

## 3. Kiến trúc đích

```text
File PDF/ảnh
   ↓
StickerSourceInspector (nhẹ, không AI)
   ↓
StickerSourcePipeline(strategy=auto)
   ├─ CutContour thật → giữ vector
   ├─ PDF/vector hoặc Alpha sạch → mask/geometry đáng tin cậy
   ├─ nền trắng/đơn giản → connected-components
   ├─ nền phức tạp → AI fallback + uncertainty
   └─ không đủ bằng chứng → manual/review, không xuất âm thầm
   ↓
StickerSheetSession theo page
   ↓
Mask review + AI controls (khi có capability)
   ↓
StickerOutputSettings dùng chung
   ↓
Preview CutContour → export PDF/PNG
```

### Hợp đồng nguồn

Các field hiện có tiếp tục là nguồn chân lý:

- `source_kind`;
- `boundary_source`;
- `strategy_confidence`;
- `needs_review`;
- `pages[]`, `instances[]`, `warnings[]`;
- `vector_geometry_ref`;
- DPI/khổ vật lý;
- revision và session/page artifact.

Không đưa bitmap vào React state; store chỉ giữ manifest, URL asset, edit và settings.

### Capability thay cho kiểm tra cứng theo tên strategy

Frontend sẽ suy ra capability từ manifest/session, ví dụ:

```text
canReviewMask
canEditMask
canRefineAi
canRebuildCutline
canPreserveExistingCut
canSplitInstances
```

Không dùng điều kiện kiểu `boundary_source === 'ai'` để làm biến mất toàn bộ thanh kéo. Một
nguồn `simple-bg`, `alpha` hoặc `vector` vẫn có thể được phép dựng lại CutContour nếu người dùng
chủ động bật **Tạo lại đường bế**.

## 4. Quy tắc chọn chiến lược

### Bước 1 — Inspect nhẹ

`POST /api/sticker-sheet/inspect` chỉ đọc loại file, page box, DPI, Alpha/SMask, vector/raster
và CutContour thật; không nạp model, không connected-components, không sinh dao.

### Bước 2 — Nhận diện chủ động

Nút hiển thị cho người dùng là **Nhận diện tem và tạo đường cắt**. Backend mặc định nhận
`strategy=auto`.

Thứ tự:

1. `existing-cut`: giữ path vector, không AI;
2. `vector`/silhouette có bằng chứng: dùng proposal phù hợp, không giả vờ mọi vector là CUT;
3. `alpha`: lấy Alpha sạch và tách connected-components;
4. `simple-bg`: tách nền đồng nhất/nền trắng;
5. `ai`: chỉ fallback khi deterministic không đủ confidence;
6. `manual`: review/sửa mask nếu vẫn không đủ bằng chứng.

### Bước 3 — Nâng cao

Trong menu **Nhận diện lại**, người dùng có thể chủ động chọn:

- Tự động (mặc định);
- Dùng Alpha;
- Dùng nền đơn giản;
- Dùng AI.

Lựa chọn nâng cao phải ghi rõ đây là hành động thay thế proposal hiện tại và có thể thay đổi
mask/đường cắt.

### Ca `Xep Tem.pdf`

```text
inspect: không có CutContour
auto: nhận 5 vùng tem, không nạp AI
review: chỉnh vùng nếu cần
output: giữ nguyên tấm hoặc tách 5 tem
```

Nếu sau khi xem artifact người dùng yêu cầu silhouette chi tiết hơn, mới mở nhánh AI refine theo
ROI; không quay lại cách chạy BiRefNet một lần trên cả tờ.

## 5. UX đích

### 5.1 Khung chính

```text
Bù xén – Tạo đường cắt
  [Bế tem nhãn] [Xén vuông góc]

Nguồn: Xep Tem.pdf · 1 trang
Trạng thái: Chưa nhận diện
  [Nhận diện tem và tạo đường cắt]

┌ Preview / thumbnail / mask review ┐
└────────────────────────────────────┘

Đường cắt và bù xén
  Offset · kiểu góc · lấp lỗ · bù xén · màu · crop
  [Giữ nguyên tấm] [Tách từng tem]

▸ Tinh chỉnh đường bế
▸ Sửa vùng tem

  [Lưu PNG] [Tạo PDF có đường cắt]
```

### 5.2 Hiện/ẩn theo capability

| Khu vực | Khi nào hiển thị | Nội dung bắt buộc giữ |
|---|---|---|
| Nguồn & nhận diện | luôn | file, trang, trạng thái, số tem, cảnh báo, Nhận diện lại |
| Đường cắt | sau inspect/hoặc có thiết lập | mode cắt, Offset, kiểu góc, lấp lỗ, crop |
| Bù xén | sau inspect/hoặc có thiết lập | độ rộng, màu/CMYK, preview |
| Sửa vùng tem | có mask editable | Xóa, Giữ, Gộp, cỡ cọ, Undo/Redo |
| Tinh chỉnh AI | `canRefineAi` hoặc user bật Tạo lại | Khử bóng, Bám sát, Độ bo, Lọc chi tiết |
| Giữ biên có sẵn | `canPreserveExistingCut` | thông báo giữ vector, nút Tạo lại |
| Xén vuông góc | product type rectangle | cạnh bù xén, edge bite, lật gương, dải màu và n-up cũ |

Ẩn là **thu gọn**, không phải xóa state. Khi mở lại, giá trị phải được giữ nguyên.

### 5.3 Cảnh báo nghiệp vụ

Các warning hiện trong manifest phải có vùng hiển thị rõ, ví dụ:

- “Chỉ nhận diện được 1 tem; hãy kiểm tra lại vùng tem.”;
- “Nguồn có nền phức tạp; đường cắt cần được xác nhận.”;
- “Đang giữ nguyên đường cắt vector có sẵn.”

Không hiển thị tên BiRefNet/OpenCV/timing kỹ thuật trong UI thường; tên strategy chỉ nằm trong
phần nâng cao/chẩn đoán nếu cần.

## 6. State machine đích

### Tab/document

| State | Ý nghĩa | Hành động |
|---|---|---|
| `empty` | chưa có file | chọn/thả file |
| `source-ready` | có preview gốc, chưa quét | inspect/nhận diện/đổi file |
| `inspecting` | đọc nhẹ metadata | chờ/hủy |
| `detecting` | pipeline đang nhận diện | chờ/hủy |
| `mask-review` | có mask/proposal chưa chốt | sửa, tinh chỉnh, nhận diện lại, xác nhận |
| `mask-ready` | mask/geometry đã chốt | chỉnh output, preview, xuất |
| `exporting` | đang ghi artifact | chờ/hủy theo contract |
| `error` | lỗi có thể khôi phục | thử lại/đổi chiến lược/sửa thủ công |

### Page state

PDF nhiều trang giữ `pages[source_page]` độc lập: status, manifest, edit, revision, tuning,
asset URL và lỗi. `pageOrder` chỉ quyết định thứ tự xuất, không đổi owner của mask.

### Di trú state hiện tại

- `StickerSourceMode` chỉ tồn tại trong giai đoạn tương thích; sau khi runtime ổn định sẽ xóa.
- `productType` vẫn giữ vì `sticker` và `rectangle` là mục tiêu hình học khác nhau.
- `outputSettings` trở thành object chung; các field AI giữ trong page state.
- localStorage `ps_sticker_*` tiếp tục đọc được; không đổi tên key trong lượt đầu.
- export xong không tự đổi mode; Viewer nhận artifact mới nhưng session/settings vẫn có thể mở lại.

## 7. Lộ trình theo lô (mỗi lô tối đa 5 file)

Mỗi lô phải dừng, chạy verify và chờ người dùng nghiệm thu trước khi sang lô kế. Các file nêu
dưới đây là phạm vi dự kiến; nếu phát hiện cần thêm file, phải cập nhật kế hoạch trước khi sửa.

### Lô 0 — Characterization và fixture, không đổi production

**Mục tiêu:** chụp baseline trước khi thay UI.

Ca bắt buộc:

1. `Xep Tem.pdf`: 0 CutContour, auto = 5, AI hiện tại = 1;
2. PDF Corel có CutContour thật: preserve byte/content/page box;
3. PDF vector không CutContour;
4. PNG Alpha một/nhiều tem;
5. JPG nền trắng một/nhiều tem;
6. JPG mockup có bóng;
7. PDF nhiều trang, DPI X/Y khác nhau và thiếu DPI;
8. `Xén vuông góc`: cạnh bù xén, edge bite, màu, crop.

**Artifact:** mỗi ca có manifest, số instance, kích thước mm, PDF/ZIP đầu ra, số CutContour và
ảnh render. Không đưa file khách hàng vào Git; fixture tổng hợp phải tái tạo được bằng test.

**Gate:** duyệt bảng expected behavior trước khi đổi code.

### Lô A — Quick win: không ép AI, sửa đúng ca `Xep Tem` (4 file)

1. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`
   - gọi `auto` cho trang hiện tại/tất cả;
   - hiện warning/confidence dạng nghiệp vụ;
   - thêm Nhận diện lại → AI ở phần nâng cao.
2. `desktop/src/components/preprocess-tools/StickerSheetPanel.test.tsx`
   - khóa payload `auto`;
   - khóa hiển thị warning một-tem/confidence thấp;
   - giữ test các thanh kéo hiện có.
3. `backend/tests/test_sticker_source_pipeline.py`
   - thêm fixture PDF nhiều artwork kiểu `Xep Tem`;
   - assert auto nhận đủ vùng và không gọi model;
   - assert explicit AI vẫn là hành động nâng cao, không phải mặc định.
4. `backend/tests/test_sticker_sheet_api.py`
   - khóa manifest warning, count, page metadata và detect → confirm → export.

**Verify:** pytest phạm vi sticker; Vitest panel; typecheck; chạy lại artifact `Xep Tem.pdf`.

**Điểm dừng:** người dùng kiểm tra 5 tem/5 trang và quyết định có cần AI refine silhouette hay
không.

### Lô B — Một controller nguồn, bỏ selector hai mode (5 file)

1. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`
   - bỏ hai nút source mode;
   - giữ selector `Bế tem nhãn/Xén vuông góc` ở lớp nghiệp vụ;
   - luôn dùng một owner/session theo `tabId`.
2. `desktop/src/components/preprocess-tools/StickerUnifiedPanel.tsx` *(mới)*
   - điều phối source-ready → inspect → detect → review → export;
   - mount panel review hoặc legacy rectangle theo capability/product type, không tạo nguồn thứ hai.
3. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`
   - thêm `sourceCapabilities`/recognition action;
   - giữ page state, request key, cleanup và output settings;
   - đánh dấu `mode` deprecated, chưa xóa cho tới lô cuối.
4. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`
   - mở tool trực tiếp, từ tab PDF đang có và từ Home;
   - đổi file không inspect ngầm;
   - export không tự chuyển mode.
5. `desktop/src/components/preprocess-tools/stickerSheetStore.test.ts`
   - owner theo tab/page, stale response, cancel, dispose, session cleanup;
   - settings không reset khi đổi strategy.

**Verify:** Vitest 2 file + typecheck; chưa xóa route legacy.

### Lô C — Gộp bảng thiết lập đầu ra, giữ toàn bộ thông số cũ (5 file)

1. `desktop/src/components/preprocess-tools/StickerOutputSettingsPanel.tsx`
   - controlled component dùng cho cả nguồn session và legacy sticker;
   - `preserveNotice`, capability và trạng thái disabled rõ ràng;
   - giữ Offset, kiểu góc, lấp lỗ, bù xén, màu/CMYK, crop.
2. `desktop/src/components/preprocess-tools/stickerOutputSettings.ts`
   - chuẩn hóa object chung;
   - đọc/ghi tương thích mọi khóa `ps_sticker_*` hiện có.
3. `desktop/src/components/preprocess-tools/StickerTool.tsx`
   - dùng bảng chung ở nhánh `sticker`;
   - giữ nguyên các control chỉ dành cho `rectangle`;
   - không đổi payload cho Xén vuông góc.
4. `desktop/src/components/preprocess-tools/StickerOutputSettingsPanel.test.tsx`
   - parity tất cả field, clamp, CMYK và localStorage migration.
5. `desktop/src/components/preprocess-tools/StickerTool.test.ts`
   - payload sticker/rectangle, crop, corner, bleed, force contour và recipe preference.

**Verify:** Vitest phạm vi + typecheck; so payload trước/sau bằng fixture, chưa đổi backend.

### Lô D — Progressive disclosure cho mask và AI (5 file)

1. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`
   - tách section Nguồn / Sửa vùng / Tinh chỉnh / Đường cắt / Đầu ra;
   - không gate ba slider hình học chỉ bằng `boundary_source === 'ai'`;
   - giữ Khử bóng, Bám sát, Độ bo, Lọc chi tiết, cọ và Undo/Redo.
2. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.tsx`
   - overlay/hand/brush theo capability;
   - hiển thị source status, uncertainty và warning mà không đổi viewer ownership.
3. `desktop/src/components/preprocess-tools/StickerSheetPanel.test.tsx`
   - AI controls vẫn có và giữ giá trị;
   - auto/vector/alpha mở đúng section;
   - existing-cut hiện notice giữ vector và nút Tạo lại.
4. `desktop/src/components/preprocess-tools/StickerSheetWorkspace.test.tsx`
   - pan/hand/brush, active page, overlay, tab nền và mask edit.
5. `desktop/src/i18n/locales/vi.json`
   - thêm/cập nhật text nghiệp vụ; nếu cần `en.json`, tách thành lô i18n riêng ≤5 file.

**Verify:** Vitest workspace/panel + typecheck; kiểm tra UI không lộ tên model/thư viện.

### Lô E — Export session và legacy parity (5 file)

1. `backend/app/workers/sticker_source_pipeline.py`
   - khóa `auto`/existing-cut/vector/alpha/simple-bg/AI fallback;
   - chỉ tạo `vector_geometry_ref` bảo toàn khi path CUT thật;
   - không đổi semantics generic vector thành CutContour.
2. `backend/app/workers/sticker_sheet_export.py`
   - nhận settings chung;
   - preserve PDF vector khi đủ điều kiện;
   - mask edit, crop/keep-sheet, page order, output PDF/ZIP atomic.
3. `desktop/src/lib/stickerSheetApi.ts`
   - một payload export/preview cho mọi nguồn session;
   - giữ `pages`, `page_order`, revision, DPI X/Y, warning/capability.
4. `backend/tests/test_sticker_sheet_api.py`
   - export artifact cho CutContour, Alpha, auto 5 tem, multi-page, stale revision và ZIP.
5. `backend/tests/test_sticker_engine_e2e.py`
   - parse/render CutContour, page boxes, continuity, short segment, bleed và preserve.

**Lưu ý contract gap:** `remove_white_bg`, `bleed_sides`, `edge_bite_mm` và
`cut_first_page_only` thuộc route/nhánh legacy. Không map đại vào settings session. Nếu ca
`sticker` thật sự cần chúng, lập lô E2 riêng để bổ sung schema/consumer; `rectangle` giữ route
legacy trong thời gian đó.

**Verify:** pytest API/E2E, py_compile, parse PDF + render Poppler. Không chạy AI trên CutContour.

### Lô F — Bảo toàn route Xén vuông góc và recipe (5 file)

1. `desktop/src/components/preprocess-tools/StickerTool.tsx`
2. `backend/app/api/routes/pdf_tools.py`
3. `backend/tests/test_pdf_tools.py`
4. `desktop/src/components/preprocess-tools/StickerTool.test.ts`
5. `desktop/src/components/preprocess-tools/stickerToolPolicy.ts`

Khóa lại:

- product type `rectangle`;
- cạnh bù xén ít nhất một cạnh;
- edge bite và edge sample inset;
- mirror/trajectory/inpaint/image/solid + CMYK;
- process pages/cut-first-page;
- selection object và force contour;
- localStorage/recipe cũ.

**Verify:** pytest pdf tools + Vitest StickerTool; so sánh payload và artifact với baseline Lô 0.

### Lô G — Routing, native drop, multi-tab và dọn mode cũ (5 file)

1. `desktop/src/components/imposition-tools/ImposerDashboard.tsx`
2. `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx`
3. `desktop/src/components/ImpositionTab.tsx`
4. `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx`
5. `desktop/src/components/preprocess-tools/StickerCutlineTool.test.tsx`

Khóa:

- picker/DOM drop/native drop cùng đưa về một source owner;
- tab nền/đã đóng không nhận file;
- đổi thumbnail chỉ đổi page đang review;
- kết quả export commit xong mới cập nhật Viewer;
- xóa `MODES`, `StickerSourceMode` và dead branch chỉ sau khi tất cả test migration xanh.

**Verify:** typecheck, Vitest routing/drop, rồi `run_dev.bat` thao tác thật trên Windows.
DOM test không thay thế native-drop smoke.

### Lô H — Tùy chọn: AI refine theo từng ROI (5 file)

Chỉ mở lô này nếu artifact `Xep Tem.pdf` sau Lô A cho thấy contour chữ nhật không đạt yêu cầu
sản xuất.

1. `backend/app/workers/sticker_instance_refiner.py` *(mới)*
2. `backend/app/workers/sticker_source_pipeline.py`
3. `backend/app/workers/sticker_sheet_engine.py`
4. `backend/app/workers/sticker_sheet_export.py`
5. `backend/tests/test_sticker_source_pipeline.py`

Thiết kế: deterministic proposal tạo từng ROI → AI chạy riêng trong ROI → ghép label-map về
tọa độ trang → giữ thứ tự/id → chạy lại topology/safe-envelope/C2. Không chạy thêm worker vô
điều kiện; dùng scheduler/hồ sơ RAM hiện có. Đây là tính năng hình học mới, phải có corpus và
artifact oracle riêng, không gộp vào quick-win đổi `ai` thành `auto`.

## 8. Ma trận nghiệm thu

### Nguồn và số instance

| Ca | Kết quả bắt buộc |
|---|---|
| `Xep Tem.pdf` | 5 vùng; auto không gọi AI; PDF 5 trang/ZIP 5 PNG |
| PDF có CutContour | giữ vector/page box/content; không raster khi chưa yêu cầu dựng lại |
| PDF vector không CUT | nhận diện proposal, không giả nhận mọi path là CUT |
| PNG Alpha 1/nhiều tem | giữ Alpha, đúng component và kích thước |
| JPG nền trắng 1/nhiều tem | deterministic trước AI |
| JPG mockup/bóng | AI fallback, warning/uncertainty và review |
| PDF nhiều trang | mask/revision/error độc lập; page order đúng |
| DPI thiếu/lệch X-Y | giữ quy ước 72 DPI hoặc metadata từng trục, không bịa scale |

### Settings/parity

- Offset âm/dương chỉ áp một lần;
- bù xén và màu không làm thay đổi nguồn biên ngoài ý định;
- crop/giữ khổ tấm đúng lựa chọn;
- góc preserve/round/miter đúng preview và PDF;
- lấp lỗ đúng topology;
- slider AI giữ giá trị qua collapse, đổi trang và reopen;
- existing-cut không bị AI hóa lại âm thầm;
- Xén vuông góc giữ nguyên cạnh, edge bite, mirror và recipe.

### Runtime Windows

1. Mở công cụ từ Home và từ PDF đang mở.
2. Chọn/thả PDF `Xep Tem.pdf`; chưa bấm nhận diện thì không chạy AI/connected-components.
3. Bấm nhận diện; xác nhận 5 tem và nguồn biên hiển thị bằng ngôn ngữ nghiệp vụ.
4. Mở/đóng phần tinh chỉnh; xác nhận tất cả thanh kéo AI vẫn có và không reset.
5. Sửa một vùng, Undo/Redo, đổi thumbnail và đổi tab.
6. Xuất giữ nguyên tấm và tách từng tem; mở lại PDF, đếm trang/CutContour và render.
7. Chạy lại PDF có CutContour và Xén vuông góc để xác nhận không hồi quy.
8. Lặp picker, DOM drop, native drop, tab nền và tab đã đóng.

## 9. Trình tự verify và điều kiện dừng

Sau mỗi lô:

1. `git diff --check` và kiểm tra chỉ file trong lô;
2. typecheck nếu chạm frontend;
3. Vitest phạm vi;
4. pytest/py_compile nếu chạm backend;
5. parse/render artifact nếu chạm PDF/geometry;
6. chỉ sau khi các bước trên xanh mới chạy lô kế.

Nếu người dùng báo sai kết quả, chậm hoặc mất control: dừng toàn chiến dịch, giữ artifact của
lô gây lỗi, khoanh regression và sửa/revert theo tag audit trước khi tiếp tục.

Không build installer trong các lô đầu. Build/release là audit unit riêng sau khi runtime dev
đã đạt.

## 10. Quyết định cần duyệt

Đề xuất duyệt theo thứ tự:

1. **Lô A** trước để sửa ngay `Xep Tem.pdf` và có artifact 5 tem;
2. Lô B–D để hợp nhất UI/state nhưng giữ nguyên các control AI;
3. Lô E–F để khóa export/parity và Xén vuông góc;
4. Lô G để dọn mode cũ sau runtime;
5. chỉ mở Lô H nếu silhouette từng tem cần AI refine riêng.

Tài liệu này là kế hoạch, không cấp quyền tự động sửa production trước khi người dùng duyệt
lô tương ứng.
