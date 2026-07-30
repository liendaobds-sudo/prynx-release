# Báo cáo audit — Spike VTracer cho Phục hồi & Vector hóa Logo

**Ngày audit:** 2026-07-29  
**Trạng thái:** Đã sửa Lô 1–4 và chạy lại benchmark — **G1 vẫn HOLD/NO-GO**  
**Phạm vi:** `tools/logo_rebuild_spike/`, corpus synthetic, dữ liệu benchmark G1,
`docs/BAO_CAO_SPIKE_VTRACER_LOGO_2026-07-29.md` và phần license liên quan  
**Ngoài phạm vi:** mã PrynX không thuộc logo rebuild và toàn bộ thay đổi song song đang có trong
working tree

---

## 0. Kết quả khắc phục sau khi được duyệt

Phần 1–8 bên dưới giữ nguyên bằng chứng audit **trước khi sửa** để truy vết. Đợt khắc phục đã
hoàn tất bốn lô mã và chạy lại toàn bộ đường quick-benchmark bằng cùng một fingerprint:

`53b342e75bf7c39dd1e7eb4b5af7f7fbfa0285ed202d2b20295f34293b336843`

### Trạng thái 12 phát hiện

| Mã | Trạng thái sau sửa | Bằng chứng đóng |
|---|---|---|
| §VL.01 | Đã đóng | ΔE50 đo trên mask mực GT; self-test vùng nhỏ cho `0,00 → 47,90` |
| §VL.02 | Đã đóng | nhóm text chọn preset màu `c2/c3`, preset binary không còn thắng nhóm nhiều màu |
| §VL.03 | Đã đóng | `flat2__alpha` có alpha `(0,255)`, alpha IoU CLI `0,9936` |
| §VL.04 | Đã đóng ở synthetic | split `train=29`, `holdout=10`, `reject=3`; 5 hình học holdout không vào stage 1 |
| §VL.05 | Đã đóng ở mức pilot | reject v2 xuất precision/recall; synthetic đạt TP=6, FP=0, FN=0 |
| §VL.06 | Đã đóng | cache schema 2 băm corpus, source, wheel và CLI; `results.json` chỉ merge cùng `cache_id` |
| §VL.07 | Đã đóng phép thử | stage 4 A/B fixed-palette trên 29 ca màu, tách train/holdout |
| §VL.08 | Đã đóng | corpus/CLI tính từ repo và có `--corpus`, `--cli`, `VTRACER_CLI` |
| §VL.09 | Đã đóng | ignore chính xác `/tools/logo_rebuild_spike/rust_probe/target/` |
| §VL.10 | Đã đóng | README có `PYO3_PYTHON`, `VIRTUAL_ENV`, cargo/maturin; `smoke.py` chạy đạt |
| §VL.11 | Đã đóng | chỉ `vtracer::Error::Cancelled` được coi là hủy; lỗi khác nổi thành Python error |
| §VL.12 | Đã đóng tài liệu | lệnh chuẩn đặt UTF-8 trước self-test; tổng 54/54 self-test Python đạt |

### Kết quả benchmark mới

Corpus mới có 42 ca, trong đó 39 ca có ground truth. Quick stage 1 chạy 108/108 lượt;
stage 2 chạy 84/84; stage 4 chạy 58/58. Không có lỗi engine, SVG NaN/Inf hoặc key trùng.

| Split/nhóm | CLI đạt | Wheel đạt |
|---|---:|---:|
| Train flat 1–4 màu | 1/8 | 0/8 |
| Train flat 5–12 màu | 0/7 | 0/7 |
| Train đen trắng | 3/3 | 2/3 |
| Train line art | 0/3 | 0/3 |
| Train text | 0/8 | 0/8 |
| Holdout flat 1–4 màu | 0/2 | 0/2 |
| Holdout flat 5–12 màu | 0/2 | 0/2 |
| Holdout đen trắng | 2/2 | 2/2 |
| Holdout line art | 0/2 | 0/2 |
| Holdout text | 1/2 | 0/2 |

Kết luận chất lượng: **không đạt G1 khi chạy auto-color**. Holdout tổng chỉ đạt 3/10 với CLI
và 2/10 với wheel; phần đạt chủ yếu là đen trắng.

