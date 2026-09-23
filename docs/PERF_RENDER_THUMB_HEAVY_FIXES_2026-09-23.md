# NHẬT KÝ LÔ FIX HIỆU NĂNG RENDER / THUMBNAIL / FILE NẶNG — 2026-09-23

Phạm vi theo `BAO_CAO_AUDIT_PERF_RENDER_THUMB_HEAVY_2026-09-23.md`.

## Lô 1 — Virtualize sidebar thumbnail

- Finding: `§R23.05`.
- File: `desktop/src/components/acrobat/ThumbSidebar.tsx`.
- Thay đổi: dùng `VirtuosoGrid`; chỉ mount viewport + overscan, giữ nguyên `pageOrder`, index, selection, drag/context menu và request key.
- Commit: `65f15aa`.
- Verify: `npm run typecheck` đạt; Vitest `ThumbSidebar.aiStatus.test.tsx` + `ThumbSidebar.cutlinePreview.test.tsx`: **12/12 pass**.
- Chưa đạt: runtime Tauri với PDF 1.000+ trang, đo DOM/RSS và scroll thumbnail thật.

## Lô 2 — Document-affinity cho worker nền

- Finding: `§R23.02`.
- File: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.
- Thay đổi: khóa affinity theo `document.path + document.token` cho background lane; cùng snapshot PDF dùng lại worker/DOC_CACHE/page LRU; xóa affinity khi worker transport lỗi hoặc đóng tài liệu.
- Commit: `37df8e1`.
- Verify: `cargo check --manifest-path desktop/src-tauri/Cargo.toml` đạt; test `document_affinity` đạt **1/1**.
- Ghi chú: lần check đầu bị build lock/file lock do tiến trình Cargo khác; chạy lại sau khi tiến trình đó kết thúc đã đạt. `cargo fmt --all -- --check` còn báo các khác biệt format có sẵn ngoài lô này; không chạy formatter toàn repo để tránh sửa file người dùng.
- Chưa đạt: runtime A/B chứng minh `open_ms`, cache hit ratio, first-pixel và peak RSS trên file khách.

## Lô kế tiếp

1. Telemetry sạch theo document/worker/session để đo A/B.
2. First-pixel fast path tách PageShell/geometry khỏi metadata nền nhưng giữ soundness màu.
3. PPE retained scene/resource cache sau khi có baseline sạch.

## Lô 3 — Nâng lane tile khi trang prefetch trở thành active

- Finding: `§R23.06`.
- Files: `desktop/src/components/workspace/LivePageFrame.tsx`, `desktop/src/hooks/viewer/renderCoordinator.ts`, `desktop/src/hooks/viewer/tileRenderScheduler.ts` và test liên quan.
- Thay đổi: khi tile còn nằm trong hàng đợi nền nhưng trang đã active, coordinator/scheduler hạ priority của task đang chờ và cập nhật `purpose`; không hủy hoặc dựng lại cùng bitmap.
- Commit: `295700b`.
- Verify: `npm run typecheck` đạt; Vitest scheduler/coordinator/LiveTile: **48/48 pass**.
- Chưa đạt: runtime A/B trên file khách để xác nhận queue_ms/first-pixel giảm; request đã chạy trong worker không thể bị đổi lane giữa chừng và vẫn cần telemetry.

## Lô 4 — Telemetry affinity worker an toàn

- Finding: hỗ trợ đo `§R23.02`/`§R23.06`.
- File: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.
- Thay đổi: ghi `RENDER_WORKER_AFFINITY` với action/lane và mã băm 12 ký tự của snapshot tài liệu; không ghi path hay tên file khách hàng.
- Commit: `4682ccc`.
- Verify: `cargo check` đạt; test `document_affinity` **1/1 pass**.
- Chưa đạt: cần chạy binary mới trên file khách để thu `open_ms`, `queue_ms`, affinity hit/assign/drop và peak RSS.

## Lô 5 — Gom target DPI sau first-frame

- Finding: chuỗi stale/cancel 56 → 68 → 92 DPI trong cold-open runtime probe.
- Files: `desktop/src/components/workspace/LivePageFrame.tsx` và test LiveTile.
- Thay đổi: khi đã có first-frame prime, trì hoãn 120 ms cho target accurate kế tiếp để gom các thay đổi layout/fit liên tiếp; không trì hoãn frame đầu và không hạ DPI cuối.
- Commit: `8b13216`.
- Verify: `npm run typecheck` đạt; LiveTile **26/26 pass**.
- Chưa đạt: cần chạy lại cùng PDF khách để xác nhận số stale/cancel và số lượt PPE giảm.
- Telemetry settle thêm tại commit `f696438` để phiên runtime kế tiếp ghi rõ lúc gom target DPI.

## Lô 6 — Hoãn accurate base nền đến khi layout ổn định

- Bằng chứng runtime mới: event `tile-accurate-target-settle` đã xuất hiện; trang accurate nền vẫn có request 68 DPI rồi 92 DPI sau khi active/layout đổi.
- Files: `LivePageFrame.tsx`, `livePageFramePolicy.ts`, test LiveTile.
- Thay đổi: accurate base/underlay nền chỉ được dựng khi `renderZoom` khớp target hiện tại; trang active không bị gate này.
- Commit: `30ea519`.
- Verify: typecheck đạt; LiveTile + renderPolicy **49/49 pass**.
- Chưa đạt: runtime A/B trên cùng PDF; giữ kế hoạch tiến tới retained scene/resource cache sau baseline.

- Runtime probe cho thấy 120 ms vẫn phát hai settle cách nhau ~208 ms; commit `3c02d26` đồng bộ settle lên 250 ms theo debounce zoom hiện tại. Verify lại: typecheck + LiveTile/renderPolicy **49/49 pass**.

## Lô 7 — Telemetry PPE resource cache

- Finding: cần kiểm chứng retained Form/Image/Page cache trước khi mở rộng engine.
- File: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.
- Thay đổi: log `PPE_SESSION_CACHE` theo request/page/mode với image/form/page hits/misses; không ghi path.
- Commit: `f9a76b9`.
- Verify: `cargo check` + test affinity bằng `CARGO_TARGET_DIR` riêng đạt; `print_engine` session cache tests **8/8 pass**, Form parity **1/1**, SMask cache **1/1**.
- Chưa đạt: cần binary mới chạy lại để lấy cache hit ratio thực tế trên file khách.

### Runtime probe sau khi bật PPE_SESSION_CACHE

- Binary mới đã ghi telemetry thật. Lượt lạnh trên tài liệu 44 trang ghi `image_hits=0`, `image_misses` tăng theo trang; lượt ấm sau đó page 1 ghi **4 hit / 3 miss**, các trang kế tiếp tiếp tục tăng hit — session/resource cache đang được tái sử dụng.
- Accurate page 1 có `PPE_NATIVE_RESULT total_ms` khoảng **190 ms**, `source_ms` vài ms và `decode_ms=0`; first-pixel end-to-end khoảng **200–220 ms** trong lượt warm này. Chưa có bằng chứng để ưu tiên shared-surface/GPU transport.
- Form cache của corpus này chưa có hit vì file không đi qua Form XObject; cần corpus Form/SMask riêng trước khi tối ưu tiếp.

### Runtime probe sau settle 250ms + PPE cache telemetry

- Binary mới đã ghi `delay_ms=250` và phát target cuối ở generation cuối; page 1 accurate đạt khoảng **190–210 ms PPE/first-pixel** trong lượt warm.
- Ba event settle gần nhau là các effect layout cùng debounce; chỉ request cuối commit bitmap, các request cũ bị cancel/stale nhanh, không phát thêm bitmap sai.
- `PPE_SESSION_CACHE` cho thấy cache image warm hoạt động (`image_hits=4`, `image_misses=3` ở page 1; hit tiếp tục tăng ở page sau). Đây là bằng chứng runtime cho retained resource cache hiện tại.

## Runtime probe — phiên người dùng 2026-09-23

Nguồn: `%USERPROFILE%\Desktop\PrynX_RenderPerf.log`, lượt cuối lúc 04:56. Đây là probe runtime thật, chưa phải P95 corpus.

- PDF 44 trang: bootstrap **43 ms**, full metadata **53 ms**; page 1 PPE 92 DPI `total_ms=193`, first-pixel khoảng **418 ms sau `pdf-load-start`**; page 2/page 3 first-pixel lần lượt khoảng **1.97 s / 2.76 s** khi các trang accurate được dựng nối tiếp.
- Cùng PDF: affinity background chuyển sang `hit lane=background:4`; thumbnail page 1–5 trả khoảng **9–53 ms**.
- PDF 123 trang: bootstrap **52 ms**, page 1 display render `10–20 ms`, first-pixel khoảng **136 ms**; thumbnail các trang đầu khoảng **153–236 ms**, affinity `hit lane=background:0`.
- Priority promotion đã chạy thật (`tile-priority-promote` với `previous_priority=100 → priority=10`) và không cần hủy bitmap đang chờ.

