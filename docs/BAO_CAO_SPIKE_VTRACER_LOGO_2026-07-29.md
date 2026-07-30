# Báo cáo spike — Vector hóa logo bằng VTracer (cổng G1)

**Ngày:** 2026-07-29
**Trạng thái:** **ĐÃ ĐÍNH CHÍNH SAU AUDIT — G1 HOLD/NO-GO**
**Kế hoạch gốc:** `docs/KE_HOACH_PHAT_TRIEN_PHUC_HOI_VECTOR_LOGO_2026-07-29.md`
**Khảo sát gốc:** `docs/BAO_CAO_KHAO_SAT_TAI_DUNG_LOGO_2026-07-29.md`
**Công cụ spike:** `tools/logo_rebuild_spike/` (không phải mã sản phẩm, không vào installer)
**Máy đo:** i5-13400 (10C/16T), 31,8 GB RAM, Windows 11 Pro

---

## 0. Đính chính bắt buộc sau audit

Kết luận `27/29 = 93%` và “GO có điều kiện” bên dưới **đã bị thu hồi**. Metric cũ đo
ΔE trên toàn khung nên nền giống nhau che mất sai màu ở vùng logo nhỏ. Báo cáo audit và kết quả
khắc phục đầy đủ nằm tại `docs/BAO_CAO_AUDIT_SPIKE_VECTOR_LOGO_2026-07-29.md`.

Benchmark mới dùng ΔE trên vùng mực, corpus `train=29 / holdout=10 / reject=3` và cache
fingerprint `53b342e75bf7…` cho kết quả auto-color:

- holdout CLI: **3/10** ca đạt;
- holdout wheel: **2/10** ca đạt;
- phần đạt chủ yếu là đen trắng;
- reject pilot synthetic: precision/recall `1,000/1,000`, nhưng chưa có reject holdout thật;
- palette ground-truth oracle kéo ΔE50 holdout từ `9,37 → 0,38` (CLI) và
  `29,48 → 0,56` (wheel), nhưng đây không phải palette tự suy từ ảnh cũ.

Phán quyết hiện hành: **HOLD/NO-GO cho tích hợp sản phẩm đầy đủ**. Chưa chuyển probe vào
`native/`, chưa xây API/UI. Chỉ nên tiếp tục spike nhánh đen trắng và palette có người dùng xác nhận,
đồng thời bổ sung ảnh thật kèm vector gốc.

## 1. Kết luận lịch sử (không còn hiệu lực)

### [ĐÃ THU HỒI] GO có điều kiện — chọn đường crate Rust `vtracer 1.0.0-alpha.2` trong `pdfcompare_native`

Hai đường được đo song song trên cùng corpus, cùng bộ chỉ số:

| | Đường **crate/CLI 1.0.0-alpha.2** | Đường **wheel PyPI 0.6.15** |
|---|---|---|
| Tỷ lệ đạt toàn corpus | **27/29 = 93%** | 13/29 = 45% |
| Node trung bình (logo phẳng 5–12 màu) | **323** | 9.547 |
| Giới hạn số màu | có sẵn `max_colors` | **không có** — ta phải tự viết |
| Hủy giữa lúc chạy | **có, 6 ms** | **không thể** |
| Tiến độ | 709 báo cáo, 3 pha | không có |
| Cache phân vùng cho preview | có, nhanh 1,8× | không có |
| Giấy phép | MIT OR Apache-2.0 | MIT OR Apache-2.0 |
| Rủi ro | API alpha | năng lực thiếu, phải tự bù |

Khoảng cách không phải chuyện tinh chỉnh tham số. Bản 0.6.15 **thiếu hẳn** bốn năng lực mà
kế hoạch dựa vào (`max_colors`, fixed palette, ngưỡng thích ứng, curve simplification) — chúng
chỉ có từ 1.0. Muốn dùng 0.6.15 thì phải tự viết cả bốn, và phép thử cho thấy chỉ riêng bộ
lượng tử màu tự viết đã đủ làm mất màu thương hiệu (mục 4.2).

### Điều kiện kèm theo

