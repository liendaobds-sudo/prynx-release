# Sửa đường cắt theo biên trong suốt — 2026-08-04

Thực hiện sau khi người dùng duyệt
`docs/BAO_CAO_AUDIT_DUONG_CAT_ALPHA_2026-08-04.md`.

## Lô A — Engine + writer + regression test

### §ALPHA.1–2 — Lọc bậc pixel và xuất Bézier có guard

File:

- `backend/app/workers/sticker_engine.py`
- `backend/app/workers/cutline_geometry.py`

Thay đổi:

1. Alpha không còn xuất gần như nguyên marching-squares với tolerance 0,02 mm.
2. Engine thử rút gọn 0,05 mm theo đơn vị vật lý; chỉ nhận candidate khi:
   - geometry hợp lệ;
   - số polygon/số lỗ không đổi;
   - Hausdorff với đường lùi lý tưởng không quá 0,08 mm;
   - cấu hình lùi mặc định vẫn giữ khoảng cách Alpha tối thiểu 0,05 mm.
3. Writer dùng Catmull–Rom độ căng thấp `0,15 → 0,10 → 0,05 → 0,03`. Mỗi mức chỉ được
   dùng khi guard chứng minh đường cubic không vượt ngân sách; nếu tất cả thất bại thì tự lùi
   về polyline đã lọc, cuối cùng mới về tolerance cũ 0,02 mm.
4. Phép kiểm cubic dùng chặn trên sai lệch vuông góc control-point ↔ chord theo O(n), kèm
   sampled topology. Bản thử dùng Hausdorff toàn đường lấy mẫu làm 72 trang tăng từ khoảng
   33 lên 109 giây đã bị loại bỏ.
5. Offset dương do người dùng chủ động vẫn được tôn trọng; safe envelope chỉ bảo vệ khoảng lùi
   khi đường cắt thực sự nằm trong Alpha.

### §ALPHA.2b — Fit nhiều bậc raster thành cubic dài hơn

Phản hồi sau vòng đầu xác nhận 300–400 anchor/trang vẫn còn dày. Vòng hai bổ sung fitter cubic
kiểu Schneider trên từng ring kín:

1. Thử tolerance vật lý `0,10 → 0,095 → 0,08 → 0,06 mm`; nhiều điểm raster liên tiếp được
   thay bằng một cubic thay vì một cubic cho mỗi anchor.
2. Mọi candidate vẫn phải giữ nguyên số polygon/lỗ, geometry hợp lệ, nằm trong safe envelope
   và có Hausdorff tổng với đường lùi lý tưởng không quá `0,12 mm`.
3. Kiểm Hausdorff dùng hai tầng: reference 0,02 mm quyết định nhanh các ca chắc chắn; vùng sát
   ngưỡng kiểm contour gốc bằng bao phủ buffer hai chiều. Với hai tập đóng, điều kiện này tương
   đương Hausdorff `≤ r` nhưng tránh phép đo O(n×m) trên 8–12 nghìn điểm raster.
4. Tay nắm của nghiệm bình phương tối thiểu bị giới hạn bằng chiều dài chord. Nếu tay nắm quay
   ngược theo chord, fitter ưu tiên tay nắm đơn điệu; nếu toàn contour không hợp, thử lại biến thể
   giới hạn chord trước khi về Catmull vòng một. Mỗi biến thể vẫn qua cùng guard artifact.
5. Chỉ nhận fitted path khi giảm ít nhất 15% segment so với fallback; 10/72 trang khó không qua
   guard được giữ nguyên fallback an toàn, không cố ép giảm node.

### §ALPHA.P1 — Gỡ hồi quy 86 giây và khóa mọi nhánh worker

Runtime app ngày 05/08 ghi nhận đúng file 72 trang mất `86,257 s`: engine dự kiến 3 worker trên
máy 32GB/16 luồng nhưng `_cap_sticker_workers()` ép còn 1 chỉ vì file 288MB và có 72 trang.
Đây là hard-cap sai, trái rule máy mạnh chạy hết công suất.

Bản sửa:

1. Máy `≥16GB` dùng `CPU-1` process; không còn cap theo dung lượng file, số trang hoặc RAM khả
   dụng. Máy `<8GB` giữ 1 worker; máy `8–16GB` tối đa 2 và tiếp tục gate theo RAM trống.
2. Sticky tuần tự tắt trên máy mạnh. Nếu pool đầy bị crash, engine thử lại bằng nửa pool trước;
   chỉ khi cả hai pool đều chết mới chạy tuần tự an toàn.
