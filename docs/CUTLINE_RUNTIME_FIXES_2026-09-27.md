# Giảm thời gian Simplify của Bù xén – Tạo đường cắt

## Yêu cầu và phạm vi

Ngày 27/09/2026, người dùng báo thao tác Thực thi chậm sau nâng cấp và duyệt
“xử lý đi” sau chẩn đoán. Lô này sửa đúng lõi giảm node đã đo là điểm nghẽn,
không bỏ AUTO, không hạ chất lượng, không sửa Viewer/PPE hoặc thay worker pool.

Log thật 20:08–20:09: Binder2 13 trang, tạo CUT mọi trang mất 37,45 giây cả
response; trang 3 có `simplify_s=34.37` trên `total_s=35.91`. Pool đủ 13 worker,
queue 0 ms. Commit `bb139dd` đã bỏ AUTO-skip-fitted để bảo đảm preview=PDF;
bật lại skip đó sẽ tái tạo sai khác đường cắt, nên không dùng cách này.

Lượt VDP 123 trang với màu bù xén `inpaint` là vấn đề riêng: log các trang đã
kiểm có `simplify_s=0`. Lô này không tuyên bố giải quyết hoặc tăng tốc ca đó.

Baseline Git là `1c1c838`; giữ nguyên các thay đổi frontend/telemetry đang có
của người dùng. Chỉ sửa 2 file production, thêm 1 bộ test, 1 harness và báo cáo
này (5 file). Không build release, không stage/commit, không cập nhật golden.

## §CUT.QR — giảm kích thước hệ phương trình, giữ mọi mẫu

Profile riêng của nguồn trang 3: 39,95 giây có instrumentation; LSMR chiếm
27,87 giây, gọi nhân ma trận hơn 100.000 lượt. Không dùng số có profiler để
tính tỷ lệ tăng tốc. Mỗi cubic chỉ có 4 hàm Bernstein nhưng ma trận cũ mang
hàng nghìn hàng mẫu phụ thuộc tuyến tính vào từng lượt giải.

Thay đổi:

- `backend/app/workers/cutline_fair_jacobian.py`: `compress_fair_samples`
  dùng QR cho từng khối `[W·B, W·Y]`, gồm 4 cột Bernstein và 2 cột đích x/y.
  Nếu `A=QR` thì `||WB·P-WY||² = ||RB·P-RY||²`. Giữ cả phần sai số hằng
  ngoài không gian Bernstein, không làm thay đổi cost/ftol bằng cách bỏ nó.
  Mỗi khối còn tối đa 6 hàng do hạng đại số, **không phải cắt số mẫu hoặc
  hard-cap tài nguyên/chất lượng**. Không tạo normal equation JᵀJ để giải.
- Jacobian dùng cùng cơ sở QR; giữ API cũ cho caller/test không dùng nén.
- `backend/app/workers/cutline_fair_simplify.py`: chỉ đổi biểu diễn residual
  và Jacobian bên trong từng vòng đối ứng. Giữ nguồn, mẫu, trọng số, seed,
  thứ tự fallback, IRLS/Newton, ràng buộc góc, x_scale, ngưỡng hội tụ.
- Không đổi verifier liên tục, kiểm topology/lỗ/góc/độ cong và lượng tử writer.
  QR lỗi hoặc trả giá trị không hữu hạn thì giữ mọi hàng gốc của khối đó.
  Có checkpoint cancellation giữa các khối; không nuốt PreviewCancelled.
- Không thêm cache toàn cục, không đổi RAM gate, số worker, DPI hoặc màu.
  Memo cũ vẫn là kết quả được chứng nhận theo cùng hợp đồng hình học; không
  invalidate kết quả đã duyệt chỉ vì đổi cơ sở giải toán.

QR tương đương về đại số nhưng không hứa bit-identical trong số thực hữu hạn.
Các vòng lặp solver có thể khác một ít ở tọa độ; kết quả vẫn phải qua verifier
cũ. Vì thế kiểm cả PDF thật, không chỉ kiểm tốc độ/hàm chi phí.

## Đối chứng tốc độ

Harness: `scripts/benchmark_cutline_runtime.py`.
Artifacts: `.tmp/cutline-perf-20260927/`.

