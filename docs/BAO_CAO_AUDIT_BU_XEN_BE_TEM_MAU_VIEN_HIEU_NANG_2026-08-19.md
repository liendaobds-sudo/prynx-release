# Báo cáo audit — Bù xén tạo đường cắt bế tem nhãn: màu viền và hiệu năng — 2026-08-19

> Audit unit: `W2-U03-EDGE` (Bù xén tem nhãn từ ảnh raster nền trắng).
>
> File đối chứng: `C:\Users\Khanh Pham\Desktop\tải xuống.jpg`, SHA-256
> `EA6B7C5865A48871C5A015481C975B930916BC4BE94E08EB44312B84F68640E6`.
>
> Trạng thái: **IMPLEMENTED + ARTIFACT**. Đã truy vết UI → PDF trung gian → route
> → approved bridge → StickerEngine → nguồn màu/contour, sửa theo lô A/B và phần
> log trực tiếp của lô D, rồi chạy lại đúng file thật. Chi tiết triển khai/verify:
> `docs/BU_XEN_BE_TEM_MAU_VIEN_HIEU_NANG_FIXES_2026-08-19.md`.

## 1. Tóm tắt điều hành

Hai lỗi người dùng báo đều là lỗi thật và có chung một điểm vào:

1. **Màu bù xén bị nhạt:** nghi vấn lấy nhầm pixel ở rìa tem là đúng. Nhánh
   `approved-AI` làm rơi thông tin nền trắng trước bước lấy màu. Thuật toán vì thế
   chấp nhận lớp JPEG hồng/trắng sát rìa làm nguồn màu. Trên file thật, nguồn hiện
   tại có median `RGB(255,233,233)`; viền mực thật ở sâu khoảng 7 pixel nguồn có
   median `RGB(99,42,41)`, chênh `ΔE76 ≈ 72,03`.
2. **Chờ lâu rồi lỗi 214 MiB:** ảnh 2000×2000 không có DPI được bọc thành PDF
   2000×2000 pt. Engine 300 DPI phóng thành 8333² rồi kẹp về khoảng 5292². Sau
   `np.pad`, `skimage.find_contours()` nhận đúng mảng 5294×5294 và tự ép sang
   `float64`: `5294² × 8 = 213,825 MiB`, khớp chính xác thông báo lỗi.
3. Trước bước OOM, route còn chạy BiRefNet dù file có nền trắng sạch. Diagnostic
   trên đúng file ghi nhận DirectML hết bộ nhớ rồi rơi CPU; tiến trình thử tăng khoảng
   4,62 GB trước khi được dừng để bảo vệ máy. Sau khi đã có Alpha + Bézier từ AI,
   engine vẫn raster và dò contour toàn trang lần hai.

Đây **không phải lỗi PPE màu** của đợt CMNM2026 trước. Luồng hiện tại dùng PDFium để
raster nguồn, BiRefNet để tạo Alpha và scikit-image/OpenCV để dựng contour/bleed.

## 2. Ground truth và đường chạy thật

### 2.1. File và thiết lập

| Thuộc tính | Giá trị xác minh |
|---|---|
| File | `tải xuống.jpg` |
| Dung lượng | 92.271 byte |
| Ảnh | JPEG progressive, RGB, 2000×2000 px |
| DPI | JFIF density unit = 0, tức **không có DPI vật lý thật** |
| Thiết lập | Bế tem nhãn; Theo hình gốc; offset 0 mm; Góc tròn; bù xén 2 mm; Đặc ruột; Bỏ nền trắng; Lấy theo màu viền tem |

Artifact PDF tương đương frontend tại `tmp/audit_tai_xuong_frontend.pdf` có:

- `MediaBox [0, 0, 2000, 2000]`;
- đúng một XObject JPEG `/DCTDecode`, kích thước 2000×2000 px.

### 2.2. Chuỗi kích thước dẫn tới lỗi

1. `desktop/src/lib/imageNormalizer.ts:311-315` dùng fallback 72 DPI khi ảnh không
   có DPI → 2000 px trở thành 2000 pt, tương đương 705,56 mm.
