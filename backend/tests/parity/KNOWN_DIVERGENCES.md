# Known Rust ↔ Python divergences (cần xử lý ở Task 14)

Phát hiện khi cài `pdfcompare_native` (Rust ON) và chạy golden/parity.
Đây là khác biệt **có sẵn từ trước** giữa hai bản triển khai, không do refactor native→core.

## 1. `sticker_cluster_grid` với params mặc định (None)
- Python fallback: ~24 item (như grid thường).
- Rust: ~48 item — sinh 2 item CHỒNG NHAU mỗi cell khi `dx=dy=0` (item A và B cùng vị trí).
- Bản chất: code gốc Rust `sticker_cluster_grid` khi params None đặt item B tại `(base_x+dx, base_y+dy)` = trùng item A.
- Lưu ý: production thường gọi với params hợp lệ (dx_outer... do orchestrator tính), nên ít gặp; nhưng khác biệt cùng-input là có thật.

## 2. `optimal_auto` / `l_shape` — khác thứ tự & toạ độ ô
- Cùng SỐ LƯỢNG (vd 43, 157) nhưng sắp xếp ô khác nhau giữa Rust và Python.
- Ảnh hưởng vị trí cụ thể từng tem dù sức chứa bằng nhau.

## 3. `shape_hammer` (búa) — Rust thiếu L-shape fill nội bộ  → ĐÃ XỬ LÝ 2026-06-21
- Rust `core::hammer` chỉ trả KHỐI CHÍNH; Python `_py_solve_illustrator_hammer_layout` khi
  `disable_l_shape=False` còn thêm fill lồng ghép qua `evaluate_unified_asymmetric`.
- Đo thật (búa 60×140, tấm 800×1100, gap 6): Rust=115 vs Python=122 item; widthUsed 724 vs 790.
- Chỉ khớp khi `disable_l_shape=True` (115=115).
- **Fix (F1):** wrapper `solve_illustrator_hammer_layout` chỉ gọi Rust khi `disable_l_shape=True`
  (hot path fill); nhánh full-fill (top-level, 1 lần/trang) dùng Python → khôi phục fill cho búa
  + đảm bảo parity. Thêm test `test_sticker_hammer_parity_disable_lshape` +
  `test_hammer_wrapper_full_fill_uses_python`.

## Quyết định hiện tại
- Golden baseline khóa theo **Rust ON** (cấu hình production thực ship).
- Khi `IMPOSITION_ALLOW_PY_FALLBACK` được nối (Task 14), cần:
  1. Hoặc sửa Python fallback khớp Rust (ưu tiên — Rust là nguồn chân lý), hoặc
  2. Đánh dấu fallback là "không đảm bảo parity" và fail-fast khi thiếu Rust (Req 7).
- Cân nhắc sửa luôn lỗi cluster None-params (item chồng nhau) trong `imposition_core` nếu xác nhận là bug, kèm cập nhật golden có chủ đích.
