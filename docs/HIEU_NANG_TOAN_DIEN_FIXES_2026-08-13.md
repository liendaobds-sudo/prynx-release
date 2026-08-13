# Nhật ký sửa hiệu năng toàn diện PrynX — 13/08/2026

**Nguồn:** `BAO_CAO_AUDIT_HIEU_NANG_TOAN_DIEN_2026-08-13.md` và
`BAO_CAO_RE_AUDIT_HIEU_NANG_LO_P_A_2026-08-13.md`  
**Phạm vi đã duyệt:** PA-1 (RAM/lifecycle/cancel/error Compare) → PA-2
(benchmark nghiệm thu)  
**Trạng thái:** PA-1 và PA-2 đã triển khai, test tự động đạt; P-B nâng giới hạn
trang vẫn hoãn.

## Lô PA-1 — RAM, vòng đời, hủy và lỗi Compare

### Cửa sổ pipeline và độ phản hồi trang đầu

- Hàng đợi không còn giữ trực tiếp `img_a`/`img_b`; raster đầu vào nằm trong
  closure của future và được giải phóng ngay khi phép so xong.
- Bỏ cửa sổ `workers + 2`. Số phép so bay tối đa đúng số worker; giai đoạn khởi
  động chỉ render trước tối đa 4 cặp và drain ngay khi trang đầu hoàn tất.
- Máy yếu vẫn theo policy cũ: `<8 GB → 1 worker`, `8–<16 GB → tối đa 2`, máy
  `>=16 GB → CPU-1`; không thêm hard-cap máy mạnh.

### Hủy cooperative và lifecycle queue

- Thêm `POST /api/jobs/{job_id}/cancel`, idempotent cho job queued/running.
- Route local giữ `threading.Event` theo job. Future callback là nơi duy nhất trả
  submission slot, nên cancel queued và kết thúc worker không double-release.
- Engine kiểm hủy trước/sau các biên render, submit, drain, lưu artifact, commit
  và hoàn tất summary. Nhánh Celery không dùng chung bộ nhớ với API nên thăm trạng
  thái `cancelled` từ DB và tuyệt đối không retry khi nhận `InterruptedError`.
- Chuyển trạng thái `processing → completed` và `pending/processing → cancelled`
  dùng UPDATE có điều kiện; nếu Hủy đến đúng lúc Hoàn thành thì chỉ một trạng thái
  terminal thắng, không ghi đè qua lại.
- UI Compare có nút **Hủy so sánh**, hiển thị trạng thái đang dừng/dọn và không
  còn chỉ dừng polling trong khi backend tiếp tục chạy. Timeout 10 phút và unmount
  tab cũng gửi hủy best-effort về backend. Hủy giữ nguyên hai file/cài đặt để chạy
  lại ngay; chỉ “So sánh mới” mới xóa toàn bộ phiên.

### Cleanup và retry idempotent

- Mỗi lần chạy/retry cùng job bắt đầu bằng việc xóa `PageResult` và thư mục
  `RESULTS_DIR/<job_id>` cũ.
- Hủy/lỗi rollback session rồi xóa toàn bộ row + PNG/GIF dở dang; job chỉ giữ
  trạng thái terminal và thông báo. Lỗi giữa chừng không còn trộn kết quả cũ với
  lần retry.
- `cv2.imwrite()` trả `False` nay được nâng thành lỗi ghi đĩa (trước đây có thể
  im lặng lưu URL tới file không tồn tại), đi chung cleanup/failed lifecycle.
- DB session vẫn chỉ dùng ở thread chính; render PDFium vẫn tuần tự trên document
  handle, không thay đổi khóa PDFium.

## Lô PA-2 — Ổn định native parallelism và benchmark nghiệm thu

### Nguyên nhân dao động được xác nhận

OpenCV trên máy audit mặc định báo `cv2.getNumThreads() = 16`. Pipeline lại mở
tới 15 worker theo trang, tức mỗi task có thể tự mở thêm toàn bộ native threads —
nested parallelism gây oversubscription hàng trăm thread, thời gian có lượt tăng
từ khoảng 4 giây lên 12–13 giây dù cùng corpus.

Sửa cuối:

