# SPEC — Lô B9: Miền hợp lệ tăng dần cho autofill (bỏ O(N²) difference, GIỮ layout)

Ngày: **2026-08-30**. Đơn vị: `W7-U13`. Nối tiếp B6 (O(N²) difference nội tại) + B7 (clash-index).
Trạng thái: **ĐANG LÀM (user duyệt "đi A"). Byte-identical ⇒ golden là gate cứng, không bless.**

## 1. Vấn đề

`run_autofill_baseline` gọi `feasible_region_cached` cho MỖI (mẫu, góc) mỗi lần đặt, và mỗi
lần **dựng lại miền từ IFP rồi trừ TOÀN BỘ chi tiết đã đặt** ⇒ O(N²) (đo: difference 21s/
27,9s ở 357 tem). B6 chứng minh không bỏ-blocker chính xác được. Nhưng `placed_rings` chỉ
**MỌC THÊM** (append-only), nên giữa hai lần đặt CÙNG (mẫu, góc), miền chỉ khác ở các chi
tiết MỚI thêm.

## 2. Ý tưởng (chính xác, GIỮ NGUYÊN layout)

Nhớ miền hợp lệ theo khoá `(part_index, angle)` kèm số chi tiết đã tính (`accounted`). Lần
gọi sau cho cùng khoá: chỉ **trừ thêm** `placed_rings[accounted..]` (delta ~1 vòng quét ≈ số
mẫu) khỏi miền đã nhớ, thay vì trừ lại từ đầu.

```
feasible_after(base, delta) = base \ ∪ NFP(delta)
            = (IFP \ ∪NFP(placed[:accounted])) \ ∪NFP(placed[accounted:])
            = IFP \ ∪NFP(placed)        // ĐÚNG bằng dựng-từ-đầu
```

Cùng tập trừ, cùng thứ tự đặt (append-only) ⇒ cùng SET ⇒ Clipper số nguyên chuẩn tắc cho
cùng đỉnh ⇒ **layout byte-identical** (357 tem, util, 0° không đổi). Độ phức tạp: O(N × D)
với D = số mẫu (13) thay vì O(N²).

## 3. Phạm vi (≤2 file)

1. `imposition_core/src/mixed_nesting/nfp.rs` — **THÊM** `feasible_region_after(base_region,
   new_obstacles, moving, gap, tol, cache, should_stop)`. **KHÔNG sửa** `feasible_region_cached`
   (đường dựng-từ-đầu giữ nguyên ⇒ golden của nó xanh sẵn). Không bbox-reject (delta nhỏ; trừ
   NFP rời là no-op; đo được bbox_rejects=0 ở autofill).
2. `imposition_core/src/mixed_nesting/baseline.rs` — trong `run_autofill_baseline`: thêm
   `BTreeMap<(usize,i64),(RegionMm,usize)>`; lần đầu mỗi khoá gọi `feasible_region_cached`
   (từ đầu), lần sau gọi `feasible_region_after` với delta; cập nhật cache sau mỗi lần.
   `run_baseline` (đa tờ, chế độ số lượng) **để lô sau** — giữ scope hẹp.

## 4. Bất biến & verify (gate cứng)

1. **Golden `test_nesting_layout_golden.py` 4/4 byte-identical** — KHÔNG bless. Lệch = revert.
2. `cargo test imposition_core` toàn bộ xanh (feasible_region_cached không đổi nên test miền/
   cache/cold-miss giữ nguyên; test baseline hành vi giữ nguyên placement).
3. Benchmark máy rảnh `baseline_scaling`: difference giảm mạnh (kỳ vọng O(N²)→O(N·D)),
   `placedCount`/util **không đổi** mọi cỡ. Báo số trước/sau.
4. Đo lại file thật 357 tem: elapsed giảm, layout (posesSha) không đổi.

## 5. Rủi ro & rollback

