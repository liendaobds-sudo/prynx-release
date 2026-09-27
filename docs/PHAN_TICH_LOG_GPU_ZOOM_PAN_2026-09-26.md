# Phân tích lượt zoom/pan lúc 07:08 ngày 26/09/2026

## Kết luận

Bản LRU/hủy camera trước đó **chưa giải quyết được ca runtime** người dùng báo.
Kết luận quy chủ yếu cho FIFO là quá sớm. Log chứng minh app đã chạy logic mới,
nhưng có nhiều lượt refine bị hủy, đường tile cũ vẫn làm việc khi bị ẩn, và
chi phí dựng detail vẫn cao. Hai test LRU trước chỉ kiểm hàm chọn phần tử nhỏ
nhất/rỗng; không kiểm ca A → B → A hay tiến triển làm nét khi kéo liên tục.

Lượt này chỉ đọc log và đối chiếu code, không thay renderer đang chạy.

## Nguồn và phạm vi

- Log gốc: `D:\pdfcompare\.tmp\render-diagnostics\PrynX_RenderPerf.log`.
- Host PID 30520, khởi động 07:08:03.729 +07:00; dòng 312867.
- SHA-256 binary: `e709b4be83b5074f3276d151c9a8f1f93ad0b98b5f4fda13dc8b3bf631a10f23`.
- Scene revision 2, trang 1. Không có đổi revision trong đoạn đo này.
- Input native đo từ 07:08:20.921 đến 07:08:36.514 (15,593 giây).
- Cắt ở input cuối +1 giây để giữ refine cuối, loại phần lớn log idle.
- Snapshot số liệu: `.tmp/render-diagnostics/resident-session-070803-summary.json`.
- Trích GPU kèm số dòng gốc: `.tmp/render-diagnostics/resident-session-070803-evidence.log`.
- Script tái tính: `.tmp/render-diagnostics/analyze-resident-session.py`.
- GPU được chọn: NVIDIA GeForce RTX 3060, Vulkan, driver 591.86.
- RAM lắp 32 GiB, 16 luồng logic. Mốc nạp scene có khoảng 15,1 GiB RAM khả dụng,
  `system_pressure=false`, `gpu_pressure=false`. Đây không phải đo peak suốt lượt.

## Kết quả đo

Percentile dùng nearest rank; không trộn overview vào thống kê detail.

| Đại lượng | Số mẫu | P50 | P95 | Lớn nhất |
|---|---:|---:|---:|---:|
| Encode detail | 20 | 200,685 ms | 290,078 ms | 301,791 ms |
| Tuổi request tới detail ready, bỏ detail đầu | 19 | 213,440 ms | 364,071 ms | 364,071 ms |
| Xử lý clip trong detail | 20 | 80,523 ms | 115,689 ms | 130,164 ms |
| Nhận input native tới gọi present | 356 | 2,097 ms | 51,447 ms | 70,680 ms |
| Đoạn compositor/submit/present trên CPU | 431 | 0,756 ms | 1,801 ms | 5,255 ms |

`ready_us` tính từ `FrameRequest.at`, không phải thời gian GPU thuần hoặc thời
điểm pixel lên màn hình. Detail đầu có tuổi request 1.025,618 ms, encode 253,200 ms.
`resident_us` không đo toàn bộ GPU execution, chờ acquire, hay scan-out.

- 163 lượt cache miss, 144 lượt `GPU_SCENE_REFINE_CANCEL`, 20 detail hoàn tất.
- 8 frame bị loại ở trần 12. **118 miss xảy ra trước lần eviction đầu tiên.**
- Sau detail native đầu, frontend vẫn có 199 tile requests và 199 PPE IPC submit;
  kết quả gồm 82 ready, 112 cancelled, 5 stale.
- 152 sự kiện `tile-frame-opportunity` trong đoạn này đều `css_visible=false`.
  Số này không có nghĩa mỗi request đều tương ứng một sự kiện frame.

## Đối chiếu nguyên nhân

### 1. Hủy mọi thay đổi camera làm gián đoạn refinement

`desktop/src-tauri/src/viewport/presenter.rs:81` so sánh chính xác camera; bất
kỳ thay đổi pan/zoom nào đều gọi `refiner.invalidate()`. `refinement.rs:114`
hủy encode khi generation đổi. Presenter còn loại kết quả nếu camera kết quả
khác camera hiện tại, kể cả frame vẫn giao với vùng đang xem.

Log 144 hủy/20 detail hoàn tất xác nhận cơ chế này hoạt động thường xuyên.
Với encode khoảng 200 ms, chuyển camera nhanh khiến nhiều lượt bị bỏ dở trước
khi bổ sung pixel nét. Chưa có log encode của lượt hủy nên chưa tính được tổng
CPU lãng phí hoặc tỷ lệ hủy trên toàn bộ submit một cách hoàn chỉnh.

