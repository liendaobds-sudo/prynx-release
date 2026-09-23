# BÁO CÁO AUDIT TOÀN DIỆN BÌNH SÁCH / TẠP CHÍ — 2026-09-23

> Trạng thái: Giai đoạn 1 — khảo sát, truy vết và chứng minh; chưa sửa mã.
> Audit chạy trên HEAD 703ffc2 và worktree đang có 90 thay đổi chưa commit. Các thay đổi
> có sẵn được giữ nguyên, không dùng làm lý do để kết luận lỗi nếu chưa nối được vào đường chạy.

## 1. Phạm vi và tiêu chí

Audit bao phủ đường Bình sách/Tạp chí từ UI đến PDF thật:

- năm kiểu đóng: saddle, thread, continuous, cut_stacks, flush_mount;
- 1-up, fit, Step & Repeat và Cut & Stack;
- chia tép, trang trắng, bù gáy, lề/dấu gia công, xoay trang;
- preset, report sách/tạp chí, xem thành phẩm, xem bài in;
- backend execute-plan-json, scheduler, PlanExecutor, artifact PDF và consumer mở lại;
- nhánh Offset/Auto Catalog được kiểm riêng dưới trạng thái dormant, vì
  HIDE_OFFSET_BOOKLET=true hiện khóa đường vào UI.

Không dùng báo cáo 2026-07-31 để lặp lại các mục đã sửa. Lô cũ đã được đối chiếu lại:
chặn flush_mount + cut_stack, padding continuous bội 4, loại dấu giữa và test
page-order hiện đều có regression hiện hành.

## 2. Đường chạy đã trace

1. UI → settings: BookletSettingsSection.tsx:45-60,63-81,124-140 đọc/ghi kiểu đóng,
   folio, scale mode; ImposerDashboard.tsx:1607-1630 dựng payload;
   ImpositionTab.tsx:3165-3266 dựng map, hộp xác nhận và gọi engine.
2. Planner → backend: pdfImposer.ts:548-567 chuẩn hóa mode; pdfImposer.ts:617-789
   dựng VirtualMap, remap pageOrder, serialize instruction; pdfImposer.ts:797-837
   gọi /api/imposition/execute-plan-json.
3. Backend sink: imposition.py:152-199 validate path/entitlement và gọi PlanExecutor;
   plan_executor.py:172-237 render phase-2 hoặc front/back; plan_executor.py:245-269
   thêm bìa tách; plan_executor.py:277-369 ghi và trả artifact.
4. Preview: FlipbookDialog.tsx:115-197 dùng generateBindingMap; SheetViewerDialog.tsx:493-536
   dựng map/sheet preview và computeDigitalPreviewGrid dùng SSOT grid ở
   InstructionSerializer.ts:429-467.

## 3. Ma trận bằng chứng hiện tại

| Audit unit | Bằng chứng | Trạng thái |
|---|---|---|
| Map page-order 5 binding × page count biên | Vitest VirtualMap.test.ts + probe Node cho 19 page counts: không trùng/sót trang với blankPlacement=end | AUTO |
| blankPlacement=center + chia tép | Probe Node tái hiện blank ở logical 18–19 của tép 2 với tài liệu 34 trang | ARTIFACT-PARTIAL, finding mở |
| Serializer phase-2, marks, rotation, gutter | Vitest InstructionSerializer.phase2.test.ts 30+ ca trong suite mục tiêu | AUTO |
| PlanExecutor page-box/rotation/marks/report | Pytest test_plan_executor.py 44 pass; có raster, CMYK marks, ICC và report | ARTIFACT-PARTIAL — plan test chủ yếu hand-crafted |
| UI → payload → backend → artifact trong Tauri dev | Chưa thao tác app thật trong lượt này | UNKNOWN |
| Offset/Auto Catalog | Bị khóa bởi featureFocus.ts:12; không có click-through/runtime hiện hành | DORMANT / UNKNOWN |

## 4. Phát hiện đã xác nhận

### §BOOK.01 — Phase-2 không fail-closed khi khổ tờ nhỏ hơn spread — P0 / M

Đường chạy: BookletSettingsSection.tsx:124-140 cho chọn nhiều cuốn/Cut & Stack →
ImpositionTab.tsx:1607-1630 truyền khổ tùy chỉnh → pdfImposer.ts:705-752 vẫn dựng
phase-2 mà không kiểm tra fit → InstructionSerializer.ts:456-466 ép cols/rows >= 1
thay vì báo không vừa → plan_executor.py:195-214 nhận tọa độ âm và cắt ngoài trang.

Bằng chứng thực thi: probe TS với spread 1190.56×841.89 pt trên press sheet
566.93×566.93 pt phát placement đầu x=-311.815, y=-137.48, inBounds=false.
Chạy chính placement đó qua PlanExecutor tạo artifact 1134×1134 px có
dark_fraction=0.0 — nội dung bị mất, không có lỗi trả về.

Tác động: người dùng chọn khổ hợp lệ theo UI (UI chỉ chặn dưới 10 mm tại
PaperSettingsUI.tsx:174-184,283-287) nhưng nhận PDF trắng/mất artwork.

