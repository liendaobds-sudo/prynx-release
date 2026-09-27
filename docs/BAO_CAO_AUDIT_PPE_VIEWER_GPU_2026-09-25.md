# Review bản triển khai PPE Viewer GPU — 25/09/2026

> Sau khi người dùng duyệt “xử lý hết”, các bản sửa và kết quả kiểm chứng được
> ghi tại [PPE_VIEWER_GPU_FIXES_2026-09-25.md](PPE_VIEWER_GPU_FIXES_2026-09-25.md).
> Nội dung bên dưới là baseline review trước sửa; không dùng trạng thái cũ để
> suy các lỗi pixel vẫn còn, hoặc suy toàn bộ renderer đã hoàn thành.

## 1. Kết luận

**Chưa đủ điều kiện nghiệm thu G0–G4 hoặc chuyển Viewer mới vào sử dụng.** Có các module và pipeline GPU chạy được ở mức thử nghiệm, nhưng đường PDF thật → scene → graph → GPU → native present chưa được nối. Một số phần quyết định tính đúng còn là placeholder hoặc có lỗi đã tái hiện.

Trong lượt review này, **5/5 ca đối chứng độc lập thất bại**, gồm 2 ca compiler/CPU và 3 ca shader chạy trên NVIDIA GeForce RTX 3060. Bốn test CPU parity hiện có vẫn pass; TypeScript typecheck pass. Test xanh hiện tại không bao phủ các hợp đồng quan trọng bị hỏng.

Không có bằng chứng trang 1 R01 đã được render bằng renderer mới nhanh hơn baseline 330 ms. Số 1,627 ms trong sổ tiến độ thuộc cảnh tổng hợp, không phải cùng tác vụ PDF. Không có đối chiếu artifact Acrobat trong bài test mang tên Acrobat parity.

Đây là review; **không sửa source ứng dụng, không khởi động/đóng PrynX, không sửa sổ tiến độ hoặc báo cáo cũ của người dùng**. Probe riêng và log ở `.tmp/review-ppe-gpu-2026-09-25/`; tài liệu này ghi kết quả phản biện để quyết định đợt sửa.

## 2. Phạm vi và provenance

- Repository: `D:\pdfcompare`.
- HEAD: `bb139dde242804fb44d0514f2c6688bbd686e13a`.
- Change set: thay đổi working tree và file mới của GPU Viewer trên HEAD này; không chỉ `git diff` vì phần lớn module chưa tracked.
- Đối chiếu: [kế hoạch triển khai](KE_HOACH_TRIEN_KHAI_PPE_VIEWER_GPU_2026-09-25.md), [quyết định kiến trúc](QUYET_DINH_KIEN_TRUC_PPE_VIEWER_DAI_HAN_2026-09-25.md), schema, [sổ tiến độ của bản triển khai](PPE_VIEWER_GPU_TIENDO_2026-09-25.md), threat model tại `docs/audit/PRYNX_THREAT_MODEL.md`.
- Đã truy vết: consumer React và settings; Tauri commands/Win32 host/controller/scheduler; scene compiler/graph/CPU replay; shader và pipeline GPU; capability/resource pool; benchmark, acceptance và các bài kiểm liên quan.
- Manifest 61 file của phạm vi chính: [source-manifest.json](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/source-manifest.json). Đây là danh sách định danh source được đối chiếu, không có nghĩa tất cả dòng mọi test đã được review sâu.
- Không review toàn bộ sản phẩm, không kiểm bản installer, không có phép đo zoom UI hoặc so Acrobat mới trong lượt này. Không xem fixture/mock/probe Python là bằng chứng native runtime.

Mức bằng chứng: **[TÁI HIỆN]** = chạy probe cục bộ vào code hiện tại; **[TĨNH]** = xác định từ source/call graph/hợp đồng API; **[THIẾU CHỨNG CỨ]** = claim nghiệm thu chưa có bài kiểm tương ứng. Các finding dưới có trạng thái **Accepted, chưa sửa**, không tự chuyển thành Verified/Closed.

## 3. Danh sách phát hiện

P1 ở đây là lỗi/chỗ thiếu phải xử lý trước khi nghiệm thu hoặc nối renderer mới; không có nghĩa mọi lỗi đang xảy ra trên Viewer cũ. P2 là lỗi tích hợp cần sửa trước cutover. Tổng: **10 P1, 3 P2**.

