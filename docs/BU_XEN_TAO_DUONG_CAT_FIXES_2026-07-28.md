# Nhật ký sửa bù xén / tạo đường cắt — 2026-07-28

Theo báo cáo `BAO_CAO_AUDIT_BU_XEN_TAO_DUONG_CAT_2026-07-28.md`.

## Lô A — phát hiện suy giảm và cảnh báo, không đổi PDF đầu ra

- `sticker_engine.py`: đo tỷ lệ chuyển màu gắt giữa các pixel kề nhau trên shell
  lấy mẫu. Chỉ lấy tối đa 100.000 pixel để không tạo thêm bản sao raster lớn.
- Khi shell có cả biến thiên sáng lớn và nhiều chuyển màu cao tần, thêm cảnh báo
  “bù xén có thể xuất hiện vệt”; không sửa `bleed_colors`, mask, color space hay
  content stream.
- Cảnh báo của từng trang được gộp với cảnh báo không dò được đường cắt ở cả nhánh
  tuần tự và song song, sau đó đi qua contract `X-Sticker-Warning` hiện có.
- Bổ sung hồi quy cho halo cyan hình tròn, viền hai mảng màu dài (không báo oan),
  gộp nhiều cảnh báo và header API.

## Lô B — sửa shell lấy màu thích nghi (đổi PDF đầu ra có chủ đích)

- `sticker_engine.py`: giữ nguyên mask hình học đường cắt, nhưng tách quyết định
  shell lấy màu. Chỉ khi shell ban đầu có nhiễu cao tần mới thử tối đa bốn độ sâu
  đến 0,60 mm và chọn shell ổn định nhất.
- Viền gồm các mảng màu dài giữ nguyên shell ban đầu; halo AA/JPEG đổi màu sát mép
  được bỏ trước khi nearest kéo ra ngoài.
- Trường hợp màu vẫn bất ổn xuyên vào ruột không bị đoán bừa: giữ cảnh báo fail-loud.
- Quality oracle đo trực tiếp vành ngoài: fixture halo cyan phải trở về màu xanh nền,
  đồng thời fixture hai nửa đỏ/xanh không được đổi mask lấy mẫu.
- Test PDF→raster 300 DPI đạt: vành đo có 100% pixel xanh trong ngưỡng, 0% pixel
  cyan nhạt; không còn cảnh báo sau khi shell được ổn định.

## Lô B.1 — khử răng cưa/viền trắng tại mối nối tem–bleed

- Baseline đọc trực tiếp SMask của PDF cho thấy alpha chỉ có `0/255`; ranh giới
  đường cong vì vậy vẫn là bậc pixel dù màu bleed đã đúng.
- Giữ phần bleed bên ngoài đục hoàn toàn và chồng kín qua vùng halo; chỉ mép trong
  của lớp chồng được feather 0,15 mm bằng smoothstep trước khi trả về artwork.
- Không đổi đường cắt, kích thước bleed, color space hay Form XObject gốc.
- Quality oracle khóa cả cấu trúc SMask có alpha trung gian và tính đơn điệu của
  dải chuyển tiếp để tránh tái xuất hiện sợi trắng/răng cưa.

## Trạng thái

Đã verify tự động:

- `py_compile app/workers/sticker_engine.py`: đạt.
- `pytest tests/test_sticker_engine_e2e.py -q`: 38 passed.
- `pytest tests/test_sticker_engine_e2e.py tests/test_sticker_parallel_fallback.py -q`:
  56 passed.

Lô A đã được nghiệm thu trên ứng dụng. Màu của Lô B đã được nghiệm thu. Lô B.1 đã
qua `py_compile`, hai quality oracle riêng (`2 passed`) và toàn bộ test sticker +
song song (`58 passed`); đang chờ nghiệm thu mối nối tem–bleed trên file thật.