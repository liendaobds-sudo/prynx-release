# PPE RE-AUDIT — NHẬT KÝ SỬA THEO LÔ

**Báo cáo gốc:** `docs/BAO_CAO_AUDIT_TOAN_BO_PPE_2026-08-10.md`  
**Ngày bắt đầu sửa:** 2026-08-10  
**Nguyên tắc:** mỗi lô tối đa 5 file; verify xong và chờ nghiệm thu trước khi sang lô tiếp theo; không build/maturin/installer khi chưa được duyệt riêng.

## Lô 1 — §PPE.REAUDIT.2 — Flatten/PDF-X-1a mixed-page

**Trạng thái:** `AUTO + ARTIFACT đạt; RUNTIME UI chờ xác nhận`  
**File thay đổi trong lô:** 3

1. `backend/app/core/pdf_actions_native.py`
2. `backend/tests/test_no_ghostscript_survival.py`
3. `docs/PPE_REAUDIT_FIXES_2026-08-10.md`

### Baseline đã xác minh

- Input ba trang chỉ có transparency ở trang 2–3.
- Bản cũ trả `flattened=3`; trang 1 mất vector và bị thay bằng `/FlatIm`.
- PDF/X-1a gọi cùng `flatten_transparency`, nên kế thừa mất mát.
- Artifact baseline: `.tmp/ppe-reaudit-mixed-flatten-vector-result.json`.

### Thay đổi

- `flatten_transparency()` lấy một lần bản đồ `_detect_transparency_by_page()`.
- Chỉ trang nằm trong tập transparency mới được gửi vào PPE và thay content bằng ảnh CMYK.
- Trang đục không render lại, không mất chữ/path vector.
- Giữ nguyên cảnh báo raster/Spot và hành vi fail-loud hiện có.
- Gắn tag truy vết `CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.2)`.
- Thêm regression ba trang cho cả Flatten trực tiếp và PDF/X-1a:
  - đúng 2 trang raster;
  - trang 1 còn toán tử vector và không có `/FlatIm Do`;
  - trang 2–3 có `/FlatIm Do`;
  - source SHA-256 không đổi;
  - output hết transparency;
  - số trang giữ nguyên;
  - PDF/X-1a vẫn đạt compliance nội bộ.

### Verify

- `py_compile` hai file: đạt.
- Pytest hẹp `-k "flatten or pdfx1a"`: **6 passed**, 23 deselected, 1 warning Pydantic.
- Pytest regression bốn file liên quan: **68 passed**, 1 warning Pydantic.
- `git diff --check` hai file code/test: đạt.
- Chạy lại artifact audit thật:
  - `source_unchanged=true`;
  - `transparent_pages_before=[2,3]`;
  - `flattened=2`;
  - `transparent_pages_after=[]`;
  - `page1_vector=true`;
  - `page1_flat_image=false`;
  - `flat_content_by_page=[false,true,true]`.
- Output chẩn đoán: `.tmp/ppe-reaudit-mixed-flatten-vector-output-after-fix.pdf`.

### Chưa chạy

- Chưa build/maturin/installer theo chỉ đạo.
- Chưa bấm Flatten và xuất PDF/X-1a trên Tauri UI; cần chủ dự án nghiệm thu trước khi sang Lô 2 theo workflow audit.

## Lô 2 — §PPE.REAUDIT.1 — First-frame thật và bootstrap ưu tiên trang đầu

**Trạng thái:** `AUTO + BENCH đạt; RUNTIME-PARTIAL`  
**File thay đổi trong lô:** 4

1. `desktop/src-tauri/src/pdf_color_risk.rs`
2. `desktop/src-tauri/src/lib.rs`
3. `.tmp/runtime-smoke/cold-warm-open-smoke.mjs`
4. `docs/PPE_REAUDIT_FIXES_2026-08-10.md`

### Baseline đã xác minh

