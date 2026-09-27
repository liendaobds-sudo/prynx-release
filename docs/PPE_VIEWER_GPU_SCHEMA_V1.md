# Đặc tả Kỹ thuật Schema Version 1: Scene IR & Render Graph Contract (PPE Viewer GPU)

Tài liệu: `docs/PPE_VIEWER_GPU_SCHEMA_V1.md`  
Ngày ban hành: 25/09/2026.  
Mốc kế hoạch: **Milestone G0 — Gói G0.2**.  
Quyết định kiến trúc cơ sở: [QUYET_DINH_KIEN_TRUC_PPE_VIEWER_DAI_HAN_2026-09-25.md](QUYET_DINH_KIEN_TRUC_PPE_VIEWER_DAI_HAN_2026-09-25.md)  
Kế hoạch triển khai: [KE_HOACH_TRIEN_KHAI_PPE_VIEWER_GPU_2026-09-25.md](KE_HOACH_TRIEN_KHAI_PPE_VIEWER_GPU_2026-09-25.md)

---

## 1. Mục đích và Phạm vi

Tài liệu này chuẩn hóa và khóa chặt các giao diện dữ liệu, hệ tọa độ, mô hình màu/mực/alpha, cơ chế vô hiệu hóa (invalidation) và phân định quyền sở hữu (feature ownership) cho toàn bộ hệ thống PPE Viewer GPU:
1. **Scene IR (Intermediate Representation)**: Cấu trúc dữ liệu hình học và tài nguyên trang PDF bất biến theo camera/zoom.
2. **Render Graph & Surface Lease**: Đồ thị các pass dựng hình (raster, clip, soft mask, group blend, color resolve) độc lập giữa CPU và GPU.
3. **Ma trận Feature Ownership & Consumer Inventory**: Phân định dứt khoát giữa Native Viewport, React Shell và Shared Session Store, giải quyết triệt để vấn đề "airspace" trên Windows.

---

## 2. Hệ Tọa độ và Chuỗi Biến đổi (Coordinate Transform Pipeline)

Để đảm bảo không có hiện tượng co giãn mờ nét, lệch pixel hoặc nhảy vị trí thước đo/overlay khi zoom phân số hoặc thay đổi DPI, hệ thống định nghĩa 4 không gian tọa độ chuẩn:

```
[PDF Page Space (pt)]
       │
       ▼  (Page Box Origin + Rotation + UserUnit)
[Scene Local Space (Normalized pt / Logical Layout)]
       │
       ▼  (Camera Zoom Scale `S`, Pan Offset `(Tx, Ty)`)
[Viewport Pixel Space (Logical Dip)]
       │
       ▼  (Device Pixel Ratio `DPR`)
[Physical Surface Pixel Space (Device Pixels)]
```

### 2.1. Chi tiết các không gian
1. **PDF Page Space (pt)**: Tọa độ gốc PDF (1 inch = 72 pt), gốc (0,0) thường ở góc dưới trái (hoặc theo CropBox/MediaBox).
2. **Scene Local Space**: Tọa độ chuẩn hóa của trang sau khi đã áp dụng `MediaBox/CropBox origin`, `UserUnit` và `Rotate` (0°, 90°, 180°, 270°). Trục Y hướng xuống (chuẩn đồ họa màn hình), gốc (0,0) tại đỉnh trên-trái của trang. Không gian này hoàn toàn **bất biến đối với zoom và pan**.
3. **Viewport Pixel Space (Logical Dip)**: Tọa độ hiển thị trong khung nhìn cửa sổ:
   $$\begin{pmatrix} X_{vp} \\ Y_{vp} \end{pmatrix} = S \cdot \begin{pmatrix} X_{scene} \\ Y_{scene} \end{pmatrix} + \begin{pmatrix} T_x \\ T_y \end{pmatrix}$$
4. **Physical Surface Pixel Space**: Tọa độ pixel vật lý thực tế trên swapchain DirectX 12 / Vulkan:
   $$X_{phys} = \lfloor X_{vp} \cdot \text{DPR} \rceil, \quad Y_{phys} = \lfloor Y_{vp} \cdot \text{DPR} \rceil$$

