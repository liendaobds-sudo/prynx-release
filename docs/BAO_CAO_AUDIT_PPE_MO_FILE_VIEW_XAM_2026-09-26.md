# Báo cáo audit PPE: mở file, bàn giao view và zoom — 2026-09-26

## Phạm vi và mức bằng chứng

Audit unit: mở một PDF ở Viewer, chờ scene PPE/native present, sau đó zoom hoặc
đổi trang; kết quả quan sát là vùng PDFium fallback có còn hiển thị hay bị thay
bằng HWND native màu xám.

Đã đối chiếu frontend React, Tauri viewport, `viewer_gpu` compositor, PPE worker,
log runtime trong `.tmp/render-diagnostics/PrynX_RenderPerf.log` và test native
viewer. Chưa chạy lại thao tác trên cửa sổ Tauri đang hiển thị PDF khách trong
lượt này, nên trạng thái runtime cuối cùng vẫn là `OPEN`.

## Kết luận điều hành

Có một lỗi bàn giao đã được xác nhận bằng test: native viewport được phép che
fallback sau `first-present` dù hợp đồng input (tool/text/markup) vẫn đang chờ
ACK. Khi lệnh interaction bị treo hoặc PPE/native chưa sẵn sàng, fallback
PDFium đã bị ẩn và người dùng chỉ còn thấy nền của HWND (`#525659`).

Có thêm hai khoảng trống làm lỗi khó quan sát: `first-present` chỉ chứng minh
`output.present()` và giao hình học, không chứng minh pixel có nội dung; khi scene
mới sẵn sàng, frontend lập tức ghi đè camera fit bằng scale React hiện tại. Cả hai
đều làm cửa sổ xám kéo dài hoặc tái xuất khi mở file/đổi trang/zoom.

Không có bằng chứng cho thấy PDFium crash trong phiên log gần nhất: scene compile,
PPE refinement và native present đều hoàn tất; không thấy `GPU_DEVICE_ERROR` hay
`GPU_SURFACE_ERROR` ở đoạn phiên được đối chiếu. PDFium đang bị che bởi policy
handoff khi native đã nhận quyền vẽ, nên một frame native không hợp lệ không còn
đường cứu hình ngay lập tức.

## Findings đã xác minh

### PPE-VIEW-01 — P1 / M — [CONFIRMED]

**Native che fallback trước khi interaction ACK.**

- `desktop/src/components/acrobat/NativeViewportInteractions.tsx:31-40` gửi
  `set_native_gpu_viewport_interaction` bất đồng bộ sau `isSceneReady`.
- `desktop/src/hooks/viewer/useNativeGpuViewport.ts:137-149` nhận status present
  và tự đặt `interactionRevision.current = value.revision`, không chờ Promise
  interaction hoàn thành.
- `desktop/src/hooks/viewer/useNativeGpuViewport.ts:173-176` vì vậy cho
  `shouldShow=true`; `NativeGpuViewportContainer.tsx:108,132-150` đặt fallback
  `opacity: 0`, `visibility: hidden`, `pointer-events: none`.
- Test bảo vệ hợp đồng đã đỏ tại
  `desktop/src/components/acrobat/NativeGpuViewportContainer.test.tsx:188-196`:
  test chặn `set_native_gpu_viewport_interaction` và vẫn quan sát một lần gọi
  `set_native_gpu_viewport_visibility` trong khi ACK chưa đến.

**Ảnh hưởng:** native HWND đã được đưa lên trên WebView nhưng scene interaction
chưa hoàn tất. Nếu PPE/material/driver hoặc IPC bị chậm, PDFium fallback bị che
hoàn toàn; nền native màu xám trở thành ảnh duy nhất. Đây là finding gần nhất với
triệu chứng “mở file một cái thì mất view chính”.

### PPE-VIEW-02 — P1 / M — [CONFIRMED DESIGN GAP]

**`first-present` không kiểm tra pixel có nội dung.**

- `desktop/src-tauri/src/viewport/presenter.rs:241-247` chỉ loại frame khi
  `raster_overlaps` của overview/detail đều false, sau đó gọi `output.present()`.
- `desktop/src-tauri/src/viewport/presenter.rs:281-282` phát status thành công
  cho frontend sau lần present đầu.
- `desktop/src/hooks/viewer/useNativeGpuViewport.ts:137-149` coi status đó là
  đủ để bật native; `NativeGpuViewportContainer.tsx:108,150` ẩn fallback.
- `raster_overlaps` chỉ kiểm tra hình học ma trận, không đọc pixel, alpha,
  coverage hay checksum của texture. Một texture toàn nền xám nhưng còn giao
  hình học vẫn được ACK.

**Ảnh hưởng:** một surface/PPE frame rỗng, stale hoặc chỉ có nền vẫn có thể giành
quyền vẽ. Log hiện có `GPU_SCENE_PRESENT`, nhưng điều này chưa chứng minh ảnh
trang thật đã xuất hiện.