- Khi pipeline đa worker chạy, OpenCV dùng 1 native thread cho mỗi task; tầng
  worker theo trang vẫn giữ CPU-1 trên máy mạnh. Đây là bỏ nested oversubscription,
  không phải hard-cap tổng công suất.
- Thiết lập global của OpenCV được khóa và khôi phục trong `finally`, kể cả khi
  compare lỗi/cancel. `PRYNX_COMPARE_CV_THREADS` là escape hatch để benchmark/QA.
- Script tái lập đã đưa vào `scripts/benchmark_compare_pipeline.py`; mỗi sample
  chạy process sạch, cấu hình xen kẽ, đo elapsed, first-page, working set và parity
  của `PageResult`, summary, PNG/GIF SHA-256.

### Kết quả ma trận cuối

Corpus: 20 trang A4, 150 DPI, 7/20 trang có khác biệt; máy 32 GB, 16 logical CPU;
3 lượt mỗi cấu hình, thứ tự xen kẽ. Elapsed/first-page lấy median, RAM lấy peak lớn
nhất của ba lượt.

| Worker | Elapsed median | Trang đầu median | Peak working set | Speedup vs 1 | Parity |
|---:|---:|---:|---:|---:|---|
| 1 | 3,746 s | 0,370 s | 274,2 MiB | 1,000× | đạt |
| 2 | 3,351 s | 0,407 s | 272,9 MiB | 1,118× | đạt |
| 4 | 2,035 s | 0,481 s | 367,5 MiB | 1,840× | đạt |
| 8 | 1,907 s | 0,525 s | 387,8 MiB | 1,964× | đạt |
| CPU-1 (15) | 1,720 s | 0,471 s | 406,1 MiB | **2,177×** | đạt |

Đối chiếu re-audit trước sửa PA-1/PA-2:

- CPU-1 speedup: `1,864× → 2,177×`, đạt gate `>=2×`.
- First-page CPU-1: `1,661 s → 0,471 s` (nhanh hơn khoảng 3,5×).
- Peak CPU-1: `824 MiB → 406 MiB` (giảm khoảng 51%).
- PNG/GIF và dữ liệu kết quả trùng giữa mọi mức worker trong toàn bộ sample.

## Bằng chứng kiểm thử

- `py_compile` toàn bộ file Python của PA-1/PA-2 + benchmark: đạt.
- Toàn bộ tập verify backend của lô (Compare + API contract + RAM policy):
  `119 passed` (`54` ca trực tiếp engine/pipeline/queue/parity/lifecycle).
- Frontend `npm run typecheck`: đạt.
- ESLint hẹp `CompareTab.tsx` + `api.ts`: đạt.
- `git diff --check` trên các file thuộc lô: đạt.
- Không cập nhật golden/snapshot; không đổi thuật toán verdict hoặc nội dung
  artifact có chủ đích.

## Việc cố ý chưa làm

- **P-B vẫn hoãn:** chưa nâng trần 50 trang lên 1.000/bỏ trần. Trước khi nới cần
  admission theo dung lượng artifact/đĩa và benchmark tài liệu dài; PA-1/PA-2 chỉ
  đóng RAM/lifecycle/cancel/tốc độ của pipeline hiện tại.
- Chưa build installer/release toàn bộ vì thay đổi này không chạm pipeline đóng
  gói; cần smoke UI trên app thật trước mốc phát hành.

## Lô RV — Re-review PA-1/PA-2 (13/08 chiều)

Chi tiết bằng chứng, smoke test và audit P-B tài liệu dài:
`BAO_CAO_AUDIT_COMPARE_P_B_TAI_LIEU_DAI_2026-08-13.md`.

- **§RV.1 [P0]** `routes/compare.py`: khôi phục dòng `local_mode` bị xóa nhầm
  trong lô PA-1 — trước fix, MỌI request tạo job Compare chết `NameError` (route
  chỉ được test tới 422/404 nên 119 test không bắt được). Thêm test đi hết đường
  tạo job local.
- **§RV.2 [P2]** `routes/compare.py`: nhánh chờ cancel bắt thêm `CancelledError`
  (kế thừa `BaseException`) — hủy kép chạy đua không còn trả 500.
