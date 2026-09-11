# Preview và Thực thi bù xén còn chậm — đo lại 2026-09-11

## Trạng thái và phạm vi

Người dùng báo: “tôi thấy preview và thực thi bù xén tạo đường cắt còn chậm”.
Chưa có file/trang/thông số hoặc chuỗi thao tác mới của người dùng. Dùng corpus
`test/Binder2.pdf`, trang 12 để khoanh vùng; không gọi đây là tái hiện đúng phiên
Tauri của người dùng. SHA-256 đã kiểm lại:
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.

Lô trước đã nối job nền, latest-only, hủy hợp tác và canonical preview. Các cơ
chế đó không đồng nghĩa lần tính mới đã nhanh: giá trị chưa có cache vẫn cần
dựng hình học. Báo cáo cũ `BAO_CAO_AUDIT_HIEU_NANG_SIMPLIFY_PREVIEW_2026-09-10.md`
còn ghi prewarm chưa triển khai; trạng thái ấy đã lỗi thời so với source hiện tại.

Lượt này chỉ sửa nhỏ `§PREWARM.DRAFT` trong bộ điều phối và test tương ứng.
Không sửa solver, dung sai, số mẫu kiểm, DPI, worker count, màu hoặc artwork.
Các đề xuất lớn hơn ở cuối báo cáo chưa triển khai, cần duyệt theo
`prynx-audit-workflow`.

## Số đo và giới hạn diễn giải

### Một trang, không qua HTTP/Tauri

Chạy test có sẵn
`test_cache_binder2_simplify_preview_bang_cut_pdf_va_execute_khong_giai_lai`
trong `backend/tests/test_sticker_cutline_preview.py`. Test gọi engine tuần tự,
so lệnh SVG với CUT PDF, và chặn lõi Simplify khi đo cache nóng/Execute dùng memo.
RAM trong bảng chỉ là mô phỏng policy cache trên cùng máy, không phải hai máy.

| Thông số | RAM policy cache | Preview lạnh | Lặp cùng thông số | Execute 1 trang dùng memo |
|---|---:|---:|---:|---:|
| original/preserve, offset 2 mm, Simplify 0,10 mm | 4 GB | 6,2522 s | 0,0103 s | 1,2955 s |
| bleed/round, bleed 2 mm, bo 100, Simplify 0,10 mm | 4 GB | 21,3089 s | 0,0102 s | 2,5788 s |
| original/preserve, offset 2 mm, Simplify 0,10 mm | 32 GB | 7,5949 s | 0,0090 s | 1,1598 s |
| bleed/round, bleed 2 mm, bo 100, Simplify 0,10 mm | 32 GB | 19,2738 s | 0,0093 s | 2,6197 s |

4 test đạt. Kết quả giữ 122→64 đoạn và 364→56 đoạn, cận tương ứng
0,08950000 mm và 0,09983597 mm. Không lấy các số trên để dự đoán tổng thời
gian Execute đủ 13 trang hoặc thời gian tải kết quả vào Viewer.

### Job ProcessPool Windows thật

Tạo session tạm, inspect/detect Alpha trang 12 rồi gọi `start_preview_job`.
Bộ đếm thời gian bắt đầu sau detect, kết thúc khi worker đã xong; chưa bao gồm
HTTP, debounce, polling UI hoặc dựng Viewer. Cấu hình bleed/round như trên.

| Lượt đo | Tổng job | Các lần gọi builder |
|---|---:|---|
| Trước sửa, không instrument builder | 17,009 s | Không tách thời gian từng bước |
| Trước sửa, có instrument builder | 20,384 s | Nháp 0: 1,902 s; cuối 0,10: 18,464 s |
| Sau bỏ nháp whole-page | 8,336 s | Chỉ cuối 0,10: 8,321 s |

Đây là các lần chạy riêng, không phải A/B có tải máy được kiểm soát hay trung
vị N lần. **Không kết luận bỏ nháp tạo ra toàn bộ mức giảm 20,384→8,336 s.**
Ngay phần builder cuối cũng dao động 18,464→8,321 s. Bằng chứng chắc chắn:
bỏ một lần dựng nháp; trong lượt trước sửa nó chiếm 1,902 s.

Lượt đầu trong sandbox bị `WinError 5` khi tạo named pipe; job `failed` sau
0,021 s không được tính là benchmark thành công. Các số ProcessPool ở bảng
là lượt đã được cấp quyền ngoài sandbox.

### Profile lõi (không dùng để so speedup wall-time)

