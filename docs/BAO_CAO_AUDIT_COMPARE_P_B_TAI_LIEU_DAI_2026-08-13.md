# BÁO CÁO AUDIT COMPARE P-B — TÀI LIỆU DÀI + RE-REVIEW PA-1/PA-2

**Ngày:** 2026-08-13  
**Mốc code:** worktree branch `codex/pre-release-audit-2026-08-04` (sau PA-1/PA-2, trước khi đổi trần trang)  
**Phạm vi:** (A) re-review hẹp diff PA-1/PA-2; (B) smoke test Windows thật; (C) audit P-B cho tài liệu dài 50→1.000 trang  
**Trạng thái:** lộ trình mục 6 **đã duyệt**; PB-1 → PB-3 **đã triển khai và nghiệm thu** (mục 10, nhật ký `HIEU_NANG_TOAN_DIEN_FIXES_2026-08-13.md`). Trần hiện hành: 250 trang (env override). Còn MỘT quyết định mở: nâng trần mặc định lên 1.000 (mục 10.4).

## 1. Kết luận điều hành

1. **Re-review PA-1/PA-2 tìm thấy 1 lỗi CHẶN PHÁT HÀNH đã lọt qua 119 test:** dòng gán `local_mode` trong `create_comparison_job` bị xóa nhầm trong diff PA-1 → mọi request tạo job Compare chết `NameError` ngay khi qua bước validate. Đã repro bằng gọi route thật, đã sửa cùng 2 lỗi nhỏ hơn (race hủy kép trả 500; job mồ côi sau restart không được dọn) — cả 3 có test hồi quy, 129 test đạt.
2. **Smoke Windows thật đạt 7/7 kịch bản lifecycle** trên backend của phiên `run_dev.bat` (uvicorn 8321, code hiện tại): job 20/50 trang chạy trọn, hủy đầu/giữa job dọn sạch row + artifact trong ≤1 giây, hủy sát lúc xong trả đúng semantics "job đã kết thúc", chạy lại ngay sau hủy với cùng hai file thành công. UI xác minh ở mức webview (vite) — chưa phải app đóng gói.
3. **P-B: KHÔNG nới thẳng 50 → 1.000.** Bằng chứng benchmark 50/100/250 trang: RAM đỉnh **phẳng theo số trang** (tốt — cửa sổ PA-1 hoạt động đúng) và artifact tăng **tuyến tính** (~2,1 MiB/trang khác biệt @300 DPI), nhưng **speedup pipeline suy giảm theo chiều dài tài liệu: 2,49× @50 trang → 1,41× @250 trang (300 DPI)**, và Compare hiện **không có admission theo dung lượng đĩa** trong khi nhánh xả áp lực đĩa cố ý bỏ qua artifact Compare. UI còn timeout cứng 10 phút sẽ tự gửi hủy job dài hợp lệ.
4. **Đề xuất lộ trình bậc thang:** PB-1 (admission đĩa + sửa wording trần + trần 250 có gate) → PB-2 (đo stage, giảm phần tuần tự của pipeline trên tài liệu dài) → PB-3 (timeout theo tiến độ + benchmark 500/1.000) → khi đó mới quyết định trần 1.000. Chi tiết mục 6.

## 2. Phần A — Re-review diff PA-1/PA-2

Phạm vi soát: `backend/app/api/routes/compare.py`, `backend/app/core/comparison_engine.py`, `backend/app/core/highlight_renderer.py`, `backend/app/workers/compare_task.py`, `backend/app/schemas/job.py`, `backend/tests/test_compare_queue.py`, `backend/tests/test_compare_parallel_parity.py`, `desktop/src/components/CompareTab.tsx`, `desktop/src/lib/api.ts`, `desktop/src/stores/comparisonStore.ts`, `scripts/benchmark_compare_pipeline.py`. (`pdf_processor.py`, `pdfium_lock.py`… chỉ khác EOL, không có thay đổi nội dung.)

### §RV.1 — [FIXED] P0 / S — Tạo job Compare chết NameError: `local_mode` bị xóa nhầm

