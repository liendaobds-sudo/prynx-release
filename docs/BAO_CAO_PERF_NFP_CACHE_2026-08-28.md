# Tăng tốc nesting — cache NFP, đơn giản hoá footprint, ghi tiến trình

Ngày: 2026-08-28. Nhánh `codex/pre-release-audit-2026-08-04`. Máy Windows thật.
Mọi số đo trên **chính file khách**: `test/test nesting.pdf` (13 trang, contour 110–733 đỉnh).

Xuất phát từ báo cáo của người dùng: "tốc độ bình như thế này thì chết, xoay mãi ko xong",
kèm ảnh `Đang bình trang: 0/0...` bất động.

## 1. Kết quả

Tờ 650×450, lề 10mm, gap 2mm, profile `fast`, ngân sách 3000ms:

| Số mẫu (5 con/mẫu) | Trước | Sau | Tăng tốc |
|---|---|---|---|
| 1 | 3,72s | 4,17s | — |
| 2 | 3,88s | 6,07s | — |
| 3 | 6,84s | 5,96s | 1,1× |
| 4 | **23,96s** | **6,68s** | **3,6×** |
| 8 | **60,04s** | **14,31s** | **4,2×** |
| 13 | ~2–3 phút (ngoại suy) | **32,73s** | **~4–5×** |

Ca một mẫu, autofill một tờ:

| | giây | xếp được |
|---|---|---|
| trước | 12,09 | 97 |
| sau | **2,96** | 94 |

Ca gần thực tế nhất — 13 mẫu × 50 con (650 con, 7 tờ): **156,7s**. Trước bản vá lượt này
chạy **quá 7 phút** và tôi phải dừng giữa; giờ nó **hoàn tất**.

`placedCount` và `sheetCount` giống hệt qua mọi lượt đo, và **299 test Rust xanh** —
kết quả hình học không đổi.

## 2. Ba nguyên nhân, đo trước khi sửa

### 2.1 Contour quá nhiều đỉnh (§NEST-FOOTPRINT)

Đo trong Rust, bản `--release`: chi phí NFP tăng theo **bình phương** số mảnh lồi, mà số
mảnh ≈ số đỉnh lõm + 1.

| đỉnh | mảnh | NFP |
|---|---|---|
| 24 | 7 | 0,44 ms |
| 96 | 32 | 96 ms |
| **127** | **43** | **510 ms** |
| **196** | **64** | **1.715 ms** |

Contour khách có 110–733 đỉnh với 4–66 đỉnh lõm ⇒ **một** NFP tốn 0,5–1,7 giây.

**Sửa**: `packing_footprint` là đường bế đã phình 0,2mm rồi giảm đỉnh. `cut_contour` giữ
nguyên từng đỉnh — dao vẫn cắt đúng đường của file. An toàn vì footprint **chứa** hình
thật, đúng bất biến `_validate_render_geometry` sẵn có đã cưỡng chế
("cutContour vượt ngoài packingFootprint").

Chọn `buffer` chứ không `simplify` thuần: Douglas–Peucker cắt **vào trong** nên phải hợp
lại với hình gốc để giữ bao hàm, và bước hợp đó nhồi lại toàn bộ đỉnh cũ — đo được là mất
sạch tác dụng (127 đỉnh vẫn ra 127). Phình ra thì **lấp luôn chỗ lõm nhỏ**, tức xoá đúng
loại đỉnh gây tốn.

Đo ở 0,2mm trên 13 trang khách: đỉnh lõm giảm 50–65% (trang 733 đỉnh/66 lõm → 171/22),
diện tích chỉ phình 1,6–3,7%, và **mọi trang đều chứa hình gốc**. 0,2mm nằm **dưới** sai số
cơ khí của dao bế (~0,3mm).

