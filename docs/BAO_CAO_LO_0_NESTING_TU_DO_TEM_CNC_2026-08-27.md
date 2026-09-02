# BÁO CÁO LÔ 0 — NESTING TỰ DO CHO BÌNH TEM BẾ / CNC

**Ngày:** 2026-08-27
**Kế hoạch:** `docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md`
**Audit nền:** `docs/BAO_CAO_AUDIT_TICH_HOP_NESTING_TEM_CNC_2026-08-27.md`
**Trạng thái:** **CHỜ DUYỆT** — chưa sửa một dòng code sản xuất nào. Lô 1 không được bắt đầu trước chốt duyệt này.

---

## 1. Lô và mục tiêu

Lô 0 theo kế hoạch §12: thu corpus đủ 4 flow × 2 intent, ghi baseline, rồi **trình duyệt** compactness metric, tolerance, hash precision, search/time budget, cancel SLA và ngưỡng p50/p95/RAM. Không đổi hành vi.

Mục tiêu thật của lô này là trả lời một câu: **có đủ bằng chứng để chi tiền cho 11 lô tiếp theo không, và nếu có thì phạm vi nào?** Câu trả lời sau khi đo là **có, nhưng phạm vi phải hẹp lại so với kế hoạch** — chi tiết ở §6 và §7.

---

## 2. File đã đổi (3 file, không có file sản xuất)

| File | Loại | Vai trò |
|---|---|---|
| `backend/tests/fixtures/nesting_tu_do/corpus_lo0.json` | mới | Corpus v1: 16 nguồn khai báo, 23 ca, ma trận phủ 4 flow × 2 intent đủ 8 ô |
| `scripts/lo0_nesting_baseline.py` | mới | Harness đo baseline + smart. Chỉ đọc `backend/app`, không import ngược vào production |
| `docs/BAO_CAO_LO_0_NESTING_TU_DO_TEM_CNC_2026-08-27.md` | mới | Báo cáo này |

Không sửa `backend/app/**`, `imposition_core/**`, `native/**`, `desktop/**`. Không cập nhật golden. Không commit.

PDF khách hàng **không** vào repo: `.gitignore:153` đã loại `/private_test_corpus/`. Corpus mô tả PDF theo cách khai báo và harness tự sinh bằng pikepdf, đúng khuôn mẫu `backend/tests/fixtures/mixed_nesting_sources/manifest.json` đã dùng trong repo.

---

## 3. Hợp đồng đã kiểm và trạng thái thực tế

### 3.1. Đường dẫn — kế hoạch đúng, audit report cũ

`rg` xác nhận: `backend/app/workers/sticker_imposer_pkg/{layout_compute,orchestrator,bin_packing}.py` **tồn tại**; `sticker_layout/` mà audit report nêu **không tồn tại**. Kế hoạch §12 Lô 5 ghi đúng. Cần sửa lại đường dẫn trong audit report để lô sau không đi tìm file không có.

### 3.2. Mapping taskMode — đúng như kế hoạch

- `taskMode` hợp lệ chỉ còn 3 giá trị: `nup` | `step_repeat` | `booklet`. `sticker_imposer`/`cnc_imposer` là legacy và bị normalize về `nup` (`store/profiles.ts:47-50`).
- `resolveLayoutTypeForTaskMode` (`store/profiles.ts:63-72`): `step_repeat → layoutType='repeat'`. Ghi ngay tại `setTaskMode` (`workspaceSlice.ts:41-61`), có effect vá state lệch (`ImposerDashboard.tsx:691-694`), và cùng một công thức ở cả hai callsite submit (`:1521-1524`) và preview (`:1972-1975`).
- Dropdown "Cách xếp" là `gridStrategy`, **độc lập** `taskMode`, hiện đúng 3 option `optimal_auto` | `simple_auto` | `manual` (`GridSettingsSection.tsx:503-515`), default store `optimal_auto` (`nupSlice.ts:119`).

### 3.3. Hai callsite payload khác cả naming lẫn đơn vị

| | EXECUTE | PREVIEW |
|---|---|---|
| Nơi build | `processHandlers.ts:267-373` | `GridPreview.tsx:1535-1618` |
| Naming | camelCase | snake_case |
| Đơn vị | **mm** | **point** (`× MM_TO_PT`) |
| Khoá strategy | `gridStrategy` (`:288`, fallback `'simple_auto'`) | `strategy` (`:1541`) |
| Endpoint | `POST /imposition/nup-start` | `POST /imposition/preview-layout` |

Có callsite thứ ba: `/imposition/preview-layouts-batch` (`ImposerDashboard.tsx:1322-1325`). Bất kỳ field mới nào của strategy phải đi qua **cả ba**, và phép chuyển mm↔pt chỉ được xảy ra đúng một lần ở mỗi nhánh.

### 3.4. Điểm chèn thật cho `true_shape_nesting`

`rg` cho ra một phát hiện **ngoài phạm vi kế hoạch §12 Lô 9**: `GridStrategy` là enum Rust ở `imposition_core/src/model.rs:81-89` có `ts-rs` export sang `desktop/src/components/imposition-tools/generated/GridStrategy.ts`. Đường sản xuất tem/CNC đọc `settings.get('gridStrategy')` dạng chuỗi thuần nên hai hợp đồng đang song song. Lô 9 phải quyết: đồng bộ enum Rust, hay giữ tách và ghi rõ lý do.

Nhánh gang CNC là điểm chèn tốn công nhất: `cnc_render.py:357` chỉ đọc `gridStrategy` cho nhánh S&R; nhánh gang **không đọc** và còn nén `gap = max(gapX, gapY)` (`cnc_render.py:361`). Thêm option UI là không đủ.

### 3.5. Biểu diễn xoay hiện tại — chỉ hai cờ boolean

