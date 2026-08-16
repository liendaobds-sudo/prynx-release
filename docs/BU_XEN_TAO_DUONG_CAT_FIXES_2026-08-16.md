# Nhật ký sửa — Bù xén / Tạo đường cắt — 2026-08-16

Theo `docs/BAO_CAO_AUDIT_BU_XEN_TAO_DUONG_CAT_2026-08-16.md`. **Chưa commit.**

## Lô A — biên API backend (1 file)

`backend/app/api/routes/pdf_tools.py`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.F06 | Thêm `_sticker_float_param()`; `offset_mm` (−50…50), `bleed_mm` (0…50), `edge_bite_mm` (0…10) đi qua nó | Trước đây là hai tham số hình học duy nhất không validate: `float("abc")` ném ValueError ngoài `try` → 500 trần; `'1e309'`/`'NaN'` lọt thành inf/nan vào `compute_cut_bleed_offsets` |
| §BX.F08 | Default `corner_style` `"round"` → `"preserve"` | Khớp UI và recipe. Client thiếu field trước đây nhận khuôn BỊ BO GÓC |
| §BX.F11 | `_set_sticker_json_header()` chỉ gắn `X-Sticker-Boxes`/`X-Sticker-Pages` khi ≤3000 ký tự; `X-Sticker-Warning` cắt ở 600 ký tự trước khi percent-encode | Hai header JSON không cap và không được frontend đọc; file nhiều trăm trang sinh header hàng chục KB, tiếng Việt percent-encode phình ~3× |

**Verify:** `pytest tests/test_api_contract.py tests/test_feature_entitlements.py` → 67 pass.

## Lô B — hợp đồng payload dùng chung (4 file)

`stickerToolPolicy.ts`, `StickerTool.tsx`, `recipeRunners.ts`, `recipeRunners.test.ts`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.F01 | `buildStickerDielineFields()` + `resolveStickerShapeMode()` trong `stickerToolPolicy.ts`; cả `StickerTool` (chạy tay), bản ghi recipe và `runStickerDieline` (phát lại) đều dùng | Ba công thức `shape_mode` song song: default `preserve` khiến chạy tay gửi `auto_safe` còn phát lại gửi `contour` → khuôn bế phát lại khác bản đã duyệt. Bản ghi recipe nay lưu thêm `forceContour` |
| §BX.F02 | `resolveStickerEdgeBiteMm()`: chỉ gửi lẹm mép với `image/trajectory/inpaint` | Ô nhập ẩn khi chọn "Đổ màu trơn" nhưng giá trị cũ vẫn gửi và engine vẫn clip artwork → mất nội dung sát mép, im lặng |
| §BX.F03 | `runVectorMirror` kiểm `finalRes.ok` trước `.blob()` | Download 404/400 trả JSON lỗi, blob đó được commit như PDF và THAY THẾ tài liệu đang mở |
| §BX.F04 | `bleedRes.json().catch(() => null)` + kiểm `ok`/`success`/`output_filename` | Sidecar trả HTML → message kỹ thuật (`Unexpected token '<'`) lọt vào hộp lỗi UI |
| §BX.F07 | `clampStickerMm()` áp cho `bleedMm`/`offsetMm`/`edgeBiteMm` ở mọi đường gửi | Playback recipe bỏ qua toàn bộ clamp UI; `String(NaN)` → `'NaN'` mà Python `float()` nhận |
| §BX.F09 | Normalize màu trơn ngay trong `useState` initializer | Storage cũ giữ `solid` + hex RGB: UI hiện 4 ô CMYK `0,0,0,0` nhưng payload gửi `#FFFFFF` → backend đổ DeviceRGB trong bài CMYK |
| §BX.F10 | Chỉ `setDetectedShapeType/Params` khi header có giá trị | Multi-page/selection không phát header → ghi `null` XOÁ hình đã dò, panel Bình tem bế rơi về `RECTANGLE` cho tem tròn |
| §BX.F13 | `resolveStickerCornerStyle()`/`resolveStickerRemoveWhiteBg()` giữ hai nhánh riêng của `cutMode='alpha'` ở cả playback | Playback trước đây bật `remove_white_bg` và đổi `corner_style` cho biên alpha → dò lại biên bằng mask nền trắng |
| §BX.F19 | `stickerBleedSidesToParam()` bỏ nhánh `'none'` không reachable | Dead branch; UI đã chặn trạng thái 0 cạnh |

**Test cập nhật/thêm** trong `recipeRunners.test.ts`:
- Sửa 1 assertion đang **khoá hành vi sai** (`preserve → contour`) thành hợp đồng đúng (`auto_safe`).
- Thêm 4 ca: van an toàn `forceContour`, nhánh `alpha`, `solid` không gửi lẹm mép, clamp NaN/ngoài khoảng.

**Verify:** typecheck pass; `vitest run src/lib/recipe src/components/preprocess-tools` → 272 pass.

## Lô C — huỷ job và trạng thái (1 file)

`StickerTool.tsx`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.F05 | `abortRef` + `isMountedRef`; `signal` xuống cả ba request (sticker-dieline, mirror-bleed, download); lượt mới abort lượt cũ; unmount abort; không commit/setState khi đã abort; `finally` chỉ nhả trạng thái nếu còn sở hữu controller; `disabled={isProcessing}` cho nút "Hình cắt sai?" | Trước đây không có đường huỷ nào: bấm sai phải chờ hết, bấm 2 lần → 2 job PDFium song song, đóng tab vẫn commit file vào tài liệu không còn chủ |
| §BX.F12 | Đọc `X-Sticker-Cut-Confidence`, hiện `(NN%)` cạnh tên hình, tô vàng khi `<50%` | Backend đã phát độ tin cậy nhưng UI bỏ qua → hình nhận sát ngưỡng trông y như hình chắc chắn |
| §BX.F15 | `let warnedAboutStickerStorage` → `Set<string>` theo loại lỗi; thông báo log sang tiếng Việt | Cờ boolean toàn cục xuyên tab, vi phạm bất biến `prynx-architecture` |

**Verify:** typecheck pass; `vitest` 3 thư mục liên quan → 429 pass.

## Lô D — hiệu năng engine (2 file)

`backend/app/workers/sticker_engine.py`, `backend/tests/test_sticker_parallel_fallback.py`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.P05 | Log `DPI cap` chuyển từ `logger.warning` chỉ khi `self.debug` sang `logger.info` luôn, kèm DPI thực | Bản phát hành trước đây không ghi gì khi tờ lớn bị hạ về ~95–152 DPI; DPI thực của đường cắt là thông tin nghiệp vụ |
| §BX.P06 | Tier 8–16GB: `min(cpu-1, 2)` → `min(cpu-1, 4)` | Bảng RAM chuẩn của dự án là `min(cores, 4)`. Máy 12GB/8 nhân chỉ được 2 worker → gần 2× thời gian (cùng dạng hồi quy §3.14, tier khác). `_cap_sticker_workers` vẫn hạ tiếp theo RAM trống |
| §BX.P07 | `_process_parallel` probe khổ **lớn nhất** trong 32 trang đầu, không chỉ trang đầu | File "bìa nhỏ + ruột tờ lớn" làm ước lượng RAM/worker thấp → quá nhiều worker → pool crash → sticky tuần tự |
| §BX.P08 | `_n_pages_should_parallelize(page_area_pt2=…)`: tier `full` + trang ≥ ~247×247 mm hạ ngưỡng 6 → 2 trang | Ngưỡng 6 tính theo ~2s/trang cỡ tem/A4; tờ lớn tốn nhiều giây/trang nên 2 trang đã bù overhead spawn. Máy yếu giữ nguyên 6 |
| §BX.P11 | `STICKER_MAX_WORKERS` set tường minh thì không còn bị kẹp bởi `cpu-1` (vẫn kẹp theo số trang) | Escape hatch phải thắng auto-detect cả hai chiều; `_cap_sticker_workers` đã làm đúng, chỗ này thì chưa |
| §BX.P12 | `MAX_LONG_PX`/`MAX_MEGAPIXELS` thành hằng số module `_STICKER_MAX_LONG_PX` = 6000, `_STICKER_MAX_MEGAPIXELS` = 28M, dùng chung với `_estimate_worker_ram_mb` | Trần 40M là nhánh chết (cạnh dài kẹp 6000 → tổng ≤36M), và hai chỗ lệch hằng số làm ước lượng RAM sai |

