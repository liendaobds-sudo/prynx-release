# Hiệu năng toàn diện — nhật ký sửa 28/09/2026

## Tiếp tục sau duyệt toàn bộ phần còn lại, trừ AI QC

User yêu cầu “trừ AI QC ra còn lại làm cho đến hết”: tiếp tục các lô đã đề xuất, không cần hỏi lại sau mỗi lô; vẫn giữ ≤5file/lô và verify xong mới sửa lô tiếp. Không coi lời duyệt là nghiệm thu GUI/physical16GiB. Không commit/push/đóng gói/restart ứng dụng hoặc sửa thay luồng Viewer/PPE đang dirty. Các mục thiếu runtime/binary/máy thử sẽ ghi đúng mức bằng chứng, không tự tuyên bố đạt trần.

### Chốt verify cuối lượt (28/09/2026)

- Đã hoàn tất các lô production ngoài AI QC: B2a–B2k (RAM-gating và consumer), A3 (serialization VDP), C (nhả khóa PDFium trước CMM xám) và D1 (lazy-load EN). D2 chỉ dừng ở `SOURCE-PROFILE/SUSPECTED` vì chưa có patch ròng an toàn; không chuyển chi phí sang preview đầu tiên khi chưa có benchmark chứng minh.
- Bộ regression backend liên quan chạy trong sandbox đạt **1.139 pass**; 4 ca multiprocessing bị `WinError 5` ở `CreateFile` trước khi worker chạy. Chạy lại đúng 4 ca ngoài sandbox đạt **4/4**; tổng bằng chứng hiệu dụng **1.143 pass**, chỉ còn warning deprecation có sẵn.
- `desktop/npm run typecheck`: **PASS**. Vitest i18n scoped: **49/49 pass**. `git diff --check`: **PASS**.
- AI QC vẫn loại khỏi phạm vi lượt này: không bật entry, không benchmark/test lại để nghiệm thu và không dùng số đo QC làm lợi ích sản phẩm; các file QC dirty có từ lô trước được giữ nguyên.
- Chưa đóng mức `RUNTIME/RELEASE`: chưa chạy GUI với source mới, máy vật lý 8/16 GiB, binary/installer, GPU/scan-out 60 FPS. Đây là khoảng trống nghiệm thu, không phải lý do để thêm cap hoặc patch mù.

### B2a — helper tier chung và bộ điều phối việc nặng

- 5file: `system_memory.py`, `heavy_job_scheduler.py`, `test_worker_ram_gating.py`, nhật ký này, master matrix. Thêm resolver **thuần** `memory_tier_mb(usable, installed)` và wrapper runtime `read_memory_tier_mb(usable)`; B1 planner dùng resolver đó, không đổi policy. Pure policy khác sẽ nhận tier riêng, không ngầm đọc OS khi truyền dữ liệu kiểm thử.
- Scheduler dùng installed hợp lệ cho các mốc8/16/64GiB; chỉ sửa sai phân hạng, giữ nguyên số slot1/2/3/4, env override, gate Office/whole-machine và memory reservation. Sửa docstring cũ không còn khớp nhánh thực thi.
- Trước vá:14ca mới đỏ, trong đó3ca tái hiện slot ở usable7952/16144/65296MiB bị hạ1/2/3 thay vì2/3/4; các ca còn lại thiếu API helper mới. Sau vá: **136 passed,1 skipped**,6,79s (`test_worker_ram_gating`, `test_heavy_job_scheduler`, `test_heavy_scheduler_kind_gate`, `test_mixed_nesting_admission`). Reader usable/available và `process_pool_budget_mb` không đổi.
- Đây là AUTO policy/scheduler concurrency, chưa benchmark các job nặng trên máy8/16GiB thật. B2 các consumer riêng còn tiếp tục; C/D1 đang chuẩn bị, chưa sửa ở mốc này.

> **Đính chính phạm vi AI QC:** `desktop/src/lib/toolRegistry.ts:893` đã khóa/ẩn entry `ai_qc`; `docs/DEFERRED_FEATURES.md:39` ghi rõ tạm dừng. Audit ban đầu bỏ sót registry nên mô tả sai đây là đường UI đang hoạt động. Rút lại ưu tiên P1 cho trải nghiệm UI hiện tại; §PERF28.01 giữ ở trạng thái **DEFERRED, bằng chứng API-only**. Patch lô A không bật lại tính năng; lô B1 không sửa thêm, không chạy lại QC và không yêu cầu user nghiệm thu QC. Số đo lịch sử bên dưới không được dùng làm lợi ích cho giao diện đang dùng.

### B2b — bình tem và ảnh phân tích nguồn

- 5file: `sticker_engine.py`, `sticker_source_pipeline.py`, `test_memory_tier_consumers.py` và2tài liệu. Auto profile + gate worker thứ hai cùng dùng installed tier; đầu vào policy minh thị và `_total_ram_mb()` vẫn giữ hợp đồng cũ. Env/sticky, available-cap máy yếu và admission thực không đổi.
- Ảnh nguồn dùng tier cho trần cạnh; vẫn giữ giới hạn raster nguồn và available-pressure cho mọi máy. Sửa guard bị lệch indent: open/metadata, render+copy+bitmap-close và page/document-close đều giữ khóa; tính scale và PIL convert ngoài khóa. Cleanup vẫn đóng document khi page.close lỗi.
- Baseline37ca mới: **20fail/17pass**, tái hiện cả sai tier lẫn lifecycle thiếu khóa. Sau vá **129 passed**,63,08s: `test_memory_tier_consumers`, `test_sticker_parallel_fallback`, `test_sticker_source_pipeline`, `test_sticker_admission`, `test_pdfium_lock`. Kiểm6/8/12/16/32GiB, installed lỗi, input minh thị, overrides, available512MiB planner15 nhưng admission1, scale/pressure,10điểm lỗi native và PDF thật300DPI pixel parity giữa hai profile full.
- SOURCE+AUTO, ARTIFACT hẹp ảnh nguồn. Không suy test policy thành tăng tốc đo thật; chưa máy16GiB/GUI. `git diff --check` đạt.

### B2c — chuẩn bị N-up và ngân sách tìm kiếm S&R

- 5file: `api/routes/imposition.py`, `workers/nup_true_shape_nesting.py`, test consumer chung và2tài liệu. Runtime truyền installed tier vào policy chuẩn bị N-up; S&R16GiB không bị rơi ngân sách3000ms xuống1ms vì reserved RAM. Không đổi admission/số slot, pure policy, override hoặc các lane không phải S&R.
- 19ca mới:5đỏ/14xanh trước vá → xanh. Suite `test_memory_tier_consumers`, `test_nesting_session_handover`, `test_nup_true_shape_nesting_entry`:168pass/1fail do sandbox Windows named pipe; chạy lại đúng `test_process_con_that_render_khong_solve` ngoài sandbox đạt. Hiệu dụng **169ca đạt**, không cộng trùng. SOURCE+AUTO; không suy ngân sách tìm kiếm thành số tăng tốc hay xác nhận placement tốt hơn trên file khách.

