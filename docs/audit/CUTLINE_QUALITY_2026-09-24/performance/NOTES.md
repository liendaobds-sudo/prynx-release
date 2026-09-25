# Nhánh audit hiệu năng CUT — 2026-09-24

Phạm vi chỉ đọc production: đường Preview/Thực thi của Bù xén – Tạo đường cắt,
pool/scheduler, cache/memo và lõi Simplify. Không sửa production, không đo
benchmark nặng đồng thời với root. Những số năm 2026-09-11 dưới đây là lịch sử,
không dùng làm benchmark của source ngày 2026-09-24.

Đã đọc skills architecture, audit-workflow, performance, testing, imposition;
báo cáo hiệu năng CUT runtime, nhật ký CORE PERF 2026-09-11, audit/nhật ký giảm
node 2026-09-09 và báo cáo Simplify preview 2026-09-10.

## Luồng hiện tại và điểm đã bảo vệ đúng

- Route jobs `backend/app/api/routes/sticker_sheet.py:534` gọi bộ điều phối và
  trả 202; polling `:562` chỉ đọc snapshot, không giải lại CUT.
- `backend/app/workers/sticker_cutline_jobs.py:323` hủy generation cũ trước
  submit, `:214` chặn source/page/revision/stage cũ, `:228` kiểm lại khi publish.
  Lượt whole-page không còn dựng draft mức 0 thừa (`:257–262`).
- Pool điều phối dùng `plan_worker_count`/escape hatch
  `PRYNX_CUTLINE_PREWARM_WORKERS` (`:87–100`). Preview nhiều tem dùng pool riêng,
  truyền `copy_context().run` để giữ token hủy (`sticker_cutline_preview.py:143–164`);
  policy >=16 GB không cắt CPU (`:122–139`).
- Whole-page preview dùng process cách ly PDFium và canonical writer thật
  (`sticker_classic_page_preview.py:266–330`). Pool nóng chung hiện chỉ một worker
  (`:43–47`): hợp lý cho một job/một trang, nhưng nhiều phiên độc lập vẫn xếp
  hàng cùng pool. Chưa đo chờ nhiều tab nên đây là giới hạn kiến trúc, không
  khẳng định là nguyên nhân chậm thao tác một tab.
- Execute đi admission `kind="sticker"` trước global slot
  (`pdf_tools.py:1996–2000`), không giữ global slot trong lúc các job sticker
  chờ nhau. Một job trải trang vào process pool. Bảng phần cứng
  `sticker_engine.py:8391–8405` giữ CPU-1 khi >=16 GB; planner
  `:12049–12074` tôn trọng env và số trang. Không đề nghị tăng worker mù quáng.
- Memo là dữ liệu hình học tin cậy trong RAM, khóa gồm algorithm, toàn bộ
  control points, options/frame; cache hit cũng kiểm cancellation
  (`cutline_simplify_memo.py:54–99`). Memo không được lấy từ payload HTTP.
- Lịch sử artifact không bị LRU loại tùy tiện: UI còn giữ fingerprint A khi
  xem B rồi quay A. Source nói rõ ở `sticker_classic_page_preview.py:455–458`
  và `sticker_cutline_preview.py:1559–1563`. Đây là chủ đích chống 409/parity,
  không tự kết luận unbounded history là leak để xóa.

## Phát hiện mới có probe

### PERF.DIGEST — P2/S, confirmed helper bug; đóng góp nhỏ trên corpus hiện tại

`sticker_classic_page_preview.py:365–378` gọi `os.stat` nhưng module không import
`os`. `except Exception` bắt NameError rồi hash lại toàn file. `_DIGEST_CACHE`
không bao giờ được điền/hit trong môi trường hiện tại.

Probe gọi helper thật ba lần cùng Binder2 (759.172 byte): 3 NameError ở dòng
367, 3 `file_digest`, 0 cache entry. Hash nguồn vẫn đúng
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
Timer có trace chỉ 0,47–0,73 ms/lần; không thể giải thích hàng chục giây solver
trên file này. File rất lớn sẽ khuếch đại I/O/hash.

Reachability: `_final_cache_available` jobs `:176`, builder classic `:414/:436`,
worker classic `:286`, snapshot Execute `sticker_sheet_export.py:379` gọi helper.
Jobs còn hash thật riêng ở `_source_identity :140–141` đầu/cuối để giữ source
guard. Không được loại mọi hash.