| ID | Mức | Phát hiện | Bằng chứng | Công sửa sơ bộ |
|---|---|---|---|---|
| R25.GPU.01 | P1 | Chưa có đường render PDF thật vào viewport mới | Tĩnh | L |
| R25.GPU.02 | P1 | Compiler làm mất text và không phân giải XObject/state thật | Tái hiện + tĩnh | L |
| R25.GPU.03 | P1 | CPU replay bỏ clip và bỏ nhiều pass nhưng vẫn trả thành công | Tái hiện | L |
| R25.GPU.04 | P1 | K bị dùng làm alpha trong fixed-function blending | Tái hiện GPU | L |
| R25.GPU.05 | P1 | Mask đã trích luminosity bị diễn giải lần hai thành CMYK | Tái hiện GPU | M |
| R25.GPU.06 | P1 | Image shader bỏ qua alpha của ảnh RGB | Tái hiện GPU | M |
| R25.GPU.07 | P1 | Proof/overprint/ICC contract chưa được triển khai đúng | Tĩnh | L |
| R25.GPU.08 | P1 | HWND tạo/hủy trong async task, thiếu ownership thread và khởi tạo surface | Tĩnh | M–L |
| R25.GPU.09 | P1 | Một viewport toàn process làm các tab/cửa sổ tác động lẫn nhau | Tĩnh | M |
| R25.GPU.10 | P1 | Acceptance cho pass từ cảnh mô phỏng và kiểm tra không đo yêu cầu | Tĩnh | L |
| R25.GPU.11 | P2 | Schema camera Rust và TypeScript khác tên trường | Tĩnh | S |
| R25.GPU.12 | P2 | CSS pixel chuyển thẳng thành kích thước HWND physical | Tĩnh | M |
| R25.GPU.13 | P2 | Open bất đồng bộ có thể sống sau unmount hoặc mở trùng | Tĩnh | M |

### R25.GPU.01 — Chưa nối Viewer hiện hành với renderer mới

**Vị trí:** [NativeGpuViewportContainer.tsx:20](/D:/pdfcompare/desktop/src/components/acrobat/NativeGpuViewportContainer.tsx:20), [appSettingsStore.ts:328](/D:/pdfcompare/desktop/src/stores/appSettingsStore.ts:328), [win32_host.rs:408](/D:/pdfcompare/desktop/src-tauri/src/viewport/win32_host.rs:408), [hybrid_executor.rs:36](/D:/pdfcompare/viewer_gpu/src/hybrid_executor.rs:36).

Tìm toàn bộ `desktop/src` cho thấy component chỉ có định nghĩa/export, chưa có consumer mount; `nativeGpuViewportEnabled` chỉ được khai báo/khởi tạo/set trong store. Viewer hiện hành vẫn gọi `useTileRenderer`/`LivePageFrame`. Các command native mới chỉ nhận geometry/camera, không nhận document/page/scene/resource.

`render_viewport_frame` chỉ clear màu xám rồi `present()`, không thực thi scene, graph hay image của PDF. `viewer_gpu` không phụ thuộc `print_engine`; `HybridGraphExecutor` hiện là tập hàm gọi pass bằng tham số thủ công, chưa có adapter đi từ `RenderGraph`/resource thật vào executor. Không thấy scene compiler được gọi từ worker/session hiện hành.

**Tác động:** mở/zoom PDF trong ứng dụng không đi qua pipeline vừa thêm. Chỉ mount component hiện tại sẽ không tạo ra ảnh PDF. Cờ `true` không chứng minh đã bật GPU Viewer.

**Đề xuất:** hoàn thiện một lát cắt PDF → scene/graph → CPU/GPU → viewport trong build thử nghiệm, có document revision và log pixel producer. Chưa bật đường này cho Viewer mặc định trước khi các lỗi tính đúng bên dưới được xử lý.

### R25.GPU.02 — SceneCompiler vẫn sinh dữ liệu giữ chỗ

**Vị trí:** [compiler.rs:419](/D:/pdfcompare/print_engine/src/scene/compiler.rs:419), cùng file tại 437–457, 346–366 và 471.

