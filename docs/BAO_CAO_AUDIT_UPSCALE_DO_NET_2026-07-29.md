# Báo cáo audit — Upscale: chọn "Chất lượng" nhưng ảnh không sắc nét

Ngày: 2026-07-29
Phạm vi: `backend/app/workers/realesrgan_engine.py`, route `/pdf-tools/upscale` trong `backend/app/api/routes/pdf_tools.py`, `backend/scripts/convert_realesrgan_onnx.py`, `desktop/src/components/preprocess-tools/UpscaleTool.tsx` + `imageBatch/ImageBatchPreview.tsx`, `build_production.ps1`.
Trạng thái: **chờ duyệt. Chưa sửa dòng code nào.**
Tiền đề: đây là đợt thứ ba. `BAO_CAO_AUDIT_UPSCALE_2026-07-28.md` (UP-01…UP-11) và `BAO_CAO_AUDIT_UPSCALE_TREO_2026-07-28.md` (§1, §2) đã chạy; `UPSCALE_FIXES_2026-07-28.md` ghi lô A/B đã làm. Báo cáo này chỉ đo lại đúng triệu chứng bạn báo và xác minh trạng thái thực của các fix trước.

---

## 1. Kết luận điều hành

Triệu chứng của bạn có thật và đo được: **chế độ "Chất lượng" cho ảnh MỀM HƠN chế độ "Nhanh"**, đều đặn trên cả ảnh line-art và ảnh chụp, ở mọi kích thước tôi thử. Nó không nét kém vì lỗi pipeline — pipeline chạy đúng — mà vì ba nguyên nhân cộng lại:

1. **Model chọn sai vai.** `RealESRGAN_x4plus` (bản 2021) được huấn luyện với suy biến tổng hợp nặng nên xu hướng làm mượt; `realesr-general-x4v3` (bản 2022) mới hơn và làm cứng mép mạnh hơn. Gán bản cũ làm "Chất lượng" là ngược thực tế đo được.
2. **Chế độ "Chất lượng" không có bước bù chi tiết nào**, trong khi "Cân bằng" có (dù bước đó gần như vô tác dụng, xem §NET.03). Nên tùy chọn cao cấp nhất lại là tùy chọn ít được xử lý nhất.
3. **Model "Nhanh/Cân bằng" đang được đóng gói ở mức khử nhiễu TỐI ĐA** — mạnh hơn cả mặc định của upstream — và không có tham số nào để tiết chế. Đây là gốc của cảm giác "bệt", và cũng là lý do nó trông "nét" theo kiểu cứng mép chứ không phải nét theo kiểu có chi tiết.

Ngoài ra có một phát hiện P0 độc lập: **`_guard_runtime` — chốt an toàn của lô A đợt trước — là code chết, chưa bao giờ được gọi.** Nên hai fix §1.1 và §1.2 của đợt trước trên thực tế không có hiệu lực.

---

## 2. Cách đo

Script đo nằm ở `tmp/audit_upscale_sharpness.py`, `tmp/audit_upscale_view.py`, `tmp/audit_upscale_fix_probe.py` (chỉ đọc engine, không sửa). Máy đo có DirectML hoạt động (`['DmlExecutionProvider', 'CPUExecutionProvider']`), nên chế độ Chất lượng chạy được và cho ra ảnh thật.

Hai bài:

- **Phục hồi có chuẩn:** ảnh gốc = chuẩn → thu nhỏ ¼ bằng LANCZOS → phục hồi ×4 → so với chuẩn bằng PSNR/SSIM.
- **Ca thật:** ảnh nhỏ như khách gửi (400 px cạnh dài) → phóng ×4 → đo độ nét tuyệt đối, không có chuẩn.

Chỉ số:

- `sharp` = phương sai Laplacian → **độ nét cảm nhận** (mắt người đọc chỉ số này).
- `HF%` = tỉ lệ năng lượng phổ ở dải tần > ½ Nyquist → **lượng chi tiết thật**.
- Hai chỉ số này tách nhau ra là điểm mấu chốt của báo cáo, xem §NET.01.

Ảnh dùng: `desktop/public/images/dieline/auto_bottom.png` (line-art), `private_test_corpus/incoming/ChatGPT Image 18_32_56 14 thg 7, 2026.png` (ảnh dày chi tiết). Sai số lặp lại ~±1% (DirectML không bit-exact giữa các lần chạy).