2. `backend/app/api/routes/pdf_tools.py:1604` tạo `StickerEngine(dpi=300)`.
3. Raster lý tưởng: `2000 × 300 / 72 = 8333,33 px` mỗi cạnh.
4. `backend/app/workers/sticker_engine.py:7407-7408, 8174-8198` kẹp tổng xuống
   28.000.000 pixel → `sqrt(28.000.000) = 5291,50`, bitmap thực 5292².
5. `sticker_engine.py:8527` pad một pixel mỗi phía → 5294².
6. `sticker_engine.py:8531` gọi `measure.find_contours`; bản scikit-image đang cài
   thực hiện `image.astype(np.float64)` vô điều kiện.
7. Mảng tạm riêng bước này cần `224.211.488 byte = 213,825 MiB`, chưa tính bitmap,
   RGB/RGBA, label connected-components, các mask và ONNX arena đang sống.

## 3. Phát hiện có bằng chứng

| Mã | Mức | Effort | Phát hiện | Ảnh hưởng |
|---|---|---:|---|---|
| `§STK.EDGE01` | `[VERIFIED]` 🔴 P1 | M | Màu nền bị rơi khỏi hợp đồng `approved-AI`; sampler nhận `background_rgb=None` | Kéo lớp hồng/trắng JPEG ra toàn vùng bù xén, màu nhạt rõ rệt |
| `§STK.EDGE02` | `[VERIFIED]` 🔴 P1 | S–M | Candidate adaptive có thể được nhận dù độ phủ chu vi chỉ 4,204% | Sửa riêng EDGE01 vẫn có thể kéo vài chục điểm màu ra toàn contour |
| `§STK.MEM01` | `[VERIFIED]` 🔴 P1 | M | Ảnh không DPI bị raster 28 Mpx rồi marching-squares full-frame `float64`; contour approved còn bị dựng lại | Chờ lâu, OOM đúng 214 MiB, không tạo được file |
| `§STK.MEM02` | `[VERIFIED]` 🔴 P1 | M–L | Legacy bridge chạy AI trước deterministic background; single-page không có memory reservation và estimator 10 byte/px quá thấp | Peak kép AI + raster; DirectML→CPU chậm và giữ nhiều RAM |
| `§STK.OBS01` | `[VERIFIED]` 🟠 P2 | S | Thiếu timing/RAM theo stage và lỗi OOM nghiệp vụ | Chỉ thấy `Find Contours ... Unable to allocate`, không biết hơn một phút mất ở AI hay contour |

### 3.1. `§STK.EDGE01` — mất màu nền ở nhánh approved-AI

Đường chạy:

- Route bật bridge AI khi `remove_white_bg=true`, không phải rectangle/selection,
  `cut_mode != none` và `shape_mode` là `auto_safe|contour`
  (`pdf_tools.py:1607-1645`).
- Payload approved chỉ mang `alpha`, `dpi`, `source_pixel_mm`, `boundary_source` và
  `path_groups`; không mang màu nền/tolerance.
- Engine đặt `approved_contour_page=True` (`sticker_engine.py:8276-8292`) và bỏ qua
  nhánh dựng `white_bg_mask` (`:8309-8365`), nên `white_bg_mask_built` vẫn `False`.
- Tại `sticker_engine.py:9103-9120`, nền trắng chỉ được gán khi
  `remove_white_bg and white_bg_mask_built`. Vì điều kiện trên sai, lệnh adaptive tại
  `:9121-9141` nhận `background_rgb=None`.

Số đo trực tiếp trên file thật:

| Nguồn | Peel | Số pixel nguồn | Median RGB | Luma median | Gần trắng ≤72 |
|---|---:|---:|---|---:|---:|
| Hành vi hiện tại (`background=None`) | 1 | 1.595 | `[255,233,233]` | 237,6 | 98,75% |
| Viền mực thật khoảng lớp 7 | 7 | — | `[99,42,41]` | — | — |

Metrics shell hiện tại là `transition_ratio=0,01969 < 0,05` và
`luma_span=15,286 < 30`, nên dải hồng nhạt đồng đều bị coi là “ổn định” và được trả
ngay ở `sticker_engine.py:5956-5961`.

