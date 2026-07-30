# NHẬT KÝ — BÌNH CẮT XÉN NHIỀU KÍCH THƯỚC

**Ngày bắt đầu:** 30/07/2026  
**Đặc tả đã duyệt:** `docs/BAO_CAO_AUDIT_BINH_CAT_XEN_NHIEU_KICH_THUOC_2026-07-30.md`

## Lô 0 — Characterization và khóa hồi quy hiện tại

**Trạng thái:** hoàn tất.

### Mục tiêu

- Khóa hành vi cũ: `sequential` từ chối trang khác kích thước.
- Khóa hành vi cũ: nhiều mẫu cùng kích thước vẫn xuất trên cùng tờ.
- Khóa preview: nhiều trang vật lý cùng kích thước vẫn hiện đủ từng mẫu.
- Chưa thêm `mixed_guillotine`, chưa thay đổi code sản phẩm.

### File trong lô

1. `backend/tests/test_mixed_guillotine_characterization.py`
2. Tài liệu này

### Verify

- Test hẹp characterization: **2 passed**.
- Nhóm guillotine/zone mở rộng: **41 passed**.

## Lô 1 — Solver thuần và cây cắt

**Trạng thái:** hoàn tất.

### Mục tiêu

- Thêm solver `ProductSpec → MixedGuillotinePlan` độc lập với PDF/UI.
- Sinh layout nhiều kích thước theo các vùng guillotine xác định, có placements và cây cắt để kiểm chứng.
- Giữ kết quả deterministic, kiểm tra bounds, overlap, rotation, số lượng và tính hợp lệ của cây cắt.

### File trong lô

1. `backend/app/workers/mixed_guillotine.py`
2. `backend/tests/test_mixed_guillotine_solver.py`

### Verify

- `py_compile` cho `mixed_guillotine.py`: **đạt**.
- Test hẹp solver mới: **18 passed**.
- Nhóm guillotine/zone/mixed mở rộng: **59 passed**.

## Lô 3 — Preview dùng chung plan với export

**Trạng thái:** hoàn tất.

### Mục tiêu

- Bổ sung contract `duplex_flip_edge` và `mixed_guillotine_strategy` cho preview.
- Định tuyến riêng `mixed_guillotine` trước guard cùng kích thước và các nhánh cluster/NFP cũ.
- Đọc trim của mọi trang qua adapter chung, dựng đúng `MixedGuillotinePlan` như export.
- Trả `cells` của mặt đầu để tương thích cũ và `sheets` theo từng mặt của tờ mẫu; không nhân response theo `runCount`.
- Trả `planHash`, version, cut tree/cut segments, số tờ vật lý và lỗi 422 tiếng Việt cho cặp hai mặt không hợp lệ.

### File trong lô

1. `backend/app/api/routes/imposition.py`
2. `backend/tests/test_mixed_guillotine_preview.py`
3. Tài liệu này

### Verify

- `py_compile` cho route và test mới: **đạt**.
- Test hẹp preview mới (gồm lề bất đối xứng): **10 passed**.
- Ma trận preview/export/solver/adapter/hồi quy liên quan: **66 passed, 2 warnings**.
- Test tích hợp xác nhận preview và export sinh **cùng `planHash`** từ cùng PDF/cấu hình.
