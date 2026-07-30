# NHẬT KÝ SỬA UPSCALE — ĐỘ NÉT — 2026-07-29

Đối chiếu: `docs/BAO_CAO_AUDIT_UPSCALE_DO_NET_2026-07-29.md`.

## Lô 1 — Nhìn thấy được sự thật

**§NET.06 — preview có chế độ 1:1** (`imageBatch/ImageBatchPreview.tsx`, `vi.json`, `en.json`)

- Đo kích thước pixel thật của ảnh kết quả (`onLoad` → `naturalWidth/Height`) và kích thước khung (`ResizeObserver`), quy ra `baseScale` của `object-contain`.
- Chỉ báo `%` khi đã có kết quả nay là **tỉ lệ pixel thật** (`baseScale × zoom`), kèm kích thước px của kết quả. Trước đây là hệ số CSS: ảnh ×4 trong khung ~1100 px hiện "100%" trong khi thực tế đang xem ~18%.
- Thêm nút **1:1** đặt zoom về đúng 1 pixel ảnh trên 1 pixel CSS; sáng màu chàm khi đang ở 1:1.
- `image-rendering: pixelated` khi tỉ lệ ≥ 1 — zoom vào không còn bị WebView nội suy mờ.
- Trần zoom nới theo `baseScale` (`max(10, 2/baseScale)`) để ảnh ×4 lớn vẫn tới được 1:1.
- Khi chưa có kết quả thì giữ nguyên hành vi cũ. Công cụ Tách nền dùng chung component nên cũng được hưởng.

**§NET.04 — chốt thời gian/GPU không còn là code chết** (`realesrgan_engine.py`, `pdf_tools.py`, `UpscaleTool.tsx`)

- `_guard_runtime` → đổi tên thành `guard_runtime` (công khai) và **route gọi thật**, đặt cạnh `_validate_upscale_memory` trong `_process_upscale`. Trước đây không chỗ nào gọi, nên fix §1.1/§1.2 của đợt audit treo trên thực tế vô hiệu.
- Cố tình KHÔNG gọi trong `upscale()`: warmup và smoke test lúc build chạy ảnh 16×16, không được để chốt chặn phát hành.
- Route thêm `except UpscaleUnavailable` → **HTTP 422 kèm nguyên văn** thông điệp. Đúng hợp đồng mà docstring của lớp này vẫn ghi nhưng chưa ai thực hiện.
- Hai `RuntimeError` hướng người dùng trong `_run_session` (thiếu GPU cho chế độ Chất lượng, GPU lỗi) đổi thành `UpscaleUnavailable` để cũng ra 422.
- FE parse `detail` trong JSON lỗi và hiện nguyên văn khi 422, thay vì dán cả `{"detail":...}` vào toast.

## Lô 2 — Chữa độ nét

**§NET.03 — thay bước bù texture vô tác dụng bằng khuếch đại chi tiết AI** (`realesrgan_engine.py`)

- Xóa `_restore_source_texture`. Bước đó lấy tần số cao của ảnh nguồn đã Lanczos, bán kính Gauss 1,2 px tính ở độ phân giải đầu ra — ở ×4 tương đương 0,3 px nguồn, dưới Nyquist, nên khuếch đại gợn resample. Đo được chỉ +0,5…2,7% độ nét, HF% không tăng.
- Thêm `_amplify_ai_detail(sr, patch, strength)` = `sr + strength·(sr − lanczos(nguồn))`, tức khuếch đại đúng phần **model đã suy ra**.
- Chạy **theo từng ô** trong `_upscale_rgb` nên đỉnh RAM không tăng theo kích thước ảnh (bước cũ dựng thêm một ảnh full ×4).

**§NET.01 — ba chế độ thành một thang thật** (`realesrgan_engine.py`)

- `_DETAIL_BY_MODE`: Nhanh 0 · Cân bằng 0,12 · Chất lượng 0,45. Override từng chế độ bằng `PRYNX_UPSCALE_DETAIL_<MODE>` (0 là giá trị hợp lệ, không dùng `_env_float` vì hàm đó coi 0 là không hợp lệ).
- Tách khái niệm `mode` (lựa chọn UI, quyết định cường độ) khỏi `variant` (file .onnx). Cân bằng vẫn dùng chung model với Nhanh nhưng khác cường độ.

**§NET.08 — pad theo model** (`realesrgan_engine.py`) — phát hiện mới trong lúc verify

