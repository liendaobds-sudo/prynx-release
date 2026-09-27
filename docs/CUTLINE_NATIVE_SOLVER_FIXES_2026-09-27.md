# Bước 2 — LSMR native cho CUT

Triển khai ngày27/09, chốt kiểm tra sau0giờ ngày28/09/2026 (UTC+7).

## Phạm vi đã duyệt

Người dùng duyệt “tiến hành” bước2 sau khi chốt: kernelLSMR Rust, binding
PyO3, bộ điều phối tĩnh dùng được với Nuitka, fallback SciPy và đối chứng
13khuôn. Lô này giữ đúng5file: `native/src/cutline_lsmr.rs`, đăng ký tại
`native/src/lib.rs`, `backend/app/workers/cutline_fair_solver.py`,
`backend/tests/test_cutline_fair_solver.py`, báo cáo này.

Giữ các sửa clipping/memo/QR/fused của những lô trước; không stage/commit,
không build/phát hành installer, không đổi Cargo release profile, không
thêm dependency hoặc hard-cap worker/chất lượng. Bản native chỉ được bật
sau bằng chứng numerical/geometry/artifact và tốc độ, không thay bằng
đường rút gọn thô nếu chưa đạt.

## Thiết kế

- Rust tính LSMR của toán tử augmented `[J·diag(scale); diag(diagonal)]`,
  giữ recurrence/termination của SciPy1.12.0; không dùng normal equations
  hoặc fast-math. Binding kiểm biên CSR và số hữu hạn, sở hữu dữ liệu trước
  khi nhả GIL; callback hủy được kiểm định kỳ và giữ nguyên ngoại lệ hủy.
- Bộ bounded-TRF tĩnh giữ preprocessing, QR, điều kiện hội tụ, callback
  counters và OptimizeResult của đường CUT. Không đọc/clone bytecode hoặc
  monkeypatch SciPy để nối kernel native; không thay bản thân least_squares
  dùng bởi tác vụ khác.
- Unsupported options trước callback đi solver gốc; unsupported Jacobian
  phát hiện sau callback đi tiếp stockTRF với chính f0/J0 đã có, không gọi
  lại callback. Binding thiếu/cũ về đường SciPy, trạng thái backend có log.
- Nguồn chuyển thể giữ notice SciPy BSD-3-Clause và tác giả LSMR trong file.

## §CUT.NATIVE — kết quả và chốt chất lượng

Đã bật lựa chọn native trong source **sau** đối chứng corpus, với guard
SciPy1.12.0 + NumPy1.26.4 + bindingAPI2. Thiếu binding, version khác hoặc
contract chưa hỗ trợ dùng fused/SciPy cũ. Không có fallback bắt lỗi rồi
chạy lại residual hoặc công việc đã hủy.

Vòng lặp LSMR, nhân CSR/transpose, cập nhật vector được chuyển sang Rust.
**Norm vẫn gọi chính `numpy.linalg.norm` qua API PyO3 an toàn**, trên bản sao
NumPy riêng. Rust nhả GIL cho tính toán và chỉ lấy lại lúc gọi norm/hủy.
Không có DLL loading thủ công, function pointer, FFI Windows thô, fast-math
hay normal equations. Bounded-TRF là code tĩnh, không clone bytecode.

### Vì sao không dùng norm cộng tuần tự thuần Rust

Prototype đầu qua unit test nhưng **không đạt gate chất lượng corpus**:
ở2worker, trang12 đổi62→58cubic, max độ cong29,948→59,823/mm; trang13
tăng bước nhảy độ cong. Cả hai vẫn dưới dung sai nguồn0,1mm, nên chỉ kiểm
ngưỡng này là chưa đủ. Cờ native được giữ tắt trong lúc điều tra.

Giữ reduction NumPy đã khắc phục hoàn toàn: API2 khớp từng bit trên
100CSR ngẫu nhiên +10hệ cố định; toàn bộ tọa độ và stats corpus trở về
đúng baseline. Không nới test/dung sai hoặc chọn nghiệm kém hơn để lấy tốc độ.
Số đo của prototype bị loại **không được dùng làm kết quả tăng tốc cuối**.

