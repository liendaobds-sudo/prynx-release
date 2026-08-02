# Nhật ký sửa — Dấu xén Dàn nhiều kích thước

Ngày: 2026-08-01  
Đặc tả đã duyệt: `docs/BAO_CAO_AUDIT_DAU_XEN_MIXED_GUILLOTINE_2026-08-01.md`  
Phương án: **A — giữ dấu thành phẩm Rust, chỉ vẽ endpoint của segment tách zone thật.**

## Lô 1 — Tách renderer dấu thành phẩm và dấu phân vùng

**Trạng thái:** code và test tự động đạt; chưa kiểm tay PDF trong ứng dụng thật.

### Thay đổi

1. `backend/app/workers/nup_engine.py`
   - Không chiếu `cutLines` mixed thành lưới `{v,h}`.
   - Không tự thêm bốn mép `usableRect`.
   - Chỉ chuyển các segment `kind='zone'` với đầy đủ `axis/coordinate/start/end`.

2. `backend/app/workers/nup_process_chunk.py`
   - `markType='none'` tắt cả renderer marks Rust và renderer marks cấp vùng.
   - Mixed-guillotine đi renderer segment; cluster tile cũ vẫn đi renderer lưới.

3. `backend/app/workers/cluster_tile_engine.py`
   - Thêm `draw_segment_cut_marks`: mỗi segment chỉ sinh hai dấu endpoint.
   - Giữ hỗ trợ nét đơn/nét đôi Nhật và khử trùng nét trùng.
   - Không tạo tích Descartes giữa các toạ độ dọc/ngang.

4. `backend/tests/test_mixed_guillotine_export.py`
   - Khóa 2 endpoint/segment.
   - Khóa `markType='none'` không gọi renderer marks.
   - Khóa mixed không quay lại `draw_tile_cut_marks` và chỉ truyền segment zone.

### Verify

- `py_compile` 4 file: **đạt**.
- Test hẹp export mixed: **9 passed, 2 warnings**.
- Ma trận mixed/guillotine/marks mở rộng: **91 passed, 2 warnings**.
- `git diff --check`: **đạt**.

Hai warning đều có sẵn từ Pydantic v2 và `reportlab.rl_safe_eval`; không phát sinh từ bản sửa.

### Còn cần kiểm tay

Chạy ứng dụng thật với đúng đường vào `Bình cắt xén → Dàn nhiều mẫu → Dàn nhiều kích thước`:

- `Dấu xén đầy đủ`: từng cụm vẫn đủ dấu thành phẩm; giữa các zone chỉ còn dấu ở hai endpoint của đường tách thật.
- `Không vẽ dấu xén`: output không có dấu thành phẩm hoặc dấu phân vùng.
- Kiểu Nhật: endpoint zone là nét đôi đúng khoảng bleed.
- Một mặt và hai mặt: dấu zone mặt sau bám đúng cut segment đã mirror.