**Test cập nhật:** bảng tier `(12, 8)` → 4 worker, thêm ca `(12, 3)` → 2 để khoá cả nhánh CPU thấp.
**Verify:** `pytest tests/test_sticker_parallel_fallback.py tests/test_sticker_page_canvas.py` → 29 pass.

## Lô E — pre-pass AI (1 file)

`backend/app/workers/sticker_source_pipeline.py`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.P01 | Van cuối theo **RAM còn trống** (`_PDF_ANALYSIS_BYTES_PER_PX`=20, `_PDF_ANALYSIS_RAM_FRACTION`=0.55) áp cho mọi tier, có log khi hạ. `to_pil().copy()` giữ trong khóa PDFium (bitmap chết khi ra khỏi guard), `convert("RGBA")` đẩy RA NGOÀI khóa | Máy ≥16GB trước đây `max_edge_px = None` — tờ 1600 mm @300 DPI ≈ 18 900 px cạnh, ba buffer toàn khung ngay trong khóa PDFium toàn process |

**Quyết định thiết kế:** đã thử trần px cứng 6000 cho tier cao nhưng **bỏ** — nó hạ DPI phân tích trên máy mạnh, vi phạm nguyên tắc vàng "máy mạnh chạy hết công suất" (và làm fail đúng test `test_pdf_user_unit_keeps_physical_size_and_only_caps_low_ram` bảo vệ nguyên tắc đó). Chặn theo RAM còn trống giữ đủ 300 DPI khi máy còn bộ nhớ, cùng cách `_plan_background_work_size` đang làm.

**Verify:** `pytest tests/test_sticker_source_pipeline.py` → 27 pass.

## Verify tổng

| Phép kiểm | Kết quả |
|---|---|
| `tsc --noEmit -p tsconfig.app.json` | pass |
| `pytest tests` (toàn bộ backend) | **2880 pass**, 0 fail, 490s (sau Lô H; 2876 sau Lô E) |
| `vitest run` (toàn bộ frontend) | 2408 pass, 2 skip, **1 fail** — `LogoRebuildWorkspace.test.tsx` |
| `vitest run src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx` (riêng) | **33 pass** |
| `vitest run src/lib/recipe src/components/preprocess-tools src/components/imposition-tools` | 429 pass |
| `eslint` 4 file frontend đã sửa | 39 lỗi = **đúng baseline trước khi sửa** (đo bằng `git stash`) |
| `npm run lint:budget` | fail `react-refresh/only-export-components 58 > 32` — **đã fail y hệt trước khi sửa** (đo bằng `git stash`) |

**Về ca fail:** `LogoRebuildWorkspace.test.tsx` pass 33/33 khi chạy riêng, chỉ fail ở `waitFor` khi chạy full-suite dưới tải. Đợt này không chạm file nào của Logo Rebuild → flake thời gian có sẵn, không phải hồi quy của đợt này. Cần theo dõi riêng.

**Lưu ý môi trường:** chạy `pytest tests` qua pipe PowerShell sinh `UnicodeDecodeError` giả trong `_pytest/capture` và báo hàng nghìn "error" không thật. Phải set `PYTHONUTF8=1` + ghi ra file rồi đọc lại; kết quả thật là 2876 pass.

## Lô F — admission job tem (3 file) — §BX.P03

`backend/app/core/heavy_job_scheduler.py`, `backend/app/api/routes/pdf_tools.py`,
`backend/tests/test_sticker_admission.py` (mới)

### Đo TRƯỚC khi sửa

Test `test_job_tem_dang_cho_khong_chiem_suat_heavy_toan_cuc` đọc trực tiếp
`max_active_heavy_jobs() - _HEAVY_JOB_SLOTS._value` trong lúc 3 request tem đồng thời
đang chạy (engine giả bị giữ lại để nhìn đúng trạng thái "1 chạy, 2 chờ"):

| Phép đo | Trước | Sau |
|---|---|---|
| Suất heavy toàn cục bị giữ khi chỉ 1 job tem chạy | **3** | **1** |
| Số job tem chạy đồng thời (trần cố ý = 1) | 1 | 1 |

Đây là **đo được**, không phải suy luận: `assert 3 == 1` fail trước bản vá.

### Thay đổi

- `heavy_job_scheduler.py`: thêm `_STICKER_KINDS = {"sticker"}` + `_STICKER_SLOTS`
  (mặc định 1, override `PRYNX_MAX_STICKER_JOBS`) vào `_kind_gate()`. Gate được lấy
  **trước** suất toàn cục theo đúng thứ tự khóa cố định của module, nên không deadlock.
- `pdf_tools.py`: `sticker-dieline` chuyển từ `run_in_threadpool` (`kind="pdf-tools"`)
  sang `run_scheduled_in_threadpool("sticker", …)`; bỏ `with _sticker_job_slot(job_id)`
  bên trong `_run_sticker_job` và dedent lại thân hàm.
- `_sticker_job_slot` / `_STICKER_JOB_SEMAPHORE` giữ lại và đánh DEPRECATED để test cũ
  (`test_sticker_route_responsiveness.py` monkeypatch nó) vẫn import được.

**Vì sao quan trọng:** trước đây job tem xếp hàng vẫn giữ suất heavy toàn cục, nên 3 lần
bấm "Tạo đường cắt" là đủ khoá hết trần toàn cục (3 trên máy 16–64GB) và mọi endpoint
`pdf-tools` khác — merge, split, resize, optimize, OCR, decrypt — phải chờ oan dù chỉ có
**một** job tem thật sự đang chạy. Đúng dạng lỗi §LR3.01 đã sửa cho scheduler, nhưng
semaphore riêng của tem lặp lại nó.

**Verify:** `pytest tests/test_sticker_admission.py tests/test_sticker_parallel_fallback.py tests/test_sticker_route_responsiveness.py` → 32 pass.

## Lô G — i18n và phản hồi UI (4 file) — §BX.F18, §BX.F16

`vi.json`, `en.json`, `StickerTool.tsx`, `StickerTool.ui.test.tsx`

| Mã | Thay đổi | Lý do |
|---|---|---|
| §BX.F18 | 11 key mới trong `preprocess.sticker` (vi + en); thay hardcode: "Chọn sticker cần bù xén", tooltip + aria-label chọn đối tượng, "Bắt đầu chọn"/"Chọn lại"/"Xong chọn", "Chỉ xử lý N đối tượng đã chọn · trang N" (dùng interpolation), "Crop trang theo tem" + desc | Đổi ngôn ngữ sang EN thì các khối này vẫn tiếng Việt → giao diện nửa nạc nửa mỡ |
| §BX.F16 | `openImpositionTool` hiện thông báo `cong_cu_chua_kha_dung` thay vì `return` im lặng | Tool bị tắt trong registry: nút không làm gì, không nói gì, người dùng bấm lại nhiều lần |

`StickerTool.ui.test.tsx` mock `t()` bằng bảng key→text, nên phải khai báo 5 key mới —
đã thêm để test vẫn kiểm đúng bố cục người dùng thấy, không phải nới assertion.

**Verify:** typecheck pass; `vitest run src/lib/recipe src/components/preprocess-tools src/components/imposition-tools src/i18n` → 434 pass.

## Lô H — peak RAM nhánh song song (3 file) — §BX.P04

`backend/app/workers/sticker_engine.py`, `backend/tests/test_sticker_admission.py`,
`backend/tests/test_sticker_parallel_fallback.py`

### Đo TRƯỚC khi sửa

`test_chunk_song_song_khong_giu_het_trong_ram_cha` dùng `tracemalloc` quanh
`_run_sticker_chunks` với 5 chunk PDF thật (~3 MB/chunk, nội dung random để không nén được):

| Phép đo | Trước | Sau |
|---|---|---|
| Peak RAM Python của process cha | ≈ 5 × chunk (gom cả bộ) | < 2,5 × chunk |

### Thay đổi

- `_run_sticker_chunks(..., spill_dir=None)`: khi có `spill_dir`, mỗi
  `chunk_pdf_bytes` nhận được (từ pool hoặc in-process) được **ghi ra file tạm ngay** và
  bytes được `del`; phần tử đầu của result trở thành **đường dẫn**. Không truyền
  `spill_dir` thì giữ nguyên hợp đồng bytes cũ (test cũ không phải đổi payload).
- `_process_parallel`: `tempfile.TemporaryDirectory` cho spill dir, truyền vào cả ba
  đường gọi (pool đầy, pool giảm một nửa, fallback tuần tự). Finalizer của
  `TemporaryDirectory` dọn cả khi worker stage ném ra, `cleanup()` tường minh trên
  đường thành công.
