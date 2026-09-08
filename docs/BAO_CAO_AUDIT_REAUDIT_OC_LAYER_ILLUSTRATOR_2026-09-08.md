# Báo cáo tái audit boong/ốc, layer Graphtec và đường mở Illustrator

> Ngày: 2026-09-08  
> Baseline source: `ea4e8638d2d5f097f38655db0a3d525996326c9b`  
> Audit unit: `W2-U02-OC / PONTLAYER-RE`  
> Phạm vi: cấu hình boong/ốc → payload → route/dispatch → writer PDF → tách “Chỉ trang khuôn” → mở Illustrator/CorelDRAW.  
> Mức bằng chứng: `ARTIFACT` cho finding chính; `RUNTIME` chưa xác minh vì chưa thao tác được app + Illustrator/Graphtec Studio thật.

## 1. Kết luận điều hành

Đã xác nhận một lỗi mới, độc lập với bản vá `copyPages()` ngày 2026-08-07:

**Trong bản dev hiện tại, CNC (và Sticker) với `gridStrategy=optimal_auto` + ít nhất một hình được nhận là `CUSTOM` đi qua nhánh true-shape. Nhánh writer production có nhận đủ tên Graphtec/layer/group/item trong `renderBundle`, nhưng không ghi bất kỳ OCG nào (`/OCProperties`, `/D/Order`) và cũng không ghi marked-content `/NM`.**

PDF thật tái hiện có root chỉ gồm `/Type` và `/Pages`, không có `/OCProperties`; vì vậy file gốc đã mất layer trước khi tới `OpenInDesignModal`. Khi modal trích “Chỉ trang khuôn”, helper bảo toàn OCG không thể khôi phục metadata chưa từng được ghi.

Đây khớp trực tiếp triệu chứng “đã đặt tên layer cho Graphtec nhưng mở trang bế bằng Illustrator không thấy gì”. Bản vá cũ chỉ bảo vệ đường `copyPages()` khi artifact nguồn đã có OCG; nó không bao phủ writer true-shape mới.

## 2. Bằng chứng tái hiện

### 2.1 Route thật trong môi trường hiện tại

Với `backend/app/config.py` hiện hành, probe trả `DEV_MODE=True` và `true_shape_nesting_enabled=True`. Cùng một settings tối thiểu:

```text
imposerMode=cnc
isDieCutMode=true
gridStrategy=optimal_auto
layoutType=sequential
taskMode=nup
detectedShapesByPage={"0":"CUSTOM"}
pontType=custom
pontConfig={isGraphtec:true, layerInfoName:"AUDIT_GRAPH_INFO",
            layerName:"AUDIT_LAYER", groupName:"AUDIT_GROUP",
            itemName:"AUDIT_ITEM", ...}
```

`route_true_shape(settings)` trả `True` (manual=false, auto=true). Đây không phải đường giả lập: `_run_nup_engine_impl` xét true-shape **trước** nhánh CNC legacy.

### 2.2 Artifact PDF thật — ma trận Sticker/CNC

Đã gọi `run_true_shape_nesting()` trên `test/test nesting.pdf` với cấu hình Graphtec ở trên và mở lại bằng `pikepdf`. Cùng một writer production được dùng cho cả Sticker và CNC; khác nhau chỉ ở `flow.tool`/duplex:

```text
Sticker true-shape: route=True, pages=2, root keys=['/Type','/Pages'], ocprops=False
CNC true-shape:     route=True, pages=2, root keys=['/Type','/Pages'], ocprops=False
```

Đối chứng cùng bộ tên, ép đường lưới legacy:

| Luồng | Cấu hình | Kết quả artifact |
|---|---|---|
| Sticker (Bế tem) | `isDieCutMode=true`, `gridStrategy=manual`, `separateCutPage=true` | Có `/OCProperties`; `AUDIT_GRAPH_INFO`, `AUDIT_LAYER`, `AUDIT_GROUP`; trang CUT có cây `/Order`. |
| Sticker (Bế tem) | `optimal_auto` + `CUSTOM` (dev) | Không có `/OCProperties`; không có `/NM`. |
| Bình nguyên tấm decal (Page Sheet) | `page_sheet_mode=true`, legacy grid | Có `/OCProperties`; tên Graphtec/layer/group được giữ. `pontsOnCutFile=false` bỏ ốc ở CUT theo hợp đồng. |
| CNC simplex | legacy `run_cnc_two_sided` | Có `/OCProperties`; tên Graphtec/layer/group/item giữ ở Front+CUT. |
| CNC duplex | legacy `run_cnc_two_sided` | Có cây OCG; boong `4/0/4` ở Front/Back/CUT theo hợp đồng hiện hành. |

