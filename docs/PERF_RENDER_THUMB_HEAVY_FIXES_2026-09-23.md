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