`finalize_placements` (`imposition_finalize.py:25-107`) trả `cell: {x, y, width, height, isRotated, isRotated180}`. **Không có trường góc.** Cùng cặp cờ đó xuất hiện độc lập ở bốn nơi khác nhau, nên nâng lên affine phải chạm đúng chín điểm sau — đây là phạm vi thật của Lô 6/7/8:

| # | Điểm | Vấn đề khi góc tự do |
|---|---|---|
| 1 | `nup_artwork.py:1179-1196` `transform_die_point` | 4 nhánh `if` hard-code, anchor = góc `die_rect` |
| 2 | `nup_process_chunk.py:1229-1320+` | **Bản copy inline** của hàm trên — dễ bỏ sót nhất |
| 3 | `nup_artwork.py:1290-1296` nhánh `'re'` | Dựng lại `Rect(min..max)` từ 4 góc → hình nghiêng thành bbox trục chuẩn, sai đường bế |
| 4 | `pdf_ops.py:639-645, 650-656` | Swap `scale_x/scale_y` theo `rotate % 180` và tính `e/f` theo bbox. Ma trận `cos/sin` (`:663-673`) đã tổng quát; chốt chặn là phần tính khổ |
| 5 | `nup_clip_shape.py:189-197` cache key | Thiếu góc; fast-path "chỉ tịnh tiến" (`:269-286`) chỉ còn đúng khi khoá theo góc đã lượng tử |
| 6 | `imposition_finalize.py:47-51, 56-81` | Thiếu góc; `width/height` phải là bbox **sau** xoay vì `x_off/y_off` và `original_cell_y` dựa vào chúng |
| 7 | `pont_collision.py:250-285` `get_item_polygon` | `angle = 90×isRotated + 180×isRotated180` + scale theo `iw/ih` → méo footprint nghiêng |
| 8 | `nup_process_chunk.py:774-780` | Duplex toggle `isRotated180`; free-angle phải thành phép biến đổi góc |
| 9 | `pdf_ops.py:606-620` `_clip_path` | Clip là **nonzero winding**, không phải even-odd như kế hoạch §9 ghi; `nup_clip_shape._polygon_from_rings` (`:120-140`) **cố ý bỏ lỗ** để không clip mất artwork trong cửa sổ khuôn |

Điểm sáng: `imposition_parity._rotation_deg` (`:71-84`) **đã** ưu tiên khoá `"rotation"` dạng float độ trước khi fallback về cờ. Parity guard không phải viết lại từ đầu. Và `mixed_nesting_pdf_export.py:108-134` đã có `pose_matrix` → `RigidMatrix` + `transform_ring` — hạ tầng affine free-angle có sẵn để tái dùng.

### 3.6. Khoảng cách kernel so với `NestingRequestV1` / `PlacementManifestV1`

**Đã có, không phải làm lại:** `rotationDeg` liên tục; `referencePointMm` per-part; pose khớp đúng `p_sheet = R(θ)(p_local − ref) + (tx,ty)` (`transform.rs:6-10, 96-121`); `RigidTransform` chỉ lưu `(cos, sin, tx, ty)` nên mirror/scale/shear **bất khả biểu diễn ở cấp kiểu**; `Reflection` chỉ có một biến thể `Forbidden` (`model.rs:461-465`); orientation `Full` `[0°,360°)` là **mặc định** (`orientation.rs:40-48`); canonicalize góc **không** snap cardinal; `stopReason` (= `RunStats.termination_reason`); 16 version tag dùng được cho provenance; validator 15 mã lỗi gồm `TRANSFORM_NOT_RIGID`; 217 test Rust + 11 file test backend.

**Thiếu:** `inputHash` cấp job · `layoutFingerprint` · `manifestId` · `affineMm` derived echo · `layoutIntent` · `fixedObstacles` · `gapX`/`gapY` dị hướng · clearance part↔biên và part↔obstacle riêng · tách `cutContour` / `artworkClipPath` / `packingFootprint` (hiện **một** polygon `outer` + `holes`, và hole bị coi là vật liệu đặc — `model.rs:504-505`) · corpus hình học chia sẻ cho kernel Rust.

### 3.7. Scheduler — một hợp đồng của kế hoạch §10 không khả thi như đang viết

`heavy_job_scheduler.py:75-76`:

```
_WHOLE_MACHINE_KINDS = frozenset({"nup", "vdp", "compare", "mixed-nesting"})
_WHOLE_MACHINE_SLOTS = threading.BoundedSemaphore(1)
```

Bốn loại việc chia nhau **đúng một suất**. Nên:

- Kế hoạch §10 đòi "benchmark 1 job và 2 heavy job đồng thời để chứng minh không oversubscribe" — **hai job whole-machine không thể chạy đồng thời trong cùng process**, job thứ hai xếp hàng. Hợp đồng benchmark phải viết lại thành: đo thời gian chờ suất + chứng minh không oversubscribe, hoặc ghép một job whole-machine với một job nhóm khác.
- Tiến trình con của nup **không** dùng scheduler (chỉ tiến trình cha có `@scheduled_job("nup")` rồi `multiprocessing.Process`). Nên gọi kernel trong tiến trình con **không** deadlock — nhưng con cũng không tự biết grant. **Grant phải được truyền vào settings của tiến trình con.** Kernel hiện **không nhận** worker/RAM grant: chữ ký PyO3 chỉ có `solve(request_json)` (`mixed_nesting_py.rs`), số worker từ `plan_hardware()` chỉ dùng cho admission.
- `multi_start::solve` chạy **vòng `for` tuần tự**, không rayon (`multi_start.rs:157-208`). Toàn engine hiện là một thread. `reduce_candidates` đã dùng thứ tự toàn phần nên song song hoá về sau an toàn.

### 3.8. PDFium

Kernel **không** chạm PDFium (`mixed_nesting_service.py:21-23`; `mixed_nesting_pdf_source.py:8-11` dùng pikepdf thuần) nên `pdfium_guard()` không cần ở đường solver. Nhưng đường sản xuất tem/CNC thì chạm PDFium ở mọi bước render, và **chưa xác minh** `mixed_nesting_pdf_export.py`. Lô 4 phải kiểm.

