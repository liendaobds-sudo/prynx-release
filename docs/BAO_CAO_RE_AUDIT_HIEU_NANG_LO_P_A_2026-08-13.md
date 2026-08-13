# BÁO CÁO RE-AUDIT HIỆU NĂNG — LÔ P-A SO SÁNH PDF ĐA LÕI

**Ngày:** 2026-08-13  
**Mốc code:** `5629eaf`, branch `codex/pre-release-audit-2026-08-04`, audit trên worktree hiện tại  
**Phạm vi:** đối chiếu `BAO_CAO_AUDIT_HIEU_NANG_TOAN_DIEN_2026-08-13.md` với phần triển khai Lô P-A trong `backend/app/core/comparison_engine.py` và `backend/tests/test_compare_parallel_parity.py`  
**Trạng thái:** Chốt 1 re-audit — **chỉ audit, chưa sửa code P-A**

## 1. Kết luận điều hành

**Chưa nghiệm thu Lô P-A.** Hướng pipeline là hợp lý và các kiểm tra parity hiện có đều đạt, nhưng lô chưa đáp ứng chính gate đã ghi trong báo cáo:

- Benchmark A/B xen kẽ trên đúng corpus 20 trang A4, 150 DPI, máy 32 GB/16 luồng chỉ đạt **1,86×** theo median, thấp hơn gate **≥2×** và thấp hơn dự báo **2,5–3×**.
- Pipeline 15 worker tăng đỉnh working set từ khoảng **297 MiB lên 824 MiB** và làm thời điểm báo trang đầu chậm từ **0,388 s lên 1,661 s** trên corpus stress 20 trang đều khác biệt.
- Báo cáo yêu cầu test tiến độ đơn điệu, hủy giữa chừng và parity byte của PNG/GIF; test mới không chứa các assertion này. Engine/caller Compare hiện cũng chưa có hợp đồng hủy cooperative để test.
- Code mô tả “compare + save” chạy trong pool, nhưng thực tế pool chỉ chạy `ImageComparator.compare*`; ghi PNG/GIF và commit DB vẫn tuần tự.
- Đề xuất P-B nâng trần tới 1.000 trang không còn có thể dựa vào nhận định “RAM không tích lũy theo số trang” của pipeline cũ. P-A giữ tới `workers + 2` cặp ảnh/kết quả đang sống và Compare chưa có admission theo dung lượng artifact đĩa.

Điểm tích cực: 41 test Compare đạt; stress 320 phép so đồng thời không lệch kết quả; booklet, alignment và CMYK hiện không phát hiện hồi quy; hash PNG/GIF trong phép kiểm tay 1↔4 worker trùng nhau. Đây là bằng chứng `AUTO` tốt cho một phần correctness, nhưng chưa đủ cho gate hiệu năng/RAM/cancel/artifact của lô.

## 2. Phạm vi code và đường chạy đã xác minh

Đường desktop/release đang dùng:

`CompareTab.handleStartCompare` → `POST /jobs/compare` → executor Compare một job → `run_comparison_sync` có `scheduled_job("compare")` → `run_comparison_pipeline` → `PDFProcessor.render_page*` tuần tự → pool `ImageComparator.compare*` → `HighlightRenderer` ghi PNG/GIF tuần tự → `PageResult`/`ComparisonJob` → polling UI đọc lại.

Nhánh desktop release được nhận diện bằng `PRYNX_TOKEN_SOURCE=stdin`, vì vậy đi executor local và chốt whole-machine `compare`. Nhánh Celery server cũng gọi cùng engine nhưng không thuộc runtime desktop phát hành hiện tại; chưa có runtime server trong phạm vi re-audit này.

## 3. Findings

### §PA.R1 — [CONFIRMED] P1 / M — Pipeline giữ quá nhiều raster/kết quả đồng thời, tăng đỉnh RAM và làm chậm progress trang đầu

**Bằng chứng code:**

- `comparison_engine.py:505` đặt `inflight_limit = compare_workers + 1`.
- `comparison_engine.py:540-550` luôn submit/render trước, chỉ drain khi `len(pending) > inflight_limit`. Với 15 worker, generator có thể giữ **17 item pending** trước yield đầu tiên: 15 task chạy/chờ + 2 item biên theo điều kiện `>`.
- Mỗi item giữ `img_a`, `img_b`, `future`; future đã xong còn giữ `ComparisonResult` gồm mask/highlight/GIF cho tới khi drain.
- `per_worker_mb=640` chỉ ảnh hưởng máy `<16 GB`; policy chung cố ý không áp available-RAM cap cho máy mạnh. Vì thế con số này không tạo memory reservation cho job trên máy 16–64 GB.