### B2d — tile Compare và admission ghép PDF

- 5file: `core/comparison_engine.py`, `workers/pdf_manifest_engine.py`, test consumer chung và2tài liệu. Chỉ đổi tier tile và page-cap ghép; reserve/fraction/available, disk budget, DPI, ngưỡng chọn process/tile và env override không đổi.
- 16ca mới4đỏ/12xanh → xanh, có cap8/16GiB, fallback/override và ca budget7000MiB nhận nhưng7200MiB từ chối với usable16144/available12000/1slot. Suite `test_memory_tier_consumers`, `test_compare_pipeline`, `test_compare_tiled`, `test_compare_region_render`, `test_pdf_manifest_engine`: **144pass**,9,27s. Diff whitespace đạt; SOURCE+AUTO, chưa benchmark tile throughput/peak trên máy16GiB vật lý.

### B2e — memo CUT cục bộ và broker của pool bình tem

- 5file: `workers/cutline_simplify_memo.py`, `workers/sticker_engine.py`, test consumer chung và2tài liệu. Runtime local memo dùng tier; caller Sticker truyền tier cho broker tường minh. `_memo_budget_bytes`/`shared_simplify_job` không tự đọc host, `_total_ram_mb` vẫn usable. Không đổi hình học/key/retry/lifecycle hoặc admission pool.
- 14ca mới6đỏ/8xanh → xanh; test caller thật `_process_parallel` dừng tại broker xác nhận tier, không chỉ kiểm helper. Suite consumer +`test_cutline_job_memo`/`test_cutline_simplify_memo`/`test_sticker_parallel_fallback`:137pass/3named-pipe failures; rerun cả25ca job-memo ngoài sandbox đạt. Hiệu dụng **140ca duy nhất đạt**, gồm broker spawn/singleflight/crash/retry/đóng job. Diff whitespace đạt. SOURCE+AUTO; chưa workload khách/máy16GiB thật.

### B2f — nén nền Resize và tile Upscale

- 5file: `workers/resize_background_engine.py`, `workers/realesrgan_engine.py`, test consumer chung và2tài liệu. Chỉ runtime tier chọn số lane zlib/tile; giữ pure policy, CPU1, override, model/padding/scale và xử lý lỗi GPU. Không tải model hay sửa AI QC.
- 8ca mới2đỏ/6xanh → xanh; `test_memory_tier_consumers`, `test_resize_smart`, `test_upscale`: **165pass**,9,14s. Diff whitespace đạt. SOURCE+AUTO cho policy và regression Resize/Upscale; chưa đo GPU throughput/VRAM hay máy16GiB thật.

### B2g — chất lượng Logo và tách nền

- 5file: `workers/logo_rebuild.py`, `api/routes/pdf_tools.py`, test consumer chung và2tài liệu. Installed tier chỉ quyết định full-quality/error-vs-downscale, kích thước upscale mục tiêu và lưới palette; usable/available vẫn quyết định reserve/fraction và reservation nguyên tử. Policy thuần vẫn nhận input minh thị.
- 12ca mới3đỏ/9xanh → xanh. `test_memory_tier_consumers`, `test_logo_rebuild`, `test_background_removal`: **183pass**,11,84s. Ca16GiB/usable16144/available1500 không âm thầm giảm ảnh mà từ chối như full-tier cũ; máy yếu vẫn giảm đúng chính sách; reservation về0 cả khi lỗi; budget thật không đổi. Diff whitespace đạt; SOURCE+AUTO, chưa timing/GUI/model thật.

### B2h — ngân sách PPE và phiên Viewer

- 5file: `core/print_engine/facade.py`, `core/ppe_viewer_session.py`, test consumer chung và2tài liệu. Installed chỉ chọn hạng, không cộng reserved vào ngân sách; giữ nguyên basis usable/available, tỷ lệ/sàn, chia slot, override và vòng đời phiên.
- Policy thuần nhận `tier_ram_mb` tường minh; callback RAM tùy biến của Viewer không bị RAM host lấn át. Runtime mặc định đọc cả snapshot/tier ngoài event loop, giữ cache policy2giây. Đã rà singleton production và caller test; review độc lập không thấy blocker.
- 35ca baseline17đỏ/18xanh → xanh, thêm1ca wiring runtime không đè private reader; test consumer hiện142ca. Suite `test_memory_tier_consumers`, `test_ppe_memory_budget`, `test_ppe_facade`, `test_ppe_viewer_session`: **228passed**,6,65s. Kiểm biên8/16GiB, pressure, unknown/mâu thuẫn, DI, pure policy, override/chia slot và off-loop. SOURCE+AUTO, chưa runtime GUI/PPE binary mới hoặc máy16GiB thật.

### B2i — lane render chính xác và DPI xem trước màu

- 5file: `core/viewer_accurate_cache.py`, `core/color_conversion_preview.py`, test consumer và2tài liệu. Gate runtime nhận installed tier; callback RAM/DPI tùy biến vẫn độc lập host trừ khi caller cung cấp tier-reader. Không đổi policy thuần, DPI được yêu cầu, màu, cache key, lifecycle hoặc admission.
- 35ca mới11đỏ/24xanh → xanh, gồm biên8/16GiB, reader lỗi/mâu thuẫn, unknown/0/âm và DI trên host mạnh; suite consumer+`test_viewer_accurate_cache`+`test_convert_colors_preview`: **210passed**,9,13s. Consumer hiện177ca; diff whitespace đạt. SOURCE+AUTO, chưa đo GUI/thời gian render/physical16GiB.

### B2j — cache danh mục mực và phiên nesting

- 5file: `core/ink_manager.py`, `core/nesting_preview_session.py`, test consumer và2tài liệu. Chỉ chọn ngưỡng bằng installed tier; nhánh máy mạnh vẫn tính số lượng từ **usable//512** và **usable//4096**, không dùng RAM reserved để tăng dung lượng. Không đổi key/eviction/ownership hoặc hình học.
- 12ca mới5đỏ/7xanh → xanh; suite consumer+`test_ppe_facade`+`test_nesting_preview_session`: **319passed**,10,34s. Kiểm boundary/fallback/policy thuần không đọc host, và32/64GiB có reserved vẫn dùng số lượng theo usable. Consumer hiện189ca; diff whitespace đạt. SOURCE+AUTO, chưa memory plateau hoặc GUI thực.

### A3 — serialization VDP ngoài event loop (không gồm AI QC)

