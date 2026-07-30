# Spike: Phục hồi & Vector hóa Logo (`logo_rebuild`) — công cụ Giai đoạn 0

Bộ công cụ **chỉ dùng để khảo sát**, phục vụ cổng duyệt G0/G1 của kế hoạch
`docs/KE_HOACH_PHAT_TRIEN_PHUC_HOI_VECTOR_LOGO_2026-07-29.md`.

Không phải mã sản phẩm, không nằm trên đường đóng gói: Nuitka chỉ gói
`--include-package=app` (`build_production.ps1`), nên thư mục `tools/` không lọt
vào installer. Không import bất cứ thứ gì từ đây vào `backend/app` hay `desktop/`.

## Vì sao có bộ này

Kết luận GO/NO-GO cho một vectorizer chỉ có giá trị khi đo được. Ảnh chụp áo do
khách gửi thường **không kèm file vector gốc**, nên không có ground truth — và
nếu chỉ đo "SVG render lại giống ảnh đầu vào đến đâu" thì chỉ số vẫn cao trong khi
engine đã làm sai nét chữ. Bộ này đi ngược chiều để có ground truth chính xác:

```
SVG gốc do script vẽ (biết chính xác)
  → raster sạch                          ← GROUND TRUTH
  → warp phối cảnh (ma trận biết trước)
  → trường sáng không đều
  → texture vải / nhăn nhẹ
  → nhòe + giảm phân giải + JPEG
  → ảnh đầu vào của corpus
```

## Thành phần

| File | Vai trò |
|---|---|
| `corpus_spec.py` | lược đồ metadata một ca kiểm thử + validate + tóm tắt |
| `svg_raster.py` | render SVG (tập con an toàn) → PNG, không thêm dependency |
| `metrics.py` | boundary F-score, IoU, ΔE00, SSIM, đếm path/node, sai số bốn góc |
| `make_synthetic_corpus.py` | sinh corpus synthetic + kiểm chứng + in mốc tham chiếu |

Cả `svg_raster.py` và `metrics.py` đều có `--self-test` **bắt buộc chạy trước khi
tin bất kỳ số đo nào**. Hai bộ self-test này đã bắt được ba lỗi thật trong chính
công cụ (xem mục "Bài học" cuối file).

## Cách chạy

Dùng Python trong venv của backend (đã có sẵn opencv, Pillow, scikit-image,
reportlab, pypdfium2, fontTools — **không cài thêm gì**):

```powershell
$repo = (Resolve-Path ".").Path
$py = Join-Path $repo "backend\venv\Scripts\python.exe"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

# 0) Bắt buộc: kiểm chính công cụ đo và hai adapter trước
& $py tools\logo_rebuild_spike\svg_raster.py --self-test      # 17 mục
& $py tools\logo_rebuild_spike\metrics.py --self-test         # 18 mục
& $py tools\logo_rebuild_spike\engines.py --self-test         # 19 mục

# 1) Sinh corpus synthetic (cùng seed ⇒ cùng byte đầu ra)
& $py tools\logo_rebuild_spike\make_synthetic_corpus.py

# 2) Kiểm corpus tự nhất quán + in mốc tham chiếu cho G1
& $py tools\logo_rebuild_spike\make_synthetic_corpus.py --verify

# 3) Kiểm một file metadata bất kỳ
& $py tools\logo_rebuild_spike\corpus_spec.py <đường_dẫn>\corpus.json

# 4) Benchmark. Có thể đặt VTRACER_CLI hoặc truyền --cli <đường_dẫn>.
& $py tools\logo_rebuild_spike\run_bench.py --stage 1
& $py tools\logo_rebuild_spike\run_bench.py --stage 2
& $py tools\logo_rebuild_spike\run_bench.py --stage 4  # A/B palette oracle
```

Mỗi lượt benchmark ghi `bench/provenance.json` và gắn `cache_id` vào JSONL. Cache cũ sẽ tự bị bỏ qua khi corpus, metric, mã adapter, phiên bản wheel hoặc binary CLI thay đổi.

Console PowerShell mặc định không phải UTF-8 nên tiếng Việt hiện thành ký tự lạ.
Đặt trước khi chạy:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $env:PYTHONIOENCODING="utf-8"
```

## Build và kiểm probe Rust/PyO3

Probe dùng đúng Python trong venv. Phải đặt cả `PYO3_PYTHON` và `VIRTUAL_ENV`; nếu thiếu,
`cargo check`/`maturin develop` có thể không tìm thấy CPython dù venv vẫn tồn tại.

```powershell
$env:PYO3_PYTHON = $py
$env:VIRTUAL_ENV = Join-Path $repo "backend\venv"
cargo check --manifest-path tools\logo_rebuild_spike\rust_probe\Cargo.toml
& (Join-Path $env:VIRTUAL_ENV "Scripts\maturin.exe") develop `
  --manifest-path tools\logo_rebuild_spike\rust_probe\Cargo.toml
& $py tools\logo_rebuild_spike\rust_probe\smoke.py
```