- **§RV.3 [P3]** `routes/compare.py`: hủy job mồ côi (backend restart giữa chừng,
  registry RAM trống) nay dọn row/artifact dở dang idempotent ngay tại route.
- `tests/test_compare_queue.py`: 9 → 12 ca (3 test hồi quy mới).
- `scripts/benchmark_compare_pipeline.py`: thêm số đo `artifact_bytes` phục vụ
  artifact-budget P-B.
- Verify: 129 test Compare/API contract/RAM policy đạt; typecheck + ESLint hẹp
  đạt; benchmark PA-2 parity đạt, pipeline elapsed tái lập 1,729 s (ratio dao
  động theo tải nền máy — xem báo cáo P-B mục 5).

## Lô PB-1 — Admission đĩa + trần 250 trang (13/08 chiều, sau duyệt lộ trình P-B)

- `core/disk_space_guard.py`: thêm `estimate_compare_disk(total_render_pixels,
  page_count)` — hệ số theo pixel đo từ ma trận P-B, giả định xấu nhất mọi trang
  khác biệt; Compare ghi thẳng `RESULTS_DIR/<job_id>` nên toàn bộ nằm ở
  `output_bytes`.
- `routes/compare.py`: (a) gọi `ensure_job_disk_space` trước khi nhận job — thiếu
  đĩa trả 413 với thông báo tiếng Việt; (b) trần trang mặc định 50 → **250**, đọc
  qua `PRYNX_MAX_COMPARE_PAGES` (đọc mỗi request, người vận hành nới/thu được);
  (c) sửa wording trần trang cho đúng bản chất (trần sản phẩm, không phải giới
  hạn phần cứng) + thêm `_estimate_total_render_pixels` (thiếu metadata thì giả
  định A4 — ước lượng dư an toàn hơn ước lượng 0).
- `core/comparison_engine.py`: cập nhật comment cũ còn nhắc "MAX_PAGES=50".
- Test: `test_disk_space_guard.py` thêm unit test estimator; `test_compare_queue.py`
  thêm 3 test route (từ chối khi thiếu đĩa, override env, wording 413).
- Verify lô: 90 test (disk guard + queue + api + contract) đạt.

## Lô PB-2 — Đo stage + rút ngắn sàn tuần tự pipeline (13/08 tối)

### PB-2a: đo stage — chốt nguyên nhân speedup suy giảm theo chiều dài

`benchmark_compare_pipeline.py` thêm `--stages` (wrap render/compare/save/commit
trong process con). Số đo 250 trang trên máy tĩnh: **wall time pipeline = sàn
tuần tự main-thread** (chờ drain chỉ 1,4–1,5 s), trong đó render chiếm 76–81 %,
save PNG/GIF 15–16 %, commit 6–9 %. Compare trong pool chỉ bận ~1/15 worker —
không phải nút cổ chai. Kết luận: muốn nhanh hơn phải bốc save/commit ra khỏi
main thread; render là sàn cứng còn lại (PDFium buộc tuần tự).

### PB-2b: encode PNG trong worker + gộp commit theo lô

- `core/image_comparator.py`: `ComparisonResult` thêm trường `highlighted_png`.
- `core/comparison_engine.py`: (a) `_encode_highlight_to_png` — pipeline encode
  PNG ngay trong worker so-ảnh (cùng encoder/tham số với `cv2.imwrite` — byte
  trùng tuyệt đối, có test SHA-256), giải phóng raster sớm → đỉnh RAM pipeline
  giảm; main thread chỉ còn ghi bytes; (b) commit PageResult theo lô
  (`_COMPARE_COMMIT_BATCH_PAGES=16` hoặc trễ tối đa 1 s — local mode đọc tiến độ
  qua DB nên nhịp cập nhật UI giữ ≤1 s; checkpoint hủy vẫn MỖI TRANG; hủy/lỗi
  giữa lô rollback trong `_finalize_interrupted_job`). Đường tuần tự máy yếu giữ
  nguyên trừ việc cũng hưởng lợi gộp commit (không phải cap).
- `core/highlight_renderer.py`: thêm `save_highlighted_png_bytes` (ghi bytes, lỗi
  đĩa ném OSError — cùng đường rollback với `save_highlighted_image`).