Artifact trực quan: `tmp/audit_tai_xuong_edge_sources.png` — bên trái là nguồn màu
hiện tại chạy sát halo; bên phải là counterfactual khi biết nền trắng.

### 3.2. `§STK.EDGE02` — guard độ phủ chỉ có hiệu lực ở một nhánh

Khi truyền lại `background_rgb=(255,255,255)`, helper không còn chọn shell hồng nhưng
candidate thắng chỉ còn 48 pixel, phủ 4,204% chu vi. Trong
`sticker_engine.py:6036-6068`, `background_coverage >= 0,90` chỉ tham gia biến
`background_released`; candidate ít hơn 64 mẫu không bị xem là unstable và vẫn có
thể thắng bằng `score`.

Vì nearest-fill có quyền kéo nguồn đó ra toàn contour, vá EDGE01 đơn lẻ chưa đủ an
toàn. Mọi candidate thay thế phải đạt coverage tối thiểu; nếu không đạt phải giữ
nguồn cũ kèm cảnh báo/fail-loud, không được coi vài điểm màu là đại diện cả chu vi.

### 3.3. `§STK.MEM01` — contour full-frame bị dựng lại dù đã có artifact duyệt

`build_legacy_single_page_approved_contour()` đã trả Alpha và Bézier tại
`sticker_source_pipeline.py:451-579`. Nhưng engine:

- resize Alpha lên đúng bitmap 5292² tại `sticker_engine.py:4072-4118`;
- pad + chạy `find_contours` full-frame tại `:8527-8531`;
- tới `:8885-8901` mới dùng lại fitted path approved để ghi đường cắt.

Như vậy một artifact đã có hình học duyệt vẫn chịu thêm một lượt marching-squares
28 Mpx. Với lưới gốc 2000², riêng buffer `float64` chỉ khoảng 30,55 MiB; hiện tại là
213,825 MiB, lớn hơn gần 7 lần mà không tạo thêm chi tiết ảnh thật.

### 3.4. `§STK.MEM02` — AI chạy trước fast path và không có admission RAM trang đơn

- `sticker_source_pipeline.py:516` gọi thẳng `analyze_sticker_sheet()` trong legacy
  bridge khi raster không có Alpha.
- Cùng module đã có fast path `_background_detection()` (`:650-730`) và luồng
  `auto` khác thử simple background trước AI (`:1265-1289`), nhưng bridge không tái
  dùng nó.
- `pdf_tools.py:1724-1725` gọi
  `run_scheduled_in_threadpool("sticker", _run_sticker_job)` mà không truyền
  `memory_required_mb`, dù scheduler hỗ trợ reservation.
- `_estimate_worker_ram_mb()` tại `sticker_engine.py:7569-7598` dùng khoảng
  10 byte/pixel và chỉ phục vụ planner nhiều trang. Riêng float64 contour đã 8
  byte/pixel, labels 4 byte/pixel; chưa tính RGB/RGBA/mask/bleed/ONNX.

Diagnostic đúng file đã thấy DirectML OOM rồi fallback CPU; process thử tăng khoảng
4,62 GB. Chưa đo cold/warm chính thức vì máy đang chịu áp lực RAM và phép thử đã được
dừng để tránh làm treo ứng dụng. Không quy toàn bộ RAM hệ thống cho BiRefNet trước khi
có lượt đo sạch sau restart.

**Đính chính sau triển khai:** `_background_detection()` hữu ích để lấy màu nền,
nhưng mask nhị phân của nó không đủ chuẩn làm hình học đường bế. Thử nghiệm trên
đúng file đã tạo 11 path/905 cubic và 10 vòng rác, trong khi Alpha AI tạo 1 path/91
cubic. Vì vậy bản cuối không bỏ AI; phần giảm RAM/thời gian đến từ việc giữ contour
ở lưới nguồn 2000². Benchmark process sạch sau đó đo approved AI cold `12,849 s`
với DirectML và `12,322 s` khi ép CPU.

### 3.5. `§STK.OBS01` — log chưa đủ để phân biệt stage

Tag `Find Contours Page 0@8531` xác định được nơi cấp phát cuối cùng, nhưng route chỉ
có tổng `engine_seconds` khi thành công. Chưa có log thống nhất cho:

