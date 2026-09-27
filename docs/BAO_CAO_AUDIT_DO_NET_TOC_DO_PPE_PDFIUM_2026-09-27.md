# Audit độ nét và tốc độ làm nét PPE/PDFium — 27/09/2026

## Trạng thái

**Đã khảo sát, chưa sửa renderer, chờ duyệt lô triển khai.** Phạm vi là đường
Viewer hiện hành PDFium/PPE: DPI/DPR → viewport tile → scheduler/coalescing →
worker raster/ICC/encode → decode PXRG/PNG → surface đang nhìn thấy. Native GPU
View không thuộc phạm vi sửa trong lượt này; source hiện tại đã hard-gate nó bằng
`DEV + VITE_ENABLE_GPU_VIEWPORT` ở commit `1c1c838`.

## Kết luận điều hành

Độ nét hiện bị chi phối bởi hai đại lượng khác nhau:

1. **Nét hình học:** bitmap hiện tại có đúng mật độ, đúng clip, đúng profile,
   không bị phóng từ underlay hoặc ghép sai tile.
2. **Tốc độ lên nét:** từ khi zoom/pan đổi đến khi bitmap PPE mới decode và thật sự
   phủ vùng nhìn thấy.

Source hiện đã có nhiều guard đúng: DPI bucket 12 DPI, clip snap theo device pixel,
giữ ảnh cũ/queued target, PXRG raw bytes, proof metadata và test terminal success/
cancel/decode. Tuy nhiên các test này phần lớn chứng minh **policy/lifecycle**, chưa
chứng minh time-to-sharp trên PPE worker thật và compositor WebView2.

Bằng chứng runtime lịch sử còn cho thấy một tài liệu PPE có 97 viewport requests,
88 bị hủy, chỉ 8 ready; completion native quan sát được khoảng 537–1551 ms.
Đây là bằng chứng cũ cần tái đo trên binary hiện tại, không tự gán là trạng thái
cuối cùng.

## Baseline hiện tại

- Test hẹp vừa chạy: **6 test files / 192 tests pass** gồm `viewportTilePolicy`,
  `LivePageFrame.liveTile`, `renderZoomPolicy`, `useTileRenderer`,
  `renderCoordinator`, `tileUrlCache`. Có cảnh báo jsdom `Canvas.getContext` chưa
  triển khai ở nhánh fallback, nhưng không có test fail.
- CMNM outline worker probe trước đó: PPE warm khoảng **1.231 ms**; VDP ảnh-raster
  warm khoảng **233 ms**. Đây là worker timing, chưa phải GUI time-to-sharp.
- Current source có `accurateViewerDpi()` neo 12 DPI, `accurateViewerRasterDpr()`
  quy đổi clip, `VIEWPORT_TILE_RUNWAY_PAD=0`, tile snap 64 px và `TILE_MAX=4000`.
- `LivePageFrame` phát settled tile mỗi khoảng 16 ms, nhưng `renderZoom` có trailing
  khoảng 48 ms; `LiveTile` còn có accurate target settle 96 ms ở nhánh đã nhận frame
  mồi. Các khoảng này chưa được cộng/đo thành một SLA thống nhất.
- `TileLayer` giữ `visible`, `target`, `queued`; target cùng nội dung được coalesce,
  target khác document/page/profile/revision mới hủy ngay. Đây là hợp đồng tốt cần
  giữ, không được thay bằng “hủy mọi request cũ”.

## Findings

### §SHARP.01 — P1 / L — Chưa có bằng chứng time-to-sharp end-to-end hiện tại

**Bằng chứng:** `LiveTile`/`TileLayer` test dùng Promise và latency giả; chúng xác
nhận target cuối tiến triển, không đo worker PPE, IPC, decode PXRG, WebView paint
hoặc scan-out. Audit runtime cũ ghi tỷ lệ cancel cao và native completion 537–1551
ms, nhưng thuộc binary/phiên trước.

**Tác động:** không biết hiện tượng “đang kéo nhưng không nét” nằm ở scheduler,
PPE raster, IPC, decode hay compositor.