---

## 3. Phát hiện

### §NET.01 — [P1] Chế độ "Chất lượng" nét kém hơn "Nhanh", đều đặn 11–14%

Bài phục hồi có chuẩn (`tmp/audit_upscale_sharpness.py`):

| ảnh | chế độ | PSNR | SSIM | **sharp** | HF% |
|---|---|---:|---:|---:|---:|
| line-art 508×264 | Lanczos | 22,40 | 0,8280 | 11,2 | 4,82 |
| | general (Nhanh) | 23,93 | 0,9108 | **793,6** | 27,39 |
| | balanced (Cân bằng) | 23,80 | 0,9089 | **797,8** | 27,12 |
| | quality (Chất lượng) | **25,63** | **0,9324** | **681,5** | **31,03** |
| | *chuẩn* | — | — | *2304* | *46,36* |
| ảnh chụp 512×288 | Lanczos | 17,12 | 0,6204 | 118,2 | 7,64 |
| | general | **17,60** | **0,6617** | **1916,6** | 24,77 |
| | balanced | 17,57 | 0,6626 | 1968,0 | 24,80 |
| | quality | 17,44 | 0,6392 | **1705,2** | **26,47** |
| | *chuẩn* | — | — | *6062* | *39,61* |

Ca thật (ảnh nguồn 400 px → ra 1600 px, không có chuẩn):

| ảnh | general | balanced | quality |
|---|---:|---:|---:|
| line-art | 353,4 | 363,9 | **297,0** |
| ảnh chụp | 1112,6 | 1136,7 | **996,8** |

Đọc bảng: `quality` **luôn** thấp hơn `general` ở cột `sharp` (−11% đến −14%) nhưng **luôn** cao hơn ở cột `HF%` (+7% đến +13%). Nghĩa là RRDBNet thật sự tái tạo nhiều chi tiết tần số cao hơn, nhưng với tương phản cục bộ thấp hơn — mắt đọc ra "mềm". Trên line-art nó còn thắng rõ về fidelity (+1,7 dB PSNR). Trên ảnh chụp thì thua cả PSNR lẫn SSIM.

Nguyên nhân bổ trợ, `realesrgan_engine.py:382-410`:

```python
preserve_texture = variant == "balanced"
...
if preserve_texture:
    result = _restore_source_texture(result, src)
```

`quality` không đi qua bất kỳ bước bù chi tiết nào. Tùy chọn đắt nhất (16–21× thời gian) là tùy chọn được hậu xử lý ít nhất.

**Khuyến nghị:** không nên "sửa" bằng cách đổi nhãn. Hướng có số đo hậu thuẫn là cho `quality` một bước khuếch đại chi tiết (§NET.03) — khi đó nó thắng `general` ở cả hai cột. Effort: S (nếu dùng kết quả §NET.03).

### §NET.02 — [P1] Model "Nhanh/Cân bằng" được đóng gói ở mức khử nhiễu tối đa, và tài liệu ghi ngược

`backend/scripts/convert_realesrgan_onnx.py:157,184-187`:

```python
state = _dni_blend(_extract_state(x4v3_path), _extract_state(wdn_path), alpha)
...
"--alpha", default=1.0,
help="DNI cho model Nhanh: 1 giữ chi tiết, 0 khử nhiễu mạnh",
```

