# Sửa nghẽn trong Presenter thật — 27/09/2026

## Kết quả và phạm vi

**V27.R7 đã sửa và đo A/B trên chính vòng Presenter, Refiner, GPU-credit và compositor với surface Win32 riêng luôn ẩn.** Không dùng benchmark gọi trực tiếp renderer để thay thế scheduler nữa. Chưa nghiệm thu scan-out/60fps trên cửa sổ người dùng.

Chỉ thay hành vi thực thi ở `desktop/src-tauri/src/viewport/presenter.rs`; thêm observer/historical A/B flags chỉ dưới `cfg(test)` và harness `presenter_runtime_tests.rs`. Không đổi ICC/PPE, shader, chất lượng, worker hoặc cache budget. Không điều khiển app của người dùng; test không ShowWindow/SetFocus/SetCapture và không gửi chuột/phím. Foreground giữ nguyên trong tất cả probe đã lưu.

## Nguyên nhân có bằng chứng runtime

Phiên21716/epoch1790468394136, EXE SHA `8d2711e16233492dd471ef6d48c86cec2a5445daa814ab8fe6b4ca1dbaeda9b0`, file Giấy mời chưa outline trên Desktop, trang1. [Snapshot/phân tích](audit/VIEWER_2026-09-27/presenter-live-before.json), [log có số dòng gốc](audit/VIEWER_2026-09-27/presenter-live-before.evidence.log).

Trong902ms không input mới, camera đứng yên nhưng có **359 resident presents**. CPU Presenter tốn764,814ms encode/submit +72,380ms gọi present +5,270ms acquire; Refiner chỉ83,368ms CPU trên thread khác. Cache tăng152→172 mảnh và vẫn miss trước input kế tiếp.

Nguyên nhân: mỗi batch refinement đặt `dirty=true` dù chỉ ghi vào texture **offscreen chưa đưa vào cache**. Thế là Presenter compositing/present lại ảnh cũ cho từng primitive. Việc cập nhật camera/overlay và commit refinement vốn đã có dirty riêng.

Nhưng chỉ xóa dirty là chưa đủ: `wgpu-core24.0.5/src/device/queue.rs` gọi `Device::maintain(Poll)` ngay trong `Queue::submit`. Các present thừa vô tình giúp poll callback. Khi bỏ chúng, `recv_timeout(1ms)` trở thành sàn thời gian thu hồi credit; bộ thích ứng lát2ms bị kẹt batch1. Phải sửa cặp cơ chế, không vá một nửa.

Không dùng `Maintain::WaitForSubmissionIndex` trên thread khác để “giải phóng UI”: source wgpu giữ fence read-lock khi wait, trong khi queue submit cần write-lock, có thể chặn lại camera.

## Thay đổi đã áp dụng

1. Không đặt dirty cho batch offscreen. Vẫn present khi camera/overlay thay đổi hoặc một refinement đã commit.
2. Khi còn GPU credit đang chờ: poll không chặn, consume wake và `yield_now()` nhường scheduler. Khi idle: vẫn đợi event, không spin nền.
3. Kiểm lỗi device trước pending submit và trước early-exit `!dirty`. Khi lỗi, hủy pending, ACK, bỏ credit, báo fallback; không chờ một input mới và không spin trên credit chết.
4. Nhánh `legacy` và `candidate` chỉ tồn tại trong binary test. App không có setting/env để vô tình bật lại chúng.

## A/B có kiểm soát, không bỏ qua kết quả xấu

Probe đầu có cadence sleep tương đối và chạy gần các đợt rustc: bỏ dirty làm31→2 presents ở camera tĩnh nhưng thời gian1193→1862ms; **không chấp nhận kết quả này là cải thiện**. Các artifact `presenter-before/after` vẫn được giữ.