Nguồn notice SciPy/SOL được giữ nguyên văn trong source và trong
`cutline_lsmr_version.__doc__` của binary, đã kiểm thực tế. Bộ cài đầy đủ
vẫn cần kiểm notice trong artifact như quy trình phát hành riêng.

## Đối chứng hình học và PDF cuối

Nguồn `test/Binder2.pdf`, SHA256
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
Cùng DPI300, bleed2mm, preserve, tension50, denoise30, AUTO/.1mm, mọi trang.
Hai phía dùng cùng engine đã sửa clipping; chỉ đổi backend solver.

- **13/13 trang khớp chính xác toàn bộ CUT + stats**, ở cả13worker và2worker.
  Trang12/2worker trở lại62cubic và cận0,08832812500181901mm; trang13
  trở lại63cubic và cận0,07582812500181903mm, toàn bộ tọa độ trùng.
- Các metric độ cong/topology cũng giữ nguyên vì hình học trùng hoàn toàn,
  không chỉ gần nhau qua lấy mẫu. Không cập nhật golden snapshot.
- Cả hai cấu hình: ảnh nhúng, khổ trang và **mọi pixel PDF gồm CUT ở150DPI
  khớp**, không chỉ so artwork sau khi ẩn đường cắt.
- Có1.181lần gọi Rust thật mỗi lượt13worker;1.648lần ở2worker. Fused gọi0.
  Trace ghi bindingv2, đúng đường DLL staged; không suy từ việc import được DLL.
- Replay13đầu vào thật của2worker, không có memo scope: groups/stats chưa
  lượng tử cũng khớp hoàn toàn. Lõi trang3 của sáu lượt CPU-controlled có
  artifact JSON byte-identical.

Artifacts trong `.tmp/cutline-native-20260927/`:
`quality-review-initial.*` giữ ca bị chặn; `quality-review-v2.json` chốt
hình học cuối; `safe-norm-all.json`, `safe-norm-core/`,
`verify-final13/exact-parity.json`, `verify-final2/exact-parity.json`.

### Phát hiện ngoài phạm vi

Baseline fused13worker và2worker đã có khác biệt **đầu vào trước Simplify**
ở một số trang, ví dụ trang12 là85vs133cubic. Vì vậy chỉ so native/fused
**cùng cấu hình worker**; không lấy sai khác upstream/chunking này để biện
minh hồi quy native. Không sửa pipeline/chunking trong lô này.

## Hiệu năng cuối — không giảm chất lượng

Máy Intel Core i5-13400,10lõi/16luồng. Các benchmark tuần tự, không chạy
đồng thời với test/build. Máy dùng chung nên wall-time còn dao động.

### Lõi trang3, cùng process và CPUlogic0, thứ tự A–B–C–C–B–A

| Backend | CPU lượt1 | CPU lượt2 | CPU trung bình |
|---|---:|---:|---:|
| SciPy trước bước1 | 5,406s | 5,656s | 5,531s |
| Fused bước1 | 4,734s | 4,797s | 4,766s |
| Native API2 + norm NumPy | 3,938s | 3,969s | 3,953s |

Giảm **17,05% CPU so bước1**, hoặc28,53% so trước cả hai bước. Cùng123→88
cubic, tọa độ/stats khớp byte. Đây là số lõi một contour, không phải latency GUI.

### Đủ13trang, không chỉnh affinity,13worker

| Lượt | Fused bước1 | Native API2 |
|---|---:|---:|
| A | 15,254s | 14,238s |
| B | 16,886s | 13,293s |
| Trung bình | **16,070s** | **13,765s** |

Wall giảm **14,34%**. Tổng CPU các bước Simplify giảm từ trung bình39,156s
xuống32,703s (16,48%). Đây làN=2mỗi phía; không cam kết tỷ lệ cố định
trên mọi PDF hoặc tuyên bố đã nhanh hơn bản ngày25/09 chưa đo cùng điều kiện.

