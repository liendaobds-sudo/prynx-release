# Lô tối ưu lõi Simplify — 2026-09-11

## Phạm vi được duyệt

Sau báo cáo `BAO_CAO_AUDIT_HIEU_NANG_CUTLINE_RUNTIME_2026-09-11.md` và số đo
Execute đủ 13 trang, người dùng yêu cầu “tiến hành đi”, sau đó “tiếp”. Lô này
triển khai giảm phép tính trùng trong lõi, không đổi thuật toán chọn nghiệm,
thứ tự seed/fallback, dung sai, số vòng solver, verifier, quỹ đạo hoặc worker.

Ba file production, một file test mới và báo cáo này tạo thành lô ≤5 file.
Không sửa các thay đổi khác trong worktree; không stage/commit/build release.

## Bằng chứng và thay đổi

### §CUTRUNTIME.CORE — tái dùng phần chuẩn bị trong đúng một lần gọi

Profile đầu vào thật của Binder2 trang 4 (98→59 đoạn) cho tổng có profiler
28,372 s; fair solver 26,821 s, LSMR 15,811 s và hai lần dựng seed 3,440 s.
Trang 9 (52→52 đoạn) có tổng 16,208 s; hai lần dựng seed 2,636 s.
Số tích lũy lồng nhau, không cộng lại; không so trực tiếp thời gian có
profiler với wall-time của benchmark không profiler.

- `backend/app/workers/cutline_fair_simplify.py`: khi lượt nhanh không đạt,
  tái dùng nguồn/mẫu/seed bất biến để chạy lượt đầy đủ. Mỗi optimizer vẫn bắt
  đầu từ bản sao seed gốc; không warm-start từ candidate nhanh bị loại.
- `backend/app/workers/cutline_fair_seed.py`: cây chia và hàng đợi gộp tái
  dùng kết quả `_fit` cho cùng cặp `(start,end)` trong một `_fit_run`; gồm cả
  nghiệm bị loại. Cache kết thúc theo lời gọi, không dùng chung giữa trang,
  mức slider hoặc thread. Lấy mẫu chỉ tính vị trí khi không cần đạo hàm,
  với nguyên biểu thức số học cũ.

### §CUTRUNTIME.CSR — dựng cấu trúc Jacobian một lần

- `backend/app/workers/cutline_fair_jacobian.py`: ánh xạ COO→CSR và các cột
  free cố định trong một vòng đối ứng. Chuẩn bị ánh xạ một lần, mỗi bước
  solver chỉ điền các đạo hàm mới theo đúng thứ tự cũ.
- Ring 1/2 neo vẫn dùng assembly cũ vì có cột trùng cần cộng theo quy tắc
  SciPy. Boolean mask không có cột free trả đúng ma trận 0 cột.
- Mỗi ma trận trả về có mảng riêng; `eliminate_zeros()` hoặc solver không
  được sửa template. Không loại đạo hàm nhỏ, chỉ bỏ số 0 như trước.

Các consumer: `build_fair_seeds` → `fair_refit_ring` → dispatcher
`simplify_cubic_path_groups`; dispatcher dùng bởi preview Alpha và writer
classic/Execute. API, cache fingerprint, memo, mặt nạ, màu và renderer không
thay đổi. Không đổi salt thuật toán vì phép tính và nghiệm được giữ nguyên.

## Đối chứng chất lượng

- `backend/tests/test_cutline_core_reuse.py`: oracle `_fit_run` không cache,
  so bit vị trí/mẫu, đếm phép fit trùng, giữ đầu vào bất biến, seed gốc cho
  full fallback, lỗi phụ thuộc tùy chọn và cancellation.
- CSR được so toàn bộ `data/indices/indptr` với assembly COO cũ qua selector
  số nguyên: ring 2/3/4/11 neo, có khóa góc/tất cả/không có biến free; thử
  sửa ma trận trả về rồi gọi tiếp. Test đếm chỉ dựng cấu trúc một lần.
- Capture đầu vào Simplify từ engine thật ở trang 4/6/9/12, không đọc SVG
  pixel làm nguồn. A/B lõi trang 4/6/9 so toàn bộ tọa độ, metadata và cận
  sai số, tất cả khớp nguyên vẹn ở các lượt đã chạy; không chỉ so số node.
- Execute đủ 13 trang: so hash lệnh CUT từng trang giữa lõi cũ/mới,
  **13/13 khớp** ở cả cấu hình 13 worker và 2 worker.