1. **Nhóm logo 1–4 màu đạt 7/8 = 87,5%, thiếu 1 ca so với ngưỡng 90%.** Nguyên nhân đã chẩn
   đoán xong (mục 4.2), nằm ở bước lượng tử màu chứ không ở engine, và khắc phục được bằng
   palette khoá tay đã có trong kế hoạch. Cần bạn xác nhận coi đây là "đạt có điều kiện" hay
   yêu cầu đạt 90% trước khi mở cổng.
2. **Ghim đúng `=1.0.0-alpha.2`.** Bản alpha đổi API giữa các bản phát hành; không dùng dải
   `^1.0.0-alpha`.
3. **Chưa kiểm trên ground truth thật.** Toàn bộ số liệu ở đây là corpus synthetic. Xem mục 9.

---

## 2. Phương pháp

### 2.1 Corpus

32 ca synthetic có ground truth chính xác (SVG do script sinh), gồm 29 ca `pass`/`review` và
3 ca `reject`. Chi tiết ở `tools/logo_rebuild_spike/README.md`.

Ảnh được **dựng lại phối cảnh bằng đúng bốn góc đã lưu** trước khi trace. Chủ ý: ở G1 ta đo
chất lượng *vector hóa*, không đo chất lượng tự tìm bốn góc. Trộn hai thứ thì một engine tốt
bị trừ điểm vì lỗi của bước khác.

### 2.2 Chỉ số và tiêu chí đạt

Chỉ số quyết định là **boundary F-score** (bF) — trùng khớp đường biên ở sai số 0,75% đường
chéo. SSIM bị loại khỏi vai trò quyết định vì nó **bão hòa** trên logo phẳng: ca
`text_vn_sm__fabric_light` có SSIM 0,990 trong khi bF chỉ 0,471. Chấm bằng SSIM sẽ cho ca đó
gần như hoàn hảo.

Một ca đạt khi thoả **đồng thời**:

| Điều kiện | Ngưỡng | Vì sao |
|---|---|---|
| boundary F | ≥0,95 với hồ sơ `clean`; ≥ mốc ngưỡng thô của chính ca đó với hồ sơ suy giảm | `clean` là trần thật (1,000); ca suy giảm thì engine phải ít nhất bằng phép phân ngưỡng đơn giản |
| ΔE00 trung vị | ≤3,0 | chặn kiểu "thắng điểm biên bằng cách xoá màu" |
| số node | ≤ max(1500, 20× node ground truth) | kế hoạch đòi "không vượt mức khó chỉnh sửa" |
| tỷ lệ path vụn | ≤0,5 | tỷ lệ cao nghĩa là đang trace texture, không phải thiết kế |
| toạ độ | không NaN/Inf | |

Ca `reject` **không** tính vào tỷ lệ đạt — tính vào cột "phát hiện đúng" (mục 6).

### 2.3 Bốn lỗi phương pháp đã bắt và sửa trong quá trình đo

Ghi lại vì mỗi lỗi đều từng cho ra một kết luận sai:

1. **Chấm preset bằng bF đơn thuần** → chọn preset 2 màu cho nhóm 4 màu, 4 màu cho nhóm 12
   màu. bF là chỉ số biên, không phạt việc phá màu. Đã đổi sang xếp hạng đạt → bF → ít node.
2. **Cho số màu vào vòng tối ưu** → harness "gian" được bằng cách giảm màu. Trong sản phẩm số
   màu do người dùng chọn, nên số màu giờ cố định theo `expected_colors` của từng ca, chỉ quét
   độ mượt/despeckle/chế độ.
3. **Đo peak RAM bằng `GetProcessMemoryInfo` sau khi tiến trình thoát** → trả hằng số vô nghĩa
   (4,2 MB cho một interpreter Python, 5,8 MB cho một binary Rust xử lý ảnh). Đã chuyển sang
   Job Object `PeakProcessMemoryUsed`.
4. **Suy màu nền bằng "bin lượng tử lớn nhất"** → nhiễu tách một vùng màu thành nhiều bin,
   vùng hình thắng vùng nền và **mặt nạ bị đảo**; mốc bF nhảy 0,42↔1,00 giữa các ca đáng ra
   tương đương. Đã chuyển sang median viền ngoài, dùng **cùng một** màu nền cho cả hai mặt nạ.

