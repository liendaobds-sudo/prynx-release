# Nhật ký sửa Bình cắt xén — dải trắng tại ranh giới hai trang A5

- Ngày: 2026-09-01
- Audit unit: `W2-U01-CLIPOWN`
- Finding: `§CLIPOWN.1`
- Báo cáo gốc: `docs/BAO_CAO_AUDIT_BINH_CAT_XEN_LOI_TRANG_RANH_GIOI_2026-09-01.md`

## Phạm vi được duyệt

Lô 1 sửa quyền sở hữu clip của Bình cắt xén thường. Lô này không đổi writer PDF, không đổi `blockId=product_id`, không cập nhật snapshot/golden và không sửa Tem bế, CNC hoặc Page Sheet.

Finding độc lập `§CANONFAIL.1` về canonicalization fail-open thuộc Lô 2, vẫn `P1 MỞ`; chưa được duyệt và chưa sửa.

## Nguyên nhân đã sửa

Worker cũ dựng bbox riêng cho từng `(cluster_idx, blockId)`. Hai sản phẩm `mixed_guillotine` kề nhau vì thế cùng coi seam chung là mép ngoài và cùng nhận full bleed. Với hai A5 có bleed trắng opaque `3 mm` đặt sát nhau trên A4, hai output clip overlap `6 mm`; Form vẽ sau phủ trắng `3 mm` vào trim của Form vẽ trước.

Toán tử PDF `re W n` và writer không sai; rectangle ownership đầu vào writer mới là nguồn lỗi.

## Thay đổi theo file

### `backend/app/workers/nup_artwork.py`

- Thêm `compute_output_clips()` để tính bốn cạnh clip từ láng giềng hình học của mọi placement trên cùng một output sheet, không dùng `blockId` hoặc `cluster_idx` làm biên ownership.
- Dùng sweep theo từng trục kết hợp range-max index, độ phức tạp `O(N log N)`; không quét mọi cặp placement và không thêm hard cap theo số placement.
- Gap 0 cho hai clip gặp đúng seam. Với gap `g`, mỗi phía nhận tối đa `min(bleed, g/2)`. Cạnh không có láng giềng giữ full bleed.
- Đặt `_CLIP_COORD_EPSILON_PT = 0.01 pt` để nhận ra hai cạnh cùng seam bị lệch/chồng nhau dưới điểm in do cộng và làm tròn nhiều trường hình học. Đây là cơ chế giải thích các ca lỗi hiếm: dung sai `1e-6 pt` trước review có thể bỏ sót đúng các láng giềng chịu sai số serialize/deserialize.
- Dung sai chỉ mở cửa nhận diện candidate; helper vẫn tính gap từ tọa độ thật. Vì vậy khe dương `0.005 pt` vẫn được giữ và chia `0.0025 pt` mỗi phía, không bị nhập nhầm thành gap 0.
- Nới projection bảo thủ theo bleed để clip chữ nhật không đi vào trim của placement chỉ chạm hoặc gần góc; không cố biểu diễn notch mà rectangle không hỗ trợ.
- Thêm override `output_clip` cho `place_one_artwork()`. Sentinel riêng phân biệt “caller không truyền” với override `None` hợp lệ khi bleed bằng 0, nên consumer legacy vẫn giữ đúng hành vi.
- Giữ `compute_block_bbox()` cho Tem bế/CNC và consumer ngoài phạm vi.

### `backend/app/workers/nup_process_chunk.py`

- Tính `compute_output_clips(placements, bleed_pt)` đúng một lần cho mỗi output sheet.
- Gate chính xác `not is_die_cut and not page_sheet_mode`: chỉ Bình cắt xén thường đi qua ownership toàn tờ.
- Truyền clip theo identity của placement vào `place_one_artwork()` bằng override tường minh.
- Tem bế/CNC và Page Sheet tiếp tục dùng bbox block legacy; lô này không đổi hợp đồng clip theo hình khuôn.

### `backend/tests/test_mixed_guillotine_export.py`

- Thêm regression end-to-end hai trang có MediaBox `154 × 216 mm`, trim A5 `148 × 210 mm`, bleed trắng opaque `3 mm`, đặt sát nhau trên A4 ngang `297 × 210 mm`.
- Parse content stream để khóa hai `re W n` gặp nhau đúng seam trim, không overlap; đồng thời khóa full bleed ở hai cạnh ngoài.
- Raster PDF thật và dò dải quanh seam để chặn hồi quy dải trắng opaque `3 mm`.
- Thêm unit test gap dương `4 pt` chia `2 pt` mỗi phía, giữ outer bleed `10 pt`.
- Thêm unit test corner-touch để clip chữ nhật không đi vào trim của placement chéo góc.
- Thêm `test_output_clips_tolerate_sub_point_rounding_overlap_at_zero_gap` cho seam gap 0 bị tiny-overlap sau làm tròn; đồng thời xác nhận khe dương `0.005 pt` vẫn chia theo giá trị thật.