- 5file: `api/routes/vdp.py`, `tests/test_vdp_datasource_responsiveness.py`, probe ASGI cô lập và2tài liệu. Parser/Sheets/validator đã ở pool từ lô A; lô này chuyển `jsonable_encoder` + `JSONResponse.render` của `/datasource` sang pool thường. Giữ nguyên encoder FastAPI (kể cả lọc khóa `_sa`), bytes/header/status, đủ rows, Unicode và cancellation; không cắt dữ liệu, cache, process pool hay đổi PDFium.
- Probe mới không nạp `app.main`, QC, server hay mạng; XLSX10k là đường UI thực, CSV100k chỉ stress API. N3 trước/control/sau, response hash/size/type/length/status đều parity. Fixture XLSX268.286 B, CSV5.877.814 B; source/parser/probe SHA lần lượt `98f2f4a4…e769ace983`, `a45e3580…c672c7e7b`, `3a940d59…56289779c8`.
- Đo lần cuối: XLSX full heartbeat gap median **154,7→83,8 ms**, CSV full **1.596,4→183,9 ms**; preview không cải thiện ổn định (XLSX **71,4→74,8 ms**, CSV **97,4→97,6 ms**). Elapsed N3 nhiễu và đôi lúc control/sau chậm hơn (XLSX full **1.624,5→1.775,1 ms**, CSV full **2.014,4→1.951,0 ms**), nên chỉ kết luận giảm block event loop ở payload lớn, không gọi throughput/p95/FPS. Stage trace cho thấy encoder+dumps là phần chi phối full CSV; disposal rows chỉ khoảng mili-giây.
- Red 2 ca kiểm encoder/dumps chạy trên event loop → xanh sau vá. Suite VDP-only `test_vdp_datasource_responsiveness.py`, `tests/vdp`, `test_vdp_job_lifecycle.py`: **109passed**,42,97s; không chạy suite QC. SOURCE+AUTO, chưa runtime GUI/release.

### D2 — đo import sidecar, chưa sửa dependency

- Fresh subprocess/temp cwd, N3 sau các lô cuối, `DEV_MODE=false`, SQLite memory, thư mục uploads/results/mixed/profile riêng, bỏ token/env cấu hình và đóng `mixed_nesting_jobs` sau import; **không lifespan/server/request**. `app.main` có28 route; median source-import **1.551s** (1.604/1.472/1.551s), eager vẫn gồm `cv2`, `numpy`, `pikepdf`, `reportlab.platypus`, `pypdfium2`, `pdfcompare_native`.
- Attribution `-X importtime` tách riêng trước lô A3 cho thấy chi phí phân tán giữa FastAPI/SQLAlchemy, `preflight`, `vdp`, `sticker_sheet`/`sticker_engine`, `document_cleanup`, native/PDF; `Paragraph` chỉ dùng trong thân render preview đang chạy đồng bộ trên event loop. Lazy một import sẽ chuyển chi phí sang first-preview và không loại dependency dùng chung bởi route khác, nên chưa có patch production chứng minh lợi ích ròng.
- Trạng thái **SUSPECTED / SOURCE-PROFILE**, không gọi 1.551s là startup app/release/Nuitka/cold-disk/GUI và không dùng để tuyên bố nhanh hơn. Bước tiếp theo nếu cần là profile binary sạch + first-preview/cancel thực tế sau khi nhánh Viewer/PPE ổn định.

### B2k — cache proof xuất máy bế và preview CUT

- 5file: `workers/cut_export/inspect_proof.py`, `workers/sticker_cutline_preview.py`, test consumer và2tài liệu. Tier proof được chuẩn hóa hữu hạn/dương trước khi chọn ngưỡng; giữ basis usable/available, tỷ lệ/sàn, admission, chữ ký/ownership và eviction. Preview giữ các mức2/8/khôngcap, chỉ sửa nguồn phân hạng. Không đổi hình học/độ mịn/cache key.
- 17ca mới10đỏ/7xanh → xanh; suite consumer+`app/workers/cut_export/tests/test_api.py`+`test_sticker_cutline_preview`: **309passed**,51,03s. Consumer hiện206ca; proof tests ngoài `backend/tests` vẫn đạt mà không dựa fixture installed của host. Kiểm pressure512MiB, fallback usable, unknown/zero/NaN/∞/invalid tier và pure policy. Diff whitespace đạt; SOURCE+AUTO, chưa memory plateau/GUI/máy vật lý16GiB.

### D1 — tiếng Anh chỉ tải khi được chọn

- 4file: `desktop/src/i18n/index.ts`, `desktop/src/i18n/lazyLanguage.test.tsx` và2tài liệu. VI nạp sẵn; EN dùng literal dynamic import, một promise dùng chung193namespace qua backend i18next. Không đổi API caller/store/locale JSON; diagnostic DEV được dời tới lúc EN nạp.
- Cold-VI test đỏ do loaderEN chạy sớm → xanh. **14ca mới đạt**, có bản EN thật, delayed/all namespaces, concurrent/latest-wins, thiếu/rỗng key fallbackVI, lỗi→thử lại, savedEN qua store thật, click LanguageToggle và collision/tvDebug. Suite6file: **130pass/1fail**; bỏ catalog thì126/126pass5file. Scoped ESLint và diff whitespace đạt.
- Baseline trước đó từng có lỗi catalog `misc.acrobatViewer:compatibility_preview_warning` và 3 lỗi type trong Viewer ngoài lô; không quy cho D1 và không sửa bằng cách che test. Verify chốt cuối lượt đã cho `npm run typecheck` **PASS** và i18n scoped **49/49 PASS**.
- SOURCE+AUTO/DOM đạt trong phạm vi lazy locale; **chưa build chunk, đo startup app hay runtime Tauri**. Con số EN360.381byte compact trong audit là source, không được gọi là byte/ms sản phẩm tiết kiệm.
- Verify (cwd desktop): `npx vitest run src/i18n/lazyLanguage.test.tsx src/i18n/i18nCatalog.test.ts src/stores/appSettingsStore.test.ts src/components/acrobat/viewerModalContract.test.tsx src/lib/processHandlers.test.ts src/components/SystemIntegrations.test.tsx`; `npx eslint src/i18n/index.ts src/i18n/lazyLanguage.test.tsx`; `npm run typecheck` với lỗi ngoài phạm vi nêu trên.
- SHA256: index `41f036a8da9d86d63a8513813188394194fdf3d4e4aca43c9a9702a9a75fcf9c`; test `6d61ed63decb2c96d6512e086caf0a14ca550293d14998db6f14f816b36ee718`.

### C — xuất ảnh xám, nhả khóa PDFium trước CMM

§PERF28.04 **SOURCE + AUTO + ARTIFACT đạt**, chưa GUI/release. Lô 5file: `backend/app/api/routes/export.py`, `backend/tests/test_export_images.py`, `docs/audit/PERF_2026-09-28/gray_export_probe.py` và hai tài liệu tiến độ. Không đổi profile/màu/chất lượng ảnh.