- Bootstrap cũ gọi detector màu toàn bộ tài liệu trước khi mount Viewer.
- Smoke cũ chỉ kiểm `<img>.complete`, kích thước ảnh và CSS; hai ảnh từng được ghi là
  “sharp” tại `1909/1944 ms` thực tế không có pixel nội dung trong vùng trang.
- Claim cũ `1.909/1.944 ms` vừa sai gate compositor vừa sai cách ghi đơn vị; không dùng
  làm bằng chứng hiệu năng.

### Thay đổi

- Bootstrap quét chính xác màu/resources của trang 1 ngay trong lần parse `lopdf` đã có.
- Các trang chưa quét được đánh dấu bảo thủ `highRisk=true` và
  `accurateColorRecommended=true`; vì Viewer áp detector theo từng trang, trang 1 RGB vẫn
  đi display lane nhanh, còn trang 1 CMYK/DeviceN/Spot/Transparency đi thẳng PPE và không
  lóe PDFium sai màu.
- Summary bootstrap được lưu riêng trong `bootstrap_color_risk`; cache full
  `color_risk` vẫn là `None` cho tới pha metadata nền. Không thể ghi nhầm kết quả tạm
  thành kết quả toàn tài liệu.
- `viewer_bootstrap_in_process()` không còn gọi `get_or_load_cached_document_with_color_risk()`.
  Pha metadata nền sau first-frame vẫn quét đầy đủ và thay summary tạm như cũ; contract JSON
  không đổi nên không cần sửa `usePdfLoader`.
- Smoke cold/warm chỉ chụp khi có tile đang hiện thật, crop đúng mặt trang, giải mã screenshot
  compositor bằng `Image + canvas`, đo range/variance/dark/chromatic pixel và yêu cầu hai frame
  pixel liên tiếp ổn định. `firstVisibleMs` và `sharpMs` không còn được ghi từ DOM-only.
- Harness đưa trang CDP ra foreground và chờ hai animation frame trước khi đo. Nếu không,
  WebView có thể giữ DOM/blob đúng nhưng chưa composite surface vì cửa sổ kiểm thử nằm nền.
- Gắn tag truy vết `PERF/RUNTIME (audit 2026-08-10 §PPE.REAUDIT.1)`.

### Verify

- `cargo fmt --check`: đạt.
- Regression detector màu: **4 passed**; ca mới khóa trang 1 RGB + trang 2 CMYK, bootstrap
  chỉ biết thật trang 1 và full analyzer nhận đúng CMYK trang 2.
- Regression tách cache bootstrap/full: **1 passed**.
- Toàn bộ Tauri lib: **128 passed, 5 ignored**, không có failure; hai warning dead-code đã có.
- `cargo check` Tauri: đạt; 7 warning dead-code hiện hữu, không có warning mới từ Lô 2.
- `node --check .tmp/runtime-smoke/cold-warm-open-smoke.mjs`: đạt.
- Frontend typecheck: đạt.
- Regression Viewer tập trung 4 file: **66 passed**.
- `git diff --check` hai file Rust: đạt.
- Benchmark trên `CMNM2026 - Giay moi_BLUE - in.pdf` (4 trang, 5 mẫu):
  - bootstrap mới: median **36,61 ms**;
  - đường full/legacy: median **40,83 ms**;
  - pha hydrate full nền: median **40,92 ms**;
  - riêng đường bootstrap nhanh hơn khoảng **10,3%**. Đây là số đo metadata/open nội bộ,
    không được diễn giải thành thời gian pixel đọc được của UI.
- Hai lượt chẩn đoán không foreground được giữ làm bằng chứng sửa harness, không tính là
  latency ứng dụng: một lượt mất `26,12 s`; lượt khác DOM báo tile sắc và blob PNG đúng
  (`488 969 byte`, canvas đầy đủ màu) nhưng screenshot compositor vẫn trắng đồng nhất.