Khoảng trống còn lại: cold-open PDF 44 trang vẫn phát chuỗi request accurate 56 → 68 → 92 DPI và có stale/cancel ở các generation cũ. Đây là mục tiêu lô kế tiếp: ổn định target DPI/first-frame để giảm render thừa, không hạ chất lượng cuối.

## Lô 8 — Script baseline runtime tái lập

- File: `scripts/report_viewer_perf.ps1`.
- Commit: `25fa56c`.
- Cách chạy: `powershell -ExecutionPolicy Bypass -File scripts/report_viewer_perf.ps1 -Tail 50000`.
- Probe 50.000 dòng hiện tại: bootstrap P50/P95 **66/457 ms**; PPE total P50/P95 **156/833 ms**; first-pixel native→decode P50/P95 **289/1.069 ms**; affinity hit/assign/drop **534/115/21**; image cache hit ratio **14,04%** trong cửa sổ này.
- Đây là baseline tự động hóa, chưa phải P95 sản phẩm vì log trộn nhiều tài liệu/phiên; dùng để so sánh binary tiếp theo.

## Lô 9 — Re-audit backend Compare file dài

- Benchmark có sẵn: `scripts/benchmark_compare_pipeline.py`, chạy DEV_MODE với token benchmark; không sửa production.
- Corpus 20 trang A4 @150 DPI, workers 1→4: elapsed **3.049s → 2.022s (1.51×)**, first-page **0.493s → 0.512s**, artifact **9.1 MiB** parity `True`, peak working set **254 → 353 MiB**.
- Kết luận: pipeline process-level Compare hiện đã hoạt động đúng và scale có lợi cho tổng job; không mở thêm worker vô điều kiện. First-page không nhanh hơn, nên nút thắt first-page vẫn thuộc render/metadata riêng.
- Corpus nhỏ 5 trang @72 DPI: workers 4 đạt 1.66× nhưng workers 2 nhiễu chậm hơn; không dùng số nhỏ làm KPI.

## Lô 10 — Baseline backend Export ảnh

- Script: `scripts/benchmark_export_images.py`, commit `04d71a4`.
- Corpus: `backend/tests/preflight_fixtures/pdfs/13_multipage_15.pdf`, 15 trang @150 DPI.
- RGB PNG từng trang: **0,412s**, khoảng **27,5 ms/trang**, artifact 149 KiB.
- CMYK TIFF/PPE từng trang: **1,390s**, khoảng **92,7 ms/trang**, artifact 9,54 MiB.
- Đây là baseline nhỏ, chưa phải file khách nặng; chưa tối ưu song song export vì PDFium vẫn phải serialize trong một document và chưa có số đo peak RAM trên corpus lớn.
- Cùng corpus @300 DPI: RGB **1,132s / 75,5 ms-trang**, CMYK **1,605s / 107,0 ms-trang**; scale tăng nhưng vẫn chưa cho thấy Export cần thêm process vô điều kiện.

## Lô 11 — Installed/WebView smoke gate

- Harness: `scripts/ppe_viewer_webview_baseline.mjs`, chạy qua CDP trên Tauri dev mới với thumbnail đóng.
- Fixture RGB 15 trang: shell **764 ms**, PPE 3 fulfilled/3 rejected; harness fail-closed vì capability không sạch.
- Fixture CMYK/TAC: shell **982 ms**, first visible **1.239 s**, compositor có content; PPE 2 fulfilled/2 rejected, nên không đạt gate PPE-only.
- Fixture PDF tối giản: shell **740 ms**, first visible **944 ms**, compositor có content; PPE 2 fulfilled/2 rejected.
- Kết luận: harness/runtime path hoạt động và fail-closed đúng; các fixture repo không phù hợp gate `ppe-only` tuyệt đối (capability reject), chưa có corpus Standee hash chính thức để đóng installed smoke. Không hạ gate để che lỗi capability.

## Lô 12 — Smoke file khách + compatibility gate tường minh

- File: `scripts/ppe_viewer_webview_baseline.mjs`.
- Thay đổi: thêm `PRYNX_VIEWER_BASELINE_ENGINE_MODE=hybrid` kết hợp cờ bắt buộc `PRYNX_VIEWER_BASELINE_ALLOW_COMPATIBILITY=1` cho chẩn đoán; cổng mặc định vẫn `ppe-only`. Compatibility chỉ hợp lệ khi request được định danh/path đúng, không pending/shadow, và PPE reject thực sự có display fallback; không nới pixel gate chính thức.
- Verify: self-test mặc định và self-test compatibility **đạt**.
- File khách `test/poster retro - Khắc Trung - 0854444414.pdf` (SHA-256 `574af320396c766eb975b6b3d062aa99c0724f241ff4c107401426b2eddff9a1`, 5 trang):
  - PPE-only smoke: shell **1.066 s**, FSP **1.473 s**, 16 fulfilled/10 rejected, không display fallback; fail-closed vì không đạt PPE-only frame gate.
  - Hybrid diagnostic smoke: shell **1.059 s**, FSP **4.099 s**, 3 fulfilled/2 rejected, không display fallback; fail-closed vì compatibility reject không có PDFium fallback và FCVF timeout.
- Reports: `docs/audit/viewer_smoke_customer_2026-09-23.json`, `docs/audit/viewer_smoke_customer_hybrid_2026-09-23.json`.
- Kết luận: file khách này chưa chứng minh được đường render hoàn chỉnh trong cả hai mode; không được dùng làm KPI P95. Cần corpus PPE Standee chuẩn để đóng installed gate và một corpus capability-reject có fallback thật để đo hybrid.

## Lô 13 — Installed thumbnail stress 1.000 trang

- File: `scripts/thumbnail_webview_stress.mjs`.
- Fixture: `.tmp/thumbnail-stress-1000.pdf`, 1.000 trang vector nhẹ (không commit fixture).
- Cách đo: mở qua Tauri WebView/CDP, bật thumbnail panel qua đúng workspace store, đo Virtuoso scroller trước và sau khi scroll tới cuối; không dùng selector ngoài làm giả scroll container.
- Kết quả: `docs/audit/thumbnail_stress_1000_2026-09-23.json`; initial **5 item DOM**, sau scroll **5 item DOM** (index **995–999**), `scrollHeight=202.484 px`, `clientHeight=689 px`; JS heap **86,3 → 90,2 MiB**; gate virtualizer **đạt**.
- Kết luận: `VirtuosoGrid` đã giữ DOM theo viewport/overscan trên tài liệu 1.000 trang; không còn bằng chứng `pageOrder.map` mount toàn bộ. Đây là dev WebView smoke, chưa thay thế installed release/RSS toàn cây process.

## Lô 14 — Export file khách RGB/CMYK

- Benchmark: `scripts/benchmark_export_images.py` (read-only, output tạm tự dọn), report `docs/audit/export_customer_2026-09-23.json`.
- File khách 5 trang, 61 MB, SHA-256 `574af320396c766eb975b6b3d062aa99c0724f241ff4c107401426b2eddff9a1`:
  - RGB 150 DPI: **6.890 s**, **1378 ms/trang**, artifact 25,8 MiB.
  - RGB 300 DPI: **22.0144 s**, **4402.88 ms/trang**, artifact 58,2 MiB.
  - CMYK 150 DPI: PPE **fail-fast** vì ước tính raster **3865 MiB (~3,8 GiB)** vượt ngân sách **3547 MiB**.
  - CMYK 300 DPI: PPE **fail-fast** vì raster **7087×11811 @ 300 DPI** vượt gate kích thước.
- Kết luận: RGB export chạy được nhưng chi phí tăng khoảng 3,2× khi tăng DPI; CMYK safety gate đang bảo vệ RAM đúng hợp đồng, chưa được coi là lỗi. Cần peak RSS và chiến lược tile/stripe cho CMYK nặng trước khi hạ gate.

## Lô 15 — Thumbnail native đi qua RenderCoordinator

- Finding: `§R23.04`/`§R23.05` — thumbnail đã virtualize DOM nhưng còn gọi `render_pdf_page` trực tiếp qua scheduler riêng.
- File: `desktop/src/components/acrobat/ThumbSidebar.tsx`.
- Thay đổi: thumbnail native dùng `RenderCoordinator` với document identity, generation key, display pipeline và owner dùng chung trong cùng tab; group vẫn tách theo trang để cancel đúng item. Blob encode vẫn lossless PNG, physical cancel dùng đúng `requestId` do coordinator cấp.
- Verify: `npm run typecheck` đạt; Vitest `thumbnailPipeline`, `renderCoordinator`, `ThumbSidebar.aiStatus`: **19/19 pass**.
- Giới hạn: native worker/session vẫn là đường process hiện tại; chưa có shared RGBA surface và chưa có release A/B chứng minh RSS/P95 trên corpus khách.

