# Báo cáo lô §NEST-BASELINE-UNBOUNDED — baseline tiêu hết ngân sách của trial

Ngày 2026-08-28. Tiếp nối `BAO_CAO_NEST_FOOTPRINT_DECIMATE_BI_LOAI_2026-08-28.md`.

## Kết luận trước

Đã sửa được một lỗi **thật** và định lượng được **rào cản còn lại**:

- **Đã sửa:** deadline bị baseline đốt hết nên vòng trial chưa bao giờ chạy nổi một lượt.
  Bây giờ trial được cấp lại đúng một cửa sổ ngân sách sau khi baseline xong.
- **Chưa giải quyết:** kể cả khi được cấp 40 giây, trial vẫn **không hoàn tất nổi một
  sweep** cho job 13 mẫu. Nguyên nhân đã đo được và là **kiến trúc**, không phải tham số:
  một trial đắt gấp ~12 lần baseline vì nó thử 12 góc mỗi chi tiết trong khi baseline thử
  1. Với job của khách, một trial ≈ 186 giây và `profile="fast"` chạy 4 trial ≈ **12 phút**.

Đó chính là lý do "thử hơn 2 phút chưa ra kết quả".

## Lỗi đã sửa

`RunControl::new()` chốt `deadline = now + time_budget_ms` ngay lúc tạo. Baseline **cố ý
bỏ qua** deadline — nó là sàn an toàn, phải luôn hoàn chỉnh, có test khoá
`baseline_bo_qua_deadline_va_work_budget_nhung_van_ton_trong_cancel` — nhưng đồng hồ vẫn
chạy. Trên file khách 13 mẫu baseline tốn 15,5s trong khi ngân sách là 3000ms, nên khi vòng
trial bắt đầu thì deadline đã cháy 5 lần: `control.checkpoint()` đầu vòng trả
`DeadlineReached` ⇒ `break` ⇒ **`trialsRun` luôn bằng 0**.

Người dùng chọn "Nesting tối ưu theo đường bế" và **luôn** nhận layout greedy của baseline.

Đáng chú ý: ý định đúng đã được ghi ngay trong code, ở comment của
`checkpoint_cancel_only` — *"baseline là sàn an toàn nên phải hoàn tất trước khi áp deadline
hoặc ngân sách tìm kiếm cho các trial"*. Ý định đó chưa từng được hiện thực.

### Bản vá

`imposition_core/src/mixed_nesting/control.rs`

- `deadline: Option<Instant>` → `started: Instant` + `deadline_nanos: AtomicU64`. Cần
  interior mutability để nạp lại qua `&self`; `checkpoint()` là hot path nên dùng atomic
  Relaxed, không `Mutex`. Work-plan cố định vẫn **không đọc đồng hồ**: `checkpoint()` kiểm
  `stop.time_budget_ms.is_some()` trước.
- Thêm `rearm_deadline_after_baseline()`.

`imposition_core/src/mixed_nesting/multi_start.rs`

- `solve()` gọi `control.rearm_deadline_after_baseline()` đúng một lần, sau khi baseline
  hoàn tất và validate, trước vòng trial.

Hệ quả có chủ đích: tổng thời gian một lượt thành `baseline + ngân sách` thay vì
`max(baseline, ngân sách)`.

## Đo trên file khách

`test/test nesting.pdf`, 13 trang khuôn, tờ 320×430mm, lề 5mm, hở 2mm, `profile="fast"`,
autofill một tờ. **3 lượt mỗi cấu hình, cả 3 lượt cho số giống nhau từng chữ số.**

| mẫu | con/tờ | attempts | engineMs |
|---|---|---|---|
| 1  | 41 | 209 | 3,55s |
| 4  | 48 | 122 | 6,1s |
| 13 | 46 | 77  | 17,7s |

So với trước bản vá ở ca 13 mẫu: 15,5s / 69 attempts → 17,7s / 77 attempts. Trial **có**
chạy (attempts tăng), tốn thêm ~2,2s, và **chưa** đổi được kết quả.

Nới ngân sách cho trial, cùng ca 13 mẫu:

| ngân sách | engineMs | con/tờ | trialsRun |
|---|---|---|---|
| 3000ms  | 17,7s | 46 | 0 |
| 15000ms | 29,8s | 46 | 0 |
| 40000ms | 57,2s | 46 | 0 |

`attempts` tăng 77 → 89 → 179, nên trial đang chạy thật. Nhưng không sweep nào hoàn tất
trong 40 giây.

## Rào cản còn lại, đã định lượng

Đọc code xác nhận nguồn gốc con số:

- `baseline_angles(RotationDomain::Full, FirstAllowed)` → `vec![0.0]` — **một** góc mỗi
  chi tiết (autofill thêm góc bootstrap, nhưng chỉ một lần cho mỗi design).
- `SearchEffort::for_profile(Profile::Fast)` → `orientation_proposals_per_part: 12`,
  `trial_count: 4`.

Mỗi góc cần một `feasible_region` dựng lại **từ đầu** — NFP với từng chi tiết đã đặt rồi
hợp lại. Nên:

```
1 trial ≈ 12 × baseline ≈ 12 × 15,5s ≈ 186s
profile "fast" = 4 trial ≈ 12 phút
```

