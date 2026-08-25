# BÁO CÁO AUDIT HỢP ĐỒNG REVISION XUYÊN CÔNG CỤ — 2026-08-25

## 1. Kết luận điều hành

Hợp đồng người dùng cần được khóa là:

> **Viewer đang hiển thị revision nào thì công cụ kế tiếp phải nhận đúng revision đó; kết quả cũ không được ghi đè revision mới và artifact còn đang được tab giữ không được tự biến mất.**

Audit trên cây mã đang làm việc xác nhận lỗi “xoay rồi Bù xén vẫn lấy dữ liệu gốc” không phải một trường hợp đơn lẻ. Có **13 nhóm hợp đồng cần xử lý**, gồm các đường chạy đã xác nhận và một số nhánh còn ở mức nghi vấn. Rủi ro tập trung ở năm biên:

1. state nhìn thấy trong Viewer (`pageOrder`, rotation theo từng instance, edit-object chưa commit);
2. nguồn phụ giữ song song (`sourceImageFile`, `selectionFileId`);
3. cache/upload không gắn với document identity;
4. job bất đồng bộ không mang expected revision khi trả kết quả;
5. file kết quả backend có TTL ngắn hơn vòng đời tab.

Không có bằng chứng cho thấy mọi công cụ đều sai. Nhiều luồng đã dùng `useWorkingPdf()` hoặc `getWorkingBytes()` đúng. Vì vậy báo cáo phân biệt `CONFIRMED`, `SUSPECTED`, `DISPROVED` và `EXPECTED`; **1.048 hit scanner không được tính là 1.048 bug**.

Mức hiện tại của audit unit là `TRACED + AUTO-PARTIAL`. Chưa đủ để tuyên bố an toàn end-to-end vì chưa chạy ma trận Tauri/runtime và chưa có artifact chain dài hạn qua TTL.

> **Cập nhật triển khai 2026-08-25:** sau chốt duyệt, cả 13 nhóm §REV.01–§REV.13
> đã có bản sửa theo lô và regression tự động tương ứng. Các finding bên dưới được
> giữ nguyên làm baseline trước sửa; trạng thái mới và bằng chứng nằm trong
> `HOP_DONG_REVISION_CONG_CU_FIXES_2026-08-25.md`. Audit unit vẫn là
> `AUTO-PARTIAL`, chưa nâng `RUNTIME`: chưa chạy chuỗi thao tác trên Tauri thật,
> chưa mô phỏng app sleep/restart dài hạn với tài liệu khách và fingerprint nhẹ
> không thay thế snapshot/hash tuyệt đối.

## 2. Phạm vi và revision authority

Phạm vi đã truy vết:

- nguồn đang mở: `File`, native `path`, Blob và ảnh nguồn;
- thao tác trang: xóa, nhân bản, sắp lại, xoay theo từng instance;
- edit-object in-memory, Crop và Extract;
- tool PDF trực tiếp, bình trang, AI-sheet, Recipe, Undo và Recovery;
- output native-path của N-up/VDP/Edit và vòng đời cleanup backend;
- chuyển công cụ khi thao tác trước chưa commit hoặc job trước chưa hoàn tất.

Nguồn chuẩn hiện có:

- `desktop/src/hooks/useWorkingPdf.ts:41-126` materialize `viewerPageOrder + viewerPageRotations`, giữ nguyên `.path` khi revision là identity và tạo `File` bytes mới khi cần bake.
- `desktop/src/stores/useWorkspaceStore.ts:21-36` định nghĩa identity file/document theo file, page order và rotation.
- Viewer và panel công cụ cùng tồn tại trong `desktop/src/components/ImpositionTab.tsx:3794-3819` và `desktop/src/components/ImpositionTab.tsx:3962-4113`; vì vậy người dùng có thể đổi trang trong khi panel đã giữ cache/input.
- thao tác xoay/xóa thumbnail vẫn reachable từ `desktop/src/components/AcrobatViewer.tsx:1261-1271` và `desktop/src/components/acrobat/ThumbSidebar.tsx:650-670`.

Một revision đầy đủ trong phạm vi hiện tại phải có tối thiểu:

```text
file/blob/path
+ pageOrder
+ pageInstanceIds
+ rotations theo vị trí/instance
+ edit-session revision hoặc artifact đã commit
+ nguồn ảnh owner tương ứng
+ generation/expected revision của job
+ lease của artifact backend
```

PrynX hiện chưa có state **lật trang ở cấp Viewer**. Do đó yêu cầu “lật” chỉ được xem là đã an toàn nếu thao tác lật là một tool tạo Working File mới. Nếu bổ sung quick-flip giống quick-rotate, bắt buộc thêm flip vào document identity, materializer, cache key, recovery, undo và generation fence; hiện chưa thể đánh dấu parity cho capability chưa tồn tại.

## 3. Phương pháp và thang bằng chứng

Audit đi dọc từ producer state → resolver Working PDF → upload/path → handler/worker → commit → Viewer/Undo/Recovery, đồng thời quét các consumer đi tắt qua `pdfFile`, `sourceImageFile`, `fileId`, native path hoặc fallback raw bytes.

| Nhãn | Cách dùng trong báo cáo |
|---|---|
| `CONFIRMED` | Có đường chạy production xác định làm mất/sai revision, không cần suy đoán từ tên hàm. |
| `SUSPECTED` | Có drift hợp đồng hợp lý nhưng cần runtime/fault injection để chứng minh output sai. |
| `DISPROVED` | Pattern nhìn đáng ngờ nhưng code hiện đã resolve/materialize Working revision đúng. |
| `EXPECTED` | Dùng nguồn gốc là chủ đích của loại tool, hoặc chỉ là producer state chưa tạo artifact. |

Severity dùng P1/P2, không nâng hàng loạt lên P0: các lỗi cần chuỗi thao tác cụ thể, nhưng có thể làm output in sai hoặc mất thay đổi mà UI vẫn báo thành công.

## 4. Inventory tổng hợp

| Nhóm | Trạng thái | Kết quả audit |
|---|---|---|
| Working PDF nền tảng | `DISPROVED` lỗi chung | `useWorkingPdf()` xử lý order/rotation theo vị trí đúng; identity-prefix đã kiểm source page count. |
| Shuffle, Trim & Shift, Split, Merge | `DISPROVED` | Dùng `getWorkingBytes()` tại `processHandlers.ts:668-760`, `1201-1209`, `1298-1342`, `1374-1399`. |
| Bình N-up preview/output | `DISPROVED` về input revision | Preview fail-closed tại `GridPreview.tsx:1062-1165`, key gồm order/instance/rotation tại `ImposerDashboard.tsx:490-500`; output materialize tại `processHandlers.ts:256-263`. Vẫn còn finding TTL/job ở §REV.03/§REV.11. |
| Sticker một tem | `DISPROVED` | Preview/execution dùng Working PDF tại `StickerTool.tsx:460-464`, `562-566`, `599-619`. |
| Font, Ink, Convert Colors | `DISPROVED` | Có document identity/Working resolver tại `FontToolsTool.tsx:139-147,228-242`, `InkManagerTool.tsx:51-78`, `ConvertColorsTool.tsx:408-415,532-560`. |
| OCR, Optimize, Watermark, Encrypt, Metadata | `DISPROVED` | Dùng Working PDF tại `OcrTool.tsx:41-55`, `OptimizeTool.tsx:56-86`, `WatermarkTool.tsx:137-155`, `EncryptTool.tsx:35-58,97-115`, `MetadataTool.tsx:36-47,88-100`. |
| Data Merge, Numbering, Header/Footer | `DISPROVED` | Template/materialization đúng tại `DataMergeTool.tsx:1048-1059,1286-1315`, `NumberingTool.tsx:320-331`, `StickTextNumberTool.tsx:92-102`. |
| Page Tools | `EXPECTED` | Là producer của page order/rotation, chưa phải consumer artifact: `PageToolsPanel.tsx:57-74`. |
| Office Convert, Logo Rebuild, Background Remover độc lập | `EXPECTED` | Dùng Office/ảnh nguồn theo thiết kế; không được suy rộng sang trường hợp ảnh đã normalize thành PDF rồi tiếp tục sửa Viewer. |
| Preflight/PDF-X/Hairline/Trap/Crop | `CONFIRMED/SUSPECTED` | Resolver ban đầu đúng nhưng cache `fileId` không scope theo page revision; xem §REV.02 và §REV.04. |
| AI-sheet Tách nhiều tem | `CONFIRMED` | Giữ page order nhưng bỏ rotation; xem §REV.05. |
| Upscale/Làm trắng scan với ảnh nguồn | `CONFIRMED` | `sourceImageFile` có thể che revision PDF đang thấy; xem §REV.06. |
| Extract/Undo/Recovery | `CONFIRMED` | Mất instance/edit/page-state ở các biên; xem §REV.07–§REV.08. |
| Resize/Recipe fallback | `CONFIRMED` | Fail-open về backing file; xem §REV.09. |
| Cover Numbering/Resize inspect | `CONFIRMED/SUSPECTED` | Metadata/range lấy raw file dù execution dùng Working PDF; xem §REV.12. |

