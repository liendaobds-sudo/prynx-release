# Tích hợp operator gộp cho solver CUT — 27/09/2026

## Phạm vi

Người dùng duyệt tiếp lộ trình tăng tốc từng khuôn khác nhau sau khi sửa
clipping artwork. Lô này chỉ tích hợp **bước1: operator gộp**; chưa port
LSMR sang Rust, chưa build release hoặc commit/push. Giữ nguyên các thay đổi
artwork đang chưa commit của lô trước.

5 file của lô: module mới `cutline_fair_solver.py`, tích hợp tại
`cutline_fair_simplify.py`, test mới `test_cutline_fair_solver.py`, thêm
CPU-time vào harness `scripts/benchmark_cutline_runtime.py`, báo cáo này.

## §CUT.FUSED — thay đổi

- Gộp đường `J @ (d*x)` và `d*(J.T@u)` với diagonal regularization thành
  một LinearOperator. Gọi cùng kernel CSR/CSC có sẵn của SciPy; không
  prescale `J.data`, không đổi thứ tự phép nhân/cộng hoặc hệ phương trình.
- Kiểm CSR float64, index32/64, chiều/dtype/biên và bộ đệm liên tục trước
  khi dùng kernel nội bộ. Duplicate/unsorted giữ nguyên, không canonicalize
  để đổi thứ tự cộng. Input không phù hợp dùng builder SciPy cũ.
- Jacobian, seed, QR compression, IRLS, LSMR, bounds, x_scale, regularization,
  số vòng, ngưỡng hội tụ, verifier và writer đều giữ nguyên.
- SciPy không có API công khai để thay riêng inner operator trong TRF.
  Adapter tạo bộ globals **riêng** cho chuỗi least_squares→TRF→TRF-bounds
  từ đúng function Python đang cài; không monkeypatch globals SciPy hay
  sửa site-packages. Unbounded/LM/dogbox giữ hàm gốc.
- Guard chỉ nhận SciPy1.12.0 đang pin trong requirements, exact Python
  FunctionType không closure/decorator/compiled marker, đúng tham chiếu
  của graph và tên nội bộ cần thiết. Stub/test override được trả nguyên.
- Runtime/library/adapter không được hỗ trợ thì gọi solver cũ. Chỉ fallback
  khi dựng adapter; không bắt lỗi tính toán/hủy rồi chạy lại job. Có
  `fused_solver_status()` và log `[CUT_SOLVER]` một lần mỗi capability để
  biết đang dùng `fused-csr` hay `scipy-default`, kể cả lỗi dựng adapter.
- Không thêm worker/cache hình học, không thay RAM gate hoặc cap chất lượng.
  Cache ở đây chỉ giữ bộ function đã dựng, không giữ dữ liệu các trang.

## Kết quả hình học và PDF

