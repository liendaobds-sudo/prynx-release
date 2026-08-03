# BÁO CÁO AUDIT RESIZE TRANG CÓ VÙNG TRONG SUỐT

**Ngày:** 2026-08-03
**Phạm vi:** PDF tạo từ Combine ảnh PNG/APNG hoặc PDF bên ngoài còn alpha → công cụ Resize → PDF kết quả.
**Trạng thái:** đã triển khai và verify tự động; smoke backend trên đúng PDF Combine 301.879.277 byte đã đạt. UI Tauri thực tế còn cần người dùng xác nhận trực quan sau khi app nạp sidecar/frontend mới.

## 1. Kết luận điều hành

Combine đang giữ đúng khổ trang và alpha của ảnh nguồn. Ca kiểm chứng gần nhất có trang `100 × 100 mm`, Image XObject `3000 × 3000` và `/SMask`; phần nhìn thấy chỉ chiếm khoảng `73,6% × 87,3%` trang.

Sai lệch xuất hiện ở Resize: đường content-aware render trang thành RGB, dò bounding box khác trắng rồi crop vật lý trước khi tính tỷ lệ. Vì vậy vùng trong suốt thuộc khổ gốc bị xem như phần thừa, làm khổ/tỷ lệ đầu ra bám theo con tem thay vì toàn bộ trang.

Hành vi cần chốt:

- Mặc định **tắt** `Resize theo nội dung`: trang có alpha dùng toàn bộ `CropBox/MediaBox`, giữ vùng trong suốt và tỷ lệ khổ gốc.
- Chỉ hiện tùy chọn khi PDF còn transparency thật trong cấu trúc PDF; không suy đoán từ đuôi PNG/JPEG/PDF.
- Khi bật, chỉ trang có transparency được phép bỏ vùng trong suốt ngoài nội dung; trang không có transparency giữ hành vi resize hiện có.
- PDF hỗn hợp được xử lý theo từng trang.
- Trang có transparency không được đi đường raster RGB hoặc Ghostscript downsample có nguy cơ flatten alpha; giữ đường Form/XObject và `/SMask`.
- PDF đã flatten alpha hoặc đã crop trước khi xuất không còn đủ dữ liệu để biết nguồn từng là PNG.

## 2. Phát hiện có bằng chứng

| Mã | Mức | Effort | Bằng chứng | Kết luận |
|---|---|---:|---|---|
| §TR.1 | P1 | M | `backend/app/workers/resize_background_engine.py:450-489` render RGB, `_find_nonwhite_content_bbox()` rồi `_physical_crop_page()` | Vùng alpha ngoài con tem bị loại trước khi tính tỷ lệ. |
| §TR.2 | P1 | M | `backend/app/workers/resize_background_engine.py:499-508` tính `fixed_width/fixed_height` từ `content_width_pt/content_height_pt` sau crop | Khổ khóa một chiều bám theo con tem thay vì khổ 100 × 100 mm. |
| §TR.3 | P1 | M | `backend/app/workers/pdf_tools_engine.py:629-642` có thể chọn `_raster_resize()` trong mode `auto/raster` | Trang alpha có thể bị dựng lại RGB và mất `/SMask`. |
| §TR.4 | P2 | S | `desktop/src/components/preprocess-tools/PageResizerTool.tsx` chưa nhận file/inspection và chưa có `resizeByContent` | Người dùng không có cách chủ động chọn giữ khổ hay bám nội dung. |
| §TR.5 | P2 | S | `backend/app/core/pdf_actions_native.py:1733-1836` đã phát hiện transparency toàn tài liệu nhưng chưa trả theo từng trang | Có thể tái sử dụng traversal cấu trúc PDF, không cần nhận diện theo tên file. |

## 3. Hợp đồng triển khai

Inspection trả JSON:

```json
{
  "has_transparency": true,
  "transparent_pages": [1, 3]
}
```

`transparent_pages` dùng số trang 1-based ở biên API/UI. Engine nội bộ chuyển về chỉ số 0-based.

Resize nhận thêm `resize_by_content=false`. Cờ này chỉ thay đổi cách xử lý trang có transparency:

- `false`: dùng toàn bộ vùng nhìn thấy của trang;
- `true`: dò bounding box nội dung rồi crop;
- trang opaque: giữ hành vi content-aware hiện có để không hồi quy tính năng xén viền trắng/nền động.

## 4. Thứ tự sửa theo lô

1. **Lô 1 — inspection backend:** phát hiện transparency theo từng trang, endpoint inspection, regression cấu trúc PDF.
2. **Lô 2 — engine resize:** truyền `resize_by_content`, khóa đường vector cho alpha, regression khổ trang và `/SMask`.
3. **Lô 3 — frontend:** API inspection/resize, checkbox điều kiện, state mặc định, i18n và test handler/UI.
4. **Closeout:** pytest tập trung, Vitest tập trung, typecheck, rà diff và smoke runtime trên file Combine thực tế nếu sidecar/app đang sẵn sàng.

Mỗi lô tối đa năm file; không chạm các thay đổi khuôn bế/logo đang tồn tại trong working tree.

## 5. Kết quả triển khai

- Inspection nhận đúng ảnh alpha trực tiếp, `/Mask`, `/SMask`, Form XObject lồng, transparency group và ExtGState theo từng trang.
- `resize_by_content=false` mặc định giữ toàn `CropBox/MediaBox` của trang alpha; `true` mới crop theo nội dung nhìn thấy.
- Mode `auto/raster` không được raster RGB hoặc fallback Ghostscript khi tài liệu còn transparency; Form/XObject và SMask được giữ.
- UI chỉ hiện checkbox sau khi inspection xác nhận file hiện tại có trang transparency.
- Typecheck đạt; Vitest tập trung 31/31; pytest resize alpha 47/47 và nhóm PDF liên quan 63 pass, 1 skip.

Smoke trên file Combine thực tế 72 trang, 301.879.277 byte:

| Chế độ | Khổ trang 1 sau resize khóa rộng 50 mm | Transparency trang 1 | Thời gian |
|---|---:|---:|---:|
| Tắt Resize theo nội dung | 50 × 50 mm | Còn | 0,617 s |
| Bật Resize theo nội dung | 50 × 59,413 mm | Còn | 0,619 s |

Hai output smoke khoảng 300 MB/file đã được xóa sau kiểm tra.