3. Guard Hausdorff fitted Alpha đổi từ `geometry.hausdorff_distance()` sang buffer/covers hai
   chiều tương đương toán học. Forced-sequential 72 trang giảm `39,133 → 30,587 s` trên corpus
   benchmark mà không đổi một byte CutContour nào.
4. Production auto trên máy 32GB/16 luồng chọn 15 worker và hoàn tất corpus 72 trang trong
   `12,005 s`; CutContour 72/72 trang và toàn bộ page box giống hệt baseline trước tối ưu.

### §ALPHA.3 — Khóa regression

File: `backend/tests/test_sticker_engine_e2e.py`.

Đã thêm:

- fixture raster 300 DPI có vòng ngoài + lỗ trong;
- oracle giảm node so với thuật toán 0,02 mm;
- topology/lỗ, Hausdorff, khoảng cách Alpha và diện tích vượt biên;
- E2E parse content stream, yêu cầu đường Alpha cong xuất Bézier và không quay lại hàng trăm
  đoạn thẳng pixel.

## Artifact người dùng — trước/vòng một/vòng hai

Nguồn 72 trang: `d07e3ff4aba347679b7b623ca88c52e9.pdf`.

| Chỉ số | Trước | Vòng một | Vòng hai |
|---|---:|---:|---:|
| Node/anchor — median | 991,5 | 310,5 | **144,5** |
| Node/anchor — max | 1.408 | 475 | **466** |
| Trang 1 | 1.202 | 401 | **166** |
| Tổng segment sau vòng một (cùng nguồn A/B vòng hai) | — | 21.652 | **9.790** |
| Giảm median so với trước | — | 68,7% | **85,4%** |
| Trang dùng fitted cubic vòng hai | — | — | **62/72** |
| Trang xuất Bézier | 0/72 | 72/72 | **72/72** |
| Lệnh thẳng `l` trong CutContour | 69.966 | 0 | **0** |
| Page-box delta trong cặp A/B | — | 0 pt | **0 pt** |
| Kích thước file | 302.463.030 B | 302.432.372 B | **302.208.999 B** |

Artifact sau vòng một:

`tmp/research/alpha_fixed_curve_final2_72.pdf`

Artifact vòng hai (cùng artwork được khôi phục từ output vòng một để A/B đúng cùng nguồn):

`tmp/research/alpha_fitted_dual_final_72.pdf`

## Verify

```text
python -m py_compile sticker_engine.py cutline_geometry.py test_sticker_engine_e2e.py
→ đạt

pytest backend/tests/test_cutline_contour.py backend/tests/test_sticker_engine_e2e.py \
       backend/tests/test_sticker_parallel_fallback.py -q
→ 112 passed, 1 cảnh báo Pydantic có sẵn, 18,16 s

Artifact 72 trang, chạy tuần tự cùng quy trình:
→ thành công 72/72 trang trong 31,83 s
→ 72/72 trang có Bézier, 0 trang fallback polyline
→ page box delta 0 pt

Artifact vòng hai 72 trang, chạy tuần tự trên cùng nguồn A/B:
→ thành công 72/72 trang trong 36,52 s
→ 62 trang dùng fitted cubic; 10 trang tự về Catmull có guard
→ median 308 → 144,5 segment (−53,1%); tổng 21.652 → 9.790 (−54,8%)
→ trang 1: 396 → 166 segment (−58,1%)
→ không trang nào tăng segment; 0 lệnh thẳng; page-box delta 0 pt
→ render lại trang 1 và 37 ở 600 DPI: không thấy loop, gấp gãy hoặc lệch viền

Runtime/performance regression:
→ app baseline thật: 86,257 s; workers=1 do hard-cap file/page
→ forced sequential sau tối ưu guard: 30,587 s trên corpus A/B
→ production auto: profile 15 worker, 12,005 s cho 72 trang
→ 72/72 CutContour stream giống baseline; page-box delta 0 pt
→ test worker phủ: máy mạnh không cap bởi MB/trang/RAM trống; máy yếu vẫn gate;
  pool crash thử nửa pool rồi mới tuần tự
```

## Trạng thái còn lại

- Mức bằng chứng: `ARTIFACT`.
- Chưa chạy thao tác lại trên app desktop thật; cần smoke đúng file người dùng trước khi gọi là
  `RUNTIME`.
- §ALPHA.4 (có nên mở tùy chọn UI “Bám sát pixel”) tạm chưa triển khai. Engine hiện mặc định
  “Mượt an toàn”; chỉ nên thêm lựa chọn chuyên sâu sau khi smoke/cắt thử xác nhận nhu cầu thực.