- Giả thuyết tab nền bị loại: 16 request `purpose=background` khớp trực tiếp URL thumbnail
  “Mở gần đây” tại `RecentFiles/ThumbnailView.tsx`, không phải `LivePageFrame` của tab nền.
  Hunk thử nghiệm `suspendViewer` đã được gỡ, không giữ tối ưu không có bằng chứng.
- Runtime pixel hợp lệ trên cửa sổ foreground, đúng PDF khách:
  - cold: `firstVisible=1941 ms` (1,94 giây), `sharp=2285 ms` (2,29 giây), 11 poll trắng;
  - warm: `firstVisible=2046 ms` (2,05 giây), `sharp=2419 ms` (2,42 giây), 12 poll trắng;
  - hai ảnh cùng signature pixel `5aee9a8d`, range luma `187`, variance `3008,02`;
  - **0** bad HTTP, **0** console error, hai lượt đều có 2 frame compositor ổn định;
  - ảnh cold/warm: `.tmp/runtime-smoke/09-cold-open-sharp.png` và
    `.tmp/runtime-smoke/10-warm-reopen-sharp.png`.

> Các số `1941/2285` và `2046/2419 ms` ở trên là lượt pixel-gate đầu của Lô 2.
> Lượt mới nhất dùng harness Lô 6 và là mốc canonical hiện tại: cold
> `4175/4670 ms`, warm `3971/4402 ms`. Vì phiên dev có nhiều process và chưa có
> P50/P95 sạch, bằng chứng chung chỉ được nâng tới `RUNTIME-PARTIAL`.

### Chưa chạy

- Chưa build production, maturin hoặc installer theo chỉ đạo.

## Lô 3 — §PPE.REAUDIT.3 — File-action cooperative cancel + atomic output

**Trạng thái:** `AUTO đạt; RUNTIME UI chờ rebuild`  
**File thay đổi trong lô:** 5

1. `backend/app/core/action_engine.py`
2. `backend/app/core/pdf_actions_native.py`
3. `backend/app/core/pdfx_export.py`
4. `backend/app/core/outline_text.py`
5. `backend/tests/test_ppe_concurrency_benchmark.py`

### Thay đổi

- Cancellation của coroutine được nối xuống worker sync bằng `threading.Event`; worker
  phải dừng và đóng file thật trước khi caller nhận lại `CancelledError`.
- Flatten, PDF/X và Outline kiểm token tại các checkpoint an toàn; pipeline dọn cả
  output trung gian khi hủy.
- Mọi file-action ghi vào `.pending.pdf` cùng volume, hậu kiểm PDF/số trang rồi mới
  `os.replace`; cancel/fail dọn cả staging và output đích.
- Caller không thể tráo token nội bộ qua params.

### Verify

- Regression cancel/atomic hẹp: **11 passed**.
- Nhóm Flatten/Outline/PDF-X: **78 passed, 17 skipped**.
- Nghiệm thu tổng cuối Lô 3–7 có lại toàn bộ các file này trong **261 passed** backend.

## Lô 4A — §PPE.REAUDIT.4 — Show filter đi tới plane PPE

**Trạng thái:** `AUTO + ARTIFACT đạt`  
**File thay đổi trong lô:** 5

1. `native/src/print_engine_py.rs`
2. `backend/app/core/print_engine/facade.py`
3. `backend/app/core/separations.py`
4. `backend/tests/test_ppe_facade.py`
5. `print_engine/tests/render_page.rs`

### Thay đổi

- `output_preview_filter` đi xuyên PyO3 → facade → separations và lọc ngay khi dựng
  `InkBuffer`; bitmap, plate và TAC cùng một tập object nguồn.
- `Show=All` giữ ABI/default native cũ và byte plate không đổi.
- Filter khác `all` trên native cũ fail-loud, không âm thầm trả plate chưa lọc.

### Verify

- Facade/separations: **50 passed** ở lượt hẹp.
- Rust filter: **43 passed** ở lượt hẹp; nghiệm thu cuối toàn `print_engine` đạt
  **642 passed, 4 ignored**.
