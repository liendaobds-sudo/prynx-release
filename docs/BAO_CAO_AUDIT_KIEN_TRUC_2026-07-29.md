# BÁO CÁO AUDIT KIẾN TRÚC — PrynX (2026-07-29)

Phạm vi: kiến trúc tổng thể — ranh giới tầng (desktop / FastAPI sidecar / Rust), tính một-nguồn-chân-lý
của các engine, hợp đồng API xuyên tầng, cấu hình & build, vệ sinh mã. **Không** audit hình học khuôn bế,
hiệu năng chi tiết hay UI/UX (đã có báo cáo riêng trong `docs/`).

Tiêu chí: `AGENTS.md` (6 quy tắc bất di bất dịch) + skill `prynx-architecture`, `prynx-audit-workflow`,
`prynx-performance`, `prynx-conventions`.

Trạng thái: **Giai đoạn 2 — chờ duyệt.** Chưa sửa file nào.

---

## 1. Tóm tắt điều hành

Kiến trúc lõi đúng và có chủ đích: 3 tầng rõ, phần cực nặng đã đẩy xuống Rust, dieline có
một-nguồn-chân-lý thật sự (bundle TS nhúng vào Rust, chạy bằng Boa), chính sách parity Rust/Python
fail-fast, security posture ở `main.py` chặt (tắt OpenAPI trên binary, CORS hẹp, ký truy cập
`/results/`, thoát code 48 khi port bị zombie chiếm). `tsc --noEmit` sạch tại thời điểm audit.

Vấn đề tập trung ở **ranh giới tầng phía backend/API**, không ở phân tầng lớn:

| # | Vấn đề đầu bảng | Mức |
|---|---|---|
| §A.1 | Route béo — `imposition.py` 4.126 dòng, 18 endpoint, 79 import trong hàm; trái nguyên tắc "route mỏng, engine ở `core/`" | P1 |
| §A.2 | Không có hợp đồng API: 127 endpoint / chỉ 24 `response_model`; ~45 pydantic model rải trong route; 26 file component tự `fetch` bỏ qua `lib/api.ts` | P1 |
| §C.1 | `AGENTS.md` rule #3 dẫn `PDFIUM_PY_LOCK` — symbol **không tồn tại** trong repo; serialize PDFium hiện chỉ là hệ quả gián tiếp của trần job = 1 | P1 |
| §C.3 | `nup_engine` mở worker theo `cpu_count-1` **không gate RAM** (máy yếu không được bảo vệ), trong khi trần job lại hard-cap vô điều kiện (máy mạnh không được nới) | P1 |
| §B.1 | Grid solver tồn tại 4 bản; đường output đã hợp nhất về backend (Task 11) nhưng bản TS còn sống cho booklet, không có parity test | P2 |

Ghi nhận điểm mạnh cần **giữ nguyên** (mục 6) để đợt sửa không phá.

---

## 2. Phát hiện theo nhóm

### §A — Ranh giới tầng

> **ĐÍNH CHÍNH (khi thực thi lô 9)** — phần "349 import trong hàm là dấu hiệu vòng phụ thuộc bị
> lách" **chỉ đúng một phần**. Kiểm thật: không module nào trong 26 module mà `imposition.py` import
> lười lại import ngược về nó (chỉ `core/edit_session.py` ↔ `routes/edit.py` có vòng thật). Nhưng
> nhiều module đó rất nặng (`pont_collision`/shapely, `die_detection`, `sticker_imposer_pkg`,
> `nup_engine`) nên đây là **lazy-load có chủ đích**: chuyển lên mức module sẽ bắt mọi lần khởi động
> sidecar trả giá dù người dùng không bình tem. Giữ nguyên. Việc rút logic khỏi route vẫn cần làm
> nhưng phải có spec riêng — xem `docs/KIEN_TRUC_FIXES_2026-07-29.md` lô 9.

**§A.1 (P1, effort L) — Route béo, engine nằm trong route.**
`prynx-architecture` quy định "backend route mỏng, engine nặng nằm ở `backend/app/core/`".
Thực tế:

| File | Dòng | Endpoint | `from app.` import bên trong hàm |
|---|---|---|---|
| `backend/app/api/routes/imposition.py` | 4.126 | 18 | 79 |
| `backend/app/api/routes/pdf_tools.py` | 1.888 | — | 43 |
| `backend/app/api/routes/preflight.py` | 1.622 | — | 31 |
| `backend/app/api/routes/edit.py` | 1.404 | — | — |

Toàn backend: **349** import nội bộ đặt trong thân hàm so với **280** ở mức module
(`backend/app/**/*.py`). Import-trong-hàm ở mức này là dấu hiệu vòng phụ thuộc bị lách, đồng thời
làm đồ thị phụ thuộc vô hình với công cụ phân tích tĩnh.

Bằng chứng bổ sung — logic nghiệp vụ trong route: `imposition.py:1831-1870`, `:2701-2710`,
`:2996-3020`, `:3208-3230`, `:3475-3495`, `:3970-3990` đều tự gọi
`nup_layout_solver.solve_optimal_layout` và tự lắp nhánh cluster/ratio-stack ngay trong handler.

Rủi ro: mỗi lần đổi quy tắc layout phải sửa cùng lúc trong route và trong `nup_engine.py` (3.711
dòng) — đúng loại lệch đã sinh ra hàng loạt comment "preview phải KHỚP output" trong chính file này
(`imposition.py:1847-1848`).

**§A.2 (P1, effort M) — Hợp đồng API không được cưỡng chế.**
- 127 endpoint (`^@router\.(get|post|put|delete|websocket)` trong `backend/app/api/routes/`), chỉ
  **24** khai `response_model=` → hơn 100 endpoint trả dict thô.
- `backend/app/schemas/` chỉ có 538 dòng (`edit.py` 340, `job.py` 102, `vdp.py` 71,
  `imposition.py` 25) trong khi ~45 `class ...(BaseModel)` được khai báo rải rác trong file route
  (`preflight.py` ~25 model, `edit.py` ~12, `imposition.py` 2, `qc.py` 3, `export.py` 1).
- Phía desktop: `lib/api.ts` 997 dòng viết tay; **26/239** file trong `desktop/src/components/` tự
  gọi `getApiUrl()`/`authenticatedFetch` trực tiếp (vd `workspace/LivePageFrame.tsx:990,1194,1440`,
  `workspace/CropDialog.tsx:284,396,440`, `OutputPreviewTab.tsx:359`,
  `preprocess-tools/FontToolsTool.tsx:81`), so với 33 file dùng `lib/api`.