`despeckle=0` bị loại khỏi ứng viên preset sau khi đo: ~29.000 node trên một thiết kế 23 node.
Các dòng d0 vẫn còn trong `stage1.jsonl` làm bằng chứng.

---

## 3. Kết quả chất lượng theo nhóm

Chặng 2 — toàn corpus, preset đã chọn, 64 lượt, **0 lỗi engine, 0 SVG chứa NaN/Inf**:

| Nhóm | Engine | Đạt | bF tb | Node tb | Giây tb |
|---|---|---|---|---|---|
| `flat_1_4` | **cli/crate** | **7/8** | 0,959 | **100** | 0,19 |
| `flat_1_4` | wheel | 2/8 | 0,671 | 1.926 | 0,20 |
| `flat_5_12` | **cli/crate** | **6/7** | 0,928 | **323** | 0,30 |
| `flat_5_12` | wheel | 0/7 | 0,836 | 9.547 | 0,35 |
| `bw` | **cli/crate** | **3/3** | 1,000 | **50** | 0,12 |
| `bw` | wheel | 2/3 | 0,987 | 262 | 0,07 |
| `line_art` | **cli/crate** | **3/3** | 1,000 | **226** | 0,09 |
| `line_art` | wheel | 3/3 | 0,997 | 834 | 0,08 |
| `text` | **cli/crate** | **8/8** | 0,998 | **238** | 0,04 |
| `text` | wheel | 6/8 | 0,949 | 492 | 0,04 |

Đối chiếu ngưỡng kế hoạch:

- **logo 1–4 màu ≥90%** → đường crate 87,5% (7/8). Thiếu đúng một ca.
- **logo 5–12 màu 75–80%** → đường crate **85,7% (6/7), đạt**.
- Chữ, đen trắng, nét mảnh: **100%**.

Chênh lệch node là điểm đáng chú ý nhất: nhóm 5–12 màu, crate cho **323** node còn wheel cho
**9.547**. Cùng chất lượng biên xấp xỉ nhau (0,928 vs 0,836) nhưng một bên ra artwork chỉnh
được, một bên thì không.

---

## 4. Hai ca không đạt — đã chẩn đoán đến gốc

Không kết luận "engine kém" khi chưa biết vì sao. Cả hai ca đều được soi riêng.

### 4.1 `flat8__lowres_jpeg` — crate, bF 0,574 (mốc ngưỡng thô 0,648)

Ảnh bị giảm còn 1/3 độ phân giải rồi nén JPEG chất lượng 62. Đây là ca `review` theo thiết
kế corpus, tức **phải cảnh báo chứ không phải phải làm đúng**. Kết quả dưới mốc ngưỡng thô
nghĩa là ở mức suy giảm này thông tin biên còn quá ít để engine làm tốt hơn phép phân ngưỡng.
Hệ quả sản phẩm: cần chặn/cảnh báo theo độ phân giải hữu dụng của vùng logo, không chỉ theo
kích thước ảnh.

### 4.2 `flat4__clean` — crate, bF 0,917 (ngưỡng `clean` 0,95)

Số liệu: **precision 1,000, recall 0,847**. Biên vẽ ra đều đúng, chỉ **thiếu**. Diện tích
thiếu 2,5% khung khớp đúng ô vuông nhỏ 160×160 px (2,56% khung). Ô đó vẫn được vẽ, nhưng màu
bị kéo từ xanh `(40,120,48)` sang xanh đen `(24,72,80)` — lọt vào ngưỡng "coi là nền".

Cùng gốc với thất bại nặng nhất của đường wheel: **`flat2__clean` wheel bF = 0,000**. Ground
truth có navy 85,4% + đỏ 13,5%; kết quả có navy 85,6% + `(48,48,88)` 14,3% — màu thứ hai vẫn
là navy, chỉ lệch 24 ở kênh đỏ. **Vành khuyên đỏ biến mất hoàn toàn.** Nguyên nhân là bộ lượng
tử median-cut mà *ta* phải tự viết cho đường wheel: nó chia theo số lượng pixel nên cả hai ô
palette rơi vào khối navy 85%, còn đỏ 13,5% bị gộp.