- `cargo check` native và rustfmt đạt.

## Lô 4B — §PPE.REAUDIT.4 — UI/sampling/TAC/subset cùng filter identity

**Trạng thái:** `AUTO + ARTIFACT đạt; runtime current-source chờ rebuild`  
**File thay đổi trong lô:** 5

1. `backend/app/api/routes/preflight.py`
2. `backend/app/schemas/preflight.py`
3. `desktop/src/components/OutputPreviewTab.tsx`
4. `desktop/src/lib/outputPreviewSampling.test.ts`
5. `backend/tests/test_icc_and_color_preview.py`

### Thay đổi

- Route/schema truyền và echo filter; response cũ không thể bị dùng cho filter mới.
- Đổi Show refetch separations nhưng giữ panel ổn định; dữ liệu sampling/TAC bị vô hiệu
  ngay trong lúc chờ để không đọc nhầm plate cũ.
- `plateDataRef`, sampling, TAC heatmap và subset/solo đều lấy từ filtered planes.

### Verify

- Backend hẹp: **140 passed**; frontend hẹp: **24 passed**; typecheck đạt.
- Nghiệm thu tổng cuối: **261 passed** backend và **106 passed** frontend mục tiêu.

## Lô 5 — §PPE.REAUDIT.5 — Dùng chung document identity

**Trạng thái:** `AUTO đạt; benchmark/runtime panel chờ lượt sạch`  
**File thay đổi trong lô:** 5

1. `desktop/src/components/OutputPreviewHost.tsx`
2. `desktop/src/components/preprocess-tools/InkManagerTool.tsx`
3. `desktop/src/hooks/useWorkingPdf.ts`
4. `desktop/src/stores/useWorkspaceStore.ts`
5. `desktop/src/components/OutputPreviewHost.test.tsx`

### Thay đổi

- `selectionFileId` gắn identity gồm file revision + page order + rotations.
- Output Preview và Ink Manager tái sử dụng cùng ID khi identity khớp; chỉ materialize/
  upload Working PDF khi tài liệu thật sự khác.
- Metadata nhỏ của cùng `File` dùng `WeakMap`; không giữ byte PDF trong cache toàn cục.
- Shell Output Preview hiện ngay trong lúc chuẩn bị file, tránh cảm giác app reload/trắng.

### Verify

- `OutputPreviewHost`: **7 passed**; nhóm identity/useWorkingPdf/store: **12 passed**.
- Typecheck đạt; nghiệm thu tổng frontend mục tiêu **106 passed**.

## Lô 6 — §PPE.REAUDIT.1/6 — Harness runtime có pixel gate thật

**Trạng thái:** `W7-U04 = RUNTIME-PARTIAL; W7-U05 = AUTO + ARTIFACT`  
**File thay đổi trong lô:** 4

1. `.tmp/runtime-smoke/tauri-runtime-smoke.mjs`
2. `.tmp/runtime-smoke/cold-warm-open-smoke.mjs`
3. `docs/PRYNX_RENDER_ENGINE_FIXES_2026-08-08.md`
4. `docs/PRYNX_MASTER_AUDIT_MATRIX.md`

### Thay đổi và bằng chứng

- Cả hai harness đưa cửa sổ ra foreground, đo pixel vùng trang, yêu cầu hai frame
  compositor cùng signature; timeout bắt buộc làm smoke fail.
- Background signature được lấy trước action; không còn nuốt timeout rồi báo đạt.
- Lượt canonical mới trên PDF khách:
  - cold first-visible/sharp: **4175/4670 ms**;
  - warm first-visible/sharp: **3971/4402 ms**;
  - cùng signature `5aee9a8d`, `0` bad HTTP, `0` console error.
- Phiên dev có 10 `pdf-inspector`, 13 Node và 3 Python process nên đây không phải
  P50/P95 sạch. Các số lăn/zoom/pan/xoay và smoke Output Preview `42/42` cũ được
  hạ `STALE`; không dùng đóng acceptance.