- Merge loop nhận cả đường dẫn lẫn bytes; **đóng tường minh** các handle chunk sau
  `save` (trước đây cố ý không close nên rò tới GC — và trên Windows còn handle mở thì
  không xoá được file tạm).

**Vì sao quan trọng:** peak RAM của process cha trước đây ≈ 2× tổng dung lượng output
(bytes trong `results` + `BytesIO` của pikepdf), rơi đúng vào lúc worker vừa nhả RAM —
tức thời điểm dễ OOM nhất của cả job.

**Test cập nhật:** ba fake `_run_sticker_chunks` trong `test_sticker_parallel_fallback.py`
nhận thêm `spill_dir=None`.

**Verify:** `pytest tests` (toàn bộ backend) → **2880 pass**, 0 fail, 490s.

## Hoãn — cần đo và duyệt riêng

Các mục dưới đây đổi kiến trúc điều phối hoặc đường I/O, rủi ro hồi quy trên máy mạnh cao,
và theo `prynx-performance` phải **đo trước** rồi mới sửa. Không đưa vào đợt này:

| Mã | Vì sao hoãn |
|---|---|
| §BX.P02 (trang 1 raster 3 lần) | Phải bỏ hoặc tái dùng bitmap giữa inspector / analysis / engine — đổi luồng nhận diện, cần artifact oracle so contour trước–sau |
| §BX.P09 (serialize PDF 3 lần/job) | Gộp page box + watermark vào một `pikepdf.Pdf`. Chạm cả `restore_sticker_page_canvas` và `_safe_watermark` (license) — cần duyệt riêng vì liên quan watermark |
| §BX.P10 (guard `_banded_*_fill` trả False giữa vòng lặp) | Cần đo mới biết ca xấu xảy ra bao thường; sửa sai có thể đổi màu vùng bù xén |
| §BX.F14 (localStorage không scope tab) | Tách effect persist theo từng dep hoặc scope theo `tabId` — đổi hành vi ghi nhớ thiết lập, nên hỏi ý người dùng muốn thiết lập dùng chung hay riêng từng tab |
| §BX.F17 (Lật gương không dùng `file_path`) | `mirror-bleed` phải nhận thêm `file_path` → chạm schema + route preflight, dùng chung với `add-bleed`, ngoài phạm vi công cụ này |

**Đã đóng trong lượt sau (Lô F–H):** §BX.P03, §BX.P04, §BX.F16, §BX.F18 — cả hai mục
hiệu năng đều **đo trước khi sửa** bằng test giữ lại làm hồi quy, đúng yêu cầu của
`prynx-performance`.

## Chưa xác minh

- Mọi số RAM/px là số học từ hằng số trong code, **không phải đo runtime**.
- Chưa chạy `run_dev.bat` và thao tác thật (Mức 3). Bằng chứng hiện tại là Mức 1 + Mức 2.
- §BX.F11 chưa repro file ≥200 trang để biết trần header thật của h11/WebView2 là bao nhiêu.
- §BX.P06/P08 chưa benchmark trên máy 8–16 GB vật lý.

## Lô I — §WHITE-SHADOW: tem viền trắng + bóng mềm (2 file)

`backend/app/workers/sticker_source_pipeline.py`, `backend/tests/test_sticker_source_pipeline.py`
(+ `backend/scratch/probe_white_soft_shadow.py` làm chứng cứ số đo)

### Người dùng báo

Luồng **Ảnh AI nhiều tem**: nhánh tem **không** viền trắng + dropshadow chạy đúng; nhánh
tem **có** viền trắng + dropshadow cho kết quả dính nhiều rác nhận diện và đường cắt răng
cưa, trong khi "cách đây vài commit thì tốt hơn".

### Hai nhánh rẽ ở đâu — đã truy vết

Cả hai vào `detect_background`, rẽ ở `_looks_like_fragmented_sticker_sheet`:

| | Không viền trắng | **Có viền trắng** |
|---|---|---|
| Mask so màu nền | artwork tối/màu → một component liền | viền trắng ≈ màu tờ → chỉ còn chữ/nét → **xé mảnh** |
| `_looks_like_fragmented_sticker_sheet` | `False` | `True` |
| HEAD (`.tmp/head_pipeline.py:597-606`) | đi tiếp | **`return None` → bail sang AI** |
| Working tree (`:653-673`) | đi tiếp (không đổi) | **bị chặn**, xử lý bằng code mới |
| Bộ khử bóng thực dùng | `sticker_sheet_engine._remove_attached_neutral_shadow` (chín) | `_recover_white_body_component` (mới) |

`git log -S"_recover_white_body_component"` trả **rỗng** → hàm này chỉ có trong working
tree, chưa từng được commit. Đây là nguồn hồi quy, không phải commit cũ.

### Bốn chỗ bộ mới yếu hơn bộ chín

| Mã | Bộ chín (`sticker_sheet_engine.py`) | Bộ mới (trước Lô I) |
|---|---|---|
| §WHITE-SHADOW.1 | dilate 1 px + nới tới `luma ≤ 252`, `chroma ≤ 18` (`:413-425`) | dừng cứng ở `shadow_luma_max` → đuôi gradient 249–252 dính lại vào thân tem |
| §WHITE-SHADOW.2 | rim trắng ≥ `0.88` **và** cải thiện ≥ `0.08` (`:458-463`) | rim trắng ≥ `0.70`, không đòi cải thiện |
| §WHITE-SHADOW.3 | chỉ **trừ**, không bao giờ tô đầy | `cv2.fillPoly` contour ngoài → một chỗ dính sai làm phình cả silhouette |
| — | có `_filter_full_page_jpeg_halo_components` ở luồng `StickerEngine` | không dùng bộ lọc halo JPEG nào |

Cả `_recover_fragmented_near_white_sheet` và `_recover_white_body_component` có **0 test**.

### Số đo trước khi chọn ngưỡng

`scratch/probe_white_soft_shadow.py` dựng hai fixture khác nhau **đúng một biến** (bóng
phẳng 205 vs gradient 252→205) rồi đo dải bóng dính biên của một tem:

| Phép đo | Bóng cứng | Bóng mềm |
|---|---|---|
| bg đo được / `tolerance` | `(253,253,253)` / 12 | `(253,253,253)` / 12 |
| `corner_p95` → `strict_tolerance` | 0.0 → **1** | 0.0 → **1** |
| `shadow_luma_max` / `rim_white_min` | 248 / 251 | 248 / 251 |
| số pixel bóng dính biên | 1 631 | 5 680 |
| **tỉ lệ luma > 240 (span 8)** | **0,0018** | **0,2243** |
| luma bóng p50 / p95 | 205 / 206 | 225 / 248 |

Hai giá trị cách nhau hai bậc độ lớn. Ngưỡng `0,10` nằm giữa, cách bóng cứng 55× và bóng
mềm 2,2× — chọn từ số đo, không chỉnh tay mò.

Số đo này cũng bác một giả thuyết trung gian của tôi: dải "mơ hồ" giữa `shadow_luma_max`
và `rim_white_min` chỉ rộng **2 mức** (249–250), nên guard theo dải đó gần như không bao
giờ bắt được. Đã bỏ, thay bằng phép đo đuôi gradient ở trên.

### Thay đổi

| Mã | Thay đổi |
|---|---|
| §WHITE-SHADOW.3 | Phát hiện **bóng mềm** ngay sau khi xác định dải bóng dính biên: tỉ lệ pixel có `luma > shadow_luma_max - 8` vượt `0,10` → `return None` (kèm log) → auto rơi về AI, đúng hành vi HEAD |
| §WHITE-SHADOW.1 | Thêm bước nới 1 px qua đuôi gradient (`_AUTO_WHITE_SHADOW_EXPAND_LUMA_MAX = 252`, `_CHROMA_MAX = 20`), mượn đúng ràng buộc của bộ chín |
| §WHITE-SHADOW.2 | `_AUTO_WHITE_BOUNDARY_RATIO_MIN` `0.70 → 0.88`; thêm `_AUTO_WHITE_BOUNDARY_GAIN_MIN = 0.08`, chỉ áp khi thực sự đã bóc bóng (tem không bóng thì `before` đã cao sẵn, không có gì để cải thiện) |
| — | Trích `_rim_white_ratio()` để đo trước/sau bằng **cùng một** tiêu chí |

