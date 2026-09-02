# Báo cáo lô §NEST-FOOTPRINT-DECIMATE — giả thuyết bị số đo loại bỏ

Ngày 2026-08-28. Tiếp nối `BAO_CAO_NFP_DEADLINE_VA_PHAT_HIEN_TRIALSRUN_0_2026-08-28.md`.

## Kết luận trước

Tôi đặt giả thuyết: ép mạnh số đỉnh của footprint đóng gói (từ 55–211 xuống ~24) sẽ chữa
được `trialsRun = 0`, vì chi phí NFP đo được tăng theo số đỉnh tới ba bậc.

**Số đo loại bỏ giả thuyết này.** Ép đỉnh làm mất 2 trong 46 con mỗi tờ (−4,3% vật liệu,
vĩnh viễn) để đổi lấy ~5,5 giây một lần, và `trialsRun` vẫn bằng 0. Tôi đã hoàn nguyên mặc
định, giữ lại cơ chế như **van an toàn** cho contour bệnh lý, và ghi số đo vào code để
không ai đi lại đường này.

## Cách đo

File thật của khách `test/test nesting.pdf`, 13 trang khuôn. Tờ 320×430mm, lề 5mm, hở
2mm, `profile="fast"`, ngân sách 3000ms. Ca **autofill một tờ** (không khai SL) được chọn
làm thước đo vì ở ca này `placedCount` **chính là** mật độ — không cần suy diễn.

Mỗi cấu hình chạy **3 lượt**. Điều này là bắt buộc, không phải cho chắc: lượt đơn có
phương sai rất lớn — cùng một cấu hình đo được 31,7s rồi 55,3s. Kết luận dựa trên lượt đơn
ở lô trước là không đứng được.

## Số đo

| trần đỉnh | engineMs (3 lượt)   | attempts | con/tờ | util engine báo |
|---|---|---|---|---|
| 24        | 9,9 / 10,1 / 11,5s  | ~239     | 44     | 0,615 |
| tắt (256) | 15,5 / 15,1 / 17,4s | 69       | **46** | 0,599 |

Cột `con/tờ` lặp lại y nguyên cả 3 lượt ở cả hai cấu hình, nên chênh lệch 44/46 không phải
nhiễu.

Số đỉnh footprint thực tế ở dung sai 0,2mm, theo trang:

| trang | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| đỉnh gốc | 144 | 158 | 196 | 313 | 207 | 263 | 130 | 193 | 220 | 305 | 195 | 1098 | 228 |
| đỉnh footprint | 55 | 88 | 117 | 139 | 103 | 104 | 74 | 96 | 86 | 133 | 90 | **211** | 144 |

## Ba điều số đo nói

1. **`materialUtilization` mà engine báo không dùng được để so hai footprint khác nhau.**
   Nó *tăng* khi ép đỉnh (0,599 → 0,615) trong khi số con *giảm* (46 → 44), vì util tính
   theo diện tích footprint mà footprint vừa bị phình. Chỉ `placedCount` đáng tin.

2. **Nhiều lượt thử không bù được footprint sai.** Trần 24 cho gấp 3,5 lần `attempts`
   (239 so với 69) mà vẫn xếp được ít hơn. Độ trung thực của hình thắng số lượt thử.

3. **Chi phí mỗi attempt đi theo số đỉnh và chiếm gần hết thời gian.** 225ms/attempt ở
   55–211 đỉnh so với 44ms/attempt ở ≤24 đỉnh. Nhân lại đúng tổng (69 × 225ms ≈ 15,5s),
   nên không còn thành phần nào khác đáng kể. Hướng tối ưu đúng vì thế là làm NFP rẻ đi
   **mà không đổi hình**: cache theo hình+góc (§NFP-CACHE, đã làm), chạy song song
   (NFP-PARALLEL-1), giảm số mảnh lồi trong phân rã.

## Nguyên nhân thật của `trialsRun = 0`

Đã định vị chính xác trong `imposition_core/src/mixed_nesting/multi_start.rs`:

1. Baseline **cố ý bỏ qua deadline** (có test khoá:
   `baseline_bo_qua_deadline_va_work_budget_nhung_van_ton_trong_cancel`). Trên 13 mẫu nó
   tốn 15,5s trong khi ngân sách là 3000ms.