Smoke test xác nhận import module, trace RGBA, ba pha tiến độ và hủy thật. Chỉ
`vtracer::Error::Cancelled` được tính là hủy; lỗi pipeline khác phải nổi thành lỗi Python.
Thư mục `rust_probe/target/` là artifact tái sinh được và đã nằm trong `.gitignore`.

## Corpus đang có

Ảnh **không commit vào git**. Đích mặc định
`private_test_corpus\logo_rebuild\synthetic\` nằm trong `.gitignore`, đúng chính
sách "Never commit customer artwork or generated corpus reports". Corpus tái sinh
được bất cứ lúc nào từ script, nên không cần lưu ảnh.

### Nhánh synthetic — 42 ca, 39 ca có ground truth chính xác

| Nhóm | Ca | pass | review | reject |
|---|---:|---:|---:|---:|
| `flat_1_4` | 10 | 9 | 1 | 0 |
| `flat_5_12` | 9 | 8 | 1 | 0 |
| `text` | 10 | 8 | 2 | 0 |
| `bw` | 5 | 5 | 0 | 0 |
| `line_art` | 5 | 4 | 1 | 0 |
| `photo_gradient` | 1 | 0 | 0 | 1 |
| `embroidery` | 1 | 0 | 0 | 1 |
| `occluded` | 1 | 0 | 0 | 1 |

Chữ dùng **outline thật của font hệ thống** qua fontTools, chuỗi tiếng Việt có
dấu (`HỘP GIẤY ĐỨC THẮNG`, `CÔNG TY TNHH IN ẤN PHƯƠNG NAM`, `PRYNX Đặc Biệt`) để
kiểm dấu mũ/dấu thanh không bị despeckle ăn mất. Không vẽ chữ bằng hình khối và
không dùng font đoán — ground truth phải là đúng outline.

Corpus được khóa split: `train=29`, `holdout=10`, `reject=3`. Chỉ `train` được dùng chọn preset; `holdout` có năm hình học độc lập và chỉ xuất hiện ở báo cáo đánh giá.

Ba ca `reject` tính vào cột **"phát hiện đúng"**, không tính vào cột "đạt". Trộn
hai loại đó là cách nhanh nhất để tự lừa mình bằng một tỷ lệ đạt đẹp.

### Nhánh ảnh thật — 16 file tại `test\logo test`

Dùng làm **bộ smoke test**, không phải corpus chính thức. Lý do, đo thật:

* độ phân giải thấp — 14/16 file dưới 1,5 MP, nhỏ nhất 512×280; vùng logo hữu
  dụng còn khoảng 150–300 px;
* không có ground truth — không file nào kèm vector gốc, không biết kích thước in;
* quyền sử dụng không rõ — tên file chỉ ra nguồn Shutterstock preview, Taobao,
  Amazon, thumbnail YouTube, Google Images ⇒ `rights: "unknown"`, không được đếm
  vào tỷ lệ đạt và không được đưa ảnh so sánh vào tài liệu phát hành;
* thiếu ba nhánh kỹ thuật cần kiểm: không file nào có EXIF orientation, chỉ 1 file
  có ICC profile, không file nào có alpha.

Cần bổ sung: 3–4 ảnh khách **kèm file vector gốc** (AI/CDR/PDF) để có ground
truth thật, và vài ảnh có EXIF xoay + ICC lạ.

## Mốc tham chiếu cho G1 — cách đọc

`--verify` dựng lại phối cảnh bằng đúng bốn góc đã lưu rồi so với ground truth.
Bảng kết quả (trung bình theo hồ sơ suy giảm, bF = boundary F-score):

| Hồ sơ | Ca | bF | SSIM | ΔE50 |
|---|---:|---:|---:|---:|
| `alpha` | 1 | 1.000 | 1.000 | 0.00 |
| `clean` | 9 | 1.000 | 0.997 | 0.09 |
| `persp_mild` | 4 | 0.796 | 0.993 | 0.10 |
| `wrinkle_light` | 3 | 0.695 | 0.976 | 1.30 |
| `persp_strong` | 1 | 0.667 | 0.994 | 0.20 |
| `lowres_jpeg` | 3 | 0.676 | 0.958 | 0.89 |
| `fabric_light` | 4 | 0.651 | 0.985 | 0.46 |
| `fabric_uneven` | 4 | 0.704 | 0.979 | 1.22 |

Hai cách đọc khác nhau, đừng gộp:

* **`clean` là trần thật.** Ảnh không suy giảm, chỉ qua một phép warp đồng nhất.
  Engine tụt dưới 1.000 ở nhóm này là lỗi engine, không có lý do biện hộ.
* **Các hồ sơ còn lại là mốc ngưỡng thô**, tức kết quả phân ngưỡng thẳng ảnh đã
  dựng lại mà không lọc gì. Hạt vải và nhiễu JPEG bị tính là mực nên mốc bị kéo
  xuống — đó là lý do `fabric_light` (0.651) lại thấp hơn `fabric_uneven` (0.704).
  Một engine có despeckle **nên vượt** mốc này; tụt sâu dưới mốc nghĩa là engine
  còn kém hơn phép phân ngưỡng đơn giản.

**SSIM bão hòa trên logo phẳng** — kể cả ca suy giảm mạnh vẫn 0,96–0,99 trong khi
bF tụt xuống 0,47. Vì vậy ở G1 lấy **boundary F-score làm chỉ số quyết định**,
SSIM chỉ để tham khảo. Đây chính là lớp lỗi "điểm tổng đẹp nhưng chữ sai" mà mục
11 báo cáo khảo sát cảnh báo.

## Quy ước metadata

Mỗi ca (`corpus_spec.CorpusCase`) bắt buộc khai `rights`, `logo_type`,
`expectation`. Hai ràng buộc được validate cứng:

* `expectation != "pass"` ⇒ **phải** có `expectation_reason`. Không có lý do thì
  không kiểm chứng được engine từ chối vì đúng nguyên nhân hay từ chối tình cờ.
* có `ground_truth_svg` ⇒ **phải** có `ground_truth_png` kèm theo, vì boundary
  F-score đo trên artifact render thật, không đo trên JSON trung gian.

Chỉ `rights` thuộc `{synthetic, owned, licensed}` được tính vào corpus chính thức.

## Giới hạn phải nói rõ

* `svg_raster.py` chứng minh hình học của **tập con SVG mà PrynX tự sinh**, không
  chứng minh "mở được trong browser/Inkscape" — việc đó vẫn phải kiểm tay.
* Parser cố tình **từ chối** `script`, `foreignObject`, `image`, `use`, `style`,
  URL ngoài, DOCTYPE/ENTITY và thuộc tính `transform`. Gặp lệnh cung tròn `A/a`
  thì báo lỗi thay vì bỏ qua, vì VTracer không sinh lệnh đó — gặp nghĩa là nguồn
  SVG khác kỳ vọng.
* Renderer **clip theo viewBox**. Preflight "path ngoài canvas" sau này phải kiểm
  trên toạ độ, không kiểm trên ảnh đã render.
* Nhăn mạnh (biến dạng phi tuyến biên độ lớn) không có trong corpus: hồ sơ
  `wrinkle_light` chỉ 3 px biên độ. Nhăn mạnh thuộc R&D sau v1.
* Mốc đo chạy trên máy 31,8 GB RAM / i5-13400. Theo thống nhất với chủ dự án, lấy
  **16 GB làm mốc cấu hình tối thiểu**; không đo hồ sơ dưới 8 GB.

## Bài học từ chính công cụ này

Ba lỗi do self-test/verify bắt được, ghi lại để không lặp:

1. **`SVGPathPen` lược bỏ chữ lệnh khi lặp** (`L 1 2 3 4` thay vì `L 1 2 L 3 4`).
   Mọi bộ parse chuỗi `d` tự viết sẽ vỡ ở đó. Cách đúng: áp biến đổi ở tầng pen
   bằng `TransformPen`, không parse lại chuỗi.
2. **Renderer clip theo viewBox.** Một ô vuông tràn khung bị cắt làm sai diện tích
   kỳ vọng trong test, dẫn tới kết luận sai là "chỉ số hỏng".
3. **Không được suy màu nền bằng "bin lượng tử lớn nhất".** Nhiễu/resample tách
   một vùng màu thành nhiều bin, khiến vùng hình thắng vùng nền và **mặt nạ bị
   đảo** — mốc boundary F nhảy 0,42↔1,00 giữa các ca đáng ra tương đương. Cách
   đúng: lấy median viền ngoài, và truyền **cùng một** màu nền tham chiếu cho cả
   hai mặt nạ đang so nhau.