### Runtime verify sau Lô 15

- Fixture 1.000 trang vẫn đạt virtualizer gate: 5 item DOM đầu/cuối, cuối index 999.
- Log native ghi `RENDER_WORKER_AFFINITY action=hit lane=background:1` và thumbnail page 997–1000 `CACHE_HIT tier=disk`; document-affinity đang được dùng thật.
- Bổ sung `markEncoded` cho thumbnail để chốt trace source-only, tránh giữ coordinator group sau khi Blob URL đã sẵn sàng.

## Lô 16 — Runtime verify coordinator/session thumbnail

- Report: `docs/audit/thumbnail_coordinator_runtime_2026-09-24.json` và `docs/audit/thumbnail_stress_1000_coordinator_2026-09-24.json`.
- Smoke 1.000 trang sau commit `aaf9266`: initial/end **5 DOM items**, cuối index **999**.
- Log bounded theo lượt ghi owner đã băm `thumbnail:c662e6ee`, group `thumbnail:<page>`, pipeline `pdfium-display-png-v1`, trạng thái `ready` cho page 1–5 và 997–1000; sample page 1 **123 ms**, page 1000 **42 ms**.
- Native log đồng thời ghi `RENDER_WORKER_AFFINITY action=hit`, document hash `cf76f3f65634`, lane `background:2`.

## Lô 17 — Peak RSS toàn cây thumbnail

- Report: `docs/audit/thumbnail_rss_runtime_2026-09-24.json` và stress output `docs/audit/thumbnail_stress_1000_rss_2026-09-24.json`.
- Dùng `scripts/measure_process_tree_memory.ps1`, lấy mẫu đồng thời 50 ms trong toàn cây PrynX: **186 mẫu / 29,783 ms**, peak working set **1.074,75 MiB**, peak private **667,99 MiB**, tối đa **25 process**.
- Cùng lượt vẫn đạt virtualizer gate: **5 DOM items** đầu/cuối, cuối index **999**.
- Đây là gate RSS dev WebView đầu tiên; release/installer và corpus PDF nặng vẫn là cổng riêng chưa đóng.

## Lô 18 — Peak memory Export file khách

- Script `benchmark_export_images.py` nay lấy mẫu Windows working set/private mỗi 25 ms trong process benchmark; output UTF-8 qua `PYTHONUTF8=1` khi tên file có dấu.
- File khách 5 trang: RGB 150 DPI **6.8505 s**, peak working set **812.547 MiB**, private **808.078 MiB** (219 mẫu).
- RGB 300 DPI **22.7286 s**, peak working set **2985.164 MiB**, private **3009.695 MiB** (718 mẫu).
- Artifact bytes khớp baseline trước (27,099,864 / 61,076,919); benchmark compile đạt. Report `docs/audit/export_customer_memory_2026-09-24.json`.
- Kết luận: 300 DPI có peak xấp xỉ 3 GiB cho 5 trang file này; không đủ cơ sở mở song song Export vô điều kiện. Cần tile/stripe hoặc giảm peak copy trước khi tăng concurrency.

## Lô 19 — Cancel độc lập thumbnail nhân bản

- Finding: cùng một `originalPageNum` có thể xuất hiện nhiều vị trí sau thao tác nhân bản; group chỉ theo page khiến cleanup một item hủy nhầm item còn lại.
- File: `desktop/src/components/acrobat/ThumbSidebar.tsx`.
- Thay đổi: group coordinator dùng `thumbnail:<index>:<originalPageNum>`; owner/document session vẫn dùng chung để giữ affinity, nhưng lifecycle/cancel tách theo vị trí.
- Verify: `npm run typecheck` đạt; Vitest thumbnail/coordinator/AI badge **21/21 pass** (có test group duplicate).

## Lô 20 — Kiểm lifecycle thật: reorder, remount, đổi revision và observer

- Ngày chạy thật: **2026-09-23**. Một số tên artifact lô trước mang ngày 2026-09-24; không dùng tên đó làm bằng chứng thời gian.
- Baseline đỏ bằng `ThumbSidebar.nativeLifecycle.test.tsx`: sau khi đổi chỗ hai bản sao cùng trang rồi cuộn một bản ra/vào hai lần, cleanup hủy request bản còn mounted. Khóa index của Lô 19 không đủ vì React giữ component khi reorder. Test khác xác nhận thiếu `cancelOwner` khi đóng sidebar và observer còn giữ node đã rời DOM.
- Sửa: group theo ID lần mount, không theo index; dọn owner khi đóng panel/tab hoặc đổi revision; kiểm source còn current trước khi dùng Blob; bỏ observe node khi ref detach. Không thay DPI, số worker, màu hay native engine.
- Sáu test tích hợp chạy component/coordinator/scheduler thật (giả lập viewport mount và IPC): reorder+remount, unmount+response muộn, đóng/mở panel, đổi revision, hai tab cùng file, observer detached-node. Test string-key cũ được thay bằng test hành vi; helper không export từ component để Fast Refresh/lint hợp lệ.
- Typecheck đạt; lint ba file TS liên quan đạt; Vitest toàn thư mục `acrobat` + coordinator/scheduler/LiveTile: **123/123 test, 15 file**. Runtime dev smoke `docs/audit/thumbnail_lifecycle_smoke_2026-09-23.json`: 1.000 trang, 5 DOM item ở đầu/cuối, index cuối 999. Gate này **chỉ là DOM**, không chứng minh mọi ảnh overscan hoặc parity pixel đã đạt.
- Đính chính phạm vi: dùng chung coordinator/worker-affinity **không đồng nghĩa** thumbnail đã dùng chung Blob/scene PPE với trang chính. Thumbnail hiện vẫn là PDFium display; shared scene/cache xuyên consumer còn trong kế hoạch, chưa đánh dấu hoàn tất.

## Lô 21 — Sửa phép đo canvas và truy nguyên PPE reject

- Source xác nhận harness cũ chỉ quét `.tile-container img`, trong khi LiveTile hiển thị ImageBitmap bằng canvas và ẩn img. Vì thế `tiles=[]/sharp_coverage=0` của các lô 11–12 không đủ chứng minh frame trắng/capability thiếu.
- Sửa: canvas có metadata đúng bitmap **sau drawImage**; không thay đổi theo target zoom đang chờ. Harness đọc cả img/canvas, giữ gate hình học/độ nét/compositor; phân loại body reject theo allowlist và chỉ ghi kind/code/hash (không lưu chi tiết PDF). Không nới gate PPE-only: reject dù cancelled vẫn chưa được chấp nhận.
- Test LiveTile khóa dấu vết canvas không đổi khi zoom mới còn pending; self-test harness khóa taxonomy, privacy và gate không bị nới.
- Verify: typecheck đạt; LiveTile/coordinator/renderZoomPolicy **37/37**; self-test PPE-only và hybrid đạt. Lint LivePageFrame còn **10 lỗi/4 cảnh báo có sẵn**: đối chiếu HEAD và bản vá có cùng rule/severity/nodeType/nội dung đầu dòng; không có diagnostic mới trong lô này.
- Runtime file khách SHA `574af320…ff9a1`: **3 fulfilled, 3 cancelled, 0 unsupported quan sát được**, không PDFium display. Canvas phủ **100%**, stableFrames **2**, FCVF **4856 ms**, shell **1333 ms**. Report `docs/audit/viewer_customer_rejection_probe_2026-09-23.json` vẫn `complete=false` vì gate không chấp nhận reject; warm chưa chạy.
- **Đính chính kết luận lô 11–12**: số reject khi đó chưa được phân loại; không được gọi là capability-reject hoặc kết luận file không tương thích PPE. Lượt mới chứng minh cancellation, không chứng minh mọi trang/capability đều được hỗ trợ.
- Bằng chứng định hướng tối ưu tiếp (không hạ chất lượng ở lô này): log page 1 fit `zoom=0.174`, target `render_zoom=0.958`; canvas **2173×3622** đặt trong khung khoảng **395×657**, mật độ **5.5×** mỗi cạnh. PPE 92 DPI `total_ms=2766`; prime 24 DPI `total_ms=708`, prime ready khoảng 1063 ms. Cần đo/giảm công việc lặp và giữ frame đầu trong khi target đầy đủ chạy; FSP harness không đại diện mọi pixel prime.

## Lô 22 — Observer không vượt cổng settle target accurate

