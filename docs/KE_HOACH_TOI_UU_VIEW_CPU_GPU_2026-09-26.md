# Kế hoạch tối ưu hai chế độ Viewer CPU/PPE và GPU — 2026-09-26

**Phạm vi:** cho phép người dùng chọn đường CPU/PPE ổn định hoặc GPU native để làm việc; giữ màu, pan, zoom và khả năng phục hồi nhất quán.

**Trạng thái:** khảo sát và đề xuất; chưa sửa source.

## Kết luận hiện trạng

PrynX chưa chạm trần GPU. Log cho thấy compositor native có thể submit/present khoảng 0,8–1,8 ms, nhưng thời gian detail và request-to-present còn cao. Nút thắt chính là hợp đồng bàn giao giữa PPE/PDFium/WebView2/HWND, chi phí raster clip trên CPU và lịch trình surface, không phải GPU không tạo được pixel.

Đường CPU/PPE hiện là baseline phù hợp để phát hành:

- nativeGpuViewportEnabled hiện đang mặc định true và persisted fallback cũng là true trong desktop/src/stores/appSettingsStore.ts:329,417.
- View chính giữ đường PPE/FOGRA39; thumbnail vẫn gọi render_pdf_page tại desktop/src/components/acrobat/ThumbSidebar.tsx:313, nên khác màu là pipeline riêng.
- Đường CPU đã có tile/PXRG cache, page LRU theo RAM, PDFium render lock, latest-wins/cancel và cache key gồm file identity/page/zoom/rotation/clip; đây là nền cần bảo toàn, không nên thay bằng một renderer mới.
- AcrobatViewer.tsx đã giữ renderEnabled=true cho fallback.
- Native viewport là child HWND nằm trên WebView2, nhận input Win32 riêng. Pan/Hand/chuột giữa có code native, nhưng DOM bên dưới không thể nhận chuột khi HWND đang visible.
- ppe-native-status hiện có contentReady, nhưng frontend kiểm tra contentReady !== false; payload thiếu field vẫn được coi là hợp lệ. Chưa có FrameProof mang identity và bằng chứng pixel; status cũng cần surfaceGeneration để loại frame của surface vừa recreate.
- presenter.rs:151-164 bỏ detail khi draws == 0 && coverage_bytes == 0, trong khi document_renderer.rs:249 có nhánh PPE CPU upload ảnh hợp lệ nhưng FrameStats mặc định các trường này bằng 0.
- Phiên log mới PID 20000 trên RTX3060/Vulkan/Mailbox ghi input-to-present P50 1,706 ms, P95 11,065 ms; resident P50 1,115 ms, P95 9,027 ms; refine encode P50 156,977 ms, P95 201,107 ms; scene prepare khoảng 473 ms; không có GPU_DEVICE/SURFACE_ERROR.
- Trong chính khoảng native visible vẫn có 57 tile-request-start và 57 ppe-ipc-submit. Fallback producer đang chạy song song; chi phí duplicate chưa được A/B đo riêng.
- HWND bắt focus/input tại win32_host.rs:452-453. WM_KEYDOWN chỉ xử lý một nhóm phím; Ctrl+C/Escape/Delete chưa có cầu nối chắc chắn về DOM. Ctrl+0 hiện còn đặt zoom/pan trực tiếp thay vì gọi semantic Fit Page.

## Mục tiêu nghiệm thu

Hai chế độ phải độc lập và chuyển đổi an toàn:

| Chế độ | Đường hiển thị | Quyền input | Tiêu chí |
|---|---|---|---|
| CPU/PPE | WebView/PPE accurate | DOM/Viewer hiện tại | màu FOGRA39, pan/zoom hiện tại không đổi |
| GPU thử nghiệm | HWND native + resident compositor | HWND native sau handoff | không chớp, pan được, anchor đúng, có keyboard và recovery |

Không đổi renderer theo từng wheel/pan. Một phiên xem trang đã bàn giao cho GPU phải giữ native visible trong lúc camera stale; một phiên CPU không được âm thầm dựng HWND.

## Lô 0 — Baseline và corpus đo, chưa sửa code

Dùng cùng corpus cho cả hai chế độ: PDF CMYK/FOGRA39 thực tế, PDF vector nhiều đối tượng, trang trắng hợp lệ, transparency/spot/DeviceCMYK và PDF nhỏ RGB.

Ghi riêng cho mỗi mode:

- thời gian tới ảnh đầu;
- thời gian tới ảnh accurate/nét;
- scene compile, PPE encode, detail-ready, request-to-present;
- P50/P95 input-to-present;
- số lần hủy refinement, surface acquire wait, device/surface error;
- peak RSS/VRAM và số request tile/PPE;
- ảnh chụp cùng camera để so màu, MAE/DeltaE theo corpus;
- thời gian và kết quả recovery sau đổi trang, resize/DPR, GPU lỗi.

Không dùng test DOM hoặc output.present() làm bằng chứng runtime. Phải có ảnh/pixel và thao tác trên Windows thật.

## Lô 1 — Chế độ chọn CPU/GPU an toàn (≤5 file)

1. Đổi mặc định production sang CPU: nativeGpuViewportEnabled=false.
2. Thêm migration một lần cho persisted state cũ từng bật GPU thử nghiệm; sau migration người dùng vẫn có thể bật lại từ Settings.
3. Đổi nhãn và mô tả qua i18n thành “GPU Viewport — thử nghiệm”, nêu rõ CPU là chế độ ổn định.
4. Khi người dùng đổi setting, thực hiện handoff ở ranh giới scene: ẩn/đóng native trước khi bật CPU hoặc mở native mới; không để khoảng trống.
5. Thêm test store/migration, Settings và test bật/tắt trong lúc file đang mở.

Điều kiện đạt: cài mới và profile cũ đều vào CPU; bật GPU chỉ là lựa chọn rõ ràng; tắt GPU không làm mất ảnh CPU.

## Lô 2 — Hợp đồng contentReady và FrameProof (≤5 file)

Thêm schema version cho status native, tối thiểu:

    documentToken, page, revision, generation,
    surfaceWidth, surfaceHeight,
    contentReady, contentKind,
    sourceRect, visibleSourceRect,
    sourcePixelsReady, imageDimensionsValid

Quy tắc:

- Frontend chỉ nhận contentReady === true; field thiếu hoặc identity không khớp thì giữ CPU.
- PPE CPU được coi là có nội dung khi worker trả Completed, PNG decode thành công, kích thước đúng vùng yêu cầu và vùng ảnh giao camera. Không dùng draws làm gate.
- Retained GPU cần texture đúng scene, overlap camera và proof identity; draws/coverage_bytes chỉ là chẩn đoán.
- Trang trắng hợp lệ vẫn là content.
- present() không tự tạo ACK. Content proof sai gửi contentReady=false, không toast lỗi.
- Native error, stale revision, device loss hoặc surface loss phải làm frontend ẩn HWND và khôi phục CPU.
- Nhánh uncaptured GPU error hiện clear resource rồi continue mà chưa luôn notify frontend; phải phát terminal event theo lease/revision, nhả HWND, tạo context/lease mới khi retry, không lặp vô hạn trên device cũ.

## Lô 3 — Handoff và input không chớp (≤5 file)

Giữ state hai pha:

    CpuVisible
      -> NativePreparing
      -> NativeCandidate(contentReady=true, interactionReady=true)
      -> NativeVisible
      -> NativeInvalid -> CpuVisible

Bất biến:

- Camera stale do pan/zoom/refinement không làm NativeVisible chuyển về CPU.
- Native giữ resident frame cũ và transform ma trận ngay lập tức; refine chạy nền.
- Chỉ hạ HWND khi đổi document/page/revision, tab/modal/occlusion yêu cầu, resize không còn hợp lệ, surface/device lỗi hoặc unmount.
- Khi native visible, input phải do native sở hữu; không chờ DOM fallback xử lý pan.
- Khi CPU visible, không phát event native và không để HWND cũ còn hit-test.
- Thêm cầu nối keyboard/focus cho Ctrl+C, Escape, Delete, Ctrl+0 và các phím Viewer; Ctrl+0 phải gọi semantic Fit Page.
- Test Promise interaction pending, đổi scene giữa hai ACK, modal/tab nền, GPU lỗi sau handoff và bật/tắt setting lúc đang zoom.

## Lô 4 — Tối ưu GPU theo số đo (≤5 file)