- Test mới (`test_compare_parallel_parity.py`, 12 → 14 ca): lỗi encode trong
  worker dọn sạch row/artifact như lỗi ghi PNG cũ; ngưỡng lô lớn hơn tổng trang
  vẫn force-flush đủ PageResult.
- **Số đo sau tối ưu (250 trang, máy tĩnh):** save trên main thread 12,4 → 0,44 s
  và commit 5,9 → 0,80 s (@300 DPI); sàn tuần tự giờ ~97 % là render thuần —
  pipeline chạy sát trần lý thuyết của kiến trúc render-tuần-tự. Speedup 250
  trang @150 DPI: **2,09×** (parity đạt); @300 DPI: 1,59× (trần Amdahl 1,63× do
  render pipeline bị tranh chấp CPU +30 % so với chạy đơn). Đỉnh RAM pipeline
  @300/250: **837 → 711 MiB**.
- Verify lô: **143 test đạt** (Compare + engine + pipeline + parity + RAM policy
  + API + contract + disk guard); py_compile đạt; gate PA-2 corpus chuẩn trên
  máy nghỉ: parity đạt cả 5 mức worker, pipeline elapsed median **1,763 s** (bàn
  giao 1,720 s — chênh +2,5 % trong nhiễu); ratio vs 1 worker còn 1,62× vì gộp
  commit làm CHÍNH baseline tuần tự nhanh lên (3,107 → 2,854 s) — củng cố đề
  nghị neo gate theo pipeline elapsed đã ghi trong báo cáo P-B mục 5.

## Lô PB-3 — Lifecycle tài liệu dài (13/08 tối)

- `desktop/src/components/CompareTab.tsx`: bỏ deadline cứng 10 phút (tự hủy oan
  job dài hợp lệ); thay bằng **watchdog theo tiến độ** — chỉ hủy khi status/
  progress/current_page/status_message đứng yên suốt 5 phút (kiểm mỗi 30 s);
  backend chết (poll lỗi liên tục) cũng rơi vào cùng nhánh. Nút Hủy vẫn là đường
  thoát chính. i18n mới `job_khong_co_tien_trien_trong_5_phut` (vi + en).
- Verify: `npm run typecheck` đạt; ESLint hẹp `CompareTab.tsx` đạt; test
  `i18nCatalog` đạt (5/5).

### PB-3 (tiếp) — Benchmark tài liệu dài 500/1.000 trang (máy tĩnh, 16 luồng)

Ma trận `--stages --workers 1,cpu-1 --runs 1` + biến thể `--all-diff` (mọi trang
khác); log `tmp/pb3_*.log`; **parity SHA-256 đạt cả 4 cấu hình**:

| Cấu hình | Tuần tự | Pipeline | Speedup | Trang đầu (pipe) | Đỉnh RAM (pipe) | Artifact |
|---|---:|---:|---:|---:|---:|---:|
| 500 @150, 1/3 khác | 65,8 s | 31,4 s | **2,10×** | 1,21 s | 452,3 MiB | 224,5 MiB |
| 1.000 @150, 1/3 khác | 131,3 s | 61,4 s | **2,14×** | 2,02 s | 455,0 MiB | 451,6 MiB |
| 1.000 @150, all-diff | 513,9 s | 216,1 s | **2,38×** | 2,13 s | 735,3 MiB | 1.352,2 MiB |
| 1.000 @300, 1/3 khác | 460,1 s | 292,6 s | 1,57× | 2,75 s | 772,4 MiB | 709,1 MiB |

- **Speedup KHÔNG còn suy giảm theo chiều dài** sau PB-2b (2,10× @500 → 2,14×
  @1.000; trước PB-2 con số 250 trang chỉ 1,35–1,41×) — nguyên nhân cũ (save +
  commit trên main thread tăng theo trang) đã loại. @300 DPI giữ ~1,57× đúng sàn
  render tuần tự PDFium (trần Amdahl ~1,6× đã chốt bằng số đo stage PB-2a).
- **RAM đỉnh phẳng theo số trang** (452 → 455 MiB khi 500 → 1.000 @150; all-diff
  735 MiB do cửa sổ giữ bytes PNG mọi trang) — không OOM ở mọi cấu hình.
