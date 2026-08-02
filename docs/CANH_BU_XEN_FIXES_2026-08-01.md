# Nhật ký sửa chọn cạnh bù xén — 2026-08-01

## Lô A — §CBS.1: loại bỏ dải trắng ở cạnh không bù xén

Trạng thái: **đã triển khai và verify tự động; chờ xác nhận runtime của người dùng**.

### Thay đổi

- `backend/app/workers/sticker_engine.py`
  - Với `rectangle_mode` dùng raster (`inpaint`, `trajectory`, `solid`), clip artwork
    trực tiếp theo hình chữ nhật vật lý của trang.
  - Không trace mask full-page qua contour OpenCV cho clip rectangle nữa; nhờ vậy
    không còn hụt tọa độ `H - 1` ở cạnh dưới.
  - Lượng lẹm mép vẫn lấy theo số pixel raster đã lượng tử để clip khớp SMask.
  - Nhánh contour của Bế tem nhãn và thuật toán sinh màu bù xén không thay đổi.

- `backend/tests/test_sticker_engine_e2e.py`
  - Thêm ma trận 20 ca: 4 mode màu × 5 cấu hình cạnh (`all`, `left`, `right`,
    `bottom`, `top`).
  - Pixel oracle soi hai pixel cuối ở giữa cạnh dưới tại render 600 DPI.
  - Trước fix: 9 ca đỏ (`left/right/top` × `inpaint/trajectory/solid`) với
    RGB(255,255,255), tương đương dải trắng 0,0847 mm ở nguồn 300 DPI.
  - Sau fix: 20/20 ca đạt.

### Verify

```text
python -m py_compile app/workers/sticker_engine.py
→ đạt

pytest test mới
→ 20 passed, 43 deselected

pytest test_sticker_engine_e2e.py test_mirror_bleed_origin.py test_sticker_page_canvas.py
→ 85 passed, 2 warnings
```

Hai warning là warning deprecation có sẵn của Pydantic/ReportLab, không phát sinh từ
bản sửa.

### Kiểm tra tay còn thiếu

Trong app: **Tạo đường cắt (bù xén) → Xén vuông góc**, lần lượt thử chỉ Dưới, chỉ
Trên, chỉ Trái, chỉ Phải với các mode Làm mượt, Theo quỹ đạo và Đổ màu trơn; phóng
lớn cạnh không bù để xác nhận không còn sợi trắng. Sau khi người dùng xác nhận mới
sang Lô B (`/Rotate`) theo quy trình audit.