### 2worker — ghi cả lượt bất lợi, kiểm thêm trên cùng CPU

Lượt không cố định CPU: fused29,089s, native30,979s, **native chậm6,50%**.
Các lượt fused2worker trước đó36,521–38,615s cho thấy dao động lớn, nhưng
không được bỏ lượt bất lợi này khỏi báo cáo hoặc xem nó là đã tăng tốc.

Probe đối chứng tiếp đặt riêng process benchmark và con trên CPUlogic0+2,
thứ tự A–B–B–A, giữ nguyên2worker và hình học. Không đổi affinity ứng dụng.

| Lượt cố định cùng CPU | Fused | Native API2 |
|---|---:|---:|
| A | 18,399s | 17,044s |
| B | 18,172s | 17,040s |
| Trung bình | 18,286s | 17,042s |

Giảm6,80% trong đối chứng kiểm soát. Không thêm cap hay chính sách pin CPU
vào production; kết quả không đồng nghĩa mọi lượt2worker ngoài thực tế đều nhanh hơn.

## Test, cài dev và giới hạn nghiệm thu

- Cargo check và check--tests đạt;8Rust unit test đạt sau API2; release-dev
  extension build đạt, không thay Cargo profile/dependency.
- **246/246test** source adapter + native staged đạt, không skip; gồm
  parity float64 bit cho100CSR ngẫu nhiên/10hệ cố định, sparse duplicate,
  suy biến/ill-conditioned/damping, counters, errors/cancel không retry,
  concurrency và callback không sửa dữ liệu solver.
- Module adapter được biên dịch Nuitka4.1.2; **246/246test** trên module
  compiled cuối + bindingAPI2 đạt. SciPy globals không bị monkeypatch.
- Bộ hồi quy30file: **1.041test đạt,3skip** theo ID không cộng trùng. Lượt
  đầu1.037đạt/4lỗi quyền Named Pipe/3skip trong358,77s; chạy lại đúng hai
  module ngoài sandbox: memo25đạt và classic preview9đạt, xác nhận cả4lỗi
  môi trường đã hết. Không còn lỗi code trong bộ đã chạy. Ba skip cùng
  thiếu fixture riêng `output/pdf/Binder2-page12-global-final-2026-09-10/`
  `Binder2_page12_offset2_B3.pdf`; không coi chúng là đã đạt.
- Đã cài vào venv dev bằng `maturin develop --release --offline --locked`.
  Process mới không dùng stage báo API2/backend=`native-lsmr`; **246test trên
  chính binary đã cài đạt**. Smoke engine đủ13trang bằng binary đã cài khớp
  CUT/stats và mọi pixel PDF với baseline; timer smoke có chạy cùng test nên
  không dùng nó làm số đo hiệu năng.
- Không sửa TS/UI, không build installer, không commit/push. Chưa chạy lại
  chuỗi thao tác Tauri/Illustrator hoặc smoke bộ cài đầy đủ; bằng chứng hiện
  tại là unit/integration + PDF artifact, không gọi là GUI runtime verified.

Binary staged đã dùng cho toàn bộ bằng chứng API2, SHA256:
`3d4bce1fc5b54694b40d6a0979e29a838a1002ccb361c1a722ef695c6341c4d6`.

Binary cài bằng maturin được build lại, SHA256
`9d02ca2929c594f85b242395fe1bd0eeab971839cc0cbb546485ec10267f4e33`.
Đã kiểm độc lập như trên, không suy chất lượng từ việc build thành công.
Backend đang mở cần khởi động lại để nạp extension mới; bộ cài đã phát hành
không được thay đổi bởi việc cài venv dev này.

`py_compile` và `git diff --check` đạt. Không thay Cargo.toml/lock, không
thêm dependency, không sửa worker/RAM gate, DPI, tolerance hay verifier.