Đây chính là rủi ro mà skill đã cảnh báo ("hai đầu không có codegen chung, lệch là lỗi runtime im
lặng") — hiện chưa có cơ chế nào bắt lệch tự động.

**§A.3 (P2, effort S) — Hai thư mục state song song.**
`desktop/src/store/` (2 store: `useBoxStore`, `useMockupStore`) và `desktop/src/stores/`
(10 file: `useWorkspaceStore`, `useAuthStore`, `appSettingsStore`…). Đếm import: 32 lượt từ
`store/`, 56 lượt từ `stores/`. Skill cũng buộc phải liệt kê cả hai. Người mới (và agent) đoán sai
chỗ đặt store mới là chắc chắn.

### §B — Một-nguồn-chân-lý của engine

> **ĐÍNH CHÍNH (khi thực thi lô 11)** — "đường booklet tính layout bằng TS" mô tả chưa chính xác.
> Booklet có **engine TS riêng** (`GeometricSolver` + `VirtualMap` + `SpreadPlacer` →
> `InstructionSerializer` sinh instruction set → backend `plan_executor` thực thi) — kiến trúc "client
> lập kế hoạch, server dựng", không phải bản trùng của solver Rust. Rủi ro thật hẹp hơn: bản TS được
> `ProductAdvisor` dùng để trả lời "1 tờ mấy con" cho người dùng. Đã thêm parity test bắc cầu qua
> fixture dùng chung — **12/12 case `simple_auto` khớp**, tức con số tư vấn hiện đang đúng.

**§B.1 (P2, effort M) — Grid solver N-up có 4 hiện thân.**

| Bản | File | Dòng | Vai trò hiện tại |
|---|---|---|---|
| Rust core | `imposition_core/src/grid.rs` | 415 | nguồn chân lý |
| PyO3 wrapper | `native/src/imposition/grid_solver.rs` | 94 | vỏ mỏng — OK |
| Python | `backend/app/workers/nup_layout_solver.py:114` `_py_solve_optimal_layout` | ~120 | fallback có kiểm soát |
| TypeScript | `desktop/src/lib/imposerEngine/NupGridSolver.ts` | 1.517 | còn sống cho booklet |

Phần đã làm tốt: `nup_layout_solver.py:16-63` fail-fast khi thiếu Rust, chỉ cho fallback Python qua
`IMPOSITION_ALLOW_PY_FALLBACK=1` kèm cảnh báo và `backend/tests/parity/KNOWN_DIVERGENCES.md`.
`processHandlers.ts:75-77` ghi rõ Task 11 đã đưa **mọi** job N-up (xén + bế) về backend.

Phần còn hở: bản TS vẫn được `NupRenderer.ts:4`, `MarksRenderer.ts:18`, `ProductAdvisor.ts:9,17,164`,
`processHandlers.ts:77` dùng, tức đường **booklet** vẫn tính layout bằng TS trong khi export đi
Rust — và không có parity test nào cho cặp này (`__test_hex_parity.ts` chỉ so TS ↔ JSX cũ, không so
với Rust). `imposition_core/src/grid.rs:1-4` tự khai "giữ NGUYÊN VẸN để bảo toàn parity", nhưng
điều đó chỉ được test cho Python.

**§B.2 (điểm mạnh, nên nhân rộng) — dieline làm đúng SSOT.**
`native/src/dieline_engine.rs:1-20` nhúng bundle TS do `build.rs` sinh và chạy bằng Boa
(`PRYNXRAW1`/`PRYNXENC1`), `backend/app/api/routes/dieline.py:20` giữ một thread Boa warm. Một bản
mã, hai môi trường chạy. Đây là mô hình nên áp cho §B.1 (booklet) thay vì port thủ công.

**§B.3 (P2, effort M) — Sinh PDF tồn tại cả ở webview.**
`desktop/package.json` mang 6 thư viện PDF/vẽ: `pdf-lib`, `pdfjs-dist`, `react-pdf`, `jspdf`,
`@pdfme/generator`, `svg2pdf.js`; cộng `desktop/src/lib/pdfImposer.ts` (881 dòng) tự lắp trang.
`processHandlers.ts:506-560` đã phải đặt `FE_SIZE_LIMIT = 50MB` và bắt `RangeError` vì pdf-lib
ngốn RAM 3-4× kích thước file trong WebView. Kết luận: đường ghi PDF phía frontend là nợ kỹ thuật
đang được rào bằng heuristic, không phải bằng ranh giới kiến trúc.

### §C — Bất biến dự án vs thực tế (drift tài liệu ↔ mã)

**§C.1 (P1, effort S–M) — `PDFIUM_PY_LOCK` không tồn tại.**
`AGENTS.md` rule #3: "Mọi truy cập native ↔ pypdfium2 phải qua `PDFIUM_PY_LOCK` trong
`backend/app/core/rust_bridge.py`". Kiểm chứng:
- grep `PDFIUM_PY_LOCK` trên `backend/app`, `native/src`, `docs`, `.agents` → **0** kết quả.
- `git log -S "PDFIUM_PY_LOCK" --all -- backend/app/core/rust_bridge.py` → **rỗng** (chưa từng tồn tại).
- `rust_bridge.py` chỉ có `PDFIUM_DLL_PATH` (dò dll), không có khóa nào.
- `native/src/*.rs`: không có `Mutex`/`OnceLock` nào quanh PDFium.
- 19 file backend `import pypdfium2` (routes `edit/export/imposition/preflight`, core
  `channel_remover/geometry_reader/layer_engine/outline_fonts/page_boxes/pdf_processor/rust_bridge/separations/softproof`,
  workers `nup_engine/pdf_ops/pdf_tools_engine/sticker_engine/vdp_engine/vdp_preview`).

Thực tế hiện an toàn **một cách tình cờ**: việc nặng chạy `ProcessPoolExecutor`/
`multiprocessing.Process` (mỗi process một PDFium riêng), còn trần job mặc định = 1
(`PRYNX_MAX_NUP_JOBS`, `PRYNX_MAX_COMPARE_JOBS`, `PRYNX_MAX_VDP_JOBS`, `PRYNX_MAX_STICKER_JOBS`).
Nhưng `imposition.py:4091-4094` có `ThreadPoolExecutor(max_workers=workers)` cho nesting, và bất kỳ
ai nâng một biến `PRYNX_MAX_*_JOBS` lên >1 sẽ mất serialize mà **không có gì chặn**. Đề xuất: hoặc
tạo khóa thật đúng như rule mô tả, hoặc sửa rule để nói đúng cơ chế đang bảo vệ (process isolation +
trần job) và ghi rõ điều kiện được phép nới trần.

**§C.2 (P2, effort S) — Router chết.**
`backend/app/api/routes/report.py` khai `router = APIRouter()` và endpoint
`@router.get("/jobs/{job_id}/report")` (dòng 123) nhưng **không** được `include_router` ở
`main.py` và không nơi nào import; grep `api/report` phía desktop → 0.
Ngoài ra `prynx-architecture` liệt kê `report.py` trong bản đồ route như thể đang phục vụ.

> **ĐÍNH CHÍNH (khi thực thi lô 1)** — bản đầu của báo cáo này viết thêm rằng `report.py` là nơi
> duy nhất dùng `reportlab` nên nên bỏ `reportlab==4.2.0`. **Sai.** Grep gốc dùng brace-glob
> `backend/**/*.{py,txt,toml}` mà ripgrep không mở rộng → gần như không match gì. Người dùng thật
> của reportlab: `workers/vdp_engine.py`, `workers/nup_report.py`,
> `workers/cut_export/emitters/pdf_spot.py`, `core/layer_engine.py`, `core/stream_editor.py` và
> ~18 file test. **reportlab phải giữ.** Bài học: không dùng brace-glob trong includePattern; xác
> minh "dependency chết" bằng grep trên danh sách file tường minh.

**§C.3 (P1, effort M) — RAM-gating không đồng nhất (rule #1 lệch cả hai chiều).**
Làm đúng: `workers/sticker_engine.py:1376-1454` (`_auto_sticker_hw_profile` phân tier RAM),
`core/print_engine/facade.py:126-159` (<8GB / <16GB / ≥16GB), `api/routes/pdf_tools.py:49,77`,
`workers/realesrgan_engine.py:353`.

Lệch chiều "máy yếu không được bảo vệ": `workers/nup_engine.py:3217-3233` lấy
`available_cores = cpu_count-1` rồi mở `ProcessPoolExecutor` bằng số đó (`:3333`) — **không đọc RAM
lần nào**. Mỗi worker là một process pikepdf giữ PDF trong RAM; máy 8GB/16 lõi vào job bình lớn là
đường ngắn nhất tới OOM. `preflight_engine.py:212` cũng chỉ gate theo CPU (`cpu_count-1`, trần 8).

Lệch chiều "máy mạnh bị kìm": `core/heavy_job_scheduler.py:18-21` hard-cap
`PRYNX_MAX_HEAVY_JOBS=2` vô điều kiện; các trần job = 1 ở `routes/imposition.py:998`,
`routes/compare.py:27`, `routes/vdp.py:55`, `routes/pdf_tools.py:38` cũng vô điều kiện. Lưu ý khi
sửa: `max_active_heavy_jobs()` đang được dùng để **chia ngân sách RAM** cho từng slot, nới trần mà
không tính lại ngân sách sẽ phá đúng lớp bảo vệ đó — phải sửa cặp.

> **ĐÍNH CHÍNH (khi thực thi lô 5)** — phần "trần job = 1 kìm máy mạnh" **sai**. Mỗi job nup/VDP/tem
> đã tự trải hết lõi bên trong (`ProcessPoolExecutor` theo `cpu_count`, `_auto_sticker_hw_profile`
> tới 6 process), nên trần 2 job = ~2×(cpu−1) process cùng giữ PDF trong RAM → oversubscribe, TỔNG
> thông lượng giảm. Trần 1 là thiết kế đúng; đã ghi chú lý do tại chỗ thay vì nới.
> Chỉ `PRYNX_MAX_HEAVY_JOBS=2` là hằng số thật cần gate — đã gate chiều xuống cho máy `<8 GB`; nới
> lên cho máy mạnh vẫn treo lại chờ đo, vì slot này phục vụ đúng các feature từng bị treo (upscale,
> COM/LibreOffice).

### §D — Cấu hình & build

> **ĐÍNH CHÍNH (khi thực thi lô 10)** — effort **KHÔNG phải M**. `run_dev.bat`,
> `build_production.ps1` và `release_update.ps1` gõ cứng `desktop\src-tauri\target\{debug,release}`
> (installer NSIS, exe để hash), `release_update.ps1` còn regex-sửa `desktop\src-tauri\Cargo.lock`,
> và CI cố tình quét đúng 4 lockfile. Workspace dồn `target/` về gốc + xoá lockfile con → vỡ cả đường
> phát hành, phải kiểm bằng một bản cài thật. Đã làm phương án chặn đúng rủi ro với chi phí gần bằng
> không: `scripts/check_cargo_lock_skew.py` + bước CI (lệch minor/major crate hình học = chặn merge).

**§D.1 (P2, effort M) — Không có Cargo workspace, 4 lockfile độc lập.**
`desktop/src-tauri/Cargo.lock`, `native/Cargo.lock`, `imposition_core/Cargo.lock`,
`print_engine/Cargo.lock`. Lệch đã xuất hiện: `serde` **1.0.228** (src-tauri, imposition_core) vs
**1.0.229** (native, print_engine). `imposition_core` là crate dùng chung của cả `native` (PyO3) và
`desktop/src-tauri` (`lib.rs:1335` gọi `imposition_core::grid::solve_optimal_layout`) → hai bên có
thể build cùng logic trên hai nền dependency khác nhau, và cùng một crate bị biên dịch lại 4 lần.
Ràng buộc phải giữ khi gộp: **không** đưa `[profile.release]`/LTO vào Cargo.toml (rule #2 — LTO chỉ
qua `CARGO_PROFILE_RELEASE_*` trong `build_production.ps1`). Hiện chỉ có `[profile.dev]` ở
`src-tauri/Cargo.toml:63` — đúng rule.

**§D.2 (P2, effort S) — Núm điều chỉnh không có registry.**
44 tên biến `PRYNX_*` khác nhau, đọc `os.environ` ở 65 chỗ trong `backend/app`, trong khi
`backend/app/config.py` chỉ khai 16 field và `.env.example` chỉ nhắc 4 biến `PRYNX_*`. Tài liệu duy
nhất mô tả các trần job nằm rải trong 3 báo cáo audit cũ (`docs/audit/PERFORMANCE_*`,
`BAO_CAO_AUDIT_UPSCALE_TREO_*`). Hệ quả: người vận hành không biết có núm nào, và §C.3 (nới/hạ trần)
không có chỗ để ghi quyết định.

**§D.3 (P3, effort S) — `desktop/package.json` dùng dải `^` cho toàn bộ dependency.**
Có `package-lock.json` (274 KB) nên build hiện tại tái lập được; chỉ nên siết pin cho các thư viện
ảnh hưởng hình học/xuất file (`pdf-lib`, `pdfjs-dist`, `three`, `clipper-lib`) để nâng cấp không
lặng lẽ đổi kết quả golden.

### §E — God file (P2, effort L, làm dần)

| File | Dòng | Ghi chú |
|---|---|---|
| `desktop/src/components/workspace/LivePageFrame.tsx` | 4.141 | vừa render vừa gọi 5 endpoint backend |
| `backend/app/api/routes/imposition.py` | 4.126 | xem §A.1 |
| `backend/app/core/stream_editor.py` | 3.713 | |
| `backend/app/workers/nup_engine.py` | 3.711 | |
| `backend/app/workers/sticker_engine.py` | 3.252 | |
| `desktop/src/components/ImpositionTab.tsx` | 2.990 | |
| `desktop/src/components/imposition-tools/sections/GridPreview.tsx` | 2.528 | |
| `desktop/src/components/preprocess-tools/DataMergeTool.tsx` | 2.486 | |
| `desktop/src-tauri/src/lib.rs` | 2.298 | 19 `#[tauri::command]` + shell logic |
| `desktop/src/App.tsx` | 1.746 | giữ mọi tab mounted (bất biến đã biết) |

`print_engine/src/.../interp.rs` (3.597) là trình thông dịch PostScript/PDF — độ dài hợp lý cho
loại mã này, không xếp vào nhóm cần tách.

### §F — Vệ sinh repo (P3, effort S)

Thư mục/file rác còn trong cây làm việc: `backend/_atm2`, `backend/_atm4`, `backend/_audit_tmp2`,
`backend/debug`, `backend/temp`, `backend/node_modules`, `backend/t.txt`, `backend/ocr_raw.txt`,
`backend/ocr_pre.txt`, gốc repo `_to_delete`, `terminals`, `tmp`. Kiểm tra `git ls-files`: tất cả
đều **untracked** (chỉ `attic` 5 file và `data` 24 file được theo dõi) → không bẩn lịch sử, chỉ gây
nhiễu khi grep/khảo sát và làm chậm chính các lệnh quét của agent.

---

## 3. Quick-win (làm được ngay, rủi ro thấp)

1. **§C.1** — Chốt sự thật về khóa PDFium: sửa `AGENTS.md` rule #3 cho khớp cơ chế thật, hoặc tạo
   khóa thật trong `rust_bridge.py`. Đây là rule bị mọi agent đọc đầu tiên; sai là sai lan.
2. **§C.2** — Xóa `routes/report.py` + bỏ `reportlab==4.2.0` khỏi `requirements.txt`, cập nhật bản
   đồ route trong `prynx-architecture`.
3. **§D.2** — Thêm `docs/CAU_HINH_ENV.md` liệt kê 44 biến `PRYNX_*` (mặc định, phạm vi, ai đọc), bổ
   sung vào `.env.example`.
4. **§A.3** — Gộp `desktop/src/store/` vào `stores/` (2 file, 32 import — sửa cơ học, `tsc` bắt hết).
5. **§F** — Dọn thư mục rác cục bộ + thêm vào `.gitignore` những mục còn thiếu.

## 4. Đề xuất thứ tự sửa theo lô (≤5 file/lô, backend → desktop → Rust)

| Lô | Nội dung | File | Verify |
|---|---|---|---|
| 1 | §C.1 + §C.2: chốt rule PDFium, xóa router chết | `AGENTS.md`, `.agents/skills/prynx-architecture/SKILL.md`, `routes/report.py`, `requirements.txt` | `py_compile` + import app; `scripts/sync_ai_skills.ps1` |
| 2 | §C.3a: RAM-gate worker pool bình bản | `workers/nup_engine.py`, `core/preflight_engine.py`, `core/system_memory.py` | pytest `backend/tests` (nup + preflight), chạy thử 1 job bình trên máy thật |
| 3 | §C.3b: trần job theo RAM + ngân sách RAM theo slot (đi cặp) | `core/heavy_job_scheduler.py`, `routes/imposition.py`, `routes/compare.py`, `routes/vdp.py`, `routes/pdf_tools.py` | pytest + đo lại thời gian 1 job trên máy ≥16GB (chống hồi quy máy mạnh) |
| 4 | §D.2: registry env | `docs/CAU_HINH_ENV.md`, `.env.example`, `app/config.py` | đọc lại, không đổi hành vi |
| 5 | §A.3 + §F: gộp store, dọn rác | `desktop/src/store/*` → `stores/`, `.gitignore` | `npm run typecheck`, `npm run test` |
| 6 | §A.2 bước 1: bọc contract cho nhóm endpoint nóng nhất (imposition + preflight) bằng `response_model` + gom model về `schemas/` | 5 file/lô, chia nhiều lô | pytest + `npm run typecheck` |
| 7 | §A.1: rút logic layout khỏi `routes/imposition.py` sang `core/imposition_engine.py`, chuyển import-trong-hàm về mức module theo từng cụm | nhiều lô, mỗi lô ≤5 file | pytest + golden bình bản; **cần duyệt riêng** vì chạm đường xuất file |
| 8 | §D.1: gộp Cargo workspace (giữ rule #2 — không `[profile.release]`) | 4 `Cargo.toml` + 1 `Cargo.lock` | `cargo check` cả 4 crate, `maturin develop --release`, build thử `build_production.ps1` |
| 9 | §B.1: parity test TS ↔ Rust cho booklet, rồi quyết định thu hẹp/bỏ `NupGridSolver.ts` | `NupGridSolver.ts` + test mới | `npx vitest run src/lib/imposerEngine` |

Lô 7, 8, 9 chạm đường xuất file / build phát hành → xin duyệt lại trước khi vào từng lô.

## 5. Phát hiện thêm (ngoài phạm vi, chỉ ghi nhận)

- `backend/app/core/print_engine/facade.py` (Python) trùng tên với crate Rust `print_engine/` — dễ
  gây nhầm khi đọc log/stack trace. Đổi tên là việc cơ học nhưng chạm nhiều import → để đợt riêng.
- `main.py` import router hai đợt: 4 router ở đầu file, 8 router bằng `from app.api.routes import ...`
  giữa thân file (dòng ~232). Không sai, nhưng khiến "có bao nhiêu router" khó đọc.
- `desktop/src/lib/imposerEngine/__test_hex_parity.ts` là script chạy tay (`npx tsx`), không nằm
  trong `vitest run` → không ai biết khi nó vỡ.
- `desktop/src/components/` 239 file với nhiều file >900 dòng nằm cùng cấp thư mục tính năng; nên có
  quy ước trần dòng cho component mới (`lint:budget` đã có hạ tầng để cưỡng chế).

## 6. Điểm mạnh — không được phá trong đợt sửa

- `main.py`: tắt `/docs|/redoc|/openapi.json` trên binary compiled, CORS cố tình hẹp và **không**
  đọc `settings.CORS_ORIGINS`, middleware ký truy cập `/results/`, lưới an toàn bind port → exit 48.
- `nup_layout_solver.py`: chính sách Rust-bắt-buộc + fail-fast + `KNOWN_DIVERGENCES.md`.
- `heavy_job_scheduler.max_active_heavy_jobs()` được dùng để chia ngân sách RAM theo slot.
- Dieline SSOT qua Boa (`native/src/dieline_engine.rs`), kèm khoá engine theo license ở bản phát hành.
- Hạ tầng test: `backend/tests/{golden,parity,preflight_golden,vdp}`, `desktop` vitest +
  `nativeFixtureParity.test.ts`, `lint:budget`.
- `tsc --noEmit -p tsconfig.app.json` sạch (chạy trên Windows thật, 2026-07-29).

---

## Cách kiểm chứng lại báo cáo này

```powershell
# §A.1/§E — dòng & import trong hàm
Get-ChildItem -Recurse -File -Include *.py backend\app | ForEach-Object { "{0,6} {1}" -f (Get-Content $_.FullName).Count, $_.Name } | Sort-Object -Descending | Select-Object -First 10
(Get-ChildItem -Recurse -File -Include *.py backend\app | Select-String -Pattern "^\s+(from app\.|import app\.)").Count

# §A.2 — endpoint vs response_model
$r = Get-ChildItem -Recurse -File -Include *.py backend\app\api\routes
($r | Select-String -Pattern "^@router\.(get|post|put|delete|websocket)").Count
($r | Select-String -Pattern "response_model=").Count

# §C.1 — khóa PDFium
git log --oneline -S "PDFIUM_PY_LOCK" --all -- backend/app/core/rust_bridge.py   # rỗng

# §D.1 — lệch lockfile
Select-String -Path native\Cargo.lock,desktop\src-tauri\Cargo.lock -Pattern 'name = "serde"' -Context 0,1
```