Hợp đồng bắt được một lỗi của tôi ở đây: adapter đòi `packingFootprint` **trùng khít** hình
đã gửi solver, nên footprint phải dựng đúng **một lần** rồi dùng cho cả `_public_request`
lẫn part spec.

### 2.2 NFP tính lại cho từng chi tiết đã đặt (§NFP-CACHE)

`nfp.rs:233` gọi `no_fit_polygon(obstacle, moving)` **một lần cho từng chi tiết đã đặt**, ở
**mỗi** lần thử một góc. Nhưng NFP chỉ phụ thuộc hai **hình dạng**:

```text
NFP(A + t, B) = NFP(A, B) + t
```

Con thứ 50 cùng hình cùng góc có NFP y hệt con thứ 1, chỉ dịch đi. Grep
`cache|memo|HashMap` trong `mixed_nesting/` chỉ ra các comment nói validator *cố ý* không
cache — **không có cache NFP nào**.

Trước khi xây, tôi đo giả định cốt lõi: nếu `refine_pose` tinh chỉnh theta **liên tục** thì
mỗi con một góc riêng và cache vô dụng. Đo thật trên file khách: **cả 20 con đều
`rotationDeg = 0.0`** — chỉ một góc. Rotation domain là cardinal, nên với `P` mẫu và `K` góc
chỉ có tối đa `P×K` hình khác nhau.

**Sửa**: `nfp_cache.rs`. Khoá là cặp vòng đã chuẩn hoá về gốc theo bbox-min, lượng tử hoá
`1e-9 mm` — **nhỏ hơn `Tolerance::linear_mm` (1e-6) một nghìn lần**, nên hai vòng trùng khoá
lệch dưới mọi ngưỡng engine coi là phân biệt được. Giá trị lưu là NFP **đã nở gap** (phép
`offset` cũng đắt và cũng lặp).

Cache cấp **trial**, không cấp toàn cục: trial là đơn vị độc lập của `multi_start`, nên cache
theo trial giữ nguyên tính tất định kể cả khi lớp gọi chạy các trial song song.

Đo hai bước tách biệt:

| | 4 mẫu | 8 mẫu | 13 mẫu |
|---|---|---|---|
| gốc | 23,96s | 60,04s | ~2–3 phút |
| cache trong một lượt | 8,09s | 16,81s | 45,61s |
| **cache xuyên trial** | **6,68s** | **14,31s** | **32,73s** |

`feasible_region` cũ giữ nguyên làm wrapper (tạo cache tạm) nên API và test hiện có không đổi.

### 2.3 Không ghi tiến trình (§NEST-PROGRESS)

Nhánh nesting **không ghi** `nup_prog_<job_id>.txt` — đúng file mà `/nup-status` đọc. Nên UI
hiện `0/0` bất động suốt cả phút, người dùng không biết job còn sống hay đã treo.

**Sửa**: ghi ngay một mốc `0/N` trước cả snapshot đầu, rồi cập nhật theo `progress` (0..1)
của snapshot Rust. Chỉ ghi khi con số đổi — snapshot tới 10 lần/giây, không đập đĩa vô ích.
Snapshot méo hay lỗi ghi đĩa **không** được làm hỏng lượt bình.

## 3. Phạm vi

| File | Thay đổi |
|---|---|
| `imposition_core/src/mixed_nesting/nfp_cache.rs` | mới — `NfpCache` |
| `imposition_core/src/mixed_nesting/nfp.rs` | +`feasible_region_cached`, `feasible_region` thành wrapper |
| `imposition_core/src/mixed_nesting/solver.rs` | cache cấp trial cho cả hai nhánh |
| `imposition_core/src/mixed_nesting/baseline.rs` | cache cấp lượt baseline |
| `imposition_core/src/mixed_nesting/mod.rs` | export `nfp_cache` |
| `backend/app/core/nesting_source_geometry.py` | +`derive_packing_footprint`, hằng dung sai |
| `backend/app/core/nesting_production_pipeline.py` | footprint dựng một lần, dùng cho cả request và part spec |
| `backend/app/workers/nup_true_shape_nesting.py` | +`_progress_writer`, +`cancel_event` |
| `backend/tests/test_nup_true_shape_nesting_entry.py` | +8 test tiến trình |