- RGB được copy độc lập; bitmap/page close và phục hồi CropBox vẫn trong khóa PDFium. Khởi tạo/chạy Gray Gamma2.2 chuyển ra ngoài; khóa CMM riêng giữ tính tuần tự của transform dùng chung. RGB trung gian đóng tường minh cả khi lỗi. Không thay bằng luma `.convert('L')`.
- 4ca chọn lọc đỏ trước vá; sau vá **87 passed**/20,02s (`test_export_images`, `test_pdfium_lock`, `test_heavy_job_scheduler`, `test_heavy_scheduler_kind_gate`), gồm58export/11ca mới. Kiểm waiter PDFium đồng thời, cold transform, alpha/UserUnit/pagebox/thứ tự, PNG/TIFF, lỗi/hủy/rollback. AST3file và `git diff --check` đạt.
- A/B N3, cùng PDF A4/300DPI, process mới mỗi mẫu: lock trang trung vị **222,295→132,490ms**; request PDFium cạnh tranh chờ **84,230→0,0085ms**. CMM giữ khóa3/3 trước→0/3 sau. Tổng export **279,101→288,313ms**: không tuyên bố tăng throughput, giảm RAM hoặc FPS từ số này.
- Cả6mẫu trùng pixel/file/ICC/mode/size/DPI; thêm4format PNG/JPEG/TIFF/WebP ×2pagebox ở72DPI trùng trước/sau. Fixture SHA256 `ca290f3b0ff568ef711106af0311e5c7123545d4b84613869a27c2372add354d`; ảnh300DPI L2481×3508 pixel `463b14658cca5f2904cae509d0c820fd1d17424b80ca51d94280afb55af2045f`, ICC `be734596deb5705924522031fcf1fc1c2c94d818a6a94b98f1402dfb992ba358`, file `b8db0717d5c78d9dd10836aef8fa4797e17a4a4d168042b63fb858a6081dd40d`.
- CPU16/installed32768MiB/usable32527,914MiB; Pillow12.3.0/LCMS2.19. Máy32GiB thật, không đo máy yếu vật lý. CMM cold-process, filesystem cache không kiểm soát, không p95/GUI/scan-out.

Tái lập từ root: `.\backend\venv\Scripts\python.exe -B docs/audit/PERF_2026-09-28/gray_export_probe.py --runs 3 --dpi 300`. Harness đọc baseline qua `git show bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58`, không ghi/khôi phục source và không gọi AI QC.

Raw milliseconds (thứ tự1/2/3):

```json
{
  "before": {"elapsed":[320.645900,276.299900,279.100700],"page_lock":[245.668600,217.958900,222.294500],"cmm":[86.600000,84.113900,79.549300],"wait":[86.729400,84.230400,79.630600]},
  "after": {"elapsed":[337.576400,288.313200,270.734600],"page_lock":[162.605800,126.994800,132.489800],"cmm":[96.241300,99.700500,80.664600],"wait":[0.012600,0.007800,0.008500]}
}
```

SHA256 sau C: export `f3f8a32177d02ad8283c115f8f069cff50d1a39a69586ddaa8b872ef4ace18af`; test `1bf8f7b57ca99258b7d679bc12a27af9db2db8161fa722cb3df3cd80aedf18ff`; harness `39605064b16a631f66e20321d3a4649c137ae7a66a77832fe28c9c3b22a0f978`. Không ghi đè provenance lịch sử A/B1.

## Lô A — AI QC và dữ liệu VDP (A1 + A2)

**Lịch sử lô đã được duyệt qua yêu cầu “xử lý đi”. SOURCE + AUTO đạt ở API; chưa nghiệm thu trên app thật.** Thực hiện chung một lô backend 5 file vì cùng mẫu blocking call và dùng chung bộ kiểm thử ASGI. Sau khi đính chính AI QC đang tạm dừng, user yêu cầu “làm tiếp lô sau đi”: tiếp tục B1 bên dưới, không coi yêu cầu này là bằng chứng nghiệm thu runtime lô A.

Báo cáo gốc: [audit P28](BAO_CAO_AUDIT_HIEU_NANG_TOAN_DIEN_2026-09-28.md). Baseline giữ nguyên trong `audit/PERF_2026-09-28/evidence.json`, không ghi đè số đo trước sửa.

### Phạm vi file và cách sửa

1. `backend/app/api/routes/qc.py`: §PERF28.01 dùng `await run_in_threadpool(LLMChecker.check_text_cloud, ...)`. Giữ checker/provider/payload/timeout/response và lỗi như cũ. Dùng pool I/O sẵn có, không thêm worker/process/cap và không chiếm heavy slot.
2. `backend/app/api/routes/vdp.py`: §PERF28.02 offload `read_source`, `list_xlsx_sheets`, `_table_from_rows`, `validate_batch` ở validate và nhánh tính lại error-report. Đọc UploadFile trước khi offload, chỉ chuyển bytes/text hoặc dữ liệu riêng của request.
3. `backend/tests/test_qc_vdp_responsiveness.py`: 31 regression tests mới.
4. Nhật ký này: số đo, phạm vi, bằng chứng và phần chưa nghiệm thu.
5. `docs/PRYNX_MASTER_AUDIT_MATRIX.md`: cập nhật mức SOURCE/AUTO của hai finding, không đóng những phần chưa đo.

Không sửa Viewer/PPE/Rust đang dirty của công việc khác, không build/commit/restart app, không thay snapshot/golden, không gửi mạng AI/Sheets thật hoặc sử dụng PDF khách.

### Vì sao cách sửa giữ được hợp đồng

- QC giữ nguyên đồng bộ bên trong checker nhưng lời gọi diễn ra ngoài event loop. Ba provider vẫn đi đúng host; timeout/HTTP lỗi vẫn được checker chuyển thành danh sách lỗi theo hợp đồng cũ. Input trống/thiếu key/mode off/không hợp lệ không khởi chạy checker.
- VDP không lấy mẫu dữ liệu: preview vẫn20, count và `include_all_rows` giữ đủ35/10.000/100.000 dòng trong các ca tương ứng. Giữ ưu tiên source so với rows, sheet/header, Unicode, mã có số0 đầu, lỗi400 và gating.
- `_resolve_table` có ba consumer: validate, preview API và error-report. Cả ba dùng parse rows đã offload; test routes integration có cả preview PNG và CSV error-report. **Không** chuyển PDF preview renderer sang thread.
- Validator quét điều kiện/barcode/đường file ảnh; đã đọc `vdp_validate`, `resolve_field_content`, `_substitute`, `_resolve_image_path`: các nhánh này không gọi PDFium. Không đưa document/bitmap handle qua thread, không cần tạo khóa PDFium mới.
- Hủy coroutine không cưỡng bức giết HTTP/parse đang chạy ở thread. Test kiểm hủy request không làm hỏng health/request kế tiếp; worker được nhả và thu hồi trong fixture. Không tuyên bố đã bổ sung abort tức thời cho cloud/Excel. Timeout hiện có vẫn giữ nguyên.
- Không đổi giới hạn pool của framework, planner/tier RAM, heavy scheduler, DPI/màu hoặc cache. Test policy máy yếu/mạnh hiện hữu vẫn đạt; chưa đo throughput trên máy vật lý8/16GiB.

