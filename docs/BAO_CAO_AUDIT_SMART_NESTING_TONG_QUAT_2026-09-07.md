# Audit smart nesting tổng quát — nhiều contour và interlock

Ngày: 2026-09-07  
Phạm vi: `imposition_core/src/mixed_nesting` → native/production artifact S&R và dàn nhiều mẫu.  
Trạng thái: **READ-ONLY / CHỜ DUYỆT — chưa sửa thuật toán**.

## 1. Kết luận điều hành

Phản hồi “trang 8 không lồng theo từng cặp” là triệu chứng của một khoảng trống rộng hơn:
engine hiện bảo đảm **hợp lệ hình học + motif tuần hoàn**, nhưng chưa có objective tổng quát cho
“lồng thông minh” (hõm–tai–đuôi, shared-edge, cavity fill, adjacency, contact quality).

Vì vậy không nên vá riêng contour trang 8. Hướng đúng là portfolio solver nhiều chiến lược,
giữ baseline làm sàn, thêm quality oracle độc lập và mở rộng search theo từng lớp:

1. đo được chất lượng interlock/cavity trên corpus nhiều dạng;
2. mở rộng motif/basis cho S&R (nhiều member/phase/góc, không chỉ `0/180`);
3. thêm angle competition/lookahead/LNS cho generic nesting;
4. chỉ công bố ứng viên qua cùng validator, không giảm floor hoặc phá preview/export parity.

## 2. Bằng chứng hiện trạng

### 2.1. Ca trang 8 — không phải lỗi PDF/CTM

Artifact runtime: `D:/pdfcompare/tmp/r2-r3-production-runtime-final/step-repeat.pdf`. Manifest
`trang-8` có 58 placement, góc `0°/180°` mỗi loại 29, dải pose theo Y là
`6/6/6/6/5/5/6/6/6/6`. Cặp `#1/#2` và `#3/#4` có khoảng cách contour lần lượt
`2,570688 mm`; chúng không phải cặp “đuôi chui vào hõm” riêng biệt.

Lattice hiện tại có pitch X `48,775379 mm`, chu kỳ hai hàng
`ΔX=-16,523024 mm`, `ΔY=82,124639 mm`; hai hàng 5 ở giữa là phase chạm biên tờ, không phải
tem bị mất ngẫu nhiên. CUT page 6 có `cm=0`, `Do=0`, manifest `validation.valid=true` và
floor source page 8 tăng `57 → 58`.

**Kết luận:** layout hiện hợp lệ và lặp, nhưng objective hiện hành không yêu cầu interlock
theo cặp. Đây là proof về khoảng trống chất lượng, không phải bằng chứng transform drift.

### 2.2. S&R periodic hiện tại

- `multi_start.rs:624-626`: khi baseline periodic hợp lệ, S&R bị khóa baseline; không chạy smart
  trials để cạnh tranh.
- `baseline/periodic.rs:646-712`: `pair_motifs()` chỉ sinh motif 2 member từ NFP/axis contact,
  giữ 3 cực trị theo diện tích/rộng/cao; không chấm contact length, cavity fill, adjacency
  hoặc interlock.
- `baseline/periodic.rs:819-841`: member thứ hai chỉ xét `primary + 180°`; không có cặp
  90°/góc tự do, motif >2 member, nhiều phase hoặc alternate orientation theo cell.
- `baseline/periodic.rs:24-30`: `Basis` chỉ có `pitch_x + row vector`; không biểu diễn topology
  motif biến đổi giữa các cell.

### 2.3. Generic nesting hiện tại

- `score.rs:185-193`: `LayoutScore` chỉ xếp theo invalid/unplaced → số tờ → envelope bbox →
  waste trong envelope → canonical key; không có metric interlock/cavity/contact/regularity.
- `candidates.rs:275-286`: region vertices được sort Bottom-Left rồi truncate theo beam; chưa
  bảo toàn đại diện pocket/contact đa dạng.
- `solver.rs:298-371` và `460-517`: gặp góc đầu tiên có pose hợp lệ thì dừng đường xếp; không
  so toàn bộ góc/bố cục trước khi kết luận.
- `refine.rs:205-218`: objective cục bộ chủ yếu `minY → minX`, không tối ưu contact/void/edge-fit.
- Không có global repack/Large Neighborhood Search; greedy incremental dễ mắc local optimum,
  bỏ cavity hoặc không quay lại các placement trước.

### 2.4. Holes và phạm vi sản phẩm

`normalize.rs:294-296` tính diện tích theo outer; collision/NFP MVP coi lỗ là vật liệu đặc.
Nesting tem vào lỗ là một capability khác, cần phase/contract riêng, không tự bật trong lô
interlock tổng quát này.

## 3. Findings