**Kết luận chung của hai ca:** màu chiếm **diện tích nhỏ** bị gộp hoặc kéo lệch khi palette
chật. Đây là rủi ro sản phẩm thật, vì logo thương hiệu thường có một màu nhấn diện tích nhỏ.
Biện pháp đã có trong kế hoạch, cần làm đúng chứ không được bỏ:

- palette chỉnh tay và **khoá màu** trước khi trace (`--palette` của 1.0 nhận palette cố định);
- phân cụm trong OKLab thay vì theo số lượng pixel;
- cảnh báo khi một màu trong palette đề xuất chiếm dưới ngưỡng diện tích;
- không gắn nhãn "màu gốc" cho màu ước lượng từ ảnh.

---

## 5. Hiệu năng và ngân sách RAM

Chặng 3 — đo riêng trên tiến trình sạch, peak lấy bằng Job Object:

| Cạnh ảnh | Pixel | crate/CLI giây | crate/CLI peak | wheel giây | wheel peak (đã trừ nền Python) |
|---|---|---|---|---|---|
| 500 px | 0,25 MP | 0,08 | 10,1 MB | 0,09 | 15,5 MB |
| 1.000 px | 1,0 MP | 0,29 | 31,7 MB | 0,40 | 51,0 MB |
| 2.000 px | 4,0 MP | 1,21 | 119,4 MB | 1,56 | 188,2 MB |
| 4.000 px | 16,0 MP | 5,13 | 462,2 MB | 6,39 | 730,6 MB |
| 6.000 px | 36,0 MP | 15,41 | 1.172,3 MB | 13,70 | 1.940,5 MB |

Quy luật rút ra, dùng để lập ngân sách:

- **crate: ≈32 byte/pixel.** wheel: ≈54 byte/pixel, tức tốn thêm ~65%.
- Thời gian tăng gần bậc hai theo cạnh ảnh: 0,25 MP → 36 MP là 144× pixel nhưng ~190× thời gian.
- Ảnh 4.000 px (16 MP) đã cần ~460 MB và ~5 s. Ảnh 6.000 px cần ~1,2 GB và ~15 s.

Đề xuất chính sách, tuân thủ nguyên tắc "máy yếu mới điều chỉnh":

| RAM máy | Chính sách |
|---|---|
| ≥16 GB (mốc tối thiểu đã thống nhất) | **không hard-cap**; kiểm ngân sách trước khi giải mã bằng công thức `pixel × 32 byte × hệ số an toàn`, thiếu RAM thì báo lỗi có hành động chứ không âm thầm hạ chất lượng — đúng mẫu `pdf_tools.py:76-92` |
| <16 GB | giảm cạnh preview, xử lý tuần tự, cảnh báo khi ảnh quá lớn |

**Không tự thêm `kind` mới vào `heavy_job_scheduler`.** Trần chung mặc định chỉ 2
(`heavy_job_scheduler.py:20-24`) và `acquire()` không timeout (`:47`). Một job vector hóa
0,2–0,3 s cho preview mà chiếm slot chung sẽ chặn N-Up/VDP/compare. Đề xuất: preview chạy
threadpool thường; chỉ stage nặng (ảnh rất lớn, AI tuỳ chọn) mới vào scheduler.

---

## 6. Ca phải từ chối — dấu hiệu phát hiện

Cả ba ca `reject` đều để lại dấu hiệu đo được, nên **phát hiện tự động là khả thi**:

| Ca | Engine | Path | Node | Tỷ lệ vụn | Kích thước SVG |
|---|---|---|---|---|---|
| `gradient_photo` | crate | 214 | 23.302 | 0,00 | 1.273,7 KB |
| `gradient_photo` | wheel | 197 | 14.013 | 0,85 | 837,8 KB |
| `embroidery` | crate | 1.214 | 8.862 | 0,59 | 545,7 KB |
| `embroidery` | wheel | 1.643 | 15.889 | 0,58 | 950,3 KB |
| `occluded` | crate | 81 | 504 | 0,83 | 32,2 KB |
| `occluded` | wheel | 101 | 609 | 0,94 | 38,0 KB |

Ba dấu hiệu tách bạch được ba loại:

- **chuyển sắc/ảnh chụp**: node rất cao (23.302) với path ít → mỗi vùng có biên cực phức tạp;
- **thêu**: path rất nhiều (1.214) kèm tỷ lệ vụn cao (0,59) → hình bị cắt thành sợi rời;
- **bị che**: node thấp nhưng tỷ lệ vụn rất cao (0,83) → chỉ còn mảnh vụn, không còn hình.

Lưu ý `occluded` chỉ 504 node và 32 KB nên **nằm trong ngân sách node** — nếu chỉ chặn bằng
độ phức tạp thì ca này lọt qua và trả về một SVG "hợp lệ" của một logo đã mất hơn nửa hình
học. Phải dùng tỷ lệ vụn kèm phân tích nội dung, không chỉ đếm node.

---

## 7. Kiểm chứng đường tích hợp Rust

Crate thử nghiệm `tools/logo_rebuild_spike/rust_probe/` — cdylib PyO3 **cùng phiên bản pyo3
0.29 với `native/Cargo.toml`**, ghim `vtracer =1.0.0-alpha.2`. Cố ý nằm ngoài `native/` để
không làm bẩn cây sản phẩm trong lúc còn spike.

| Câu hỏi | Kết quả |
|---|---|
| Biên dịch và liên kết vào cdylib PyO3? | **Có.** Wheel **290 KB**, crate chính biên dịch 24 s |
| Kết quả có khớp đường CLI? | **Có.** `flat12__fabric_uneven`: 13 path / **210 node** — trùng khít số CLI |
| `CancelToken` hủy thật? | **Có.** Hủy sau báo cáo đầu: dừng ở **6 ms** so với 245 ms chạy trọn |
| `Session` tái dùng phân vùng? | **Có.** Đổi độ mượt: 383 ms → 218,5 ms (**1,8×**); đổi tham số phân vùng: 237 ms |
| Tiến độ đủ hạt để vẽ thanh? | **Có.** **709 báo cáo** (Segment 192, Compose 514, Optimize 3), kết ở `Optimize 1.0` |

Hai điều này giải trực tiếp hai vấn đề đã ghi trong khảo sát:

- **§LR.07** (nút Hủy chỉ ngừng chờ ở UI, engine vẫn chạy): `CancelToken` cho hủy thật ở
  6 ms. Ngược lại, `vtracer.convert_raw_image_to_svg` của bản wheel là lời gọi native **chặn,
  không hủy được** — trong lúc benchmark đã có cấu hình chạy quá 10 phút không dừng, và cách
  duy nhất để bỏ là hạ tiến trình. Đó là lý do đường wheel trong harness phải chạy ở tiến
  trình con có hạn 30 s.
- **Preview kéo slider**: cache phân vùng cho 1,8× khi chỉ đổi tham số làm mượt.

Ngoài ra bản 1.0 trả `VectorDoc` làm mô hình path trung gian, khớp yêu cầu "không lưu raw
`<svg>` không kiểm soát làm nguồn chân lý" của khảo sát.

**Đính chính một điều dễ hiểu sai:** doc comment `config.rs:36` ghi `Hierarchical::Cutout` là
"not yet implemented". Đó là comment cũ chưa cập nhật — `mosaic.rs` là module đầy đủ và
`config.rs:311` đã nối `Cutout → Compositing::Mosaic`. Tính năng có thật.

---

## 8. Giấy phép và đóng gói

| Hạng mục | Kết quả |
|---|---|
| Giấy phép `vtracer` | **MIT OR Apache-2.0** — phù hợp chính sách dự án |
| Crate trong cây probe | 36 |
| Crate đã có trong cây `native/` | 297 |
| **Crate MỚI phải khai NOTICE** | **12** |
| Copyleft mạnh trong nhóm mới | **KHÔNG CÓ** |

12 crate mới: `vtracer 1.0.0-alpha.2`, `visioncortex 0.9.1`, `flo_curves 0.3.1` và `0.8.0`,
`ouroboros` + `ouroboros_macro 0.17.2`, `proc-macro-error` + `proc-macro-error-attr 1.0.4`,
`roots 0.0.6` và `0.0.8`, `bit-vec 0.6.3`, `aliasable 0.1.3`.
Giấy phép: 6× MIT OR Apache-2.0, 2× Apache-2.0, 2× BSD-2-Clause, 1× MIT, 1× MIT/Apache-2.0.

