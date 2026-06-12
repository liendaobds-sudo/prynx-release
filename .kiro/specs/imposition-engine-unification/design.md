# Design — Imposition Engine Unification

## Overview

Mục tiêu: gộp 5 bản layout-math về **một crate Rust thuần toán** (`imposition_core`), bọc bởi hai binding mỏng (PyO3 cho backend Python, Tauri cho client), tiêu thụ bởi hai assembler "ngu" (pikepdf cho job lớn/bế tem, pdf-lib cho job nhỏ) và preview. Hợp đồng dữ liệu sinh từ struct Rust để không còn field câm. State tách theo profile để hết rò rỉ. Rust là dependency cứng; fallback (nếu giữ) phải kêu to và nằm trong parity-CI.

Thiết kế tuân theo Requirements 1–10. Mỗi mục dưới ghi rõ requirement liên quan.

> **Cập nhật quyết định (B → A):** Khi triển khai G3 mới thấy rõ phương án B (assembler client tự tính) buộc phải port cả tầng selection/scoring/collision sang Rust client — quá lớn. Chuyển sang **A**: mọi job N-up/bế tem **và** preview đều đi **backend** (đã chạy qua `imposition_core` solvers). Bỏ assembler client pdf-lib và xóa engine TS. Preview==output theo cấu trúc vì dùng chung một đường. Các mục "client pdf-lib" bên dưới không còn áp dụng; thay bằng "mọi job → backend".

---

## Architecture

### 1. Kiến trúc tổng thể (Req 1, 2)

```
                ┌─────────────────────────────────────────────┐
                │  imposition_core   (rlib, THUẦN Rust)         │
                │  - structs serde: LayoutInput/Output, Cell,   │
                │    Placement, MarkSeg, ImposeSettings         │
                │  - grid_solver, shape_solvers, sticker,       │
                │    nfp, orchestrator, assembler (math)        │
                │  KHÔNG phụ thuộc pyo3 / tauri / pdf           │
                └─────────────────────────────────────────────┘
                   ▲ depend                    ▲ depend
        ┌──────────┴───────────┐    ┌──────────┴────────────┐
        │ native/ (cdylib+pyo3)│    │ src-tauri/ (app)       │
        │ #[pyfunction] wrappers│    │ #[tauri::command] wrap │
        │ ↔ chuyển PyDict↔struct│    │ ↔ serde_json↔struct    │
        └──────────┬───────────┘    └──────────┬────────────┘
                   │ gọi từ Python              │ invoke() từ client
        ┌──────────┴───────────┐    ┌──────────┴────────────┐
        │ Backend assembler     │    │ Client assembler       │
        │ pikepdf (job lớn,     │    │ pdf-lib (job nhỏ)      │
        │ bế tem)               │    │ + Preview SVG          │
        └───────────────────────┘    └────────────────────────┘
```

### Cargo workspace
Tạo workspace gốc (hoặc dùng path deps) để cả hai crate cùng tham chiếu `imposition_core`:
- `imposition_core/` — `[lib] crate-type = ["rlib"]`, deps: `serde`, `geo`. KHÔNG có `pyo3`, `pdfium`, `tauri`.
- `native/` — giữ `cdylib + pyo3`, thêm dep `imposition_core = { path = "../imposition_core" }`. Các file trong `native/src/imposition/*` rút gọn còn wrapper.
- `desktop/src-tauri/` — thêm dep `imposition_core = { path = "../../imposition_core" }`. Xóa `pdf_engine/imposition.rs`, thay bằng gọi `imposition_core`.

> Lưu ý refactor cốt lõi: solver Rust hiện nhận `Bound<PyDict>`/trả `PyObject`. Phải đổi chữ ký lõi sang **structs Rust thuần** (`fn solve_optimal_layout(input: &LayoutInput) -> LayoutOutput`), rồi binding PyO3/Tauri chỉ làm việc chuyển đổi kiểu. Đây là phần công sức lớn nhất của thiết kế.

---

## Data Models

### 2. Hợp đồng dữ liệu có kiểu (Req 4)