### 2. GPU hiển thị nhưng nhánh tile ẩn vẫn xử lý zoom

`NativeGpuViewportContainer.tsx:88–97` chỉ ẩn children bằng `visibility:hidden`.
`AcrobatViewer.tsx:2675` vẫn truyền `isViewerActive={isActive}`, `zoom` mới và
`getTileUrl` cho `LivePageFrame`. Camera native cập nhật zoom React ở dòng 3073,
kéo nhánh tile đang ẩn chạy tiếp.

199 yêu cầu tile/PPE và 152 mốc `css_visible=false` xác nhận có công việc song
song không hiển thị trong đoạn GPU đã có frame. Chưa đo riêng mức độ chúng góp
vào các stall input 51–71 ms; cần A/B sau khi ngừng producer ẩn mới định lượng.

### 3. Compositor bỏ detail khi zoom lớn thêm dù detail vẫn tốt hơn overview

`viewer_gpu/src/resident_present.rs:75` chỉ vẽ detail nếu mật độ >=0,9.
`win32_host.rs:400` tăng zoom 1,15 lần mỗi wheel notch thông thường.
Với detail vừa đủ mật độ 1, tăng một notch cho mật độ `1/1,15 ≈ 0,8696`:
detail bị loại khỏi các lớp vẽ, dù vẫn nằm trong cache. Vùng đó có thể rơi về
overview thô cho tới khi có detail khác.

Đây là điều kiện xác định được từ code/phép tính; log chưa có ID lớp được chọn
hay mật độ từng lớp để gắn nó với một khung hình cụ thể trong lượt vừa rồi.

### 4. Miss không chỉ vì thiếu bộ nhớ; LRU hiện còn yếu

`DetailCache::touch` chỉ báo phủ đủ nếu **một** frame phủ cả viewport. Hợp nhiều
frame đủ phủ vẫn bị coi là miss. Dịch camera nhẹ cũng có thể kích hoạt dựng lại
cả viewport thay vì chỉ phần mới lộ ra.

`touch` cập nhật cùng timestamp cho mọi frame có giao vùng, không xét lớp nào
thực sự được dùng. Các frame gần nhau/chồng nhau dễ có timestamp bằng nhau;
tie lại loại frame đứng trước. Tăng trần 8→12 không giải quyết đặc điểm này.

118 miss trước eviction đầu bác bỏ giả thuyết eviction là lời giải thích đủ.
Log chưa ghi pan, rect hay ID frame bị loại nên chưa chứng minh frame A cụ thể
của người dùng bị loại ở dòng nào.

### 5. Chi phí dựng clip/path vẫn nằm trên CPU

`viewer_gpu/src/retained_renderer.rs:182` tạo mới cache clip mỗi frame.
Path coverage dùng `Mask::fill_path` và đóng gói buffer (dòng 220 trở đi);
clip còn raster mask bằng CPU (dòng 288–350).

Trong 19 detail sau detail đầu, clip chiếm khoảng 41,3% tổng encode; mỗi lượt
clip mất 60–130 ms. Nhãn renderer GPU không có nghĩa toàn bộ đường làm nét đã
chạy trên GPU. Chưa có phép đo GPU execution hoặc CPU utilization để kết luận
thiết bị đã chạy hết công suất hay phần chậm còn lại chính xác chiếm bao nhiêu.

## Hướng sửa và tiêu chí nghiệm thu

1. **Ngừng nhánh tile ẩn sau first-present native hợp lệ.** Giữ bitmap fallback
   đã có; tiếp tục producer khi native không còn phục vụ. Kiểm tra riêng đổi
   trang, lỗi native, đổi tool, modal và tab nền để tránh tạo vùng trắng.
   Nghiệm thu: không sinh tile IPC mới cho trang GPU đang hiển thị sau handoff.
2. **Bảo đảm refine có tiến triển khi camera di chuyển.** Không hủy chỉ vì pan
   lệch một pixel. Cho phép hoàn tất và giữ kết quả cùng scene còn hữu ích;
   coalesce request mới. Hủy khi sai scene/nội dung hoặc thực sự vô ích, không
   để mọi input khởi động lại toàn bộ công việc. Kiểm thử giữ chuột kéo liên
   tục lâu hơn một lượt encode và vẫn có detail hoàn tất trước khi dừng.
3. **Tách ngưỡng cần làm nét khỏi ngưỡng được hiển thị.** Dùng lớp tốt nhất đang
   có, kể cả đang phóng nhẹ; chỉ dùng overview ở chỗ không có lớp tốt hơn.
   Kiểm ảnh tại một notch 1,15× và đảo chiều, không cho chất lượng rơi đột ngột.
4. **Cache theo vùng trang/mức chi tiết ổn định.** Kiểm phủ bằng hợp các vùng,
   render phần thiếu, thu hồi theo RAM/VRAM thực đo. Không tăng số frame tùy ý
   để coi như sửa xong; máy mạnh không bị trần frame cố định vô căn cứ.