- SHA-256 Binder2 trước/sau giữ nguyên
  `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
  PDF kết quả của harness được tạo rồi dọn trong thư mục tạm riêng; không
  sửa/xóa nguồn. JSON số đo vẫn giữ lại.

## Số đo — không che các lượt dao động

Nguồn `test/Binder2.pdf`, đủ 13 trang. Theo mép tràn lề 2 mm, offset 0,
góc tròn/bo 100, denoise 30, Simplify 0,10 mm, DPI 300, nền bù xén solid
trắng. Đo `StickerEngine.process_pdf`, không có memo preview, không đưa
`_page_subset` vào lần Execute. Máy 16 CPU logic, 32.527,9 MiB RAM.

Các lượt cũ/mới chạy tuần tự. Baseline là bản sao ba module ngay trước lô
này, nạp riêng trong process benchmark; không chép đè source production.

| Lượt | Worker | Wall-time cũ | Wall-time mới | Tổng CPU worker cũ → mới |
|---|---:|---:|---:|---:|
| Cặp đầu, chưa đo CPU | 13 | 36,048 s | 44,028 s | Chưa đo |
| Cặp có CPU-time | 13 | 45,337 s | 30,112 s | 140,344 → 107,844 s |
| Giả lập ít worker bằng env | 2 | 63,264 s | 39,922 s | 97,641 → 68,594 s |

**Không cam kết mọi file/mọi lần chạy nhanh hơn 33–37%.** Cặp đầu wall-time
xấu đi; ngay trang 12, không đi qua nhánh fair vừa sửa, cũng tăng 20,178→
36,350 s. Số đo bị ảnh hưởng bởi trạng thái máy dùng chung; không được quy
toàn bộ chênh lệch cho bản vá. Cặp tiếp theo theo dõi thêm CPU-time cho thấy
giảm tổng công việc CPU của worker trong chính lượt đó. CPU-time là tổng
thời gian CPU nhiều worker, không phải thời gian người dùng chờ.

Lõi riêng cũng dao động: hai cặp xen kẽ ở trang 4 có trung vị 15,726→16,189 s;
trang 6 là 6,150→6,809 s; trang 9 là 20,562→15,421 s. Một cặp bổ sung có
CPU-time cho trang 4 là 23,141→17,594 s, trang 6 là 6,344→6,875 s và trang 9
là 19,953→18,766 s. Không dùng riêng một trang hay lượt thuận lợi để tuyên
bố tăng tốc chắc chắn toàn ứng dụng.

Cấu hình 2 worker chỉ là override cho process benchmark; không phải máy
RAM 4/8 GB vật lý và không thay cấu hình PrynX. Máy mạnh vẫn dùng đủ 13 worker
cho file này. Không thêm cap/limit vào mã production.

### File bằng chứng

Trong `tmp/cutline-runtime-20260911/`:

- `baseline/`: ba module trước sửa để A/B, không phải code được ứng dụng nạp.
- `core_probe.py`, `capture-page{4,6,9,12}.json`: capture/profiler lõi.
- `core-page4-baseline-profile.json`, `core-page9-baseline-profile.json`
  và `.pstats` tương ứng: profile trước sửa.
- `paired_core.py`, `core-paired-3961b4ad.json`, `core-paired-f302b75c.json`:
  A/B lõi xen kẽ, equality của toàn kết quả.
- `benchmark_execute.py`: đủ 13 trang, có `--baseline` và `--measure-cpu`.
- `execute-no-memo-46905c99.json`, `execute-no-memo-50f73bb5.json`: cặp đầu.
- `execute-no-memo-b573be65.json`, `execute-no-memo-cc89c29b.json`: cặp 13
  worker có CPU-time.
- `execute-no-memo-86c17a15.json`, `execute-no-memo-0fb0ccfa.json`: cặp 2
  worker có CPU-time.

## Verify cuối và giới hạn

- Bộ hẹp mới + seed/Jacobian không gồm hai ca Binder2: 54 passed.
- Bộ hồi quy tổng hợp: **265 passed**, 154,89 s, gồm core reuse, seed,
  Jacobian, cubic/global, verifier, cancel, memo, job và cutline preview.
  Bộ này bao gồm test của lượt hẹp; không cộng 54+265 thành test độc lập.
  Chỉ còn warning Pydantic có sẵn, không có test lỗi.
- `py_compile` ba module, test mới và harness đạt.
- `git diff --check` đạt; so nội dung ba module với bản sao baseline chỉ có
  thay đổi tái dùng trong lô này.
- Chưa thao tác Tauri; chưa đo từ kéo slider/click Execute đến frame Viewer
  thật. Đo engine không bao HTTP, admission, watermark, restore canvas hoặc
  tải/render kết quả trong Viewer.
- Không cập nhật golden hoặc sửa frontend/Rust; không build/commit.
- Simplify vẫn cần tính khi đổi thông số chưa có cache. Lô này giảm công
  việc trùng, chưa làm mọi preview tức thì và không giải quyết toàn bộ LSMR.
