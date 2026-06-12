# Golden tests — Imposition layout

Khóa hành vi layout-math hiện tại trước khi gộp engine (`imposition_core`).
Thuộc spec `.kiro/specs/imposition-engine-unification` (Task 1, Requirements 8.1/8.2).

## Cách hoạt động
- `test_golden_layout.py` chạy các solver layout công khai với bộ input cố định:
  - Cắt xén: `nup_layout_solver.solve_optimal_layout` / `solve_grid` / `get_src_page_idx`
  - Bế tem: `sticker_imposer.solve_*` (grid, hex, l-shape, cluster, optimal_auto)
- Output được chuẩn hóa (số ô + toạ độ làm tròn 2 chữ số, sắp xếp ổn định) rồi so với `golden_baseline.json`.

## Quy trình
- Lần chạy đầu: nếu `golden_baseline.json` chưa có → tự sinh, test đánh dấu `xfail`. Chạy lại để khóa.
- Các lần sau: mọi sai khác so baseline → test FAIL (báo scenario lệch).

## Cập nhật baseline (chỉ khi đổi hành vi có chủ đích)
Xóa `golden_baseline.json` rồi chạy lại pytest 2 lần. Phải giải thích lý do thay đổi trong PR.

## Chạy
```
cd backend
python -m pytest tests/golden -q
```