- **Bằng chứng:** diff PA-1 xóa dòng `local_mode = settings.DEV_MODE or settings.IS_DESKTOP_APP` ngay trước `if local_mode and not _COMPARE_SUBMISSION_SLOTS.acquire(...)` trong `create_comparison_job`, nhưng hàm vẫn dùng `local_mode` ở 4 chỗ. Repro gọi trực tiếp route với 2 file hợp lệ: `NameError: name 'local_mode' is not defined` (script `tmp/repro_local_mode.py`).
- **Vì sao 119 test không bắt:** hai test route hiện hữu (`test_api.py`) dừng ở 422 (payload sai) và 404 (file không tồn tại) — đều raise TRƯỚC dòng `local_mode`. Toàn bộ test queue/parity gọi thẳng helper/engine, không đi qua route tạo job.
- **Fix:** khôi phục dòng gán kèm tag `PERF (audit 2026-08-13 §RV.1)`; thêm test `test_create_comparison_job_local_mode_submits_and_returns_job_id` đi hết đường tạo job local (validate → reserve slot → registry → submit executor).

### §RV.2 — [FIXED] P2 / S — Hủy kép chạy đua: `future.result()` ném `CancelledError` xuyên qua `except Exception` → endpoint 500

- **Bằng chứng:** từ Python 3.8, `concurrent.futures.CancelledError` là builtin `CancelledError` kế thừa `BaseException`. Kịch bản: hai request hủy đồng thời; request 1 `future.cancel()` thành công; request 2 đã đọc registry trước khi callback pop, thấy `future.done()` → vào nhánh chờ `future.result()` → `CancelledError` không bị `except Exception` bắt → HTTP 500 dù job đã dừng đúng.
- **Fix:** bắt `(CancelledError, Exception)` tại nhánh chờ, tag `§RV.2`; test `test_second_cancel_after_future_already_cancelled_stays_idempotent`.

### §RV.3 — [FIXED] P3 / S — Job mồ côi sau khi backend restart: hủy không dọn row/artifact dở dang

- **Bằng chứng:** registry `_COMPARE_CONTROLS` sống trong RAM process. Backend restart giữa job → DB còn `processing` + PageResult/PNG/GIF dở dang, registry trống. Endpoint cancel chuyển trạng thái nhưng không nhánh nào gọi cleanup (worker không còn tồn tại để tự dọn).
- **Fix:** khi `local_mode` và không còn control trong registry, route gọi `_finalize_interrupted_job` (idempotent) ngay sau UPDATE cancelled, tag `§RV.3`; test `test_cancel_orphan_local_job_cleans_partial_output`. Không áp cho nhánh Celery (worker khác process vẫn đang chạy và tự dọn qua DB probe).

### Các đường đã soát và không phát hiện vấn đề

| Hạng mục | Kết quả soát |
|---|---|
| Slot accounting (BoundedSemaphore) | Future done-callback là nơi trả slot DUY NHẤT (kể cả cancel queued, lỗi init); các nhánh lỗi trước khi submit pop registry + release đúng một lần. `BoundedSemaphore` sẽ ném nếu double-release — không có đường nào tới đó. |
| Deadlock nhánh chờ cancel | Route commit UPDATE cancelled TRƯỚC khi `future.result()` → không giữ khóa SQLite khi chờ; worker checkpoint theo trang nên chờ hữu hạn. |
| Generator pipeline thoát sớm | Consumer lỗi/hủy → `GeneratorExit` đi qua `finally`: cancel future chưa chạy + `pool.shutdown(wait=True, cancel_futures=True)` — không rò pool/thread. |
| OpenCV thread budget | `_compare_cv_thread_budget` có lock process + khôi phục trong `finally`; test fault đã có (`test_pipeline_restores_opencv_threads_when_compare_fails`). |
| Celery không retry job hủy | `raise_on_cancel=True` + `except InterruptedError` return; nhánh `except Exception` re-check DB `cancelled` trước khi retry. |
| Race cancel ↔ completed | Cả hai chiều dùng UPDATE có điều kiện; test `test_cancel_does_not_overwrite_job_that_completed_during_request` + smoke runtime xác nhận. |
| PDFium / DB session | Render vẫn tuần tự trên main thread; worker pool chỉ chạy OpenCV; DB session không vào worker. |
| Ghi PNG/GIF lỗi | `cv2.imwrite` False → OSError → rollback + dọn artifact (test `test_png_write_failure_rolls_back_page_and_artifact`); GIF dùng `open().write` ném OSError tự nhiên. |