### §BOOK.02 — Trang trắng “Giữa sách” áp vào toàn tài liệu, không theo từng tép — P1 / M

Đường chạy: ImpositionTab.tsx:4175-4179 hứa chèn blank vào “ruột trong cùng” →
VirtualMap.ts:46-64 chèn toàn bộ blank vào một mảng logical chung →
VirtualMap.ts:160-203 mới chia tép thread.

Bằng chứng: generateBindingMap(34, 'thread', 16, 'center') cho blank tại logical
18–19, cả hai nằm ở đầu tép 2; chúng không nằm ở trung tâm vật lý của từng tép như
copy UI mô tả. Đây là dữ liệu mà serializeBookletPlan dùng trực tiếp cho output.

### §BOOK.03 — Engine tự gộp để vượt “Số trang mỗi tép/tay sách” — P1 / S

Đường chạy: BookletSettingsSection.tsx:63-81 hiển thị folio như số trang/tép →
VirtualMap.ts:170-177 đổi currentSigPageCount thành toàn phần còn lại nếu dư đúng
4 trang → VirtualMap.ts:181-212 ghi report nhưng vẫn serialize tay lớn hơn giá trị nhập.

Bằng chứng: generateBindingMap(20, 'thread', 16) trả 1 tép 20 trang và report
“tự động gộp 4 trang dư”. generateBindingMap(34, 'thread', 16, 'center') trả 20 + 16.
Consumer downstream dùng sigTotalSheets/signatureIndex của map này để dựng creep và
PDF; không có bước xác nhận thứ hai ngoài report.

### §BOOK.04 — Preset không tái lập đầy đủ một bài bình — P1 / M

Bằng chứng: ImposerDashboard.tsx:1810-1815 không lưu paperClassification,
separateCover, coverPageCount, bookReportDisplay hoặc autoCatalog; phần load ở
ImposerDashboard.tsx:1843-1851 cũng không reset các field vắng mặt, không xóa
foldPattern cũ và chỉ nạp gripperMargin khi truthy. Vì vậy cùng preset có thể chạy
khác Digital/Offset hoặc giữ state cũ về bìa/report/nhíp.

Proof gap: desktop/src/lib/presetManager.test.ts:4-35 chỉ khóa gutterMargin và
blankPlacement, chưa có round-trip assertion cho các field trên.

### §BOOK.05 — Đường Bình sách không có hủy cooperative — P1 / M

Bằng chứng: nhánh booklet ở processHandlers.ts:551-566 gọi thẳng imposePdfViaBackend;
chỉ nhánh N-Up đăng ký setCancelHandler tại processHandlers.ts:443-445.
Overlay Hủy chỉ render khi có handler (ImpositionTab.tsx:4246-4259). Backend route
imposition.py:152-195 chờ PlanExecutor.execute đến hết và không trả job_id/cancel
endpoint cho plan JSON.

Tác động: job PDF lớn tiếp tục giữ heavy slot, CPU/RAM và ghi artifact dù người dùng
muốn dừng; UI booklet không có nút Hủy tương ứng.

## 5. Phát hiện latent / khoảng trống cần chốt, chưa dùng làm P0/P1 hiện hành

### §BOOK.S1 — Auto Catalog Tauri có nguy cơ mất toàn bộ batch — [SUSPECTED] / dormant

featureFocus.ts:12 khóa Offset nên chưa reachable hiện tại. Nếu bật lại: runCatalogPlan
(processHandlers.ts:625-650) chỉ đếm blob.size; imposePdfViaBackend trên Tauri trả
blob 0 byte và outputPath (pdfImposer.ts:818-830), trong khi
imposeCatalogBatchViaBackend chỉ đưa blob vào CatalogBatchResult
(pdfImposer.ts:847-924). runCatalogPlan sau đó merge/filter chỉ blob > 0
(processHandlers.ts:651-703). Cần test installed/Tauri trước khi mở cờ.

### §BOOK.S2 — Lỗi stamp report bị nuốt — [FIXED Lô E1]

plan_executor.py:314-350 bắt mọi exception của stamp_reports_on_pdf, chỉ log warning rồi
trả output như thành công. Nếu report bật nhưng không stamp được, UI không nhận lỗi và file
thiếu thông tin sản xuất.

### §BOOK.S3 — Payload plan JSON chưa có schema/fail-closed contract — [SUSPECTED] / P2

imposition.py:152-199 nhận body: dict và chỉ kiểm tra có plan; các field sâu được để
PlanExecutor tự lỗi. Chưa có response contract hoặc test phân loại malformed plan thành
400 thay vì 500.

### §BOOK.S4 — Mixed page size chưa có parity preview ↔ artifact — [SUSPECTED] / P2