### Verify

- `node --check` cả hai harness: đạt.
- Tài liệu render fixes và master matrix đã được sửa đồng nhất về đơn vị/trạng thái.

## Lô 7 — §PPE.REAUDIT.7/8 — Native provenance + corpus rollout gate

**Trạng thái:** `source/gate AUTO đạt; rollout data + installed vẫn OPEN`  
**File thay đổi trong lô:** 5

1. `native/build.rs`
2. `native/src/print_engine_py.rs`
3. `build_production.ps1`
4. `scripts/ppe_viewer_shadow_report.py`
5. `docs/VIEWER_ENGINE_CORPUS_2026-08-10.json`

### Thay đổi

- `ppe_capabilities()` công khai `source_revision`, `source_dirty`, build timestamp,
  profile, provenance và identity SHA-256; dev fallback được gắn `auto-git`.
- `build_production.ps1` pin identity cho đúng lượt maturin staging, đối chiếu wheel
  vừa build, từ chối revision không biết/mismatch; public release từ chối dirty và
  provenance không phải pipeline. Manifest ghi mapping identity + SHA-256 `.pyd`.
- Corpus lên schema 2 nhưng **giữ `engineModeGate=current`**. Gate yêu cầu mỗi trang
  5 cặp PPE–display ở 96 DPI, MAE RGB `≤5`, P95 PPE `≤650 ms`, không unsupported/error,
  đủ timing và một cặp artifact ổn định.
- Reporter nay bắt cả thiếu PPE lẫn thiếu display trong một `ready` observation; một
  lượt ready không còn che được lượt error/unsupported khác.

### Verify

- `py_compile` + reporter `--self-test`: đạt; self-test phủ missing pair, missing MAE,
  error, quá P95 và thiếu số mẫu.
- Manifest JSON parse/load đạt đủ **11 entry**; PDF khách khớp SHA-256; generated OCG/AP
  giữ đúng hash.
- Probe không có log shadow trả exit `1` và báo thiếu đúng **14/14 trang**; dữ liệu rỗng
  không thể làm gate pass hoặc promote engine.
- PowerShell parse đạt; probe gate xác nhận native cũ fail-loud và fake staged native
  đúng identity đi qua success path.
- rustfmt đạt; `cargo check --locked` native đạt. Build output dev ghi đúng commit
  `89a9048d1d5eb71d64171e8c9195782da064d36a`, `dirty=true`, profile `debug`,
  provenance `auto-git` và identity 64 hex.
- Native test harness compile được nhưng không chạy do Windows loader `0xc0000022` đã biết;
  không quy lỗi loader thành source failure.

### Cổng còn mở có chủ đích

- Chưa có log `PPE_SHADOW` thật đủ 5 cặp/trang; reporter sẽ trả gate fail nếu chạy ngay.
- Chưa có P50/P95/RSS trên máy vật lý `<8 / 8–15 / ≥16 GB`.
- Không promote `hybrid`; không build production/maturin/installer theo chỉ đạo.
- `§RENDER.11`, installed/clean-user và Lô 8 giữ nguyên `OPEN`.

## Nghiệm thu tổng Lô 3–7 — 2026-08-10

- TypeScript: đạt.
- Frontend mục tiêu: **15 file / 106 passed**.
- Backend mục tiêu: **261 passed**, 1 warning Pydantic hiện hữu.
- `print_engine`: **642 passed, 4 ignored**, 0 failed.
- Native: `cargo check --locked` đạt; test binary compile nhưng loader trả `0xc0000022`.
- Runtime harness: hai file `node --check` đạt; cold/warm pixel-gate hợp lệ.
- Shadow reporter, corpus JSON, PowerShell parse/gate probes: đạt.
- Không chạy production build, maturin, installer; không stage/commit và không đổi default
  Viewer khỏi `current`.