`_dni_blend(a, b, alpha) = a*alpha + b*(1-alpha)`, với `a = realesr-general-x4v3`, `b = realesr-general-wdn-x4v3`. Công thức này trùng đúng upstream ([inference_realesrgan.py](https://github.com/xinntao/Real-ESRGAN/blob/master/inference_realesrgan.py): `model_path = [x4v3, wdn]`, `dni_weight = [denoise_strength, 1 - denoise_strength]`), nên `alpha` ≡ `denoise_strength` của upstream.

Upstream mô tả tham số này là 0 = khử nhiễu yếu (giữ nhiễu), 1 = khử nhiễu mạnh, **mặc định 0,5** (nội dung diễn giải lại từ tài liệu Real-ESRGAN để phù hợp giấy phép nội dung).

Suy ra:

- `default=1.0` → trọng số dồn hết vào `x4v3` → **khử nhiễu mạnh nhất có thể**, mạnh hơn mặc định 0,5 của upstream.
- Dòng `help` ghi "1 giữ chi tiết, 0 khử nhiễu mạnh" là **ngược hoàn toàn**.
- `build_production.ps1:516` gọi `convert_realesrgan_onnx.py --out ... --model all` không truyền `--alpha`, nên bản phát hành ăn đúng mặc định 1,0.
- `~/.u2net/realesr-general-wdn-x4v3.pth` đã có sẵn trên máy build nhưng **không được đóng gói dạng .onnx**, nên runtime không có cách nào tiết chế.

Đây là nguyên nhân trực tiếp của "bệt / mất hạt" mà đợt audit trước ghi ở §2.3 và tới nay vẫn còn.

**Khuyến nghị:** sửa `help` cho đúng nghĩa; đổi mặc định về 0,5 hoặc convert cả hai mức rồi cho người dùng một thanh trượt khử nhiễu. Cần benchmark lại vì đổi trọng số là đổi SHA-256 đã khóa ở `realesrgan_engine.py:MODEL_SHA256`, `build_production.ps1` và `THIRD_PARTY_NOTICES.md`. Effort: M (cần máy có torch).

### §NET.03 — [P1] `_restore_source_texture` gần như vô tác dụng; hướng đúng là khuếch đại phần AI thêm vào

`realesrgan_engine.py:362-374`:

```python
source_rgb = source.convert("RGB").resize(result.size, Image.Resampling.LANCZOS)
low_frequency = source_rgb.filter(ImageFilter.GaussianBlur(radius=1.2))
high_frequency = ImageChops.subtract(source_rgb, low_frequency, offset=128)
```

Bán kính 1,2 px được áp ở **độ phân giải ĐẦU RA**. Ở ×4, 1,2 px đầu ra ứng với 0,3 px nguồn — dưới Nyquist của ảnh nguồn. Cái được trích ra gần như toàn bộ là gợn LANCZOS, không phải chi tiết nguồn. Số đo khớp: `balanced` chỉ hơn `general` **+0,5%** (793,6 → 797,8) trên line-art và **+2,7%** (1916,6 → 1968,0) trên ảnh chụp, `HF%` không tăng (27,39 → 27,12 và 24,77 → 24,80).

Tôi đã thử giả thuyết hiển nhiên nhất — nâng bán kính theo thang ×4 — và **nó không phải câu trả lời**:

| biến thể | PSNR | SSIM | sharp | HF% |
|---|---:|---:|---:|---:|
| general + unsharp r=1,2 s=0,35 *(hiện tại)* | 23,80 | 0,9089 | 797,8 | 27,12 |
| general + unsharp r=2,0 s=0,35 | 23,66 | 0,9059 | 802,6 | 26,83 |
| general + unsharp r=4,0 s=0,35 | 23,31 | 0,9013 | 807,0 | 26,27 |
| general + unsharp r=4,0 s=0,60 | 22,83 | 0,8936 | 814,4 | 25,56 |

Nâng bán kính đánh đổi 1 dB PSNR để lấy 2% độ nét, `HF%` còn **giảm**. Không đáng.

Hướng đo được là khuếch đại **phần AI thực sự thêm vào** so với Lanczos, tức `out + k·(out − lanczos(src))`. Bảng dưới là một lần chạy riêng (`tmp/audit_upscale_fix_probe.py`) nên baseline lệch ~±1% so với bảng §NET.01:

| biến thể | PSNR | SSIM | sharp | HF% |
|---|---:|---:|---:|---:|
| **line-art** | | | | |
| general | 23,93 | 0,9108 | 789,6 | 27,12 |
| quality | 25,63 | 0,9324 | 679,0 | 30,68 |
| **quality + 0,3× residual AI** | **25,19** | **0,9293** | **1073,3** | **34,26** |
| quality + 0,6× residual AI | 24,39 | 0,9215 | 1469,9 | 36,45 |
| *chuẩn* | — | — | *2272* | *46,10* |
| **ảnh chụp** | | | | |
| general | 17,60 | 0,6617 | 1819,8 | 25,28 |
| quality | 17,44 | 0,6392 | 1494,6 | 26,35 |
| **quality + 0,3× residual AI** | 16,77 | 0,6035 | **2234,3** | **29,71** |

Trên line-art, `quality + 0,3×` là một thắng lợi rõ: độ nét **+58%** so với `quality`, **+36%** so với `general`, `HF%` cao nhất trong nhóm, mà chỉ mất 0,44 dB PSNR và 0,003 SSIM. Trên ảnh chụp mức đánh đổi fidelity nặng hơn (−0,67 dB, −0,036 SSIM), nên `k` không nên cố định — cần là tham số, mặc định thấp (~0,25–0,30).

Khác biệt với bước hiện tại: hiện tại khuếch đại gợn resample của **ảnh nguồn**; hướng này khuếch đại chi tiết mà **model** đã suy ra.

**Khuyến nghị:** thay `_restore_source_texture` bằng khuếch đại residual AI có tham số, áp cho cả ba chế độ, mặc định gate theo loại nội dung hoặc để người dùng chọn. Cần corpus thật trước khi chốt `k` mặc định. Effort: S cho engine, M nếu thêm điều khiển UI.

### §NET.04 — [P0] `_guard_runtime` là code chết: chốt an toàn của lô A đợt trước không hoạt động

`realesrgan_engine.py:158-184` định nghĩa `_guard_runtime`. Tìm toàn bộ `backend/` (trừ `venv`): **không có chỗ nào gọi nó.** `estimate_seconds` (dòng 140) cũng chỉ được `_guard_runtime` gọi, nên cũng chết theo.

Hệ quả cụ thể:

- Phép kiểm GPU dựa trên **đo thời gian** — chính là fix cho §1.1 của báo cáo trước — không chạy. Cái còn chạy là phép kiểm cũ theo **tên provider** ở `_run_session` (dòng 271-283), mà báo cáo trước đã chứng minh không bao giờ bắn vì `get_providers()` trả về provider đã đăng ký chứ không phải provider thực thi. **Nghĩa là §1.1 vẫn nguyên vẹn:** máy không có tăng tốc GPU thật vẫn nhận job Chất lượng và chạy hàng chục phút.
- `_MAX_JOB_SECONDS = 300.0` và biến môi trường `PRYNX_UPSCALE_MAX_SECONDS` không có tác dụng.

Đi kèm là một lỗi hợp đồng: docstring `UpscaleUnavailable` (dòng 66-71) ghi *"Route dịch thành HTTP 422 kèm nguyên văn `str(exc)`"*. Route `pdf_tools.py:1863-1872` chỉ có `except HTTPException` rồi `except Exception` → 500 với thông điệp chung `"Phóng to ảnh thất bại (UpscaleUnavailable)"`. Toàn bộ thông điệp tiếng Việt đã soạn kỹ trong `_guard_runtime` không bao giờ đến được người dùng.

**Khuyến nghị:** gọi `_guard_runtime` trong `upscale()` (hoặc trong `_process_upscale` sau `_validate_upscale_memory`), và thêm `except UpscaleUnavailable → 422` ở route. Đây là fix nhỏ, độc lập với phần chất lượng ảnh. Effort: S.

### §NET.05 — [P2] Hai mục còn lại của lô A đợt trước cũng chưa làm

- **§1.2 (ước lượng thời gian, tiến độ theo ô):** `estimate_seconds` không được gọi; `UpscaleTool.tsx` chỉ có chuỗi `Đang phóng to i / n`, không có phần trăm theo ô, không có dự báo trước khi chạy. Nút hủy thì đã có (`cancelBatch`, dòng 105-107) — mục này đã làm.
- **§1.3 (timeout cho slot heavy):** `heavy_job_scheduler.py:45` vẫn là `_HEAVY_JOB_SLOTS.acquire()` không timeout. Một job Chất lượng dài vẫn giữ slot chung với bình bản, và request upscale vẫn có thể chờ vô hạn nếu slot bị chiếm.

Ghi ở đây để trạng thái lô A được báo trung thực; không phải phát hiện mới.

### §NET.06 — [P2] Preview không có chế độ xem 1:1, nên bạn không thể thấy độ nét thật

`ImageBatchPreview.tsx:143` và `:176-193`: khi đã có kết quả, **cả ảnh gốc và ảnh 4× dùng cùng một class** `"absolute inset-0 w-full h-full object-contain"` trong cùng một khung. Nghĩa là ảnh 4× bị WebView thu về đúng kích thước khung để so sánh cạnh nhau.

Với khung preview điển hình ~1100 px và ảnh khách 1500 px:

| | kích thước thật | tỉ lệ hiển thị ở "zoom 100%" |
|---|---:|---:|
| ảnh gốc 1500 px | 1500 px | ~0,73× |
| kết quả ×4 | 6000 px | **~0,18×** |

Ở tỉ lệ 0,18×, gần như toàn bộ chi tiết AI bị bước thu của trình duyệt xóa đi — hai bên thanh trượt trông na ná nhau. Zoom lại là `transform: scale()` (dòng 141) nội suy mượt trên phần tử **đã bị thu**, nên zoom vào chỉ làm mờ thêm chứ không lấy lại pixel thật. Chỉ số `%` ở dòng 235 là hệ số CSS, không phải tỉ lệ pixel ảnh — ở ví dụ trên, "100%" thực tế là 18%.

Điều này không làm ảnh xuất ra kém đi, nhưng nó làm **mọi đánh giá bằng mắt trên preview đều không đáng tin** — kể cả đánh giá của bạn dẫn tới báo cáo này, và cả tiêu chí "không có seam ở crop 100–400%" mà báo cáo UP-05 đặt ra.

**Khuyến nghị:** thêm nút "1:1" đặt zoom sao cho 1 pixel ảnh kết quả = 1 pixel màn hình, đổi chỉ số % sang tỉ lệ pixel thật, và đặt `image-rendering: pixelated` khi tỉ lệ > 1. Effort: S. **Nên làm trước hoặc cùng lúc với các fix chất lượng** — không có nó thì không xác nhận được fix có tác dụng.

### §NET.07 — [P3] Text UI mô tả không khớp số đo

`desktop/src/i18n/locales/vi.json:2992-2994`:

- `"model_can_bang_goi_y": "Nhanh gần như chế độ Nhanh nhưng giữ hạt và texture nguồn tốt hơn."` — đo được +1…2% độ nét, `HF%` không tăng (§NET.03). Câu này hứa quá.
- `"model_chat_luong_goi_y": "Chi tiết tốt hơn; ..."` — đúng theo `HF%`, sai theo độ nét cảm nhận. Đây chính là chỗ làm bạn thấy "chưa ổn": nhãn nói chi tiết tốt hơn, mắt thấy mềm hơn.
- `en.json:2990` còn ghi Balanced là `(recommended)`, trong khi nó gần như trùng Fast.

Effort: S. Nhưng chỉ nên sửa text **sau** khi chốt hành vi, không sửa trước.

---

## 4. Phát hiện thêm (ngoài phạm vi, chưa đo)

- `_upscale_rgb` không có `pre_pad` như `RealESRGANer` của upstream. Biên ảnh chạy conv với đệm 0 → có thể có viền khác biệt vài pixel. Chưa đo, mức P3.
- `MODELS` chỉ có hai biến thể. Upstream còn `RealESRGAN_x4plus_anime_6B` (line-art/minh họa) và `RealESRGAN_x2plus` (×2 thật, thay cho ×4 rồi thu). `tmp/upscale-ncnn-anime6b-2048.png` cho thấy đã từng có người thử. Đây là mục UP-02 lô B, vẫn mở.
- Corpus QA chất lượng (mục UP-05 / lô C) vẫn chưa có. Toàn bộ số trong báo cáo này chạy trên **2 ảnh**, một line-art và một ảnh tổng hợp dày chi tiết. Không đại diện cho chữ Việt nhỏ, tram in, JPEG khách gửi hay chân dung.

---

## 5. Lộ trình đề xuất

### Lô 1 — Nhìn thấy được sự thật (làm trước, ít rủi ro nhất)

| # | Việc | File | Effort |
|---|---|---|---|
| 1 | §NET.06 — nút 1:1, chỉ số % theo pixel thật, `pixelated` khi >1 | `ImageBatchPreview.tsx` | S |
| 2 | §NET.04 — gọi `_guard_runtime`, map `UpscaleUnavailable` → 422 | `realesrgan_engine.py`, `pdf_tools.py` | S |

2 file backend + 1 file desktop. Không đổi hình học/chất lượng ảnh xuất, nên verify nhẹ. Sau lô này bạn xem lại đúng ảnh cũ ở 1:1 và xác nhận triệu chứng — có thể một phần cảm giác "chưa nét" là do preview.

### Lô 2 — Chữa độ nét (cần bạn gửi ảnh mẫu)

| # | Việc | Effort |
|---|---|---|
| 1 | §NET.03 — thay `_restore_source_texture` bằng khuếch đại residual AI có tham số | S–M |
| 2 | §NET.01 — áp bước trên cho `quality`, benchmark lại thứ tự ba chế độ | S |
| 3 | §NET.07 — viết lại text UI theo hành vi đã chốt | S |

Chốt `k` mặc định cần corpus thật. **Xin bạn gửi 3–5 ảnh khách điển hình** (một ảnh chụp sản phẩm, một logo/chữ nhỏ, một JPEG nén nặng) — tôi sẽ đo trên đúng ảnh của bạn thay vì 2 ảnh nội bộ.

### Lô 3 — Chữa "bệt" tận gốc (cần máy có torch)

§NET.02 — sửa `help` của `--alpha`, convert lại model ở mức khử nhiễu 0,5, hoặc bundle thêm `wdn` để có thanh trượt. Kéo theo cập nhật `MODEL_SHA256`, `build_production.ps1`, `THIRD_PARTY_NOTICES.md`, `test_upscale.py`. Đây là lô nặng nhất và cũng là lô có tiềm năng cải thiện lớn nhất cho ảnh chụp.

### Lô 4 — Việc dài, tách riêng

§NET.05 (ước lượng thời gian + timeout slot heavy), model thứ ba cho line-art, corpus QA. Đề nghị mở spec riêng thay vì nhồi vào đợt này.

---

## 6. Tiêu chí chấp nhận

- Ba chế độ tách biệt đo được: chênh lệch `sharp` giữa hai chế độ liền kề ≥ 10% trên corpus chuẩn, không chỉ 1–2%.
- Chế độ đắt nhất phải nét nhất **và** có `HF%` cao nhất. Không được có ca "chọn cao cấp, ra mềm hơn".
- Preview có chế độ 1:1; chỉ số % phản ánh tỉ lệ pixel thật của ảnh kết quả.
- Cấu hình vượt trần thời gian hoặc thiếu GPU trả **422 kèm thông điệp tiếng Việt cụ thể**, không phải 500 chung.
- Text UI không hứa điều gì chưa đo được.
- Máy ≥16 GB không bị hạ chất lượng hay cap vô điều kiện (nguyên tắc vàng `prynx-performance`).

---

## 7. Giới hạn kiểm chứng

Mức bằng chứng đạt được: **Mức 2** (đo tự động trên engine thật, GPU thật của máy này).

- **Chưa** chạy `run_dev.bat` và thao tác thật trong app — mọi kết luận về preview (§NET.06) là suy ra từ đọc code + tính toán tỉ lệ, chưa xác minh runtime.
- Số đo trên **2 ảnh**, không phải corpus. Kết luận vững chắc chỉ gồm: `quality` mềm hơn `general`, `balanced` ≈ `general`, và khuếch đại residual AI có tác dụng đo được. Ngưỡng `k` cụ thể thì chưa.
- Máy đo có DirectML hoạt động. Nếu máy bạn không có, §NET.04 còn nghiêm trọng hơn con số ở đây.
- Chưa chạy `pytest backend/tests/test_upscale.py` vì chưa sửa gì; sẽ chạy khi bắt đầu lô sửa.

## 8. Nguồn đối chiếu

- Real-ESRGAN — `inference_realesrgan.py`: https://github.com/xinntao/Real-ESRGAN/blob/master/inference_realesrgan.py
- Real-ESRGAN — Model Zoo: https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md
- Real-ESRGAN — Releases (mô tả tham số `-dn`): https://github.com/xinntao/Real-ESRGAN/releases

*Nội dung tham số khử nhiễu được diễn giải lại từ tài liệu gốc để phù hợp giới hạn giấy phép nội dung.*