Đề xuất: sửa thiết kế identity tin cậy theo session/revision hoặc tái dùng digest
trong phạm vi một bước được bảo vệ. **Không chỉ thêm `import os` rồi coi xong**:
key cache đang là path + `st_mtime` float + size sẽ nhận hash cũ nếu nội dung đổi
giữ stat, trong khi test/hợp đồng yêu cầu bắt đúng trường hợp đó. Cache module
hiện chưa có lifecycle clear cho mọi source cũng cần xem khi kích hoạt lại.

Bằng chứng: `probe_digest.py`, `digest_evidence.json`. Lần harness đầu đã ghi
JSON nhưng in console cp1252 lỗi Unicode; đổi `ensure_ascii=True` ở console và
chạy lại đạt. Không thay helper production.

### PERF.BLAS — P2/M, confirmed cấu hình không có tác dụng; chưa đo slowdown

`sticker_engine.py:1–3` đã import OpenCV/NumPy trước `_process_sticker_chunk`.
Worker `:8676–8681` mới set env OpenBLAS/OMP/MKL rồi gọi setter thật cho OpenCV.
Env muộn không đổi NumPy OpenBLAS đã khởi tạo.

Probe gọi worker thật với `StickerEngine` stub (không PDF/render),
`threads_per_worker=1` trên máy 16 CPU. API native
`openblas_get_num_threads64_` cho NumPy DLL báo **16 trước và 16 sau**;
`OPENBLAS_NUM_THREADS` lúc vào engine là `"1"`; OpenCV đổi **16→1** đúng.
Vì planner `:12079–12085` kỳ vọng tổng threads≈CPU, nhiều worker có thể còn cấu
hình BLAS vượt ngân sách đó. Không có số đo chứng minh các matrix nhỏ thực sự
chạy 16 thread, nên không gán một tỷ lệ speedup giả định.

Đề xuất: scope setter runtime cho các BLAS library đã nạp, hoặc bootstrap env
trước import ở worker riêng, kiểm cả NumPy lẫn SciPy và restore khi đi nhánh
in-process. Giữ tổng công suất toàn máy; đây là chia luồng lồng nhau theo số
process, không cap worker/chất lượng máy mạnh. Cần A/B CPU/wall-time và toàn
control-point/parity trước tích hợp; không thêm dependency tùy tiện.

Bằng chứng: `probe_worker_threads.py`, `worker_threads_evidence.json`.

### PERF.CANCEL — P2/S, confirmed thiếu checkpoint; mức độ latency cần đo thêm

Solver, DAG và job đã có hủy hợp tác. Tuy nhiên
`cutline_fair_verify.py:75–109,122–206,338–399` và hàm topology dưới nó không gọi
`check_preview_cancelled()`. Verifier có flatten đệ quy, metric giải tích,
GEOS buffer nhiều lượt và dense reference fallback. Nếu hủy ngay sau checkpoint
trước verifier (`cutline_fair_simplify.py:272`), công việc kiểm vẫn chạy hết.

Probe circle 8→4 cubic hủy token ở đầu callback metric của verifier thật: tiếp
tục hai metric + `_distance_bound`, trả accepted trong 125 ms instrumented.
Đây là bằng chứng dead work sau cancel, **không phải stale artifact**: caller
vẫn chặn publication bằng token/generation. Chưa đo worst-case latency.

Đề xuất: checkpoint trước/sau mỗi khối lớn và trong loop flatten/buffer; hủy
bằng `PreviewCancelled(BaseException)` để không bị fallback Exception nuốt.
Không bỏ phép kiểm, không giảm mẫu/dung sai/độ sâu. Một lệnh GEOS/native đơn lẻ
vẫn không bị ngắt giữa chừng; ghi giới hạn này khi nghiệm thu.

Bằng chứng: `probe_verifier_cancel.py`, `verifier_cancel_evidence.json`.

## Các gate hiệu năng ảnh hưởng khả năng tìm ít node/mượt

Đây là source hiện tại, khác giả định của nhật ký CORE PERF 2026-09-11 vốn nói
không giảm candidate/vòng solver. Nhánh hình học của audit chính cần lượng hóa
chất lượng trước khi quyết định thay thế.