Metadata lưu sourcePageDims[] (ImposerDashboard.tsx:1025-1035), nhưng Sheet Viewer
nhận một pageWpt/pageHpt từ trang đầu (ImposerDashboard.tsx:2395), còn output chọn
maxSrcW/maxSrcH theo toàn bộ trang (pdfImposer.ts:678-695). UI có cảnh báo khác khổ,
nhưng chưa có artifact/golden chứng minh cách căn trang nhỏ trên frame lớn.

### §BOOK.S5 — Continuous/thread + scaleMode=cut_stack thiếu artifact E2E — [SUSPECTED] / P2

Regression hiện có kiểm map continuous cut-stack và phase-2 cut-stack chủ yếu với
bindingMode=saddle; chưa có PDF thật cho continuous/thread, mặt sau, lật cọc và collation.

## 6. Những mục audit cũ đã được xác minh là đã xử lý

- flush_mount + cut_stack hiện bị chặn ở UI và engine (InstructionSerializer.ts:283-287),
  có test phase-2.
- continuous thường pad bội 4; VirtualMap.test.ts đã khôi phục các nhóm saddle/thread/
  cut-stacks.
- Dấu giữa 1-up phân biệt fold_mark đỏ cho saddle/thread và slit_mark đen cho mode
  không gấp (InstructionSerializer.ts:739-745), có regression.

## 7. Kiểm chứng đã chạy

| Lệnh / probe | Kết quả |
|---|---|
| pytest test_plan_executor.py test_booklet_scheduler.py test_imposition_route_output_path.py | 44 pass, 1 warning Pydantic |
| pytest test_imposition_entitlements.py test_heavy_scheduler_kind_gate.py test_heavy_job_scheduler.py | 25 pass, 1 warning Pydantic |
| Vitest map/serializer/preset/report/Flipbook/SheetViewer | 54 pass |
| Vitest CatalogPlanner/ProductAdvisor | 26 pass |
| Vitest processHandlers/recipe/dashboard/file-opening | 139 pass |
| npm run typecheck | đạt |
| audit_contracts.ps1 -SelfTest | 17/17; scanner baseline 1.691 file, mọi hit chỉ [SUSPECTED] |
| Probe map Node 19 page counts × 5 binding | không trùng/sót với blankPlacement=end |
| Probe phase-2 khổ nhỏ + PlanExecutor raster | placement âm; artifact trắng, xác nhận §BOOK.01 |

Verify sau các lô A–D + E1: Vitest phạm vi Bình sách 148/148, pytest phạm vi backend 73/73,
typecheck và py_compile route/executor đều đạt. Đây vẫn là bằng chứng source/test; chưa
phải runtime Tauri.

Chưa chạy: Tauri dev click-through, build installer, runtime Offset/Auto Catalog, máy
in/gấp/xén vật lý, golden E2E dùng cùng một plan sinh từ UI rồi đọc lại toàn bộ page-order.

## 8. Đề xuất thứ tự sửa sau khi được duyệt

Mỗi lô tối đa 5 file, verify xong mới sang lô kế:

1. Lô A — fail-closed khổ phase-2: kiểm fit sau xoay + lề/nhíp trong computeSpreadGrid
   và boundary execute; thêm test planner + artifact blank-negative.
2. Lô B — quy tắc thread: chốt blank theo từng tép; chốt folio là giới hạn cứng hay
   mục tiêu mềm; thêm matrix 20/34/36/78 trang và PDF artifact.
3. Lô C — preset round-trip: version schema và lưu/khôi phục đủ mode, cover, report,
   fold/gripper kể cả giá trị 0; test load preset cũ.
4. Lô D — cooperative cancel: thêm job/cancel cho booklet plan hoặc AbortSignal
   xuyên route/scheduler, rồi kiểm tra cleanup artifact và heavy slot.
5. Lô E — **để dành ngoài phạm vi hiện tại**: Offset/Auto Catalog tiếp tục đóng. Khi có
   chủ trương mở lại mới sửa native outputPath/batch contract, report fail-loud và schema
   plan trước khi runtime Tauri.

## 9. Quyết định đã được duyệt

1. Khổ phase-2 không vừa: dừng fail-closed.
2. foliosize: giới hạn cứng; không tự gộp 4 trang dư.
3. blankPlacement=center: đặt trong tép thiếu trang, không đặt giữa toàn cuốn.
4. Offset/Auto Catalog: tiếp tục đóng, không triển khai trong đợt này.

**Kết luận:** các finding §BOOK.01–§BOOK.05 đã có bản sửa và verify tự động theo lô.
Chưa nâng GO/RUNTIME vì chưa chạy Tauri thật, artifact từ đúng UI và kiểm tay in/gấp/xén.

## 10. Trạng thái sau khi chủ dự án duyệt

Chủ dự án đã chọn: giữ Offset đóng; phase-2 fail-closed; folio là giới hạn cứng; blank
center theo tép thiếu trang. Các lô A–D và E1 đã triển khai theo nhật ký
BINH_SACH_TAP_CHI_FIXES_2026-09-23.md. Source/unit/integration đã xanh; Tauri runtime,
artifact sinh từ đúng UI và kiểm tay in/gấp/xén vẫn chưa chạy nên chưa nâng lên GO/RUNTIME.
