# Triển khai sửa PDF Viewer — 27/09/2026

> **CẬP NHẬT SAU VÁ HỒI QUY:** R1–R4 đã xử lý: coverage ROI nguyên, giữ đúng extent cache, policy tiến triển→full PPE recovery→idle, mask theo ROI và scissor compositor. 54 viewport +49 GPU +53 worker tests đạt; hai PDF thật mỗi ca32 camera/3.840 kiểm idle, ROI không khác byte. Mức SOURCE + AUTO + ARTIFACT, **chưa nghiệm thu scan-out/60fps**. Xem [nhật ký sửa hồi quy](PDF_VIEWER_CACHE_HOI_QUY_FIXES_2026-09-27.md).

> **Lịch sử chẩn đoán hồi quy ngày 27/09: nghiệm thu convergence/độ mượt lô D từng là OPEN/STALE.** Log host17540 và probe trực tiếp source xác nhận khe thiếu giả do `f32`, crop nhỏ cùng matrix xóa frame lớn, gây refinement lặp khi đã đứng yên. Test pixel cũ vẫn có giá trị hẹp nhưng không kiểm scheduler + cache hoàn tất. Xem [baseline hồi quy](BAO_CAO_AUDIT_VIEWER_CACHE_HOI_QUY_2026-09-27.md); trạng thái sau sửa ở cập nhật phía trên.

Người dùng duyệt toàn bộ kế hoạch trong `BAO_CAO_AUDIT_PDF_VIEWER_60FPS_2026-09-27.md`, không hỏi duyệt lại. Chỉ kiểm thử bằng code theo yêu cầu tiếp theo; không điều khiển/restart cửa sổ PrynX. Không commit/push/phát hành. Các thay đổi đã có trong worktree được giữ nguyên.

## Tiến độ và chốt verify

| Lô | Trạng thái | Bằng chứng/việc còn lại |
|---|---|---|
| A — nối frame mồi | SOURCE + AUTO đạt | 81 tests/3 file và typecheck đạt; caller lấy path của file hiện hành; prop nguồn bắt buộc ở biên public |
| B1 — phase/lock telemetry | SOURCE + AUTO đạt | cargo check đạt; 2 scene protocol tests đạt, 1 worker-runtime ignored có khai báo. Trailer opt-in tương thích probe cũ; phase con qua process có chồng lấp, không cộng như CPU thuần |
| B2 — input/logging | SOURCE + AUTO đạt | cargo check đạt; async writer/flush test và left+middle input test đạt; timestamp trước khóa, queue coalescing; chưa A/B overhead binary mới |
| B3 — GPU/display collector | SOURCE + AUTO/GPU đạt | Frame timestamp opt-in, đọc16byte; upload probe riêng đo4,17–4,18ms/ảnh4042×2696. Probe staging tăng CPU~91ms nên KHÔNG là đường mặc định; PRYNX_GPU_UPLOAD_PROBE phải bật riêng. Không giả scan-out |
| C1 — proof provenance | SOURCE + AUTO đạt | C1a 58 tests; C1b 123 tests + typecheck. Requirement xuyên layer kiểm trước cache/decode/swap; negative missing/PDFium/stale và positive PPE qua canvas đạt |
| C2 — handoff/producer | SOURCE + AUTO đạt | Giữ bitmap; nếu native ready trước nền thì cho một target nền cố định hoàn tất, không chạy theo wheel; chỉ pause khi đã có fallback/prime proof. Reset theo token/profile; metadata gate native/prime; 108 tests bổ sung đạt |
| C3 — native PPE detail/proof | SOURCE + AUTO đạt | Typed-proof native regression đạt; 42 hook/container tests + typecheck; strict surface ACK và false-after-true; geometry-only visibility test giữ nguyên |
| D1 — cache vùng/byte | SOURCE + AUTO/ROI đạt | 6 cache tests + cargo check; vùng thiếu + gutter/crop GPU; 12 ROI ở3camera PDF thật bằng đúng pixel full frame, partial chờ union đủ |
| D2 — coverage/clip | SOURCE + AUTO + ARTIFACT đạt | 6 ảnh toàn trang/zoom trước–sau trùng byte; 12 ROI parity; packing scalar và5 GPU tests đạt. Warm debug encode toàn trang792–809→382–391ms, zoom673–770→262–295ms; không suy FPS UI |
| E — camera/layout | SOURCE + AUTO đạt | 43 tests + typecheck/cargo check; idle20 rAF không đọc layout; camera trùng không gọi callback; scope chuyển scene riêng |
| F — recovery/teardown | SOURCE + AUTO + worker/GPU artifact đạt | 47 native headless tests và53 worker tests đạt; thêm4 probe worker/refiner thật. Close retire nền, proof-invalid ẩn HWND không đợi JS; guard sequence+revision; thu cache đúng GPU epoch, giữ parser CPU |