- **Batching khác** giữa dựng-từ-đầu và incremental có thể (lý thuyết) cho FP khác nếu Clipper
  KHÔNG chuẩn tắc tuyệt đối. B7 đã dựa vào tính chuẩn tắc này và golden xanh ⇒ tin cậy, nhưng
  golden vẫn là trọng tài. Lệch ⇒ **revert lô, không bless**.
- **Audit cũ** đo một bản incremental *append-only* chậm hơn 51–57% — bản đó KHÁC (không nhớ
  miền theo (mẫu,góc), trừ lại nhiều). Bản này nhớ theo khoá + chỉ trừ delta. Nếu benchmark
  cho thấy KHÔNG nhanh hơn ⇒ revert (không giữ code phức tạp vô ích).
- **Bộ nhớ**: giữ ~D miền (clone mỗi lần cập nhật). Nhỏ (MB). Rule #1: máy mạnh không được
  chậm đi — benchmark kiểm N nhỏ.
- Rollback: xoá cache trong `run_autofill_baseline` + `feasible_region_after`; `feasible_region_cached`
  chưa đụng nên về nguyên trạng ngay.

---

## 6. KẾT QUẢ (2026-08-30): GIỮ B9 — nhanh ~7×, ĐỔI layout mức phần-triệu (±1 con ở N lớn)

**Người dùng đã duyệt phương án 1 (giữ B9 + mở rộng golden khoá layout mới).**

### 6.1 Số đo tốc độ (`test nesting.pdf`, autofill, máy rảnh)

| capacity | differenceMs TRƯỚC (B7) | SAU (B9) | giảm |
|---:|---:|---:|---:|
| 195 | 5.069 | 545 | −89% |
| ~297 | 12.645 | 916 | −93% |
| ~457 | **31.848** | **1.669** | **−94,8%** |

`blockersConsidered/N`: **252 → 12,9** (= số mẫu) ⇒ đổi hẳn O(N²) → O(N×D). Pha baseline
457 con: **35,8s → 5,06s (−86%)**. Deterministic (chạy 2 lần khớp).

### 6.2 KHÔNG byte-identical ở N lớn (đã lường trước ở §5)

Golden ca nhỏ (25/13/43/18 con) **khớp từng byte**. Nhưng file thật lệch **±1 con** ở khổ
lớn, deterministic:
- 800×1050: 297 → **298** (+1); 1000×1300: 457 → **456** (−1). Net ~0, không hồi quy mật độ.

Nguyên nhân: `difference` của Clipper **nhạy cách gom batch** — incremental gom delta theo
biên khác đường trừ-từ-đầu, cho toạ độ đỉnh lệch ~1e-6 ở mối nối phức tạp, đủ lật MỘT ứng
viên biên. Layout vẫn hợp lệ (qua validator). Không thể vừa incremental vừa byte-exact tuyệt
đối (batch của base đã cố định từ lần tính trước).

### 6.3 Chốt lại (bless CÓ CHỦ ĐÍCH, không giấu hồi quy)

- Thêm ca golden `autofill_scale_mixed_cardinal` (4 mẫu, 111 con) khoá layout B9 ở quy mô;
  4 ca cũ GIỮ NGUYÊN giá trị (25/13/43/18 — đã kiểm không đổi). Golden 5/5 xanh, xác định.
- `cargo test imposition_core` ~347 xanh; backend `-k "nesting or mixed_nesting"` **1013
  passed / 2 skipped / 0 failed**. `feasible_region_cached` KHÔNG đụng (đường from-scratch
  nguyên vẹn); chỉ THÊM `feasible_region_after` + cache theo (mẫu,góc) trong autofill.
- Rollback nếu cần: xoá cache + `feasible_region_after`, un-bless ca scale.

### 6.4 Giới hạn

- Chỉ áp cho `run_autofill_baseline` (đường preview nóng). `run_baseline` (đa tờ, số lượng)
  giữ from-scratch — lô sau nếu cần.
- Xoay: không đụng (file gần-vuông không lợi xoay). Còn `NEST-AUD-11/12`.