Với `Tj/TJ`, compiler sinh `font_name="DefaultFont"`, `font_size=12`, `text=""`; không đọc payload chữ hoặc trạng thái `Tf/Tm/Td`. Với mọi `Do`, compiler sinh `SceneImage` 1×1 theo tên resource, chưa phân biệt Form/Image và chưa đọc nội dung/tài nguyên lồng. Các operator chưa xử lý bị bỏ qua ở `_ => {}`. `q/Q` bị biểu diễn thành group; đó chưa phải phân giải transparency group từ tài nguyên PDF.

**Tái hiện:** stream `BT /F1 24 Tf 10 20 Td (Hello) Tj ET` trả scene có chữ rỗng, font DefaultFont, cỡ 12. Probe `scene_preserves_actual_text` fail.

**Tác động:** scene thiếu dữ liệu để tạo nội dung thật, đặc biệt với Form lồng và tài nguyên của R01. Số command >0 hoặc camera không sửa scene không chứng minh G1 đạt.

**Đề xuất:** compiler dùng resource/state resolution của PPE, bảo toàn text/glyph và scope từng invocation. Operator chưa hỗ trợ phải tạo capability/fallback có semantics đầy đủ hoặc trả lỗi có định danh; không thành công với nội dung đã mất.

### R25.GPU.03 — CPU replay chưa là đường tham chiếu hoặc fallback đúng

**Vị trí:** [replay.rs:79](/D:/pdfcompare/print_engine/src/cpu_scene/replay.rs:79), cùng file tại 98–115; [builder.rs:168](/D:/pdfcompare/print_engine/src/render_graph/builder.rs:168).

`clip_mask` luôn `None`. Nhánh Text/Image/Shading/GroupBlend/SoftMask không làm gì, rồi hàm vẫn trả `Ok(buffer)`. Builder biểu diễn clip thành SoftMaskPass, nhưng pass không có clip path đủ để replay và không được thực thi.

**Tái hiện:** cùng một PDF tối giản với clip rectangle 20×20 rồi fill trang 100×100. Interpreter PPE hiện có tô **400 pixel Cyan**; scene/CPU replay tô **10.000 pixel Cyan**. Probe `cpu_replay_preserves_clip` fail.

**Tác động:** nội dung tràn khỏi clip, mất chữ/ảnh/shading hoặc sai group nếu dùng CPU path mới để fallback/đối chiếu. Hiện chưa có cơ sở cho tuyên bố parity G1 đầy đủ.

**Đề xuất:** triển khai từng pass bằng kernel PPE với state/clip/dependency thật; phần chưa hỗ trợ phải từ chối rõ hoặc fallback đúng toàn đơn vị phụ thuộc. Bổ sung golden có clip, image, text và nested group, không chỉ hình tô phẳng.

### R25.GPU.04 — Format CMYK bị trộn với alpha của GPU

**Vị trí:** [path_raster.rs:136](/D:/pdfcompare/viewer_gpu/src/path_raster.rs:136), [path_raster.wgsl:73](/D:/pdfcompare/viewer_gpu/src/shaders/path_raster.wgsl:73), [soft_mask.wgsl:50](/D:/pdfcompare/viewer_gpu/src/shaders/soft_mask.wgsl:50).

Texture RGBA16F lưu C/M/Y/K; shader trả `K × coverage` ở thành phần thứ tư. Pipeline lại dùng `OneMinusSrcAlpha`, nên GPU coi lượng mực K là độ trong suốt. Khi K=0, nền không bị loại dù đối tượng phủ kín, alpha=1. Tương tự Alpha soft mask đọc `src.a` nhưng trong format CMYK đó là K.

**Tái hiện GPU:** vẽ Magenta đặc rồi Cyan đặc đè toàn vùng, không overprint. Kỳ vọng Cyan `[0,255,255,255]`; thực tế **Blue `[0,0,255,255]`**. Probe `opaque_cyan_replaces_magenta_without_overprint` fail.

**Đề xuất:** tách ink channels khỏi alpha/shape/coverage trong storage và định nghĩa rõ compositing. Không sửa riêng một công thức RGB để che hậu quả; nền tảng surface format này ảnh hưởng path, image, group, SMask và overprint.

### R25.GPU.05 — Luminosity mask bị tính hai lần