- inspect nguồn / cache AI hit-miss / provider DML-CPU;
- render phân tích và inference;
- raster page, mask, `find_contours`, bleed fill và compress;
- kích thước bitmap dự kiến/thực tế cùng RAM available trước mỗi stage.

Lỗi cấp phát vì thế đi ra dưới dạng lỗi thư viện, thay vì thông báo tiếng Việt có
kích thước trang, nhu cầu RAM và hướng xử lý.

## 4. Phạm vi ảnh hưởng

### Chắc chắn bị ảnh hưởng

- Bế tem nhãn một trang raster, bật Bỏ nền trắng, cắt theo contour/auto-safe.
- `image` và `trajectory` dùng adaptive sampler nên dính EDGE01/EDGE02.
- `inpaint` dùng cùng nguồn viền nhưng không qua adaptive ở nhánh hiện tại, cũng cần
  oracle riêng.
- Mọi kiểu màu, kể cả `solid`, vẫn có thể dính MEM01 vì OOM xảy ra trước lúc tạo màu
  bleed.

### Không đi đúng chuỗi lỗi này

- Xén vuông góc/rectangle dùng hình học trang và có nhánh vector riêng.
- Selection mode và `cut_mode=none` không chạy legacy AI pre-pass như trên.
- PDF đã có CutContour/vector thật thường bị inspector loại khỏi legacy AI bridge.

Ảnh/tờ raster lớn đi thẳng StickerEngine vẫn có rủi ro marching-squares full-frame,
dù không chịu peak kép AI của ca này.

## 5. Bằng chứng kiểm thử và khoảng trống

### Đã chạy/đã đo

- Định danh đúng file thật và metadata JPEG/DPI.
- Tạo PDF frontend-equivalent, xác nhận `MediaBox 2000×2000 pt` và XObject JPEG
  2000×2000.
- Đo shell màu trực tiếp trên ảnh thật, gồm counterfactual có/không có nền trắng.
- Baseline trước sửa của `backend/tests/test_sticker_edge_color_background.py`:
  **11/11 pass**. Kết quả xanh này không phủ nhánh lỗi vì các test 72 DPI
  tại `:152-219` luôn
  truyền `background_rgb=(255,255,255)`.

### Khoảng trống khiến regression lọt qua

- Test approved override tại `backend/tests/test_sticker_source_pipeline.py:718-783`
  chạy `StickerEngine(dpi=72)` và `bleed_mm=0`, nên không đi vào color source.
- Test route dùng engine giả, không chạm PDFium/scikit/RAM thật.
- Chưa có chuỗi ảnh 2000×2000 không DPI → image normalizer → route thật → engine
  300 DPI.
- Chưa có oracle coverage theo từng cung contour, intentional white border,
  `image/trajectory/inpaint` parity và fail-loud khi nguồn màu an toàn không đủ.
- Chưa có budget peak RSS/largest-array hoặc test admission RAM cho một trang.

Không chạy lại full AI + 28 Mpx trong trạng thái máy hiện tại; điều đó chỉ lặp OOM và
không tạo thêm bằng chứng. Lượt verify sau sửa phải chạy trong process sạch có log
provider, thời gian và peak memory.

## 6. Điều không nên sửa nhầm

- Fallback 72 DPI của image normalizer là hợp đồng cũ, đang có test khóa. Không đổi
  toàn cục sang 300 DPI trong lô này vì sẽ đổi kích thước vật lý mọi ảnh không DPI.
- Không hard-cap chất lượng vô điều kiện cho máy mạnh. Giới hạn hợp lý ở đây là theo
  lưới pixel nguồn hoặc RAM available thật; nguồn 2000 px không có thêm chi tiết khi
  nội suy lên 5292 px.
- Không chỉ “lùi sâu hơn”. Phải mang đúng màu nền và kiểm coverage, nếu không sẽ đổi
  lỗi màu nhạt thành lỗi kéo vài màu cục bộ quanh toàn contour.
- Không dùng ảnh raster lại toàn trang để chữa màu; artwork PDF gốc vẫn phải được giữ
  nguyên, chỉ lớp bleed được sinh thêm.

## 7. Lô sửa đề xuất