Palette oracle chứng minh sai màu có thể cứu được, nhưng chưa giải quyết hoàn toàn hình học/độ phức tạp:

| Split | Engine | ΔE50 auto → palette | Ca cải thiện | Chênh ca đạt |
|---|---|---:|---:|---:|
| Train | CLI | 11,40 → 1,69 | 23/23 | +1 |
| Train | wheel | 27,43 → 1,40 | 22/23 | +16 |
| Holdout | CLI | 9,37 → 0,38 | 6/6 | +0 |
| Holdout | wheel | 29,48 → 0,56 | 6/6 | +6 |

Đây là **oracle upper-bound** lấy palette từ SVG ground truth, không phải bằng chứng hệ thống tự suy
palette được từ ảnh cũ. Wheel được lợi lớn; CLI vẫn trượt holdout màu do node/biên dù màu đã đúng.

### RAM đo lại

| Cạnh ảnh | CLI | Wheel (phần engine) |
|---:|---:|---:|
| 500 px | 10,3 MB | ~15,2 MB |
| 1.000 px | 32,6 MB | ~51,1 MB |
| 2.000 px | 120,1 MB | ~187,7 MB |
| 4.000 px | 462,2 MB | ~729,8 MB |
| 6.000 px | 1.172,8 MB | ~1.940,7 MB |

### Phán quyết sau sửa

- **HOLD/NO-GO cho tích hợp sản phẩm đầy đủ.** Không chuyển probe vào `native/` và chưa làm UI/API.
- Có thể tiếp tục spike nhánh **đen trắng** và nhánh **palette do người dùng xác nhận**.
- Trước khi mở G1 vẫn thiếu 3–4 ảnh thật có vector gốc, reject holdout độc lập và vòng matrix đầy đủ
  (kết quả trên là quick matrix 6 cấu hình, dùng để audit tính đúng của đường đo).

## 1. Kết luận điều hành

### HOLD — chưa duyệt cổng G1 theo tỷ lệ 27/29 hiện tại

Spike có nhiều phần làm tốt:

- tách công cụ khảo sát khỏi mã sản phẩm;
- corpus có metadata và ground truth synthetic;
- có boundary F-score, độ phức tạp path và đo peak RAM;
- so hai đường VTracer trên cùng dữ liệu;
- ghim phiên bản alpha cụ thể;
- adapter Rust nhận RGBA thô, có kiểm tràn kích thước;
- self-test hình học và metric có chiều sâu;
- báo cáo công khai nhiều hạn chế thay vì che giấu.

Tuy nhiên tiêu chí màu đang đo sai miền. `run_bench.evaluate()` tính ΔE trên **toàn khung ảnh**,
gồm phần nền, trong khi nhiều logo chỉ chiếm vài phần trăm diện tích. Nền trắng/navy giống nhau
làm trung vị ΔE rất thấp ngay cả khi toàn bộ chữ hoặc màu nhấn bị đổi màu.

Tái đo 29 ca có ground truth bằng cùng SVG, cùng preset, chỉ thay ΔE sang vùng mực ground truth:

| Engine | Báo cáo hiện tại | Đo lại trên vùng mực |
|---|---:|---:|
| crate/CLI 1.0.0-alpha.2 | **27/29** | **9/29** |
| wheel 0.6.15 | **13/29** | **3/29** |

Ví dụ:

| Ca | ΔE50 hiện tại | ΔE50 vùng mực | Kết quả |
|---|---:|---:|---|
| `text_vn_lg__clean`, CLI | **0,00** | **21,19** | preset nhị phân giữ biên nhưng làm mất màu chữ |
| `text_vn_sm__clean`, CLI | **0,00** | **20,53** | tương tự |
| `lineart__clean`, CLI | **0,00** | **21,38** | màu navy bị chuyển thành nhị phân |
| `flat2__clean`, CLI | 0,379 | 11,95 | màu nhấn lệch đáng kể |

Vì tỷ lệ đạt là căn cứ chính để mở cổng G1, phát hiện này làm mất hiệu lực của kết luận
“93% đạt” cho đến khi sửa metric, chọn lại preset và chạy lại toàn bộ benchmark trên dữ liệu
được tách train/holdout.