2. Vòng trial bắt đầu bằng `control.checkpoint()`. Deadline đã cháy 5 lần từ trước khi
   vòng chạy ⇒ `Interrupt::DeadlineReached` ⇒ `break` ⇒ **không trial nào kịp bắt đầu**.
3. Với job có SL (`quantity_fulfillment`), trial bị ngắt còn bị **loại thẳng** trước cả
   khi validate, nên kể cả có kịp chạy cũng không được tính.

Chứng minh trial **có** tác dụng khi được cho chỗ — 4 mẫu × 5 con, ngân sách 60000ms:

| footprint | kết quả | trialsRun | terminationReason |
|---|---|---|---|
| tắt trần (55–211 đỉnh) | `baseline` | 0 | `deadline` (63,4s) |
| trần 24 đỉnh | `smart_trial` | **4** | `all_placed` (32,3s) |

Nên finding **NEST-BASELINE-UNBOUNDED** là chốt kế tiếp, không phải hình học footprint.

## Đã sửa gì

`backend/app/core/nesting_source_geometry.py`

- `PACKING_FOOTPRINT_MAX_VERTICES = 256` — **van an toàn**, đặt cao hơn mọi giá trị thật
  (cao nhất đo được 211) nên không bao giờ chạm trên file bình thường; chỉ chặn contour
  vài nghìn đỉnh khỏi treo máy.
- `PACKING_FOOTPRINT_MAX_TOLERANCE_MM = 3.0` — chặn trên khi nới dung sai.
- `derive_packing_footprint` nhận thêm `max_vertices`, `max_tolerance_mm`; nới dung sai
  gấp đôi từng bước cho tới khi đạt trần hoặc chạm chặn trên.
- Tách `_grown_footprint()`: một bước phình + giảm đỉnh, trả `None` nếu **không giữ được
  bao hàm**. Không dựng được footprint an toàn thì trả nguyên đường bế.
- Toàn bộ bảng số đo trên nằm trong comment tại chỗ.

`backend/tests/test_nesting_packing_footprint.py` — file mới, 40 test. Trước lô này
`derive_packing_footprint` **không có test đơn vị nào**.

## Verify

| Hạng mục | Kết quả |
|---|---|
| `test_nesting_packing_footprint.py` | 40 passed |
| Vùng nesting (`-k "nesting or footprint or diecut or die_detection"`) | 935 passed, 2 skipped |
| `cargo test imposition_core` | 304 passed, EXITCODE=0 |
| `pytest --collect-only` | 4532 = 4492 (nền) + 40 (mới) |
| Full backend | **4513 passed, 19 skipped = 4532**, khớp collect-only, EXITCODE=0, 542,26s |

### Đã kiểm test bắt lỗi

Ba đột biến, mỗi cái xác nhận test đỏ đúng chỗ:

| Đột biến | Kết quả |
|---|---|
| Hạ trần về 24 | 1 đỏ — `test_tran_mac_dinh_khong_cham_contour_thuc_te` (`assert 24 > 211`) |
| `buffer(+tol)` → `buffer(-tol)` | 2 đỏ. Fail-closed chặn phần còn lại: mất bao hàm ⇒ trả nguyên đường bế |
| Đổi buffer âm **và** bỏ chốt `covers(original)` | 22 đỏ — toàn bộ nhóm bao hàm |

## Còn lại

| Mã | Việc | Ưu tiên |
|---|---|---|
| `NEST-BASELINE-UNBOUNDED` | Baseline ăn hết deadline ⇒ `trialsRun` luôn 0. Cho baseline ngân sách riêng, hoặc cho trial bị ngắt **đã đủ SL** được vào cuộc so sánh thay vì loại thẳng | P0 |
| `NFP-PARALLEL-1` | Engine chạy 1 lõi | P1 |
| `NEST-PREVIEW-1` | Preview đi đường lưới cũ nên lệch với kết quả thật | P1 |
| `NFP-PRUNE-1` | Chỉ trừ obstacle gần — **đổi layout**, cần chủ dự án duyệt | P1, cần duyệt |
