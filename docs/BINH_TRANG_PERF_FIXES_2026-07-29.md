# NHẬT KÝ TỐI ƯU TỐC ĐỘ BÌNH TRANG

**Ngày:** 29/07/2026  
**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_TOC_DO_BINH_TRANG_2026-07-29.md`  
**Ca chuẩn:** 13 trang, 13 khuôn riêng, `groups=13`, `reused=0`.

## Lô 1 — PERF-IMPO-01: bỏ NFP thừa cho CUSTOM

**Trạng thái:** đã triển khai và đạt kiểm thử tự động; chờ kiểm tra runtime trên giao diện thật.

### File thay đổi

1. `backend/app/workers/sticker_imposer_pkg/layout_compute.py`
2. `backend/tests/test_custom_nfp_fast_path.py`
3. Tài liệu tiến độ này

### Thay đổi

- Chỉ bỏ `get_optimal_head_to_tail_overlap()` khi đồng thời:
  - strategy là `optimal_auto`;
  - `shape_type_override == 'CUSTOM'`;
  - shape cuối cùng vẫn là `CUSTOM`.
- Vẫn gọi `extract_page_die_cut_polygon()` để giữ polygon thật cho kiểm tra va chạm.
- `head_to_tail` vẫn tính NFP như cũ.
- CUSTOM tự phát hiện nhưng chưa có override vẫn tính NFP để giữ bước tinh chỉnh loại hình.

### Benchmark đúng file 13 khuôn riêng

Thông số benchmark cố định: usable sheet `1000 × 700 pt`, gap `8,5 pt`, `optimal_auto`, explicit `CUSTOM`.

| Chỉ số | Trước | Sau |
|---|---:|---:|
| Layout 13 trang | 7,129828 s | median 0,408801 s |
| Tăng tốc | — | **17,44×** |

Năm lượt sau sửa: `0,415272`, `0,397438`, `0,394085`, `0,408801`, `0,467090` giây.

Parity:

- Toàn bộ JSON layout giống nhau ở cả 5 lượt.
- Capacity giống nhau.
- Strategy từng trang giống nhau.
- SHA-256 chung: `6c1833128e46f48c887f5f24feabf936970e1fbac61f4fb222351b29a0129fac`.

### Kiểm thử

- `py_compile`: đạt.
- Nhóm hẹp sau sửa: `13 passed, 2 warnings`.
- Nhóm sticker/preview/homogeneous mở rộng: `101 passed, 3 warnings`.
- Không cập nhật golden/snapshot.

### Còn phải kiểm tra

- Chạy `run_dev.bat`, mở đúng file 13 khuôn riêng và xác nhận cột Tem/tờ cập nhật nhanh.
- Bấm Bình và đo riêng RUN → file kết quả hiển thị; thay đổi này mới tối ưu bước layout, chưa tối ưu render/merge/hậu xử lý.

## Lô 2 — PERF-IMPO-02: lazy NFP cho hình học chuyên dụng

**Trạng thái:** đã triển khai và đạt kiểm thử tự động; chờ người dùng chạy lại file 17 khuôn.

### Baseline runtime

File `cac loai hinh - Copy.pdf`: 17 trang, 17 nhóm hình học riêng, không có CUSTOM.

- Nhận diện: `0,229 s`.
- Preview trang đầu: `2,876 s`.
- Batch Tem/tờ: `13,948 s`.
- Output: 34 trang, 8,93 MB.

Profile trực tiếp cho thấy NFP chiếm khoảng 99% thời gian của phần lớn trang: solver chuyên dụng thường dưới 1 ms, trong khi NFP từng trang khoảng 0,19–1,02 s.

### Thay đổi

- Với `optimal_auto` và shape đã được Detection xác định rõ, NFP được bọc trong `LazyNfpParams` và chỉ tải tối đa một lần.
- Solver búa/tạ và generic vẫn tải NFP ngay vì chúng thật sự so candidate head-to-tail.
- Solver chuyên dụng chỉ tải NFP nếu có vùng fill đủ lớn và `_best_fill_layout` thật sự xét candidate NFP.
- Hình thang/bình hành không tải NFP vì downstream loại các candidate đó.
- `head_to_tail`, auto-detect không có override, `CUSTOM` và `one_dao` giữ nguyên contract cũ.
- Nếu extractor polygon nhẹ thất bại, NFP được tải ngay để giữ polygon collision của đường cũ.

### Benchmark đúng file 17 khuôn

Thông số cố định: usable sheet `1000 × 700 pt`, gap `8,5 pt`, `optimal_auto`.

| Chỉ số | Trước | Sau |
|---|---:|---:|
| Layout 17 trang | 7,551464 s | median 3,423538 s |
| Tăng tốc | — | **2,21×** |

Năm lượt sau sửa: `3,366543`, `3,423538`, `3,462076`, `3,456500`, `3,380291` giây.

Parity:

- Hash toàn bộ JSON layout giống tuyệt đối ở cả 5 lượt.
- SHA-256: `04fce0b4ab86de269158f87cc77ca1c2b93a58d6e182baf6b9e59dfddd828a28`.
- Capacity và strategy của 17/17 trang giống baseline.
- Sweep 204 trường hợp (17 khuôn × 12 khổ tờ): `0` khác biệt.
- NFP chỉ được tải ở 42/204 trường hợp; 162/204 trường hợp trước đây tính thừa.

### Kiểm thử

- `py_compile`: đạt.
- Test lazy NFP + CUSTOM: `8 passed, 2 warnings`.
- Nhóm sticker/preview/homogeneous/one-dao mở rộng: `111 passed, 3 warnings`.
- Không cập nhật golden/snapshot.