### Đỏ → xanh và xác minh

Trước vá, chạy:
```powershell
cd D:\pdfcompare\backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_qc_vdp_responsiveness.py -k http_health_completes --tb=short
```

**10/10 ca đỏ**,31,38s, cùng nguyên nhân thread chạy helper chính là event-loop thread. Không phải flaky timing: gate chỉ nhả khi event loop tiếp tục phục vụ request khác.

Sau vá:
- Bộ mới ban đầu **29/29 pass**; bổ sung2ca hủy → **31/31 pass**.
- Suite backend rộng **160/160 pass**,36,94s: bộ mới29ca lúc đó, `test_qc_extract.py`, toàn `tests/vdp/`, `test_sticker_route_responsiveness.py`, `test_worker_ram_gating.py`, `test_heavy_scheduler_kind_gate.py`, `test_pdfium_lock.py`.
- Chạy lại bộ mới cuối31ca + `test_free_token_e2e.py::test_signed_vdp_helpers_do_not_restore_datamerge_parent_gate`: **32/32 pass**,9,92s. Tổng phủ **163 ca backend duy nhất**, không cộng chồng160+32.
- Test ASGI dùng app/router/middleware thật, cùng event loop, license fixture của test; không mở server. Khi QC/CSV/XLSX/Sheets/list sheets/parse rows/validator đang giữ gate, `/health` phải hoàn tất trước worker; các ca QC/datasource còn kiểm một request validate khác. Phân biệt mức tích hợp HTTP in-process với runtime Tauri.
- Transport QC thật được thay bằng stub; parser/provider/timeout/error vẫn checker thật. Có nguồn XLSX thật nhiều sheet chạy đồng thời, giữ dữ liệu35dòng/sheet, và test lỗi nguồn rồi retry thành công.
- Signed capability VDP helper vẫn từ chối token chỉ có numbering, chấp nhận datamerge.
- `npm run typecheck`: **PASS**.
- Vitest `DataMergeTool.test.tsx`, `api.vdpEntitlement.test.ts`, `api.vdpArtifactLease.test.ts`, `vdpUtils.test.ts`: **27/27 pass**,4file,1,50s.
- Python AST của3file code/test: **PASS**. Diff kiểm whitespace sạch.
- Warning có sẵn: Pydantic class config; Starlette TestClient/httpx và BlockingPortal deprecation. Không đổi dependency ngoài phạm vi.
- Chưa chạy full suite frontend/backend, GUI, build native/sidecar/installer. Lỗi locale của audit baseline không được sửa hoặc kết luận đã hết bằng các test chọn lọc này.

Lệnh backend rộng:
```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_qc_vdp_responsiveness.py tests/test_qc_extract.py tests/vdp tests/test_sticker_route_responsiveness.py tests/test_worker_ram_gating.py tests/test_heavy_scheduler_kind_gate.py tests/test_pdfium_lock.py --tb=short
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_qc_vdp_responsiveness.py tests/test_free_token_e2e.py::test_signed_vdp_helpers_do_not_restore_datamerge_parent_gate --tb=short
```

### Số đo trước/sau

Cùng script audit `probe.py`, N=3 mỗi ca, Windows32GiB/16CPU logic; heartbeat danh nghĩa5ms, Windows idle tối đa16,051ms sau sửa. Fixture Excel có cùng nội dung nhưng zip metadata được tạo lại; không khẳng định byte-identical workbook. Không chạy benchmark đồng thời với suite test; cache/tác vụ máy ngoài audit không bị kiểm soát. Đây là thăm dò, không có p95 hay cam kết throughput.

| Ca | Gap heartbeat trung vị trước → sau | Elapsed route trung vị trước → sau |
|---|---:|---:|
| QC chờ transport250ms |250,551 → **16,569ms** |250,466 →251,215ms |
| XLSX10.000dòng/6cột |542,113 → **49,231ms** |551,363 →530,315ms |
| CSV100.000dòng/6cột |176,828 → **66,154ms** |176,637 →191,458ms |

Kết quả chính là **giảm thời gian backend không thể phục vụ việc khác trong các ca API đã đo**, không phải làm dịch vụ AI chạy nhanh hơn. AI QC đang ẩn nên ca đó không chứng minh cải thiện UI hiện tại. CSV có elapsed cao hơn ở N3 này; chưa đủ bằng chứng khẳng định throughput không giảm trên mọi dữ liệu. Không che trade-off bằng chỉ báo gap.

**Phần còn mở:** GIL/parse và JSON serialization response lớn vẫn có thể giữ event loop theo từng đoạn; CSV còn gap60–69ms, nên gate chung p95<50ms chưa được nghiệm thu. JSON issues/CSV report encoding, PDF preview rendering, QC extract/OCR không được tối ưu trong lô này. Nếu cần tăng throughput CPU/memory hơn nữa phải benchmark cụ thể và có lô riêng, không tự thêm process pool/cache/cap.

Probe preview API sau sửa vẫn PNG cùng SHA baseline `8e012fed0adc9357bfaff8fa4d84e68a3005348b44368726a12f9342fc8cd503` ở cả3lượt. Chỉ xác nhận fixture/API này, không suy ra live overlay/Next UI (chưa thấy caller endpoint đó).

### Kiểm chạy thật lô A còn thiếu — chỉ VDP đang hoạt động

User chạy **bản dev đã nạp source mới** (bản đóng gói cũ chưa chứa vá này), thử:

1. Nạp Excel nhiều sheet, đổi sheet, kiểm count/preview; validate rồi thử sinh đủ record. Thử file lỗi rồi file đúng.
2. Đóng/hủy công cụ rồi mở lại, kiểm request kế tiếp hoạt động; không đòi thread HTTP đang chạy phải bị giết ngay.

Chưa tự chạy `run_dev.bat` để tránh đụng app/backend và công việc Viewer đang chạy. User đã duyệt tiếp B1 bằng “làm tiếp lô sau đi”; runtime VDP vẫn pending. Trạng thái RAM §PERF28.03 xem B1 bên dưới; ICC lock §PERF28.04 và locale §PERF28.05 vẫn OPEN, không nói hoàn tất toàn đợt tối ưu.

### Provenance và số đo raw sau sửa

HEAD gốc `bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58`; patch chưa commit. SHA-256 code/test và raw output được lưu ngay trong nhật ký để lô chỉ chạm5file, không ghi đè evidence baseline.

