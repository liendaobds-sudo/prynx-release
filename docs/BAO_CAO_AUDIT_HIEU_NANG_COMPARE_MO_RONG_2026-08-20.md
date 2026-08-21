# PHỤ LỤC AUDIT HIỆU NĂNG COMPARE TRANG LỚN MỞ RỘNG — 2026-08-20

**Phạm vi:** Ba nhánh còn lại của Đối chiếu PDF: CMYK, hai trang khác kích thước
và bình bài/bình nhiều bản.
**Mục tiêu:** Không hạ DPI, không fallback full-frame gây OOM; giữ verdict, vùng lỗi,
thống kê bình bài và hợp đồng artifact hiện hữu.
**Trạng thái duyệt:** Chủ dự án đã yêu cầu “làm hết”; triển khai toàn bộ phụ lục này
theo lô tối đa 5 file, verify xong từng lô.

## Kết luận điều hành

Ba nhánh đều tối ưu được nhưng không thể dùng nguyên comparator tile 1:1:

1. CMYK dùng RGB làm nguồn verdict, sau đó mới tính trung bình lệch C/M/Y/K trên
   từng vùng lỗi. Vì vậy chỉ cần stream RGB toàn trang và render CMYK theo ROI lỗi.
2. Hai trang khác kích thước có hai semantics hiện hữu: cùng aspect và chênh diện
   tích dưới 1,8× thì resize bên nhỏ lên bên lớn; các ca còn lại pad trắng về khung
   lớn nhất. Resize phải giữ đúng OpenCV `INTER_AREA`, nên cần staging `memmap`.
3. Bình bài đang dùng `matchTemplate` toàn tờ ở full DPI rồi so từng instance. Trang
   lớn phải đổi thành dò toàn cục trên preview, tinh chỉnh tọa độ ở full DPI và chỉ
   render ROI của từng instance.

## Phát hiện và phương án

### §CLX.1 — [P1 / M] CMYK lớn bị chặn dù verdict đã là RGB

**Bằng chứng:** `image_comparator.py:654-708` gọi comparator RGB trước; CMYK chỉ được
đọc lại trong bbox lỗi để gắn mô tả. `comparison_engine.py` hiện loại `is_cmyk_mode`
khỏi `_page_tile_eligible`.
**Sửa:** tile RGB như nhánh 1:1; với mỗi `DiffRegion`, render bundle CMYK đúng ROI A/B,
tính mean từng kênh và giữ ngưỡng mô tả `>5` như đường full-frame.

### §CLX.2 — [P1 / L] Trang khác kích thước thiếu hệ ánh xạ tile

**Bằng chứng:** `_compare_scaled()` resize toàn ndarray nhỏ bằng `INTER_AREA`; nhánh
khác aspect gọi `_normalize_dimensions()` để pad trắng. Reader tile hiện bắt buộc hai
ảnh cùng raster.
**Sửa:** pad-reader trả trắng ngoài biên; scaled-reader dùng RGB staging disk-backed,
`cv2.resize(..., dst=memmap)` để giữ kernel OpenCV hiện tại rồi cấp tile theo khung
đích. Admission đĩa tính đủ staging và tự dọn khi hủy/lỗi.

### §CLX.3 — [P1 / L] Bình bài lớn cần tách detect và verify

**Bằng chứng:** `_compare_imposition()` giữ cả template và imposed full raster,
`matchTemplate` toàn tờ, rồi crop từng instance. Tờ 65 MP đã khiến riêng full-frame
đạt đỉnh hàng GiB.
**Sửa:** preview giới hạn dùng đúng 4 góc xoay/NMS/multi-scale hiện hữu để tìm ứng viên;
quy đổi box về full DPI; render template full nếu dưới ngưỡng, nếu vượt ngưỡng dùng
staging; tinh chỉnh từng box bằng cửa sổ full-DPI nhỏ; so pixel từng instance theo
ROI, giữ morphology/AA-filter/micro-rescue hiện tại.

### §CLX.4 — [P1 / M] Route đang từ chối ba nhánh trước engine

**Bằng chứng:** `_large_page_tile_compatible()` chỉ nhận `comparison_mode=full`, không
imposition và các size khớp.
**Sửa:** route admission theo chiến lược cụ thể và dung lượng staging; chỉ 413 khi
TEMP/RESULTS thiếu hoặc metadata không đủ để lập chiến lược an toàn.

## Lộ trình đã duyệt

1. **Lô A, ≤5 file:** CMYK tile + test parity mô tả kênh/artifact.
2. **Lô B, ≤5 file:** pad/resize khác kích thước + staging/admission + parity.
3. **Lô C1, ≤5 file:** tách primitive detect/verify bình bài và test parity nhỏ.
4. **Lô C2, ≤5 file:** engine/route/artifact bình bài lớn + smoke/benchmark.
5. **Verify cuối:** pytest Compare/API, typecheck/lint frontend, process-spawn và
   smoke ở nguyên DPI cho cả ba nhánh.

## Gate nghiệm thu

- CMYK 65 MP hoàn tất ở DPI yêu cầu; mô tả C/M/Y/K trùng full-frame corpus nhỏ.
- Cặp khác kích thước forced-tile có verdict/mask/region/artifact trùng full-frame.
- Bình bài forced-large giữ `total_instances`, `failed_instances`, vùng lỗi và
  `match_scale`; không render toàn tờ imposed ở full DPI.
- Máy ≥16 GB không bị hard-cap worker; máy <8/<16 GB giảm theo policy hiện hữu.
- Hủy/lỗi dọn sạch `.part`, memmap và PageResult dở dang.