### Phán quyết đề xuất

1. **Giữ VTracer 1.0.0-alpha.2 là ứng viên ưu tiên**, vì bằng chứng về tốc độ, node, khả năng
   hủy và API Rust vẫn có giá trị.
2. **Không dùng tỷ lệ 27/29 để duyệt tích hợp sản phẩm.**
3. Sửa bộ đo và corpus trước, chạy lại G1, sau đó mới quyết định GO/NO-GO.
4. Chưa chuyển code probe vào `native/` trước khi các phát hiện P0/P1 được đóng.

---

## 2. Bằng chứng đã chạy

### 2.1 Self-test Python

Với `PYTHONIOENCODING=utf-8`:

| Bộ kiểm | Kết quả |
|---|---:|
| `engines.py --self-test` | 15/15 đạt |
| `svg_raster.py --self-test` | 17/17 đạt |
| `metrics.py --self-test` | 17/17 đạt |
| Tổng | **49/49 đạt** |

Không đặt UTF-8 thì cả ba script dừng ở lần `print()` tiếng Việt đầu tiên bằng
`UnicodeEncodeError` trên console CP1252.

### 2.2 Corpus và dữ liệu thô

- metadata: 32 ca;
- có ground truth: 29 ca;
- `stage1.jsonl`: 1.057 dòng, không trùng key `(case_id, engine, config)`;
- `stage2`: 64 dòng, không trùng key;
- lỗi engine trong stage 2: 0;
- tỷ lệ theo dữ liệu thô khớp các bảng trong báo cáo hiện tại;
- corpus validator trả “Corpus hợp lệ”.

Như vậy bảng hiện tại được tổng hợp nhất quán từ dữ liệu thô. Sai lệch nằm ở định nghĩa metric
và thiết kế phép thử, không phải lỗi chép số vào báo cáo.

### 2.3 Tái đo màu độc lập

Đã chạy lại cả hai engine trên 29 ca có ground truth:

1. giữ nguyên ảnh đã dựng lại;
2. giữ nguyên preset từ `presets.json`;
3. giữ nguyên boundary F, node budget và tiny path;
4. chỉ đổi ΔE từ toàn khung sang vùng mực của ground truth.

Kết quả crate/CLI giảm 27 → 9 ca đạt; wheel giảm 13 → 3.

### 2.4 Rust probe

- artifact release cũ còn trên máy: `logo_vectorizer_probe.dll`, 614.400 byte;
- `cargo check` mới không tự chạy được vì PyO3 không tìm thấy Python;
- module `logo_vectorizer_probe` hiện không import được từ venv;
- README không có quy trình build/install/chạy assertion cho Rust probe.

Điều này không phủ định lần build đã ghi trong báo cáo, nhưng khiến bằng chứng Rust khó tái lập
độc lập từ tài liệu hiện có.

---

## 3. Bảng phát hiện

| Mã | Mức | Effort | Tóm tắt |
|---|---:|---:|---|
| §VL.01 | P0 | M | ΔE đo cả nền làm tỷ lệ đạt G1 sai |
| §VL.02 | P1 | S | Preset nhị phân được phép thắng nhóm chữ nhiều màu |
| §VL.03 | P1 | M | Ca `alpha` thực tế không có pixel trong suốt |
| §VL.04 | P1 | M | Tập chọn preset và tập nghiệm thu dùng lại cùng 9 thiết kế |
| §VL.05 | P1 | M | Chưa có bộ phân loại/tiêu chí đạt cho ca `reject` |
| §VL.06 | P1 | M | Cache JSONL không có version/hash, có thể tái dùng số đo cũ sau khi đổi metric |
| §VL.07 | P1 | M | Giải pháp palette khóa màu chưa được benchmark trên ca thất bại |
| §VL.08 | P2 | S | Đường dẫn tuyệt đối khóa spike vào `D:\pdfcompare` |
| §VL.09 | P2 | S | `rust_probe/target` không được ignore |
| §VL.10 | P2 | M | Rust probe thiếu lệnh tái lập và assertion tự động |
| §VL.11 | P2 | S | `probe_cancel` coi mọi lỗi pipeline là hủy thành công |
| §VL.12 | P3 | S | Self-test phụ thuộc cấu hình encoding console thủ công |