**Vị trí:** [soft_mask.wgsl:57](/D:/pdfcompare/viewer_gpu/src/shaders/soft_mask.wgsl:57), [group_blend.wgsl:122](/D:/pdfcompare/viewer_gpu/src/shaders/group_blend.wgsl:122).

SoftMaskPipeline đã xuất scalar mask `vec4(lum,lum,lum,lum)`. Khi đưa mask này vào GroupBlendPipeline theo nhánh luminosity/CMYK, shader coi các thành phần đó là C/M/Y/K và tính lại luminosity. Với `lum=0,5`, kết quả trở thành `(1−0,5)×(1−0,5)=0,25`. Đây cũng là cách ghép pass trong benchmark mới.

**Tái hiện GPU:** gray 50% → SoftMaskPipeline → Cyan group trên nền trắng. Kỳ vọng `[128,255,255,255]`; thực tế **`[191,255,255,255]`**. Probe `generated_luminosity_mask_is_used_once` fail.

**Đề xuất:** contract mask output là scalar coverage đã resolve; group đọc trực tiếp scalar. Phân biệt mask source color space với group blend color space; áp transfer function/inversion đúng một lần và có test mức trung gian, không chỉ 0/1.

### R25.GPU.06 — Ảnh RGB trong suốt bị vẽ đặc

**Vị trí:** [image_sample.wgsl:44](/D:/pdfcompare/viewer_gpu/src/shaders/image_sample.wgsl:44), cùng file tại 65.

Uniform có `has_alpha`, nhưng shader không sử dụng trường này hoặc `raw_sample.a` trong nhánh RGB. Màu chỉ nhân `uniforms.alpha`. Vì vậy alpha từng pixel bị bỏ qua.

**Tái hiện GPU:** RGB đỏ, alpha=0; `has_alpha=1`, opacity tổng=1, nền trắng. Kỳ vọng trắng `[255,255,255,255]`; thực tế **đỏ đặc `[255,0,0,255]`**. Probe `transparent_rgb_image_keeps_white_background` fail.

**Đề xuất:** giữ pixel alpha, object opacity, image mask và soft mask riêng tới đúng stage compositing; test alpha 0/0,5/1 trên cả nền trắng và nền màu. Phụ thuộc sửa surface/alpha contract ở R25.GPU.04.

### R25.GPU.07 — Color resolve chưa thực hiện hợp đồng chế bản

**Vị trí:** [color_resolve.wgsl:42](/D:/pdfcompare/viewer_gpu/src/shaders/color_resolve.wgsl:42), [test_g4_acrobat_parity.rs:154](/D:/pdfcompare/viewer_gpu/tests/test_g4_acrobat_parity.rs:154).

Nhánh mang tên proof chỉ dùng `(1-C)*(1-K)` và tương tự cho M/Y. Không có profile/ICC transform, rendering intent, spot/DeviceN hoặc channel mask trong shader này. `overprint_sim` và `gamma` khai báo nhưng không ảnh hưởng đầu ra. Bốn thành phần texture không đủ cho CMYK + spot + alpha như hợp đồng đã đề ra.

Test mang tên overprint/Acrobat nạp trực tiếp một swatch CMYK, đặt flag rồi đối chiếu cùng công thức số học đó; không có chồng đối tượng OPM=1, ảnh tham chiếu Acrobat hoặc phép tính ΔE00. Không thể suy ΔE00 ≤1 từ kiểm sai số ba byte RGB ±2.

**Tác động:** nếu dùng path này thay PPE color contract hiện tại, View/Proof/profile/spot có thể sai dù test swatch vẫn xanh.

**Đề xuất:** color resolve dùng ColorContract thực với profile provenance và precision được kiểm; overprint phải xử lý ở ink/composite stage đúng nghĩa. Loại transform chưa đạt phải có fallback có bằng chứng và tính đủ chi phí.

### R25.GPU.08 — Vòng đời native window chưa đúng ràng buộc Windows

**Vị trí:** [commands.rs:37](/D:/pdfcompare/desktop/src-tauri/src/viewport/commands.rs:37), cùng file tại 53 và 155; [win32_host.rs:468](/D:/pdfcompare/desktop/src-tauri/src/viewport/win32_host.rs:468), cùng file tại 577.