**Đề xuất:** thêm harness ghi cùng một `sharpness_attempt_id` từ zoom input →
target group → worker start/end → response bytes → decode → tile commit → pixel
coverage. Tách `first-readable`, `first-sharp`, `target-sharp` và `idle-settle`.

### §SHARP.02 — P1 / L — PPE raster/ICC là sàn lớn hơn debounce

**Bằng chứng:** CMNM outline warm PPE khoảng 1.231 ms, VDP khoảng 233 ms; source
worker gộp open/parse/raster/color vào `render_ms`, sau đó PNG encode riêng.
Trong code không có phép đo tách phase cho từng viewport request ở UI.

**Tác động:** giảm 48/96 ms chỉ giúp phần lịch; không giải quyết request mất hàng
trăm ms hoặc hơn một giây. Tăng worker vô điều kiện có thể làm low-RAM swap và
giảm độ nét vì request bị hủy giữa chừng.

**Đề xuất:** profile CMNM/VDP theo `raster`, `color`, `resource`, `encode`, clip
diện tích và số mask/path; giữ interactive lane riêng. Chỉ tối ưu phase đứng đầu
profile, không đoán từ GPU utilization.

### §SHARP.03 — P1 / M — Có nhiều “độ trễ sàn” cộng dồn

**Bằng chứng source:**

- `LivePageFrame.tsx`: render zoom trailing khoảng 48 ms.
- `renderZoomPolicy.ts`: viewport tile settle 48 ms.
- `LivePageFrame.tsx`: accurate target settle 96 ms sau khi đã nhận frame mồi.
- Worker/IPC/decode thường lớn hơn các timer trên.

**Tác động:** người dùng có thể thấy bitmap cũ bị scale mềm trước khi request PPE
cuối bắt đầu; ngược lại nếu bỏ timer mù, zoom wheel sẽ tạo request quá dày.

**Đề xuất:** gom thành một state machine đo được: `desired camera`, `accepted
target`, `in-flight`, `displayed`, `sharp`. Chỉ settle layout ở cold-open; sau lần
sharp đầu, target mới dùng coalescing/in-flight hiện tại, không reset delay mồi.

### §SHARP.04 — P1 / M — Mật độ và clip có thể đúng toán nhưng chưa có pixel gate

**Bằng chứng:** `accurateViewerDpi()` bucket lên 12 DPI; `computeViewportTileSpec()`
floor/ceil clip theo DPR và snap 64; `computeDevicePixelSnapOffset()` chỉnh origin
theo device pixel. Unit test kiểm số nguyên, xoay, coverage và seam.

**Khoảng trống:** chưa có corpus pixel thật kiểm chữ nhỏ, hairline, gradient,
CMYK/spot và clip mép ở DPR 1/1,25/1,5/2 cùng zoom 100/200/400%. Độ phủ geometry
không chứng minh độ sắc chữ hoặc không bị resampling.

**Đề xuất:** pixel gate theo ROI: chữ 8–12 px, đường 1 px, logo/ảnh, gradient;
so full PPE với viewport PPE tại cùng DPI/profile. Ghi exact dimensions và pixel
ratio của bitmap đã decode.

### §SHARP.05 — P1 / M — Underlay đúng semantics nhưng có thể che cảm giác “không nét”

**Bằng chứng:** policy giữ `visible` tile cũ trong lúc `target/queued` chờ; khi
zoom settling, tile cũ được scale theo khổ sống. Đây là cần thiết để không trắng,
nhưng không có chỉ số cho biết vùng đang nhìn là bitmap đúng mật độ hay underlay.

**Đề xuất:** telemetry phải ghi `displayed_scale`, `target_scale`, `pixel_ratio_x/y`,
`underlay_age_ms`, `viewport_coverage` và `proof.engine`. Nghiệm thu phải tách:
“không trắng/không mất ảnh” khỏi “đã đủ nét”. Không che bằng crossfade.

### §SHARP.06 — P1 / M — Queue/cancel có nguy cơ làm đói target cuối