Nguồn `test/Binder2.pdf`, SHA-256
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`,
được hash trước/sau từng phép đo. Cấu hình cố định: 300 DPI, mode bleed,
bleed 2 mm, offset 0, góc preserve, tension 50, denoise 30, solid trắng,
remove_white_bg=false, AUTO và tolerance 0,1 mm, CUT tất cả trang.

Đây là benchmark backend lạnh không truyền memo/canonical preview, **không
phải tái hiện đầy đủ thao tác Tauri/setting đã lưu của người dùng**. Lượt core
capture dùng `_page_subset`; lượt full đi qua auto-detect alpha và process
pool thật. Không cộng hai kết quả hoặc coi chúng là cùng workload.

| Workload | Trước | Sau |
|---|---:|---:|
| Core nguồn trang 3, 1 luồng, không profiler | 36,177 s | 8,835 s |
| Đủ 13 trang, 13 worker, lượt 1 | 58,844 s | 18,002 s |
| Đủ 13 trang, 13 worker, lượt lặp | 58,664 s | 18,207 s |
| Đủ 13 trang, override 2 worker | 85,610 s | 32,108 s |

Hai lượt full mỗi phía chạy tuần tự, không benchmark đồng thời với test.
Trung bình 58,754 → 18,105 giây, giảm khoảng 69,2%, tương đương 3,25× trong
cấu hình này. Không hứa tỷ lệ cố định trên mọi PDF hoặc gọi đây là GUI latency.
Baseline lần lặp nạp hai module cũ từ Git vào process benchmark riêng, gồm cả
worker spawn; không rollback/chép đè source production để đo.

Cấu hình 2 worker nhanh hơn khoảng 2,67×; đây là giả lập hạn chế worker qua
env trong process benchmark, **không phải máy RAM 4/8 GB vật lý**. Tổng ngân
sách CPU do planner vẫn giữ nguyên. So riêng trước/sau cùng 2 worker; không
coi khác biệt giữa hai cách chia chunk là tác dụng của QR.

## Đối chứng chất lượng artifact

`artifact-check.json` đọc hai PDF full thật, kết quả:

- 13/13 trang giữ nguyên số lệnh CUT theo từng ring; không tăng node.
- 52 stream ảnh khớp byte; MediaBox/CropBox/TrimBox khớp toàn bộ.
- 13/13 trang artwork render PDFium 150 DPI khớp pixel khi ẩn riêng CUT trong
  bản sao bộ nhớ. Không sửa PDF trên đĩa, không dùng text extraction để suy
  ra màu/nội dung không đổi.
- 9 trang có tọa độ CUT khớp hoàn toàn; 4 trang có sai khác số thực nhỏ.
  Cận control-hull giữa hai bản lớn nhất 0,009565 mm ở trang 11; ba trang còn
  lại tối đa 0,000326 mm. Đây không phải cận sai số so với silhouette gốc.
- Metadata chứng nhận sau chạy full có cận so với baseline đường cắt tối đa
  0,099868 mm, dưới dung sai 0,1 mm giữ nguyên.
- Đã render và soi trang 3, 11 ở 200 DPI: artwork và đường CUT hiển thị bình
  thường; không chứng minh dao máy thật hoặc mọi tài liệu khác.

Core capture trang 3 giữ 121→57 đoạn; trước/sau có cùng cận
0,096921875 mm. Không dùng số 57 này thay cho số lệnh CUT của pipeline full,
vì đường vào capture/auto-detect alpha khác như đã ghi ở trên.

**Giới hạn không được che:** trong đối chứng 2 worker, trang 12 đổi 58→62
đoạn (nguồn 133 đoạn); cận so với nguồn giảm 0,096531→0,088328 mm. Các trang
khác giữ số đoạn. Kiểm lại hai đường PDF trang 12: đều simple, cận khoảng
cách liên tục giữa hai kết quả là 0,081763 mm (số đo mẫu 0,081434 mm).
Nghiệm solver có thể rơi sang seed khác dù cùng bài toán đại số; không tuyên
bố bit-identical hoặc số node luôn giữ nguyên trên mọi cấu hình. Các output
vẫn qua cùng gate 0,1 mm, topology/góc/độ cong, và preview=Execute được test.
`two-worker-artifact-check.json`: 52 stream ảnh, khổ trang và pixel artwork
13/13 trang khớp trước/sau. Không có đánh đổi DPI/chất lượng raster.
Lượt kiểm cuối `two-worker-artifact-check-final.json` giữ cùng kết quả; đã
soi cặp ảnh PDF trang 12 ở 200 DPI, gồm đường CUT thật, không thấy thay đổi
artwork hoặc đường gãy mới bằng quan sát ảnh.

## Test và giới hạn

- Bộ mới kiểm cost, Jᵀr và JᵀJ trước/sau đổi cơ sở; chỉ dùng JᵀJ làm oracle
  trong test, production không giải normal equation. Phủ ring 1/2/5/19 neo,
  thứ tự mẫu xáo trộn, hạng suy biến, trọng số 0, góc khóa, ít mẫu/không mẫu,
  sai phân Jacobian, QR lỗi và cancellation giữa các khối.
- Baseline test mới đỏ vì chưa có helper; sau tích hợp bộ hẹp 51 pass/1 skip.
- Bộ core/hình học/memo/AUTO/tuning: **351 pass, 3 skip**, 78,25 s.
  Không cộng bộ hẹp vào tổng vì trùng test. Ba skip là corpus artifact riêng
  không có sẵn, không phải bỏ qua test mới.
- Bộ tích hợp classic preview/AUTO-memo/PDF, cutline preview, job/cancel và
  parallel fallback: **127 pass**, 95,06 s; có ProcessPool Windows thật.
  Tổng hai bộ không trùng file: **478 pass, 3 skip, 0 fail**.
- `py_compile` cả hai module/test/harness và `git diff --check` phạm vi lô đạt.
  Không sửa frontend/Rust nên không chạy lại typecheck/Vitest/Cargo cho lô này.
- Còn các warning Pydantic/Starlette có sẵn. Không đổi snapshot/golden.
- Windows sandbox không cho tạo Pipe của ProcessPool; các benchmark full
  chạy qua quyền được duyệt. Lượt baseline đầu ghi log worker như engine cũ;
  harness sau đã chuyển log worker benchmark sang thư mục artifact riêng.
- Chưa nghiệm thu Tauri/WebView hoặc bộ cài; backend đang mở phải nạp source
  mới để người dùng kiểm lại. Không tự đóng/khởi động lại phiên làm việc.

Hash hai file production của lô:

- `cutline_fair_jacobian.py`: `917C661B02CAB5824C5CC8B5669A2880579C39C6221A14A1A61F161ADC971B72`
- `cutline_fair_simplify.py`: `15F5A98D0109A7CD1A6DDD8275CB7329BED29B17B32B276DF73594FD79BF2ACE`