- Baseline đỏ: `onVisible`/IntersectionObserver gọi `_loadTile` trước hoặc trong timer 250 ms; test quan sát request DPI trung gian được phát dù đã có frame prime. Timer ở Lô 5–6 mới chỉ chặn một entrypoint nên chưa bảo đảm gom layout.
- Sửa trong LiveTile: cài timer trước khi đăng ký observe; `_loadTile` kiểm cùng timer, kể cả lời gọi observer. Timer xong mới phát target cuối; không đổi giá trị 250 ms, DPI cuối, số worker hoặc bitmap prime.
- Test khóa chuỗi prime 0.25 → target 0.75 → target 1: observer đồng bộ và callback lặp không được phát request trước deadline mới; sau deadline chỉ xin một request target 1, prime vẫn hiện trong thời gian chờ. Typecheck đạt; LiveTile/coordinator/renderZoomPolicy **38/38**; mở rộng toàn acrobat + LiveTile/coordinator/scheduler **125/125, 15 file**.
- Runtime dev trên cùng file khách: `viewer_customer_settle_probe_2026-09-23.json`; reject **3 → 2**, không còn request **92 DPI cancelled** như lô 21; còn hai cancellation 24 DPI ở trang 1/2. Bitmap cuối giữ **2173×3622**, coverage **1**, stableFrames **2**; native 92 DPI **2696 ms**.
- Không tuyên bố tăng tốc tổng thể từ một lượt: FCVF **4856 → 5232 ms** (+7,7%), FSP tương quan LiveTile **4654 → 1685 ms** (phạm vi đo FSP vẫn có giới hạn đã nêu). Bản vá bảo đảm cổng gom request chạy đúng; cần tiếp tục loại request 24 DPI trùng, giảm công việc raster lặp và đo nhiều lượt. Gate PPE-only vẫn `complete=false` vì còn cancellation; không nới gate.

## Lô 23 — Viewer nhận trạng thái prime và dùng request đang chạy

- Bằng chứng source: kho first-frame chỉ có `peek`, không thông báo ready; Viewer sau grace có thể tự render trang 1 trong khi prime đã chạy. `requestsByIdentity` giữ promise cả sau adopt/release/TTL nên mở lại có thể nhận kết quả cũ không còn thuộc kho frame.
- Thay đổi: trạng thái pending được khóa bằng native document token; đăng ký theo path và dùng `useSyncExternalStore` để nhận ready/error. Chỉ trang 1, không xoay, đúng FOGRA39/relative/proof mặc định mới chờ prime cùng revision; không chặn shell, profile khác hay tài liệu khác. Sau khi prime lỗi thì cổng mở cho pipeline thường thử lại. Không tăng grace, hạ DPI hay đổi engine.
- Kho prime nhả promise theo adopt/release/TTL; job cũ xong sau save-over không được ghi đè frame mới. Năm test thư viện kiểm dedupe hai File, notify đúng token/path, nhận quyền/mở lại, lỗi/retry, save-over và TTL (một test kiểm nhiều bất biến).
- Verify: typecheck đạt; lint thư viện/test mới đạt; mở rộng acrobat/LiveTile/dispatcher/coordinator/scheduler/tile cache: **161/161, 18 file**.
- Runtime dev `docs/audit/viewer_customer_prime_shared_2026-09-23.json` trên file khách: **3 fulfilled, 1 cancelled** (chỉ trang 2 nền ở 24 DPI). Không còn request trang 1 24 DPI trùng; page 1 nhận prime rồi xin target 92 DPI một lần. Native prime **673 ms**, ready **952 ms**; native target **2567 ms**, bitmap **2173×3622**, coverage **1**, stableFrames **2**.
- FCVF một lượt **4637 ms** so với **5232 ms** ở lô 22; chưa phải P95 hoặc kết luận tốc độ toàn corpus. Report vẫn `complete=false` vì gate còn từ chối cancellation trang 2; không nới gate để lấy pass. Chưa hoàn tất shared scene/cache PPE và các gate còn lại.

## Lô 24 — Không hủy bitmap vì callback metadata đổi identity

- Baseline test đỏ ở cả priority 10/100: chỉ thay object callback `getTileUrl` (giữ fileKey/trang/zoom/clip/owner) đã gọi cancel và render lại. Cache của LiveTile vốn khóa theo pixel identity, không theo object function; cleanup in-flight trước đây không nhất quán với cache-hit.
- Sửa: ref giữ builder mới nhất cho request kế tiếp; sự thay đổi callback đơn thuần không restart effect. Trạng thái có/không builder vẫn nằm trong dependency; thay fileKey/revision/profile/zoom/owner vẫn hủy và loại response cũ. Không đổi DPI/worker/engine hay nội dung pixel.
- Năm test mới: active/background giữ request qua metadata; zoom tiếp theo dùng callback mới; đổi revision hoặc profile loại bitmap cũ; bỏ rồi gắn lại builder vẫn hủy/khởi động đúng. Typecheck đạt; mở rộng regression **166/166 test, 18 file**.
- Runtime `docs/audit/viewer_customer_metadata_stable_2026-09-23.json`: cold-open đầu tiên qua gate **PPE-only + pixel** với **3 fulfilled / 0 rejected / 0 display**, coverage **1**, hai frame ổn định, bitmap **2173×3622**, shell **1066 ms**, FCVF **4601 ms**. Không dùng một sample làm P95.
- Warm zoom chưa đạt toàn harness: `readIpcTrace` chờ rỗng 5 giây trong khi các tile nền còn chạy; native log sau đó xác nhận chúng hoàn tất (tile 512×512/188 DPI, queue kéo dài khoảng 5 giây). Không tự coi timeout trace là trang trắng, không tăng timeout để lấy pass. Report tổng vẫn `complete=false`, 1/2 run valid; cần tách timing viewport khỏi drain toàn bộ prefetch mà vẫn giữ chứng cứ pending/failure.
- Phạm vi môi trường: Vite + binary debug có sẵn, tập trung đường render native; sidecar HTTP không được mở trong lượt này nên report có `ERR_CONNECTION_REFUSED`. Không phải full-app/release smoke và không chứng minh hiệu năng dưới tải backend.

## Lô 25 — Đo riêng viewport/drain và baseline 30 cặp với backend

- Harness chốt snapshot ngay sau frame gate, sau đó drain IPC trong **phần còn lại của deadline tổng 60s**. FSP/FCVF không cộng thời gian drain; hết deadline vẫn pending/error thì report thất bại và giữ snapshot. Reset lượt kế tiếp vẫn đòi trace rỗng, không trộn hai transition.
- Probe `viewer_customer_full_dev_drain_2026-09-23.json` xác nhận thêm false-negative cũ: mọi PPE request hoàn tất, canvas sharp coverage 1, nhưng harness loại tile đang hiện chỉ vì priority nền. Sửa candidate dựa vào path/page/DPI/clip/source mới và hình học viewport; giữ nguyên gate PPE-only, rejection/pending, độ phủ/độ nét và hai screenshot ổn định. Self-test khóa tile nền đúng viewport được nhận; sai trang hoặc surface trước trigger vẫn bị loại. Tên correlation đổi từ `interactive-geometry` sang `visible-geometry` cho đúng phạm vi.
- Smoke đủ backend (`/health=200`, token dev tạm dùng chung với Tauri), Vite và binary debug: `viewer_customer_full_dev_visible_2026-09-23.json` **2/2 valid**, không console/HTTP error. Không dùng `run_dev.bat` để tránh dừng process không thuộc lượt đo; không build installer.
- Baseline chính file khách **30 cold + 30 warm**, `viewer_customer_baseline_60_2026-09-23.json`: **60/60 valid, 0 PPE rejected, 0 PDFium display, 0 console/HTTP error**. Máy i5-13400/16 luồng/32 GiB RAM; provenance ghi HEAD và hash binary/frontend/harness. Đây là cache ứng dụng lạnh, **không xóa cache OS**, không phải corpus Standee/release hay checkout sạch.

| Mốc | P50 | P95 |
|---|---:|---:|
| Shell cold | 984 ms | 1058 ms |
| FSP cold (phạm vi LiveTile đã nêu) | 3952 ms | 4297 ms |
| FCVF cold | 4570 ms | 4821 ms |
| FSP warm zoom | 905 ms | 1503 ms |
| FCVF warm zoom | 1164 ms | 1735 ms |
| Drain IPC sau viewport warm | 6060 ms | 6322 ms |

- Warm blank-gap **0** ở cả 30 lượt; cold blank-gap P95 **0**, max **308 ms** (có thể thuộc chờ pixel đầu; chưa chứng minh invariant gap sau committed riêng). `complete=true` của artifact chỉ là **baseline 60 lượt này đạt validity/pixel gate**, không có nghĩa đạt chỉ tiêu độ trễ toàn kế hoạch.
- Còn cần tối ưu: shell gần 1s, cold sharp gần 4.8s P95, warm sharp 1.7s P95; chưa đạt chỉ tiêu trải nghiệm. Shared scene/resource/image và việc chuẩn bị file/shell vẫn phải xử lý theo số đo, không tự chuyển sang renderer khác hoặc hạ chất lượng.

