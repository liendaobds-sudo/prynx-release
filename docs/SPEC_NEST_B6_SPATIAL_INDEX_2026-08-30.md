# SPEC — Lô B6: Spatial index cho baseline `feasible_region` (bỏ O(N²))

Ngày: **2026-08-30**. Đơn vị: `W2-U09 / W7-U11`. Finding gốc: `NEST-AUD-10/19`.
Trạng thái: **CHỐT 1 — SPEC + GOLDEN (chưa sửa engine). Chờ duyệt trước khi vào chốt 2.**

Đo hậu thuẫn: `docs/BAO_CAO_NEST_BASELINE_ON2_2026-08-30.md`.
Golden khóa bất biến: `backend/tests/test_nesting_layout_golden.py` +
`backend/tests/fixtures/nesting_golden/baseline_layout_golden.json` (đã tạo, 4 ca xanh).

## 1. Mục tiêu

Bỏ O(N²) của pha baseline nesting để preview file nhiều tem (đo thật của người dùng: **357 tem
→ 35–59s**) xuống còn vài giây, **không đổi một pixel layout nào**. Đây cũng là điều kiện cần
để pha search kịp chạy (mở đường xoay tem — vấn đề `NEST-AUD-11/12`).

## 2. Gốc rễ (đã đo, định lượng)

`imposition_core/src/mixed_nesting/nfp.rs::feasible_region_cached`: với mỗi lần đặt con, vòng
`for obstacle in placed` trừ NFP của **TOÀN BỘ** con đã đặt.

| capacity | blockersConsidered | differenceMs | bboxRejects |
|---:|---:|---:|---:|
| 46 | 1.897 | 461 | 0 |
| 195 | 23.972 | 9.300 | 0 |
| 457 | 115.117 | 36.487 | 0 |

- `blockersConsidered ~ N²` (blockers/N tăng tuyến tính) — mỗi placement quét cả tập đã đặt.
- `differenceMs ~ N²` — phép Boolean difference xử lý O(N) blocker × N placement.
- **`bboxRejects = 0` mọi cỡ**: broad-phase bbox hiện tại (`bounds_may_touch(ifp_box, reach)`)
  **vô dụng** vì autofill lấp cả tờ ⇒ IFP ≈ cả tờ ⇒ mọi con đã đặt đều "chạm" hộp IFP cả-tờ.
- NFP build PHẲNG (`cacheMisses=169` hằng số) — **không** phải nút thắt; cache đã đúng.

Kết luận: nút thắt là **trừ NFP của mọi blocker cho mỗi placement**, không phải dựng NFP.

## 3. Bất biến correctness — GATE cứng của lô này

**Spatial index CHỈ được bỏ những blocker CHỨNG MINH được không thể chạm miền ứng viên đang
xét.** Bỏ một blocker như vậy là phép **chính xác** (exact), không phải xấp xỉ: NFP của nó
không carve bất kỳ diện tích hợp lệ nào trong miền đó, nên tập placement **không đổi**.

Gate: `test_nesting_layout_golden.py` — 4 ca (autofill rect/L/mixed cardinal + quantity),
freeze `placedCount / sheetCount / posesSha256`. Sau chốt 2 (sửa Rust + rebuild native), chạy
lại phải **KHỚP từng byte**. Lệch = hồi quy, **không được bless** để làm xanh.

Không dùng `layoutFingerprint` làm mốc vì nó chứa locator pin đổi mỗi lượt (RA-NEST-00); pose
records là bất biến hình học thật (đã kiểm ổn định ở PV-CACHE).

## 4. Thiết kế đề xuất

### 4.1 Ý tưởng: sweep bottom-up + spatial index theo dải

Baseline greedy chọn vị trí **bottom-left**. Không cần miền hợp lệ trên **cả tờ** — chỉ cần ở
biên bottom-left. Đề xuất:

1. Chỉ số hoá con đã đặt trong **lưới không gian đều** (grid), key theo bbox của **grown-NFP**.
2. Tính `feasible_region` theo **dải ngang từ dưới lên**: dải thấp nhất có thể chứa placement,
   chỉ trừ blocker mà grown-NFP bbox **giao dải đó** (truy vấn grid).
3. Nếu dải có đỉnh hợp lệ → đó chính là bottom-left toàn cục (đơn điệu theo y) → dừng. Chỉ nới
   lên dải kế nếu dải hiện bị chặn hết.

Độ phức tạp: mỗi placement chỉ đụng ~O(k) blocker cục bộ ⇒ tổng ~**O(N·k)** thay vì O(N²).

### 4.2 Lập luận chính xác (vì sao layout không đổi)

- Blocker có grown-NFP bbox **không giao dải** ⇒ NFP không carve diện tích nào trong dải ⇒ bỏ
  qua không đổi miền hợp lệ của dải. **Exact.**
- Thứ tự dải dưới-lên + tính đơn điệu của mục tiêu bottom-left ⇒ đỉnh hợp lệ đầu tiên tìm thấy
  chính là đỉnh BL toàn cục — trùng với "tính cả miền rồi lấy BL" của code hiện tại.
- Do đó `region_vertices` + `bottom_left_order` + `take(MAX_CANDIDATES_PER_ANGLE)` cho **cùng**
  tập ứng viên ⇒ cùng placement ⇒ golden khớp.

### 4.3 Biến thể dự phòng (chốt 2 sẽ A/B chọn)

- **B-strip** (§4.1): grid + dải bottom-up.
- **B-sort**: sắp blocker theo `NFP.min_y` tăng dần; trừ dần; "khoá" đỉnh BL khi min_y của
  blocker chưa xử lý đã cao hơn đỉnh hiện có (không blocker nào còn có thể hạ đỉnh) → dừng sớm.
  Ít đụng cấu trúc dữ liệu hơn, nhưng tiết kiệm phụ thuộc phân bố.

Cả hai đều phải qua **cùng golden**. Chốt 2 prototype cả hai, benchmark máy rảnh, giữ cái
thắng mà vẫn khớp golden.

### 4.4 KHÔNG làm (bài học đã trả giá)

- **KHÔNG** incremental append-only ngây thơ: audit `NEST-AUD-10` đo được **chậm hơn 51–57%**
  (duy trì miền union lớn đắt hơn phần tiết kiệm).
- **KHÔNG** "gom mọi đỉnh NFP rồi hậu kiểm lười": đã đo **>60s**, tệ hơn baseline.
- **KHÔNG** đổi biểu diễn collision (raster mask) trong lô này — đó là lô riêng, đổi kernel.

## 5. Phạm vi file (chốt 2, ≤5 file)

1. `imposition_core/src/mixed_nesting/nfp.rs` — `feasible_region_cached` nhận/ dùng spatial index.
2. `imposition_core/src/mixed_nesting/` — module spatial grid mới (vd `spatial.rs`) + `mod.rs`.
3. `imposition_core/src/mixed_nesting/baseline.rs` + `solver.rs` — dựng/nuôi index theo tập đã đặt
   (index sống cùng vòng đặt, cập nhật khi push placement).
4. `imposition_core/tests/` — property test: kết quả index-on == index-off trên hình ngẫu nhiên.
5. Rebuild native (`maturin develop --release`) — không phải file, nhưng là bước bắt buộc để
   golden Python chạy trên binary mới.

## 6. Verify plan (chốt 2)

1. **Golden layout** `test_nesting_layout_golden.py` — 4 ca KHỚP từng byte (gate cứng).
2. **Property test Rust**: sinh N hình + vị trí ngẫu nhiên, so `feasible_region` index-on vs
   index-off phải cho **cùng region** (hoặc cùng tập region_vertices). Đây là lưới an toàn cho
   mọi hình, không chỉ 4 ca golden.