---

## 4. Chi tiết phát hiện

### §VL.01 — [VERIFIED] P0: ΔE đo cả nền làm tỷ lệ đạt G1 sai

**Bằng chứng mã:**

- `tools/logo_rebuild_spike/run_bench.py:174-180` render ảnh dự đoán rồi gọi
  `delta_e_stats(gt_small, pred)` mà không truyền mask;
- `tools/logo_rebuild_spike/metrics.py:143-157` chỉ giới hạn phép đo khi tham số `mask` được
  truyền;
- `case_passes()` tại `run_bench.py:210-221` dùng trực tiếp `delta_e50 ≤ 3` làm điều kiện đạt.

**Bằng chứng số:**

- `text_vn_lg__clean` có vùng mực khoảng 3,8% khung;
- ΔE toàn khung = 0,00;
- ΔE trên vùng mực = 21,19;
- preset đang dùng là `binary=True`, nên màu chữ navy/đỏ bị chuyển thành nhị phân;
- kết quả vẫn được tính là đạt trong báo cáo hiện tại.

**Ảnh hưởng:**

- tiêu chí “ΔE chặn kiểu thắng điểm biên bằng cách xóa màu” không thực hiện được mục tiêu;
- preset sai màu có thể thắng;
- tỷ lệ 27/29 không còn hợp lệ làm cổng GO.

**Hướng sửa:**

- tính ΔE trên vùng mực ground truth hoặc union vùng mực;
- đồng thời báo:
  - ΔE trên vùng giao;
  - ΔE trên vùng ground truth;
  - tỷ lệ coverage bị mất/thừa;
- ca không còn vùng giao phải trượt màu, không trả ΔE = 0;
- thêm self-test “logo nhỏ trên nền lớn nhưng sai màu hoàn toàn”.

### §VL.02 — [VERIFIED] P1: Preset nhị phân được phép thắng nhóm chữ nhiều màu

**Bằng chứng:**

- `best_presets()` chỉ bắt `colors == expected_colors` khi `binary` là false tại
  `run_bench.py:378-381`;
- cấu hình nhị phân vì vậy được phép cạnh tranh với cấu hình màu cho nhóm `text`;
- `presets.json` chọn `c8-s0.5-d4-bw` cho toàn bộ `text` của cả CLI và wheel;
- corpus khai `text_vn_lg` có 3 màu tại
  `make_synthetic_corpus.py:466-473`.

**Ảnh hưởng:**

Các ca chữ đạt boundary F gần 1 nhưng không giữ màu thiết kế. §VL.01 làm lỗi này bị che.

**Hướng sửa:**

- chỉ cho binary cạnh tranh khi `expected_colors ≤ 2` và semantic của ca cho phép đơn sắc;
- tách `text_monochrome` và `text_multicolor`;
- màu chữ không được biến thành đen trắng nếu người dùng không chọn chế độ đó.

### §VL.03 — [VERIFIED] P1: Ca `alpha` không thực sự kiểm nền trong suốt

**Bằng chứng:**

- `logo_flat()` luôn vẽ một path kín phủ toàn khung tại
  `make_synthetic_corpus.py:108-122`;
- hồ sơ `alpha` chỉ giữ nguyên RGBA tại `:357-360`, nhưng ảnh gốc đã kín toàn khung;
- đo trực tiếp `flat2__alpha` cho alpha extrema `(255, 255)`: không có pixel trong suốt;
- `prepare()` ghép ground truth lên trắng và `rectify()` trả RGB tại
  `run_bench.py:134-149` và `make_synthetic_corpus.py:589-598`.

**Ảnh hưởng:**

Corpus có nhãn `alpha` nhưng không kiểm:

- bảo toàn vùng trong suốt;
- không sinh path nền giả;
- xuất SVG/PNG trong suốt;
- màu RGB ẩn dưới alpha.

**Hướng sửa:**

- thêm logo không có path nền, alpha extrema phải chứa cả 0 và 255;
- giữ RGBA qua bước rectify;
- metric alpha riêng: IoU alpha, halo và path nền;
- test SVG render trên ít nhất hai màu nền.

### §VL.04 — [VERIFIED] P1: Không có holdout độc lập