## Verify

Chạy riêng file regression:

```powershell
.\backend\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider backend/tests/test_mixed_guillotine_export.py
```

Kết quả: `13 passed`.

Chạy nhóm mixed export + adapter + logical CropBox:

```powershell
.\backend\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider `
  backend/tests/test_mixed_guillotine_export.py `
  backend/tests/test_mixed_guillotine_adapter.py `
  backend/tests/test_nup_logical_cropbox.py
```

Kết quả: `32 passed`.

Lượt 32 test đã bao gồm 13 test của file regression; không cộng hai con số thành 45 test độc lập. Không cập nhật snapshot/golden.

Review độc lập:

- parity với oracle brute-force đạt trên `15.800` cấu hình;
- benchmark synthetic helper: 10k placement khoảng `0,34 s`, 40k placement khoảng `1,44 s`.

Các số đo này xác nhận cấu trúc sweep/index ở tầng helper; chưa thay thế benchmark end-to-end trong runtime app.

Compatibility verify bổ sung:

- nhóm mixed/logical + clip-shape/cut-border/page-fallback/homogeneous: `89 passed`;
- nhóm CNC + sheet-plan parity: `44 passed`, chạy ngoài sandbox vì Windows named pipe;
- warning Pydantic là cảnh báo baseline cũ, không phát sinh từ bản vá.

Các lượt compatibility có chồng lấp phạm vi với test hẹp; không cộng thành một tổng test duy nhất.

## Kiểm chứng trên đúng PDF nguồn của người dùng

Không lưu đường dẫn Desktop cá nhân trong tài liệu; nguồn được định danh bằng:

- tên file: `Adjusted page size 1.pdf`;
- SHA-256: `E7D9B7EC5849416CD5F6A77BF936387263F1397D21F0A5D63926B98E0AF2F691`;
- 8 trang đồng nhất, khoảng `145 × 205 mm`;
- MediaBox/CropBox có gốc khác 0; không khai báo TrimBox/BleedBox/ArtBox.

Đã gọi trực tiếp public `run_nup_engine()` ở hai route:

- `mixed_guillotine`, bleed `3 mm`, làm probe chẩn đoán ownership trên chính nội dung khách;
- `sequential`, bleed `2 mm`, gap `0`, là route đúng cho nguồn đồng nhất.

Cả hai route đều tạo 4 tờ A4, đúng 2 lệnh `Do` trên mỗi tờ. Với route `sequential`, cả 4 tờ đều có hai interval clip theo trục x `[(15.5908, 420.9455), (420.9455, 826.3002)] pt`: hai clip gặp đúng seam `420.9455 pt`, không overlap và không hở.

Raster quanh seam xác nhận không cross-paint:

- tờ 2: trái màu cam `0/23` pixel trắng, phải là vùng source-white `23/23`;
- tờ 3: trái là vùng source-white `22/23`, phải màu cam `0/23` pixel trắng.

SHA-256 của PDF nguồn không đổi sau các lượt chạy. File có gốc Media/Crop khác 0 nhưng canonicalization đã thành công; đây không phải bằng chứng đóng `§CANONFAIL.1`, vốn mô tả nhánh canonicalization **thất bại** rồi N-Up vẫn fail-open.

## Trạng thái và khoảng trống còn lại

- `§CLIPOWN.1`: `FIXED · AUTO + ARTIFACT`; fixture regression A5 → A4 và đúng PDF nguồn khách đều đã verify.
- PDF khách đạt `EXACT CUSTOMER ARTIFACT VERIFIED` qua public backend engine: 4 tờ A4, 2 `Do`/tờ, seam kín và raster không cross-paint.
- Chưa `RUNTIME`: chưa thao tác lại trên UI/app hoặc installer thật; cũng chưa có PDF kết quả lỗi lịch sử để so sánh output trước–sau.
- Gap dương, tiny-overlap do làm tròn và corner-touch đã có unit test; ca xoay block, `splitGap` dương và hình L chưa có artifact riêng.
- Đã có parity brute-force `15.800` cấu hình và benchmark synthetic tới 40k placement; benchmark runtime app vẫn còn thiếu.
- `§CANONFAIL.1`: `CONFIRMED · P1 MỞ`; ngoài phạm vi Lô 1, chưa sửa.