## Lô 26 — Chuyển việc chờ prime sang Viewer, bỏ grace giữ shell

- Trace source bác bỏ giả thuyết chờ hai lần: dispatcher chỉ prime nền; mỗi đường mở trong ImpositionTab chờ grace một lần. Tuy nhiên grace 250 ms luôn hết trước prime ~0,7–1s trên file khách, nên chỉ trì hoãn mở Workspace. Sau lô 23 Viewer đã theo dõi pending/ready/error theo document token và không render prime trùng.
- Sửa mặc định `VIEWER_FIRST_FRAME_GRACE_MS=0`: nhường một lượt event loop, không hủy request prime; tùy chọn grace tường minh vẫn giữ. Không sửa ImpositionTab đang có thay đổi người dùng, không đổi native/DPI/chất lượng.
- Test đỏ → xanh: shell được nhả ngay ở timer 0 trong khi prime còn chạy; request vẫn hoàn tất sau đó. Typecheck đạt, lint hai file TS đạt; regression mở rộng **175/175 test, 19 file**.
- Smoke `viewer_customer_shell_handoff_smoke_2026-09-23.json` **2/2 valid**. Không suy tốc độ từ smoke đầu (shell 1073 ms, có chi phí warmup app/module).
- Sau smoke, baseline cùng cách đo **30 cold + 30 warm**, `viewer_customer_shell_handoff_60_2026-09-23.json`: **60/60 valid, 0 rejection/display fallback/console/HTTP error**, bitmap cuối **2173×3622**. Hash native và harness không đổi so với lô 25.

| Chỉ số | Lô 25 P50/P95 | Lô 26 P50/P95 |
|---|---:|---:|
| Shell cold | 984 / 1058 ms | **415 / 504 ms** |
| FCVF cold | 4570 / 4821 ms | **4632 / 4846 ms** |
| FCVF warm zoom | 1164 / 1735 ms | **1169 / 1245 ms** |

- Shell P95 giảm khoảng **52%**, nhưng ảnh nét cold P95 gần như không đổi (**+0,5%**). Không gọi đây là tăng tốc raster. Zoom blank-gap vẫn **0**; cold blank-gap P95 **1009 ms** vì shell mở trước ảnh, khác với khoảng trắng sau một frame đã committed. Không dùng thay đổi FSP lớn để khẳng định ảnh đầu nhanh lên tương ứng vì hạn chế tương quan prime/underlay của harness.
- Giữ bản vá để giao diện phản hồi sớm hơn; tổng kế hoạch chưa đạt. Phần tiếp theo phải đi vào chi phí dựng bitmap lớn/scene-resource và các gate còn thiếu, không tiếp tục giảm DPI hoặc giấu skeleton để làm đẹp số đo.

## Lô 27 — Profiler lõi vector, bác bỏ nhánh cache ảnh cho trang 1

- Binary profiler cũ từ tháng 8 được bỏ khỏi phép đo; build riêng probe source hiện tại, không build/cài app hay installer. Probe 92 DPI, 3 render cùng session, render budget 4096 MiB/resource cache 512 MiB **chỉ dành cho probe**, không đổi policy app.
- Baseline lõi: mở/parse **45.4 ms**; raster cold **1820 ms**, warm **1651/1591 ms**; chuyển mực→sRGB **269–308 ms**. PNG proxy trong profiler **không tương đương encoder runtime**.
- **Đính chính giả thuyết trong lượt này:** liệt kê Image XObject toàn file không đủ chứng minh trang 1 dùng chúng. Trace content từng trang bằng pikepdf cho thấy trang 1 **292041 operator, 6 Form, 0 Image XObject**, khoảng **28910 end_path** trong PPE; ảnh Indexed ở trang 2. Thử nghiệm cache Indexed đạt test fixture nhưng **0 hit** trên trang 1 và không cải thiện thời gian; đã hoàn tác hoàn toàn (kể cả test thử), không đưa vào commit.
- Thêm feature **`perf-probe`**, mặc định tắt, chỉ đếm thời gian trong build probe; không đổi toán học raster. `perf_profile` xuất `raster_detail` và bổ sung hit/miss Form. Timing các span là **inclusive**, không cộng chúng thành tổng.

Lệnh tái lập (từ `print_engine/`):

```powershell
cargo build --release --offline --example perf_profile --features perf-probe
.\target\release\examples\perf_profile.exe "D:\pdfcompare\test\poster retro - Khắc Trung - 0854444414.pdf" 92 3 full 4096 512
```

| Nhóm (lượt warm thứ hai) | Số lần | Thời gian |
|---|---:|---:|
| Toàn pha raster | — | 1600 ms |
| end_path, gồm các mục bên dưới | 28910 | 830 ms |
| Tạo màu tô | 28983 | 23 ms |
| Coverage fill/stroke | 28909 | 194 ms |
| Composite fill/stroke | 28002 | 597 ms |

- Form cache warm đã hoạt động: 6 rồi 12 hit, tổng 6 miss; khoảng 179.7 MB resource được giữ. Vì thế chưa có bằng chứng cần thay parser hoặc giải mã lại Form là nút thắt chính. Phần ngoài end_path của pha raster (~770 ms) vẫn cần profile tiếp.
- Probe trước và sau instrumentation đều trả **2173×3622**, 23611818 byte RGB, checksum u64 **`13864267892951180143`**. Output raw chẩn đoán nằm tại `.tmp/customer-vector-profile-92.json` (không phải artifact release/P95).
- Verify: toàn bộ `cargo test --release --offline` mặc định đạt; bật `perf-probe`: **735 passed, 4 ignored**, không lỗi. Bốn ignored là benchmark thủ công, không bị sửa để pass. Chưa rebuild Tauri/maturin vì lô này chỉ thêm công cụ đo opt-in, chưa đổi kernel mặc định.
- Hướng lô sau: composite/vector và chi phí thực thi state/path, sau đó đo pixel parity trước khi giữ bản tối ưu. Không tuyên bố app nhanh lên từ lô profiler này.

## Lô 28 — Composite Normal: hoist điều kiện theo paint, giữ công thức pixel

- Sửa `ink.rs`: nhánh mực Normal được chọn một lần mỗi kênh; dùng slice theo hàng cho mực/alpha để tránh dispatch/kiểm biên lặp. Thử riêng chỉ cải thiện nhỏ. Profiler tách thêm RGB sidecar xác nhận ~350 ms nằm ở đó.
- Nhánh RGB Normal trên `OpaqueBackdrop` chuẩn bị màu nguồn/declared/overprint một lần mỗi path, không lặp kiểm mode và clamp nguồn ở mỗi pixel. Nhánh group premultiplied và blend khác vẫn dùng đường tổng quát; công thức float, thứ tự nhân/cộng, trạng thái CLEAN/DIRTY/INVALID/LOSSY, spot và alpha giữ nguyên. Không thêm cap/worker/buffer hoặc đổi DPI.
- Test đối chiếu với `composite_at` cũ trên toàn bộ planes/alpha (bit-level), RGB/state và ngoài ROI: 360 tổ hợp loại sidecar/nguồn RGB, overprint, declared mask, alpha, Normal/SoftLight/Hue. Test xanh cả trước và sau bản vá.
- A/B lõi có binary baseline giữ riêng; dữ liệu `docs/audit/ppe_composite_ab_2026-09-23.json` gồm bản cũ, nhánh Normal-only trung gian, bản cuối và thử ít tài nguyên. Cùng file khách/92 DPI/FOGRA39/options, tất cả trả **2173×3622**, checksum u64 **`13864267892951180143`**.

| Phép đo lõi (lượt warm) | Trước | Sau |
|---|---:|---:|
| Composite | 594–621 ms | **310–319 ms** |
| Toàn raster | 1593–1643 ms | **1298–1317 ms** |
| Render gồm chuyển màu | 1874–1920 ms | **1577–1596 ms** |
| Raster khi Rayon=1, render budget 1536/cache 64 MiB | 1738–1750 ms | **1450–1456 ms** |

- Đây là probe ít mẫu, không phải P95 app; chế độ Rayon=1/cache nhỏ là mô phỏng, chưa thay máy RAM thấp vật lý. Không tăng concurrency để lấy tốc độ. Thời gian composite giảm khoảng 47%, raster khoảng 19% trong probe cùng máy.
- Verify: PPE mặc định **735 passed/4 manual benchmarks ignored**; bật profiler **736 passed/4 ignored**. Maturin dev release và Tauri debug (overlay dev, không installer) rebuild đạt. Backend PPE/native/facade/session/memory/overprint **118 passed**; một warning Pydantic có sẵn. Tauri có warning dead-code ở phần ngoài lô; không nới gate.
- Runtime `docs/audit/viewer_customer_composite_smoke_2026-09-23.json` bằng hai binary mới: **2/2 valid, 0 rejection/fallback/console/HTTP error**, cold FCVF **4422 ms**, warm zoom **1124 ms**, blank-gap quan sát được **0**. Không gọi một cặp này là P95 mới. Report ghi hash EXE/PYD; source unrelated vẫn giữ nguyên.
- Phần chưa đóng: state/path ngoài end_path và raster còn ~1,3s ở lõi; end-to-end cold vẫn nhiều giây, cần tối ưu tiếp và đo lại P95 cuối chiến dịch. Không đánh dấu cả kế hoạch hoàn tất.