Artifact homogeneous Sticker probe (`nup_engine.run_nup_engine`, `separateCutPage=true`, 4 artwork + 1 khuôn chung) có **5 trang**: trang `0..3` là artwork, trang `4` là CUT cuối. Đây là bằng chứng cho §PONTLAYER.RE.6; không thể suy trang CUT bằng công thức xen kẽ `i*2+1`.

Content stream vẫn có vector artwork/boong, nhưng không có catalog OCG và không có `/NM`. Vì vậy:

- không có cây layer để Illustrator dựng;
- `OpenInDesignModal` không thể “materialize” layer khi copy trang;
- các test chỉ đếm vector/màu vẫn có thể xanh dù tên layer biến mất.

### 2.3 Đối chứng nhánh legacy

`run_cnc_two_sided()` legacy với cùng tên tạo được `/OCProperties`, ba OCG Graphtec/layer/group và `/NM`. Sau bước report `stamp_reports_on_pdf()` các OCG vẫn còn. Điều này khoanh vùng lỗi vào **dispatch/writer true-shape**, không phải pikepdf report stamp hay artifact lease.

## 3. Trace dọc luồng sống

| Tầng | Bằng chứng | Kết quả |
|---|---|---|
| UI/state | `desktop/src/components/imposition-tools/PontSettingsDialog.tsx:187-218`; `store/slices/marksSlice.ts:33-84` | Có các field Graphtec/layer/group/item; được persist. |
| Serialize | `desktop/src/lib/processHandlers.ts:312-350` | CNC gửi `imposerMode=cnc`, `pontType`, `pontConfig`, mặc định `gridStrategy` thường là `optimal_auto`. |
| Dispatch | `backend/app/workers/nup_engine.py:346-412` | true-shape được xét ở `361-390`, trước nhánh CNC `409-412`. |
| Build bundle | `backend/app/workers/nup_true_shape_nesting.py:933-1055`; `backend/app/core/nesting_imposition_bundle.py:100-134` | Tên Graphtec/layer/group/item đi vào `ImpositionPontConfigSpec` và `renderBundle.marks.pont.config`. |
| Writer true-shape | `backend/app/workers/nesting_imposition_render.py:1016-1082, 1375-1519` | `_pont_stream()` chỉ phát toán tử hình/màu; không phát `/OC ... BDC`, `/Span ... /NM ... BDC` hoặc tạo OCG catalog. |
| Writer legacy CNC | `backend/app/workers/cnc_render.py:46-68, 194-285`; `backend/app/workers/pdf_ops.py:752-800` | Tạo OCG Graphtec→layer→group và `/NM`; artifact đối chứng đạt. |
| Tách mở Illustrator | `desktop/src/components/imposition-tools/OpenInDesignModal.tsx:257-303` | Đã gọi `begin/finishOptionalContentTransfer(... preserveUnreferencedOcgs=true)`, nhưng chỉ cứu được OCG đã tồn tại ở nguồn. |
| Ghép nhiều chunk | `backend/app/workers/nup_output_finalize.py:118-183` | Remap page `/Resources/Properties` theo `/Name` OCG; tên layer/group tùy chỉnh bị trùng giữa các sheet nên có nguy cơ dồn nhiều trang vào OCG của sheet cuối. |
| Publish/path | `backend/app/api/routes/imposition.py:688-757, 1291-1342`; `desktop/src/lib/processHandlers.ts:441-487` | `output_path` + artifact lease được công bố; tiến trình không làm mất OCG trong probe. |

## 4. Findings

### §PONTLAYER.RE.1A — P1 — true-shape writer của BÌNH TEM BẾ làm mất toàn bộ layer Graphtec

**Trạng thái:** `[CONFIRMED]` · Likelihood `Cao` trong dev/CUSTOM · Impact `Cao` · Effort `M`

Điều kiện: bản dev, công cụ **Bình Tem Bế (Sticker)**, `optimal_auto`, hình `CUSTOM`/không nhận diện được.  
Vi phạm bất biến: mọi tên layer mà UI cho nhập phải còn trong artifact consumer; artifact không có `/OCProperties`/`/NM`.  
Consumer bị ảnh hưởng: Illustrator, CorelDRAW và plugin/workflow Graphtec.

Nguyên nhân trực tiếp: writer true-shape vẽ `_pont_stream()` như stream raw (màu + path) nhưng không materialize tên OCG/item dù bundle đã canonicalize các field đó. Dispatch đặt nhánh này trước CNC legacy nên cấu hình CNC hợp lệ vẫn rơi vào lỗi.