3. `cargo test imposition_core` toàn bộ xanh (các test determinism/score/baseline hiện có).
4. **Benchmark máy rảnh** (tắt run_dev) `baseline_scaling.py` ở capacity 46/110/195/297/457:
   chứng minh `blockersConsidered/differenceMs` đổi từ ~N² sang ~N·k, và **placedCount không
   đổi** ở mọi cỡ.
5. Golden production nếu cần: chạy `test nesting.pdf` ở vài khổ, so pose SHA trước/sau.

## 7. Rủi ro + rollback

- **Rủi ro cao nhất**: biên dải/khoá đỉnh sai ⇒ đổi layout tinh vi. Bắt bằng golden + property
  test. Nếu property test đỏ ⇒ dừng, không merge.
- **Hồi quy máy mạnh**: index có overhead nhỏ ở N bé. Benchmark phải cho thấy N bé không chậm
  đi đáng kể (rule #1: không làm máy mạnh chậm).
- **Rollback**: thay đổi khu trú trong `nfp.rs`/`spatial.rs`; có thể gate sau cờ để tắt nếu cần,
  hoặc revert lô. Không đụng schema/manifest/provenance nên không ảnh hưởng file đã lưu.

## 8. Quy trình 2 chốt

- **Chốt 1 (báo cáo này)**: spec + golden. Golden đã tạo và xanh trên engine hiện tại. **Chờ
  duyệt.**
- **Chốt 2 (sau duyệt)**: prototype B-strip/B-sort → property test → chọn biến thể → sửa ≤5 file
  → rebuild → chạy golden + benchmark máy rảnh → báo cáo số trước/sau. Không bless golden.

## 9. Giới hạn spec

- Chưa viết code engine (đúng ý chốt 1).
- Golden phủ hình synthetic (rect/L/mixed cardinal); property test chốt 2 phủ ngẫu nhiên rộng
  hơn. Golden production trên file khách là tùy chọn thêm.
- Biến thể cuối (B-strip vs B-sort) quyết ở chốt 2 bằng benchmark, không chốt cứng ở đây.

---

## 10. CHỐT 2 — KẾT QUẢ ĐO (2026-08-30): SPATIAL-INDEX KHÔNG CỨU ĐƯỢC O(N²)

**Kết luận: thiết kế trong spec này KHÔNG khả thi cho byte-exact O(N·k). Đã đo, đã revert
instrumentation, KHÔNG merge. Golden vẫn 4/4 xanh (không bless).**

### 10.1 Hai lỗ hổng thiết kế phát hiện khi đọc kỹ engine

1. **Frontier theo `NFP.min_y` KHÔNG dâng lên** trong autofill lấp đáy-lên. NFP nở LÊN
   TRÊN (một con đã đặt chặn vị trí phía trên nó một khoảng bằng chiều cao con đang xếp),
   nên `NFP.min_y ≈ py − chiều_cao_moving − gap` của MỌI con đã đặt đều nằm dưới đường
   lấp. Không thể "dừng sớm khi frontier vượt qua" — frontier chỉ vượt sau khi đã trừ hết.

2. **Miền hợp lệ đầy đủ cho BL vốn cần ~O(N) blocker/placement** ở tờ lấp dày: phải carve
   quanh TỪNG con đã đặt mới biết còn khe hở nào lọt con kế. Bỏ một con vì "ở xa" có thể
   bỏ sót khe hở thấp → đổi layout → golden đỏ. Lưới an toàn clash-check KHÔNG cứu
   byte-exact vì mất một ứng viên là đổi layout, và `take(64)` có thể đánh rớt đáp án đúng.

### 10.2 Bằng chứng đo (instrumentation tạm, hành vi GIỮ NGUYÊN, golden 4/4 xanh)

Đo trần "blocker mà bbox NFP đã KHÔNG còn chạm miền hợp lệ hiện tại" — tức trần tối đa mà
một spatial-index CHÍNH XÁC có thể bỏ, dưới ĐÚNG thứ tự đặt hiện hành (`test nesting.pdf`,
autofill, quét khổ):

| capacity | blockersConsidered | trần-bỏ-được (skip ceiling) | % | differenceMs |
|---:|---:|---:|---:|---:|
| 46  | 1.897   | 62 | 3,3%  | 280 |
| 110 | 8.166   | 23 | 0,28% | 1.502 |
| 195 | 23.972  | 19 | 0,08% | 5.100 |
| 297 | 52.219  | 29 | 0,06% | 12.542 |
| 457 | 115.117 | 47 | **0,04%** | 31.991 |

Trần bỏ-được **giảm** khi N tăng (3,3% → 0,04%). `differenceMs/N²·1e3` phẳng (~132–153)
⇒ O(N²) sạch. Một spatial-index chính xác chỉ bỏ được **47/115.117** phép trừ ở N=457 —
vô nghĩa. **O(N² của pha difference là NỘI TẠI** với thuật toán "miền-hợp-lệ-đầy-đủ + BL",
không phải do thiếu broad-phase.

### 10.3 Phân rã thời gian baseline tại N=457 (~47,6s)

- `differenceMs` ≈ **32,0s (67%)** — O(N²) nội tại (đo trên).
- prewarm NFP (wall) ≈ 2,0s — PHẲNG theo N (cache đúng, 169 miss hằng số), KHÔNG phải nút.
- Còn lại ~13,6s — gồm clash-check `judge_pair` vs TOÀN BỘ placed mỗi ứng viên (O(N²) thứ
  hai) + region_vertices/sort/dedup mỗi lần gọi.

### 10.4 Hướng thật (đều có đánh đổi — cần duyệt riêng)

- **B7 — Clash-check spatial index (CHÍNH XÁC, byte-identical, thắng một phần).** Index
  `placed_rings` vào `SpatialGrid` sẵn có (spatial.rs), clash chỉ truy vấn con gần. Kết quả
  `judge_pair` KHÔNG đổi (cặp ở xa chắc chắn không chạm) ⇒ golden an toàn. Chỉ giảm phần
  ~13,6s (clash), KHÔNG đụng 32s difference. Ước 47,6s → ~38–40s. An toàn, làm được ngay.
- **B8 — Đường lưới nhanh cho hình GIỐNG NHAU (thắng LỚN, ĐỔI layout).** Tờ tem bế thường
  là nhiều bản của 1–2 hình; xếp lưới/hàng là O(N) (hoặc giải tích), đúng cách các phần mềm
  bình bao bì thương mại làm (xem `docs/nesting-algorithms-esko-icut.md`). 47,6s → dưới giây
  cho hình giống nhau. NHƯNG: thuật toán mới, đổi layout ⇒ cần spec + golden mới + cổng chất
  lượng (utilization) + duyệt. Đây là hướng đúng cho file thật 357 tem của người dùng.
- **B-incremental — tái dùng miền qua các lượt.** `feasible_{n} = feasible_{n-1} \ NFP(con
  mới)` khi moving không đổi ⇒ O(N). Nhưng audit `NEST-AUD-10` đã đo bản ngây thơ **chậm
  hơn 51–57%** do miền phình lỗ. Chỉ khả thi nếu thêm giản-lược-miền định kỳ — rủi ro.
- **Raster-mask collision** — đổi kernel, xấp xỉ theo độ phân giải, đổi layout. Lô riêng.
- **Cap preview + tính chính xác nền** — loại: người dùng yêu cầu preview KHỚP kết quả bình.

**Đề xuất:** B7 (an toàn, làm ngay) để lấy phần thắng chắc chắn; song song chốt spec B8
(lưới nhanh cho hình giống nhau) vì đó mới là đòn bẩy lớn cho workload thật. Chờ người dùng
chọn hướng trước khi đụng engine tiếp.