## 3. Phần B — Smoke test Windows thật

Môi trường: backend uvicorn của phiên `run_dev.bat` đang chạy (`--reload` đã tự nạp code mới), đo working set trên process worker thật; gọi qua HTTP như UI; corpus A4, DPI 150, 7/20 và 17/50 trang khác biệt; thư mục kết quả `%TEMP%\PrynX-dev\results`. Script tái lập: `tmp/smoke_compare_api.py`.

| Kịch bản | Kết quả | Số đo |
|---|---|---|
| Job 20 trang chạy trọn | completed | 7,96 s; trang đầu ~2,0 s (tính cả tạo job/poll); đỉnh RAM worker 467,5 MiB; 14 artifact / 8,2 MiB |
| Job 50 trang chạy trọn | completed | 17,4 s; đỉnh RAM 494,3 MiB (KHÔNG tăng theo trang); 34 artifact / 20,1 MiB |
| Hủy ngay đầu job | cancelled | endpoint trả sau 0,62 s; `results/<job_id>` không tồn tại (đã dọn) |
| Hủy giữa job (~50%) | cancelled | 0,97 s; artifact + PageResult dọn sạch |
| Hủy khi ≥85% | job completed trước | trả đúng `cancelled=false`, "Job đã kết thúc nên không thể hủy", kết quả nguyên vẹn |
| Chạy lại ngay sau hủy (cùng file_id) | completed | 9,4 s; đủ 20 trang kết quả |
| Hủy job đã completed | idempotent | `cancelled=false`, kết quả không bị phá |

UI: đã chạy trọn luồng upload → Thực thi → progress ("Đang so sánh trang 1/20", nút **Hủy so sánh** hiển thị) → kết quả (KHÔNG ĐẠT, 7 lỗi in, GIF từng trang) trên giao diện vite/webview — **cùng bundle React với cửa sổ desktop nhưng chưa phải app đóng gói**; ca bấm Hủy trên UI desktop thật và kiểm giữ file/cài đặt sau hủy do đó **chưa xác minh runtime mức 3** (job 150 DPI xong trước khi kịp bấm trong phiên điều khiển từ xa). Người dùng có thể kiểm tay 4 bước với 2 file sẵn ở `tmp\smoke\a20.pdf`/`b20.pdf`.

## 4. Phần C — Hiện trạng code liên quan P-B (bằng chứng)