**Tái hiện runtime (20 trang A4, 150 DPI, mọi trang có khác biệt, process sạch):**

| Cấu hình | Tổng thời gian | Progress trang 1 | Đỉnh working set lấy mẫu |
|---|---:|---:|---:|
| `PRYNX_COMPARE_WORKERS=1` | 6,639 s | 0,388 s | 297,0 MiB |
| `PRYNX_COMPARE_WORKERS=15` | 2,806 s | 1,661 s | 824,4 MiB |

Pipeline nhanh hơn về tổng thời gian trên corpus này, nhưng dùng thêm khoảng **527 MiB** và progress trang đầu chậm **4,28×**. Corpus audit gốc chỉ có 7/20 trang khác nên chưa phơi đủ artifact/result đang sống.

**Tác động:** đỉnh RAM không còn là “per-page” như đường tuần tự cũ; với trang lớn gần guard 40 MP hoặc CMYK, spike có thể lớn hơn đáng kể. UI polling không thấy trang hoàn tất trong lúc pipeline nạp trước gần cả tài liệu 20 trang. Đây là finding chặn việc nới trần trang ở P-B.

**Đề xuất lô sửa:** giới hạn cửa sổ bay theo một budget riêng của pipeline, không đồng nhất với số CPU. Render một cặp rồi submit; drain sớm khi task đầu hoàn tất hoặc khi cửa sổ nhỏ đã đầy. Nghiệm thu bằng peak RSS/private bytes và first-page latency, không chỉ elapsed tổng.

### §PA.R2 — [CONFIRMED] P1 / S — Gate tốc độ ≥2× không đạt ổn định; dự báo 2,5–3× vượt bằng chứng

**Bằng chứng runtime:** chạy A/B xen kẽ sau warm-up, 8 cặp, cùng PDF 20 trang A4 @150 DPI, 1 worker ↔ 15 worker:

```text
sequential median: 3,176 s
pipeline median  : 1,703 s
ratio of medians : 1,864x
paired median    : 1,856x
paired mean      : 1,848x
```

Tất cả 8 cặp nằm trong khoảng **1,800–1,881×**. Lượt chạy script nguyên bản 3×3 trước đó đạt 1,85×. Một worker-sweep riêng cho thấy throughput tăng dần tới 15 worker, nên chưa có bằng chứng hard-cap máy mạnh; vấn đề là gate/dự báo của báo cáo không đạt.

**Nguyên nhân claim sai:** công thức tại báo cáo coi phần compare chia gần tuyến tính cho `CPU-1` và nói cả save vào pool. Code thực tế vẫn save + DB commit tuần tự; render tuần tự; kết quả phải drain theo thứ tự; OpenCV/Rust có song song nội tại; chi phí quản lý và memory bandwidth không bằng 0.

**Đề xuất:** hạ claim về số đo thực hoặc tiếp tục tối ưu rồi đo lại. Benchmark dùng để nghiệm thu phải được version-control hoặc ghi đầy đủ điều kiện chạy; script hiện nằm trong `tmp/` bị `.gitignore` bỏ qua và cần `PRYNX_SIDECAR_TOKEN` + `PYTHONUTF8=1` mới chạy độc lập trong cấu hình hiện tại.

### §PA.R3 — [CONFIRMED] P1 / M — Gate cancel/error chưa được triển khai; lỗi sớm vẫn chờ worker đang chạy và để partial artifact/DB

**Bằng chứng:**

- `run_comparison_pipeline` không nhận `cancel_check`/event; route Compare không có endpoint cancel; UI chỉ dừng polling khi reset/unmount, không dừng backend.
- Test mới không có ca cancel dù báo cáo yêu cầu “cancel giữa chừng”.
- `comparison_engine.py:551-555` chỉ `future.cancel()` cho task chưa chạy. Thoát `with ThreadPoolExecutor(...)` vẫn gọi shutdown với `wait=True` mặc định, nên task đang chạy phải xong trước khi lỗi được propagate.
- Fault injection: trang đầu ném lỗi tức thì, 19 trang còn lại giả lập compare 1,2 s. Đường 1 worker báo lỗi sau **0,078 s**; đường 15 worker đã bắt đầu 16 phép compare và chỉ báo lỗi sau **1,285 s**.
- Mỗi trang được ghi artifact rồi commit riêng (`comparison_engine.py:608-619,681-695`). Nếu lỗi ở trang sau, các PNG/GIF và `PageResult` trước đó còn lại; retry Celery tối đa 3 lần gọi lại cùng job mà pipeline không dọn/replace idempotent trước khi chạy.