- **Artifact tuyến tính đúng hệ số cũ** (~1,35 MiB/trang khác @150): all-diff
  1.000 trang = 1,35 GiB — admission đĩa PB-1 (giả định xấu nhất all-diff) là
  guard đúng chỗ. Trang đầu 2–2,8 s @1.000 trang do bước plan quét kích thước
  mọi trang trước khi chạy (tuyến tính, chấp nhận được).

### PB-3b — Trần lượt dò bình bài + tín hiệu sống trong lúc dò

- `core/comparison_engine.py`: bước dò map bình bài là O(A×B) lượt so mini 48 DPI
  (1.000 nguồn × 666 tờ ≈ 666k lượt ~ hàng giờ, nổ trước khi vào pipeline) — gate
  bắt buộc của trần 1.000 trong báo cáo P-B mục 6. Thêm:
  (a) **trần lượt dò** `_max_imposition_map_cells()` mặc định 62.500 (= 250×250,
  đúng thế giới đã phủ ở trần 250 — hành vi hiện tại không đổi), env
  `PRYNX_MAX_IMPOSITION_MAP_CELLS` cho người vận hành; vượt trần → job fail NGAY
  với hướng dẫn tiếng Việt (chia file theo bộ bình / chuyển ghép tuần tự);
  (b) **tín hiệu sống trong lúc dò**: cập nhật `status_message` ("Đang định vị
  trang nguồn i/N trên các tờ bình...") + commit theo nhịp ≤1 s — UI local đọc
  DB thấy tiến độ, watchdog PB-3 không hủy oan phiên dò dài; dò xong trả
  status_message về rỗng.
- Test mới (`test_compare_pipeline.py`, 6 → 8 ca): vượt trần fail nhanh kèm
  hướng dẫn + không để lại row/artifact; trong lúc dò phát tín hiệu
  "Đang định vị trang nguồn" (interval hạ 0 qua monkeypatch).
- Verify lô: py_compile đạt; **145 test đạt** (queue + engine + pipeline + parity
  + RAM policy + API + contract + disk guard).

### PB-3 (chốt) — Smoke hủy giữa job dài trên backend run_dev thật

Script `tmp/smoke_compare_long_cancel.py` (tái dùng helper smoke cũ), backend
uvicorn dev đang chạy của người dùng, corpus 250 trang @150 DPI (đúng trần mặc
định PB-1), đo RAM trên process worker thật:

| Kịch bản | Kết quả | Số đo |
|---|---|---|
| Hủy giữa job 250 trang (45 %, trang 113) | cancelled | endpoint trả sau **0,481 s**; `results/<job_id>` dọn sạch ngay (gate ≤5 s); đỉnh RAM worker 506,9 MiB |
| Chạy lại ngay sau hủy (cùng cặp file) | completed | 47,6 s; đủ 250/250 trang kết quả; 168 artifact / 101,6 MiB; đỉnh RAM 494,5 MiB |

Gate "smoke hủy giữa job 250 trang dọn sạch ≤5 s" của bậc trần 250: **đạt**.
Trạng thái gate trần 1.000 + đề xuất quyết định: xem báo cáo P-B mục 10.

### PB-3c — Quyết định trần: nâng mặc định 250 → 1.000 (đã duyệt 13/08 tối)

- Người duyệt chốt nâng trần sau khi toàn bộ gate mục 6 báo cáo P-B đạt (bảng
  10.4), chấp nhận claim "~1,6× ở DPI 300 trên tài liệu dài".
- `routes/compare.py`: `_DEFAULT_MAX_COMPARE_PAGES = 1000` (env
  `PRYNX_MAX_COMPARE_PAGES` nới/thu hai chiều giữ nguyên); comment engine +
  `CompareTab.tsx` cập nhật theo trần mới; `test_compare_queue.py` sửa test
  default (1.000) + override hai chiều (250 và 2.000).
- Verify: py_compile đạt; **145 test đạt** (bộ Compare đầy đủ); `npm run
  typecheck` đạt; `git diff --check` chỉ còn warning CRLF sẵn có.