`tmp/simplify-perf-20260910/core/profile_core.py --case round --profile
--label current-20260911` dùng input cubic đã capture từ engine, không sửa PDF.
Kết quả nằm tại `round_current-20260911_summary.json`,
`round_current-20260911.pstats` và `round_current-20260911_profile.txt` cùng thư mục.

- Tổng có profiler: 27,775 s; 364→56 đoạn, cận 0,09983597132103336 mm.
- `global_refit_ring`: 19,422 s; `_candidate`: 63.086 lời gọi, 18,955 s tích lũy.
- `_merge`: 5,869 s; phân tích metric đường máy lặp lại cũng đáng kể.
- Các thời gian tích lũy lồng nhau, không cộng lại.
- Một probe engine không cProfile đo riêng `_simplify_cubic_path_groups_impl`
  mất 15,196 s. Nhánh này là reducer bảo toàn/global, không phải fair solver.

### Execute đủ 13 trang — đã chạy sau khi người dùng cho phép

Người dùng trả lời “tiến hành đi” cho yêu cầu benchmark ngoài sandbox. Hai
lượt sau chạy tuần tự bằng Windows ProcessPool thật, không đổi mã engine
giữa các lượt; agent phụ chỉ đọc code, không chạy benchmark tranh CPU.

Harness: `tmp/cutline-runtime-20260911/benchmark_execute.py`. Thông số:
bleed/round, bleed 2 mm, offset 0, bo 100, denoise 30, Simplify 0,10 mm,
DPI 300, nền bù xén solid trắng. Nguồn đủ 13 trang, không truyền `_page_subset`
ở lần Execute. Máy có 16 CPU logic, 32.527,9 MiB RAM; không ép worker bằng env.
Engine chọn **13 worker / 13 chunk, một trang mỗi chunk**, không fallback.

| Đại lượng | Không memo | Có memo preview trang 12 |
|---|---:|---:|
| Tổng `engine.process_pdf` | 45,5148 s | 38,6703 s |
| Chờ worker (`worker_s`) | 45,328 s | 38,482 s |
| Gộp chunk | 0,164 s | 0,151 s |
| Loại image trùng | 0,002 s | 0,005 s |
| Lưu PDF | 0,004 s | 0,005 s |
| Trang 12 — xử lý trong worker | 37,270 s | 2,518 s |
| Trang 4 — xử lý trong worker | 43,944 s | 37,072 s |
| Trang 9 — xử lý trong worker | 39,708 s | 27,919 s |
| Số trang kết quả | 13 | 13 |

Lượt có memo chuẩn bị preview trang 12 trước, mất **17,0753 s** và thu một
memo entry; thời gian chuẩn bị này **không** cộng vào cột Execute. Đây là mô
phỏng Execute khi đã có preview, không phải tổng thời gian mở file đến hoàn tất.
`worker_s` gồm cả spawn/import, IPC, xử lý, ghi chunk tạm và đóng pool;
không diễn giải nó thành thời gian thuần Simplify. Timer trang cũng không
tách riêng mọi bước solver/writer.

Bằng chứng JSON:

- `tmp/cutline-runtime-20260911/execute-no-memo-14981644.json`
- `tmp/cutline-runtime-20260911/execute-memo-page12-0ea2bccf.json`

Đã mở lại cả hai PDF, kiểm đủ 13 trang, parse lệnh CUT và so hash từng trang:
**13/13 giống nhau**. Hash sáu module engine/simplifier giữa hai lượt giống
nhau, SHA-256 nguồn trước/sau giống nhau. Chỉ PDF tạm của harness được dọn
sau kiểm tra; JSON bằng chứng giữ lại. Không có PDF nguồn bị sửa/xóa.

Đây là N=1 cho mỗi tình huống, không phải trung vị nhiều lần hoặc benchmark
trên máy chuyên dụng không tải nền. Không coi chênh 45,5→38,7 s là cam kết
speedup cố định. Cũng chưa đo HTTP, admission scheduler, restore canvas,
watermark, truyền file hoặc render Viewer/Tauri.

Kết luận trong phạm vi đã đo: fan-out đã dùng đầy đủ 13 worker; gộp/lưu PDF
không chiếm đáng kể thời gian. Memo của trang 12 giảm việc của trang đó,
nhưng trang 4 vẫn quyết định lúc Execute trả kết quả. Trang 6 và 9 còn có
`cutline_simplification.changed=false` dù xử lý lâu, nên chỉ đếm số node
không đủ đánh giá chi phí. Cần profile lõi của các trang này trước lô sửa
tiếp, không tăng worker hoặc bỏ verifier để che thời gian tính.