- §UP-06 đợt trước đo pad trên model **nhẹ** rồi chốt 40 cho cả hai. RRDBNet có receptive field lớn hơn nhiều nên pad 40 vẫn lệch tới 5 mức màu so với chạy nguyên ảnh.
- Đo lại: `general` pad 16 → lệch 4, pad 40 → 0. `quality` pad 16 → 34, pad 40 → 5, **pad 64 → 1**, pad 96 → 1.
- `_TILE_PAD_BY_VARIANT`: general 40, quality 64. Tăng ~17% diện tích ô ở tile 512.

**§NET.07 — text UI khớp số đo** (`vi.json`, `en.json`, `UpscaleTool.tsx`)

- Bỏ "giữ hạt và texture nguồn tốt hơn" (đo được +0,5…2,7%) và "Balanced — preserve texture".
- Chất lượng: nói rõ nét nhất, chậm hơn hẳn, cần GPU, **chi tiết do AI suy đoán — kiểm chữ/logo ở 1:1**.
- Nhãn kết quả gom vào `MODEL_LABELS`, ghi đúng model + có bù chi tiết hay không.
- Chỉ sửa nhóm `preprocess.upscale`. Nhóm `preprocess.bgRemover` cũng chứa các key này do script i18n fill cũ copy sang nhưng UI tách nền không dùng — để nguyên, ghi vào phần còn mở.

## Lô 3 — §NET.02: đã đổi trọng số model, xong

Đã cài `torch==2.6.0+cpu` (206 MB, wheel CPU-only) + `onnx==1.17.0` vào `backend/venv`
để chạy được `convert_realesrgan_onnx.py`. Đây là **dependency của máy build**, không
vào runtime (Nuitka đã có `--nofollow-import-to=torch`); NOTICE khai ở phạm vi
`build/test`. Kéo theo: `sympy` bị hạ 1.14.0 → 1.13.1 theo ràng buộc của torch, và
thêm `fsspec`, `setuptools` — toàn bộ pytest vẫn xanh sau đó.

**Sửa tài liệu.** `--alpha` có dòng `help` ghi **ngược**. Theo upstream, alpha ≡
`denoise_strength`: 0 = khử nhiễu yếu (giữ hạt), 1 = mạnh nhất, mặc định 0,5. Thêm
docstring cho `_dni_blend` nêu rõ nó trùng `dni_weight = [denoise_strength, 1 - denoise_strength]`
với `model_path = [x4v3, wdn]`.

**Kiểm tính tái lập trước khi đổi.** Convert lại đúng `alpha 1.0` trên toolchain này
cho hash **khác** artifact đã khoá (`09abc53…` vs `027319f…`), nhưng chạy suy luận thì
lệch **0,0000 mức màu** — tức khác metadata ONNX, không khác trọng số. Export .onnx
không byte-reproducible giữa các bản torch/onnx. Đã ghi cảnh báo này vào
`build_production.ps1`: vì `.onnx` được commit vào git nên bước convert chỉ chạy khi
file biến mất; nếu nó chạy thật thì hash sẽ lệch và build dừng, khi đó phải đo lại rồi
cập nhật hash ở cả ba chỗ.

**So sánh ba mức DNI** (CPU, để kết quả ổn định):

| bản | ảnh chụp: sharp / HF% / PSNR / SSIM | line-art: sharp / HF% / PSNR / SSIM |
|---|---|---|
| a=1.0 (đang bundle) | 1995,6 / 24,97 / 14,88 / 0,5486 | 818,2 / 29,26 / 23,98 / 0,8585 |
| **a=0.5** (upstream) | **2186,2 / 26,90 / 14,95 / 0,5495** | **828,2 / 30,55 / 24,47 / 0,8544** |
| a=0.0 (giữ hạt) | 2586,1 / 31,13 / 14,71 / 0,5339 | 788,2 / 31,23 / 24,66 / 0,8530 |

`a=0.5` là **cải thiện không phải trả giá**: ảnh chụp nét +9,6%, HF% +7,7%, mà PSNR
và SSIM còn nhúc lên. `a=0.0` cho texture nhiều nhất trên ảnh chụp (+30%) nhưng mất
PSNR/SSIM và **line-art lại kém nét đi** — nên nó chỉ hợp làm một mức tuỳ chọn, không
làm mặc định.