### §PONTLAYER.RE.1B — P1 — cùng lỗi trên nhánh CNC true-shape

**Trạng thái:** `[CONFIRMED]` · Likelihood `Cao` trong dev/CUSTOM · Impact `Cao` · Effort `M`

Điều kiện: bản dev, công cụ **CNC**, `optimal_auto`, hình `CUSTOM`/không nhận diện được. `route_true_shape()` trả `True` trước khi `imposerMode='cnc'` được chuyển tới `run_cnc_two_sided()`. Artifact CNC true-shape có cùng dấu vết `ocprops=False` như Sticker; vì vậy test CNC legacy xanh không bảo vệ ca đang chạy trong dev.

### §PONTLAYER.RE.1C — P2 — Page Sheet không mất layer ở legacy, nhưng chưa có test tách Illustrator cuối luồng

**Trạng thái:** `[ARTIFACT PASS / RUNTIME UNVERIFIED]`

Page Sheet bị chặn khỏi true-shape (`pageSheetMode`), và artifact legacy probe giữ OCG Graphtec/layer/group. Tuy vậy chưa có smoke app → `Bế` → Illustrator cho Page Sheet, cũng chưa có assertion sau `savePrintFilesToFolder`; giữ proof gap, không quy kết Page Sheet đang mất layer.

### §PONTLAYER.RE.2 — P1 — “Chỉ trang khuôn” không thể cứu artifact true-shape

**Trạng thái:** `[CONFIRMED as consequence]` · Effort `S`

`OpenInDesignModal` đã sửa đúng lỗi `copyPages()` cũ ở `OpenInDesignModal.tsx:279-290`. Tuy nhiên với artifact true-shape **của Sticker hoặc CNC**, `beginOptionalContentTransfer()` thấy nguồn không có `/OCProperties`, nên transfer rỗng và PDF tạm tiếp tục không có layer. Đây là lý do bản vá cũ không làm triệu chứng hiện tại biến mất.

### §PONTLAYER.RE.3 — P2 — regression test true-shape chưa khóa tên layer/item

**Trạng thái:** `[CONFIRMED test gap]` · Effort `S`

`backend/tests/test_nesting_imposition_render.py:1015-1222` chỉ kiểm màu registration, số cung, pixel vị trí, thứ tự stream và hình L; không assert `/OCProperties`, `/OCGs`, `/D/Order`, page `/Resources/Properties` hay `/NM`. `backend/tests/test_nesting_finishing_parity.py:307-334` cũng chỉ kiểm đường bế không lọt lên trang in. Vì vậy writer raw mới có thể đạt toàn bộ suite hiện tại trong khi layer bị mất ở cả Sticker và CNC.

### §PONTLAYER.RE.4 — P2 — đường lưu file in vẫn không giữ OCG rỗng Graphtec (proof gap cho file tách)

**Trạng thái:** `[SUSPECTED / cần artifact regression riêng]` · Effort `S`

`desktop/src/lib/savePrintFiles.ts:73-84` gọi `beginOptionalContentTransfer([srcDoc])` không bật `preserveUnreferencedOcgs`. Với artifact legacy, Graphtec info/layer cha là OCG rỗng và chỉ được giữ khi caller bật tùy chọn explicit (đã chứng minh trong `desktop/src/lib/pdfOptionalContent.test.ts:153-204`). Vì vậy file `(cut).pdf` sinh bởi Save Print có nguy cơ chỉ còn group OCG, dù đường mở modal đã bật preserve. Chưa xếp `[CONFIRMED]` cho tới khi chạy artifact qua `savePrintFilesToFolder` và parse file ghi ra.

### §PONTLAYER.RE.6 — P1 — modal chọn nhầm trang khi Sticker dùng một khuôn chung ở cuối file

**Trạng thái:** `[CONFIRMED]` · Likelihood `Trung bình` (homogeneous/single-mold) · Impact `Cao` · Effort `M`

Backend legacy có chủ đích dồn một trang CUT dùng chung xuống cuối file khi homogeneous/single-mold: `backend/app/workers/nup_output_finalize.py:323-360, 595-614`. Artifact probe với bốn trang artwork + một CUT cho kết quả **5 trang**; trang `0..3` có `NM` boong nhưng không có `/OC`, trang `4` mới có `5` block `/OC` và cây layer. Trong khi đó `OpenInDesignModal.tsx:149-162` và `printFileNaming.ts:100-151` luôn suy `pagesPerUnit=2`, lấy CUT ở các chỉ số `1,3,...`; với file 5 trang, modal lấy trang artwork `1`/`3` và bỏ qua CUT thật ở `4`. Người dùng vì vậy có thể mở Illustrator đúng file nhưng thấy không có đường bế/layer tương ứng. Lỗi này độc lập với true-shape writer.

