# NHẬT KÝ SỬA CHỮA XUẤT ẢNH CHUẨN MÀU — 2026-09-22

> **Đợt sửa:** Lô 1 & Lô 2 — Chuẩn hóa Grayscale trắc màu, an toàn WebP ICC, và đồng bộ profile PPE CMYK.
> **Báo cáo gốc:** `docs/BAO_CAO_AUDIT_XUAT_ANH_TOAN_DIEN_2026-09-22.md`.
> **Mã phát hiện xử lý:** `EXPCOLOR21.03`, `EXPCOLOR21.04`, `EXPCOLOR22.01`.
> **Số file thay đổi:** 3 file (tuân thủ giới hạn $\le 5$ file / lô).

---

## 1. CÁC THAY ĐỔI CHI TIẾT THEO FILE

### 1.1. `backend/app/core/icc_profiles.py` (§EXPCOLOR22.01)
* **Thay đổi:** Nâng cấp hàm `resolve_profile_path(profile_id)`: Nếu `profile_id` là một đường dẫn file ICC hợp lệ trên đĩa (ví dụ profile OutputIntent trích xuất ra file tạm), hàm lập tức trả về đường dẫn tuyệt đối đã chuẩn hóa thay vì chỉ tra cứu trong `PROFILE_REGISTRY`.
* **Lý do:** Cho phép PPE `ppe_export_cmyk` nạp được các profile ICC động trích xuất trực tiếp từ file PDF nguồn (như GRACoL 2013, Japan Color) thay vì bị giới hạn trong danh sách bundle tĩnh.
* **Cách kiểm tra:** `test_resolve_ppe_cmyk_profile_wires_output_intent` kiểm tra `resolve_cmyk_profile_path` phân giải chính xác đường dẫn file tạm.

### 1.2. `backend/app/api/routes/export.py` (§EXPCOLOR21.03, §EXPCOLOR21.04, §EXPCOLOR22.01)
* **Thay đổi 1 (§EXPCOLOR21.03 — Grayscale Colorimetric):**
  * Thêm hàm `_get_srgb_to_gray_transform()` dựng pipeline LittleCMS chuyển đổi từ `sRGB IEC61966-2.1` sang `Gray Gamma 2.2` (Relative Colorimetric, Intent 1).
  * Trong vòng lặp render trang (`render_pdf_to_images`), khi `color_mode == 'gray'`, áp dụng `ImageCms.applyTransform(rgb_source, _get_srgb_to_gray_transform())` thay vì gọi `.convert('L')` ITU-R 601 luma thô sơ.
* **Thay đổi 2 (§EXPCOLOR21.04 — WebP Grayscale Safe):**
  * Khi xuất định dạng `webp` ở chế độ `color_mode == 'gray'`, chuyển `img` sang mode `RGB` (với 3 kênh xám đồng nhất $R=G=B$) và gắn profile `sRGB` chuẩn.
  * Tránh hoàn toàn lỗi của Pillow ghi WebP 3 kênh nhưng nhúng ICC 1 kênh `GRAY`, loại bỏ lỗi crash `cannot build transform` trên Photoshop và LittleCMS.
* **Thay đổi 3 (§EXPCOLOR22.01 — PPE CMYK Profile Wiring):**
  * Thêm hàm `_resolve_ppe_cmyk_profile(src_path, cmyk_profile)`.
  * Truyền tham số `cmyk_profile_id=ppe_cmyk_profile` vào lời gọi `ppe_export_cmyk` trong `render_page(pno)`.
  * Đảm bảo PPE dựng màu CMYK bằng đúng profile đích/nguồn (OutputIntent hoặc FOGRA39/SWOP), triệt tiêu mismatch giữa PPE render và ICC tag nhúng ngoài file.

### 1.3. `backend/tests/test_export_images.py`
* **Thay đổi:** Bổ sung 3 unit test tự động mới:
  1. `test_grayscale_export_colorimetric_accuracy`: Kiểm tra màu đỏ tươi `RGB(1,0,0)` khi xuất Grayscale đạt mức xám trắc màu chuẩn 129 (thay vì 76 của ITU-R 601 cũ).
  2. `test_webp_grayscale_export_valid_icc`: Kiểm tra file WebP Grayscale mở lại và chuyển đổi CMS mượt mà, không gặp lỗi `cannot build transform`.
  3. `test_resolve_ppe_cmyk_profile_wires_output_intent`: Kiểm tra OutputIntent được trích xuất và truyền vào PPE chuẩn xác.

---

## 2. KẾT QUẢ KIỂM THỬ XÁC MINH (VERIFICATION)

1. **Backend Tests:**
   * `pytest tests/test_export_images.py`: **47/47 passed** (bao gồm 3 test mới).
   * `pytest tests/test_icc_and_color_preview.py`: **31/31 passed**.
2. **Frontend Typecheck & Tests:**
   * `npm run typecheck` (tsc): **0 lỗi**.
   * `npx vitest run src/components/workspace/ExportImageModal.test.ts`: **10/10 passed**.
3. **Artifact Thực tế trên `file goc.pdf`:**
   * Xuất Grayscale PNG: Kích thước $1616 \times 766$, mode `L`, nhúng `Gray Gamma 2.2` ICC.
   * Xuất Grayscale WebP: Kích thước $1616 \times 766$, mode `RGB` đồng nhất xám, nhúng `sRGB` ICC, CMS transform xác minh thành công.
   * Xuất CMYK Auto: Kích thước $3366 \times 1594$, mode `CMYK`, nhúng nguyên vẹn 3,462,308 bytes `GRACoL 2013`, PPE tiếp nhận profile trích xuất thành công.