**Đã đổi sang `a=0.5`.** Hash mới `3ae50bb3…a343f`, cập nhật đồng bộ 4 chỗ (đã kiểm
lại bằng grep hash thật của file): `realesrgan_engine.MODEL_SHA256`,
`build_production.ps1` (`$EXPECTED_UPSCALE_SHA256` + `--alpha 0.5`),
`scripts/bundled_components.json`, `THIRD_PARTY_NOTICES.md` (sinh lại,
`--check` đạt). Xác nhận `~/.u2net` không có bản `.onnx` cũ nào che bản bundle.

**Hiệu chỉnh lại thang detail.** Model mới trung thực hơn nhưng bớt cứng mép, nên chế
độ Nhanh trên line-art tụt 10% độ nét (đổi lại PSNR +0,63 dB, HF% +1,0). Đo lưới
`balanced` ∈ {0,12 · 0,14 · 0,15 · 0,16 · 0,18 · 0,22 · 0,28}:

- 0,18 làm khoảng cách Cân bằng→Chất lượng trên ảnh chụp tụt còn **+7,5%** — dưới ngưỡng 10%.
- **0,15** là mốc lớn nhất còn giữ được cả hai khoảng cách ≥10% trên cả hai ảnh.

Chốt `balanced: 0.12 → 0.15`, `quality` giữ 0,45.

## Lô 4 — §NET.04: xác minh runtime đường 422

Máy dev có DirectML nên chốt GPU không tự bắn. Siết `PRYNX_UPSCALE_GPU_TILE_BUDGET_S`
và `PRYNX_UPSCALE_MAX_SECONDS` xuống cực thấp để probe đo thật rồi vượt ngân sách —
mô phỏng đúng ca máy không có tăng tốc GPU. Không mock gì:

| ca | kết quả |
|---|---|
| ngân sách GPU 0,0001s, `engine=quality` | **422** + "Máy này không có tăng tốc GPU dùng được cho chế độ Chất lượng (đo 0.3s cho một ô 256×256…)" |
| ngân sách GPU 0,0001s, `engine=balanced` | 200 — đúng, chốt GPU chỉ áp cho Chất lượng |
| trần thời gian 0,001s, `engine=balanced` | **422** + "cần khoảng 0.0311s (trần hiện tại 0.001s)…" |
| không siết gì, cả `quality` và `balanced` | 200 / 200 |

**Lỗi phát sinh trong lúc xác minh:** thông điệp trần thời gian luôn chia 60 rồi `.0f`,
nên mọi giá trị dưới 30 giây in ra "khoảng **0 phút** (trần hiện tại **0 phút**)". Với
trần mặc định 5 phút thì không gặp, nhưng thông điệp phải xuống thang tử tế. Thêm
`_format_seconds` / `_format_duration` (dưới 90 giây thì hiện giây) + test hồi quy.

## Lô 5 — "Failed to fetch (localhost:8321)" mà chủ dự án gặp

**Chẩn đoán: không phải lỗi tính năng, là hệ quả của việc tôi sửa code khi app đang chạy.**

Bằng chứng đã thu:

| kiểm tra | kết quả |
|---|---|
| cổng 8321 | đang `Listen` trên `127.0.0.1`, tiến trình còn sống, `/docs` trả 200 |
| kết nối lúc gặp lỗi | có nhiều `FinWait2` — dấu hiệu tiến trình bị tháo giữa request, không phải trả lỗi HTTP |
| tiến trình | `python -m uvicorn app.main:app --port 8321 **--reload --reload-dir app**` |
| gọi trực tiếp instance đang chạy, lần 1 | `general` → `ConnectionResetError 10054`; `balanced`/`quality` → 500 "Internal Server Error" **trần** (không phải nhánh 500 có JSON của route) |
| gọi lại lần 2 và 3 | 200 / 200 / 200 cả ba chế độ |
| sidecar **riêng** (venv python, cổng 8322, **không** `--reload`) | **12/12 request đạt** trên cả ba chế độ, 4 vòng |

`--reload-dir app` theo dõi toàn bộ `backend/app/`. Trong đợt này tôi ghi vào
`app/workers/realesrgan_engine.py`, `app/api/routes/pdf_tools.py` **và thay cả file
`app/data/models/realesr-general-x4v3.onnx` 4,7 MB**. Mỗi lần ghi là watcher tháo
worker và dựng lại; request nào đang bay thì bị reset — đúng biểu hiện "Failed to
fetch". Chuỗi 500 trần ngay sau đó là các request rơi vào lúc worker chưa dựng xong.