Ca này cũng làm `savePrintFilesToFolder` tách sai file `(cut).pdf` cho homogeneous output, vì nó dùng cùng `buildSavePlan`. Cần truyền metadata layout (shared-master-cut) hoặc dò marker/side plan từ backend; không được đoán chỉ bằng số trang.

### §PONTLAYER.RE.7 — P1/P2 — merge nhiều chunk dồn group OCG trùng tên về sheet cuối

**Trạng thái:** `[CONFIRMED artifact]` · Likelihood `Trung bình` (job nhiều sheet/chunk) · Impact `Trung bình–Cao` · Effort `M`

`_merge_layered_chunks()` tạo `chunk_ocg_map` theo tên `/Name` (`nup_output_finalize.py:127-180`). `nup_process_chunk.py:1510-1517` lại tạo một `AUDIT_GROUP`/`AUDIT_LAYER` riêng cho mỗi sheet. Khi ghép 10 sheet (20 trang), artifact thật có 10 OCG `AUDIT_GROUP`, nhưng trang CUT 1–5 trỏ group riêng; trang CUT 6–10 đều trỏ cùng `objgen (51)` — group của sheet cuối. `/Order` vẫn có 10 cây nên nhìn bề ngoài hợp lệ, nhưng bật/tắt hoặc chọn layer trong Illustrator có thể tác động nhầm sheet khác và plugin không còn phân biệt được group theo trang.

Đây không phải lỗi mất toàn bộ layer như §RE.1, nhưng là lỗi cấu trúc quan trọng với file Sticker/Page Sheet nhiều sheet. Cần remap theo object identity/ref, không dùng tên làm khóa duy nhất; hoặc chủ động canonicalize một OCG dùng chung nếu đó mới là hợp đồng.

### §PONTLAYER.RE.5 — P2 — `/NM` hiện là metadata PDF, chưa chứng minh là tên object native Illustrator

**Trạng thái:** `[RUNTIME UNVERIFIED]`

Ngay cả sau khi OCG được khôi phục, `/NM`/marked-content là hợp đồng PDF. Chưa có smoke Illustrator/Graphtec Studio để chứng minh nó được nhập thành tên object native hay chỉ còn metadata. Đây là khoảng trống hợp đồng, không được tuyên bố là đã hỗ trợ hoàn toàn.

## 5. Những điểm đã kiểm và không phải nguyên nhân chính

- `pdfOptionalContent.ts` hiện giữ `/OCGs`, `/D/Order`, ON/OFF và OCG rỗng liên quan; 88 test frontend đang xanh.
- `stamp_reports_on_pdf()` không xóa OCG trong artifact CNC legacy probe.
- Artifact lease/path hiện công bố đúng `output_path`; tiến trình debug đang chạy từ `D:\pdfcompare\desktop\src-tauri\target\debug\pdf-inspector.exe`.
- CNC legacy vẫn đạt cây OCG và item name cho cả simplex/duplex; đây là đối chứng quan trọng để không sửa nhầm helper chung.
- Màu `(1,1,1,1)` hiện được ghi dưới dạng DeviceCMYK rich black (`k/K`). Đây là quyết định màu cần xác nhận với máy/qui trình Graphtec; audit này chưa đổi nó thành finding vì chưa có yêu cầu “Registration spot” rõ ràng và chưa có test tách màu vật lý.

## 6. Verify đã chạy

- Backend: `tests/test_pont_config_and_cnc_naming.py` + `tests/test_page_sheet_imposition.py`: **37 passed**.
- Backend: `tests/test_nesting_imposition_render.py` + `tests/test_nesting_finishing_parity.py`: **71 passed**.
- Frontend: `OpenInDesignModal.test.tsx`, `pdfOptionalContent.test.ts`, `processHandlers.test.ts`: **88 passed**.
- Frontend mở rộng Sticker/Page Sheet/CNC: `trueShapeNestingRollout.test.tsx`, `ImposerDashboard.groupingParity.test.tsx`, `pageSheetPolicy.test.ts`, `savePrintFiles.nativePath.test.ts`: **86 passed**.
- Frontend sau hotfix Win32: `OpenInDesignModal.test.tsx` **11 passed**; tổng focused OCG/page-plan/process **187 passed**.
- Frontend typecheck: `npm run typecheck` hoàn tất không lỗi.
- Artifact probe true-shape: **tái hiện `ocprops=False`** như §2.2.
- Artifact đối chứng legacy: Sticker và Page Sheet cùng giữ OCG Graphtec/layer/group; CNC legacy giữ OCG cả sau report stamp.
- Artifact multi-sheet legacy: `audit_multi_sticker_small.pdf` có 10 OCG `AUDIT_GROUP`, nhưng 5 trang CUT cuối cùng cùng trỏ `objgen (51)` của sheet cuối — bằng chứng cho §PONTLAYER.RE.7.