| Lô | Tối đa file | Nội dung | Mục tiêu kiểm chứng |
|---|---:|---|---|
| A — Hợp đồng màu | 5 | Mang `background_rgb/tolerance` qua approved artifact; áp coverage ≥90% cho mọi candidate adaptive; cảnh báo khi không đủ nguồn | File thật không còn chọn halo; không ăn viền trắng có chủ đích |
| B — Tách màu/hình học + lưới nguồn | 4 | Deterministic chỉ lấy scalar nền; AI tiếp tục cấp Alpha/path mượt; approved contour giữ lưới nguồn, không marching-squares 5292² lần hai | File thật có 1 path/91 cubic, không 11 path/905 cubic; buffer contour từ ~213,8 xuống ~30,6 MiB; topology/TrimBox không đổi |
| C — Admission RAM | 4 | Sửa estimator theo buffer graph; reservation cho sticker một trang; đọc RAM lại trước raster; fail-loud tiếng Việt nếu vẫn không vừa | Không NumPy 500; máy đang thiếu RAM không bị treo, máy đủ RAM không bị giảm vô cớ |
| D — Quan sát | 2 | Log stage/timing/provider/cache/RAM/kích thước raster và mã lỗi ổn định | Phân biệt rõ AI, contour và bleed; có baseline cold/warm/peak |

Thứ tự khuyến nghị: **A → B → C → D**. A chốt correctness màu; B xử lý nguyên nhân
trực tiếp của file thật; C bảo vệ các ca lớn khác; D khóa bằng chứng vận hành.

## 8. Tiêu chí nghiệm thu sau sửa

1. Đúng file SHA-256 trên hoàn tất và trả PDF hợp lệ, không lỗi 214 MiB.
2. Kích thước/page box đầu ra vẫn tuân hợp đồng hiện tại; không đổi ngầm 2000 pt.
3. Nguồn màu theo từng cung contour có coverage ≥90%; không được kéo candidate chỉ
   48 điểm/4,204% ra toàn chu vi.
4. Với file thật, tỷ lệ nguồn gần trắng giảm rõ ràng từ 98,75%; seam không có vành
   hồng nhạt và màu bleed bám viền mực nhìn thấy.
5. Nền trắng sạch dùng deterministic để lấy màu nền; hình học opaque vẫn dùng AI
   để giữ Alpha chuyển tiếp, topology và đường bế mượt.
6. Không tạo full-frame float64 ở lưới nội suy 5292² khi approved source chỉ 2000².
7. Test gồm `image`, `trajectory`, `inpaint`, viền trắng có chủ đích, nền màu, Alpha,
   no-DPI/72/150/300 DPI và route approved thật.
8. Có số đo cold/warm, provider, peak private/RSS và kích thước mảng lớn nhất trong
   process sạch; không kết luận hiệu năng chỉ từ test unit.

## 9. Chốt triển khai

Người dùng đã duyệt bằng yêu cầu “xử lý đi”. Lô A/B và log stage trực tiếp của lô D
đã triển khai. Một hồi quy trong bản sửa đầu tiên cũng đã được bắt trên đúng file:
mask `simple-bg` nhị phân sinh 11 path/905 cubic và 10 vòng rác. Hợp đồng cuối tách
rõ deterministic chỉ lấy màu nền, AI giữ hình học; PDF cuối còn đúng 1 path/91
cubic. Test cuối đạt **260/260** (123 phạm vi source/màu/cutline/parallel + 137
StickerEngine E2E).

Đúng file đối chứng ở lượt cache-hit hoàn tất trong **3,636 giây** (approved
`1,994 s` + engine `1,077 s`), raster `2000×2000 @ 72 DPI`,
`find_contours=0,0531 s`, peel màu `7`, median bleed `RGB(85,10,6)`, không
warning. Benchmark cold trong process sạch đo approved `12,849 s` với DirectML
và `12,322 s` khi ép CPU; cộng engine khoảng `1,1–1,8 s`, tổng dự kiến `14–15 s`.

Lô C (admission RAM liên-kind) và phần provider/cache timing rộng hơn của lô D vẫn
là backlog kiến trúc; chúng không còn nằm trên đường OOM của file đối chứng sau
khi source-grid approved đã được áp dụng.