Không có thay đổi code nào cần thiết cho việc này. **Cách xử lý: khởi động lại
`run_dev.bat`.**

### §NET.09 — [P2] nhưng lộ ra một khuyết điểm thật

Dự án đã có `desktop/src/lib/errorMessages.ts` (`formatError`) viết đúng cho tình
huống này — nó dịch `Failed to fetch` thành *"không kết nối được với bộ xử lý của
PrynX"* kèm hướng dẫn *"Bộ xử lý nền có thể chưa khởi động xong hoặc đã bị tắt. Chờ
vài giây rồi thử lại…"*. Nhưng `UpscaleTool.tsx` **không dùng nó**, chỉ ném
`error.message` thô ra giao diện.

Đây không chỉ là vấn đề của vòng dev: bản đóng gói cũng có cửa sổ cold-start của
sidecar, nên người dùng thật sẽ gặp đúng chuỗi tiếng Anh vô nghĩa này. Đã đổi nhánh
catch của `processBatch` sang `formatError(error, 'Phóng to ảnh thất bại')`.

## Lô 6 — §NET.10: không lộ tên model/kiến trúc ra giao diện

Chủ dự án yêu cầu dropdown chỉ hiện **Nhanh · Cân bằng · Chất lượng**. Rà cả giao
diện thì tên model rò ra 6 chỗ, không chỉ dropdown:

| chỗ | trước | sau |
|---|---|---|
| dropdown `model_chat_luong` (vi/en) | "Chất lượng — RealESRGAN_x4plus" | "Chất lượng" |
| dropdown `model_nhanh` (vi/en) | "Nhanh — Real-ESRGAN x4v3" | "Nhanh" |
| nhãn kết quả trên preview (`MODEL_LABELS`) | "RealESRGAN_x4plus · bù chi tiết" | tên chế độ (`modeLabel()`) |
| `toolRegistry.ts` longDescription | "Real-ESRGAN cải thiện độ nét…" | "Cải thiện độ nét… xử lý hoàn toàn trên máy" |
| `toolHelp.ts` tagline | "…bằng Real-ESRGAN chạy trên máy" | "…bằng AI chạy hoàn toàn trên máy" |
| `catalog:*` (vi/en) | có tên model | bỏ |
| bản sao cũ trong nhóm `preprocess.bgRemover` (en) | có tên model | bỏ |

Nhân đó sửa luôn "100% zoom" → "1:1" trong mô tả cho khớp với nút mới ở §NET.06.

**Tên model VẪN PHẢI Ở LẠI trong `THIRD_PARTY_NOTICES.md`** (3 chỗ) — đó là nghĩa vụ
ghi công của giấy phép BSD-3-Clause, bỏ đi là vi phạm. Đã kiểm còn nguyên. Comment
trong code backend cũng giữ tên model vì không hiện ra người dùng.

Rà lại toàn bộ `desktop/src` với `ESRGAN|RRDBNet|x4v3|x4plus|SRVGG|BiRefNet|ISNet|onnx|DirectML`:
sạch, chỉ còn một comment trong `useUpscaleStore.ts` (đã sửa lại cho khớp hành vi mới).

## Kết quả đo sau khi sửa

`tmp/audit_upscale_verify.py` — phục hồi có chuẩn, tile 256, model general đã là DNI a=0,5:

| ảnh | chế độ | detail | PSNR | SSIM | sharp | HF% |
|---|---|---:|---:|---:|---:|---:|
| line-art 508×264 | Nhanh | 0,00 | 24,56 | 0,9032 | 707,8 | 28,14 |
| | Cân bằng | 0,15 | 24,17 | 0,9005 | **916,8** | 29,86 |
| | Chất lượng | 0,45 | 24,81 | 0,9260 | **1274,5** | **35,50** |
| | *chuẩn* | | | | *2272* | *46,10* |
| ảnh chụp 512×288 | Nhanh | 0,00 | 17,61 | 0,6573 | 1869,6 | 26,21 |
| | Cân bằng | 0,15 | 17,27 | 0,6417 | **2323,2** | 27,93 |
| | Chất lượng | 0,45 | 16,46 | 0,5842 | **2595,3** | **31,06** |
| | *chuẩn* | | | | *5377* | *39,37* |