```json
{
  "source_sha256": [
    {
      "path": "backend/app/api/routes/qc.py",
      "sha256": "703f5f8ec82013ba3ca4d62ef3f1e5d163dc02638b60813ed05e1ec6de051594"
    },
    {
      "path": "backend/app/api/routes/vdp.py",
      "sha256": "b2bf02cad455c563febb9b0aceab7b49627c9b61c0127253dfa95acd50eae4cf"
    },
    {
      "path": "backend/tests/test_qc_vdp_responsiveness.py",
      "sha256": "a3b6a212f3e16c6498f3f27539f1a43e74afca5db5195bc9f7e7a016d2b8d56f"
    }
  ],
  "command": ".\\backend\\venv\\Scripts\\python.exe -B docs/audit/PERF_2026-09-28/probe.py",
  "routes": {
    "cpu": 16,
    "memory_mib": [
      32527.9140625,
      19082.47265625
    ],
    "installed_mib": 32768,
    "main_thread_id": 11564,
    "scope": "in-process route/real synthetic artifacts; not GUI or installed runtime",
    "idle_control": {
      "elapsed_ms": 246.806,
      "max_heartbeat_gap_ms": 16.051
    },
    "qc_cloud_sync_transport_250ms": {
      "n": 3,
      "median_elapsed_ms": 251.215,
      "median_max_heartbeat_gap_ms": 16.569,
      "samples": [
        {
          "elapsed_ms": 263.277,
          "max_heartbeat_gap_ms": 18.583
        },
        {
          "elapsed_ms": 251.215,
          "max_heartbeat_gap_ms": 16.357
        },
        {
          "elapsed_ms": 250.887,
          "max_heartbeat_gap_ms": 16.569
        }
      ]
    },
    "qc_offload_control_only_not_production": {
      "elapsed_ms": 252.032,
      "max_heartbeat_gap_ms": 16.092
    },
    "vdp_csv_100000_rows": {
      "utf8_bytes": 3866810,
      "n": 3,
      "median_elapsed_ms": 191.458,
      "median_max_heartbeat_gap_ms": 66.154,
      "samples": [
        {
          "elapsed_ms": 163.334,
          "max_heartbeat_gap_ms": 60.599
        },
        {
          "elapsed_ms": 200.606,
          "max_heartbeat_gap_ms": 66.154
        },
        {
          "elapsed_ms": 191.458,
          "max_heartbeat_gap_ms": 68.517
        }
      ]
    },
    "vdp_xlsx_10000_rows": {
      "fixture_bytes": 306559,
      "n": 3,
      "median_elapsed_ms": 530.315,
      "median_max_heartbeat_gap_ms": 49.231,
      "samples": [
        {
          "elapsed_ms": 479.501,
          "max_heartbeat_gap_ms": 39.383
        },
        {
          "elapsed_ms": 532.541,
          "max_heartbeat_gap_ms": 49.51
        },
        {
          "elapsed_ms": 530.315,
          "max_heartbeat_gap_ms": 49.231
        }
      ]
    },
    "vdp_real_preview_one_record": {
      "image_size": [
        1190,
        1684
      ],
      "png_hashes": [
        "8e012fed0adc9357bfaff8fa4d84e68a3005348b44368726a12f9342fc8cd503",
        "8e012fed0adc9357bfaff8fa4d84e68a3005348b44368726a12f9342fc8cd503",
        "8e012fed0adc9357bfaff8fa4d84e68a3005348b44368726a12f9342fc8cd503"
      ],
      "n": 3,
      "median_elapsed_ms": 112.226,
      "median_max_heartbeat_gap_ms": 112.117,
      "samples": [
        {
          "elapsed_ms": 241.993,
          "max_heartbeat_gap_ms": 241.623
        },
        {
          "elapsed_ms": 107.639,
          "max_heartbeat_gap_ms": 107.51
        },
        {
          "elapsed_ms": 112.226,
          "max_heartbeat_gap_ms": 112.117
        }
      ]
    },
    "worker_policy_reserved_ram_boundary": [
      {
        "usable_mb": 8192,
        "workers": 2,
        "reason": "audit: workers=2 (cpu=16, base=15, ram_total_mb=8192->cap2, ram_avail_mb=6144->cap14)"
      },
      {
        "usable_mb": 7952,
        "workers": 1,
        "reason": "audit: workers=1 (cpu=16, base=15, ram_total_mb=7952->cap1, ram_avail_mb=5964->cap13)"
      },
      {
        "usable_mb": 16384,
        "workers": 15,
        "reason": "audit: workers=15 (cpu=16, base=15, ram_total_mb=16384->cap15)"
      },
      {
        "usable_mb": 16144,
        "workers": 2,
        "reason": "audit: workers=2 (cpu=16, base=15, ram_total_mb=16144->cap2, ram_avail_mb=12000->cap28)"
      },
      {
        "usable_mb": 32768,
        "workers": 15,
        "reason": "audit: workers=15 (cpu=16, base=15, ram_total_mb=32768->cap15)"
      },
      {
        "usable_mb": 32528,
        "workers": 15,
        "reason": "audit: workers=15 (cpu=16, base=15, ram_total_mb=32528->cap15)"
      }
    ],
    "gray_export_transform_inside_pdfium_lock": [
      {
        "lock_owned": true,
        "elapsed_ms": 79.719
      },
      {
        "lock_owned": true,
        "elapsed_ms": 78.668
      },
      {
        "lock_owned": true,
        "elapsed_ms": 77.418
      }
    ]
  }
}
```

## Lô B1 — phân hạng RAM lắp đặt, giữ ngân sách RAM thật

**Duyệt:** user yêu cầu “làm tiếp lô sau đi”. **§PERF28.03: B1 SOURCE + AUTO đạt; ARTIFACT hẹp cho Compare, RUNTIME pending; B2 còn OPEN.** Chỉ sửa 5 file, gồm 1 file production, 2 file test và 2 tài liệu. Không bật/sửa thêm AI QC, không chạm các thay đổi Viewer/PPE/Rust, không build/commit/restart app hoặc đổi chất lượng đầu ra.

### Phạm vi và hợp đồng