## 5. Findings có bằng chứng

### §REV.01 — P1 / CONFIRMED — Edit-object dirty không có commit barrier trước tool kế tiếp

`useEditSession` giữ thao tác trong RAM và chỉ công bố `dirty` (`desktop/src/hooks/useEditSession.ts:306`, `333-336`). `buildProcessContext.getWorkingBytes()` chỉ bake page order/rotation bằng `applyAcrobatEdits`; nó không commit edit session (`desktop/src/components/ImpositionTab.tsx:2194-2214`). Hợp đồng `ProcessingContext` cũng không có pre-run edit barrier (`desktop/src/lib/processHandlers/types.ts:455-459`).

Sticker trực tiếp gọi `useWorkingPdf()` (`desktop/src/components/preprocess-tools/StickerTool.tsx:258`, `460-464`, `605-607`), nên chuỗi **sửa object nhưng chưa commit → chuyển Sticker/Resize/N-up** có thể chạy trên backing PDF. Sau khi tool publish, `commitWorkingFile` thay file và reset page state/cache (`desktop/src/components/ImpositionTab.tsx:1335-1359`); một commit edit cũ về sau còn có thể trở thành last writer.

Save, Print và New Window đã có explicit barrier (`ImpositionTab.tsx:1811-1817`, `3042-3051`, `3321-3324`), chứng minh generic tool path đang thiếu cùng một hợp đồng chứ không phải không thể triển khai.

### §REV.02 — P1 / CONFIRMED — Crop có cả transition race và stale `file_id`

Khi chuyển sang Crop, effect đồng bộ tắt Object Edit và bật Crop (`ImpositionTab.tsx:599-617`) nhưng không await edit commit. Trong lúc đó `ensureCropFileId()` có thể materialize/upload ngay (`ImpositionTab.tsx:1410-1418`; `AcrobatViewer.tsx:339-350`). Phiên edit khởi tạo/đóng bất đồng bộ tại `AcrobatViewer.tsx:612-650`, nên Crop có thể chụp input trước commit cuối.

Sau lần upload đầu, `CropDialog` giữ `fileId` cục bộ (`CropDialog.tsx:145`, `293-296`) và Apply dùng lại `fileId || ensureFileId` (`CropDialog.tsx:571-573`). Menu App vẫn cho xoay khi Crop mở (`App.tsx:1183-1187`, `1366-1367`), listener Viewer không guard `isCropMode` (`AcrobatViewer.tsx:1286-1322`). Vì thế chuỗi **mở Crop → xoay/xóa/sắp trang → Apply** có thể gửi ID của revision trước.

### §REV.03 — P1 / CONFIRMED — Job cũ có thể commit sau revision mới

`commitWorkingFile()` có vé Recipe nhưng không nhận `expectedDocumentIdentity`/revision (`ImpositionTab.tsx:1185-1200`). Sau các await tạo path/file (`1248-1283`), nó chỉ kiểm lại vé Recipe rồi publish file và reset state (`1286-1359`). Vé đó không chứng minh document revision vẫn là revision lúc job bắt đầu.