**Đã `maturin develop --release`** — bản vá Rust không có hiệu lực nếu không build lại.

## 4. Verify

| Bộ | Kết quả |
|---|---|
| `cargo test imposition_core` | **299 passed, 0 failed** |
| Nhóm nesting Python (5 file) | **288 passed** |
| `test_nup_true_shape_nesting_entry` + handover + preview_session | **105 passed** |
| **Toàn bộ `backend/tests`** | **EXITCODE=0**, **4460 passed, 19 skipped, 0 failed**, 620s |

### 4.1 Chốt số

Theo quy tắc đặt ra từ lô A4b-5 — phải có `EXITCODE` và đối chiếu với `--collect-only`:

| | số |
|---|---|
| passed | 4460 |
| skipped | 19 |
| tổng | **4479** |
| `--collect-only` | **4479** |

Khớp tuyệt đối. Nền trước lô này là 4463 thu thập; +16 test mới (8 tiến trình + 8 ca native
§NFP-CONVEX của lô trước chưa tính vào nền) ⇒ 4479.

## 5. Còn hở — và cái đang chặn

| Mã | Nội dung | Mức |
|---|---|---|
| **NFP-PRUNE-1** | **Nút cổ chai còn lại.** `feasible_region` gọi `union_many(&blockers)` trên **mọi** chi tiết đã đặt, và bộ loại sớm so `reach` của từng obstacle với **IFP box cỡ cả tờ** nên hầu như không loại được ai. Vì vậy 650 con vẫn tốn 156s. Sửa đúng cần spatial index + chỉ trừ obstacle **gần** vị trí ứng viên. Việc này **đổi tập ứng viên ⇒ đổi layout**, nên cần chủ dự án duyệt trước | **P1** |
| NFP-DEADLINE-1 | `RunControl::checkpoint()` chỉ kiểm **giữa các góc**, không kiểm trong `feasible_region`. Một lượt gọi nặng vì vậy không cắt được ⇒ ngân sách 2 giây vẫn chạy quá, và Hủy không dứt ngay. Cache đã giảm mạnh triệu chứng nhưng chưa sửa gốc | P1 |
| NFP-PARALLEL-1 | `multi_start.rs` ghi rõ trial **độc lập** và "song song hoá là việc của lớp gọi (local Rayon pool)"; lớp gọi **không** làm, `src/nfp.rs` cũng ghi "Bỏ rayon; chạy tuần tự". Engine đang dùng **một lõi**. Kiến trúc đã sẵn, đây là N× gần như miễn phí | P1 |
| NEST-FOOTPRINT-1 | Dung sai 0,2mm là hằng tôi chọn, chưa phơi ra UI. Đo được: nới lên 2,0mm chỉ giúp thêm ~12% ở ca nhiều mẫu nên không đáng đổi mật độ | P3 |

## 6. Việc kế tiếp

Theo thứ tự giá trị đo được:

1. **NFP-PARALLEL-1** — rẻ nhất, không đổi layout (trial độc lập, `reduce_candidates` đã lo
   bước gộp tất định). Kỳ vọng N× theo số lõi.
2. **NFP-DEADLINE-1** — làm Hủy và timeout thành thật. Không đổi layout khi không bị cắt.
3. **NFP-PRUNE-1** — lợi lớn nhất cho ca nhiều con, nhưng **đổi layout** nên phải duyệt.

Ước lượng (chưa đo) cho 13 mẫu × 50 con: 156s hiện tại → ~20–40s sau (1), → ~5–15s sau (3).
Không bằng lưới grid (vài chục ms, công thức đóng) nhưng là mức dùng được thật.