1. **Trần trang vô điều kiện + wording sai:** `compare.py` `MAX_PAGES = 50`, thông báo "Vui lòng nâng cấp phần cứng và chia nhỏ file PDF" — không đúng bản chất (trần cố định, không phụ thuộc phần cứng).
2. **Guard per-page đã có:** `_MAX_COMPARE_PAGE_PIXELS` 40 MP/trang (route, ước lượng từ metadata upload) + đề xuất DPI an toàn. Đây là guard đỉnh RAM per-page, không phải guard tổng job.
3. **Không có admission đĩa:** `HighlightRenderer.save_highlighted_image/save_gif_image` ghi thẳng vào `RESULTS_DIR/<job_id>`, không gọi `ensure_job_disk_space` (`app/core/disk_space_guard.py` — N-Up/VDP đã dùng với `estimate_nup_disk`/`estimate_vdp_disk`; Compare chưa có estimator).
4. **Cleanup hiện có:** (a) sweep filesystem 26 giờ (`cleanup.py FS_CLEANUP_MAX_AGE_HOURS=26`, `_cleanup_directory` quét đệ quy results/uploads — CÓ dọn thư mục Compare cũ); (b) cascade `expires_at=24h` của file upload xóa job + artifact kèm theo (`upload.py:147`, `cleanup_expired`); (c) `DELETE /api/jobs/{job_id}` dọn chủ động. **Nhưng** nhánh xả áp lực đĩa khi volume tụt dưới reserve (`_cleanup_storage_pressure`) chỉ nhận pattern `nup_*/vdp_*` tầng gốc — artifact Compare trong 24–26 giờ đầu KHÔNG thể bị thu hồi dù đĩa cạn.
5. **ENOSPC giữa job giờ fail-safe** (sau PA-1 + §RV): ghi PNG/GIF thất bại → OSError → job failed + dọn toàn bộ output dở dang. Song job vẫn có thể ăn đĩa tới sát 0 trước khi hỏng — vi phạm reserve policy (`minimum_free_disk_bytes` = max(2 GiB, 2 % volume, cap 20 GiB)).
6. **UI timeout cứng 10 phút** (`CompareTab.tsx` deadline 600.000 ms): từ PA-1, timeout này GỬI HỦY về backend — đúng cho job treo, nhưng với tài liệu dài hợp lệ chạy quá 10 phút (máy yếu 1 worker + DPI 300 + trang lớn) sẽ tự hủy job đang chạy đúng.
7. **Ghép trang đặc thù:** map bình bài `_map_source_pages_to_sheets` là O(pages_A × pages_B) phép so mini ở 48 DPI — 1.000 trang nguồn × 250 tờ = 250.000 phép so, bùng nổ thời gian trước cả khi vào pipeline. Căn trang lệch số trang render fingerprint 36 DPI mỗi trang (tuyến tính, chấp nhận được). Đây là hai đường phải có cap/policy riêng khi nới trần, độc lập với đường 1:1.

## 5. Phần C — Số đo benchmark tài liệu dài

Máy 32 GB / 16 luồng logic; corpus A4 sinh bằng reportlab, 1/3 số trang có khác biệt; mỗi cấu hình 1 lượt process sạch (`scripts/benchmark_compare_pipeline.py --workers 1,cpu-1 --runs 1 --pages N --dpi D`); parity PageResult + summary + SHA-256 PNG/GIF so giữa 1 và 15 worker **đạt ở cả 6 cấu hình**. Log: `tmp/pb_{150,300}_{050,100,250}.log`. Lưu ý: máy đang có tải nền của người dùng — số tuyệt đối mang tính chỉ dấu, xu hướng tin được vì seq/pipe đo cùng điều kiện.

| Trang | DPI | Tuần tự (1w) | Pipeline (15w) | Speedup | Trang đầu (pipe) | Peak RAM seq → pipe | Artifact (PNG+GIF) |
|---:|---:|---:|---:|---:|---:|---|---:|
| 50 | 150 | 7,75 s | 3,91 s | **1,98×** | 0,50 s | 272,9 → 406,2 MiB | 22,2 MiB (17 trang khác) |
| 100 | 150 | 14,87 s | 7,67 s | 1,94× | 0,64 s | 274,8 → 425,1 MiB | 44,6 MiB (34) |
| 250 | 150 | 37,07 s | 27,46 s | **1,35×** | 0,92 s | 279,1 → 415,4 MiB | 111,9 MiB (84) |
| 50 | 300 | 29,05 s | 11,69 s | **2,49×** | 0,93 s | 541,2 → 781,5 MiB | 35,0 MiB (17) |
| 100 | 300 | 58,29 s | 33,94 s | 1,72× | 0,97 s | 541,8 → 803,9 MiB | 70,3 MiB (34) |
| 250 | 300 | 100,59 s | 71,45 s | **1,41×** | 1,27 s | 546,4 → 803,4 MiB | 176,0 MiB (84) |

**Ba kết luận rút ra:**