### PPE-VIEW-03 — P1 / M — [CONFIRMED]

**Camera fit bị ghi đè ngay lúc scene mới mở.**

- `load_native_gpu_scene` khởi tạo camera fit trong
  `desktop/src-tauri/src/viewport/commands.rs:184-205`.
- Ngay khi `isSceneReady`, `NativeGpuViewportContainer.tsx:82-92` gọi
  `setZoom(scale)` nếu scale React khác camera native.
- Consumer truyền `scale={effectiveZoom * 96 / 72}` tại
  `desktop/src/components/AcrobatViewer.tsx:3075-3080`.
- Log phiên `Vmui8qyql-g39vvu` ghi scene present đầu ở zoom `1.4842`, sau đó
  `GPU_DIAG_FE_SCALE_SYNC` gửi target `16.632` và native present ở zoom `16.6317`
  (`PrynX_RenderPerf.log` quanh dòng 920792–920854).

**Ảnh hưởng:** mở file bắt đầu bằng một render fit rồi lập tức chuyển sang một
  camera phóng lớn khi PPE detail chưa có. Điều này kéo dài khoảng native chỉ có
  overview và làm lộ các lỗ coverage/gray nếu compositor hoặc surface chưa ổn.

### PPE-VIEW-04 — P2 / M — [CONFIRMED COUPLING]

**Khi native visible, đường PDFium không còn làm producer cứu hình.**

- `desktop/src/components/AcrobatViewer.tsx:2722-2723` truyền
  `renderEnabled={!(nativeViewportVisible && useNativeScene)}`.
- `onNativeVisibilityChange` được gọi ngay sau visibility ACK tại
  `AcrobatViewer.tsx:3091`.
- Runtime log xác nhận sau `GPU_VIEWPORT_VISIBILITY ... visible=true` không còn
  tile/PPE IPC mới trong các phiên audit trước.

**Ảnh hưởng:** khi finding PPE-VIEW-01 hoặc 02 xảy ra, fallback PDFium đã bị
  tắt cùng lúc với việc HWND native che WebView. Đây là lý do lỗi PPE biểu hiện
  thành mất toàn bộ view thay vì chỉ chậm làm nét.

## Đối chiếu PDFium/PPE và bằng chứng runtime

- Phiên gần nhất ghi `GPU_SCENE_COMPILE`, `GPU_SCENE_READY`, `GPU_SCENE_REFINE`
  và `GPU_SCENE_PRESENT`; các scene page 1/page 2 đều có primitive được vẽ.
- Không thấy `GPU_DEVICE_ERROR` hoặc `GPU_SURFACE_ERROR` trong đoạn log đã đối
  chiếu. Vì vậy chưa thể gọi đây là PDFium crash hoặc PDFium lock deadlock.
- Log có `GPU_SURFACE_ACQUIRE wait_us=267505` ở một scene; đây là stall acquire
  rất lớn, cần giữ lại trong wave hiệu năng, nhưng tự nó chưa chứng minh frame
  xám.
- `viewer_gpu` compositor unit đạt 3/3, gồm test reverse zoom không có white
  hole. Bộ test này chưa kiểm tra surface toàn nền xám trước ACK interaction và
  chưa kiểm tra pixel thật của PPE worker trên PDF khách.

## Khoảng trống cần kiểm tiếp

1. Chụp pixel/ảnh native ngay trước status ACK và sau khi fallback bị ẩn; ghi
   checksum hoặc tỷ lệ pixel nền `82,86,89` để phân biệt frame rỗng với PDF có nền
   xám thật.
2. Chạy Tauri runtime với interaction IPC bị trì hoãn, đổi trang trong lúc scene
   compile, zoom ngay sau mở file và resize/DPR change; xác nhận fallback vẫn còn
   tới khi native frame có pixel hợp lệ.
3. Đối chiếu cùng file bằng đường PDFium-only để loại trừ lỗi nội dung/PDFium
   parser; sau đó chạy PPE-only với cùng crop/scale.
4. Ghi camera matrix, source/target rect và detail coverage cho frame đầu; hiện
   log chỉ ghi overlap hình học, chưa ghi tỷ lệ pixel hữu ích.

## Lô sửa đề xuất (chưa triển khai)

Lô A (≤5 file): sửa state gate để chỉ ẩn fallback sau cả native first-present
  **và** interaction ACK; thêm regression test cho Promise interaction treo.

Lô B (≤5 file): siết contract first-present bằng một tín hiệu nội dung hợp lệ
  (coverage/checksum hoặc readback kiểm tra trong harness), giữ fallback nếu native
  chỉ có nền; thêm test pixel/handoff.

Lô C (≤5 file): đồng bộ camera fit và scale lúc mở file, tránh setZoom React
  phóng lớn trước khi frame fit/overview đã được xác nhận; đo lại latency và gray
  window trên file khách.

Theo quy trình audit của PrynX, báo cáo này dừng ở chốt duyệt; chưa sửa source.