## Lô 29 — Bỏ ghi zero thừa khi sao chép group, tái dùng clip BBox an toàn

- Profiler bổ sung (chỉ feature `perf-probe`) bác bỏ giả thuyết state/path: q/Q/cm **~12 ms**, dựng path **~35 ms**; chuẩn bị 6 transparency group **395–401 ms**, hoàn tất group **~60 ms**. Không sửa các operator theo suy đoán.
- `copy_samples` cấp phát fallible rồi sao chép trực tiếp backdrop mực/RGB/state, bỏ lượt zero bị ghi đè; alpha child vẫn zero, group isolated vẫn khởi tạo trắng/zero. Không unsafe, không giảm MemoryBudget/cap và không tăng worker. Test khóa bit mẫu, không alias dữ liệu cha, nhả reservation khi drop và không rò reservation khi child RGB thất bại.
- BBox fast path chỉ cho chữ nhật axis-aligned phủ **toàn bộ raster**, kể cả xoay 90°. Trả lại Arc clip/None thay cho clone+intersect mask toàn 255. Test so byte mask với đường cũ ở cả AA/non-AA; BBox chạm một phần pixel và shear phải đi đường đầy đủ. Không cull nội dung Form/metadata.
- Report `docs/audit/ppe_group_copy_bbox_2026-09-23.json` chứa probe trước/sau và smoke app. Group setup warm **395–401 → 268–270 ms**, raster **1345–1365 → 1212–1214 ms**. Lợi ích chính đã thấy ở copy-only (**275–281 ms**); không gán phần chênh nhỏ còn lại riêng cho BBox vì nằm gần nhiễu đo.
- Full-page 92 DPI giữ **2173×3622**, checksum u64 **`13864267892951180143`**; tile 188 DPI ở `(1024,512,512,512)` giữ checksum **`9995153439471946921`**. Probe Rayon=1/render1536/cache64 MiB vẫn đúng pixel và raster khoảng **1349–1359 ms**, chưa đại diện máy RAM thấp vật lý.
- Verify: PPE mặc định **738 passed/4 benchmark ignored**; bật profiler **739/4**; backend/native/facade/session/memory/overprint **118 passed**. Đã rebuild/cài native dev và rebuild Tauri debug, không installer. Các warning Pydantic/dead-code ngoài lô vẫn tồn tại.
- App smoke bằng binary mới **2/2 valid**, 0 reject/display fallback/console/HTTP error; cold FCVF **4114 ms**, warm zoom **1127 ms**, không blank-gap trong cặp đo. Lần gọi harness quá sớm trước React root đã dừng trước dispatch; chỉ thử lại khi app/health sẵn sàng, không restart job đang chạy.
- Đây là lô tối ưu lõi có kiểm parity; chưa thay thế baseline P95 sau cả chiến dịch và chưa đóng các hạng mục kiến trúc/corpus còn thiếu.

## Lô 30 — Chốt RGB sidecar bằng LUT bất biến, song song theo pixel

- Profiler opt-in tách `finalize_rgb`: baseline khoảng **191–204 ms** trên trang 1 file khách @92 DPI. Vòng cũ mượn cùng LUT và tăng/giảm Arc cho từng pixel; đây là công việc có thể bỏ mà không đổi công thức màu.
- Sửa: lấy LUT một lần cho buffer; chỉ chia sẻ LUT bất biến, không đưa `ColorManager`/LCMS không-Sync qua thread. Dùng pool/ngưỡng `should_parallelize_frame` đã có, không thêm pool/cap/buffer. Nhánh nhỏ hoặc một thread vẫn scalar; alpha, spot, thứ tự toán học và trạng thái LOSSY giữ nguyên. Không có DIRTY thì không cần dựng LUT; thiếu LUT chỉ đánh dấu pixel DIRTY thành LOSSY.
- Test đối chiếu công thức cũ ở mức bit qua pool 1/4, ảnh nhỏ/lớn, opaque/premultiplied, spot và mọi trạng thái sidecar; test profile không dựng được LUT. Toàn Rust mặc định **740 passed/4 benchmark ignored**, profiler **741/4**; backend PPE/native/facade/session/memory/overprint **118 passed**. Chạy lại hai test finalize sau điều tra runtime: **2/2**. Đã rebuild native dev release và Tauri debug, không installer; warning ngoài phạm vi giữ nguyên.
- `docs/audit/ppe_finalize_rgb_2026-09-23.json` giữ **tất cả** probe, kể cả lượt nhiễu ở các pha không sửa. Cặp control nối tiếp: finalize warm **204 → 23,6–24,9 ms**; raster **1266–1273 → 1052–1088 ms**; render gồm chuyển màu **1552–1559 → 1351–1386 ms**. Đây là số đo lõi ít mẫu, không phải tốc độ cả app hoặc P95.
- Probe một thread/render1536/cache64 MiB không đổi checksum nhưng timing nhiễu lớn; không suy thành kết quả máy yếu vật lý. Full-page giữ checksum u64 **`13864267892951180143`**, tile 188 DPI `(1024,512,512,512)` giữ **`9995153439471946921`**. Tile nhỏ đi scalar, finalize khoảng 7–8 ms trước/sau; không tuyên bố tăng tốc tile từ cặp này.
- Smoke app **2/2 valid**, 0 reject/fallback/console/HTTP error, bitmap full-page vẫn **2173×3622**. Cold FCVF **4573 ms** (chậm hơn smoke lô 29), warm **990 ms**, warm drain **10961 ms**. Giữ kết quả này, không suy smoke là cải thiện tổng thể.
- Baseline kế tiếp dự kiến 30 cặp dừng ở lượt 11: `docs/audit/viewer_customer_kernel_60_2026-09-23.json` **10/11 valid, complete=false**, có 11 cancellation và viewer chuyển khỏi trang 1. **User xác nhận đã cuộn chuột trong lúc đo**; trace sau đó có trang 2/4/5. Đây là lượt benchmark bị can thiệp, không phải bằng chứng PPE không hỗ trợ file hoặc lỗi engine. Không dùng các sample đó làm P95 mới, không xóa báo cáo thất bại hay nới gate để lấy pass.
- Còn mở: chạy lại 30 cặp không can thiệp để kiểm hồi quy end-to-end; bổ sung tripwire trang/zoom và dấu vết thao tác vào harness. Các cổng corpus, shared thumbnail/scene và runtime bản cài vẫn chưa đóng; toàn kế hoạch chưa hoàn tất.

## Lô 31 — Harness từ chối đo nhầm trang/zoom và input xen ngang

- Chỉ sửa `scripts/ppe_viewer_webview_baseline.mjs`, không đổi app. Cold/warm của kịch bản này đều phải đo trang nguồn 1/vị trí 1, không xoay; warm phải đạt đúng `viewerZoom` mục tiêu. Auto-fit cold vẫn được điều chỉnh zoom tự nhiên. Frame sắc nét ở trang khác không được tính là hoàn thành.
- `scenarioEvidence` kiểm target ở frame và sau drain; bắt đổi trang trong vòng poll. Listener thụ động chỉ đếm `wheel`/`pointerdown`/`keydown` có `isTrusted`, không chặn thao tác, không lưu phím, text, toạ độ hay delta. Có input hoặc mất probe thì lượt không hợp lệ; `finally` dọn listener. `isTrusted` không chứng minh tác nhân là người hay automation, chỉ là dấu vết đầu vào của cửa sổ đo.
- Giữ nguyên PPE-only/rejection/pending, pixel coverage, stable-frame và deadline. Không đổi dữ liệu báo cáo lô trước. Không quan sát liên tục mọi thay đổi state trong drain; đây không phải bảo đảm phát hiện mọi dạng can thiệp ngoại lai.
- `node --check` và self-test cả PPE-only/hybrid đạt: ca đúng, sai trang/vị trí/xoay/zoom, drift sau frame, input xen ngang, mất probe, privacy, listener cleanup và không tràn số đếm sang lượt kế. Đây là verify tự động, **chưa chạy lại runtime/P95** sau thay đổi harness.
- Công cụ Computer Use trả `Computer Use was not approved to use PrynX` khi xin quan sát cửa sổ; không tiếp tục thao tác app qua công cụ khác. Cần được cấp quyền lại trước lượt tự động điều khiển/đo UI kế tiếp. Không kill/restart các process dev ở bước này.

