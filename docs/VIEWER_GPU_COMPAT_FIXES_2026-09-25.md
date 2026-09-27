# Viewer GPU R34 — nhật ký sửa tương thích

Ngày 25/09/2026. Phạm vi: bảy finding R34 đã được người dùng duyệt sửa.

## Đã sửa trong source

| Finding | Thay đổi | Kiểm chứng |
|---|---|---|
| R34.01 | Khi native không đáp ứng scene, giữ cây Viewer cũ đã mount và tự quay về đường tương thích; capability fallback không còn toast kỹ thuật. | 20 ca corpus cũ vẫn có đường PDFium; test container 28/28 |
| R34.02 | Native chỉ được chọn khi color contract là accurate + FOGRA39/Relative đúng với scene worker. Display preview, nền tối và profile tùy biến giữ đường cũ. | Typecheck + policy trace; chưa gọi đây là pixel parity GUI |
| R34.03 | DOM fallback không bị tháo khi HWND present; node scroll được giữ nguyên qua handoff và input chỉ thuộc backend đang chọn. | Probe handoff đã chuyển xanh; test container |
| R34.04 | Camera, visibility, invalidation, success/error đều kiểm lease + scene revision; Rust zoom/camera nhận revision để từ chối mutation cũ. | Test stale camera/error; cargo viewport 38 pass/5 ignored |
| R34.05 | Thêm `fit_native_gpu_viewport_page` và `ViewportController::fit_page`, tính zoom + pan tâm theo page bounds, Rotate/UserUnit, DPR. | Test Fit Page camera pass |
| R34.06 | GPU gate dùng `RenderWarnings::ink_unsound()`, không dùng mọi `skipped_ops`; font thay thế vẫn giữ cảnh báo hình học nhưng không bị loại vô cớ. | viewer_gpu 2 pass/1 ignored; print_engine 404 pass/5 ignored |
| R34.07 | InputStamp mang revision; presenter chỉ ghi input→present khi revision input trùng frame revision. | Rust viewport tests và log schema compile pass |

## Kết quả verify

- `npm run typecheck`: đạt.
- Targeted Vitest hook/container: **30/30 đạt** (thêm Fit Page IPC và handoff giữ node scroll).
- Full Vitest: **3857 đạt, 2 fail, 2 skip**; hai fail thuộc catalog i18n có sẵn ngoài phạm vi viewer (chuỗi tĩnh VI/EN thiếu), không phát sinh từ lô này.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib viewport`: **38 đạt, 5 ignore**.
- `cargo test --manifest-path viewer_gpu/Cargo.toml --lib retained_renderer --no-default-features`: **2 đạt, 1 ignore**.
- `cargo test --manifest-path print_engine/Cargo.toml --lib`: **404 đạt, 5 ignore**.
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml`: đạt, chỉ còn warning dead-code đã có.
- Executable debug sau build: `desktop/src-tauri/target/debug/pdf-inspector.exe`, SHA256 `9B500725C924F1227BB5102741D15682B35C83B00904561055D386236A4AE1F9`.
- Native worker probe trên cùng corpus 20 ca sau build: **20/20 display, 14/20 PPE accurate** (giữ nguyên capability), GPU trực tiếp **10/20**; hai ca font thay thế (`fixture-live-text`, `base14-font`) nay dựng GPU dù vẫn giữ metadata `geometry_approximate`. Đây là artifact tự động, chưa thay cho GUI runtime.

## Giới hạn còn phải nghiệm thu runtime

Chưa dùng test tự động để khẳng định GUI Tauri, DPI nhiều màn hình, device-loss, installer, soak 30 phút hoặc A/B tốc độ so với Acrobat. Native mặc định vẫn theo setting người dùng; các profile màu khác FOGRA39/Relative cố ý giữ đường Viewer cũ để không gắn nhãn sai. Chỉ chuyển mặc định sau khi có runtime evidence cho các ca này.