1. **RAM đỉnh phẳng theo số trang** ở cả hai DPI (chênh <5 % giữa 50 và 250 trang) — cửa sổ inflight PA-1 đúng thiết kế; RAM chỉ scale theo DPI/kích thước trang (×~1,9 khi 150→300 DPI). Nhận định "số trang chỉ tăng thời gian, không tăng RAM" của §P25.2 **được phục hồi** cho pipeline mới, với điều kiện giữ nguyên cửa sổ.
2. **Artifact tuyến tính theo số trang khác biệt:** ~1,31–1,33 MiB/trang khác @150 DPI; ~2,06–2,10 MiB @300 DPI (corpus chữ + khối màu). Ngoại suy cận dưới cho 1.000 trang @300 DPI: ~0,7 GiB nếu 1/3 trang khác, **~2,1 GiB nếu toàn bộ trang khác**; trang lớn chạm guard 40 MP có thể ×4,6 theo pixel (ước lượng cận trên thô ~5–9 GiB/job) — vượt reserve tối thiểu 2 GiB của volume nhỏ → **bắt buộc admission trước khi nới**.
3. **Speedup pipeline suy giảm theo chiều dài tài liệu** (1,98→1,35× @150; 2,49→1,41× @250 trang @300): thời gian mỗi trang của pipeline tăng từ ~78 lên ~110 ms (150 DPI) trong khi đường tuần tự giữ ~148–155 ms/trang. Phần tuần tự trên main thread (render PDFium → encode/ghi PNG+GIF → commit DB mỗi trang) trở thành sàn cứng; nguyên nhân tăng thêm theo chiều dài chưa chốt được bằng số liệu hiện có — **phải đo stage trước khi tối ưu** (PB-2), không đoán.

**Re-verify gate PA-2 (corpus chuẩn 20 trang, 150 DPI, 5 mức worker × 3 lượt):**

| Lượt | Điều kiện | Seq median | Pipe CPU-1 median | Ratio | Parity |
|---|---|---:|---:|---:|---|
| Bàn giao (13/08 sáng) | theo `HIEU_NANG_TOAN_DIEN_FIXES` | 3,746 s | 1,720 s | 2,177× | đạt |
| Re-verify 1 | CPU nền ~44 % (app người dùng + vừa chạy xong ma trận P-B) | 3,475 s | 2,410 s | 1,44× | đạt |
| Re-verify 2 | CPU nền ~15 % | 3,107 s | **1,729 s** | 1,80× | đạt |

Pipeline elapsed lượt 2 (1,729 s) tái lập gần như tuyệt đối số bàn giao (1,720 s) → **không có bằng chứng hồi quy code** (Lô RV không chạm engine; parity + 129 test đạt). Ratio tụt dưới 2× vì baseline tuần tự dao động theo tải nền (3,75 → 3,11 s). **Đề nghị:** gate PA-2 bổ sung tiêu chí neo theo "pipeline elapsed median trên corpus chuẩn" (ổn định hơn ratio), và lượt nghiệm thu chính thức phải chạy trên máy tĩnh.

## 6. Rủi ro P-B và thiết kế đề xuất (chờ duyệt)

### Bảng rủi ro khi nới trần trang

| Rủi ro | Mức | Bằng chứng |
|---|---|---|
| Job dài ăn đĩa tới sát 0 rồi mới fail; pressure-cleanup không thu hồi được artifact Compare | P1 | Mục 4.3–4.5; artifact tuyến tính mục 5.2 |
| UI timeout 10 phút tự hủy job dài hợp lệ trên máy yếu/DPI cao | P1 | Mục 4.6; ngoại suy thời gian mục 5 (máy yếu 1 worker @300 DPI: 250 trang ≈ 100 s trên máy mạnh, máy 4 nhân cũ có thể ×3–5) |
| Speedup pipeline chỉ còn ~1,4× ở 250 trang — nới 1.000 khi chưa đo stage là quảng bá sai hiệu năng | P1 | Mục 5.3 |
| Map bình bài O(A×B) bùng nổ với tài liệu dài | P2 | Mục 4.7 |
| Sidebar/diff overlay UI render 1.000 mục kết quả chưa được đo | P3 | Quan sát, chưa đo — ghi nhận để kiểm khi PB-3 |

### Lộ trình đề xuất