## Lô 32 — Thu gọn chương trình bất biến để giảm eviction Form

- Trong lúc quyền UI còn thiếu, chỉ đo process lõi độc lập và kiểm thử; không điều khiển, kill hay thay binary của app đang chạy. Probe dùng PPE session thật: trang 1 @92 DPI → hai vòng trang 1–5 @24 DPI trên file khách. Đây là bằng chứng cho retained resource, **không phải benchmark sidebar**, vì sidebar vẫn gọi PDFium.
- Baseline: cache Form trang 1 **179.687 MB**; cuối chuỗi 512 MiB cache có **36 Form misses/19 evictions**, chỉ 6 hits. Trace source tới `lopdf` tokenizer và test đỏ xác nhận lệnh `q` không có operand vẫn giữ capacity **4**; capacity tăng trưởng này tiếp tục nằm trong chương trình bất biến.
- `PageProgram` giữ mảng operator bằng `Box<[Operation]>`; operand Vec của mỗi lệnh chuyển qua boxed slice rồi về Vec có capacity đúng len. Không đổi tokenizer, thứ tự/giá trị operand, inline image, warning, resource scope, DPI, ngân sách cache hoặc worker. Bộ đếm RAM tiếp tục tính vùng sở hữu thật, không hạ số kế toán để giả vờ tiết kiệm.
- Sau sửa, cache Form trang 1 **102.169 MB** (giảm **43,1%**). Toàn chuỗi giữ **419.988 MB** trong cùng budget 512 MiB; cuối chuỗi **24 Form hits/18 misses/0 evictions**. Kết quả trước/sau ở 8 chuỗi lõi (**88 render**) khớp dimensions/checksum/cờ soundness; 11 render qua binding mới cũng khớp SHA256 RGB và warning với native trước sửa.
- Đo process độc lập theo thứ tự **ABBA**, cùng file/options/budget: peak working set quan sát **1056,8–1057,3 → 1009,5–1010,0 MiB**; peak private **1064,0 → 1009,1–1010,8 MiB**. Lấy mẫu danh nghĩa 25ms, không phải peak toàn cây app hoặc đỉnh tuyệt đối giữa các mẫu.

| Chỉ số lõi trong ABBA | Trước | Sau |
|---|---:|---:|
| Trang 1 @92 DPI cold | 1501–1530 ms | 1533–1536 ms |
| Trang 1 @24 DPI quay lại sau 5 trang | 329–334 ms | 194–198 ms |
| Trang 4 @24 DPI vòng hai | 387–401 ms | 266–275 ms |

- Không giấu trade-off: cold có chi phí thu gọn, khoảng **0,2–2,3%** trong cặp control này; probe đầu riêng tăng khoảng 5,2%. Đây là ít mẫu, chưa phải P95. Thử Rayon=1/render1536/cache64 MiB giữ pixel, peak RAM giảm tương tự; cold **3292,8 → 3296,8 ms**, warm gần như ngang nhau vì cache nhỏ vẫn phải giải mã lại. Không đại diện máy RAM thấp vật lý.
- Verify: Rust mặc định **741 passed/5 manual benchmarks ignored**, profiler **742/5**; benchmark mới thuộc nhóm ignored nhưng đã chạy tường minh ở trên. Consumer Page/Form/Pattern/Type3/text/inline image và các đường màu/transparency nằm trong toàn bộ suite, không cập nhật snapshot.
- Wheel native dev được build vào `.tmp` rồi cài **chỉ vào thư mục staging**; pytest assert đúng đường PYD trước khi chạy. Backend/native/facade/session/memory/overprint **118 passed**, một warning Pydantic có sẵn. Hash PYD đang cài và Tauri EXE vẫn giữ nguyên của lô 30; chưa đưa lô 32 vào app đang chạy.
- Dữ liệu đầy đủ, cả lượt nhiễu và provenance: `docs/audit/ppe_program_compaction_2026-09-23.json`. Còn phải nối thumbnail với đúng session/lane/profile và đo UI/P95 khi có quyền; không đánh dấu shared-thumbnail, toàn kiến trúc hay nghiệm thu bản cài là xong.

## Lô 33 — Đặt chỗ worker nền nguyên tử theo snapshot tài liệu

- Re-audit `dispatch_worker_request` tại base `e3618af`: tra `document_affinity`, chọn/khóa worker và `remember_document_affinity` nằm ở các vùng khóa riêng. Hai request cold cùng snapshot có thể đều thấy miss rồi chọn hai lane. Đây là khoảng hở trong lô affinity 2, chưa phải bằng chứng số lần mở PDF thực tế của một lượt UI.
- Tách bước reserve để kiểm chứng đúng thuật toán. Test đỏ xác nhận khóa registry đã được nhả giữa lookup và publish. Sửa `reserve_background_affinity` giữ chúng trong một critical section ngắn; bộ chọn chỉ dùng `try_lock`, không spawn, render hoặc đợi worker trong khóa registry.
- `reserve_background_worker` giữ luôn guard lane rảnh đã chọn; nếu tất cả lane bận hoặc đã có affinity, nhả khóa registry trước khi chờ lane. Không đổi số worker, RAM tiers, pixel/ICC, wire protocol, priority hoặc đường interactive. Tài liệu khác vẫn được lấy lane rảnh; không gom cả máy vào một worker.
- Năm test mới: atomic lookup/publish; 8 thread đi qua reserve và Mutex worker thật chỉ tạo một assignment; hai tài liệu dùng hai lane và chỉ retire đúng lane; registry vẫn truy cập được khi worker bận; metadata không có identity và revision khác không bị gộp. Test key/save-over cleanup cũ giữ nguyên. Các test reserve không spawn process/app UI.
- Verify: `cargo test --offline --lib pdf_engine::render_worker::tests` **38 passed/3 manual runtime probes ignored**; `cargo check --offline` đạt. Test build có 2 warning, check có 17 warning ở các hàm có sẵn ngoài lô. `git diff --check` đạt.
- Chưa rebuild/thay EXE đang chạy: hash vẫn `33c461f39ffaca6739b5f7e13fd15175a678ebc63774f7aa2672846e90ac8764`. Chưa đo UI/open-count/P95 cho thay đổi này, không tuyên bố app nhanh hơn từ unit test.
- Phạm vi còn mở rõ ràng: affinity này vẫn chỉ dành cho lane nền; shared session giữa interactive và thumbnail còn cần giải quyết routing, preemption và profile/owner lifecycle. Các file parent Viewer/hook hiện có thay đổi khác chưa được đưa vào lô. Quyền điều khiển UI vẫn thiếu, không dùng tool khác để vượt giới hạn.

## Lô 34 — Benchmark log-only qua manager/worker thật, không mở UI

- **Chốt phương pháp mới của user:** benchmark bằng log/script, không điều khiển cửa sổ PrynX. Quyền UI đã được xin lại thành công nhưng user chọn không dùng; không được tiếp tục coi quyền UI là blocker cho benchmark. Các giới hạn đo phải ghi đúng, không thay số đo pipeline bằng tuyên bố ảnh đã xuất hiện trên màn hình.
- Thêm `examples/render_worker_bench.rs`: chỉ nhận `--prynx-render-worker`, gọi đúng `run_render_worker_stdio`, không có nhánh gọi `app_lib::run`/WebView. Build example riêng không ghi đè EXE app. Test tham số **1/1**, smoke worker thật trên file khách đạt: cold/warm PNG, cooperative cancel **2 ms**, PID worker giữ nguyên sau cancel và render tiếp thành công.
- Probe `parent_manager_log_only_baseline` gọi manager/worker production qua protocol hiện có, bắt buộc mode `required` và PPE accurate; lỗi/unsupported/fallback làm fail. Mỗi vòng xóa session tài liệu **trong worker của probe**, giữ process/OS cache; chạy full92 cold/warm, tile188 `(1024,512,512,512)`, rồi thumbnail PPE24 nền cold/warm. Đây không phải sidebar PDFium hiện tại.
- Smoke 2 vòng đạt; baseline **30 vòng × 5 pha = 150 request** đạt, request ID duy nhất, PNG khớp theo DPI/clip qua cold/warm và các lượt, không geometry approximation. Report `docs/audit/ppe_headless_log_baseline_2026-09-23.json`; log thô `.tmp/ppe_log_baseline_2026-09-23.log` giữ toàn bộ dòng, không chỉ sample đẹp. Worker hash `57dfc24f…47cec4`, parent test hash `27ac291e…296f47`, build dev (không release).