1. `backend/app/core/system_memory.py:78`: thêm `read_installed_memory_mb()`, gọi `GetPhysicallyInstalledSystemMemory` với out-pointer 64-bit và đổi KiB → MiB. Windows dùng installed để phân hạng khi usable dương và installed ≥ usable; nếu API thất bại/zero/exception/mâu thuẫn thì giữ usable. Không làm tròn, không đặt ngưỡng reserved tùy ý, không cache telemetry.
2. `backend/app/core/system_memory.py:100`: chỉ đổi nguồn phân hạng của `plan_worker_count`; log phân biệt installed/usable/tier. `<8 GiB` vẫn 1 worker, `8–<16 GiB` vẫn 2, `≥16 GiB` giữ CPU−1. Trần cũ truyền qua `hard_ceiling`, CPU1, available-cap của máy yếu và env override giữ nguyên. Nếu mất usable telemetry, giữ hành vi cũ CPU-only ngay cả khi đọc được installed.
3. `backend/tests/test_worker_ram_gating.py`: thêm **30 ca**, tổng38. Kiểm API thật qua mock WinAPI (không mock helper mới), đơn vị/FFI, boundary8/16/32/64, reserved2GiB, lỗi/unknown, override, budget/admission và policy VDP/N-up.
4. `backend/tests/conftest.py:68`: fixture autouse cho riêng WinAPI installed báo FALSE mặc định. Các test cũ chỉ mock usable/available không bị RAM32GiB thật của máy chạy test lấn át. Ca mới tự thay API với telemetry minh thị; production không có nhánh test.
5. Nhật ký này và `docs/PRYNX_MASTER_AUDIT_MATRIX.md`: kết quả/giới hạn/đính chính reachability AI QC.

**Không đổi thân thực thi** của `read_memory_status_mb()` hoặc `process_pool_budget_mb()`: tuple vẫn `(OS-usable, available)`; budget vẫn dùng RAM thật, không được cộng hardware-reserved. Policy installed thống nhất với `desktop/src-tauri/src/lib.rs:2795–2823`. Tài liệu Microsoft xác nhận API lấy RAM lắp đặt từ SMBIOS, dùng KiB, có thể lớn hơn RAM OS sử dụng và không hợp lệ nếu nhỏ hơn usable. [Nguồn API chính thức](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getphysicallyinstalledsystemmemory).

### Các consumer đã đối chiếu

`rg 'plan_worker_count\(' backend/app` có **11 call site trong9file production**, ngoài định nghĩa helper:

- N-up `workers/nup_engine.py:4039`; VDP `workers/vdp_engine.py:1939`; Preflight `core/preflight_engine.py:228`.
- Compare `core/comparison_engine.py:1631,1641`; disk estimate `api/routes/compare.py:210`.
- Mixed nesting `core/mixed_nesting_service.py:1056,1531`; Image Combine `workers/pdf_manifest_engine.py:836`.
- CUT prewarm `workers/sticker_cutline_jobs.py:91`; CUT preview `workers/sticker_cutline_preview.py:129`.

Đã kiểm entry **đang bật**: registry Preflight`:291`, Data Merge`:430`, N-up`:516`; đăng ký route trong `backend/app/main.py:382,384,385`. N-up/VDP planner tiếp tục xuống chunk/output PDF; preflight tiếp tục content-stream workers → issues. Admission pool hiện hữu ở `nup_output_finalize.py:110`, `vdp_engine.py:2091`, `preflight_engine.py:247` vẫn dùng ngân sách RAM thật. Test mới VDP đi qua planner engine thật; phần N-up ghép helper + chunk planner ở mức policy, **không phải E2E N-up dưới installed16GiB**. Suite N-up artifact hiện hữu được chạy riêng bên dưới.

**Giới hạn:** Compare và CUT thread pools không gọi `process_pool_admission`; không nói mọi consumer đã có admission hoặc được bảo vệ dưới mọi giới hạn VM/Job Object. Installed/usable/available không chứng minh commit limit; Windows có các trường commit riêng `ullTotalPageFile`/`ullAvailPageFile`. [MEMORYSTATUSEX](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex). B1 không bổ sung cơ chế xử lý giới hạn này. Các bộ đọc usable để phân tier/budget riêng ở Sticker/PPE/scheduler/cache/preview vẫn giữ nguyên, phải audit và verify theo nhóm ở B2, không thay bằng regex.

### Đỏ → xanh và admission

Baseline trước thêm test: **154 passed,1 skipped**,11,57s. Test biên mới chạy trước sửa production: **3 failed,5 passed** (1,77s), lỗi đúng8/16GiB bị nhận hạng thấp. Sau sửa, các kết quả CPU16/per-worker256MiB:

| Installed / usable / available (MiB) | Worker trước → sau | Ngân sách/admission sau |
|---|---:|---|
|8192 /7952 /5964|1 →2|Máy hạng giữa, vẫn áp available-cap|
|16384 /16144 /12000|2 →15|Budget7200MiB, admit15 worker256MiB|
|16384 /14336 /12000|2 →15|Reserved2GiB không tự biến máy16GiB thành máy yếu|
|6144 /5904 /4000|1 →1|Giữ hạng yếu|
|12288 /12048 /512|1 →1|Available-cap máy yếu vẫn hoạt động|
|16384 /16144 /512|1 →15 planned|Budget307,2MiB, admit1 worker256MiB; từ chối worker1024MiB|
|32768 /32528 /512|15 →15 planned|Budget0, từ chối trước spawn|

Không suy số worker thành hệ số tăng tốc. Probe OS thật ngoài pytest: installed32768, usable32527,9140625, available18421,515625MiB, CPU16, planner15; budget15168,72421875MiB tại thời điểm đọc. Không phải máy vật lý16GiB.

### Verify tự động

- Suite policy/scheduler/nesting: **192 passed,1 skipped**,13,10s.
- Suite consumer rộng: **393 passed,5 failed**,122,46s; cả5 lỗi là sandbox `WinError5` tại `multiprocessing.Pipe/CreateFile`, trước khi worker chạy (4Compare,1N-up). Không chỉnh test/source để né.
- Chạy lại hai file chứa5ca đó ngoài sandbox: **59/59 passed**,28,59s. Tổng sau khử trùng lặp: **590 ca backend đạt,1 skip**; không cộng thêm59 vào192+398.
- Skip hiện hữu: `test_mixed_nesting_admission.py` bỏ ca route P6 cũ vì route đã có ở P7a; không bỏ test RAM mới.
- Các suite bao phủ Compare thread/process/tile artifact parity, N-up fingerprint/chunk/finalize/lifecycle, Preflight, VDP writer/routes/properties, Image Combine, CUT preview/prewarm, scheduler cancel/release và PDFium lock.
- AST cả3file code/test đạt; so thân hàm AST với HEAD gốc xác nhận reader usable/available, budget và estimate không đổi. Diff kiểm whitespace sạch.
- Review độc lập chỉ đọc3file code/test: không phát hiện blocker. Không chạy frontend/typecheck/Rust build ở lô backend-only này; kết quả frontend lô A không tính thành verify mới của B1.
- Warning có sẵn: Pydantic class config, Starlette/httpx và BlockingPortal deprecation. Không đổi dependency/snapshot.

Lệnh (cwd `D:\pdfcompare\backend`):