**PB-1 — Admission + wording (S, ~3 file):**
- Thêm `estimate_compare_disk(pages, max_render_pixels, diff_ratio_worst=1.0)` vào `disk_space_guard.py` dựa trên hệ số đo được (mục 5.2, lấy hệ số theo pixel + biên an toàn ×1,5); gọi `ensure_job_disk_space` trong `create_comparison_job` trước khi nhận job.
- Sửa thông báo trần trang cho đúng bản chất + hướng dẫn hạ DPI/chia file; thêm env `PRYNX_MAX_COMPARE_PAGES` override (người vận hành biết máy mình).
- Nâng trần mặc định 50 → **250** SAU khi hai gạch đầu dòng trên xong (250 là mức benchmark đã phủ: RAM phẳng, artifact ≤176 MiB/job, thời gian ≤~2 phút máy mạnh).

**PB-2 — Đo stage + giảm phần tuần tự (M):**
- Thêm đo stage (render / compare / encode-save / commit) vào benchmark; chốt nguyên nhân speedup suy giảm theo chiều dài.
- Ứng viên tối ưu (chỉ làm sau khi có số): chuyển encode PNG/GIF sang pool với staging file + error semantics giữ nguyên (lưu ý §PA.R5 cũ: tài liệu phải mô tả đúng những gì vào pool; DB commit vẫn ở main thread), hoặc gộp commit theo lô nhỏ có checkpoint hủy. Không đổi khóa PDFium, không đưa session vào worker.

**PB-3 — Lifecycle tài liệu dài (M):**
- UI: thay deadline cứng 10 phút bằng watchdog theo tiến độ (chỉ hủy khi `progress`/`current_page` đứng yên quá N phút); giữ nút Hủy là đường thoát chính.
- Benchmark 500/1.000 trang @150/300 DPI (thêm biến thể "toàn bộ trang khác") + smoke hủy giữa job dài trên app thật; sau đó mới quyết định trần 1.000/bỏ trần.

### Gate nghiệm thu đề xuất cho từng bậc

| Bậc | Gate bắt buộc |
|---|---|
| Trần 250 (PB-1) | Admission đĩa hoạt động (test từ chối khi thiếu đĩa, thông báo tiếng Việt rõ); parity giữ; 129+ test Compare đạt; benchmark 250 trang: RAM phẳng (±10 % so bảng mục 5), artifact đúng ước lượng ±30 %; smoke hủy giữa job 250 trang dọn sạch ≤5 s; KHÔNG hard-cap worker máy ≥16 GB. |
| Trần 1.000 (sau PB-2/PB-3) | Tất cả gate bậc 250; speedup 1.000 trang ≥ mức đã duyệt sau đo stage (hoặc chấp nhận hạ claim có phê duyệt); watchdog tiến độ thay timeout cứng; map bình bài có cap/chiến lược riêng cho A×B lớn; benchmark 1.000 trang cả hai DPI + biến thể all-diff không OOM/không tràn reserve đĩa. |

## 7. Verify đã chạy trong đợt này

| Kiểm tra | Kết quả |
|---|---|
| `pytest test_compare_queue.py test_compare_engine.py test_compare_pipeline.py test_compare_parallel_parity.py test_worker_ram_gating.py test_api.py test_api_contract.py` | **129 passed** |
| `py_compile` (`compare.py`, `test_compare_queue.py`, `benchmark_compare_pipeline.py`) | Đạt |
| `npm run typecheck` | Đạt |
| ESLint hẹp `CompareTab.tsx`, `api.ts`, `comparisonStore.ts` | Đạt (0 lỗi) |
| `git diff --check` | Đạt (chỉ warning CRLF sẵn có) |
| Benchmark PA-2 corpus chuẩn | Parity đạt; pipeline elapsed tái lập 1,729 s ↔ 1,720 s bàn giao; ratio 1,80× do baseline dao động theo tải máy (mục 5) |
| Benchmark P-B 6 cấu hình 50/100/250 × 150/300 DPI | Parity đạt cả 6; bảng mục 5 |
| Smoke HTTP backend run_dev 7 kịch bản | Đạt cả 7 (bảng mục 3) |
| Repro §RV.1 trước/sau fix | NameError → tạo job thành công |

## 8. File đã thay đổi (2 lô, mỗi lô đã verify xong trước lô kế)