Các hotkey/page command vẫn có đường đổi order/rotation trong khi tool chạy (`desktop/src/hooks/viewer/useViewerHotkeys.ts:173-195`; `AcrobatViewer.tsx:1261-1271`). Chuỗi **start job A → xoay/xóa/reorder B → A trả về** có thể khiến A ghi đè B mà không cảnh báo.

### §REV.04 — P1 / CONFIRMED — Cache upload scope theo `File`, không scope theo page revision

- Preflight chỉ reset cache khi `pdfFile` đổi và trả ngay `fileId` cũ: `PreflightTool.tsx:124-138`.
- Save PDF/X có cùng pattern: `SavePdfxTool.tsx:136-161`; Check và Export dùng cùng ID tại `163-167`, `194-198`.
- Hairlines và Trap Presets có cùng hợp đồng retry/cache: `HairlinesTool.tsx:64-79,104-107`, `TrapPresetsTool.tsx:36-50,68-71`.

Page order/rotation thay đổi không đổi object `pdfFile`, nên **Inspect/Check → xoay/xóa/reorder → Run/Export** có thể chạy trên upload cũ. Preflight/PDF-X là đường xác định; Hairline/Trap cần thêm runtime regression để đo nhánh người dùng thực tế nhưng cùng lỗi ownership.

### §REV.05 — P1 / CONFIRMED — Tách nhiều tem bỏ rotation của Working revision

Router truyền `activeSourcePage`, `activeWorkingPage`, `pageOrder` nhưng không truyền rotations (`PreprocessingRouter.tsx:291-305`). `StickerCutlineTool` chọn raw `pdfFile || sourceImageFile` (`StickerCutlineTool.tsx:84-106`) và export chỉ nhận `pageOrder` (`108-109`, `134-135`).

Vì vậy page order có thể đúng nhưng quick-rotate chưa bake không đi tới detection/export. Đây chính là cùng họ lỗi người dùng đã gặp với xoay → Bù xén, nhưng nằm ở mode AI-sheet. Sticker một tem không có lỗi này như đã ghi ở inventory.

### §REV.06 — P1 / CONFIRMED — Ảnh nguồn “shadow” thắng PDF revision đang hiển thị

Workspace giữ `sourceImageFile` song song với PDF normalize/Working File (`ImpositionTab.tsx:847-886`, `2074-2098`). Upscale ưu tiên `sourceImageFile || pdfFile` (`UpscaleTool.tsx:467-488`). Document Cleanup cũng ingest theo thứ tự đó (`DocumentCleanupTool.tsx:604-620`); resolver Working PDF của nó chỉ áp dụng cho nhánh PDF (`307-323`, gọi tại `762-766`).

Chuỗi **mở ảnh → Viewer tạo PDF → xoay/reorder/crop PDF → Upscale/Làm trắng scan** có thể xử lý ảnh nguyên thủy, không phải revision đang thấy. Đây không phải lỗi khi tool được mở độc lập trên một ảnh chưa từng đi qua PDF Viewer.

### §REV.07 — P1 / CONFIRMED — Extract làm mất instance identity và edit pending

Viewer biến vị trí chọn thành số trang nguồn trước khi gọi callback (`AcrobatViewer.tsx:1475-1489`). Backend frontend Extract đọc backing `file` (`ImpositionTab.tsx:3397-3403`) và với trang nguồn bị duplicate, rotation được lấy bằng `viewerPageOrder.indexOf(pIdx)` (`3410-3427`), luôn chọn instance đầu tiên.

Do đó hai bản nhân cùng nguồn nhưng xoay khác nhau có thể được Extract với góc sai. Đường này cũng không có edit-session barrier, nên edit-object pending không được đảm bảo đi vào file tách.

### §REV.08 — P1/P2 / CONFIRMED — Undo và Recovery không lưu đủ revision

History generic chỉ là `File[]` (`useWorkspaceStore.ts:222-227`). `commitWorkingFile` lưu backing File vào history rồi reset page order/rotation (`ImpositionTab.tsx:1295-1324`, `1353-1355`). `handleUndo` phục hồi File nhưng tiếp tục đặt `viewerPageOrder` và `viewerPageRotations` về `undefined` (`1873-1929`).