Nhánh tem **không** viền trắng không đi qua hàm này nên không bị ảnh hưởng.

### Verify

| Phép kiểm | Kết quả |
|---|---|
| `test_auto_recovers_near_white_sticker_bodies_without_ai` (ca bóng **cứng**, của người dùng) | pass — vẫn phục hồi 6 silhouette, **không** gọi AI |
| `test_auto_nhuong_ai_khi_tem_vien_trang_co_bong_mem` (ca bóng **mềm**, mới) | pass — bail sang AI, 6 instance |
| `pytest tests/test_sticker_source_pipeline.py` | 29 pass |
| `pytest tests` (toàn bộ backend) | **2884 pass**, 0 fail, 494s |

### Còn mở — cần file thật để quy trách nhiệm

- **Vòng tròn rác cạnh chữ "i"**: tôi từng nghi `_detect_exact_vector_shapes`, nhưng đọc
  lại thì nó chỉ chạy khi `boundary_source == "vector"`, còn ca ảnh JPG đi `simple-bg` —
  nên **không** phải nguyên nhân ở ca này. Sau Lô I ca này đi AI nên rác nhận diện phải
  hết theo; nếu vẫn còn thì nguồn khác, cần artifact để truy.
- HEAD có `_refine_dominant_round_components` **đối chiếu ứng viên tròn với mô hình AI**;
  hàm đã bị xoá, `_detect_exact_vector_shapes` thay thế **không** đối chiếu AI. Việc này
  ảnh hưởng nhánh PDF vector, không ảnh hưởng ca JPG vừa sửa — chưa sửa vì chưa có repro.
- Bốn defect gốc của nhánh phục hồi (dung sai đo ở góc ảnh thay vì vành artwork; `fillPoly`
  khuếch đại; thiếu bộ lọc halo JPEG; không đối chiếu AI) **vẫn còn**. Lô I chỉ bảo đảm
  nhánh này **tự nhận ra khi không đủ bằng chứng và nhường cho AI**, chưa làm nó đúng cho
  bóng mềm. Muốn nó tự xử lý được bóng mềm thì phải làm tiếp theo thứ tự đã nêu ở mục
  "Đề xuất" trong báo cáo audit.

Bằng chứng đợt này: Mức 2 (test tự động trên fixture đo được). **Chưa có Mức 3** — chưa
chạy trên file thật của người dùng.


## Lô J — A/B trên file thật của người dùng + §CUTJAG.1 (4 file)

`backend/app/workers/sticker_engine.py`, `backend/app/workers/sticker_cutline_preview.py`,
`backend/app/workers/sticker_sheet_export.py`, `backend/tests/test_sticker_cutline_tuning.py`

File thật: `test/1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg` (1313×1198, 9 tem).

### A/B với code đã commit — việc người dùng yêu cầu, trước đây tôi chưa làm

Harness dựng lại đúng luồng route (`inspect_sticker_source` → `create_source_session` →
`begin_source_detection` → `detect_sticker_source` → `promote_source_session` →
`build_sticker_cutline_preview`), chạy được trên cây HEAD qua `git worktree` + biến
`PRYNX_AB_ROOT`, nên hai phía dùng **cùng venv, cùng file, cùng tham số**.

| Phép đo | HEAD `4f513d8` | `4e5ba71` (commit cuối chạm fitter) | Working tree (Lô A–I) |
|---|---|---|---|
| `boundary_source` | ai | ai | ai |
| số tem | 9 | 9 | 9 |
| diện tích từng tem (px) | giống hệt | giống hệt | giống hệt |
| `segment_count` | 660 | 660 | 660 |
| `effective_deviation_mm` | 0,3095419 | 0,3095419 | 0,3095419 |
| `dropped_component_count` | 15 | 15 | 15 |
| `preview_seconds` | 0,815 | 0,812 | 0,796 |

**Kết luận:** kết quả **trùng đến từng chữ số** ở cả ba mốc. Toàn bộ 9 lô chưa commit
(A–I) **không** gây ra răng cưa và **không** làm chậm ca này. Răng cưa là **lỗi có sẵn**,
không phải hồi quy của mấy commit gần đây.

**Về "tốc độ quá lâu":** lần đo đầu tiên cho `preview_seconds = 37,49`. Đo lại 4 lần nữa
đều 0,54–0,82 s. Log lần đầu cho thấy nguyên nhân thật: `BiRefNet[lite]` bị
`8007000E Not enough memory` trên DirectML → **rớt về CPU**, đồng thời PowerShell của
máy cũng ngã vì "paging file is too small". Đó là máy hết bộ nhớ tại thời điểm đó, không
phải hồi quy code. Trạng thái ổn định: inspect 0,03 s + detect 0,80 s (cache Alpha AI ấm)
+ preview 0,60 s.

### Nguyên nhân răng cưa — đo tại chỗ

Probe đọc trực tiếp `analysis.raw_alpha` của mô hình:

| Phép đo trên mask AI thật | Giá trị |
|---|---|
| tỉ lệ pixel trung gian (`16 < a < 239`) | **2,06 %** → mask gần như nhị phân, không có phản răng cưa |
| tỉ lệ **đảo dấu độ cong** dọc biên (4 tem đầu) | **0,67–0,78** |
| góc gấp trung bình dọc biên | **13–21°** |
| cùng mask + Gaussian σ = 1,2 px | **0,24–0,30** và **4,1–6,7°** |
| IoU silhouette trước/sau Gaussian | **0,9979–0,9989** (lệch dưới một pixel) |

`prepare_alpha_cutline_geometry` chạy marching-squares **trực tiếp** trên mask này, nên
đường bế thừa hưởng nguyên bậc thang pixel. Fitter Bézier ở hạ nguồn không cứu được vì
ngân sách sai lệch của nó (0,31 mm) buộc nó phải bám sát chính cái biên gợn đó.

### Chọn bộ lọc — đã thử 6 ứng viên, đo cả hai mặt

Mặt A: hiệu quả trên mask AI thật. Mặt B: hồi quy góc thật, đo bằng
`protected_corner_count` trên fixture `_sharp_mask("star"/"notch")`.

| Ứng viên | đảo dấu (mask AI) ↓ tốt | góc `notch` (gốc = 11) | góc `star` (gốc = 10) |
|---|---|---|---|
| không lọc | 0,571 | 11 | 10 |
| **Gaussian 1,2 px** | **0,262** | **0** ❌ | 10 |
| median 3 | 0,567 | 11 | 10 |
| median 5 | 0,569 | 0 ❌ | 10 |
| median 3 + Gaussian 0,6 | 0,425 | 0 ❌ | 10 |
| morph open+close 3 | 0,562 | 11 | 10 |
| bilateral 5 | 0,619 (xấu hơn) | 11 | 10 |

**Không ứng viên nào thắng cả hai mặt.** Gaussian là bộ duy nhất khử được răng cưa nhưng
nó bào mất góc thật của khe (`notch`) — đúng ca `pytest` bắt được:
`test_kiem_tra_cuoi_bao_ve_goc_that_nhung_loai_doan_dao_ngan[notch-9]` fail `assert 0 >= 9`
ở bản vá đầu của tôi.

### Thay đổi cuối — cổng theo NGUỒN BIÊN

| Mã | Thay đổi |
|---|---|
| §CUTJAG.1 | `_presmooth_cutline_alpha()` + `should_presmooth_cutline_alpha()` trong `sticker_engine.py`. Sigma chặn hai lớp: ≤ 1,2 px **và** ≤ 0,12 mm (DPI thấp thì tắt hẳn); `BORDER_REPLICATE` để tem chạm sát khung không bị bào cạnh |
| | `prepare_alpha_cutline_geometry`/`build_alpha_cutline_geometry` nhận `presmooth_alpha=False` — **mặc định TẮT**, nên mọi luồng cũ và golden master không đổi một byte |
| | Bật ở 3 điểm gọi thật theo `page.boundary_source`: chỉ `ai` và `simple-bg` (hai nguồn nhị phân hoá từ điểm ảnh). `vector` / `existing-cut` / `alpha` giữ nguyên |
| | `presmooth_alpha` vào `geometry_key_payload` của live preview và vào **segment key** của export nhiều trang, để hai trang khác nguồn biên không bị gộp chung lô raster |

Đặt bộ lọc **trước** marching-squares, không đặt trong fitter: nhờ vậy `base_geometry`,
`ideal_geometry` và mọi guard sai lệch ở hạ nguồn đều tham chiếu **cùng một** silhouette.