1. Scheduler/present: giữ latest camera, coalesce input, không chờ GPU trong vòng present; đo riêng acquire wait và encode CPU. Không coi Mailbox là thuốc chữa nếu driver không hỗ trợ.
2. Refinement: không hủy pan nhỏ/one-notch; chỉ hủy scene/revision hoặc camera rời xa ngưỡng đã đo. Ghi thời gian encode trước khi hủy.
3. Clip/path: cache coverage/clip theo scene, scale và clip key; không dựng lại toàn bộ tiny_skia mask mỗi frame nếu key không đổi. Giữ invariants transform, clipping, alpha và overprint.
4. Resident budget: thay trần frame cố định bằng ngân sách texture theo RAM/VRAM thực đo. Máy <8 GB và 8–16 GB mới giảm; máy ≥16 GB không bị cap vô điều kiện.
5. Fallback producer: sau NativeVisible ổn định, dừng request tile/PPE mới nhưng giữ bitmap cuối; khi native invalid thì bật lại producer. Đo A/B 0 tile/PPE duplicate trong GPU visible.
6. CPU fallback trong GPU session: nếu GPU material không hỗ trợ, chốt cả scene sang PPE fallback theo revision; không đổi qua lại mỗi cử chỉ.

Mỗi thay đổi phải có baseline trước/sau trên máy yếu giả lập và máy mạnh; không tối ưu theo số hit cache đơn lẻ.

## Lô 5 — Anchor, pan và DPI (≤5 file)

- Lấy getBoundingClientRect() của chính native viewport tại thời điểm gửi zoom; không bù ruler/padding bằng hằng số.
- Quy ước rõ: React truyền CSS pixel local; Rust chia DPR đúng một lần trước anchor_zoom.
- Kiểm tra tool ACK trước khi cho HWND nhận input; xác minh SetCapture, is_dragging, ViewportScheduler.accumulate_pan và release khi đổi tool/tab.
- Test zoom ở bốn góc, ruler bật/tắt, scrollbar, DPR 1/1.25/1.5/2, Hand/Space/chuột giữa và đổi tool trong lúc kéo.

## Lô 6 — Màu và thumbnail (≤5 file)

Giữ CPU/PPE FOGRA39 làm reference. GPU phải dùng cùng profile/intent/black policy hoặc bị đánh dấu không tương thích và không được bật mặc định.

Thumbnail là pipeline riêng:

- render_pdf_page nhanh có thể giữ cho cold thumbnail;
- nếu tái dùng bitmap PPE, cache key phải gồm file identity, page, profile, intent và revision;
- nếu render thumbnail bằng PPE, đo 120–150 px trên máy yếu/mạnh và không để thumbnail chiếm lock/PPE worker của view chính;
- so màu bằng artifact thật, không chỉ nhìn preview.

## Verification bắt buộc

### Tự động

- Typecheck.
- Vitest store/settings, native hook/container, pan/anchor và handoff.
- Rust tests cho FrameProof, CPU PPE upload, trang trắng, stale revision, surface invalidation, anchor/DPR và resident compositor.
- Cargo check/test desktop/src-tauri, viewer_gpu; không cập nhật snapshot nếu chưa soi diff.

### Runtime Windows thật

Chạy ma trận cho cả CPU và GPU: cold/warm open file khách; đổi trang nhanh; zoom in/out và đảo chiều liên tục; pan Hand/Space/chuột giữa; ruler/scrollbar/DPR; modal/Output Preview/tab nền; GPU delay, surface loss, device loss, unsupported material; bật/tắt mode lúc file đang mở; thumbnail cold/warm và so màu.

### Chỉ bật GPU mặc định khi

- CPU mode không hồi quy về màu, pan, zoom và first-frame;
- GPU mode có content proof strict, không chớp trong chuỗi A→B→A;
- không có native HWND visible cho revision cũ;
- pan/anchor pass trên DPI matrix;
- keyboard/focus commands hoạt động khi HWND đang focus;
- recovery về CPU không tạo view trắng/xám;
- P95 input-to-present và time-to-sharp đạt ngưỡng đã chốt trên PDF thật;
- màu GPU đạt tolerance so với CPU/PPE reference;
- không có lỗi terminal trong soak test.

## Những điều không làm

- Không đổi CPU/GPU mỗi wheel hoặc mỗi refinement.
- Không dùng CSS/opacity để che vấn đề HWND opaque.
- Không dùng draws thay cho proof pixel.
- Không đặt trần resident cố định cho máy mạnh.
- Không gọi test xanh là nghiệm thu runtime.
- Không sửa thumbnail màu trong cùng lô sửa handoff GPU.

> **Chốt duyệt:** Lô 0 và Lô 1 là đường an toàn để đưa sản phẩm về CPU mặc định nhưng vẫn cho người dùng chọn GPU. Lô 2–5 cần được duyệt và verify từng lô trước khi cân nhắc bật GPU mặc định.