Vì vậy **rotate/reorder/delete → chạy tool → Undo** không chắc trở về đúng màn hình ngay trước tool; page-only Undo trong Viewer là đường riêng và đúng (`useViewerHotkeys.ts:159-168`, `197-236`), không bác bỏ finding generic này.

Recovery tính `editSessionDirty` vào trạng thái dirty (`ImpositionTab.tsx:1089-1109`) nhưng snapshot chỉ ghi path, order, rotations và VDP (`1121-1165`; schema `desktop/src/lib/recovery.ts:16-29`), không ghi edit ops hoặc artifact đã commit. Đây là P2: crash/restart sau edit-object pending có thể hiện phiên khôi phục nhưng không khôi phục nội dung edit.

### §REV.09 — P1 / CONFIRMED — Resize và Recipe fail-open về backing file

Resize bắt lỗi `getWorkingBytes()` rồi gọi backend bằng `file` gốc (`processHandlers.ts:1090-1107`). Recipe playback cũng bắt lỗi materialize và đọc `getFileArrayBuffer(file)` (`ImpositionTab.tsx:2460-2469`).

Đây là fallback sai hợp đồng: khi materialization thất bại, không có bằng chứng backing file tương đương Viewer. Hai nhánh phải fail-closed hoặc dùng snapshot đã chứng minh đúng revision; hiện tại có thể âm thầm cho output thành công nhưng mất xoay/xóa/reorder.

### §REV.10 — P1 / CONFIRMED — `selectionFileId` có identity nhưng consumer vẫn dùng ID stale

Store đã có `selectionDocumentIdentity` và setter bind identity (`useWorkspaceStore.ts:27-36`, `877-899`), nhưng thay đổi page order/rotation không invalidate ID (`612-626`). Object Edit pre-upload và fetch chỉ kiểm `selectionFileId` có rỗng hay không (`ImpositionTab.tsx:724-742`, `1489-1533`), chưa so identity hiện tại.

Các page edit reachable tại `AcrobatViewer.tsx:539-553`, `1029-1034`, `1248-1271`, `1431-1455`. Vì vậy ID có metadata đúng về mặt lưu trữ nhưng consumer chưa thực thi generation fence; Object Edit/layer/object cache có thể tiếp tục đọc revision trước.

### §REV.11 — P1 / CONFIRMED — Working artifact có TTL ngắn hơn vòng đời tab

Output N-up và VDP được frontend dùng trực tiếp bằng native path (`processHandlers.ts:397-408`; `api.ts:617-630`) nhưng backend dọn job/output sau 1 giờ (`backend/app/api/routes/imposition.py:530-555`; `backend/app/api/routes/vdp.py:75-102`). Probe cô lập trong đợt audit xác nhận hai file thực sự bị xóa.

Working File của Edit được đăng ký TTL 24 giờ (`backend/app/api/routes/edit.py:271-303`); filesystem orphan cleanup dùng 26 giờ và chạy mỗi 30 phút (`backend/app/core/cleanup.py:22-27`, `241-269`). `getFileArrayBuffer()` ưu tiên `.path` và không fallback sang Blob nếu path đã mất (`desktop/src/lib/utils.ts:28-35`).

Do đó tab còn mở không đồng nghĩa artifact còn sống. Chuỗi **N-up/VDP/Edit → giữ tab qua TTL → Save/tool kế tiếp/Undo** có thể hỏng hoặc mất revision. Cần lease theo owner/tab, không chỉ tăng TTL cố định.

### §REV.12 — P1/P2 / CONFIRMED-SUSPECTED — Metadata/range vẫn đọc raw file

Cover Numbering đếm `totalPages` bằng raw `pdfFile` (`CoverNumberingTool.tsx:84-99`) nhưng tạo output từ Working File (`186-203`). Sau delete/duplicate/reorder, validation/range có thể lệch dù template artifact đúng; đây là P1 ở lớp lựa chọn trang.