Đây là **chi phí kiến trúc**, không phải tham số sai. Bốn hướng đóng khoảng cách 12×:

| Hướng | Lợi ước tính | Đánh đổi |
|---|---|---|
| `NFP-PARALLEL-1` — 4 trial song song trên 4 lõi | wall /4 | không đổi kết quả; vẫn ~3 phút |
| Giảm `orientation_proposals_per_part` của `fast` từ 12 xuống 4 | 3× | đổi chất lượng layout, cần duyệt |
| **Miền hợp lệ tăng dần** — thêm một NFP mỗi lần đặt thay vì dựng lại toàn bộ mỗi góc | 10–100× | việc lớn, đổi cấu trúc solver |
| `NFP-PRUNE-1` — chỉ trừ obstacle gần | chưa đo | đổi layout, cần duyệt |

Hướng thứ ba là chỗ các engine nesting thương mại lấy tốc độ, và là câu trả lời thật cho
"có nhanh như iCut được không".

## Một thay đổi đã thử rồi hoàn nguyên

Tôi đã bỏ điều kiện loại thẳng quantity trial bị ngắt trong `multi_start.rs`, rồi **hoàn
nguyên**. Ba lý do, tất cả đều đo được:

1. Bỏ nó **an toàn về kế toán**: `run_trial` khi bị ngắt ghi MỌI con còn lại vào `unplaced`
   với `SEARCH_BUDGET_EXHAUSTED`/`CANCELLED`, và `LayoutScore` so `unplaced_count`
   (tiêu chí 1) TRƯỚC số tờ, nên trial dở không thể thắng bằng cách xếp ít hơn. Bất biến
   này đã được khoá bằng test `phuong_an_cong_bo_khong_bao_gio_xep_it_hon_baseline`.
2. Nhưng **không dựng được test tất định cho chính việc bỏ**: khác biệt chỉ hiện khi trial
   bị ngắt mà vẫn tốt hơn baseline, ép đúng trạng thái đó bằng deadline là flaky. Kiểm bằng
   đột biến: trả lại điều kiện cũ **không làm test nào đỏ**.
3. Hiện tại nó **vô ích**: đo 13 mẫu × 5 con, bỏ hay giữ đều cho kết quả y nguyên.

Đổi hành vi công bố mà không có test bảo vệ là đúng loại hồi quy âm thầm mà quy trình này
tồn tại để chặn. Phân tích được ghi tại chỗ trong code để lần sau không phải làm lại.

## Verify

| Hạng mục | Kết quả |
|---|---|
| `cargo test imposition_core` | **315 passed** = 304 (nền) + 11 (file mới), EXITCODE=0 |
| `maturin develop --release` | thành công, đã đo lại trên file khách sau build |
| Full backend | **4513 passed, 19 skipped = 4532**, khớp `--collect-only` 4532, EXITCODE=0, 525,42s |

### Đã kiểm test bắt lỗi

| Đột biến | Kết quả |
|---|---|
| Bỏ `control.rearm_deadline_after_baseline()` trong `solve` | 1 đỏ — `baseline_cham_hon_ngan_sach_thi_trial_van_chay`: "đánh giá hướng 24 không vượt baseline 24" |
| Trả lại điều kiện loại thẳng quantity trial | **0 đỏ** ⇒ chính vì vậy tôi hoàn nguyên thay đổi đó |

### Hai bẫy đo lường gặp trong lô này

1. **`Copy-Item` phục hồi cả mtime**, nên mtime file nguồn **lùi lại** và cargo coi là
   không đổi ⇒ dùng lại binary của bản đột biến. Kết quả "đã vá mà test vẫn đỏ" là giả.
   Sau khi phục hồi file bằng cách copy, phải `LastWriteTime = Get-Date` để buộc build lại.
2. **`attempts` không phải số quan sát đúng** để chứng minh trial đã chạy: nó chỉ tăng
   *sau* khi `feasible_region_cached` trả về, nên trial bị ngắt trong lúc dựng miền vẫn để
   `attempts` bằng 0. Phải dùng `orientation_evaluations`, tăng ngay khi vào vòng góc.

## File đã sửa

- `imposition_core/src/mixed_nesting/control.rs`
- `imposition_core/src/mixed_nesting/multi_start.rs` (chỉ thêm lời gọi rearm + comment
  khảo sát; điều kiện loại trial giữ nguyên như trước lô)
- `imposition_core/tests/mixed_nesting_baseline_budget.rs` — mới, 11 test

## Còn lại

| Mã | Việc | Ưu tiên |
|---|---|---|
| `NFP-INCREMENTAL-1` | Miền hợp lệ tăng dần thay vì dựng lại mỗi góc — chỗ có 10–100× | P0 (mới, từ lô này) |
| `NFP-PARALLEL-1` | 4 trial song song, engine hiện chạy 1 lõi | P1 |
| `NEST-PROFILE-ANGLES` | `fast` thử 12 góc là không "fast"; hạ xuống 4 đổi 3× tốc độ | P1, cần duyệt vì đổi layout |
| `NEST-PREVIEW-1` | Preview đi đường lưới cũ nên lệch với kết quả thật | P1 |
| `NFP-PRUNE-1` | Chỉ trừ obstacle gần | P1, cần duyệt |