| Pha — thời gian parent gọi manager đến khi nhận PNG | P50 | P95 |
|---|---:|---:|
| Full-page 92 DPI, session cold | 2071 ms | 2218 ms |
| Full-page 92 DPI, session warm | 1788 ms | 1902 ms |
| Tile 188 DPI, session warm | 155 ms | 166 ms |
| Thumbnail PPE 24 DPI, session nền cold | 591 ms | 668 ms |
| Thumbnail PPE 24 DPI, session nền warm | 281 ms | 292 ms |

- Cùng một file nhưng main ở PID/lane Interactive, thumbnail PPE ở PID/lane Background khác: bằng chứng runtime rằng gọi cùng PPE **chưa** chia sẻ session xuyên lane. Affinity nền hoạt động đúng, cold reset cố ý cho vòng sau có thể đổi lane. Đây là mốc trước bước hợp nhất session, không coi lô 33 đã hoàn thành document-affinity toàn kiến trúc.
- Queue trong probe tuần tự này bằng 0; không suy ra queue trong app/tải đồng thời không còn là nút thắt. Không bao gồm Tauri IPC entry, WebView decode, DOM/compositor, sidebar thật hoặc cả cây RAM. P95 này không thay P95 UI lịch sử, không chứng minh tất cả chỉ tiêu trải nghiệm đã đạt.
- Regression module worker **38 passed/4 manual probes ignored**; probe log mới đã chạy tường minh ở trên. EXE app đang mở vẫn hash `33c461f3…ac8764`; không kill/restart app, backend hoặc Vite trong lô. Còn phải triển khai chia sẻ session/lane, fast path còn thiếu và các phần kiến trúc đã liệt kê — không phải chỉ còn test.

## Lô 35 — Nhường lane nhưng giữ worker PPE, và QoS đúng cho render

- Đây là bước chuẩn bị để dùng chung session, **chưa đổi routing thành một session xuyên interactive/background**. Test runtime đỏ trước sửa xác nhận ưu tiên request tương tác đã đổi PID worker PPE, làm mất cơ hội giữ session/cache.
- PPE nay gửi CancelToken, cho **100 ms chờ acknowledgement sau khi gửi control**, rồi mới dùng kill fallback nếu không đáp ứng. Request nền do ưu tiên nội bộ sẽ chờ foreground rồi retry; cancel của user vẫn kết thúc, không bị tự hồi sinh. Notice khóa theo **PID + wire request ID**, công bố khi còn giữ active registry; response phải chờ hành động preempt kết thúc trước khi nhả slot, tránh kill trễ đánh sang request kế.
- PDFium/metadata chưa có checkpoint vẫn dùng kill như trước, nhưng cùng notice theo wire ID để xử lý Ready tới sát lúc kill an toàn. Worker đã bị kill được nhả khỏi slot ngay cả khi reply Ready hợp lệ vừa tới. Affinity chỉ bị retire khi worker thực sự không còn trong slot; cancel trên worker còn sống không làm mất binding.
- **Điều tra hồi quy:** các lượt đầu có warm/preempt chậm gần 2×. Đối chứng binary cũ và ca không preempt cũng gặp hiện tượng này; chạy ngoài sandbox riêng nó không giải thích hết. Không được coi kết luận tạm “do sandbox” là nguyên nhân cuối.
- CPU probe opt-in/debug và `GetSystemCpuSetInformation` xác nhận trên máy này logical CPU **0–11 thuộc EfficiencyClass 1**, **12–15 thuộc class 0**. Các lượt chậm chuyển sang nhóm 12–15. QoS của Windows có thể ảnh hưởng chọn loại core và quản lý công suất; đây không phải lỗi công thức màu hoặc bằng chứng cache làm đổi pixel. [Microsoft: CPU set](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-system_cpu_set_information), [QoS](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service).
- Module `worker_qos` đặt **HighQoS chỉ trong process render worker** khi khởi động. Dùng `GetCurrentProcess`/`ProcessPowerThrottling`, giữ các cờ timer do caller điều khiển; không đổi affinity mask, priority class, số worker, power plan hoặc registry. OS không hỗ trợ/từ chối API thì ghi cảnh báo và vẫn render đúng như cũ. `PRYNX_RENDER_WORKER_QOS=system` giữ hành vi cũ cho A/B/rollback. [Microsoft: API HighQoS](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation).
- A/B cùng worker binary, thứ tự **system → high → high → system**, file/options giống nhau: request tương tác sau preempt **4814–4936 → 2236–2338 ms**, cùng PNG và PID được giữ. Khi cùng dùng HighQoS, manager cũ phải restart worker đạt **2248–2314 ms**, manager mới giữ PID đạt **2236–2338 ms**: gần ngang độ trễ trong probe này, không gán lợi ích 2× riêng cho preemption. Ít mẫu, không phải P95/cam kết mọi corpus.
- Kiểm runtime bản cuối: PPE nhường lane giữ PID và PNG; cancel thường **4 ms**, worker còn sống rồi render tiếp; probe không phản hồi checkpoint buộc kill **107 ms** (lượt trước 113 ms), chỉ đúng worker test. PDFium bootstrap/metadata/render, preempt lane dùng chung, cancel/restart đều đạt trên fixture 15 trang. Không mở/điều khiển UI hay dừng app/sidecar/Vite của user.
- Unit: **42 test worker + 2 test QoS** đạt; 5 probe runtime thuộc nhóm ignored được gọi riêng theo nhu cầu. Test khóa cancel nội bộ/cancel user, notice chờ hành động xong, cleanup, deadline, PID/wire identity và bảo toàn cờ QoS khác. Dữ liệu đối chứng, kể cả các lượt chậm và giả thuyết bị bác bỏ/thu hẹp, nằm trong `docs/audit/ppe_cooperative_preemption_qos_2026-09-23.json`.
- Baseline cuối bằng manager đã sửa, 8 lane/HighQoS, **150/150 request** hợp lệ và PNG khớp lô 34: P50/P95 full cold **2104/2235 ms**, full warm **1820/1988 ms**, tile warm **160/170 ms**, thumbnail PPE nền cold **620/645 ms**, warm **289/305 ms**. So với baseline lô 34, các P95 trong tập này nằm trong khoảng −3,5% đến +4,6%; không tuyên bố tăng tốc toàn corpus từ khác biệt nhỏ đó. Report gộp giữ cả baseline này và probe preemption cuối (foreground **2207 ms**, PID giữ nguyên).
- Toàn kiến trúc chưa xong: tiếp theo mới nối lease/session xuyên lane và thumbnail; các phần mở nhanh, retained resource còn thiếu, backend file nặng, transport thử nghiệm và nghiệm thu rộng vẫn giữ nguyên phạm vi.

## Lô 36 — Thử nghiệm affinity PPE xuyên lane; chưa promote vì giảm throughput

- Prototype native gắn snapshot PDF với lane và nhiều owner; foreground theo lane đã mở tài liệu, gate ưu tiên theo từng lane. Close/release/crash chỉ retire đúng lane/snapshot, request đang chạy pin binding để TTL không thu nhầm; nhiều tài liệu vẫn phân tán trên pool hiện có.
- Headless file khách: cùng PID qua full/tile/thumbnail; thumbnail PPE24 đầu dùng session main đã ấm khoảng 276–285 ms. Không phải sidebar PDFium thật, không chứng minh first-visible UI.
- Đối chứng priority trên cùng HighQoS worker: tách lane cũ foreground 2827–2842 ms, prefetch 2812–2835 ms. Dùng một session mutable: foreground 2245 ms nhưng prefetch 4183 ms. Cỡ mẫu nhỏ; đủ bác bỏ việc promote routing tuần tự như lời giải cuối, không đủ làm P95 toàn corpus.
- Đã đặt cổng thật trong code: mặc định **tắt**; chỉ dev và `PRYNX_PPE_SERIAL_DOCUMENT_AFFINITY=1` mới thử đường này. Release bỏ qua cờ. Không hạ DPI, không tăng/giảm số worker. Bước tiếp theo phải tách snapshot tài liệu bất biến khỏi trạng thái raster từng job, không đánh dấu mục shared-session hoàn thành bằng việc tắt tính năng.
- Verify cuối: 51 unit worker passed, 6 probe ignored; cargo check đạt, 17 warning có sẵn (đã bỏ warning import mới). Log-only mặc định OFF 10/10 request đúng PNG; full cold 2044–2152 ms, warm 1732–1785 ms; thumbnail vẫn ở lane nền riêng. Runtime opt-in hai tài liệu thực sự overlap, owner còn lại giữ PID, last-owner thu binding, worker bị dừng có chủ đích được restart và PNG khớp.
- Evidence gộp: `docs/audit/ppe_serial_document_affinity_experiment_2026-09-23.json`, gồm cả kết quả chậm, control trước sửa và kiểm cuối. Worker binary giữ nguyên B1D8…D3F6C; parent mới có hash riêng trong report. Không rebuild/thay app đang mở, không điều khiển UI. Các phần kiến trúc khác còn nguyên yêu cầu.