Page Resizer inspect transparency dùng raw `pdfFile/nativePath` (`PageResizerTool.tsx:74-97`), trong khi execution dùng Working bytes/path (`processHandlers.ts:820`, `982-997`, `1090-1097`). Đây là P2 `SUSPECTED` cho UI/policy: chưa có artifact chứng minh resize output sai ngoài nhánh fail-open §REV.09.

### §REV.13 — P2 / SUSPECTED — N-up queued direct-path chưa snapshot input

Khi đủ điều kiện native-path, request N-up giữ đường dẫn đến lúc worker trong hàng đợi mở file (`backend/app/api/routes/imposition.py:759`, `902`). Nếu file ngoài app bị thay đổi trong thời gian chờ, worker có thể đọc bytes khác revision lúc bấm chạy. Chưa có fault-injection runtime chứng minh trên Tauri, nên giữ ở `SUSPECTED`, không dùng để chặn các nhánh N-up đã upload/bake.

## 6. Ma trận chuỗi thao tác bắt buộc

| Chuỗi thao tác | Revision mong đợi | Hiện trạng | Finding | Bằng chứng |
|---|---|---|---|---|
| Inspect Preflight → xoay thumbnail → Run Pipeline | upload sau xoay | dùng cached ID trước xoay | §REV.04 | `CONFIRMED` |
| Check PDF/X → xóa/reorder → Export | artifact sau xóa/reorder | dùng cached ID từ Check | §REV.04 | `CONFIRMED` |
| Mở Crop → xoay/xóa → Apply | revision lúc Apply | dialog giữ ID lúc mở | §REV.02 | `CONFIRMED` |
| Edit object dirty → chuyển Sticker/Resize/N-up | edit + page state mới nhất | generic resolver không commit edit | §REV.01 | `CONFIRMED` |
| Edit object dirty → mở Crop ngay | edit commit xong rồi mới upload Crop | hai transition chạy không có await barrier | §REV.02 | `CONFIRMED` |
| Start job A → xoay/reorder B → A trả về | A bị reject hoặc hỏi người dùng | A có thể publish đè B | §REV.03 | `CONFIRMED` |
| Mở ảnh → xoay Viewer → Upscale/Làm trắng scan | PDF revision đang thấy | ảnh nguồn shadow thắng | §REV.06 | `CONFIRMED` |
| Duplicate cùng trang, xoay hai instance khác nhau → Extract | đúng instance/góc từng bản | `indexOf` lấy instance đầu | §REV.07 | `CONFIRMED` |
| Rotate/reorder → tool commit → Undo | revision ngay trước tool | phục hồi File, xóa page state | §REV.08 | `CONFIRMED` |
| Edit dirty → crash/restart | edit ops + page state | chỉ path/order/rotation/VDP | §REV.08 | `CONFIRMED`, P2 |
| Resize materialization lỗi | dừng, không output stale | fallback raw `file` | §REV.09 | `CONFIRMED` |
| Recipe materialization lỗi | dừng, không phát step trên stale input | fallback raw `file` | §REV.09 | `CONFIRMED` |
| AI-sheet → xoay trang → detect/export | order + rotation | chỉ truyền order | §REV.05 | `CONFIRMED` |
| N-up/VDP/Edit result giữ quá TTL → tool/Save | artifact còn sống khi tab giữ owner | backend tự xóa | §REV.11 | `CONFIRMED` + probe |
| N-up xếp hàng bằng direct path → file ngoài app đổi | snapshot tại lúc bấm chạy | worker mở path muộn | §REV.13 | `SUSPECTED` |
| Quick-flip tương lai → tool kế tiếp | flip nằm trong identity/materializer | chưa có capability/state | gap thiết kế | `EXPECTED` chưa phủ |

## 7. Baseline tự động và test gap

Baseline trong đợt audit:

- 5 file Vitest liên quan: **100 test passed**.
- Self-test của contract scanner: **17 passed**.
- Scanner đọc **1.400 file**, phát **1.048 ứng viên `[SUSPECTED]`**.

Giới hạn diễn giải: 1.048 là hit heuristic cần triage, không phải finding, severity hay build gate. Các finding ở §5 chỉ được ghi khi có đường chạy cụ thể.

Test còn thiếu:

- integration mount Viewer + panel và thay order/rotation sau khi panel đã cache ID;
- edit-session barrier khi chuyển mọi generic tool, gồm last-writer race;
- generation fence với job trả kết quả ngoài thứ tự;
- duplicate instance có rotation khác nhau qua Extract;
- Undo snapshot gồm file + page state + image owner;
- Recovery có edit artifact/journal hoặc fail-closed rõ ràng;
- Resize/Recipe fault injection khi materializer ném lỗi;
- artifact owner lease qua mốc 1h/24h và restart backend;
- Tauri runtime cho native path, queued N-up và file bị thay đổi ngoài app;
- page-level flip nếu capability được bổ sung.

Chưa chạy trong audit này: Tauri click-smoke toàn ma trận, artifact PDF reopen/fingerprint xuyên nhiều tool và phép thử chờ TTL thật. Vì vậy không nâng toàn audit lên `AUTO`, `ARTIFACT` hoặc `RUNTIME`.

## 8. Kế hoạch sửa theo lô an toàn

Mỗi lô tối đa 5 file production/test và phải verify hẹp trước khi sang lô tiếp theo.

### Lô A — Revision authority và commit generation fence

- `useWorkspaceStore.ts`: revision token/snapshot có file + order + instance + rotation + edit revision.
- `useWorkingPdf.ts`: resolver nhận snapshot bất biến, không đọc closure trôi.
- `ImpositionTab.tsx`: `commitWorkingFile(expectedRevision)` reject kết quả stale.
- test store/materializer/job out-of-order.

### Lô B — Edit barrier và Crop

- shared `ensureEditCommittedBeforeTool()`.
- transition Object Edit → Crop phải await barrier.
- Crop cache gắn document identity; page edit phải abort/invalidate request cũ.
- test mở Crop rồi rotate/delete/reorder.

### Lô C — Upload cache theo document identity

- Preflight, Save PDF/X, Hairlines, Trap Presets dùng `{fileId, documentIdentity}` hoặc shared upload cache.
- request đang bay phải có generation/AbortController.
- test Check/Inspect → page edit → Execute.

### Lô D — Instance/source ownership

- AI-sheet nhận Working PDF hoặc đủ order + rotation + instance.
- Upscale/Document Cleanup chỉ dùng image shadow khi identity chứng minh Viewer vẫn đang ở revision ảnh đó.
- Extract truyền vị trí/instance, commit edit trước khi tách.
- test duplicate rotation và image → rotate → tool.

### Lô E — Undo và Recovery

- history entry là revision snapshot, không chỉ `File`.
- Undo phục hồi page state/image owner/cache identity nguyên tử.
- Recovery lưu artifact/journal edit an toàn hoặc công bố rõ không thể recovery và fail-closed.

### Lô F — Fail-closed fallback

- Resize bỏ fallback backing file khi Working materialization lỗi.
- Recipe dừng step thay vì đọc raw file.
- Cover/Resize inspect dùng cùng working snapshot với execution.
- fault-injection test bắt buộc không publish output stale.

### Lô G — Artifact lease backend

- owner/lease cho N-up, VDP, Edit Working File khi tab còn giữ artifact.
- release khi file bị thay, Undo entry bị loại hoặc tab đóng.
- `getFileArrayBuffer` báo lỗi mất artifact có ngữ cảnh; chỉ fallback Blob khi bytes được chứng minh cùng identity.
- probe TTL rút ngắn trong test, không chờ một giờ thật.

### Lô H — Runtime và artifact acceptance

- chạy toàn bộ ma trận §6 trên Tauri Windows;
- fingerprint page count/order/rotation/content trước và sau mỗi tool;
- giữ tab qua restart backend và TTL giả lập;
- chỉ nâng audit unit khi runtime/artifact chứng minh được contract.

## 9. Chốt duyệt

Khuyến nghị triển khai theo thứ tự **A → B → C → D → E → F → G → H**. Lô A/B xử lý nền tảng gây tái phát; sửa riêng từng tool trước khi có revision authority sẽ tiếp tục tạo cache/race mới.

**CHỜ DUYỆT. Audit này chưa sửa production, chưa build, chưa commit và chưa push.**