So với **trạng thái đầu đợt** (trước mọi fix):

| | line-art | ảnh chụp |
|---|---|---|
| Chất lượng: sharp | 681,5 → **1274,5** (+87%) | 1705,2 → **2595,3** (+52%) |
| Chất lượng: HF% | 31,03 → **35,50** | 26,47 → **31,06** |
| Cân bằng: sharp | 797,8 → **916,8** (+15%) | 1968,0 → **2323,2** (+18%) |
| Cân bằng: PSNR | 23,80 → **24,17** | 17,57 → 17,27 |
| Nhanh: PSNR | 23,93 → **24,56** | 17,60 → **17,61** |
| Nhanh: HF% | 27,39 → **28,14** | 24,77 → **26,21** |

Chế độ Nhanh giờ **trung thực hơn ở mọi chỉ số** dù độ nét cảm nhận trên line-art tụt
10% — đó là hệ quả của việc bớt khử nhiễu: mất phần cứng mép nhân tạo, được thêm chi
tiết thật (PSNR và HF% cùng tăng).

Tiêu chí §6 của báo cáo:

| tiêu chí | line-art | ảnh chụp |
|---|---|---|
| gap Cân bằng vs Nhanh ≥ 10% | +23,1% ✅ | +19,9% ✅ |
| gap Chất lượng vs Cân bằng ≥ 10% | +31,1% ✅ | +18,9% ✅ |
| Chất lượng nét nhất | ✅ | ✅ |
| Chất lượng có HF% cao nhất | ✅ | ✅ |

**Giá phải trả, nói thẳng:** trên ảnh chụp, chế độ Chất lượng mất 0,98 dB PSNR và 0,055 SSIM so với trước. Đây là đánh đổi cố ý (nét cảm nhận đổi lấy fidelity toán học — chuẩn mực của SR dựa trên GAN), nhưng nó có thật. Nếu ảnh của bạn thấy quá "gắt", hạ bằng `PRYNX_UPSCALE_DETAIL_QUALITY=0.3` mà không cần build lại.

Seam test (`tmp/audit_upscale_seam.py`, tile 64 so với chạy nguyên ảnh): general 0 mức, balanced 0 mức, quality 1 mức — đạt.

## Kiểm thử đã chạy

| việc | kết quả |
|---|---|
| `pytest tests/test_upscale.py` | **19 passed** (từ 8 → 19: thêm 8 test cho §NET.01/02/03/04/08, sửa 1 test cũ) |
| `pytest tests` (toàn backend) | **1615 passed, 5 skipped** — sau khi cài torch/onnx và hạ sympy |
| `gen_third_party_notices.py --check` | đạt |
| xác minh runtime 422 (4 ca, không mock) | đạt |
| so sánh 3 mức DNI trên corpus | đạt |
| lưới hiệu chỉnh detail (7 mức) | đạt |
| `npm run typecheck` | đạt |
| `npm run test` (toàn frontend) | **1262 passed, 2 skipped** ở lần chạy 10:33 |
| `npx vitest run src/components/preprocess-tools src/i18n` | đạt phần của đợt này |
| `eslint` 2 file desktop đã chạm | 5 lỗi — **bằng đúng bản HEAD**, không thêm nợ lint |
| sidecar riêng cổng 8322, 4 vòng × 3 chế độ | 12/12 đạt (chẩn đoán §NET.09) |
| `py_compile` engine + route + script convert | đạt |
| parse `build_production.ps1` | đạt |
| smoke `warmup('general')` + `warmup('quality')` | True / True (đường build production dùng) |
| seam test tile vs nguyên ảnh | đạt |

**Lưu ý về các lần chạy toàn bộ frontend sau 10:38.** Có một workstream khác đang sửa song song trong cùng workspace (dieline / `box-variant-catalog`, các file còn untracked). Số lượng test đổi giữa các lần chạy (1264 → 1327 → 1328) và lần lượt xuất hiện 3 lỗi khác nhau, tất cả nằm ngoài đợt này:

- `src/stores/useBoxStore.test.ts` — chạy riêng lại đạt (15/15);
- `src/lib/dieline/geometry.test.ts` — chạy riêng lại đạt (39/39);
- `src/i18n/i18nCatalog.test.ts` — thiếu 5 khóa `dieline.dielineGallery:*`. Không có khóa nào của đợt này trong danh sách thiếu, tức `preprocess.imageBatchPreview:*` và `preprocess.upscale:*` đã đủ cả vi lẫn en.