### Kết quả trên file thật của người dùng

| Phép đo | HEAD | + §CUTJAG.1 |
|---|---|---|
| `dropped_component_count` (rác nhận diện) | **15** | **1** |
| `segment_count` | 660 | 552 |
| tổng số neo | 669 | 561 |
| biến thiên góc quay / 360 (trung bình 9 tem) | 8,207 | **6,933** |
| biến thiên góc quay / 360 (tem xấu nhất) | 24,312 | **18,547** |
| `effective_deviation_mm` | 0,310 | **0,250** |
| `preview_seconds` | 0,815 | **0,539** |
| số tem, diện tích, `machine_safe` | 9 / — / true | **không đổi** |

### Test thêm

`tests/test_sticker_cutline_tuning.py`, 4 ca mới. Fixture là hình tròn có nhiễu biên
**từng pixel** với seed cố định — bản đầu tôi dùng sóng tuần hoàn thì fitter tự làm mượt
được (biến thiên = 1,000), tức fixture đó **không** tái tạo lỗi thật; đã thay.

- `test_khu_rang_cua_alpha_lam_muot_bien_mask_ai` — biến thiên biên giảm > 2×
- `test_khu_rang_cua_khong_lam_lech_silhouette_qua_mot_pixel` — IoU > 0,99
- `test_khu_rang_cua_bo_luon_rac_nhan_dien_nho` — vệt rác 2 px: `dropped` ≥ 1 → 0
- `test_khu_rang_cua_tat_mac_dinh_de_giu_goc_that` — khoá đúng lý do phải cổng theo nguồn
- `test_cong_khu_rang_cua_chi_mo_cho_mask_tu_diem_anh` — 7 ca `boundary_source`

### Verify

| Phép kiểm | Kết quả |
|---|---|
| `pytest tests -k "sticker or cutline"` (trước bản vá cổng) | 1 failed, 515 passed — bắt được đúng lỗi bào góc |
| `pytest tests -k "sticker or cutline"` (sau bản vá cổng) | **516 passed**, 0 fail, 246 s |
| `pytest tests/test_sticker_cutline_tuning.py` (có 4 ca mới) | **44 passed** |

### Phát hiện mới, CHƯA sửa — thanh "Độ mượt" gần như không có tác dụng

Quét `cutline_smoothness` trên chính file của người dùng, các tham số khác giữ nguyên:

| `cutline_smoothness` | tổng số neo | biến thiên góc quay / 360 | `effective_deviation_mm` |
|---|---|---|---|
| 0 | 561 | 6,933 | 0,2497 |
| 25 | 561 | 6,933 | 0,2497 |
| 50 | 561 | 6,933 | 0,2497 |
| 75 | 548 | 6,775 | 0,2847 |
| 100 | 522 | 6,404 | 0,2903 |

**0, 25 và 50 cho kết quả giống hệt nhau đến từng chữ số**, và 100 chỉ đổi 7,6 %. Nghĩa là
nửa dưới thanh trượt là **chết**, còn nửa trên thì gần như không nhích. Thông báo lỗi của
engine lại đang khuyên người dùng "hãy tăng Độ mượt" — tức đang chỉ vào một cái núm không
xoay. Cần một lô riêng: `_cutline_smoothness_scale` (0,45–1,90) bị các ràng buộc khác trong
fitter kẹp lại nên bão hoà. Chưa sửa vì đổi thang thanh trượt là đổi hình học của mọi ca
đang chạy đúng, phải có duyệt riêng.

### Còn mở

- Biến thiên góc quay còn 6,9 (tem xấu nhất 18,5). Chưa có mốc "bao nhiêu là đẹp" để biết
  còn phải đi tiếp bao xa — cần người dùng xem mắt thường trên `run_dev.bat` rồi xác nhận.
- Chưa đo lại đường **lạnh** (xoá cache Alpha AI) nên chưa biết BiRefNet mất bao lâu khi
  GPU khoẻ; nghi vấn §BX.P02 (trang 1 raster 3 lần) và §BX.P09 vẫn để nguyên.
- Bốn defect gốc của nhánh phục hồi tem viền trắng (Lô I) vẫn còn như đã ghi.

Bằng chứng đợt này: **Mức 3** — chạy trên file thật của người dùng, có A/B với ba mốc commit.


## §CUTHOOK.1 — GAI/MÓC trên đường bế: fitter tự sinh, guard không thấy (CHƯA SỬA)

Người dùng gửi ảnh zoom một đoạn đường bế quặt ngược tạo nêm mỏng. **Đây không phải răng
cưa** mà là gai/móc — dao bế đi vào đó sẽ cắt một khấc vào tem.

### Đo ba tầng để quy trách nhiệm

Probe đo góc quay lớn nhất trên quỹ đạo **được lấy mẫu dày** (kể cả bên trong từng cubic,
không chỉ tại anchor) ở ba tầng: contour của mask → `ideal_geometry` sau buffer → path cuối.
Gai = góc quay ≥ 120° trong một cung rất ngắn.

Trên `test/1785209372799_..._a00b34db50d68034ab0d94f4dcd8c982.jpg` (9 tem):

| Tầng | Góc quay xấu nhất | Số gai |
|---|---|---|
| contour của mask | 90–112° | **0** |
| `ideal_geometry` (sau buffer/offset) | 90–112° | **0** |
| **path cuối (sau fitter Bézier)** | **158–179,9°** | **1–67 mỗi tem** |

Mask và geometry offset **sạch hoàn toàn**. Gai do **fitter Bézier sinh ra**, không phải do
mô hình AI, không phải do mask, không phải do bước bù xén. Trên
`..._3465b9632654d75c79d1ccc23d3014df.jpg` cùng dạng: mask 94,43° → path cuối 170,44°, 11 gai.

### Guard đang báo an toàn cho chính những đường đó

Với **mọi** tem có gai, engine trả về:

```
machine_safe = true
maximum_join_angle_degrees ≈ 1,2e-06
unprotected_join_count = 0
short_segment_count = 0
```

`maximum_join_angle_degrees` đo **độ liên tục tiếp tuyến tại anchor (G1)**, không đo góc quay
hình học của đường được vẽ ra. Gai nằm **bên trong** một cubic segment nên nó vô hình với
phép đo này: 1,2e-06 độ trong khi quỹ đạo thật quặt 179,9°. Toàn bộ bộ xếp hạng ứng viên
(`live-bezier` / `corner-preserving-fallback` / `adaptive-safe-fallback` / `guarded-fallback`)
vì thế **chọn đúng ứng viên có gai** mà vẫn tin là an toàn.

### Bản vá §CUTJAG.1 đã dọn được phần lớn — đo được

Cùng file, cùng tham số, chỉ bật/tắt khử răng cưa Alpha:

| Tem | Gai khi TẮT | Gai khi BẬT |
|---|---|---|
| 1 | 1 (178,75°) | 1 (178,75°) |
| 2 | 1 (179,8°) | 3 (178,5°) |
| 3 | 1 (177,47°) | 2 (178,62°) |
| 4 | 2 (178,26°) | **0** (37,4°) |
| 5 | 5 (179,9°) | **0** (41,79°) |
| 6 | 6 (158,21°) | **0** (74,12°) |
| 7 | 11 (176,96°) | **0** (49,36°) |
| 8 | **67** (178,01°) | **0** (100,99°) |
| 9 | 4 (177,8°) | **0** (44,55°) |
| **Tổng** | **98** | **6** |

6/9 tem sạch hoàn toàn, tổng số gai giảm **94 %**. Nhưng 3 tem còn gai, bề rộng nêm
**0,04–0,06 mm** — mảnh hơn cả nét dao.

### Vì sao KHÔNG nên thêm thanh kéo "khử răng cưa"

1. Gai là **sai**, không phải sở thích. Không có vị trí thanh kéo nào làm một cái móc 179°
   trở nên hợp lệ. Người dùng không nên phải tự dò núm để tránh một defect.
2. Thanh **Độ mượt** hiện có **đã chết** ở nửa dưới (đo ở Lô J: mức 0/25/50 cho kết quả giống
   hệt đến từng chữ số). Thêm núm thứ hai vào một bảng đã có núm không xoay chỉ làm người
   dùng mất niềm tin vào cả hai.