**Tác động:** “hủy giữa chừng” hiện không tồn tại ở backend; lỗi có thể báo chậm hơn vì pool, tiêu CPU/RAM vô ích, và retry/rerun có nguy cơ partial/duplicate state. Đây là nhánh đúng với bất tiện “lỗi giữa chừng” nhưng nằm ngoài đo tốc độ thuần.

**Đề xuất:** chốt hợp đồng lifecycle riêng: cancel cooperative, kiểm trước render/submit/drain/save/commit; dùng staging hoặc cleanup xác định cho artifact/rows của job; lỗi đầu tiên ngừng submit mới và không chờ task không cần thiết quá lâu. Thêm test fault/cancel ở route → engine → DB/artifact.

### §PA.R4 — [CONFIRMED] P2 / S — Bộ test P-A không kiểm đủ gate đã công bố

**Bằng chứng:** `test_compare_parallel_parity.py` có 10 test và tất cả đạt, nhưng:

- Snapshot chỉ so `has_highlight`, không so `gif_image_path`, tên file, byte/hash PNG/GIF.
- Không capture callback để assert progress monotonic/current-page/total-pages.
- Không có cancel/fault injection/partial cleanup.
- “Máy yếu” được ép bằng env `PRYNX_COMPARE_WORKERS=1`; chưa test planner với tổng RAM `<8 GB` ngay tại callsite P-A hoặc 8–<16 GB = 2 worker.
- Booklet chỉ test helper pair policy trong file mới. Hai test booklet end-to-end cũ có chạy pipeline và đều đạt trong re-audit, nhưng không A/B 1 worker ↔ nhiều worker để chứng minh parity của nhánh này.

**Kiểm bổ sung ngoài test versioned:** hash SHA-256 của `page_2_diff.png` và `page_2_anim.gif` trùng giữa 1 và 4 worker trên corpus 1:1. Kết quả này tốt nhưng chưa thay thế regression test trong repo.

**Đề xuất:** thêm đúng các gate đã ghi hoặc sửa báo cáo để không tuyên bố chúng đã được nghiệm thu.

### §PA.R5 — [CONFIRMED] P2 / S — Báo cáo/code mô tả “compare + save trong pool” nhưng code chỉ song song compare

**Bằng chứng:** future tại `comparison_engine.py:518-528` chỉ gọi `compare_cmyk`/`compare`; `HighlightRenderer.save_highlighted_image/save_gif_image` vẫn gọi sau drain tại `:608-619`, rồi DB commit ở `:681-695`.

**Tác động:** claim kiến trúc và mô hình tốc độ trong báo cáo sai; save 4,8–5,7% không được song song hóa. Đây không tự thân là lỗi correctness, nhưng làm gate/dự báo thiếu căn cứ và có thể dẫn lô sau tối ưu nhầm.

**Đề xuất:** hoặc đổi tài liệu/comment thành “pool compare”, hoặc chuyển encode/ghi sang task có staging và error semantics rõ ràng. Không đẩy DB session vào worker.

### §PA.R6 — [CONFIRMED] P1 / M — Đề xuất P-B nới tới 1.000 trang chưa an toàn sau P-A

**Bằng chứng:**

- §P25.2 dựa vào nhận định engine giải phóng ảnh mỗi vòng nên số trang chỉ tăng thời gian, không tăng RAM tích lũy. P-A thay đổi đỉnh sống thành nhiều cặp/kết quả đồng thời (§PA.R1).
- Mỗi trang khác biệt có thể tạo cả PNG và GIF. `HighlightRenderer` ghi trực tiếp vào thư mục job, không gọi `ensure_job_disk_space`; cleanup high-watermark cố ý bỏ mọi thư mục Compare/preflight.
- Compare chưa có cancel backend (§PA.R3). UI có timeout polling 10 phút nhưng timeout chỉ dừng chờ phía UI; job backend vẫn tiếp tục.

**Tác động:** cho phép 1.000 trang có thể tạo job dài, nhiều artifact và hết đĩa giữa chừng; cap theo tổng RAM không giải quyết disk/time/cancel. Trần 50 hiện tại đúng là cap vô điều kiện và thông báo lỗi gây hiểu sai, nhưng không nên thay trực tiếp bằng 1.000/bỏ trần theo đề xuất hiện tại.

**Đề xuất:** tách sửa wording/cap policy khỏi nới lớn. Trước khi nâng, cần memory-window gate P-A, disk estimate/reserve, cancel, runtime timeout/lifecycle và benchmark tài liệu dài. Chọn trần theo đa tín hiệu (pixel, artifact budget, thời gian/lifecycle), RAM tier chỉ là một tín hiệu.