Nguồn `test/Binder2.pdf`, SHA-256
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`,
hash kiểm trước/sau mỗi run. Mode bleed2mm, preserve, tension50, denoise30,
AUTO/.1mm, DPI300, solid trắng, CUT mọi trang.

Baseline benchmark `--ref d251c80` chỉ nạp hai module solver trước tích hợp;
**cả trước/sau vẫn dùng cùng engine có bản sửa clipping hiện tại**. Không
rollback source để đo, không trộn lợi ích sửa mask vào việc đánh giá solver.

- **13/13 trang: toàn bộ tọa độ/lệnh CUT và stats khớp**, ở cả13worker và
  override2worker; không chỉ so số node.
- `verify/binder-fused-parity.json`: ảnh/khổ trang và pixel toàn PDF gồm
  CUT của13trang khớp ở150DPI. Không cập nhật golden.
- Test ma trận so bit float64 cho cả chiều đi/về, int32/int64,
  duplicate/unsorted, vector strided. Bài toán bounded thật giữ nguyên
  nghiệm, cost, optimality, nfev/njev/status; test hai luồng xác nhận
  globals SciPy không đổi.

Artifacts: `.tmp/cutline-fused-20260927/`.

## Số đo — chưa thể hứa tăng tốc ổn định toàn job

Máy hiện tại: Intel Core i5-13400,10lõi/16luồng theo CIM. Không đổi ưu tiên,
affinity hay số worker của ứng dụng. Các lượt benchmark chạy tuần tự,
không chạy đồng thời với test; vẫn là máy dùng chung, không phải lab cô lập.

| Lượt đủ13trang | Trước | Operator gộp |
|---|---:|---:|
| A,13worker | 20,772s | 17,321s |
| B,13worker | 11,185s | 21,829s |
| C,13worker, có CPU-time từng Simplify | 18,322s | 17,207s |
| Override2worker | 33,831s | 36,412s |

**Không bỏ lượt B hoặc ca2worker chậm hơn.** Trung bình13worker của3lượt
chưa tốt hơn baseline; median thì nhỏ hơn. Vì dao động lớn, các số này chưa
chứng minh tăng tốc toàn tác vụ ổn định hoặc đạt tốc độ trước25/09. Không
gọi lượt thuận lợi20,77→17,32 là mức tăng tốc đã chốt.

Cặp C có13khóa đầu vào Simplify giống nhau: tổng CPU worker40,50→39,53s;
riêng key trang3 là13,047→11,984s. Cặp2worker lại có tổngCPU47,83→55,50s;
các key vẫn giống nhau. CPU-time cũng chịu tốc độ lõi/trạng thái máy, chưa
được dùng để quy mọi dao động cho patch hoặc scheduler.

### Đo kiểm soát cùng CPU logic cho lõi trang3

Probe `.tmp/cutline-fused-20260927/paired_core.py` dùng cùng input đã capture,
cùng process,1luồng thư viện số; chỉ process probe được cố định vào CPUlogic0.
Không áp quy tắc affinity này cho production. Thứ tự A–B–B–A:

| Bản | Wall | CPU |
|---|---:|---:|
| Trước1 | 6,610s | 5,781s |
| Gộp1 | 5,389s | 5,094s |
| Gộp2 | 5,179s | 4,984s |
| Trước2 | 5,949s | 5,797s |

CPU trung bình5,789→5,039s, giảm **12,95%**. Tất cả control-points/stats
khớp. Đây là bằng chứng giảm chi phí **lõi trên một contour**, N=2 mỗi phía;
không thay cho latency GUI hoặc toàn13trang. Không giảm vòng lặp để lấy số.

## Test và giới hạn runtime

- Bộ mới **56 passed**; có kiểm fallback version/kernel/module/compiled
  metadata/wiring, trạng thái khi clone lỗi, lỗi/cancel không chạy lại.
- Bộ hồi quy solver/preview/memo: **503 passed, 3 skipped**,155,06s. Sau
  đó thêm một ca báo đúng lỗi dựng adapter và chạy lại adapter/Jacobian/core
  reuse trên source cuối: **95 passed, 1 skipped**. Các bộ có trùng test;
  tổng ID duy nhất đã đạt là504, không cộng503+95. Skip là fixture corpus
  riêng không có trên máy; warning Pydantic/Starlette có sẵn.
- `py_compile` và `git diff --check` phạm vi lô đạt; không sửa TS/Rust nên
  không chạy typecheck/Vitest/Cargo.

### Bộ cài Nuitka

Đường tối ưu này xác minh trên **backend Python/SciPy1.12.0 hiện tại**.
Build script có compile scipy.optimize. Nuitka có thể trả compiledfunction
với code object chỉ là metadata; adapter chủ động từ chối, về SciPy cũ và
báo `solver-runtime-unverified`. **Không tuyên bố bộ cài đã được tăng tốc**
bằng clone function này. Muốn tăng tốc cả runtime đóng gói cần phần solver
native hoặc tích hợp khác được kiểm riêng; bước2 chưa triển khai trong lô.

Chưa chạy lại thao tác Tauri/Illustrator. Không port toàn engine, không nới
dung sai, không thay bộ kiểm đường cắt và không dùng chế độ nhanh.

Hash source cuối:

- `cutline_fair_solver.py`: `12C0A62B5929F13CDA0841C19518F2544BC2F38FF66540FBEE8A2326AD2F85D1`
- `cutline_fair_simplify.py`: `9E1E9A4A38BEABD7F6E9659654D6A1ADD898BE95C15CBE5E6A404B8662007F6E`