### 2.2. Bất biến quan trọng
- **Quy tắc Camera Invariant**: Mọi thao tác thay đổi Camera (Scale $S$, Offset $T_x, T_y$) **TUYỆT ĐỐI KHÔNG LÀM THAY ĐỔI Scene IR**. Camera chỉ thay đổi ma trận `ViewTransform` gửi tới Render Graph và Vertex Shader.
- **Điểm neo Zoom (Zoom Anchor)**: Điểm neo khi lăn chuột tại con trỏ $(x_c, y_c)$ trong Viewport phải giữ nguyên vị trí tọa độ Scene tương ứng $(X_{scene}, Y_{scene})$ trước và sau khi đổi scale:
   $$T'_x = x_c - S' \cdot X_{scene}, \quad T'_y = y_c - S' \cdot Y_{scene}$$

---

## 3. Mô hình Mực, Màu và Độ mờ (Ink, Color & Alpha Representation)

Hệ thống PPE Viewer GPU phục vụ chế bản in chuyên nghiệp, do đó không được phép đơn giản hóa sớm về sRGB 8-bit.

### 3.1. Các chế độ màu hiển thị (Color Contracts)
1. **View Mode (RGB Display)**: Ánh xạ nhanh cho việc xem phác thảo, RGB hoặc sRGB 8-bit / Float16 với ICC cơ bản.
2. **Proof Mode (Bình bản / Kiểm màu chế bản)**:
   - Giữ nguyên không gian kênh n-mực: Cyan, Magenta, Yellow, Black (CMYK) cộng thêm các kênh màu pha (Spot / Separation / DeviceN).
   - Overprint Simulation: Tái tạo chính xác đè màu (Overprint Mode `OPM = 1` và `OPM = 0`) theo ISO 32000-2 Clause 8.6.7.
   - Transparency Blend Space: Nhóm hòa trộn trong không gian CMYK hoặc DeviceRGB theo thuộc tính `/CS` của Form XObject / Group.
   - Soft Mask (SMask): Hỗ trợ `/Alpha` và `/Luminosity` mask từ backdrop và transfer function.
   - Resolve ra màn hình: Đi qua Little CMS (hoặc 3D LUT GPU đã qua kiểm nghiệm ΔE00 ≤ 1) từ DeviceCMYK + Spot Profile sang Display Profile của màn hình.

### 3.2. Định dạng Surface GPU (Surface Lease Format)
- **High-Precision Framebuffer**: `Rgba16Float` (16-bit nửa nổi) cho các intermediate group, transparency stack và color blending nhằm triệt tiêu lỗi làm tròn (banding).
- **Final Present Swapchain**: `Bgra8Unorm` hoặc `Rgba8Unorm` kết hợp sRGB conversion ở hardware sampler/output resolve.

---

## 4. Cơ chế Vô hiệu hóa (Invalidation Hierarchy)

Mọi thay đổi trong ứng dụng được phân cấp rõ ràng theo mức độ tác động để tối ưu hiệu năng:

| Mức độ | Nguyên nhân | Hành động | Chi phí |
|---|---|---|---|
| **Level 0: Camera Only** | Lăn chuột (wheel), pan, kéo thanh cuộn, zoom cử chỉ | Giữ nguyên Scene IR; cập nhật ViewTransform; điều phối Tile Render Graph | Cực nhẹ (<1 ms CPU, GPU re-composite 60–120 fps) |
| **Level 1: Display / Proof Profile** | Đổi profile màn hình, bật/tắt tách màu (Separation toggle), bật/tắt OCG layer | Giữ nguyên Scene IR; re-run Color Resolve Pass / Blit Shader | Nhẹ (5–15 ms, GPU pass) |
| **Level 2: Page Geometry / In-Memory Edit** | Xoay trang, crop trang, di chuyển đối tượng vector trong bộ nhớ, undo/redo | Cập nhật một phần (dirty region) của Scene IR cho trang đó | Trung bình (10–30 ms) |
| **Level 3: Full Document Revision** | Mở file mới, reload PDF từ đĩa, apply PDF patch toàn trang | Hủy toàn bộ cache trang; biên dịch lại Scene IR từ đầu | Nặng (theo kích thước PDF) |

---

## 5. Ma trận Phân định Quyền sở hữu (Feature Ownership Matrix)

Để loại bỏ hoàn toàn xung đột hiển thị (airspace issue) giữa native child window và React WebView2, toàn bộ các chức năng được phân định quyền sở hữu như sau:

| Mã | Tính năng | Chủ sở hữu chính (Owner) | Cơ chế hiển thị & Tương tác | Chiến lược Airspace & Z-Order |
|---|---|---|---|---|
| **F01** | Page Layout & Canvas | **Native Viewport (Rust / HWND)** | Render trực tiếp bằng wgpu (D3D12/Vulkan) trên child window. | Nền dưới cùng của viewport container. |
| **F02** | Camera Gesture (Zoom / Pan) | **Native Viewport (Rust / Win32)** | Bắt trực tiếp sự kiện chuột (`WM_MOUSEWHEEL`, `WM_LBUTTONDOWN`, `WM_MOUSEMOVE`) trên child HWND. | Không gửi wheel event về React để tránh giật lag. React chỉ nhận camera snapshot định kỳ (throttled). |
| **F03** | Text Selection & Highlight | **Native Viewport (Spatial Index)** | Rust hit-test spatial tree $\rightarrow$ tính bounding quads $\rightarrow$ vẽ selection highlight trực tiếp trong overlay pass của GPU. | Đồng bộ 100% với pixel trang PDF; không lệch khi zoom. |
| **F04** | Rulers & Dimension Layer | **Native Viewport (Overlay Pass)** | Vẽ vạch thước, đường gióng mm/pt trực tiếp bằng GPU shader/lines. | Cùng frame và cùng viewport transform với trang. |
| **F05** | Guides & Snap Lines | **Native Viewport (Overlay Pass)** | Vẽ đường guide từ Native Host; snapping tính toán trong Rust. | Render cùng chu kỳ camera, không có độ trễ frame. |
| **F06** | Edit / Crop Bounding Handles | **Native Viewport (Input Tracker)** | Bắt thao tác kéo thả tay cầm trên HWND; hiển thị handles bằng GPU overlay. | Con trỏ chuột cập nhật qua `SetCursor` của Win32. |
| **F07** | Output Preview / Separation Picker | **Native Host (GPU Shader + Rust)** | Shader sampling từng kênh màu; trích xuất % mực thực tế; gửi kết quả đo về React panel. | React panel nằm ở thanh Sidebar ngoài vùng HWND. |
| **F08** | Context Menu | **Native Host (Win32 Menu)** | Gọi Win32 `TrackPopupMenuEx` từ child HWND hoặc Native Host. | Popup Win32 nổi tự nhiên trên cả child HWND và WebView2. |
| **F09** | Comment Cards / Popups | **React Shell (Floating Coordinate)** | Khi mở card nhập ghi chú: ghim vị trí theo toạ độ Viewport; tạm khóa pan hoặc gửi event cập nhật vị trí card theo camera. | Card nằm trên panel bên cạnh hoặc portal overlay có cơ chế dock. |
| **F10** | Modal Chặn Toàn App (Dialogs) | **React Shell + Native Adapter** | Khi Modal React hiển thị (Settings, Export): Native Viewport nhận cờ `suspend_rendering` hoặc ẩn tạm thời nếu modal phủ toàn màn hình. | Tránh xung đột airspace khi modal đè lên child HWND. |
| **F11** | Dual Viewer (So sánh tài liệu) | **Native Host (Multi-View Host)** | Tạo 2 child HWND độc lập; mỗi view sở hữu một Viewport Controller riêng; liên kết camera qua synchronization bus. | Hai HWND nằm cạnh nhau, phân vùng rõ ràng. |
| **F12** | Thumbnail Sidebar | **Native Host (Worker Pool)** | Worker PPE render ảnh thumbnail độc lập từ Scene IR dùng chung; gửi bitmap/texture sang WebView2. | Hiển thị trong sidebar React bình thường. |

---

## 6. Tiêu chuẩn Giao tiếp IPC & Surface Lease

1. **Không truyền con trỏ trần (Raw Pointer)**: Giữa Rust Native Host và WebView2/Worker, chỉ trao đổi metadata qua cấu trúc JSON/Bincode có type safety: `lease_id`, `revision`, `width`, `height`, `stride`, `format`, `fence_value`.
2. **Device Loss Recovery**: Nếu GPU driver crash hoặc reset (`DXGI_ERROR_DEVICE_RESET` / `VK_ERROR_DEVICE_LOST`):
   - Native Viewport phát hiện lập tức qua `wgpu::SurfaceError::Lost` hoặc `DeviceLost`.
   - Giải phóng toàn bộ swapchain và texture pool cũ.
   - Thử khởi tạo lại wgpu adapter/device.
   - Nếu thành công: re-dispatch Render Graph từ Scene IR có sẵn mà không làm mất trạng thái mở file của người dùng.
   - Nếu thất bại sau 3 lần thử: kích hoạt failover sang PPE CPU fallback và hiển thị cảnh báo Degraded Mode trên UI.