**Bằng chứng:** `useTileRenderer` có `cancelAccurateRendersForViewport`; scheduler
reject queued/running group theo owner/group; `TileLayer` coalesce target cùng
reuseGroup. Test R24.08/R25.04.2 đã khóa nhiều ca terminal, nhưng chưa replay
worker thật với input 20–48 ms và render CMNM >500 ms.

**Đề xuất:** runtime test phải chứng minh B đang render không bị hủy chỉ vì C cùng
document/revision; C được giữ queued, B hoàn tất thì trình bày nếu phủ đúng vùng,
cuối cùng C phải được gửi. Chỉ hủy ngay khi đổi document/page/profile/rotation
hoặc request không còn hữu ích theo coverage.

### §SHARP.07 — P2 / M — PXRG bỏ PNG encode nhưng decode vẫn cần đo thực tế

**Bằng chứng:** `createTileSourceFromBytes()` nhận PXRG rồi dựng `ImageData` và
`createImageBitmap`, fallback canvas/BMP. Comment gọi là zero-copy nhưng browser
decode/copy và upload surface chưa có timing tách riêng.

**Đề xuất:** đo bytes, decode, bitmap creation, canvas draw và paint; giữ PXRG nếu
đạt, nhưng không tuyên bố zero-copy hoặc lấy 0,8 ms trong probe làm SLA WebView.

### §SHARP.08 — P2 / M — Cache tile có thể giữ warm nhanh nhưng chưa phản ứng đủ với áp lực

**Bằng chứng:** `TileUrlCache` máy ≥16 GB bình thường không giới hạn; low/mid có
budget theo RAM tổng. Pressure runtime của scene/tile/PPE không có một ledger chung.

**Đề xuất:** cache identity giữ revision/profile/DPI/clip; pressure mode thu cache
theo RAM khả dụng/working set, không hard-cap máy mạnh bình thường. Đo hit/miss,
eviction, current bytes và time-to-sharp sau A→B→A.

## Khuyến nghị lô triển khai

### Lô S0 — Đo time-to-sharp, không đổi hành vi (≤5 file)

Thêm trace/harness cho input → worker → decode → commit → pixel coverage; chạy
CMNM outline, VDP, file chữ live, file nhiều ảnh ở DPR 1/1,25/1,5/2. Chốt p50/p95,
không dùng N=5 làm SLA.

### Lô S1 — Chốt DPI/clip/pixel parity (≤5 file)

Khóa một conversion pt → CSS px → device px; kiểm dimensions, ROI chữ/hairline/
gradient và cache identity. Không đổi DPI budget trước khi pixel gate xanh.

### Lô S2 — In-flight/coalescing runtime (≤5 file)

Kiểm B→C với worker thật; giữ underlay đúng proof, không mất frame, không đói
target cuối. Chỉ sau runtime pass mới cân nhắc timer 48/96 ms.

### Lô S3 — PPE phase optimization (≤5 file)

Tối ưu phase lớn nhất (raster/ICC/resource/encode) bằng retained resource/ROI;
giữ màu, font và overprint. Verify CMNM và VDP cùng binary.

## Gate nghiệm thu

- `first-readable` và `first-sharp` được đo riêng.
- Trong chuỗi zoom 20–48 ms, ảnh đang hiển thị không mất; target cuối vẫn commit.
- Sau dừng input, `target-sharp` đạt trong ngưỡng đã chốt; không nói 60 FPS nếu chưa
  đo input-to-paint.
- Pixel ROI chữ nhỏ/hairline/logo/gradient đúng; dimensions và profile đúng.
- Pan thuần không phát sinh full-page/viewport raster mới khi vùng đã phủ.
- Idle 150 ms không tự tạo request/present vô hạn; cancel ratio có lý do phân loại.
- Máy yếu và máy mạnh đều đo; máy mạnh không bị cap vô điều kiện.

## Chốt audit

Lượt này chỉ audit/đề xuất. **Chưa sửa source, chưa build, chưa cập nhật golden.**
Cần duyệt thứ tự S0→S3 trước khi triển khai theo `prynx-audit-workflow`.