3. Nguyên nhân đã định vị được chính xác: bộ xếp hạng ứng viên đang dùng một phép đo mù.
   Sửa phép đo thì bộ xếp hạng **tự** loại ứng viên có gai — đó là sửa lỗi, không phải
   thêm lựa chọn.

### Đề xuất thứ tự làm (cần duyệt vì đổi hợp đồng `machine_safe`)

1. **Đo đúng.** Trong `_alpha_final_cutline_quality`, thêm phép đo trên quỹ đạo lấy mẫu dày:
   góc quay hình học lớn nhất và **bề rộng nêm nhỏ nhất** (mm). Phát ra field mới, chưa chặn.
2. **Cho bộ xếp hạng thấy.** Đưa hai số đó vào tiêu chí chọn ứng viên, để `live-bezier` có
   gai bị loại và fallback không gai được chọn. Đây là chỗ thật sự sửa được ảnh người dùng gửi.
3. **Chặn khi mọi ứng viên đều có gai** → `machine_safe = false`. Bước này biến "xuất ra file
   sai âm thầm" thành "báo 422 rõ ràng", đúng hướng nhưng **người dùng thấy được**, nên phải
   duyệt riêng.
4. Sửa thanh **Độ mượt** đang bão hoà, sau khi 1–3 xong (đổi thang trượt lúc này sẽ trộn lẫn
   hai nguyên nhân).

Chưa làm bước nào trong 4 bước trên. §CUTJAG.1 (đã làm) chỉ giảm 94 % số gai chứ không đóng
được lỗ hổng của guard.


## Lô K — §CUTHOOK.1 bước 1+2: đo gai trên quỹ đạo và cho bộ xếp hạng thấy

`sticker_engine.py`, `sticker_cutline_preview.py`, `schemas/sticker_sheet.py`,
`tests/test_sticker_cutline_tuning.py`. Người dùng duyệt làm bước 1 và 2, chưa làm bước 3.

### Bước 1 — đo đúng

`_alpha_trajectory_cusp_summary()` đo trên **polyline lấy mẫu dày** (32 mẫu/cubic, tái dùng
đúng mảng `samples` mà `_alpha_live_machine_path_summary` đã tính, nên không thêm vòng lặp):

| Field mới trong `quality` | Ý nghĩa |
|---|---|
| `trajectory_cusp_count` | số cusp trên quỹ đạo (đã gom dải liền nhau) |
| `protected_cusp_count` | cusp khớp được với góc thật trên reference |
| `unprotected_cusp_count` | cusp do fitter tự sinh — **đây là gai** |
| `maximum_trajectory_turn_degrees` | góc quay hình học lớn nhất |
| `minimum_wedge_width_mm` | bề rộng nêm hẹp nhất |
| `cutline_hook_tolerated` | đã phải nhận ứng viên còn gai |

Ngưỡng cusp 60° cho **một bước lấy mẫu** (~0,014 mm ở 300 DPI) tương đương bán kính cong
~0,013 mm — không chi tiết bế thật nào cong tới mức đó. Bề rộng nêm đo bằng dây cung giữa
hai điểm cách đỉnh 0,35 mm theo chiều dài cung: đi thẳng cho ~2×span, góc 90° cho ~1,41×span,
móc quặt ngược cho ~0.

**Cusp không tự động là lỗi** — đầu nhọn tem hình sao cũng là cusp. Phân biệt bằng cách đưa
điểm cusp qua **đúng bộ so khớp góc thật đã có** (`_alpha_reference_corner_points` +
`_match_protected_corner_count`), thứ trước đây chỉ dùng cho khớp tại anchor. Cusp có trên
reference → được bảo vệ; cusp fitter tự sinh → `unprotected_cusp_count`.

Gom dải: một cái móc trải 1–3 mẫu liền nhau. Không gom thì đếm sai (đo được **101** "cusp"
cho cùng một vùng, sau gom còn **82**) và bộ so khớp phải chạy trên số điểm gấp nhiều lần.

### Bước 2 — cho bộ xếp hạng thấy

`accept_candidate()` đẩy ứng viên có `unprotected_cusp_count > 0` vào danh sách chờ thay vì
trả về ngay, nên chuỗi ứng viên đi tiếp xuống `corner-preserving-fallback` /
`adaptive-safe-fallback` (fit trên reference bất biến nên không sinh cusp mới). Nếu **không**
ứng viên nào sạch gai thì trả về ứng viên ít gai nhất kèm `cutline_hook_tolerated = True` —
**hành vi cũ được giữ, không sinh lỗi 422 mới**. Chặn hẳn là bước 3.

### Kết quả trên 4 ảnh test

| File | tem | Trước (không đo cusp) | Sau bước 1+2 |
|---|---|---|---|
| `1d1e06e0…` | 9 | 0,57 s — không gai | 0,61 s — **0 gai** cả 9 tem |
| `…d2aa5fed…` | 3 | 8,79 s | **4,70 s** — 2/3 tem sạch, 1 tem còn 1 gai |
| `…3465b963…` | 1 | 12,29 s | **11,28 s** — gai 11 → **1** |
| `…a00b34db…` | 9 | 44,21 s | 57,14 s — 4/9 tem sạch (trước: 0/9) |

Ba file sau là ca **nhận diện lỗi** (xem §CUTJAG.2), vốn đã 8,8–44 s ở HEAD.

### Hai lỗi phát sinh trong lượt này, đã sửa

**§CUTJAG.2 — bản vá làm mượt của Lô J phá mask mảnh.** Preview trả 422
"Không chuẩn bị được đường bế xem trước cho tem 1" trên `…a00b34db…`. Đo được: nhận diện AI
sinh vài "tem" là dải hairline — crop **8 × 1315 px**, Alpha đỉnh chỉ 235. Gaussian 1,2 px
làm dải đó rơi từ 1 363 px silhouette xuống **0 px**, và một tem khác từ 2 871 xuống **18**.
Van an toàn: mất quá 10% diện tích silhouette thì trả nguyên mask (tem thật giữ 99,79–99,89%
nên van không bao giờ chạm ca đang chạy đúng). Đây là lỗi **của tôi**, do Lô J tạo ra và
Lô K phát hiện — Lô J chỉ chạy trên một file nên không thấy.

**§CUTHOOK.2 — bộ dò góc thật chạy lại cho từng ứng viên.** `_alpha_reference_corner_points`
là bộ dò đa thang chạy trên reference; nó chỉ phụ thuộc `reference_geometry`, vốn bất biến
suốt chuỗi ứng viên, nhưng `_alpha_final_cutline_quality` gọi lại mỗi lần. Trước đây gần như
vô hại vì live-bezier thường được nhận ngay; sau bước 2 thì nó chạy 4 lần/tem. Đã thêm
`corner_cache` cấp từ `fit_prepared_alpha_cutline_geometry`. Đo được: `…3465b963…` 16,74 s →
16,20 s, `…d2aa5fed…` 9,74 s → 4,73 s.

Kèm **hạn mức độ trễ** `_CUTLINE_HOOK_SEARCH_BUDGET_SECONDS = 1,0`: khi đã có ứng viên dùng
được (chỉ vướng gai) thì tìm ứng viên sạch hơn là *tùy chọn*, nên phải chịu hạn mức của live
preview. Đo trên 4 file: tem bình thường tốn 0,2–0,6 s cho cả chuỗi nên không bao giờ chạm
hạn mức; ca bệnh lý (blob phủ cả trang, ring 11 425 điểm) tốn 2,7–2,9 s cho **mỗi** fitter
fallback nên dừng sau fitter đầu. `…3465b963…` 16,20 s → **11,28 s**. Đây là hạn mức **độ
trễ**, không phải cap theo cấu hình máy — máy mạnh vẫn chạy hết chuỗi vì làm xong trước hạn.