| Mã | Mức | Effort | Phát hiện có bằng chứng | Tác động |
|---|---|---:|---|---|
| §SMART.1 | P1 | L | S&R khóa baseline periodic, không có portfolio cạnh tranh | Không có đường tìm motif tốt hơn dù baseline hợp lệ nhưng nhìn rời rạc |
| §SMART.2 | P1 | M | Motif chỉ 1/2 member, 0/180, 3 cực trị hình học | Không mô hình hóa nhiều kiểu hõm–tai–đuôi/góc/phase |
| §SMART.3 | P1 | L | Score không có interlock/contact/cavity objective | Layout count/bbox giống nhau nhưng chất lượng lồng khác nhau vẫn bị coi ngang |
| §SMART.4 | P1 | L | Generic search first-valid-angle + Bottom-Left greedy, không LNS | Dễ mắc local optimum, bỏ pocket và hy sinh lựa chọn cục bộ cần thiết |
| §SMART.5 | P2 | M | Beam truncate theo Bottom-Left, edge-midpoint helper chưa có consumer solver | Mất diversity candidate trên contour nhiều cạnh |
| §SMART.6 | P2 | M | Test hiện chủ yếu validator/count/periodicity; thiếu quality oracle | Có thể pass xanh dù layout không đạt ý nghĩa “lồng thông minh” |
| §SMART.7 | P2 | M | Holes bị coi là vật liệu đặc | Không được tuyên bố hỗ trợ nesting vào lỗ trong lô này |

## 4. Corpus và metric cần chốt

### Corpus

- 13 trang `test/test nesting.pdf`, giữ source hash hiện hành và floor 6/7/8/12.
- Synthetic: rectangle/skinny, L/T/U, notch/jigsaw, lightning-tail, polygon lõm nhiều pocket,
  hole/frame, arbitrary angle 37°/143°, motif 3–4 member, obstacle corridor, mixed parts.
- Mỗi case có settings gap X/Y, margin, marks/obstacles, allowed-angle và expected floor.

### Metric độc lập

Ngoài count/sheet/validator cần ghi:

- min gap theo từng trục và số vi phạm;
- contact/shared-edge hoặc khoảng cách tới contact event;
- cavity occupancy / khoảng trống có thể lấp;
- adjacency graph theo member và hướng xoay;
- footprint/envelope/waste;
- motif residual/periodicity;
- runtime, NFP work, peak RSS, deterministic hash giữa worker grant.

Không dùng một metric “đẹp mắt” thay validator. Candidate chỉ được thắng khi qua final
validator và không giảm floor baseline.

## 5. Đề xuất lô triển khai sau khi duyệt

### Lô A — quality oracle + corpus (≤5 file)

Thêm metric contact/cavity/adjacency độc lập, fixture synthetic và report evidence. Chưa đổi
quyết định solver; mục tiêu là đo được “smart hơn”.

### Lô B — periodic motif portfolio (≤5 file)

Mở rộng motif candidate theo topology: nhiều member, nhiều phase, góc hữu hạn/free theo
request; chấm contact/cavity trước count tie-break. Giữ periodic authority và floor hiện tại.

### Lô C — generic angle/lookahead/LNS (≤5 file)

Cho solver giữ top-K candidate đa dạng, cạnh tranh góc/lookahead và một large-neighborhood
repack có budget. Không dùng partial candidate chưa validate; máy ≥16 GB không bị cap.

### Lô D — integration/artifact (≤5 file mỗi tầng)

Native version/provenance, backend preview/export parity, artifact 13 trang và GUI smoke.
Chỉ nâng rollout sau khi quality floor + artifact + runtime đạt.

## 6. Acceptance đề xuất

1. Không giảm floor `69/71/58/31` hiện tại và không phá count/gap/marks/cancel/validator.
2. Trên ít nhất 3 nhóm contour (lightning, L/T/U, notch/jigsaw), metric interlock/cavity tăng
   có kiểm soát hoặc count tăng mà không tăng số tờ.
3. S&R vẫn periodic; không biến thành free-gang greedy.
4. Generic solver có ít nhất một ca lookahead/LNS thắng greedy baseline trong cùng budget.
5. Preview/export dùng cùng manifest; CUT/Front parity và provenance giữ nguyên.
6. Báo cáo A/B tách rõ chất lượng, wall-clock và RSS; không gọi speedup từ một lượt warm.

**Trạng thái:** CHỜ DUYỆT các findings và thứ tự Lô A → B → C → D. Chưa sửa mã trong
đợt audit này.

## 7. Tiến độ thực hiện sau khi duyệt

### Lô A — oracle hậu kiểm (đã chấp nhận)

Đã thêm oracle độc lập tại `scripts/smart_nesting_quality.py` và test tại
`backend/tests/test_smart_nesting_quality.py`. Oracle đo sau solve, không được gọi từ
production solver: containment, obstacle, min gap, bbox-overlap/interlock mô tả và periodic
residual; hỗ trợ nested production pose, schema snake/camel case và transform đúng
`R*(p-reference)+translation`. Lỗ và clearance dị hướng không được tự tuyên bố hợp lệ:
oracle fail-closed khi chưa có contract đủ.