Định nghĩa nguồn duy nhất trong `imposition_core` bằng struct serde:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct ImposeSettings {
    pub sheet_w_mm: f64, pub sheet_h_mm: f64,
    pub margins_mm: Margins,
    pub gap_x_mm: f64, pub gap_y_mm: f64,
    pub bleed_mm: f64,
    pub strategy: GridStrategy,        // enum: Manual{cols,rows} | SimpleAuto | OptimalAuto | ...
    pub align: Align,                  // enum
    pub duplex: Duplex,                // enum Normal | Double
    pub marks: Option<MarkConfig>,     // None = không vẽ mark
    pub pont: Option<PontConfig>,      // None = không pont
    pub tool: ToolKind,                // enum Nup | Sticker | ... (Req 6: khai báo tường minh)
    // ... các field cluster/diecut gom trong nhánh enum theo tool
}
pub struct LayoutOutput { pub sheets: Vec<Sheet>, pub capacity_per_sheet: usize, /*...*/ }
pub struct Placement { pub abs_x: f64, pub abs_y: f64, pub w: f64, pub h: f64, pub rot: Rotation, pub src_page: usize }
```

**Sinh type TS từ struct Rust** bằng `ts-rs` (hoặc `schemars` + json-schema → `json-schema-to-typescript`). Type sinh ra thay thế các interface tay trong `types.ts`. Khi đó:
- Field client gửi mà core không có → lỗi biên dịch TS (Req 4.2).
- `GridStrategy::Manual { cols, rows }` buộc cols/rows được engine đọc ở mọi đường (Req 4.3).
- Gỡ `@ts-nocheck` ở `types.ts`, `ImposerDashboard.tsx`, `NupSettingsSection.tsx`, `GridPreview.tsx`, `processHandlers.ts` (Req 4.4).

`marks: Option`/`pont: Option` + `tool: ToolKind` thay cho khóa cứng `isDieCut ? ...` rải rác (Req 6).

---

## Components and Interfaces

### 3. Luồng dữ liệu (Req 2, 3)

### 3a. Job nhỏ (cắt xén nhỏ) — client pdf-lib
1. UI build `ImposeSettings` từ profile active.
2. `invoke('compute_layout', settings)` → Tauri wrapper → `imposition_core` → trả `LayoutOutput` (placements tuyệt đối).
3. Client pdf-lib **chỉ nhúng trang** theo placements (Req 2.3). Không tính lại gì.

### 3b. Job lớn / bế tem — backend pikepdf
1. UI build `ImposeSettings`, gửi `/nup-start` (gộp, xem §6).
2. `nup_engine` gọi `imposition_core` qua PyO3 lấy placements.
3. pikepdf nhúng trang theo placements (Req 2.2).

### 3c. Preview (Req 3)
1. UI `invoke('compute_layout', settings)` — **cùng** đường 3a.
2. `GridPreview` vẽ SVG từ chính `LayoutOutput`, bỏ toàn bộ phần tự tính căn lề/lật trục hiện có (Req 3.2).
3. Duplex = double → tính placements cả 2 mặt và vẽ cả hai (Req 3.3).

Vì 3a/3b/3c cùng `imposition_core`, preview == output theo cấu trúc (Req 3.4, 2.4).

---

## 4. Assembler "ngu" (Req 2)

Định nghĩa một "Placement Protocol" mà cả hai assembler tuân theo: nhận `Vec<Placement>` (đơn vị point, gốc toạ độ PDF), với mỗi placement đặt trang nguồn `src_page` vào `(abs_x, abs_y)` xoay `rot`. Không có nhánh logic layout nào trong assembler.
- Backend: `nup_process_chunk` rút gọn — bỏ phần tính toạ độ, chỉ giữ phần pikepdf đặt XObject + vẽ mark theo `MarkSeg` core trả về.
- Client: module pdf-lib mới `placementRenderer.ts` thay phần tính của `NupRenderer.ts`.

---

## 5. State theo profile (Req 5, 6)

Tái cấu trúc `useImposerSettingsStore`:

```ts
interface ImposerState {
  activeTool: ToolKind;                 // MỘT nguồn duy nhất (Req 5.3)
  paper: PaperSettings;                 // dùng chung: formsize, sheet, margins, gripper, bleed
  profiles: {
    nup: NupProfile;
    sticker: StickerProfile;
    booklet: BookletProfile;
  };
  ui: UiState;                          // modal/collapse — tách khỏi cấu hình
}
```

- Component đọc qua selector của profile active: `useProfile(s => s.profiles[s.activeTool])`. Tool không thấy được field của tool khác (Req 5.2, 5.4).
- Bỏ `activeDashboardTool`/`activeTool` local/`taskMode` trùng vai → còn `activeTool` duy nhất; bỏ `prevNonStickerMode` band-aid (Req 5.3).
- Mỗi profile khai báo `supportsMarks`/`supportsPont` → build payload theo khai báo, không khóa cứng (Req 6).
- `persist`: bump version (v3), viết `migrate` ánh xạ state phẳng cũ → `{paper, profiles}`; preset đã lưu (`printauto_saved_forms`, marks config) giữ nguyên (Req 5.5).
- Xóa `getSerializableState`/`applyParsedState` sau khi luồng mới chạy (Req 9.4).

---

## 6. Backend: độ bền & dọn dẹp (Req 9)

- Gộp `/nup-start` + `/sticker-start` → `/impose-start` với field `tool` trong settings (Req 9.3). Giữ alias cũ tạm thời để không vỡ client trong lúc chuyển.
- Job store: thay `nup_jobs` dict in-memory bằng nguồn trạng thái duy nhất. Phương án tối thiểu: chuẩn hóa đọc/ghi qua file trạng thái (đã có `nup_state_*`) làm "single source", API chỉ đọc file; phương án mạnh: dùng Redis (đã có trong stack). Chọn file-based để giảm phụ thuộc, kèm cleanup (Req 9.1, 9.2).
- Cleanup: khi job completed/failed và sau khi client tải xong → xóa `nup_state_*`, `nup_prog_*`, file output tạm.
- Xóa dead code: `src-tauri/pdf_engine/imposition.rs`, `getSerializableState`, `applyParsedState`, biến chết trong `run_nup_engine` (Req 9.4).

---

## Correctness Properties

### Property 1: Một nguồn layout
Mọi placement layout đều xuất phát từ `imposition_core`; không tồn tại đường tính layout khác cho output.
**Validates: Requirements 1.1, 1.4, 1.5**

### Property 2: Hai assembler khớp nhau
Với cùng `LayoutOutput`, output của pikepdf và pdf-lib trùng hình học ≤ 0.5pt.
**Validates: Requirements 2.4**

### Property 3: Preview khớp output
Với cùng `ImposeSettings`, sức chứa và toạ độ ô của preview khớp output ≤ 0.5pt.
**Validates: Requirements 3.4**

### Property 4: Không field câm
Mọi field trong `ImposeSettings` client gửi đều được `imposition_core` đọc, kiểm bởi kiểu sinh.
**Validates: Requirements 4.2**

### Property 5: Không rò rỉ profile
Đọc/ghi profile của tool A không làm đổi profile tool B.
**Validates: Requirements 5.4**

### Property 6: Tất định
Cùng input → cùng output bất kể Rust hay fallback; nếu không thể đảm bảo thì fail-fast.
**Validates: Requirements 7.2, 8.4**

## Error Handling

### 7. Fail-fast & fallback (Req 7)

- Binding PyO3/Tauri: nếu `imposition_core` lỗi → trả lỗi tường minh; KHÔNG nuốt sang nhánh khác.
- `rust_bridge`-style `try/except: pass` ở đường layout bị loại bỏ cho phần layout-math (giữ cho phần render/OCG không liên quan).
- Nếu giữ fallback Python `_py_*`: bọc cờ `IMPOSITION_ALLOW_PY_FALLBACK` (mặc định off ở production), log `WARNING` rõ mỗi lần dùng, và parity-CI bắt buộc so khớp (Req 7.3). Khuyến nghị: đặt Rust là bắt buộc, fallback chỉ để debug.

---

## Testing Strategy

### 8. Parity & Golden tests (Req 8, 10)

- `tests/golden/`: tập file PDF mẫu (tem tròn, chữ nhật, hex, N-up nhiều mẫu, 1-dao, cluster) × bộ settings cố định.
- Golden runner: chạy qua engine → so output (số ô/tờ + toạ độ từng ô, ngưỡng ≤0.5pt; tùy chọn so checksum render trang).
- Gom `test_verify_rust_parity.py`, `test_hex.py`, `test_layout.py` vào `tests/parity/` (Req 8.3).
- Parity-CI chạy 2 chế độ: Rust bật và `IMPOSITION_ALLOW_PY_FALLBACK` (ép Python) → kết quả trùng ngưỡng (Req 8.4).
- Guard "một bản triển khai": test/lint quét sự tồn tại của solver layout ngoài `imposition_core` (ví dụ grep cấm import `NupGridSolver` trong đường output) (Req 1.6).

---

## 9. Kế hoạch di trú theo giai đoạn (Req 8 trước tiên)

Mỗi giai đoạn deploy + revert độc lập, đối chiếu golden tests.

1. **G0 — Lưới an toàn:** dựng golden + gom parity suite (Req 8). Chưa đổi engine.
2. **G1 — Tách lõi:** tạo `imposition_core` rlib, chuyển math từ `native/src/imposition/*` sang structs thuần; `native/` thành wrapper PyO3. Backend hành vi giữ nguyên (đối chiếu golden).
3. **G2 — Hợp đồng kiểu:** sinh TS types từ core; gỡ `@ts-nocheck`; sửa field câm (markThickness/markStyle, cols/rows manual) (Req 4).
4. **G3 — Tauri binding + client tiêu thụ:** `src-tauri` dùng `imposition_core`, hoàn thiện `compute_layout` command; `GridPreview` + assembler client gọi core; xóa `NupGridSolver`/math TS + `pdf_engine/imposition.rs` (Req 1.3, 1.4, 2, 3).
5. **G4 — Fail-fast/fallback policy** (Req 7).
6. **G5 — State profiles** (Req 5, 6).
7. **G6 — Backend dọn dẹp** (Req 9).

---

## 10. Thành phần & file ảnh hưởng (tham chiếu)

- Rust: `imposition_core/*` (mới), `native/src/imposition/*` (→ wrapper), `desktop/src-tauri/src/pdf_engine/imposition.rs` (xóa), `desktop/src-tauri/src/lib.rs` (`compute_layout`/`solve_layout`).
- Backend Python: `nup_engine.py`, `nup_process_chunk.py`, `nup_layout_solver.py` (→ gọi core/fallback policy), `routes/imposition.py` (gộp endpoint, job store).
- Client TS: `useImposerSettingsStore.ts` (profiles), `ImposerDashboard.tsx` (execute handler), `sections/GridPreview.tsx` (vẽ từ core), `lib/imposerEngine/NupRenderer.ts`+`NupGridSolver.ts` (→ placementRenderer ngu), `lib/processHandlers.ts`, `types.ts` (type sinh).

---

## 11. Rủi ro & giảm thiểu

- **Refactor lõi Rust khỏi PyO3 lớn:** giảm thiểu bằng G1 làm trước, đối chiếu golden từng bước.
- **Đồng bộ đơn vị (mm↔pt):** chuẩn hóa: core nhận mm trong `ImposeSettings`, trả pt trong `Placement`; quy ước ghi rõ một chỗ.
- **pdf-lib vs pikepdf khác biệt nhúng XObject (xoay, trimbox):** kiểm bằng test parity 2 assembler (Req 2.4).
- **Persist migration làm hỏng preset người dùng:** test migrate với dữ liệu phẳng v2 thực tế (Req 5.5).
- **Hiệu năng job nhỏ qua Tauri:** đo so với đường TS cũ; vì in-process nên kỳ vọng tương đương.