Phân rã thời gian một tem bệnh lý (ring 11 425 điểm): `prepare` 0,47 s · `corner` 0,24 s ·
`live` 0,56 s · `preserved` **2,73 s** · `adaptive` **2,88 s`.

### Test thêm — 6 ca

- `test_phep_do_quy_dao_bat_duoc_cusp_ben_trong_cubic` — path đóng có cusp nằm hẳn trong
  lòng một cubic (đạo hàm x triệt tiêu tại t ≈ 0,211, đạo hàm y còn ~0,008); khẳng định có
  cusp cách mọi anchor > 0,5 pt, tức đúng vùng `maximum_join_angle_degrees` không phủ
- `test_phep_do_quy_dao_khong_bao_dong_gia_tren_duong_muot` — đối chứng âm trên đường tròn
  4 cubic: 0 cusp, `minimum_wedge_width_mm` là None
- `test_gom_dai_mau_lien_nhau_thanh_mot_cusp` — gồm cả dải bắc qua chỗ nối polyline đóng
- `test_chat_luong_cuoi_phat_ra_so_do_quy_dao` — đầu nhọn hình sao là cusp thật và phải được
  bảo vệ: `unprotected_cusp_count == 0` (ca dễ báo động giả nhất)
- `test_khu_rang_cua_bo_qua_mask_mong_nhu_soi` + `test_khu_rang_cua_van_chay_tren_mask_day_binh_thuong`
  — van §CUTJAG.2 và đối chứng âm của nó

### Verify

| Phép kiểm | Kết quả |
|---|---|
| `pytest tests -k "sticker or cutline"` (sau bước 1+2, trước khi thêm test mới) | **527 passed**, 0 fail, 366 s |
| `pytest tests/test_sticker_cutline_tuning.py` (có 6 ca mới) | **50 passed** |

### Còn mở

- **Bước 3 chưa làm**: khi mọi ứng viên đều có gai, hiện vẫn xuất file kèm cờ
  `cutline_hook_tolerated`. Biến thành 422 là bước 3, cần duyệt vì người dùng thấy được.
- Bước 4 (thanh Độ mượt bão hoà) chưa làm.
- **Nhận diện sinh rác cấp instance** là lỗi riêng, chưa vào phạm vi: trên `…a00b34db…` mô
  hình trả "tem" là dải hairline 8 × 1315 px; trên `…3465b963…` trả một blob phủ gần cả
  trang (ring 11 425 điểm). Cả hai làm mọi thứ hạ nguồn vừa chậm vừa vô nghĩa. Đây là lý do
  thật khiến hai file đó 11–57 s, không phải do fitter.
- Giao diện chưa hiển thị `unprotected_cusp_count` / `cutline_hook_tolerated`; hiện chỉ có
  trong response và log.


## Lô L — §CUTJAG.3: thanh kéo "Khử răng cưa" + sửa lỗi tôi vá sai đường code

### Người dùng nói đúng: Lô J–K không chạm vào công cụ họ đang dùng

Người dùng báo "có gì khác biệt đâu". Truy lại thì đúng — **tôi vá sai đường code**:

| Luồng | Lấy contour ở đâu | Lô J/K có chạm? |
|---|---|---|
| Xếp tem / workspace AI nhiều tem (`/sticker-sheet/*`) | `prepare_alpha_cutline_geometry` → `sticker_engine.py:4807` | **Có** |
| **Bù xén — Tạo đường cắt (`StickerTool`, `/pdf-tools/sticker-dieline`)** | `StickerEngine.process_pdf` → `sticker_engine.py:8241` | **KHÔNG** |

Hai đường lấy contour hoàn toàn độc lập. `StickerEngine` tự dựng `aa_mask` →
`contour_mask` → `measure.find_contours(aa_mask_padded, 127.5)`, không hề đi qua
`prepare_alpha_cutline_geometry`. Với ca ảnh AI, `contour_mask = aa_mask = mask.copy()` là
mask **nhị phân thuần** (không `_feather_mask_tu_dung` vì `color_bg_detected is None`) → bậc
thang pixel nguyên vẹn. Đây là lý do người dùng không thấy khác biệt gì, và tôi đã báo cáo
kết quả Lô J/K như thể nó áp cho công cụ họ dùng — sai.

### Thanh kéo, đúng như người dùng yêu cầu từ đầu

Tôi đã cãi lại đề xuất thêm thanh kéo. Lập luận "gai là sai, không phải sở thích" vẫn đúng
cho **gai**, nhưng **răng cưa thì đúng là đánh đổi** giữa mượt và bám sát chi tiết — mà mức
đánh đổi phụ thuộc bài in, nên thuộc quyền người dùng. Đã làm.

| Tầng | Thay đổi |
|---|---|
| `sticker_engine.py` | `denoise_cutline_mask(mask, amount, px_per_mm)` — 0–100 → sigma, trần **2,5 px** và trần **0,30 mm** (DPI thấp tự tắt), dùng chung van mask mảnh §CUTJAG.2, log mức thanh kéo + sigma thực |
| | `process_pdf(..., cutline_denoise=0.0)` + vào dict arg của process pool; áp ĐÚNG lên `contour_mask` ngay trước `np.pad`, **không** ghi đè `aa_mask` (nó còn là nguồn màu bù xén §BG.4 — đo thấy ghi đè lệch tới −5,4% diện tích) |
| | `prepare_alpha_cutline_geometry`/`build_alpha_cutline_geometry` nhận `cutline_denoise`; **thanh kéo thắng cổng tự động** của §CUTJAG.1, để 0 thì cổng tự động vẫn chạy |
| `sticker_source_pipeline.py` | `build_legacy_single_page_approved_contour(..., cutline_denoise)` — nhánh một-tem AI cũng theo thanh kéo, và bật cổng tự động cho nguồn `ai` |
| `pdf_tools.py` | form param `cutline_denoise` qua `_sticker_float_param` (0–100), default **0** để client cũ không đổi kết quả |
| `stickerToolPolicy.ts` | `resolveStickerCutlineDenoise()` + field `cutline_denoise` trong `buildStickerDielineFields`; Xén vuông góc / "không tạo đường cắt" luôn gửi 0 vì hai ca đó không dò contour |
| `StickerTool.tsx` | thanh kéo 0–100 step 5, hiện "Tắt" khi 0, có `label htmlFor` + `aria-describedby`, `disabled` khi đang xử lý; nhớ vào localStorage; **mức khởi điểm UI = 30** (≈1,2 px ở 300 DPI, đúng mức đã đo ở Lô J) |
| `recipeRunners.ts` + `RecipePanel.tsx` | ghi/phát lại `cutlineDenoise`; recipe cũ thiếu field → 0 = tắt, giữ đúng bản đã duyệt |
| `vi.json` / `en.json` | 3 key `khu_rang_cua`, `khu_rang_cua_tat`, `khu_rang_cua_desc` |

Backend default 0 nhưng UI khởi điểm 30: nhờ vậy artifact/golden của mọi caller cũ không đổi
một byte, còn người dùng mở công cụ ra là đã có mức làm mượt đo được sẵn.

### Đo trên ĐÚNG engine của công cụ, với ảnh của người dùng

`StickerEngine.process_pdf` trên PDF dựng từ `test/1d1e06e0-…jpg`, đọc lại CutContour từ
content stream của PDF ra rồi lấy mẫu dày:

| Thanh kéo | Số điểm quỹ đạo | Biến thiên góc quay / 360 |
|---|---|---|
| 0 (tắt) | 2 711 | 151,77 |
| 30 (mức khởi điểm UI) | 2 641 | 146,16 |
| 60 | 2 351 | 134,63 |
| 100 | 2 108 | **117,37** (−23%) |

Đơn điệu và thông suốt từ form param xuống content stream PDF. Số này đo **toàn bộ** lệnh vẽ
trong trang (gồm cả hình bù xén) nên là chặn trên của độ gợn, không phải chỉ đường bế.

### Test thêm — 5 ca backend, 4 ca frontend

Backend `test_sticker_cutline_tuning.py`:
- `test_thanh_khu_rang_cua_mac_dinh_tat_giu_nguyen_mask` — 0 / None / chuỗi rác / NaN đều
  trả nguyên mask
- `test_thanh_khu_rang_cua_keo_cao_thi_muot_hon` — **đơn điệu** qua 0/30/60/100 và mức 100
  giảm hơn một nửa; đây là ca chặn "núm giả" như thanh Độ mượt hiện có
- `test_thanh_khu_rang_cua_bi_kep_theo_mm_khi_dpi_thap` — 25 px/mm thì kéo 100 vẫn tắt
- `test_thanh_khu_rang_cua_dung_chung_van_mask_mong` — dùng chung van §CUTJAG.2
- `test_thanh_khu_rang_cua_thang_cong_tu_dong` — kéo > 0 thắng cổng tự động, kéo 0 trùng
  nhánh tự động, và lệch diện tích < 2% (vẫn là khử nhiễu, không phải bo hình)

Frontend `recipeRunners.test.ts`: recipe cũ → 0; phát lại đúng mức đã ghi; kẹp về 100; xén
vuông và "không tạo đường cắt" → 0.

### Verify

| Phép kiểm | Kết quả |
|---|---|
| `tsc --noEmit -p tsconfig.app.json` | pass |
| `vitest run src/lib/recipe src/components/preprocess-tools src/i18n` | **287 passed** |
| `pytest tests/test_sticker_cutline_tuning.py` | **55 passed** |

### Còn mở

- Thanh **Độ mượt** cũ vẫn bão hoà ở nửa dưới (bước 4 của §CUTHOOK). Giờ panel có hai thanh
  liên quan tới độ mượt, một cái chạy một cái gần như chết — phải sửa hoặc gộp.
- §CUTHOOK bước 2 (loại ứng viên có gai) chỉ áp cho đường `sticker_cutline_preview`, **chưa**
  áp cho `StickerEngine.process_pdf`. Nghĩa là công cụ Bù xén vẫn có thể sinh móc; thanh kéo
  giảm được răng cưa nhưng không phải là bộ chống gai.
- Chưa chạy `run_dev.bat` thao tác tay: người dùng phải **khởi động lại sidecar** mới thấy
  thay đổi backend.


## Lô M — sửa nhầm lẫn công cụ: đưa thanh kéo về đúng panel "Tách tem từ ảnh AI"

### Bản đồ hai công cụ — xác định bằng code, không bằng phỏng đoán

Người dùng hỏi "đang làm ở công cụ nào". Truy bằng màu đường bế trong ảnh họ gửi:
`StickerSheetWorkspace.tsx:51` vẽ `stroke='#7c3aed'` — đúng màu tím trong ảnh. i18n
`preprocess.stickerSheet.title` = "Tách tem từ ảnh AI", `mode_help_ai` ghi rõ "hiển thị
đường cắt màu tím". Vậy ảnh người dùng gửi là của công cụ **B**.

| Công cụ | Giao diện | Route | Nơi lấy contour |
|---|---|---|---|
| **A. Bù xén — Tạo đường cắt** | `StickerTool.tsx` | `/pdf-tools/sticker-dieline` | `StickerEngine.process_pdf` → `sticker_engine.py:8241` |
| **B. Tách tem từ ảnh AI** | `StickerSheetWorkspace.tsx` + `StickerSheetPanel.tsx` | `/api/sticker-sheet/*` | `prepare_alpha_cutline_geometry` → `sticker_engine.py:4807` |

### Hai kết luận sai của tôi, đã sửa

**Sai 1 (Lô L).** Tôi kết luận "Lô J/K vá sai đường code". **Câu đó sai** — Lô J (§CUTJAG.1)
và Lô K (§CUTHOOK) nằm ở `sticker_cutline_preview` / `prepare_alpha_cutline_geometry`, tức
**đúng công cụ B**, đúng chỗ người dùng đang dùng. Tôi tự suy ra kết luận ngược từ việc
`StickerTool.tsx` đang mở trong editor, không kiểm bằng code.

**Sai 2 (Lô L).** Thanh kéo tôi làm ở Lô L đặt vào **công cụ A** — panel người dùng **không**
mở. Nên họ không thấy nó. Thanh kéo ở công cụ A vẫn giữ (nó có ích ở đó), nhưng phải có ở
công cụ B mới đúng yêu cầu.

### Thay đổi — nối `cutline_denoise` xuyên công cụ B

| Tầng | Thay đổi |
|---|---|
| `schemas/sticker_sheet.py` | `StickerCutlinePreviewRequest.cutline_denoise: float \| None = None`. **`None` ≠ `0`**: `None` = client cũ, để cổng tự động §CUTJAG.1 quyết định; `0` = người dùng chủ đích TẮT |
| `routes/sticker_sheet.py` | truyền xuống `build_sticker_cutline_preview` |
| `sticker_cutline_preview.py` | có gửi field thì thanh kéo **thắng** cổng tự động (`presmooth_alpha = False`); `cutline_denoise` vào `geometry_key_payload` nên cache geometry không lẫn giữa hai mức |
| `stickerSheetApi.ts` | `cutlineDenoise` vào options + body `cutline_denoise` |
| `stickerSheetStore.ts` | field trong cả `StickerSheetPageState` và `StickerSheetTabState`, default **50**, vào `setCutlineTuning` (có clamp + so sánh no-op) và vào payload `previewStickerCutline` |
| `StickerSheetPanel.tsx` | `CutlineSlider` thứ tư "Khử răng cưa", step 5, hiện "Tắt" khi 0, nhãn hai đầu "Giữ nguyên biên" / "Mượt hơn". Đặt **đầu nhóm** vì nó tác động lên đầu vào của ba thanh còn lại |

Default 50 → sigma 1,25 px ở 300 DPI, **khớp mức 1,2 px đã đo ở §CUTJAG.1** nên bật thanh
kéo không làm đổi kết quả so với cổng tự động đang chạy. Kéo lên tới 100 = 2,5 px.

### Verify

| Phép kiểm | Kết quả |
|---|---|
| `tsc --noEmit -p tsconfig.app.json` | pass |
| `vitest run src/lib src/components/preprocess-tools` | **1659 passed**, 2 skip |
| `pytest tests -k "sticker or cutline or api_contract"` | **596 passed**, 0 fail, 283 s |

`stickerSheetApi.test.ts` thêm assert `cutline_denoise: 65` xuống payload để thanh kéo không
âm thầm bị bỏ rơi ở tầng API.

### Còn mở

- Bước xuất file của công cụ B (`export_sticker_sheet_document`) **chưa** nhận
  `cutline_denoise`; hiện nó dùng lại geometry của preview qua
  `_cutline_overrides_with_preview_fallback` nên khớp preview trong đường thường, nhưng
  nhánh fallback tự fit sẽ không theo thanh kéo. Cần nối cho chắc.
- Thanh **Độ mượt** của công cụ A và thanh **Bám sát hình gốc** của công cụ B vẫn dùng
  `cutline_smoothness` đang bão hoà (bước 4 §CUTHOOK).
- Người dùng phải **khởi động lại sidecar** mới thấy phần backend.


## Lô N — zoom "tách nền tem" (tiếp §VIEW.ZOOM-CENTER)

### Xác định lại bằng sub-agent

View "tách nền tem" **không** có viewport zoom riêng: `StickerSheetWorkspace` luôn mount
`embedded` làm `pageOverlay` của AcrobatViewer (ImpositionTab.tsx:3197-3208), nên zoom đi
qua **cùng** `useViewerZoom` như view chính. `LivePageFrame` **có** scale khung theo zoom
cho cả ảnh lẫn PDF (`displayWidth = actualWidth100 * zoom`, LivePageFrame.tsx:3056; áp lên
`.relative` :4512), không dùng transform-scale gốc top-left. Vậy sizing không phải nguyên
nhân.

### Lỗi trong bản vá Lô M của tôi

Lô M chỉ sửa nhánh `focal === null` (nút +/−, nhập %). Nhánh **Ctrl+cuộn** có `focal` nên
KHÔNG đi qua sửa đó — nếu người dùng zoom bằng Ctrl+cuộn thì fix Lô M vô tác dụng, đúng như
phản hồi "vẫn vậy".

### Sửa

Nhánh fallback của Ctrl+cuộn (`!restoredFromPage`, tức neo-theo-điểm thất bại) trước đây
dùng công thức theo gốc scroll `(scrollLeft + mouseX) * ratio − mouseX`. Công thức này SAI
với layout canh giữa (`flex items-center`) và kéo về góc trên-trái. Nay ưu tiên **neo hình
học theo điểm-tâm** đã ghi (`centerAnchorRef` + `restorePageViewportAnchor`); chỉ khi cũng
không có mới dùng công thức cũ làm phương án chót. Kết quả: worst-case là zoom ổn định theo
tâm, không còn trôi về trên-trái.

### Chưa chắc chắn

- Vì sao neo-**theo-con-trỏ** (`restorePagePointViewportAnchor`) thất bại riêng ở overlay
  tem mà không thất bại ở PDF thường — chưa xác định được bằng đọc code tĩnh (nghi `.relative`
  rect = 0 tại thời điểm cuộn, hoặc trang fit không cuộn được). Cần soi runtime DOM. Bản vá
  hiện bảo đảm KHÔNG trôi trên-trái nhưng nếu điểm-anchor thất bại thì chỉ neo theo tâm, chưa
  chính xác theo con trỏ như view chính.

Verify: typecheck pass; `pageViewport` + `AcrobatViewer` + hooks viewer = **107 passed**.