Chưa đạt `RUNTIME`: Computer Use không trả về cửa sổ ứng dụng trong phiên này; chưa thao tác được full flow trên app có license hợp lệ và chưa mở PDF bằng Illustrator/Graphtec Studio/plugin thật. Không có kết luận “đã hết lỗi” ở mức downstream.

## 7. Đề xuất lô sửa sau khi duyệt

### Lô A — Writer true-shape (tối đa 5 file)

1. `backend/app/workers/nesting_imposition_render.py`: tạo OCG Graphtec/layer/group theo bundle; bọc từng mark/guide bằng `/OC` và `/NM`; dựng `/OCProperties` + `/D/Order` hợp lệ cho **Sticker simplex**, CNC simplex/duplex, front/cut và multi-sheet.
2. `backend/tests/test_nesting_imposition_render.py`: thêm artifact assertions cho ba shape, Graphtec on/off, Sticker simplex, CNC simplex/duplex, Page Sheet legacy và nhiều sheet; parse `/OCProperties`, `/Order`, page resource refs và `/NM`.
3. `backend/tests/test_nesting_finishing_parity.py`: thêm ca Sticker và CNC `run_true_shape_nesting()` trên file nguồn thật và assert tên layer/item trong PDF ghi cuối cùng.
4. `backend/app/workers/nup_output_finalize.py` + test artifact nhiều chunk: khóa remap OCG theo ref/identity, không dồn group trùng tên giữa các sheet.

### Lô B — File tách + downstream smoke (tối đa 5 file)

1. `desktop/src/lib/savePrintFiles.ts`: quyết định/chốt policy giữ OCG rỗng cho file `(cut).pdf`.
2. `desktop/src/lib/savePrintFiles.nativePath.test.ts` hoặc test mới: parse file ghi thật, không chỉ kiểm PDF header.
3. `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx` + `desktop/src/lib/printFileNaming.ts`: khóa page plan homogeneous/shared-cut (CUT cuối file), không chọn nhầm artwork.
4. Smoke app thật + Illustrator/Graphtec Studio: xác nhận cây layer và mapping `/NM` trên Sticker thường, homogeneous, Page Sheet và CNC.

Chỉ bắt đầu sửa sau khi user duyệt findings/lô. Mỗi lô tối đa 5 file code/test và phải verify artifact trước khi sang lô kế.

## 9. Kết quả sau khi user yêu cầu xử lý

Đã triển khai Lô A và Lô B:

- §PONTLAYER.RE.1A/1B: writer true-shape nay ghi cây OCG Graphtec/layer/group và `/NM` item trên đúng side.
- §PONTLAYER.RE.2: artifact true-shape sau khi tách “Chỉ trang khuôn” giữ lại OCG nhờ nguồn đã có catalog.
- §PONTLAYER.RE.6: modal/save-plan nhận diện CUT chung ở cuối file homogeneous.
- §PONTLAYER.RE.7: merge nhiều chunk giữ ref OCG riêng theo trang dù tên trùng.
- §PONTLAYER.RE.4: file CUT tách riêng bật giữ OCG rỗng liên quan.
- Hardening bổ sung: `pontType` lạ bị từ chối; guide mang `/NM` item; path native không parse blob sentinel; output không có CUT riêng vẫn mở đúng trang hiện tại.
- Lỗi mới từ smoke người dùng `0x8007007b`: `originalName` chưa sanitize khi tạo tên PDF tạm; đã sửa tại `OpenInDesignModal` và khóa bằng regression.

Log triển khai: `docs/OC_LAYER_ILLUSTRATOR_FIXES_2026-09-08.md`.  
Mức bằng chứng sau sửa: `AUTO + ARTIFACT`; chưa nâng `RUNTIME` vì chưa mở được artifact trong Illustrator/Graphtec Studio thật.

## 8. Câu hỏi cần chốt khi duyệt

1. Có cho phép dùng true-shape trong bản dev/CNC hiện tại không, hay tạm ép CNC về legacy cho tới khi writer mới có OCG?
2. `itemName` cần hiện thành object name native trong Illustrator, hay chỉ cần `/NM`/layer Graphtec trong PDF?
3. File tự động lưu `(cut).pdf` có bắt buộc giữ cả Graphtec info/layer cha rỗng không?