**Bằng chứng:**

- corpus có 9 thiết kế gốc tại `make_synthetic_corpus.py:452-474`;
- 32 “ca” chủ yếu là các degradation khác nhau của 9 thiết kế đó;
- `representative_cases()` chọn một profile của chính các thiết kế này để chọn preset tại
  `run_bench.py:226-240`;
- stage 2 lại chấm toàn bộ profile của cùng 9 thiết kế tại `:411-488`;
- các ca dùng để chọn preset nằm trong tỷ lệ nghiệm thu.

**Ảnh hưởng:**

Tỷ lệ đạt đo khả năng khớp với các biến thể của thiết kế đã dùng để tối ưu, chưa chứng minh khả
năng tổng quát sang logo mới.

**Hướng sửa:**

- tách theo **design**, không tách theo profile;
- thiết kế dùng để chọn preset tuyệt đối không xuất hiện trong holdout;
- thêm ít nhất 5–10 hình học mới cho mỗi nhóm chính;
- báo riêng train/validation/holdout;
- ground truth thật của khách chỉ dùng holdout cuối.

### §VL.05 — [VERIFIED] P1: Chưa kiểm được “phát hiện đúng” ca reject

**Bằng chứng:**

- nhánh `prep is None` tại `run_bench.py:434-458` chỉ ghi path, node và tiny ratio;
- không có `rejected`, `reject_reason`, threshold hoặc pass/fail;
- `summarize()` chỉ in bảng các tín hiệu tại `:567-574`;
- chỉ có 3 positive sample, không có negative sample gần biên để đo false positive.

**Ảnh hưởng:**

Kết luận “phát hiện tự động là khả thi” là giả thuyết có bằng chứng ban đầu, chưa phải phép thử
đạt cổng. Không biết threshold nào vừa bắt `occluded` vừa không chặn nhầm logo nét mảnh.

**Hướng sửa:**

- định nghĩa classifier/rule cụ thể;
- đo precision, recall và false-positive rate;
- thêm ca khó nhưng hợp lệ có node/path tương tự ca reject;
- mỗi ca reject phải có lý do được phát hiện khớp expectation.

### §VL.06 — [VERIFIED] P1: Cache JSONL không có provenance/invalidation

**Bằng chứng:**

- `load_done()` chỉ dùng key `(case_id, engine, config)` tại
  `run_bench.py:247-271`;
- dữ liệu không chứa:
  - schema benchmark;
  - hash corpus;
  - hash script/metric;
  - phiên bản engine thực;
  - commit;
  - run id;
- stage 2 bỏ qua ca đã có cùng key tại `:431-432`.

**Ảnh hưởng:**

Sau khi sửa §VL.01 nhưng giữ nguyên case/config, benchmark có thể tiếp tục dùng dòng ΔE cũ và
trả lại kết luận sai. Thay ảnh nhưng giữ `case_id` cũng gặp vấn đề tương tự.

**Hướng sửa:**

- thêm `BENCH_SCHEMA_VERSION`;
- hash corpus metadata + file đầu vào + ground truth;
- ghi engine version và tool hash;
- không khớp provenance thì không tái dùng cache;
- kết quả tổng hợp phải ghi checksum dữ liệu nguồn.

### §VL.07 — [VERIFIED] P1: Palette khóa màu chưa được chứng minh

**Bằng chứng:**

- báo cáo nói ca thiếu ngưỡng 90% “khắc phục được bằng palette khóa tay”;
- `TraceConfig` không có trường palette tại `engines.py:63-76`;
- `trace_cli()` không truyền `--palette` tại `engines.py:367-409`;
- không có ca benchmark A/B trước/sau palette khóa.

**Ảnh hưởng:**

Khả năng tồn tại trong VTracer không đồng nghĩa giải pháp đã đạt trên ảnh logo. Điều kiện dùng để
chấp nhận 87,5% chưa được kiểm nghiệm.

**Hướng sửa:**

- thêm fixed palette vào adapter spike;
- chạy lại hai ca màu nhấn nhỏ;
- đo cả boundary, ΔE vùng mực và tỷ lệ coverage;
- chỉ ghi “khắc phục được” khi có số liệu.