## Phát hiện và bản sửa nhỏ

### §PREWARM.DRAFT — P2/S: dựng nháp whole-page không được UI dùng

Bằng chứng: `_run` trong `backend/app/workers/sticker_cutline_jobs.py` dựng
Simplify 0 rồi mức cuối trên cache miss. `_classic_baseline_key` trong
`backend/app/workers/sticker_classic_page_preview.py:141` chứa cả dung sai;
hai lượt đi qua hai lần engine canonical riêng. Hook
`desktop/src/components/preprocess-tools/useClassicCutlinePreview.ts` chỉ
nhận `job.result` khi `ready`, không hiển thị `job.draft`.

Sửa: whole-page đi thẳng vào builder với đúng thông số yêu cầu. Luồng thường
giữ hành vi draft/final. Kiểm nguồn, revision, cancellation, publish canonical
và phục hồi active cache khi lỗi vẫn giữ nguyên.

Các consumer được đối chiếu: schema job, route start/read, hook polling,
`StickerTool` (chốt Execute), và snapshot/memo trong `sticker_sheet_export.py`.
Không đổi hợp đồng result hoặc fingerprint; draft vốn là field tùy chọn/null.

### §CUTRUNTIME.1 — P2/M: mức Simplify mới vẫn đắt

Cache cuối phải phân biệt dung sai để giữ đúng kết quả. Whole-page chưa có
baseline hình học trước writer dùng chung giữa các mức. Không được đơn giản
xóa `cutline_simplify_mm` khỏi khóa kết quả: làm vậy sẽ trả đường của mức khác.
Profile cho thấy reducer xét nhiều span là nút thắt chính của ca round đã đo.

### §CUTRUNTIME.2 — P2/M: memo một trang không đại diện Execute cả tài liệu

`snapshot_classic_cutline_preview` trả memo của frame được tham chiếu;
`backend/app/api/routes/pdf_tools.py:1907` truyền memo đó vào engine.
Các trang khác chưa có memo vẫn cần tính, và ngay trang có memo vẫn đi qua
phần dựng PDF/màu/canvas. Test một trang dùng memo đã đạt; benchmark 13 trang
sau khi được cấp quyền ở mục trên xác nhận vẫn chờ trang chưa có memo.

## Verify và phần chưa đạt

- Backend job: **33 passed**, gồm no-draft whole-page, stale/cancel và lỗi
  ở cả hai mode, explicit-zero, cache và cleanup.
- Vitest: **78 passed / 3 file** (hook, API, StickerTool UI).
- `py_compile` hai file Python thay đổi đạt. Không sửa TS hoặc Rust.
- Không cập nhật golden, không commit.
- Chưa đo sau sửa trên một máy RAM thấp vật lý; không suy ra từ mock policy.
- Chưa thao tác Tauri hoặc xác định file/thông số thật của phản hồi mới.
- Benchmark Execute 13 trang ngoài sandbox bị hệ thống cấp quyền từ chối
  do lỗi `429 Too Many Requests` ở approval review, trước khi lệnh chạy.
  Không thử đường vòng. Sau khi người dùng xác nhận “tiến hành đi”, đã chạy
  hai lượt benchmark đủ 13 trang như mục bổ sung ở trên.
- Lượt benchmark tiếp nối không sửa thêm mã production. Harness đạt
  `py_compile`; PDF đủ trang và CUT parity đạt. Không lặp lại các test của
  lô bỏ nháp chỉ để tăng số test đã báo.

## Thứ tự đề xuất tiếp theo — chưa triển khai

1. Đo lại trên đúng file/trang/thông số người dùng, tuần tự khi máy không chạy
   benchmark khác; tách inspect/detect, solver, writer và Viewer.
2. Lô lõi ≤5 file: prototype giảm phép tính trùng trong candidate/metric nhưng
   giữ cùng candidate graph, thứ tự chọn, dung sai và verifier. Chỉ tích hợp
   sau đối chứng output và số đo A/B; không giảm vòng tìm kiếm để lấy tốc độ.
3. Lô riêng ≤5 file: tái dùng baseline **trước writer** giữa các mức Simplify
   và snapshot các trang đã duyệt khi Execute. Cần kiểm khóa source/frame,
   lỗ/góc, parity CUT, cancellation và RAM-gating; không tái dùng PDF nháp
   như PDF xuất, không Simplify trên đường đã làm tròn đọc ngược từ PDF.

Mục tiêu giảm thời gian thực tế vẫn mở. Bỏ nháp thừa chỉ là một phần nhỏ,
không phải kết luận toàn tính năng đã nhanh.