Mỗi lô source/test ≤5 file. Các kết quả GUI/Acrobat/scan-out không được suy ra từ unit test. Số đo trước sửa giữ nguyên trong thư mục audit; số đo sau dùng output riêng.

## Kết quả chốt

Đã triển khai các lô A, B1–B3, C1–C3, D1–D2, E, F ở **mã nguồn + kiểm thử tự động + artifact headless**. Không coi đây là chứng nhận 60fps màn hình, bản cài đặt hoặc tương đương Acrobat. Theo yêu cầu người dùng, không điều khiển cửa sổ và không chủ động khởi động lại PrynX.

### Kiểm chứng cuối

- Frontend: **340 file / 3.899 passed / 2 skipped**; lần cuối chỉ bổ sung trường telemetry được kiểm lại bằng 82 test hẹp. Typecheck đạt.
- Native viewport: **47 passed / 5 ignored** ở suite mặc định. Loại riêng 9 test HWND/visibility/hit-test khỏi lượt chạy vì chỉ kiểm headless.
- Worker/protocol: **53 passed / 9 ignored**. Writer nền/flush thêm **1 test đạt**.
- Bốn probe native bị ignored mặc định đã chạy riêng bằng worker/headless thật và đạt: scene cache/revision, hủy scene worker rồi phục hồi, RGB PPE fallback với pan/crop/rotation/late GPU failure, 120 camera đồng thời với refinement. Probe cuối hoàn tất 35 refinement và kiểm pixel camera cuối; không lấy 120/tổng thời gian làm FPS màn hình.
- Toàn bộ `viewer_gpu`: **46 passed / 5 ignored**. Đã chạy riêng timestamp GPU, benchmark PDF và ROI parity trong các test opt-in. Swatch/enum tests có tên “Acrobat” không được dùng làm golden Acrobat.
- `cargo check` lib/examples đạt; build worker kiểm thử riêng đạt. Không build/cài installer, không sửa Cargo release/LTO, không commit/push, không đổi snapshot để làm test xanh.

### Số đo trên đúng PDF outline, trang 1

Nguồn: `audit/VIEWER_2026-09-27/fixes-results.json` và các JSON/CSV được dẫn ở đó. Input SHA giữ nguyên `e657eab1…ce06dd1`. Máy i5-13400 / 32 GiB / RTX3060, kernel theo cấu hình Cargo dev của desktop (`print_engine` và `viewer_gpu` opt-level=3), raster 998×748.

| Phép đo | N | Kết quả |
|---|---:|---|
| Dựng full frame warm, camera thay đổi | 10 | **29,650–32,021 ms**, P50 31,335 ms |
| Dựng vùng thiếu warm, camera thay đổi | 10 | **19,261–22,407 ms**, P50 20,877 ms |
| Frame đầu, sau scene/GPU/resources setup | 1 | **311,158 ms**; không gọi là FSP đầu-cuối |
| Scene cache load trang1 mới | 1 | **544,955 ms** |
| Scene cache quay lại trang1 | 2 | **0,480–0,521 ms**; không parse/compile lại |
| PPE CPU 96 DPI, process/session mới | 3 | **662,260–687,266 ms** |
| PPE CPU 96 DPI, session warm | 6 | **352,122–368,074 ms** |

Đây là thời gian tạo texture/worker trả ảnh, **không phải input→display**. CPU PPE vẫn mất hàng trăm ms; giải pháp mượt là giữ frame resident, chỉ dựng vùng thiếu và không để producer ẩn tranh tài nguyên. Trang2 nhiều mask trong probe mở rộng vẫn có first-frame kernel khoảng 1,217 s; chưa tuyên bố mọi trang/file nặng mở tức thì.