`scripts/gen_third_party_notices.py` đọc Rust qua `cargo metadata` trên 4 manifest nên **chỉ
cần thêm crate vào `native/Cargo.toml` là NOTICE tự cập nhật** — không phải khai tay.

Đường đóng gói: `maturin build --release` chạy được với đúng interpreter venv, ra wheel 290 KB.
Bước Nuitka không cần thêm `--include-package` vì crate đi cùng `pdfcompare_native` đã có
trong danh sách (`build_production.ps1:592`). Không cần thêm binary vào `tauri.conf.json`.

**Không dùng Potrace.** Ghi nhận lại hạng mục ngoài phạm vi: `backend/bin/potrace-1.16.win64/`
chứa `potrace.exe` + `mkbitmap.exe` GPL-2.0-or-later, **đang được git track**, không có
reference code nào, không khai trong NOTICE, không trong `.gitignore`. Không phải rủi ro
installer (không vào bundle) nhưng là rủi ro phân phối source. Cần xử lý riêng.

---

## 9. Hạn chế của spike này — đọc trước khi dùng số

1. **Chưa có ground truth thật.** Toàn bộ số liệu từ corpus synthetic. Bộ 16 ảnh thật ở
   `test/logo test` chỉ dùng smoke test: 14/16 file dưới 1,5 MP, không file nào kèm vector gốc,
   quyền sử dụng không rõ (Shutterstock preview, Taobao, Amazon, thumbnail YouTube), không file
   nào có EXIF orientation, chỉ 1 file có ICC, không file nào có alpha. Cần 3–4 ảnh khách **kèm
   file vector gốc**.
2. **Nhăn mạnh không được kiểm.** Hồ sơ `wrinkle_light` chỉ 3 px biên độ. Nhăn phi tuyến biên
   độ lớn thuộc R&D sau v1.
3. **Nhánh EXIF xoay và ICC lạ chưa kiểm** — corpus không có ca nào.
4. **Bước tự tìm bốn góc chưa kiểm.** Spike dựng lại phối cảnh bằng đúng ma trận đã biết, nên
   số liệu là chất lượng vector hóa với giả định người dùng đặt bốn góc đúng.
5. **Chỉ đo trên một máy 31,8 GB.** Theo thống nhất, lấy 16 GB làm mốc tối thiểu; không đo hồ
   sơ dưới 8 GB.
6. **`1.0.0-alpha.2` là bản alpha.** Không có cam kết ổn định API.
7. **Bộ rasterize để đo là tự viết** (SVG-subset → PDF reportlab → PDFium), đã qua 17 self-test
   nhưng chỉ chứng minh tập con ta emit — **không** chứng minh "mở được trong Inkscape/
   Illustrator". Việc đó phải kiểm tay.
8. Một lần chạy chặng 1 bị dừng bất thường (exit 1, không traceback, không APPCRASH, không tái
   hiện được sau 2 lần thử). Đã xử lý bằng cách ghi JSONL tăng dần + tự chạy lại, nên không mất
   dữ liệu, nhưng nguyên nhân chưa xác định.

---

## 10. Preset mặc định đề xuất

Số màu **không** nằm trong preset — người dùng chọn, hoặc bước gợi ý tự động ước lượng.

| Nhóm logo | Chế độ | Độ mượt (simplify) | Despeckle | Ghi chú |
|---|---|---|---|---|
| Phẳng 1–4 màu | color-cluster, spline | 1,0 (≈2,5 px) | 48 px | node tb 100 |
| Phẳng 5–12 màu | color-cluster, spline | 1,0 (≈2,5 px) | 48 px | node tb 323 |
| Đen trắng | binary | 0,5 | 4 px | node tb 50 |
| Nét mảnh | binary | 0,5 | 4 px | despeckle thấp để không ăn mất nét |
| Chữ | binary | 0,5 | 4 px | node tb 238, bF 0,998 |

Hai quy tắc rút ra từ số liệu:

- **Logo phẳng cần despeckle CAO (48 px) và simplify CAO.** Mức 4 px cho 3.000–9.000 node;
  mức 48 px cho 100–323 node với bF không giảm. `despeckle=0` cho ~29.000 node — không dùng.
- **Chữ và nét mảnh phải dùng chế độ nhị phân, despeckle THẤP.** Ngược hẳn logo phẳng: dấu
  tiếng Việt và nét 6 px sẽ bị coi là nhiễu nếu despeckle cao.

---

## 11. Đề xuất tích hợp sau khi G1 được duyệt

Giữ đúng thứ tự lô trong kế hoạch, mỗi lô ≤5 file. Điều chỉnh so với kế hoạch gốc:

**Lô A (thay cho "Lô A — lõi native" của kế hoạch):** thêm `vtracer` vào `native/Cargo.toml`
+ `native/src/logo_vectorizer.rs` + đăng ký trong `native/src/lib.rs` + test Rust + chạy lại
`gen_third_party_notices.py`. Chuyển thẳng từ `rust_probe/src/lib.rs` — nó đã là adapter nhận
RGBA thô, đúng hình dạng hợp đồng với `rust_bridge`.

Ba điểm phải làm đúng ngay từ lô A:

1. **Nhận RGBA thô, không nhận byte PNG.** Backend đã giải mã ảnh bằng Pillow/OpenCV; để Rust
   giải mã lần nữa là giải mã hai lần.
2. **Không đặt `[profile.release]` vào `native/Cargo.toml`.** `vtracer` dùng `edition 2024`
   nhưng đó là thuộc tính từng crate, không ảnh hưởng `edition 2021` của `pdfcompare_native`.
3. **Phơi `CancelToken` và `Progress` lên tới API**, không chỉ dùng nội bộ — đó là toàn bộ giá
   trị của việc chọn crate thay vì wheel.

Cảnh báo cho lô entitlement/routing (mục §SP.03/§SP.04 trong phạm vi đã báo trước): `util.logo_rebuild`
phải khai **đồng thời** ở `feature_entitlements.py` và `features.ts` + `featureIdForFocus`, và
hiện **không có test parity nào** giữa hai danh sách này. Nên thêm test parity cùng lô.

---

## 12. Cần phê duyệt

1. **GO/NO-GO** cho đường crate Rust `vtracer =1.0.0-alpha.2`.
2. Nhóm 1–4 màu đạt 87,5% (7/8), thiếu 1 ca so với ngưỡng 90%, nguyên nhân đã chẩn đoán và
   khắc phục được ở tầng palette: coi là **đạt có điều kiện**, hay yêu cầu đạt 90% trước?
3. Chốt các ngưỡng đề xuất trong mục 2.2, đặc biệt **ngân sách node `max(1500, 20× GT)`**.
4. Chấp nhận ghim một bản **alpha** cho thành phần nằm trên đường chạy sản phẩm?
5. Cấp 3–4 ảnh khách kèm vector gốc để có ground truth thật.
6. Hai hạng mục ngoài phạm vi cần quyết riêng: binary Potrace GPL đang track trong git, và
   `numpy` chưa được pin trong `backend/requirements*.txt` dù Nuitka gói tường minh.

---

## Phụ lục — dữ liệu thô

| Tệp | Nội dung |
|---|---|
| `private_test_corpus/logo_rebuild/synthetic/corpus.json` | metadata 32 ca |
| `.../bench/stage1.jsonl` | 1.057 lượt quét cấu hình |
| `.../bench/stage2.jsonl` | 64 lượt toàn corpus |
| `.../bench/results.json` | tổng hợp cả 3 chặng |
| `.../bench/presets.json` | preset đã chọn kèm điểm |
| `.../bench/compare/*.jpg` | ảnh so sánh 3 khung: ground truth \| đầu vào \| vector |

Corpus và kết quả **không commit** (`.gitignore:148`). Tái sinh bằng:

```powershell
$py = "D:\pdfcompare\backend\venv\Scripts\python.exe"
& $py tools\logo_rebuild_spike\make_synthetic_corpus.py
& $py tools\logo_rebuild_spike\run_bench.py
```