Sau đó dùng cùng binary cho6 lượt xen kẽ, đợi rustc/link kết thúc tự nhiên, không dừng process nào. Phát120 camera liên tục theo deadline tuyệt đối16,667ms, tổng input~1983,5–1983,9ms, không đợi camera trước nét rồi mới gửi camera sau. Observer nằm trong loop production, đo CPU thread bằng `GetThreadTimes`. `settle` tính từ request cuối tới camera mới nhất hoàn tất, không còn pending/refine credit và đã present, sau đó chốt fence. **Không phải scan-out.**

| Nhánh, file Desktop | Dựng camera tĩnh đầu sau prepare | Chờ đủ nét sau request cuối | Tổng resident presents | CPU Presenter |
|---|---:|---:|---:|---:|
| Legacy, N2 | 1023,961–1029,337ms | 814,425–889,025ms | 1140–1173 | 1421,875–1687,500ms |
| Chỉ bỏ dirty, N2 — không chọn | 1655,688–1748,242ms | 525,828–699,995ms | 161–166 | 250,000–359,375ms |
| Bỏ dirty + cooperative poll, N2 | **429,972–444,116ms** | **174,542–174,655ms** | **206–209** | **1078,125–1125,000ms** |

Batch median: legacy/candidate1; cooperative4. Chờ credit cộng dồn: candidate3025–3271ms, cooperative5,9–9,8ms; phần còn lại là xử lý/poll/yield, không được coi là GPU-time thuần.

## Xác minh cuối trên hai PDF, cùng binary có SHA

SHA test binary `264cef1273e6984e54620b0af05543658efda5128a1a62de67dc8cdee06a8abb`; mỗi cặp dưới chạy cùng binary, cùng lịch camera, cùng input SHA.

| File trang1 | Chờ nét cuối legacy→mới | Camera tĩnh đầu legacy→mới | Presents legacy→mới |
|---|---:|---:|---:|
| Desktop chưa outline, SHA95f38c… | **706,530→263,361ms** | 886,515→423,733ms | 808→203 |
| Fixture outline user đưa, SHAe657ea… | **546,812→374,774ms** | 938,237→426,052ms | 665→201 |

Các mẫu cuối có dao động so với N2 trước; không chọn riêng174ms làm bảo đảm. CPU Desktop1234,375→1218,750ms; outline906,250→1093,750ms: có trade-off dùng CPU tích cực hơn để hoàn tất sớm, không hứa tiết kiệm CPU trên mọi PDF. Máy hiện tại32GiB/i5-13400/RTX3060; timing máy<16GiB chưa đo.

[JSON/hash kết quả và source](audit/VIEWER_2026-09-27/presenter-fix-results.json), [script tổng hợp](audit/VIEWER_2026-09-27/summarize_presenter_fix.py). Timing camera đầu **không gồm parse/compile scene và chuẩn bị renderer**, không được trình bày như thời gian mở file đầu-cuối.

## Verify và giới hạn

- Legacy probe đỏ đúng assertion: camera không đổi nhưng present nhiều hơn số commit. Cooperative xanh;150ms idle không tăng presents/refinements.
- Lỗi validation tạo trên buffer của context test khi idle đã được báo mà không cần request mới; không mô phỏng reset GPU vật lý hoặc chạm context app đang dùng.
-57 viewport tests đạt,7 ignored; probe Presenter ignored đã chạy riêng nhiều lượt. `cargo check --offline --lib --examples` đạt. Không đổi snapshot, frontend/backend, không build release/commit/push.
- Không triển khai thêm gom ROI hoặc coalesce React trong lượt này. Fragmentation vẫn có thể tốn nhiều lượt; FE mirror còn fan-out, nhưng log mới không chứng minh hide/show hoặc zoom echo là nguyên nhân chính. Tách các việc đó khỏi A/B R7.
- Phiên runtime mới xác nhận R5 pan không bị tool reset cắt ngang; không có thao tác chuyển trang để xác nhận R6 runtime. Cải thiện R7 trên owned surface không thay thế nghiệm thu toàn Viewer/Acrobat.