| Gate/caller | Bằng chứng | Hệ quả được xác nhận từ code |
|---|---|---|
| Bỏ fairing cho ring >100 cubic | `cutline_fair_simplify.py:240–248` | Không dựng seed/optimizer trên ring lớn, bất kể RAM; caller chuyển reducer bảo toàn. Comment lý do CPU không phải proof hình học. |
| Execute dùng fast | `sticker_engine.py:11412–11418` | Production export cũng truyền `preview_fast=True`, không chỉ slider. |
| Preview Alpha dùng fast | `sticker_cutline_preview.py:1389–1394` | Preview canonical nhiều tem cũng gọi fast. Whole-page dùng chính engine xuất. |
| Fast rút Newton proposal 7→3 | `cutline_cubic_simplify.py:598–602` | Verifier vẫn giữ band/topology; số proposal có thể khác. |
| Fast giới hạn span12; thường24 | `cutline_global_simplify.py:143–169,237–238` | DP chỉ tối ưu trong graph đã cắt; không chứng minh tối thiểu node toàn quỹ đạo, càng chia nguồn nhỏ càng dễ ảnh hưởng. |
| Chọn branch theo mức0,075 mm và first success | `cutline_cubic_simplify.py:611–628` | Dưới0,075 global trước; đạt thì không chạy fair. Từ0,075 fair trước. Không so tất cả ứng viên để lấy ít node/mượt nhất. |
| Fair quick vẫn có full fallback | `cutline_fair_simplify.py:255–290` | Nếu quick không đạt verifier, chạy lại seed gốc với5 IRLS/35 nfev; việc không giảm node vẫn có thể tốn thời gian. |

Không đề nghị đơn giản xóa mọi gate rồi tăng worker. Cần candidate search theo
quỹ đạo/feature và tài nguyên phù hợp, bảo toàn nguồn/corner/topology/verifier;
định lượng độ cong và sai số thực, không chỉ đếm node. Máy mạnh không bị áp cap
chất lượng chung vì heuristic hiệu năng.

## Hạn chế đã biết, không báo lại như bug mới

- Cold whole-page ở mức Simplify mới vẫn chạy canonical engine/writer một lần:
  key có geometry/tolerance (`classic_page_preview.py:143–156,279–302`). Không
  xóa tolerance khỏi result key. Có thể tách baseline trước writer tái dùng,
  nhưng phải giữ frame mm/pt, lượng tử, source/corner/mask/màu/Rotate/UserUnit.
- Execute hiện nhận memo của **frame/trang được tham chiếu**
  (`sticker_sheet_export.py:371–397` → `pdf_tools.py:1918–1919`), dù người dùng
  từng xem nhiều trang. Các trang còn lại tính lại; mỗi worker nhận memo qua
  `sticker_engine.py:12139`. Đây là mục còn mở trong báo cáo 2026-09-11.
- Mỗi branch fallback của `_simplify_cubic_path_groups_impl` chuẩn hóa/kiểm
  source lại (`:468–482`). Reuse chuẩn bị immutable/metric/certificate cùng
  source/frame có thể ít rủi ro hơn giảm candidate; chưa có profile current
  tách thời gian đủ để xếp là bottleneck chính.
- Logging hiện đồng bộ stdout+file từng event và retry khi I/O lỗi
  (`cutline_debug_log.py:29–65`). Chưa có số đo impact; không đưa thành confirmed
  bottleneck. Có thể làm sai cách đọc timer engine nếu log destination lỗi.
- Lịch sử 2026-09-11: multi-page đã sử dụng đủ13 worker; merge/save rất nhỏ;
  các trang chưa có memo là critical path. Lõi/global/fair tốn chính, không nên
  tăng pool hoặc giảm verifier để che thời gian. Những con số cũ không thay cho
  đo source ngày24 đang có gate100/span12/fast.

## Verify

Chạy Windows venv trong backend:

```
python -B -m pytest tests/test_cutline_simplify_memo.py tests/test_cutline_preview_cancel.py tests/test_sticker_cutline_jobs.py tests/test_cutline_core_reuse.py -q
```

**87 passed**, 1 warning Pydantic cấu hình cũ, **12,60 giây**. Không chạy corpus
nặng trong bộ này; không cập nhật golden. Ba probe nêu trên chạy đạt ở phạm vi
helper/worker stub/verifier; chưa chạy HTTP/Tauri, chưa benchmark full PDF pool
mới, chưa nghiệm thu máy cắt.

Chỉ ghi bảy file harness/JSON/notes trong thư mục performance này; không sửa
report chính/master matrix/production và không stage/commit.