### §VL.08 — [VERIFIED] P2: Đường dẫn tuyệt đối làm spike không di động

**Bằng chứng:**

- `engines.py:49`: CLI cố định tại `D:\pdfcompare\tmp\...`;
- `run_bench.py:55`: corpus cố định tại `D:\pdfcompare\...`;
- `make_synthetic_corpus.py:44`: output mặc định cố định;
- README cũng giả định đúng đường dẫn máy này.

**Ảnh hưởng:**

Clone/worktree khác, máy đội ngũ hoặc CI không chạy được mà phải sửa source.

**Hướng sửa:**

- suy repo root từ `Path(__file__)`;
- cho phép `--corpus`, `--out`, `--cli`;
- env chỉ là override;
- không lưu đường dẫn máy vào artifact.

### §VL.09 — [VERIFIED] P2: Build artifact Rust không được ignore

**Bằng chứng:**

- `.gitignore:28-32` chỉ ignore target của bốn crate chính;
- `tools/logo_rebuild_spike/rust_probe/target/` hiện xuất hiện thành hàng nghìn file untracked;
- `git check-ignore` không khớp target của probe.

**Ảnh hưởng:**

- nhiễu `git status` và mọi lần quét;
- nguy cơ stage nhầm binary/cache lớn;
- audit source chậm và dễ timeout.

**Hướng sửa:**

Ignore chính xác `tools/logo_rebuild_spike/rust_probe/target/` hoặc dùng rule `**/target/` sau khi
đánh giá ảnh hưởng toàn repo.

### §VL.10 — [VERIFIED] P2: Rust probe thiếu đường verify tự động

**Bằng chứng:**

- README không có lệnh build/install/test `rust_probe`;
- các hàm probe chỉ được export qua PyO3, không có Rust test hay Python test assertion;
- `cargo check` không tự tìm thấy Python nếu thiếu `PYO3_PYTHON`;
- module không import được từ venv hiện tại.

**Ảnh hưởng:**

Số liệu hủy 6 ms, cache 1,8× và 709 progress report không thể được người khác tái lập bằng một
lệnh tài liệu hóa.

**Hướng sửa:**

- thêm script verify Rust probe;
- set `PYO3_PYTHON` về venv một cách rõ ràng;
- build wheel, install tạm, chạy assertion;
- kiểm output CLI và PyO3 tương đương trên fixture;
- xóa/uninstall artifact thử nghiệm sau verify nếu cần.

### §VL.11 — [VERIFIED] P2: `probe_cancel` đồng nhất mọi lỗi với “đã hủy”

**Bằng chứng:**

`rust_probe/src/lib.rs:153-156`:

```rust
let result = pipeline.run_with_progress(&img, &cancel, &mut on_progress);
let cancelled = result.is_err();
```

**Ảnh hưởng:**

Một lỗi engine không liên quan tới cancel cũng được báo là hủy thành công.

**Hướng sửa:**

- match đúng biến thể lỗi cancellation;
- lỗi khác phải bubble lên và làm probe fail;
- thêm negative test: chạy không cancel phải hoàn thành;
- thêm cancel ở nhiều pha.

### §VL.12 — [VERIFIED] P3: Self-test phụ thuộc encoding console

**Bằng chứng:**

Ba self-test dừng bằng `UnicodeEncodeError` nếu chạy đúng command nhưng chưa đặt
`PYTHONIOENCODING=utf-8`. README có ghi workaround tại dòng 62–67.

**Ảnh hưởng:**

Không sai thuật toán nhưng làm lệnh verify dễ thất bại giả trên Windows.

**Hướng sửa:**

- cấu hình stdout UTF-8 trong entrypoint khi có thể;
- hoặc thêm wrapper PowerShell duy nhất;
- README phải liệt kê cả self-test `engines.py`;
- cập nhật số lượng test thực tế (`svg_raster.py` hiện 17, không phải 13).

---

## 5. Hạn chế đã công khai, chưa tính là bug mới

Các điểm sau đã được báo cáo spike thừa nhận đúng và vẫn là điều kiện chặn phát hành:

- chưa có 3–4 ảnh khách kèm vector ground truth;
- chưa kiểm EXIF orientation;
- chưa kiểm ICC lạ;
- chưa kiểm nhăn mạnh;
- chưa kiểm tự tìm bốn góc;
- chỉ đo RAM trên một máy 31,8 GB;
- VTracer đang ở phiên bản alpha;
- chưa kiểm mở file bằng Inkscape/Illustrator thật;
- chưa điều tra được một lần stage 1 dừng bất thường.

Audit không lặp các điểm này thành phát hiện “mới”, nhưng cổng G1 sau sửa vẫn phải ghi rõ chúng.

---

## 6. Thứ tự sửa đề xuất

### Lô 1 — Sửa tính đúng của phép đo (tối đa 4 file)

1. `tools/logo_rebuild_spike/metrics.py`
2. `tools/logo_rebuild_spike/run_bench.py`
3. `tools/logo_rebuild_spike/make_synthetic_corpus.py`
4. `tools/logo_rebuild_spike/README.md`

Đóng: §VL.01, §VL.02, §VL.03.

Verify:

- self-test màu sai trên logo nhỏ;
- ca alpha thật;
- xóa/invalidate benchmark cũ có kiểm soát;
- chạy lại stage 1 và stage 2.

### Lô 2 — Provenance và tính di động (tối đa 5 file)

1. `tools/logo_rebuild_spike/run_bench.py`
2. `tools/logo_rebuild_spike/engines.py`
3. `tools/logo_rebuild_spike/make_synthetic_corpus.py`
4. `tools/logo_rebuild_spike/README.md`
5. `.gitignore`

Đóng: §VL.06, §VL.08, §VL.09, §VL.12.

### Lô 3 — Holdout, reject và palette (tối đa 4 file)

1. `tools/logo_rebuild_spike/corpus_spec.py`
2. `tools/logo_rebuild_spike/make_synthetic_corpus.py`
3. `tools/logo_rebuild_spike/engines.py`
4. `tools/logo_rebuild_spike/run_bench.py`

Đóng: §VL.04, §VL.05, §VL.07.

Verify:

- split theo design;
- holdout không trùng hình học;
- fixed palette A/B;
- reject precision/recall;
- không giảm ngưỡng để làm đẹp tỷ lệ.

### Lô 4 — Rust probe tái lập (tối đa 4 file)

1. `tools/logo_rebuild_spike/rust_probe/src/lib.rs`
2. `tools/logo_rebuild_spike/rust_probe/Cargo.toml`
3. script verify mới;
4. `tools/logo_rebuild_spike/README.md`

Đóng: §VL.10, §VL.11.

### Lô 5 — Chạy lại và cập nhật báo cáo

- sinh corpus mới;
- chạy toàn bộ benchmark;
- lưu checksum/tóm tắt có provenance;
- cập nhật `BAO_CAO_SPIKE_VTRACER_LOGO_2026-07-29.md`;
- không ghi đè số cũ mà không có mục “đính chính”.

---

## 7. Tiêu chí mở lại cổng G1

Chỉ đề xuất GO khi:

1. ΔE đo trên vùng mực và self-test chứng minh nền không che lỗi màu.
2. Preset màu không bị preset binary thắng trái semantic.
3. Ca alpha có pixel 0/255 thật và kiểm được halo/path nền.
4. Tập holdout không dùng chung design với tập chọn preset.
5. Tỷ lệ đạt được tính lại hoàn toàn từ cache có provenance mới.
6. Ca reject có rule/classifier cụ thể và đo false positive.
7. Palette khóa màu được chứng minh trên ca màu nhấn nhỏ.
8. Rust probe chạy lại được bằng lệnh tài liệu hóa.
9. Có ít nhất 3–4 ảnh thật kèm vector gốc để kiểm holdout cuối.
10. Báo cáo phân biệt rõ:
    - chất lượng hình học;
    - chất lượng màu;
    - khả năng chỉnh sửa;
    - khả năng từ chối đầu vào không phù hợp.

---

## 8. Đề nghị phê duyệt

Các lô 1–4 đã được duyệt và hoàn tất. Benchmark mới xác nhận đường đo đã đúng nhưng chất lượng auto-color
vẫn không đạt G1. Giữ probe ngoài `native/`; không xây API/UI sản phẩm từ baseline 93% cũ.