```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_worker_ram_gating.py -k test_installed_ram_tier --tb=short
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_worker_ram_gating.py tests/test_sticker_route_responsiveness.py tests/test_heavy_job_scheduler.py tests/test_heavy_scheduler_kind_gate.py tests/test_mixed_nesting_admission.py tests/test_nesting_manifest_batch.py --tb=short
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_compare_parallel_parity.py tests/test_compare_pipeline.py tests/test_compare_tiled.py tests/test_compare_region_render.py tests/test_preflight_engine.py tests/test_preflight_xobject_recursion.py tests/test_nup_output_finalize.py tests/test_nup_engine_sheet_plan_parity.py tests/test_nup_job_lifecycle.py tests/test_sticker_cutline_preview.py tests/test_sticker_cutline_jobs.py tests/test_pdf_manifest_engine.py tests/test_pdf_manifest_jobs.py tests/vdp tests/test_vdp_job_lifecycle.py tests/test_pdfium_lock.py --tb=short
# Chạy lại ngoài sandbox sau lỗi named pipe:
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_compare_parallel_parity.py tests/test_nup_engine_sheet_plan_parity.py --tb=short
```

### Compare A/B trên PDF thật, phần cứng giả lập

Tái sử dụng `_make_pdf` và `_run_child` của `scripts/benchmark_compare_pipeline.py`, 20trangA4/150DPI,7trangkhác; cùng cặp PDF cho toàn bộ18lượt. Mỗi lượt process mới, SQLite/kho kết quả/thư mục tạm riêng; không chạy đồng thời với suite test, không tác động backend đang mở. N=3 mỗi cấu hình trước/sau, đảo thứ tự A/B ở lượt2. Auto worker: đối số harness `workers=0` khiến hai env override là0 (không ép worker); wrapper chỉ ghi lại kết quả planner.

“Trước” nạp nguyên helper từ `git show bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58:backend/app/core/system_memory.py` vào module riêng trong process đo, gắn vào đúng consumer Compare; “sau” dùng helper worktree. Cả hai mock reader usable/available với cùng số; installed API mock ghi KiB vào pointer để đi qua ctypes helper sau sửa. Không sửa/khôi phục file production trong lúc đo.

| Policy giả lập (installed/usable/available MiB) | Worker trước → sau | Elapsed trung vị trước → sau | Mốc progress trang đầu trước → sau | Peak cây process lớn nhất trước → sau |
|---|---:|---:|---:|---:|
|6GiB (6144/5904/4000)|1 →1|3,043 →2,943s|0,434 →0,411s|267,49 →266,62MiB|
|16GiB sát ngưỡng (16384/16144/12000)|2 →15|2,892 →1,859s|0,481 →0,634s|256,33 →417,09MiB|
|32GiB (32768/32528/18000)|15 →15|1,726 →1,706s|0,530 →0,520s|413,40 →408,75MiB|

**Đánh đổi phải giữ rõ:** trong mẫu16GiB, thời gian hoàn tất giảm nhưng callback trang đầu chậm hơn khoảng154ms và peak tăng khoảng161MiB. N3 có nhiễu lớn (lượt sau đầu tiên2,553s/first1,198s); chưa thể dùng để nói tương tác mượt hơn hoặc nhẹ RAM hơn. Máy yếu/mạnh ngoài ranh giới giữ cùng worker; chênh lệch thời gian nhỏ không được gán là tăng tốc nhờ helper. Mốc progress không phải ảnh đã paint/scan-out. Phép đo chạy trên **máy32GiB thật**, chỉ giả lập telemetry6/16/32GiB; chưa phải kiểm áp lực RAM của máy yếu thật, chưa có p95 hay throughput N-up/VDP thật.

Tất cả18lượt có `page_snapshot`, `summary` và SHA-256 mọi artifact khớp đối chứng; mỗi lượt9.498.432byte artifact. Đo riêng200lần API installed thật: median0,001600ms, max0,133500ms; không phải thời gian startup ứng dụng.

Raw sample (thứ tự trong mỗi mảng là lượt1/2/3; elapsed/first tính giây, peak tính MiB):

```json
{
  "weak6_before": {"elapsed": [3.0431983000,3.2878405000,2.9855590000], "first": [0.4442843000,0.4287369000,0.4343763000], "peak": [260.6875,264.37890625,267.4921875]},
  "weak6_after": {"elapsed": [2.8789267000,2.9425031000,3.0895348000], "first": [0.3977977000,0.4112947000,0.4320987000], "peak": [254.67578125,228.83203125,266.6171875]},
  "boundary16_before": {"elapsed": [3.5753409000,2.8817135000,2.8922812000], "first": [0.5901035000,0.4805090000,0.4695661000], "peak": [256.33203125,251.82421875,254.5703125]},
  "boundary16_after": {"elapsed": [2.5526737000,1.8593571000,1.7474653000], "first": [1.1982031000,0.6341946000,0.5428716000], "peak": [383.2890625,417.0859375,411.2265625]},
  "strong32_before": {"elapsed": [1.7261054000,1.7065533000,1.7293830000], "first": [0.5296519000,0.5285526000,0.5369473000], "peak": [407.94921875,413.40234375,388.1953125]},
  "strong32_after": {"elapsed": [1.6788064000,1.7058784000,1.7533579000], "first": [0.5019498000,0.5201050000,0.5535915000], "peak": [399.80859375,408.74609375,396.6015625]}
}
```

### Provenance B1 và phần còn mở

SHA-256 source sau sửa (baseline evidence JSON và source lô A giữ nguyên):

| File | SHA-256 |
|---|---|
|`backend/app/core/system_memory.py`|`590e7475cf36968935dc0efd02b501752d914c188e883ad4efb8d77c276b8c28`|
|`backend/tests/test_worker_ram_gating.py`|`5e427dd609242504bfec9667b5671c6ef8957219df0a355bcb759e1b26d2fa1f`|
|`backend/tests/conftest.py`|`a39a98ebcbb661ebf95e75ec3929a89c3fca8c1d08ca28fb24cb186d40335f6f`|
|Harness cũ, không sửa: `scripts/benchmark_compare_pipeline.py`|`941eb95684468c84931d60e4d57c1c733663b63db4cf431715ea6461474d2579`|

**Chưa nghiệm thu toàn dự án đạt trần hiệu năng.** B1 sửa đúng lỗi hạ hạng máy và đã verify source/test/artifact hẹp. Cần kiểm trên bản dev nạp source mới, máy16GiB thật: N-up/VDP job đủ lớn, tiến độ/hủy/kết quả, RAM cạn và latency trang đầu; không yêu cầu bật AI QC. Chưa chạy GUI, full backend suite, release/installer, VM/Job Object commit-limit. Dừng ở chốt B1 theo `prynx-audit-workflow`, chờ user kiểm/duyệt lô tiếp. B2 sẽ tách riêng các consumer RAM còn dùng usable để phân hạng, không đụng nhánh PPE đang sửa ở công việc khác.