---

## 4. Đã chạy gì, output ra sao

Máy đo: RAM 32.528 MB (nhóm **≥16 GB** theo quy tắc AGENTS.md #1), Windows, `backend/venv` Python 3.11.9, `pdfcompare_native` đã build (có `MixedNestingRun`).

```
backend\venv\Scripts\python.exe scripts\lo0_nesting_baseline.py --chi-bat-buoc --lap 5 --profile fast --time-budget-ms 20000
backend\venv\Scripts\python.exe scripts\lo0_nesting_baseline.py --case CNC_SR_AUTOFILL_TAMGIAC --case GEO_INTERLOCK_CHU_L --case GEO_TAMGIAC_DOI_DAU --lap 3 --profile balanced --time-budget-ms 45000
backend\venv\Scripts\python.exe scripts\lo0_nesting_baseline.py --case CNC_SR_AUTOFILL_TAMGIAC --case GEO_INTERLOCK_CHU_L --case GEO_TAMGIAC_DOI_DAU --lap 1 --profile tight  --time-budget-ms 90000
backend\venv\Scripts\python.exe scripts\lo0_nesting_baseline.py --chi-bat-buoc --lap 3 --profile balanced --rotation ca-hai --time-budget-ms 25000
```

Lượt thứ tư là phép đo quyết định ở §6.4: cùng seed, cùng profile, cùng deadline, chỉ đổi miền góc giữa `discrete [0,90,180,270]` và `free`.

**Chưa chạy:** vitest, tsc, pytest, cargo test — Lô 0 không sửa code nên không có gì để hồi quy. Chưa chạy Tauri end-to-end. Chưa dựng artifact PDF thật để soi raster; đó là việc của Lô 7/8.

Hai bài học khi dựng harness, ghi lại vì chúng là bẫy thật:

1. **Đường bế sinh ra phải là nét thuần VÀ màu nằm trong `DetectionConfig.die_colors`.** Lượt đầu dùng đỏ RGB `(1,0,0)` — không có trong bảng (`die_detection.py:56-74`) — nên `select_die_path` trả `None`, layout rơi về khung trang (`isPageFallback=true`, trim 60×60, 24 con/tờ). Đổi sang **magenta RGB `(1,0,1)`** thì nhận đúng đường bế và ra 45 con/tờ với `staggered`. Nếu không phát hiện, toàn bộ baseline sẽ sai và mọi so sánh sau đó vô nghĩa.
2. `p95` của ca đầu tiên cao gấp ~14 lần `p50` (0,1247 s vs 0,0091 s). Đó là warm-up import + dựng NFP ở lần chạy đầu, **không** phải phương sai solver. Mọi ngưỡng p95 phải bỏ lần chạy đầu hoặc warm-up trước khi đo.

---

## 5. Golden và diff kiểm tay

Không có golden nào được tạo hay cập nhật. Không có snapshot hình học nào bị chạm. Diff toàn bộ lượt này là ba file mới ở §2; hai file dữ liệu/script không nằm trong đường thực thi sản xuất.

---

## 6. So sánh baseline — số thật

### 6.1. Baseline (đường sản xuất hiện hữu), một tờ, lặp 5

| Ca | con/tờ | strategy thắng | util % | hcn dư còn lại | p50 (s) | p95 (s) |
|---|---:|---|---:|---|---:|---:|
| ST_SR_AUTOFILL_TRON | 45 | `staggered` | 67,71 | 8 × 430 mm | 0,0091 | 0,1247 |
| ST_SR_QUANTITY_TRON | 45 | `staggered` | 67,71 | 8 × 430 mm | 0,0081 | 0,0191 |
| ST_GANG_AUTOFILL_5LOAI | 22 | `maxrects_bbox` | 64,32 | 213 × 40 mm | 0,0029 | 0,0032 |
| ST_GANG_QUANTITY_5LOAI | 20 | `maxrects_bbox` | 76,65 | 31 × 456 mm | 0,0017 | 0,0020 |
| CNC_SR_AUTOFILL_TAMGIAC | 152 | `triangle_advanced` | 79,69 | 15 × 870 mm | 0,0180 | 0,0356 |
| CNC_SR_QUANTITY_DUPLEX | 152 | `triangle_advanced` | 79,69 | 15 × 870 mm | 0,0191 | 0,0272 |
| CNC_GANG_AUTOFILL_DUPLEX | 81 | `maxrects_bbox_cnc` | 59,78 | 570 × 22 mm | 0,0091 | 0,0095 |
| CNC_GANG_QUANTITY_1MAT | 77 | `maxrects_bbox_cnc` | 68,43 | 22 × 388 mm | 0,0126 | 0,0133 |
| GEO_INTERLOCK_CHU_L | 24 | `grid` | 53,49 | 8 × 430 mm | 0,0097 | 0,0191 |
| GEO_TAMGIAC_DOI_DAU | 36 | `triangle_advanced` | 72,56 | 18 × 430 mm | 0,0073 | 0,0141 |

Baseline **nhanh**: p50 từ 1,7 ms đến 19,1 ms, p95 ≤ 35,6 ms. Đây là mốc phải nhớ khi bàn ngân sách cho solver mới.

### 6.2. Kernel hiện hữu trên cùng hình học, profile `fast`, deadline 20 s

Cách đo: kernel giải **đúng một tờ** (`maxSheets = 1`) với quantity probe `= ceil(baseline × 1,3)`, nên `placedCount` của hai bên so được trực tiếp ở cùng số tờ. Số tờ cho intent quantity được **suy ra** bằng `ceil(tổng SL / con-mỗi-tờ)` — chính công thức đường sản xuất dùng.

| Ca | baseline | kernel | Δ | số tờ suy ra | giây | góc ≠ cardinal | termination |
|---|---:|---:|---:|---|---:|---:|---|
| ST_SR_AUTOFILL_TRON | 45 | 46 | **+2,2 %** | — | 20,01 | 0 | `deadline` |
| ST_SR_QUANTITY_TRON | 45 | 46 | **+2,2 %** | 112 → 109 | 20,04 | 0 | `deadline` |
| ST_GANG_AUTOFILL_5LOAI | 22 | 23 | **+4,5 %** | — | 1,77 | 18 | `max_sheets_reached` |
| ST_GANG_QUANTITY_5LOAI | 20 | 21 | **+5,0 %** | 290 → 277 | 1,46 | 0 | `max_sheets_reached` |
| CNC_SR_AUTOFILL_TAMGIAC | 152 | 84 | **−44,7 %** | — | 3,84 | 81 | `work_budget_exhausted` |
| CNC_SR_QUANTITY_DUPLEX | 152 | 84 | **−44,7 %** | 20 → **36** | 3,77 | 81 | `work_budget_exhausted` |
| CNC_GANG_AUTOFILL_DUPLEX | 81 | 86 | **+6,2 %** | — | 11,26 | 0 | `work_budget_exhausted` |
| CNC_GANG_QUANTITY_1MAT | 77 | 82 | **+6,5 %** | 45 → 42 | 5,65 | 0 | `work_budget_exhausted` |
| GEO_INTERLOCK_CHU_L | 24 | 24 | **0,0 %** | — | 6,69 | 0 | `work_budget_exhausted` |

Validator trả `valid = true` ở toàn bộ các lượt hoàn thành. Peak RSS của cả tiến trình đo: 58–60 MB ở mọi lượt — kernel không phải nguồn áp lực RAM ở cỡ này.

### 6.3. Quét profile trên ba ca then chốt

| Ca | baseline | `fast` | `balanced` | `tight` |
|---|---:|---|---|---|
| GEO_INTERLOCK_CHU_L | 24 | 24 (0 %, 6,7 s, 0 góc lẻ) | **27 (+12,5 %, 23,7 s, 25 góc lẻ)** | **29 (+20,8 %, 86,5 s, 28 góc lẻ)** |
| CNC_SR_AUTOFILL_TAMGIAC | 152 | 84 (−44,7 %, 3,8 s) | 77 (−49,3 %, 6,8 s) | 77 (−49,3 %, 15,9 s) |
| GEO_TAMGIAC_DOI_DAU | 36 | 32 (−11,1 %) | 32 (−11,1 %, 4,4 s) | 33 (−8,3 %, 12,8 s) |

### 6.4. Phép đo quyết định: cardinal so với góc tự do

Cột "góc ≠ cardinal" ở §6.2 gợi ra một câu hỏi làm đổi toàn bộ phạm vi dự án: **lãi ở nhánh gang đến từ "xếp theo hình thật" hay từ "góc tự do"?** Nếu là cái trước thì đường render hiện hữu (`isRotated`/`isRotated180`) đã đủ và **không phải chạm chín điểm affine ở §3.5**.

Đo bằng cách chạy cùng corpus, cùng seed, cùng profile `balanced`, cùng deadline 25 s, chỉ đổi `orientationPolicy.defaultRotation` giữa `discrete [0,90,180,270]` và `free`:

| Ca | baseline | **cardinal** | **free** | Cardinal giữ được | Góc tự do thêm giá trị? |
|---|---:|---:|---:|---:|---|
| ST_SR_AUTOFILL_TRON | 45 | 46 (+2,2 %) | 46 (+2,2 %) | 100 % | KHÔNG |
| ST_SR_QUANTITY_TRON | 45 | 46 · 112→109 tờ | 46 · 112→109 tờ | 100 % | KHÔNG |
| ST_GANG_AUTOFILL_5LOAI | 22 | 23 (+4,5 %) | 23 (+4,5 %) | 100 % | KHÔNG |
| ST_GANG_QUANTITY_5LOAI | 20 | **24 (+20,0 %) · 290→242 tờ** | 22 (+10,0 %) · 290→264 tờ | **200 %** | **KHÔNG — free còn TỆ HƠN** |
| CNC_SR_AUTOFILL_TAMGIAC | 152 | 77 (−49,3 %) | 77 (−49,3 %) | — | KHÔNG |
| CNC_SR_QUANTITY_DUPLEX | 152 | 77 · 20→39 tờ | 77 · 20→39 tờ | — | KHÔNG |
| CNC_GANG_AUTOFILL_DUPLEX | 81 | 86 (+6,2 %) | 86 (+6,2 %) | 100 % | KHÔNG |
| CNC_GANG_QUANTITY_1MAT | 77 | 82 (+6,5 %) · 45→42 tờ | 82 (+6,5 %) · 45→42 tờ | 100 % | KHÔNG |
| GEO_INTERLOCK_CHU_L | 24 | 24 (0 %) | **27 (+12,5 %)** | **0 %** | **CÓ** |

**8 trên 9 ca: cardinal bằng hoặc tốt hơn góc tự do.** Đúng một ca — hình lõm interlock — góc tự do thắng.

Và cardinal còn **nhanh hơn** ở mọi ca:

| Ca | cardinal | free | Nhanh hơn |
|---|---:|---:|---:|
| ST_GANG_AUTOFILL_5LOAI | 3,92 s | 6,38 s | 1,6× |
| ST_GANG_QUANTITY_5LOAI | 3,43 s | 5,86 s | 1,7× |
| CNC_GANG_QUANTITY_1MAT | 10,29 s | 13,15 s | 1,3× |
| CNC_GANG_AUTOFILL_DUPLEX | 14,47 s | 20,19 s | 1,4× |
| GEO_INTERLOCK_CHU_L | 6,44 s | 24,61 s | **3,8×** |

Hai chi tiết đáng ghi riêng:

1. **`ST_GANG_QUANTITY_5LOAI`: cardinal 24 con, free 22 con.** Góc tự do làm kết quả **xấu đi** 8,3 % so với cardinal. Cùng cơ chế với LO0-3: miền góc liên tục nở không gian tìm kiếm, trong cùng `evaluation_budget` solver tìm ra phương án tệ hơn. Chênh lệch quy ra tờ là thật — 242 tờ so với 264 tờ trên đơn 5.800 con.
2. **Trong 5 ca, `free` tự hội tụ về pose cardinal (0 góc lẻ)** — ST_SR_TRON cả hai intent, CNC_SR_TAMGIAC cả hai intent, CNC_GANG cả hai intent. Miền góc rộng hơn không mua được gì mà vẫn phải trả bằng thời gian.

### 6.5. Đọc số này ra kết luận gì

**Giá trị có thật, và nó nằm ở hai chỗ:** nhánh gang (baseline là MaxRects theo bbox) cho `+4,5 %` đến `+6,5 %`, và hình lõm interlock cho `+12,5 %` đến `+20,8 %`. Với đơn 290 tờ, `+5 %` là bớt 13 tờ giấy — thật, đo được, không phải quảng cáo.

**Nhưng ở nhánh S&R hình có solver chuyên biệt thì kernel thua rõ.** `triangle_advanced` xếp 152 con/tờ; kernel xếp 77–84 ở cả ba profile. Đó là **−44,7 %** ở lượt tốt nhất. Đáng chú ý: kernel dùng 81 góc không-cardinal và vẫn thua — free-angle không tự động tốt hơn một heuristic đã hiểu hình.

**Tem tròn gần như hoà, nhưng đắt gấp 2.200 lần.** `+2,2 %` (45 → 46 con) đổi bằng 20 s so với 0,009 s. Ở tỉ giá đó, `+2,2 %` không đáng cho preview.

**Và toàn bộ phần lãi đó lấy được mà không cần góc tự do** (§6.4). Góc tự do chỉ chứng minh được giá trị trên một họ hình duy nhất: contour lõm kiểu interlock. Đây là kết luận có sức nặng nhất của Lô 0, vì chín điểm affine ở §3.5 — phần đắt và rủi ro nhất của cả kế hoạch — chỉ tồn tại để phục vụ góc tự do.

---

## 7. Khoảng trống bằng chứng và rủi ro

### P1 — chặn phát hành, phải giải trước khi bật cho người dùng

| ID | Phát hiện | Bằng chứng |
|---|---|---|
| LO0-1 | **Release gate "placedCount không kém baseline" hiện KHÔNG đạt** ở S&R hình tam giác: 152 → 77…84 (−44,7 % … −49,3 %) ở cả ba profile | §6.2, §6.3 |
| LO0-2 | **Gate "strict improvement trên fixture interlock" không đạt ở `fast`** (24 = 24, 0 góc lẻ). Chỉ đạt từ `balanced` | §6.3 |
| LO0-3 | **Profile không đơn điệu theo chất lượng**: tam giác `fast` 84 > `balanced` 77. Nguyên nhân cấu trúc: effort mỗi trial tăng (orientation 12→32, beam 4→8, refine 2→6) mà `evaluation_budget` chỉ 30k→100k, nên `balanced` hoàn thành **ít** trial hơn `fast`. Xác định vẫn đúng; "profile cao hơn = tốt hơn" thì sai | §6.3, `control.rs:424-450` |
| LO0-4 | **Nạp SL sản xuất thẳng vào kernel là dịch sai bài toán.** `targetQuantity = 5000` ⇒ 5.000 instance ⇒ 111 tờ; pha baseline một mình đã nổ deadline và PyO3 trả `MIXED_NESTING_CANCELLED` **không kèm manifest nào**. Đường sản xuất dựng **một** template rồi nhân (`nup_engine.py:1925-1927`). Adapter phải map `quantity_fulfillment` về bài toán một tờ | lượt đo đầu, §4 |
| LO0-5 | **`SolveError::InterruptedBeforeAnyResult` làm mất cả baseline.** Baseline chưa xong mà hết deadline thì job trả lỗi cứng, trái kế hoạch §8 ("emergency timeout chỉ chọn completed barrier hoặc baseline") | `multi_start.rs:106-110` |
| LO0-6 | **Không có deadline thì `fast` chạy > 150 s** trên 57 instance tròn 24 đỉnh. Bảng 30k/100k/300k (⇒ 3/10/31 s) được hiệu chỉnh trên chữ nhật; với hình nhiều đỉnh nó không còn đúng | lượt đo đầu |
| LO0-7 | **Kernel không nhận worker/RAM grant.** `plan_hardware()` tính rồi chỉ dùng cho admission; `solve(request_json)` không có tham số nào. Và `multi_start::solve` tuần tự nên grant hiện cũng chưa có gì để cấp | §3.7 |
| LO0-8 | **`_WHOLE_MACHINE_SLOTS = BoundedSemaphore(1)`** ⇒ hợp đồng benchmark "2 heavy job đồng thời" của kế hoạch §10 không khả thi như đang viết | §3.7 |
| LO0-16 | **Góc tự do không phải nguồn của lãi.** 8/9 ca cardinal ≥ free; 1 ca cardinal **hơn** free 8,3 %; 5 ca free tự hội tụ về pose cardinal. Chỉ contour lõm interlock cần góc tự do. Nghĩa là chín điểm affine ở §3.5 — phần đắt và rủi ro nhất của kế hoạch — hiện chưa có lãi để biện minh | §6.4 |
| LO0-17 | **Miền góc liên tục cũng không đơn điệu**, cùng cơ chế LO0-3: cùng `evaluation_budget`, miền rộng hơn cho kết quả tệ hơn (`ST_GANG_QUANTITY_5LOAI` 24 → 22 con, 242 → 264 tờ) | §6.4 |

### P2 — phải quyết nhưng không chặn Lô 1

| ID | Phát hiện |
|---|---|
| LO0-9 | `terminationReason: max_sheets_reached` là lý do trả về cho một ca autofill hoàn toàn hợp lệ (`maxSheets = 1`, probe > sức chứa). Đọc như thất bại. Cần `layoutIntent` để phân biệt "tờ đã đầy" với "chạm trần số tờ" |
| LO0-10 | **NEST-11 xác nhận là thật:** `cnc_layout._materialize_sheet` (`:205-271`) luôn recenter (`−min_x/−min_y` rồi `+x_pad/y_pad`) và **không tham chiếu `exclude_zones`** ở bất kỳ dòng nào. Test `test_cnc_mirror_and_exclude.py:104-112` chỉ assert `overall_w/h ≤ usable`. Không có test nào kiểm placement sau recenter có đè boong |
| LO0-11 | **Dấu canh 2 mặt CNC không phải obstacle.** `cnc_marks.draw_duplex_marks` vẽ 4 dấu tại 4 điểm giữa cạnh, cách mép 3 mm; không có tham chiếu nào từ `cnc_layout`/`pont_collision` tới `cnc_marks`. Tem sát cạnh có thể đè dấu canh, không test nào phủ. Ca `OBS_DAU_CANH_CNC` trong corpus là ca đầu tiên phủ nó |
| LO0-12 | **Hai quy ước lỗ khoét đang xung đột.** Kernel coi hole là vật liệu đặc khi collision/score (`model.rs:504-505`); pipeline clip **cố ý bỏ lỗ** để không clip mất artwork trong cửa sổ khuôn (`nup_clip_shape:120-140`). Kế hoạch §9 lại ghi clip **even-odd** trong khi code hiện là **nonzero** (`pdf_ops.py:606-620`). Ba nơi, ba cách hiểu |
| LO0-13 | `cncFlipEdge` map cứng `'short' → mirror dọc`, mọi giá trị khác → mirror ngang, **không so `sheet_w` với `sheet_h`**. Tờ đặt ngang thì nhãn "cạnh dài/ngắn" không còn tương ứng cạnh vật lý |
| LO0-14 | Kế hoạch §12 Lô 9 thiếu `imposition_core/src/model.rs` (enum `GridStrategy` ts-rs) và file generated tương ứng |
| LO0-15 | Audit report có đường dẫn stale `sticker_layout/` (thật: `sticker_imposer_pkg/`) |

### Điều Lô 0 KHÔNG chứng minh được

- Chưa dựng artifact PDF thật để soi raster/parse. Mọi kết luận về clip, artwork, CUT và parity mặt sau vẫn là kết luận **đọc code**, chưa phải bằng chứng artifact.
- Chưa chạy trên PDF sản xuất thật (mục `nguonSanXuatThat` của corpus là danh sách yêu cầu, chưa có file). Số ở §6 là trên hình học tổng hợp.
- Chưa đo cancel SLA thực tế (ca `CANCEL_SLA` cần harness gọi kernel trên thread riêng — chưa dựng).
- Chưa đo hai heavy job đồng thời, vì §3.7 cho thấy hợp đồng đó phải định nghĩa lại trước.

---

## 8. Đề xuất chờ duyệt

### 8.1. Compactness metric

**Giữ** tiêu chí 3 hiện có: diện tích AABB đã dùng của tờ cuối (`last_sheet_used_area_fixed`).

**Đổi** tiêu chí 4. Hiện là `wasted_within_envelope` (tổng diện tích bỏ không trong bbox). Đề xuất thay bằng cặp, so theo thứ tự:

1. `maxFreeRectMm2` — diện tích hình chữ nhật trục chuẩn **lớn nhất còn lồng được** vào phần dư của tờ. **Lớn hơn là tốt hơn.**
2. `soManhDuHuuDung` — số thành phần liên thông của phần dư có diện tích ≥ diện tích bbox của part nhỏ nhất trong job. **Nhỏ hơn là tốt hơn.**

Lý do lấy từ số đo: ở cùng 45–46 con, baseline để lại dải **8 × 430 mm** (3.440 mm², một dải mỏng vô dụng) còn kernel để lại **35 × 430 mm** (15.050 mm², chạy được đơn khác). Phần trăm diện tích không phân biệt được hai thứ đó. Mẫu tương tự ở CNC: 15 × 870 so với 48–55 × 870.

Cách tính: rasterize phần dư ở lưới **1 mm** bằng tâm ô, rồi maximal-rectangle-in-histogram — O(W×H), xác định, không phụ thuộc thứ tự hình học. Ngưỡng "mảnh hữu dụng" suy từ chính job nên không có hằng số ma thuật. Bản cài đặt tham chiếu đã có ở `scripts/lo0_nesting_baseline.py::max_inscribed_rect_mm2`.

Tăng `SCORE_VERSION` khi áp.

### 8.2. Ngưỡng strict improvement cho fixture interlock

Số đo: `fast` 0 %, `balanced` +12,5 %, `tight` +20,8 %.

Đề xuất gate: **`placedCount` ≥ baseline × 1,10** trên `GEO_INTERLOCK_CHU_L` ở **profile mặc định của sản xuất**. Kéo theo một hệ quả bắt buộc: **profile mặc định không được là `fast`**.

### 8.3. Hash precision và canonical serialization

- Số thực: mm và độ serialize bằng đúng 6 chữ số thập phân (`{:.6}`). Khớp `SCORE_LENGTH_QUANTUM_MM = 1e-6`, `SCORE_ANGLE_QUANTUM_DEG = 1e-6` và `DEFAULT_LINEAR_TOL_MM = 1e-6` đã có — không thêm hằng số mới.
- `-0.0` normalize về `0.0`. `NaN`/`Inf` bị contract validate từ chối (đã có).
- Thứ tự field: khoá sort tăng theo byte UTF-8.
- Thứ tự ring: `outer` trước, `holes` sau; mỗi ring bắt đầu tại đỉnh nhỏ nhất theo `score::bottom_left_order` đã có; `outer` CCW, hole CW (`normalize.rs::Winding` đã có).
- Hash: SHA-256, hex chữ thường.
- `layoutFingerprint = sha256(inputHash ‖ strategyId ‖ solverConfigHash ‖ 16 version tag đã tồn tại ‖ geometryConstraintsHash)`. Không phát minh version mới: `MIXED_NESTING_{PROTOCOL,ENGINE,VALIDATOR,TOLERANCE,CANONICALIZATION}_VERSION`, `NORMALIZE_RULE_VERSION`, `REFERENCE_POINT_RULE_VERSION`, `KERNEL_VERSION`, `NFP_RULE_VERSION`, `SCORE_VERSION`, `SOLVER_VERSION`, `MULTI_START_VERSION`, `BASELINE_VERSION`, `CANDIDATE_RULE_VERSION`, `REFINE_RULE_VERSION` đều đã có trong code.

### 8.4. Tolerance

Hai tầng, phải nói rõ để không ai nhầm:

| Tầng | Giá trị | Nguồn |
|---|---|---|
| Hình học kernel | `linear 1e-6 mm`, `angular 1e-9°`, `MATRIX_TOL 1e-9`, `AREA_REL_TOL 1e-9` | `model.rs:99,103`; `transform.rs:40,44` — **giữ nguyên**, đã có test phủ |
| Parity preview ↔ artifact | `0,1 mm` / `0,01°` | `imposition_parity.py` mặc định — **giữ nguyên** |

Thêm một quy tắc: `affineMm` là **derived**, và validator reject nếu `‖affineMm − dựng_lại_từ(pose)‖∞ > 1e-9`. Tolerance tiếp tục **không** nằm trong request (nếu client đặt được thì `tight` nới được correctness).

### 8.5. Search budget và emergency timeout

Trước khi chốt số, phải sửa LO0-3 (không đơn điệu). Đề xuất:

1. Nâng `evaluation_budget` sao cho profile cao hơn **luôn** hoàn thành ≥ số trial của profile thấp hơn. Đề xuất khởi điểm `balanced: 100_000 → 250_000`, `tight: 300_000 → 750_000`, giữ nguyên `fast`. Con số này **phải đo lại** sau khi sửa; đó là việc của Lô 2, không phải chốt cứng hôm nay.
2. Profile mặc định sản xuất: **`balanced`** (bắt buộc bởi §8.2).
3. Emergency timeout wall-clock: **preview 20 s**, **submit/export 60 s**.
4. Sửa LO0-5: hết deadline thì **luôn** trả best-so-far đã validate, tối thiểu là baseline. Kèm chốt cứng: **baseline phải chạy xong trước khi deadline có hiệu lực** — baseline không nạp evaluation budget nên nó hữu hạn, và nếu mất baseline thì mất luôn sàn an toàn.

### 8.6. Cancel SLA

**≤ 1 s** từ lúc gọi cancel tới khi job về `cancelled`, đo tại checkpoint — khớp mục tiêu đã ghi trong `control.rs`. Cancel **không** tạo final manifest, không tạo artifact. Cần thêm checkpoint trong vòng NFP dài (hiện checkpoint ở đầu mỗi trial và trong refine; ca 20 s không dừng giữa trial sẽ vượt SLA).

### 8.7. p50 / p95 / RAM

Mốc baseline hiện tại: p50 1,7–19,1 ms, p95 ≤ 35,6 ms (bỏ warm-up).

Đề xuất ngưỡng cho strategy mới, đo trên corpus này, máy ≥ 16 GB:

| Đường | p50 | p95 |
|---|---|---|
| Preview | ≤ 2 s | ≤ 5 s |
| Submit / export | ≤ 15 s | ≤ 30 s |

RAM: peak RSS **thêm** so với baseline ≤ **300 MB/job** trên máy ≥ 16 GB. Máy `<8 GB` và `<16 GB` giảm bằng cách **hạ profile** (`tight → balanced → fast`) và giảm grant, **không** thu hẹp miền góc và **không** hard-cap vô điều kiện. Điều kiện tiên quyết: sửa LO0-7 để kernel thật sự nhận grant.

Con số đo được ở §6 nói rằng ngưỡng preview 2 s **hiện chưa đạt** cho ca tem tròn (20 s vẫn chưa hội tụ). Hai lối ra, cần chọn: (a) preview dùng profile thấp hơn submit, hoặc (b) preview không dùng strategy mới mà chỉ hiện kết quả sau khi submit. Đề xuất (a).

### 8.8. Năm câu hỏi sản phẩm

1. **Phạm vi hiển thị option.** Số đo cho thấy kernel thua rõ ở S&R hình có solver chuyên biệt (tam giác −44,7 %, tròn +2,2 % nhưng chậm 2.200×). Chọn:
   - **(a)** Chỉ hiện `true_shape_nesting` ở nhánh **gang** (cả tem và CNC) và ở S&R khi hình là `CUSTOM`/lõm. Hẹp hơn kế hoạch nhưng mọi ô hiển thị đều có lãi đo được.
   - **(b)** Hiện ở cả 4 flow đúng như kế hoạch, dựa baseline guard để tự fallback. Đúng kế hoạch nhưng người dùng chọn option mới rồi nhận kết quả của option cũ mà không hiểu tại sao.
   Khuyến nghị **(a)** cho lần bật đầu, mở rộng sang (b) khi solver vượt được `triangle_advanced`.

6. **Miền góc của lần bật đầu (câu quan trọng nhất, thêm sau phép đo §6.4).** Chọn:
   - **(a)** Khoá `rotationConstraint = discrete [0,90,180,270]`. Thu 100 % phần lãi đo được ở 8/9 ca, nhanh hơn 1,3–3,8×, và **không chạm một điểm nào** trong chín điểm affine ở §3.5. Validator chặn cứng góc ngoài tập, nên an toàn renderer được chứng minh bằng **cấu trúc** chứ không bằng lời cam kết.
   - **(b)** Mở `free` ngay theo kế hoạch. Trả toàn bộ chi phí chín điểm affine + parity mặt sau + test artifact góc lẻ, để đổi lấy lãi chỉ chứng minh được trên một họ hình (interlock lõm), và ở một ca còn **lỗ** 8,3 % so với cardinal.
   Khuyến nghị **(a)**. Mở `free` sau, và chỉ cho riêng nhánh contour lõm, khi Chặng B đóng được khoảng cách chất lượng.
2. **Dấu canh 2 mặt CNC** có thành fixed obstacle không (LO0-11)? Nếu không thì phải ghi thành hạn chế đã biết trong tài liệu phát hành.
3. **Lỗ khoét:** xác nhận V1 **không** nesting vào hole, đồng thời **vẫn in** artwork trong lỗ (LO0-12)?
4. **Fill rule của clip:** giữ **nonzero + bỏ lỗ** như code hiện tại, hay chuyển sang **even-odd** như kế hoạch §9 ghi? Đổi sang even-odd sẽ clip mất artwork trong cửa sổ khuôn — đó là lý do code hiện tại cố ý làm ngược.
5. **Ngân sách và profile mặc định** theo §8.5, kèm chấp nhận rằng `tight` mất tới 86,5 s trên ca interlock.

---

## 9. Kết luận và lô tiếp theo

**Trạng thái: CHỜ DUYỆT.** Không PASS, không ROLLBACK — Lô 0 không sửa gì để mà rollback.

### 9.1. Đề xuất tái cấu trúc thành ba chặng có cổng đo

Phép đo §6.4 đổi hẳn cấu trúc dự án: phần đắt nhất của kế hoạch (góc tự do xuyên renderer) không phải phần sinh lãi, còn phần sinh lãi thì rẻ hơn nhiều. Đề xuất gộp 11 lô thành ba chặng, mỗi chặng có cổng đo riêng và chặng sau chỉ mở khi chặng trước qua cổng.

**Chặng A — true-shape cho gang, KHOÁ GÓC CARDINAL.**
Phạm vi: option `true_shape_nesting` chỉ hiện ở `taskMode = nup` của `sticker_imposer` và `cnc_imposer`; `rotationConstraint = discrete [0,90,180,270]`; cả hai intent. Validator chặn cứng góc ngoài tập.
Kèm bốn việc phải làm dù đi đường nào: `layoutIntent` + ngữ nghĩa một-tờ-rồi-nhân (chặn LO0-4); `fixedObstacles` cho boong/nhíp/dấu canh (sửa luôn LO0-10 và LO0-11); manifest + `layoutFingerprint` + preview và export dùng chung **một** lần solve; baseline guard có provenance.
Thu về: giảm 4,5–20 % số tờ ở nhánh gang, đo được. Chạm **zero** trong chín điểm affine — `pdf_ops.show_pdf_page`, cache key clip, duplex toggle, `pont_collision.get_item_polygon` đều không đổi. Đây là lý do rủi ro hồi quy gần bằng không.
Cổng ra: trên corpus, `placedCount` ≥ baseline ở **cả 4 ô gang**, zero overlap/clearance/obstacle/boundary violation, preview và export cùng `manifestId`, và số lần solve preview→export = 1.

**Chặng B — chất lượng solver, không tích hợp gì.**
Phạm vi đóng trong `imposition_core`. Mục tiêu: vượt `triangle_advanced` (LO0-1), làm profile đơn điệu (LO0-3), làm miền góc đơn điệu (LO0-17), sửa `InterruptedBeforeAnyResult` (LO0-5).
Cổng ra: kernel ≥ baseline trên **cả 10 ca** corpus, và ≥ +10 % trên `GEO_INTERLOCK_CHU_L` ở profile mặc định, và `tight ≥ balanced ≥ fast` ở mọi ca, và `free ≥ cardinal` ở mọi ca.
Trước khi cổng này xanh, **không mở option cho nhánh S&R** — mở ra là giao cho thợ in một lựa chọn xếp kém hơn 44 %.

**Chặng C — góc tự do, chỉ khi B xanh.**
Lúc đó mới chi cho chín điểm affine, CTM của `pdf_ops`, parity mặt sau, `gapX ≠ gapY` dị hướng, và test artifact ở 17° / 123,456° / 359,999°.
Cổng vào: Chặng B đã chứng minh `free ≥ cardinal` ở mọi ca. Cổng ra: theo release gate của kế hoạch §13.

### 9.2. Nên bỏ khỏi phạm vi sớm

- **Immutable content-addressed render bundle.** Bản rẻ đạt phần lớn mức an toàn: lưu `layoutFingerprint` + sha256 nguồn cạnh manifest và reject khi lệch. Bundle đầy đủ để Chặng C.
- **`gapX ≠ gapY` dị hướng.** Là thay đổi hình học breaking (offset hiện là bo tròn, isotropic). Gang CNC hôm nay đã nén `gap = max(gapX, gapY)`, giữ nguyên không phải hồi quy. Để Chặng C, nơi nó thật sự có nghĩa.
- **Song song hoá multi-start (kế hoạch Lô 3A).** Một luồng đã cho 3,4–14,5 s ở gang với cardinal. Và `_WHOLE_MACHINE_SLOTS = BoundedSemaphore(1)` nghĩa là một job đã sở hữu cả máy. Đúng đắn trước, tốc độ sau.

### 9.3. Ba việc nhỏ nên làm ngay, không phụ thuộc duyệt

1. LO0-5 — `SolveError::InterruptedBeforeAnyResult` làm mất cả baseline. Thuần Rust, thuần robustness.
2. LO0-10 — `cnc_layout._materialize_sheet` recenter không recheck `exclude_zones`. Đây là bug sản xuất đang tồn tại, độc lập với nesting, và đã có ca corpus phủ.
3. LO0-15 — sửa đường dẫn stale `sticker_layout/` → `sticker_imposer_pkg/` trong audit report.

**Không bắt đầu Chặng A trước khi chủ sản phẩm duyệt §8.** Hai câu quyết định phạm vi là §8.8 câu 1 (flow nào được hiện option) và câu 6 (miền góc của lần bật đầu).