5. **Giảm dựng lại clip/path.** Cache theo scene/scale/vùng phù hợp hoặc dùng
   pipeline GPU cho coverage sau khi có test pixel/màu. Duy trì invariants về
   transform, clipping, alpha/overprint; đo lại encode và ready trên PDF gốc.
6. **Sửa phép đo.** Log theo input/transition, không ghi hit mỗi tick idle;
   thêm camera/rect, detail ID, mật độ lớp, diện tích thiếu, lý do eviction/hủy,
   và thời gian đã encode trước hủy. Không dùng hit spam làm bằng chứng tái dùng.

Chốt runtime phải có A → B → A cùng zoom, pan liên tục, zoom một notch, zoom
nhanh/đảo chiều, đổi trang và fallback khi GPU lỗi. Cần đo trước/sau về thời
gian đến ảnh nét và vùng được phủ nét trong lúc tương tác; compile/test LRU
đơn giản không thay thế được các tiêu chí này.

## Phiên sau Lô 08 — 26/09/2026, host PID 31656

Bản chạy mới có SHA `f070e582321e142d70f202294dd09be32a067d7edc9eab73d276750378adb9e8`.
HWND native đã được đưa lên trên WebView tại `GPU_VIEWPORT_VISIBILITY` lúc
`1790383204105`.

Kết quả xác nhận phần sửa frontend đã có hiệu lực: sau mốc HWND visible không
còn `tile-request-start` hoặc `ppe-ipc-submit`; chỉ còn 3 mốc `tile-disabled` để
dọn các request đã khởi chạy trước handoff. Không có `GPU_DEVICE_ERROR` hay
`GPU_SURFACE_ERROR`.

Native refinement tốt hơn phiên cũ: 68 detail hoàn tất sau handoff, `ready_us`
p50 124,4 ms (trước 213,4 ms), p95 263,1 ms (trước 364,1 ms); cache ghi nhận
495 hit, 101 miss và 68 insert. Trần resident 12 frame bắt đầu eviction sau
khi đầy, nên A → B → A chỉ được coi là đạt nếu vùng A vẫn được phủ bởi resident
frame; log hiện tại chưa ghi rectangle/detail ID để chứng minh từng vùng A.

Nút thắt còn lại là lịch trình presenter, không phải thao tác present GPU:
`GPU_INPUT_PRESENT` p50 1,58 ms nhưng p95 50,72 ms, tối đa 176,97 ms;
`GPU_SCENE_PRESENT resident_us` p50 0,76 ms, p95 1,55 ms trong khi
`request_to_present_us` p95 94,3 ms, tối đa 544,8 ms. Có 28 input vượt 50 ms.
Các spike này trùng lúc hàng đợi camera/refine đang dồn; compositor chỉ mất
khoảng 1–2 ms. Vì vậy Lô 08 đã loại bỏ producer tile ẩn và giảm số lần refine
bị bỏ, nhưng chưa giải quyết triệt để việc coalescing/wakeup của presenter.

Scene startup của phiên này vẫn mất khoảng 511 ms (`GPU_SCENE_READY`) và frame
prime PPE đầu mất 918 ms. Đây là chi phí mở đầu riêng, không được trộn với
latency pan/zoom sau khi HWND đã visible.

### Xử lý tiếp theo sau phiên log

Presenter đã được sửa để đánh dấu frame resident cần present ngay sau mỗi batch
command refinement được submit. Trước đó nó chỉ present khi toàn bộ command của
detail hoàn tất, tạo các khoảng trống 50–700 ms dù phần compositor chỉ mất
1–2 ms. `cargo check` và test camera refinement đã đạt; cần log runtime tiếp
theo để xác nhận p95 `request_to_present_us` thực sự giảm.

## Phiên tiếp theo — 26/09/2026, host PID 11512

Phiên này có 472 input trong 59,7 giây, GPU vẫn là RTX 3060 Vulkan và không có
lỗi device/surface. Sau HWND visible vẫn có 0 tile request và 0 PPE IPC mới.

Detail hoàn tất tăng lên 95 lượt; `ready_us` p50 128,0 ms, p95 211,7 ms.
`resident_us` p50 0,82 ms, p95 1,78 ms, tối đa 19,47 ms. Tuy vậy
`request_to_present_us` vẫn p95 101,5 ms, tối đa 401,5 ms; 135 khoảng cách
present vượt 50 ms. Như vậy thao tác submit batch chưa loại bỏ stall ở bước
acquire/pacing của surface.

Kết luận mới: cần đo riêng thời gian `surface.get_current_texture()` và chọn
`Mailbox` khi surface hỗ trợ. Bản sửa này đã được thêm vào mã nguồn, nhưng chưa
có trong phiên PID 11512; cần phiên runtime kế tiếp để xác nhận.
