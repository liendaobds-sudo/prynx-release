# R25.GPU.33 — Chuyển trang GPU giật, hiện “Đang dựng hình…”

Phạm vi là tiếp tục sửa hồi quy user báo trong nâng cấp đã được yêu cầu. Không coi R32 đã giải quyết tốc độ trang.

## Bằng chứng

- Log runtime sau R32: page=2 cache hit 92.835 ms, scene-ready 93 ms; first overview ready 12.938 s, encode 8.927 s; first-present 12.959 s. Cache scene không giải quyết chi phí vẽ lại trang.
- Benchmark R01 trang 2, 1309×885, cùng renderer hiện hành, release RTX 3060/Vulkan: 492 mask, 1138 draw, coverage_bytes=2,371,529,036; clip_pixels=1,265,043,780; encode=3.545 s. Bằng chứng `.tmp/gpu-page-latency-2026-09-25/baseline.log`, ảnh RGBA đi cùng.
- `RetainedRenderer` cấp mask/clip/group theo kích thước cả viewport. Primitive ảnh nhỏ vẫn đóng gói clip cả frame. Chi phí tỷ lệ số mask × diện tích màn hình.
- `AcrobatViewer` key viewport theo trang; close chạy `destroy` trên UI, `Presenter::Drop` join presenter, presenter drop/join refiner đang encode. Encode GPU chưa kiểm hủy giữa primitive, có thể giữ UI chờ scene cũ.

## Các lô

1. Renderer: chỉ lưu/upload vùng clip có hiệu lực, hợp vùng cần mask của mọi invocation, giảm vùng dispatch ảnh/shading; raster giữ nguyên tọa độ toàn frame. Clip trùng hình học và cùng parent được dùng lại sau so sánh đầy đủ. Không giảm độ nét hoặc giới hạn tài nguyên theo máy.
2. Native: hủy tác vụ lỗi thời trong lúc encode, không trả lỗi renderer khi user đổi trang; kiểm đường đóng viewport thật đang render.
3. Viewer: giữ lease qua đổi trang nếu hợp đồng lifecycle cho phép, từ chối camera/input/status trang cũ và không để trang cũ nhận tương tác trang mới. Kiểm DOM + native trước áp dụng.

Mỗi lô tối đa 5 source/test file, verify trước lô tiếp. Chuẩn bị staging khi dev còn mở. Chỉ áp dụng Rust sau khi user lưu/dừng dev. Chưa nghiệm thu runtime hoặc khẳng định hết giật từ unit test.

## Kết quả đã kiểm chứng trước áp dụng

- Thử nghiệm chia ô đã bị loại: nhanh hơn nhưng thay đổi AA tại một số biên. Không có code chia ô/ICC đổi tọa độ trong bản chuẩn bị áp dụng.
- So sánh cuối dùng package ID riêng cho bản tham chiếu và bản sửa, tránh reuse artifact khi hai checkout cùng target-dir. Trên R01 trang 2, 1309×885: frame 5.817 s → 1.339 s, encode 3.774 s → 0.874 s; coverage 2,371,529,036 → 14,622,536 byte. Cùng số draw/group/mask (1138/34/492), không bỏ đối tượng.
- Bốn cặp ảnh (trang 1 và 2, toàn trang và zoom/pan) trùng từng byte; hash ghi trong `pixel-proof.json`.
- Native HWND thật, bản dev có kernel GPU opt-level=3: page 2 load/prepare lần đầu 1.231 s + present 1.911 s; quay lại load 1.522 ms + present 29.077 ms; hủy viewport có tác vụ đang chạy 37.041 ms. Bản trước khi tối ưu profile tương ứng present 2.265 s / 29.936 ms; hủy 211.157 ms. Không gộp các số này với benchmark release riêng renderer.
- 42 test GPU mặc định đạt (3 benchmark/case local ignored); 38 test native đạt, gồm benchmark HWND R01 vừa nêu; 50 test frontend và typecheck đạt. Native không chạy lại ba benchmark worker/zoom cũ và case RGB worker riêng trong lô này.
- Frontend giữ lease khi đổi trang. Camera và ACK hiển thị cũ bị loại theo revision; có regression cho cache first-present tới trước rAF hide, tránh HWND bị ẩn mãi. Chỉ remount lớp tương tác theo trang để không giữ selection cũ.
- Khung overview chỉ vào cache sau submit hoàn tất, sống cùng PreparedScene (identity/token/page/GPU/format); dùng lại chính cơ chế bỏ cache khi áp lực RAM/VRAM hoặc đóng document đã có ở R31. Không giới hạn số trang cố định.
- Vòng vẽ kiểm hủy giữa primitive/clip; hủy không chốt fallback PPE. Khi overview đủ mật độ pixel cho zoom hiện tại, pan/fit dùng nó trực tiếp, không dựng detail trùng chất lượng.

Bộ bằng chứng: `.tmp/gpu-page-latency-2026-09-25/`: `runtime-before.log`, `page2-reference-final.log`, `page2-candidate-final.log`, `native-optimized-tests.log`, `gpu-final-tests.log`, `frontend-final-tests.log`, `typecheck-final.log`, `pixel-proof.json`, `changes.patch`, `manifest.json`, `ready/`, `before/`.

## Áp dụng

User đã xác nhận lưu công việc và dừng run_dev. Đã áp dụng 15 source/test/config file, đối chiếu SHA256 với `ready/` và giữ bản trước trong `before/`. 50 test frontend và typecheck chạy lại trên source thực tế đều đạt. Build executable dev thành công trong 4 phút 33 giây, 17 cảnh báo dead-code, không có lỗi build. Hồ sơ cuối ghi tại `verification.json`.

Executable `desktop/src-tauri/target/debug/pdf-inspector.exe` hoàn tất lúc 16:08:07 ngày 25/09/2026 (UTC+7), 39.772.672 byte, SHA256 `43465e1f51b99b885a2b252b93004e2d8797cce3844c16d6d4295dedd5264bcc`. Sau build đã kiểm lại hash đủ 15 file áp dụng và bốn cặp ảnh. Native benchmark trước áp dụng dùng presenter/renderer mới trong test harness và executable worker cũ với protocol/parser không đổi; chưa chạy thao tác user với executable mới.

ESLint phạm vi frontend còn 3 lỗi và 2 cảnh báo; đối chiếu bản trước áp dụng cho cùng kết quả (global test harness, set-state-in-effect, cleanup ref). Không coi lint toàn phạm vi là đạt; xem `lint-before.log` và `lint.log`.

Chưa chạy lại thao tác user trong cửa sổ Tauri/WebView2. Lần đầu trang nặng vẫn có thời gian parse/prepare/render; chưa tuyên bố ngang Acrobat.