Đợt này không chạm file nào trong số đó. Cần chạy lại toàn bộ frontend khi workstream kia dừng để có một lần xanh sạch.

Test cũ `test_balanced_mode_preserves_more_source_texture` đã bị thay: nó mock `_upscale_rgb`, mà bước bù chi tiết nay nằm **trong** hàm đó nên test không còn đo được thứ nó định đo. Thay bằng 4 test đúng kiến trúc mới: thang cường độ đơn điệu + override env, cường độ tới được vòng lặp ô, `_amplify_ai_detail` không tự sinh chi tiết khi model không thêm gì, pad quality rộng hơn general.

## Mức bằng chứng

**Mức 3 cho phần độ nét** — chủ dự án đã chạy `run_dev.bat` và xác nhận kết quả trên
ảnh thật là tốt (2026-07-29). Đây là chốt cho §NET.01/§NET.03/§NET.08: hướng sửa
đúng, thang ba chế độ hoạt động trong app thật, không chỉ trong phép đo.

**§NET.04 đạt Mức 2+** — đường 422 đã được chạy thật qua route (không mock), nhưng
bằng cách siết biến môi trường trên máy CÓ GPU, chưa phải trên máy khách thiếu GPU.
Phần code được chứng minh là toàn bộ chuỗi route → guard → probe → 422 → thông điệp.

**Chưa xác minh:**

- nút 1:1 chưa có DOM test cho zoom/pan (chỉ typecheck + lint + bạn xác nhận bằng mắt);
- chưa chạy `run_dev.bat` lại **sau khi đổi model** — bạn đã xác nhận bản trước đó,
  bản này model general đổi trọng số và `balanced` đổi 0,12 → 0,15 nên cần xem lại.

Cường độ `_DETAIL_BY_MODE` là **số chốt theo 2 ảnh nội bộ**. Có cơ sở đo, nhưng chưa
gọi là đã hiệu chỉnh cho corpus in ấn thật.

## Còn mở

| mục | lý do chưa làm |
|---|---|
| Thanh trượt khử nhiễu (bundle thêm bản DNI a=0,0 làm mức "giữ hạt tối đa") | đã đo là đánh đổi thật: ảnh chụp texture +30% nhưng line-art kém nét đi và PSNR/SSIM giảm. Cần corpus thật trước khi mở thành lựa chọn cho người dùng. Chi phí: +4,7 MB, một tham số API, hash pin thứ ba |
| §NET.05 ước lượng thời gian + tiến độ theo ô trên UI | là tính năng mới (cần job id / WS), không phải sửa lỗi. Hạ tầng đã có: `estimate_seconds` giờ chạy thật, chỉ thiếu đường đưa số đó ra UI trước khi chạy |
| §NET.05 timeout cho `heavy_job_slot` | `heavy_job_scheduler.py` dùng chung với bình bản và bù xén; đổi ở đây là blast radius ngoài phạm vi audit độ nét — cần audit riêng |
| model thứ ba cho line-art (`RealESRGAN_x4plus_anime_6B`), `RealESRGAN_x2plus` cho ×2 thật | mục UP-02, cần benchmark |
| corpus QA chất lượng có giấy phép rõ | mục UP-05 / lô C, vẫn chưa có |
| key `model_*` trùng trong nhóm `preprocess.bgRemover` | rác từ script i18n fill cũ, UI không dùng — ngoài phạm vi |

## Cần bạn làm để chốt

1. Chạy lại `run_dev.bat` và xử lý lại đúng ảnh cũ — **model general đã đổi trọng số**
   sau lần bạn xác nhận, nên kết quả chế độ Nhanh và Cân bằng khác đi (ảnh chụp nên
   nhiều texture hơn, ít bị bệt hơn).
2. Bấm **1:1** rồi mới so sánh hai bên thanh trượt.
3. Nếu chế độ nào quá gắt hoặc nổi hạt, thử `PRYNX_UPSCALE_DETAIL_QUALITY` /
   `_BALANCED` với 0,2–0,3 rồi cho tôi biết số vừa mắt để chốt mặc định.
4. Gửi 3–5 ảnh khách điển hình để đo trên corpus thật thay vì 2 ảnh nội bộ.
5. Quyết định có mở thanh trượt khử nhiễu (mức a=0,0) hay không — xem bảng đo ở lô 3.