Các command là `async`, nhưng gọi trực tiếp `CreateWindowExW`, `SetWindowPos`, `DestroyWindow`; không điều phối về một thread sở hữu window có message loop. Async command Tauri được spawn thành task riêng; không bảo đảm cùng thread giữa các lệnh. Windows yêu cầu message loop cho thread tạo window và không cho thread khác dùng DestroyWindow để hủy window đó. Kết quả DestroyWindow đang bị bỏ qua.

Nguồn API: [Tauri async commands](https://v2.tauri.app/develop/calling-rust/#async-commands), [Windows message loop](https://learn.microsoft.com/en-us/windows/win32/winmsg/using-messages-and-message-queues), [DestroyWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-destroywindow).

Ngoài ra, `create()` dựng `SurfaceConfiguration` nhưng chưa `surface.configure()` trước khi publish state. Configure chỉ có trong nhánh resize/DPI hoặc recovery. Cần bảo đảm cấu hình surface trước lần acquire đầu và cleanup nếu create_surface thất bại.

**Tác động dự kiến khi nối vào UI:** viewport không nhận/dispatch input-paint đúng, hủy không thành công, cửa sổ/tài nguyên còn sống hoặc frame đầu lỗi. Đây là finding tĩnh theo code/API; chưa gọi command trực tiếp trong phiên PrynX để tái hiện.

**Đề xuất:** owner thread/UI dispatch rõ ràng, command message queue có ACK; tạo/cấu hình/resize/hủy đúng thread, kiểm lỗi; HWND và surface có thứ tự cleanup xác định. G0 phải dùng đúng Tauri/WebView2 host, không dùng window giả lập thay thế.

### R25.GPU.09 — Thiếu ownership theo window/tab/view

**Vị trí:** [commands.rs:19](/D:/pdfcompare/desktop/src-tauri/src/viewport/commands.rs:19), cùng file tại 69–74, 90 và 155–160.

`ACTIVE_VIEWPORT` là một `Option` toàn process. Mở view B lấy/hủy view A bất kể window. Resize/zoom/close không nhận hoặc xác minh owner. Cleanup muộn của tab A vì vậy có thể đóng B; hai khung/cửa sổ không thể đồng tồn tại như kế hoạch.

**Đề xuất:** registry theo window label + tab/view ID + generation; validate caller owner ở native. Lease close chỉ đóng generation nó sở hữu; native window destroyed/hidden phải cleanup đúng view. Test hai cửa sổ và out-of-order open/close.

### R25.GPU.10 — Bộ nghiệm thu không chứng minh các gate đang đánh dấu PASSED

**Vị trí chính:** [benchmark_r01_graph.rs:43](/D:/pdfcompare/viewer_gpu/tests/benchmark_r01_graph.rs:43), [run_acceptance.ps1:99](/D:/pdfcompare/scripts/viewer_gpu/run_acceptance.ps1:99), [test_g4_acrobat_parity.rs:165](/D:/pdfcompare/viewer_gpu/tests/test_g4_acrobat_parity.rs:165), [sổ tiến độ:377](/D:/pdfcompare/docs/PPE_VIEWER_GPU_TIENDO_2026-09-25.md:377).

Các khoảng cách bằng chứng đã xác định:

| Claim | Bài kiểm thực sự làm gì | Chưa chứng minh |
|---|---|---|
| R01 p95≈1,6 ms, >600 fps | Tạo một rectangle và một Bézier, chạy các pass lên texture 1024²; không đọc PDF R01 hoặc scene của nó | R01 render, input→present, làm nét khi wheel, cold load |
| Per-stage GPU timings | Đo `Instant` quanh encode/submit; chỉ đợi GPU ở cuối frame | Thời gian GPU riêng từng stage. Tổng có đợi GPU nên vẫn là số đo có ích cho microbenchmark tổng hợp |
| G0 embedding Tauri/WebView2 | `embedding_spike` tạo parent Win32 giả lập; phần modal enable/disable trả `true` cố định | Airspace WebView2, React popup, IME/focus/accessibility, multi-monitor thực |
| Zero readback, device-loss recovery | `process_protocol_probe.py` thao tác dict/counter Python, tăng epoch; không nói chuyện worker/GPU thật | IPC lifetime, readback thực, recovery device thực |
| Acrobat/ΔE/AA/blend parity | Swatch theo công thức tự đặt; AA chỉ kiểm kích thước vertex buffer; blend chỉ kiểm enum ≤11; mask chỉ kiểm enum 0/1 | Ảnh Acrobat, ΔE00, biên ảnh raster, đúng blend/mask theo corpus |
| Soak 1.000 frame, zero handle/VRAM leak | Render lặp cùng kích thước và kiểm counter pool; không tạo swapchain/window hoặc đo handle/VRAM | 30 phút zoom/resize/open-close, device loss, nhiều kích thước hoặc leak HWND |
| Acceptance P01–P09 | JSON khai ngưỡng nhưng runner không đánh giá P02–P09 từ event/frame/present của Viewer | Các tiêu chí trải nghiệm bắt buộc |

Các test G4 còn `return` khi không tạo được GPU, có thể được tính là test passed mà không thực hiện phép kiểm. `process_protocol_probe` đặt `verdict: True`; modal spike cũng đặt `true` mà không quan sát kết quả tương ứng. Trong bản log hiện có đã đọc, GPU là RTX 3060/Vulkan; không nên suy mọi lượt test đều chạy D3D12 từ mô tả.

**Đề xuất:** giữ microbenchmark/unit model với nhãn đúng phạm vi; gate milestone cần fail khi thiếu evidence. Thay claim G0–G4 completed bằng trạng thái partial/not demonstrated, rồi bổ sung R01 thật, golden có provenance, native replay/present, và xử lý skipped không thành pass.

### R25.GPU.11 — Camera snapshot sai schema giữa Rust và TS

**Vị trí:** [controller.rs:9](/D:/pdfcompare/desktop/src-tauri/src/viewport/controller.rs:9), [useNativeGpuViewport.ts:7](/D:/pdfcompare/desktop/src/hooks/viewer/useNativeGpuViewport.ts:7).

Rust serialize `pan_x`, `pan_y`, `viewport_width`, `viewport_height`; TypeScript đòi `translation_x`, `translation_y`, `physical_width`, `physical_height`. `invoke<T>` không validate payload. Consumer đọc các trường TS sẽ nhận `undefined`; mock trong test dùng schema TS nên không phát hiện sai lệch.

**Đề xuất:** một schema dùng chung hoặc adapter có runtime validation; contract test serialize Rust → parse/consume TS, bao gồm camera change từ native input.

### R25.GPU.12 — Native geometry chưa chuyển CSS pixel sang physical pixel

**Vị trí:** [useNativeGpuViewport.ts:72](/D:/pdfcompare/desktop/src/hooks/viewer/useNativeGpuViewport.ts:72), cùng file tại 101; [win32_host.rs:474](/D:/pdfcompare/desktop/src-tauri/src/viewport/win32_host.rs:474).

Hook gửi trực tiếp `getBoundingClientRect()` đã round. Native dùng x/y/width/height trực tiếp cho child HWND và surface; `dpr` chỉ đi vào controller, không scale rectangle. Trên host per-monitor aware, rectangle CSS 800×600 ở DPR 1,5 cần vùng physical 1200×900. Cache bounds cũng không có DPR, nên chuyển monitor cùng kích thước CSS có thể bị bỏ qua.

**Đề xuất:** định nghĩa rõ payload geometry là DIP hay physical, đổi đơn vị tại một biên duy nhất, đồng bộ client origin/DPR và monitor-change. Kiểm Win32 input physical → camera DIP để tránh anchor/hit-test lệch. Chưa kiểm native UI 150% trong lượt này.

### R25.GPU.13 — Open async không được quản lý bằng generation

**Vị trí:** [useNativeGpuViewport.ts:68](/D:/pdfcompare/desktop/src/hooks/viewer/useNativeGpuViewport.ts:68), cùng file tại 86, 191–199, 209–215.

`isOpenRef` chỉ bật sau await invoke. Nếu effect cleanup chạy trước khi open trả về, `closeViewport` thấy chưa open và bỏ qua; sau đó open hoàn tất tạo viewport không còn owner React. ResizeObserver cũng có thể gửi open lần hai khi lần đầu còn pending. Callback dependency thay đổi hoặc StrictMode có thể kích hoạt chuỗi này. Cleanup không có generation/cancellation hoặc thao tác đóng kết quả open đến muộn.

**Đề xuất:** state machine opening/open/closing theo owner+generation; close-after-open nếu phiên đã hủy; chống open trùng và từ chối response muộn. Viết test với Promise điều khiển được, unmount-before-resolve và hai owner; test hiện tại chưa thực sự mount container để kiểm đường open thành công.

## 4. Kết quả kiểm chứng của lượt review

| Phép kiểm | Kết quả | Giới hạn |
|---|---|---|
| TypeScript `tsc --noEmit -p tsconfig.app.json` | Exit 0 | Không kiểm schema IPC runtime |
| `render_cpu_replay_parity` hiện có | 4 passed | Chủ yếu path tô/stroke đơn giản, overprint được sửa trực tiếp vào scene |
| Probe độc lập compiler/CPU/GPU | **0 passed, 5 failed**, GPU RTX 3060 | Fixture nhỏ để tái hiện đúng nguyên nhân; không phải benchmark R01 |
| Hook test hiện có | Không chạy tới test: Vite startup `spawn EPERM` | Lỗi môi trường spawn, không ghi thành regression của hook |
| Zoom thật PrynX/native multiwindow/DPI | Chưa chạy | Không công bố native runtime pass |
| Acrobat golden/ΔE/performance R01 mới | Chưa có phép so hợp lệ | Không dùng số synthetic để thế chỗ |

Probe dùng code và shader hiện tại, không sửa chúng để tạo lỗi. Source probe: [lib.rs](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/probe/src/lib.rs). Log: [probe.log](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/probe.log), [CPU parity đang có](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/cpu-parity-existing.log), [typecheck](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/typecheck.log), [hook test startup](/D:/pdfcompare/.tmp/review-ppe-gpu-2026-09-25/hook-tests.log).

Lệnh tái lập probe, chạy từ gốc repo:

```powershell
cargo test --offline --manifest-path .tmp/review-ppe-gpu-2026-09-25/probe/Cargo.toml --target-dir viewer_gpu/target -- --nocapture --test-threads=1
```

Exit 101 là assertion failure mong đợi của review hiện tại, không phải compile failure. Không cập nhật expected value sang output sai để test xanh.

## 5. Đánh giá lại tiến độ G0–G4

| Mốc | Phần hiện có | Đánh giá sau review |
|---|---|---|
| G0 | Schema, hash fixture, GPU capability probe, Win32 spike, acceptance JSON | **Một phần.** Chưa chứng minh Tauri/WebView2 embedding, process/device lifetime và bộ đo native theo yêu cầu |
| G1 | IR/types/path compiler, graph skeleton, CPU path replay, camera/index | **Chưa đạt.** Text/XObject/state thiếu, CPU clip và nhiều pass sai/không thực hiện |
| G2 | Pipeline wgpu và shader, texture pool, thử nghiệm synthetic | **Chưa đạt.** 3 ca shader độc lập fail; chưa có R01 graph thật/ICC/alpha contract đúng |
| G3 | Controller/scheduler/layout và Win32 host/React adapter | **Chưa đạt.** Chưa render PDF; lifecycle/ownership/schema/DPI chưa đúng; overlay/IME thực chưa có evidence |
| G4 | Cờ settings và test mang tên acceptance/parity/soak | **Chưa triển khai cutover thực.** Không có consumer mount/cờ sử dụng; parity và nghiệm thu chưa hợp lệ |

Không quy toàn bộ công việc thành “không có gì”: đã có nền tảng GPU, một số phép render/test nhỏ và cấu trúc module có thể tái sử dụng. Nhưng trạng thái phù hợp hiện tại là **prototype các thành phần**, chưa phải Viewer GPU hoàn chỉnh hoặc gần Acrobat đã được chứng minh.

## 6. Thứ tự sửa đề xuất

1. **Sửa chuẩn bằng chứng trước:** giữ nguyên artifact cũ để truy vết, sửa nhãn/trạng thái nghiệm thu và fail khi thiếu evidence. Giữ renderer mới ngoài Viewer mặc định.
2. **Quay lại G0 native:** thread/owner/window lifecycle, surface initialization, schema/geometry, pending open; thử trên Tauri/WebView2 thật với popup/IME/DPI/multiwindow. Không chỉ nối component xám vào UI.
3. **Hoàn thiện G1:** nối PPE resource/state thật vào compiler, triển khai CPU replay đúng hoặc fallback rõ; dùng các ca text/clip/image/group âm tính làm gate. Chứng minh R01 đúng qua scene.
4. **Sửa nền tảng G2:** chốt ink + alpha/shape storage, sửa fixed blending, mask contract và image alpha; sau đó ICC/spot/overprint. Đưa 5 probe này thành regression chính thức với expected semantics giữ nguyên.
5. **Nối một đường end-to-end trong build riêng:** document/revision → scene → graph executor → surface → present; log nguồn pixel, render R01 thật. Chưa mở rộng consumer đến khi correctness và performance của lát cắt này đạt.
6. **Đo và hoàn tất G3/G4:** native input/present, sharpen-in-gesture, uncached zoom/pan, thumbnail/overlay, long soak và golden Acrobat đúng điều kiện. Chỉ cutover khi đủ tiêu chí gốc.

Mỗi bước trên là nhóm công việc, cần tách lô ≤5 file và verify tương ứng theo quy ước repo. Không đề xuất tăng worker/cache hoặc đổi debounce để che các lỗi hợp đồng này.

## 7. Khoảng trống còn cần rà sâu khi sửa

- Graph culling/dependency: bounds stroke, CTM/clip restore, group stack khi cull, Form/Type3/Pattern resource scope; chưa có bộ đối chứng corpus đầy đủ trong lượt này.
- `CapabilityPlanner` mới phân loại theo kích thước và cờ exotic; `HybridGraphExecutor` chưa thực thi kế hoạch fallback từ graph. Chưa có partition texture quá lớn, recovery device/epoch đầy đủ hoặc accounting thực như mô hình Python.
- Resource pool giữ texture theo từng kích thước; test lặp một size không chứng minh working set ổn định khi resize/zoom nhiều size. Chưa đo VRAM/handle/time dài.
- Chưa có chứng cứ P02–P09, first-visit R01, GPU timestamp từng stage, source-profile parity hay input-to-present OS. Những mục này giữ trạng thái thiếu bằng chứng.
- Review tập trung tính đúng và tích hợp renderer; không kết luận toàn bộ bảo mật PrynX, dependency hoặc release pipeline đã an toàn.

**Đề nghị quyết định:** chưa chấp nhận tuyên bố hoàn thành G0–G4; giữ phần mới ở build thử nghiệm và xử lý theo thứ tự trên. Review hoàn tất, implementation vẫn chưa nghiệm thu.
# Bổ sung R25.GPU.30 — renderer độc lập công cụ (25/09/2026)

User đã duyệt triển khai bằng “làm đi” sau khi thống nhất: chọn GPU/CPU trong cài đặt, bàn tay/con trỏ chỉ quyết định tương tác. Phạm vi lô này không đổi kernel raster hay màu.

- Bằng chứng: `AcrobatViewer.tsx` chọn native bằng `nativeSceneEligible && renderToolMode === 'hand'`; `win32_host.rs` bắt mọi `WM_LBUTTONDOWN` thành pan; `LivePageFrame.tsx::SelectableTextLayer` còn sở hữu chọn chữ, liên kết và markup trên DOM. Bỏ riêng điều kiện sẽ làm mất chọn chữ.
- Hợp đồng sửa: scene/lease giữ nguyên khi pointer ↔ hand; native nhận trạng thái công cụ, mô hình chữ và markup theo revision; hit-test/vùng chọn nằm cùng camera/presenter. React tiếp tục sở hữu menu, toolbar và nhập ghi chú. Các popup DOM có vùng loại trừ khỏi child HWND để không bị che, không chuyển renderer theo từng thao tác.
- Chia lô verify: (1) hit-test/selection và overlay GPU với test tọa độ, chữ Unicode, raster readback; (2) native input/IPC/region với cửa sổ test ẩn; (3) hook/component và policy/settings, test lifecycle/routing + typecheck; (4) build native rồi kiểm runtime. Native đang chạy được giữ nguyên tới khi bản chuẩn bị đã qua các kiểm tra độc lập.
- Gate: GPU được chọn ngay ở pointer; CPU vẫn tắt native; đổi pointer/hand không mở/compile lại; kéo chọn chữ không đổi camera; bàn tay/chuột giữa/Space pan; selection/markup đi theo zoom; context menu/copy/comment hoạt động; event cũ/tab nền bị bỏ. Không tuyên bố nghiệm thu runtime từ mock.