So sánh D2 trong cùng harness debug chưa tối ưu: encode warm toàn trang 792–809→382–391 ms; vùng zoom 673–770→262–295 ms. Không lấy các số này so trực tiếp với kernel opt-level=3 hoặc FPS ứng dụng. CSV/ảnh trước–sau được giữ; không dùng phép thử nhỏ này để chứng nhận SLA P99.

### Màu và pixel

- **6 cặp ảnh full/zoom trước–sau trùng từng byte**.
- **12 ROI trên 3 camera của PDF thật** trùng pixel với frame đầy đủ; thêm các ca hairline, dash, clip và group non-isolated qua GPU.
- 9 PNG PPE sau sửa cùng hash `1ab7fe75…0c4fffe9b`, trùng baseline.
- Frame GPU đầu ở binary tối ưu cuối có hash `7f4e2729…521834e`, trùng artifact GPU trước sửa.
- Đã khóa provenance engine/token/page/profile/intent/proof qua cache/compositor. Trong yêu cầu accurate, unsupported **không tự chuyển PDFium**; giữ frame proof đã có và báo lỗi. Đây là thay đổi policy đã duyệt, không phải coi unsupported là đã render đúng.
- Pixel equality ở đây là trước/sau bản vá hoặc ROI/full cùng engine. Không biến nó thành khẳng định GPU và PPE CPU trùng từng byte, hay chứng nhận màu trên monitor/Acrobat. Minification/mip policy đang có không bị đổi để lấy tốc độ.

### Telemetry và observer overhead

- `PRYNX_PERF=1`: log compact theo phase/input/frame, writer nền; timestamp là lúc phát event. `producer_enabled`, `fallback_proof_ready`, `native_gpu_presented` phân biệt giữ bitmap với sinh request.
- `PRYNX_GPU_TIMING=1`: query GPU opt-in, readback **16 byte**, không readback framebuffer trên đường present.
- `PRYNX_GPU_DIAGNOSTICS=1`: chỉ bật khi cần dump ma trận/cache chi tiết; mặc định không format toàn bộ danh sách texture trên mỗi camera.
- `PRYNX_GPU_UPLOAD_PROBE=1`: probe transfer dùng staging tường minh, phải bật cùng GPU timing. Đo khoảng **4,17–4,18 ms** cho mỗi upload 4042×2696×2 layer. Nó làm material CPU tăng khoảng 91 ms ở phép thử, nên đã được **loại khỏi đường mặc định**. Thư mục `optimized-gpu-final/` giữ thử nghiệm có overhead này; số chốt production-default ở `optimized-gpu-default-final/`, `upload_probe_enabled=false`.
- Đường mặc định đo lại first-frame khoảng311 ms so với308 ms trước thử staging, không giữ mức374 ms của probe. N=1 nên không tuyên bố khác biệt nhỏ có ý nghĩa thống kê.
- Refinement dùng credit completion GPU và batch thích ứng để tránh submit cả trang lấp queue; không chặn presenter bằng `Maintain::Wait`, không cắt primitive hay giảm DPI.

### Giới hạn và lỗi môi trường đã xử lý

- DLL của app đang chạy từng chặn build (`os error 32`): chuyển sang `.tmp/viewer-v27-target`, không đóng app.
- Probe RGB fallback chạy từ repo root ban đầu không tìm DLL (`126`): chạy lại đúng cwd `desktop/src-tauri`, đạt; không cài hoặc thay DLL.
- jsdom báo `getContext` chưa triển khai trong ca kiểm fallback cũ; assertion suite vẫn đạt, không che diagnostic này.
- Chỉ có phần cứng32GiB thực; các ngưỡng4/8/12/16/32GiB và pressure được kiểm bằng policy tests, không gọi là đo trên máy yếu thật.
- Không đo scan-out/GUI/Acrobat/installer do phạm vi kiểm bằng code. Không coi cửa sổ PrynX đang mở là bản runtime đã nghiệm thu. Kết quả này không bao gồm phát hành.