| Lô | File | Nội dung |
|---|---|---|
| RV-1 | `backend/app/api/routes/compare.py` | §RV.1 khôi phục `local_mode`; §RV.2 bắt `CancelledError`; §RV.3 dọn job mồ côi khi hủy (đều có tag `PERF (audit 2026-08-13 §RV.x)`) |
| RV-1 | `backend/tests/test_compare_queue.py` | 3 test hồi quy cho 3 finding trên (9 → 12 ca) |
| RV-2 | `scripts/benchmark_compare_pipeline.py` | Thêm số đo `artifact_bytes` (tổng PNG/GIF mỗi job) vào child JSON + bảng tổng hợp — phục vụ artifact-budget P-B |

## 9. Việc cố ý chưa làm (chờ duyệt hoặc ngoài phạm vi)

> Ghi chú 13/08 tối: mục này là hiện trạng tại thời điểm chốt 1. Sau khi lộ trình được duyệt, các gạch đầu dòng 1–2 và 5 đã làm xong (xem mục 10); riêng smoke app đóng gói (mức 3) và cập nhật master matrix vẫn giữ nguyên trạng thái chờ.

- **Chưa đổi `MAX_PAGES = 50`**, chưa thêm admission đĩa, chưa sửa wording, chưa đổi timeout UI — toàn bộ thuộc PB-1/PB-3 chờ duyệt mục 6.
- Chưa đo stage render/save/commit (PB-2) — số liệu hiện tại chỉ đủ kết luận "phần tuần tự chiếm ưu thế ở tài liệu dài", chưa đủ chọn phương án tối ưu.
- Chưa smoke UI trên app desktop đóng gói (mức 3): phiên điều khiển từ xa chỉ thao tác được webview/vite. Cần một lượt kiểm tay 4 bước của người dùng (file sẵn ở `tmp\smoke\`) hoặc lượt smoke trước mốc phát hành như kế hoạch cũ.
- Chưa cập nhật `docs/PRYNX_MASTER_AUDIT_MATRIX.md` — chờ chốt duyệt báo cáo này.
- Chưa benchmark 500/1.000 trang và biến thể all-diff (thuộc PB-3, chỉ chạy sau khi PB-1 có admission để đo an toàn).

---

**Chốt duyệt đề nghị:** duyệt thứ tự **PB-1 → PB-2 → PB-3** (mục 6). Trong lúc chờ duyệt, các fix §RV.1–3 nên được giữ lại vì §RV.1 là lỗi chặn phát hành đã có test bảo vệ.

## 10. Phụ lục sau duyệt — kết quả triển khai PB-1 → PB-3 (13/08 tối)

Lộ trình mục 6 đã được duyệt và triển khai đủ ba bậc. Chi tiết từng lô + verify ghi trong `HIEU_NANG_TOAN_DIEN_FIXES_2026-08-13.md`; phần này chỉ chốt số nghiệm thu và trạng thái gate.

### 10.1. Tóm tắt các lô đã vào code

| Lô | Nội dung | Verify |
|---|---|---|
| PB-1 | `estimate_compare_disk` + `ensure_job_disk_space` tại route (413 khi thiếu đĩa); trần trang 50 → **250** (`PRYNX_MAX_COMPARE_PAGES` override); sửa wording trần | 90 test đạt |
| PB-2a | Đo stage trong benchmark (`--stages`): wall pipeline = sàn tuần tự main-thread; render 76–81 %, save 15–16 %, commit 6–9 % | log `tmp/pb2_stage_*.log` |
| PB-2b | Encode PNG trong worker (byte trùng `cv2.imwrite`, test SHA-256) + gộp commit theo lô (16 trang / trễ ≤1 s); save 12,4 → 0,44 s, commit 5,9 → 0,80 s (@300/250); đỉnh RAM 837 → 711 MiB | 143 test đạt; parity PA-2 cả 5 mức worker |
| PB-3 (UI) | Thay deadline cứng 10 phút bằng watchdog theo tiến độ (hủy khi đứng yên 5 phút); i18n vi+en | typecheck + ESLint + i18nCatalog đạt |
| PB-3b | Trần lượt dò map bình bài `PRYNX_MAX_IMPOSITION_MAP_CELLS` (mặc định 62.500 = 250×250) — job vượt trần fail ngay kèm hướng dẫn; tín hiệu sống (status_message ≤1 s) trong lúc dò để UI/watchdog không tưởng treo | **145 test đạt** (2 test mới) |

### 10.2. Benchmark tài liệu dài 500/1.000 trang (máy tĩnh 16 luồng, parity đạt cả 4)

| Cấu hình | Tuần tự | Pipeline | Speedup | Đỉnh RAM (pipe) | Artifact |
|---|---:|---:|---:|---:|---:|
| 500 @150, 1/3 khác | 65,8 s | 31,4 s | **2,10×** | 452,3 MiB | 224,5 MiB |
| 1.000 @150, 1/3 khác | 131,3 s | 61,4 s | **2,14×** | 455,0 MiB | 451,6 MiB |
| 1.000 @150, all-diff | 513,9 s | 216,1 s | **2,38×** | 735,3 MiB | 1.352,2 MiB |
| 1.000 @300, 1/3 khác | 460,1 s | 292,6 s | 1,57× | 772,4 MiB | 709,1 MiB |

Kết luận: (1) speedup **không còn suy giảm theo chiều dài** — mối lo chính của mục 5.3 đã loại bằng PB-2b; (2) RAM đỉnh phẳng theo số trang, không OOM kể cả all-diff; (3) artifact tuyến tính đúng hệ số mục 5.2, ca xấu nhất 1,35 GiB/job có admission PB-1 chặn từ lúc nhận job; (4) @300 DPI dừng ở ~1,57× vì sàn render tuần tự PDFium — đã chốt nguyên nhân bằng số đo stage, muốn vượt phải đổi kiến trúc render (ngoài phạm vi đợt này).

### 10.3. Smoke lifecycle job dài trên backend run_dev thật

Corpus 250 trang @150 DPI (đúng trần hiện hành), `tmp/smoke_compare_long_cancel.py`: hủy giữa job tại 45 % (trang 113) — endpoint trả **0,481 s**, artifact + row dọn sạch ngay (gate ≤5 s **đạt**); chạy lại cùng cặp file hoàn tất 250/250 trang sau 47,6 s, 168 artifact / 101,6 MiB, đỉnh RAM worker ~507 MiB. Mức bằng chứng: HTTP/webview như mục 3 — ca kiểm tay trên app đóng gói vẫn thuộc lượt smoke trước phát hành.

### 10.4. Trạng thái gate trần 1.000 (bảng mục 6) — chờ MỘT quyết định

| Tiêu chí gate | Trạng thái |
|---|---|
| Tất cả gate bậc 250 | **Đạt** (admission + 145 test + benchmark 250 + smoke hủy giữa job 250 trang) |
| Speedup 1.000 trang sau đo stage | **Đạt có điều kiện**: 2,14× @150 DPI; @300 DPI 1,57× — cần chấp nhận claim "~1,6× ở DPI 300 trên tài liệu dài" (nguyên nhân đã chốt, không phải bug) |
| Watchdog tiến độ thay timeout cứng | **Đạt** (PB-3) |
| Map bình bài có cap/chiến lược riêng | **Đạt** (PB-3b) |
| Benchmark 1.000 trang 2 DPI + all-diff không OOM/không tràn reserve | **Đạt** (mục 10.2) |

**Quyết định (người duyệt chốt 13/08 tối): NÂNG TRẦN MẶC ĐỊNH 250 → 1.000** — chấp nhận claim "~1,6× ở DPI 300 trên tài liệu dài". Đã vào code: `_DEFAULT_MAX_COMPARE_PAGES = 1000` (`routes/compare.py`, giữ env override hai chiều), comment engine + CompareTab cập nhật theo, test default/override sửa tương ứng. Verify sau nâng: **145 test đạt**, typecheck đạt. Admission đĩa, guard 40 MP/trang và trần lượt dò bình bài giữ nguyên — đó là các guard chặn đúng chỗ cho tài liệu 1.000 trang.