Kết quả: **9 tests passed**, 1 warning Pydantic hiện hữu. Lô này không thêm latency vào đường
nesting; metric interlock vẫn là tín hiệu mô tả, chưa đưa vào `LayoutScore`.

### Thử nghiệm production bị loại vì không đạt điều kiện tốc độ

- Xếp hạng motif bằng bbox-overlap (không thêm NFP/evaluation) giữ nguyên count/pose nhưng
  có lượt page 12 tăng khoảng 5,6 s → 10,4 s. **Không giữ bản sửa**.
- Beam stratified giữ nguyên số candidate/evaluation nhưng không tạo bằng chứng quality tăng;
  wall-clock dao động và có lượt page 12 vượt baseline. **Không giữ bản sửa**.

### Lô speed-safe đang giữ để verify

`periodic::phases()` đang được tách summary bbox/count để tránh cấp phát `Vec<Span>` ở phase
ranking rồi dựng lại ở `consider()`. Đây là thay đổi không đổi candidate/score/placement, chỉ
được chấp nhận nếu A/B cold/warm cùng grant chứng minh không chậm hơn. Native/runtime chưa
được cài lại trong lượt này.

Baseline và A/B được lưu tại `docs/audit/SMART_NESTING_GENERAL_BASELINE_20260907.json`,
`docs/audit/SMART_NESTING_LOT_A_EVIDENCE_20260907.json` và harness
`scripts/bench_smart_nesting_ab.py`. Lô speed-safe giữ nguyên count/hash
trên cả bốn trang; page 6/7 cải thiện nhẹ trong mẫu đo, page 8 gần ngang và page 12 biến động
theo tải máy nhưng không có quality loss. Không gọi đây là speedup toàn feature.

### Trạng thái sau khi thực hiện

- Oracle hậu kiểm đã giữ lại vì không chạm đường solve.
- Tách summary `Span` đã giữ lại sau A/B; nó không thêm NFP/evaluation và test/runtime smoke
  vẫn đạt. Wheel candidate đã cài vào `backend/venv` với build identity mới.
- Hai thử nghiệm thay đổi chất lượng trực tiếp (bbox-overlap motif ranking và stratified beam)
  **đã loại** vì không chứng minh được quality gain mà có lượt chậm hơn.
- A/B generic đúng nhánh solver (`ANGLE_ONLY`, `CONTINUOUS_XY`, `CONSTRAINTS`, `S20`) xác nhận
  stratified beam giữ count/score nhưng S20 đổi pose hash và p50 nhích từ khoảng 4,09s lên
  4,12s; `CONSTRAINTS` cũng nhích khoảng 3,42s lên 3,52s. Do không có quality gain, patch
  đã được bỏ. Không dùng A/B S&R để kết luận generic vì S&R bị khóa periodic baseline.
- Harness sau khi sửa đã truyền worker grant thực `15` và xác nhận native `.pyd` đúng file.
  Stratified beam trên generic corpus vẫn giữ nguyên score/count ở `ANGLE_ONLY`,
  `CONTINUOUS_XY`, `CONSTRAINTS`, `S20`, không chứng minh quality gain; không giữ patch.
- A/B angle-order diversity giữ số evaluation nhưng làm `S20` xấu hơn rõ rệt về envelope
  (`121168487 → 130800000` fixed area), nên cũng đã bỏ. Đây là bằng chứng trực tiếp rằng
  “đảo thứ tự góc” không đủ để gọi là smart và có thể giảm quality dù không tăng work.
- A/B thêm trung điểm cạnh NFP vào motif portfolio giữ count/hash nhưng page 12 tăng lên
  khoảng **11,7–12,5 s**; patch đã bỏ. Cạnh NFP có thể có tiềm năng interlock, nhưng phải
  được admitted bằng upper-bound/cost gate trước khi đưa vào hot path.
- Chưa đưa interlock metric vào `LayoutScore`; chưa mở motif portfolio/angle competition vô
  điều kiện. Đây là chốt bắt buộc để không làm nesting chậm hơn.

### Lô speed-safe được chấp nhận: lọc bbox trước row-contact intersection

`periodic.rs:row_contacts()` nay tiền lọc các vòng cấm chắc chắn ngoài cửa sổ bằng bbox theo
trục trước khi clone/đưa vào kernel `intersection`. Vòng còn khả năng giao vẫn đi qua kernel
exact; không đổi candidate, score hay validator.

Evidence A/B grant thực 15, cùng request/hash:

- page 6: 69 tem, pose hash không đổi;
- page 7: 71 tem, pose hash không đổi;
- page 8: 58 tem, pose hash không đổi;
- page 12: 31 tem, pose hash không đổi; lượt đo sau giảm khoảng 9,8s → 5,5s.

Wheel đã cài vào `backend/venv`; smoke production **145 passed**, 1 warning Pydantic hiện hữu.