## 4. Đối chiếu các claim còn lại của báo cáo gốc

| Mục | Kết luận re-audit | Ghi chú |
|---|---|---|
| §P25.1: compare tuần tự bỏ phí CPU | **Xác nhận hướng finding** | Đo stage mới: compare 63,7–64,4%, process trung bình ~1,07 core trên corpus gốc. P-A cải thiện rõ nhưng chưa đạt gate. |
| §P25.2: cap 50 vô điều kiện | **Xác nhận finding, bác đề xuất nới ngay** | Wording hiện tại sai; guard per-page hữu ích nhưng chưa đủ cho P-A nhiều inflight + artifact disk. |
| §P25.3: EN import tĩnh | **Xác nhận cấu trúc; số bundle là STALE-PARTIAL** | `i18n/index.ts` import tĩnh VI+EN. Locale hiện tại: VI 383.325 B raw/342.712 B min; EN 353.234 B raw/312.707 B min. `dist/index` 1.083.020 B được build ngày 12/08, trước locale sửa ngày 13/08, nên không phải artifact của source hiện tại. “~60% locale” chỉ là ước lượng, chưa chứng minh trên build hiện tại. |
| §P25.4: import diet sidecar | **Xác nhận finding; số thời gian dao động** | Lượt đo lại process sạch: `app.main` cum 1.422,8 ms; wall median 1.721,2 ms; `qc→llm_checker→httpx` ~90,1 ms, VDP ~107,6 ms, sticker ~98,4 ms. Cần A/B importtime và startup proof release sau sửa, không quy toàn bộ startup 5 s cho import. |
| “P-A blast radius một file + test” | **Bị hạ mức** | Lifecycle thật chạm route/cancel, artifact writer, DB retry và UI timeout. Nếu chỉ giữ compare-pool thì vẫn phải kiểm các biên đó. |

## 5. Bằng chứng kiểm thử đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `pytest test_compare_parallel_parity.py` | **10 passed** |
| `pytest test_compare_engine.py test_compare_pipeline.py test_compare_queue.py` | **31 passed** |
| Hai test booklet end-to-end | **2 passed** (đã nằm trong 31 ca trên; chạy lại riêng cũng đạt) |
| `pytest test_worker_ram_gating.py` | **7 passed** |
| `py_compile comparison_engine.py test_compare_parallel_parity.py` | **Đạt** |
| Stress shared comparator: booklet 160 + 1:1 160 lượt | **0/320 mismatch** |
| Artifact hash 1↔4 worker | **PNG/GIF trùng SHA-256** trên corpus 1:1 |
| Benchmark A/B xen kẽ 8 cặp | **1,86× median**, không đạt gate ≥2× |
| Peak RAM/first progress 1↔15 worker | **297→824 MiB; 0,388→1,661 s** |
| Fault injection lỗi trang đầu | **0,078→1,285 s; pipeline đã start 16 compare** |

Chưa chạy full backend, full build, installed release hoặc máy vật lý 8/16 GB vì không cần để xác nhận các finding hẹp trên và worktree đang có nhiều nhóm thay đổi độc lập.

## 6. Lộ trình đề nghị — chờ duyệt

### Lô PA-1 — Đóng correctness/lifecycle trước

1. Thiết kế cửa sổ inflight theo memory budget nhỏ và progress sớm.
2. Thêm cancel/fault contract, cleanup/idempotency cho DB + artifact.
3. Bổ sung test progress, fault/cancel, artifact hash và booklet A/B.

### Lô PA-2 — Nghiệm thu hiệu năng có số đo

1. Đưa benchmark tái lập vào vị trí được version-control hoặc ghi lệnh/env đầy đủ.
2. Đo elapsed + first-page + peak RSS/private bytes trên 1/2/4/8/CPU-1 worker.
3. Giữ máy mạnh không hard-cap; nếu giảm oversubscription nội tại thì phải benchmark chứng minh, không cap theo cảm giác.

### Lô P-B — Tạm hoãn nới lớn

Chỉ sửa thông báo lỗi/cấu hình nhỏ nếu cần. Nới số trang sau khi PA-1/PA-2 đạt và có disk/cancel/lifecycle gate cho tài liệu dài.

---

**Chốt duyệt đề nghị:** không merge/nghiệm thu P-A ở trạng thái hiện tại; duyệt **PA-1 → PA-2**, sau đó re-benchmark rồi mới quyết định P-B. Báo cáo này không thay đổi code của user và không cập nhật master matrix, vì finding đang chờ chốt duyệt.
