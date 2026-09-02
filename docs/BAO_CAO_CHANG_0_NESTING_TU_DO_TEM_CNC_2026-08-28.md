# BÁO CÁO CHẶNG 0 — RE-BASELINE NESTING TỰ DO TEM BẾ / CNC

**Ngày đo:** 2026-08-28
**Máy đo:** Windows thật của dự án, `D:\pdfcompare`, RAM ≥16 GB (nhóm "không cap" theo AGENTS.md #1)
**Trạng thái:** **CHỜ DUYỆT** — không sửa một dòng code sản xuất nào trong chặng này
**Phạm vi:** re-baseline bằng chứng + phân loại worktree + trình 6 quyết định. Không đổi hành vi, không stage, không commit, không cập nhật golden.

Chặng 0 theo `docs/PROMPT_BAN_GIAO_NESTING_TU_DO_TEM_CNC_2026-08-28.md`. Mục tiêu duy nhất: thay các con số **đọc từ tài liệu** bằng các con số **đo lại trên máy thật**, rồi chốt những quyết định nghiệp vụ mà lô A1 sẽ khoá vào contract.

---

## 1. Vì sao phải re-baseline

Báo cáo audit gốc ghi baseline HEAD `47afe41`, đã stale so với HEAD hiện tại `c863931` cộng một khối WIP lớn chưa commit. Theo `prynx-task-loop`, tài liệu trong repo là **giả thuyết, không phải bằng chứng**. Vì vậy mọi con số dưới đây đều có lệnh kèm output, và những gì chưa chạy được ghi thẳng là `UNKNOWN`.

Kết quả re-baseline: **các số trong tài liệu ngày 27–28/08 là đúng**, khớp 100% với đo lại. Nhưng có **bốn** điểm tài liệu đã lạc hậu theo hướng WIP đã làm được **nhiều hơn** tài liệu ghi (§5.1–§5.3, §5.5), và **một phát hiện P1 mới** mà chưa tài liệu nào nêu: hai lane render đang in vùng lỗ ngược nhau (§7.2, C0-9).

---

## 2. Snapshot Git đã đo lại

```powershell
git log --oneline -3
git rev-parse --abbrev-ref HEAD
git status --porcelain --untracked-files=all
git diff --stat
git diff --check
```

| Hạng mục | Giá trị đo được | So với tài liệu |
|---|---|---|
| Nhánh | `codex/pre-release-audit-2026-08-04` | khớp |
| HEAD | `c863931 feat: add mixed nesting and harden artifact workflows` | khớp |
| Đồng bộ remote | `origin/codex/pre-release-audit-2026-08-04` cùng commit, 0 ahead / 0 behind | khớp |
| Tracked modified | 50 | khớp |
| Intent-to-add | 2 | khớp |
| Untracked | **43** | tài liệu ghi 41 |
| Tổng worktree | **95** | tài liệu ghi 93 |
| `git diff --stat` | **7.585 thêm / 447 xoá trên 52 path** | khớp |
| `git diff --check` | sạch, exit 0 (chỉ warning CRLF của `.gitattributes`) | khớp |

Chênh 2 mục untracked là do chính hai file tài liệu ngày 28-08 (`TIEN_DO_*`, `PROMPT_BAN_GIAO_*`) được thêm sau khi ảnh chụp cũ được lấy. Không có file source nào phát sinh thêm.

Hai file intent-to-add: `backend/app/workers/imposition_pdf_form.py` và `backend/tests/test_imposition_pdf_form.py`. Xác nhận bằng việc `git diff --stat` đếm **52** path trong khi chỉ có 50 tracked modified — hai file kia lọt vào diff worktree-vs-index đúng đặc trưng của `git add -N`.

---

## 3. Phân loại 43 mục untracked

Phân loại để lô sau biết cái gì được stage, cái gì tuyệt đối không. Không xoá gì trong chặng này.

### 3.1. WIP production — core (6 file, `backend/app/core/`)

| File | Kích thước | Vai trò |
|---|---:|---|
| `nesting_production_adapter.py` | 77.273 B | Dựng `ProductionNestingRequest`, canonical hash, RenderBundle contract |
| `nesting_manifest_store.py` | 56.258 B | Manifest immutable, conflict fence, revalidate sau restart |
| `nesting_source_pin.py` | 23.192 B | Pin nguồn PDF bất biến trước solve |
| `nesting_imposition_bundle.py` | 22.286 B | RenderBundle V2 cho sticker/CNC renderer |
| `nesting_source_geometry.py` | 13.234 B | Giải nguồn hình học tem/CNC |
| `nesting_production_orchestrator.py` | 12.186 B | Điều phối commit fence quanh solve |

### 3.2. WIP production — worker (2 file, `backend/app/workers/`)

| File | Kích thước | Trạng thái |
|---|---:|---|
| `imposition_affine.py` | 9.054 B | `Affine2D`, `PoseMm`, `compose_render_ctm_mm` — có nội dung, có test |
| `nesting_imposition_render.py` | **87 B** | **STUB.** Nội dung đúng một dòng docstring: `"""Writer PDF production từ Placement Manifest bất biến của Bình tem/CNC."""` |

### 3.3. Test và fixture mới (6 mục)

`backend/tests/test_die_detection_page_contour.py`, `test_imposition_affine_parity.py`, `test_nesting_imposition_bundle.py`, `test_nesting_production_lifecycle.py`, `test_nesting_source_geometry.py`, `backend/tests/fixtures/nesting_tu_do/corpus_lo0.json`.

### 3.4. Script và tài liệu (6 mục)

`scripts/lo0_nesting_baseline.py` + 5 file `docs/` của đợt nesting (Lô 0, kế hoạch chính thức, hai prompt, tiến độ).

### 3.5. Scratch — KHÔNG stage, KHÔNG xoá khi chưa xác định chủ (22 mục)

| Nhóm | Số lượng | Ví dụ |
|---|---:|---|
| `_patch_form_*.diff` | 11 | `_patch_form_contract1..7`, `_patch_form_call1..2`, `_patch_form_paint1..2`, `_patch_form_hunk8` |
| `_tmp_*.gitdiff` / `_tmp_*.patch` | 7 | `_tmp_immutable*`, `_tmp_artwork_signature*`, `_tmp_eof` |
| `_probe_*.txt` | 2 | `_probe_after_close`, `_probe_patch` |
| Khác | 2 | `_codex_nesting_form.patch`, `backend/app/workers/imposition_pdf_form.py.rej` |

`.rej` là dấu hiệu một lần apply patch thất bại; nó nằm cạnh đúng file intent-to-add `imposition_pdf_form.py`. Đề nghị lô A1 kiểm hai bản có lệch nhau không trước khi tin nội dung hiện tại là bản đúng.

---

## 4. Bằng chứng verify đã chạy lại

Toàn bộ chạy trên Windows thật, đúng ràng buộc `prynx-testing` (vitest/tsc không chạy được trong VM Linux).

| Phạm vi | Lệnh | Kết quả đo 2026-08-28 | Tài liệu cũ | Mức |
|---|---|---|---|---|
| Backend contract/manifest/source/affine/PDF form/clip/die contour (7 file) | `backend\venv\Scripts\python.exe -m pytest ... -q` | **255 passed, 1 warning, 9,15 s** | 255 passed, 1 warning | AUTO |
| Toàn crate `imposition_core` | `cargo test --manifest-path imposition_core/Cargo.toml -q` | **292 passed, 0 failed** | 292 passed, 0 failed | AUTO |
| TS types | `npm.cmd run typecheck` | **exit 0, không diagnostics** | pass | Tĩnh |
| Frontend Mixed Nesting | `npx.cmd vitest run src/components/mixed-nesting src/lib/mixed-nesting src/stores/useMixedNestingStore.test.ts` | **7 file, 234 passed, 2,02 s** | 234 passed | AUTO |
| Cú pháp 9 module WIP | `python -m py_compile ...` | **exit 0** | pass | Tĩnh |
| Whitespace diff | `git diff --check` | **exit 0** | pass | Tĩnh |

Chi tiết 292 test Rust theo binary: 38 + 1 + 31 + 22 + 56 + 36 + 35 + 30 + 43 + 0.

Warning duy nhất là `PydanticDeprecatedSince20` tại `backend/app/config.py:16` (`class Settings(BaseSettings)` dùng class-based config). Đây là nợ kỹ thuật nằm **ngoài** phạm vi nesting, không phải test failure.

### 4.1. Điều vẫn UNKNOWN sau chặng này

| Hạng mục | Trạng thái |
|---|---|
| PDF artifact của **writer production** | **UNKNOWN** — writer còn là stub 87 B, không có gì để parse |
| PDF artifact của **primitive Form** | **ARTIFACT** cho một số hành vi hẹp — xem §5.4 |
| Preview ↔ export trên cùng file PDF thật | **UNKNOWN** |
| Tauri dev / installed / release end-to-end | **UNKNOWN** — chưa chạy `run_dev.bat` trong chặng này |
| Số đo solver (con/tờ, sheetCount) | **không đo lại** — vẫn là số Lô 0 ngày 27-08 |

Sửa lại một nhận định của tài liệu tiến độ: dòng "PDF artifact production thật: chưa có" là **đúng với writer production**, nhưng **không đúng** cho toàn bộ đường render. Primitive Form đã có test parse content stream và raster PDF thật — chi tiết ở §5.4.

Theo thang bằng chứng `prynx-deep-audit`, luồng này đang ở **`AUTO`** cho lõi và contract, **`UNKNOWN`** cho artifact và runtime. Không được báo `ARTIFACT` hay `RUNTIME` trong chặng này.

Tôi **không** chạy lại `scripts/lo0_nesting_baseline.py`. Lý do: harness đó cần tới 90 s/ca cho profile `tight` trên 23 ca, và Chặng 0 theo prompt chỉ yêu cầu "test baseline", không yêu cầu re-benchmark solver. Nếu chủ sản phẩm muốn số solver cũng được đo lại trước khi duyệt, đó là một lượt riêng — nói rõ để tôi chạy hẹp vào ca quyết định `ST_GANG_QUANTITY_5LOAI` và `CNC_SR_AUTOFILL_TAMGIAC`.

---

## 5. Bốn điểm tài liệu đã lạc hậu — WIP đã đóng nhiều hơn tài liệu ghi

Báo cáo Lô 0 (27-08) §3.6 liệt kê một danh sách "thiếu"; đo lại code hiện tại cho thấy **bốn mục đã có rồi**. Nếu lô A1 tin theo tài liệu, nó sẽ làm lại thứ đã có.

### 5.1. `fixedObstacles` — ĐÃ CÓ, đủ cả provenance

`imposition_core/src/mixed_nesting/model.rs:582-601`:

```rust
pub enum FixedObstacleKind { Gripper, SheetMark, CncExcludeZone, KeepOut }

pub struct FixedObstacleSpec {
    pub obstacle_id: String,
    pub kind: FixedObstacleKind,
    pub outer: Vec<PointMm>,
}
```

Kèm `MAX_FIXED_OBSTACLES = 4_096`, `MAX_OBSTACLE_ID_LEN = 128`, validate ID rỗng/quá dài/ký tự control/trùng, và ba mã lỗi `TOO_MANY_FIXED_OBSTACLES`, `INVALID_OBSTACLE_ID`, `DUPLICATE_OBSTACLE_ID` (`model.rs:1079-1096`, `:1447-1496`). Phía Python khớp đúng bốn loại tại `nesting_production_adapter.py:60-62` (`_ALLOWED_OBSTACLE_KINDS`) với hàm canonical `_canonical_obstacles` (`:1488-1516`).

### 5.2. Clearance dị hướng theo trục tờ — ĐÃ CÓ, và ngữ nghĩa đã đúng

`model.rs:546-577`:

```rust
pub struct SheetAxisClearanceMm { pub x_mm: f64, pub y_mm: f64 }

pub struct ClearanceSpec {
    pub part_to_part: SheetAxisClearanceMm,
    pub part_to_sheet_edge: SheetAxisClearanceMm,
    pub part_to_obstacle: SheetAxisClearanceMm,
}
```

Doc comment ghi đúng cái bẫy của free-angle: đây là khoảng hở theo trục **của tờ** sau khi đã áp pose, không phải trục local của chi tiết; nở footprint trước rồi xoay là **sai nghĩa**. Ba lớp clearance tách bạch, không nhập nhằng.

### 5.3. Identity cấp job — ĐÃ CÓ

`ProductionContractV1` (`model.rs:606-618`) có `schema_version`, `request_revision`, `input_hash` (canonical `sha256:` + 64 hex thường), `layout_fingerprint`, `clearance`, `fixed_obstacles`.

### 5.4. Even-odd đã được hiện thực và ĐÃ CÓ bằng chứng artifact

Đây là phát hiện làm đổi một quyết định ở §7.2, nên ghi riêng.

`backend/app/workers/imposition_pdf_form.py:625`:

```python
# NESTING (audit 2026-08-28 §FORM.1): outer + holes dùng đúng even-odd.
operations.append("W* n")
```

Và test `test_manifest_clip_outer_hole_even_odd_tren_artifact` (`backend/tests/test_nup_clip_shape_render.py:228-273`) chứng minh ở mức **ARTIFACT**, không phải suy luận:

- nguồn là trang **kín mực**, polygon outer 30×30 mm có một lỗ 10×10 mm, pose xoay **17°** (tức đã chạy đúng đường free-angle);
- `assert "W* n" in _raw(output_path)` — parse content stream thật của PDF đã ghi ra đĩa;
- raster PDF rồi đo điểm: trong outer `gray < 80` (có mực), trong lỗ `gray > 240` (**trắng, không mực**).

Nghĩa là lane manifest mới **để trống vùng lỗ trên bản in**, và điều đó đã được kiểm bằng file thật.

### 5.5. Nhưng adapter vẫn nói ngôn ngữ cũ

Ngay khi contract mới đã có, `nesting_production_adapter.py` vẫn hardcode hai chỗ (`:1679-1683` và `:1705-1711`):

```python
"gapMm": 0.0,
"orientationPolicy": { "defaultRotation": {"mode": "free"}, "reflection": "forbidden", ... }
```

Hai giá trị này **mâu thuẫn với kế hoạch rollout**: Chặng A phải khoá cardinal, và `gapMm` phẳng không thể diễn tả `gapX/gapY` mà UI tem/CNC đang dùng. Đây là việc thật của lô A1, và nó là **sửa cho khớp contract đã có**, không phải thêm contract mới.

---

## 6. Những gì vẫn hở, đã xác minh bằng code

| Mã | Phát hiện | Bằng chứng | Mức |
|---|---|---|---:|
| C0-1 | Chưa có consumer production. `true_shape_nesting` chỉ xuất hiện **một lần** trong toàn bộ `desktop/src`, `backend/app`, `imposition_core/src`: hằng `TRUE_SHAPE_NESTING_STRATEGY`. Không route/UI nào import 6 module `nesting_*` — chỉ test và chính chúng import nhau | `nesting_production_adapter.py:26`; grep import toàn `backend/app/**` | P1 |
| C0-2 | Writer production là stub 87 B | `backend/app/workers/nesting_imposition_render.py` | P0 cho Chặng A |
| C0-3 | `GridStrategy` thiếu giá trị mới ở **cả ba** nơi, và hai hợp đồng đang song song: enum Rust 6 biến thể qua `ts-rs`, union chuỗi thủ công 6 giá trị, UI chỉ hiện 3 option | `imposition_core/src/model.rs:81`; `generated/GridStrategy.ts`; `imposition-tools/types.ts:156` | P1 |
| C0-4 | ~~Adapter mặc định `free` + `gapMm=0.0`, lệch kế hoạch rollout~~ → **SỬA LẠI ở Lô A2, xem §6.1** | `nesting_production_adapter.py:1679-1683, 1705-1711` | P1 (phần `free`) |
| C0-5 | Lỗ khoét bị coi là vật liệu đặc khi collision/score. Obstacle cũng vậy: không có đường đặt chi tiết vào lỗ của obstacle | `model.rs:648-650` ("MVP ghi nhận nhưng coi là vật liệu đặc"); `model.rs:591-593` | Cần quyết định — xem §7.2 |
| C0-9 | **Hai lane đang in vùng lỗ NGƯỢC NHAU.** Lane legacy: `W n` nonzero, `_polygon_from_rings` **cố ý bỏ lỗ** nên artwork **vẫn in** trong cửa sổ/lỗ treo. Lane manifest mới: `W* n` even-odd, giữ lỗ nên vùng lỗ **để trắng**. Cùng một khuôn, hai đường, hai bản in khác nhau | `pdf_ops.py:606, 618` + `nup_clip_shape.py:115, 133-135` (legacy) so với `imposition_pdf_form.py:625` + test artifact `:228-273` (mới) | **P1 — quyết định nghiệp vụ** |
| C0-6 | Kernel **không** nhận worker/RAM grant. Chữ ký PyO3 vẫn là `solve(&self, py, request_json)` | `native/src/mixed_nesting_py.rs:190` | P2, Chặng B |
| C0-7 | Ngân sách work dùng **chung cho cả run**, không chia theo trial. Nghi là nguyên nhân profile không đơn điệu — xem §7.5 | `control.rs:339-373, 422-449`; `multi_start.rs:174-176` | `[SUSPECTED]` |
| C0-8 | Công cụ Mixed Nesting standalone **tự mở trong dev**: `isMixedNestingEnabled = isDevelopment \|\| releaseEnabled` | `desktop/src/lib/mixed-nesting/rollout.ts` | Đã biết, có chủ đích |

### 6.1. ĐÍNH CHÍNH C0-4 (thêm 2026-08-28 sau khi đo ở Lô A2)

Phát hiện C0-4 ban đầu gộp hai thứ vào một, và **một nửa là false positive**. Ghi lại đúng theo yêu cầu "xác minh chéo trước khi kết luận" của `prynx-audit-workflow`.

**`gapMm = 0.0` KHÔNG phải bug — nó là bắt buộc.** `imposition_core/src/mixed_nesting/model.rs:861-866`:

```rust
// Không cho hai nguồn chân lý. `gapMm` là contract legacy; production dùng
// ba lớp clearance tường minh trong envelope.
if self.gap_mm != 0.0 {
    errors.push(ContractError::new(
        ContractErrorCode::LegacyGapWithProductionContract,
```

Rust **từ chối** `gapMm != 0` khi đã có `productionContract`. Và gap dị hướng đã được nối đầy đủ: `normalize.rs:459-465` suy `solver_gap_mm` từ `clearance.partToPart` bằng `hypot(xMm, yMm)` cho broad-phase, còn phán quyết cuối dùng `clearance` theo từng trục tờ (`validator.rs` gọi `judge_pair_sheet_axis`). Đã kiểm bằng test native thật: đổi `gapMm` thành 4.0 thì native báo lỗi.

Nghĩa là quyết định §7.3 (a) **đã được hiện thực từ trước**; việc còn lại chỉ là bỏ chỗ nén `gap = max(gap_x, gap_y)` ở nhánh CNC legacy (`cnc_render.py:360`), thuộc lô nối route.

**`orientationPolicy = free` ĐÚNG là bug**, nhưng không phải "adapter mặc định sai". Bản chất nặng hơn: `orientationPolicy` bị **ghi cứng** trong hàm dựng request nên **không callsite nào khoá được cardinal**, dù kế hoạch rollout yêu cầu. Đã sửa ở Lô A2 — xem `docs/BAO_CAO_LO_A2_NESTING_TU_DO_TEM_CNC_2026-08-28.md`.

### 6.2. ĐÍNH CHÍNH §7.1 — không có bước recenter trong lane manifest

Quyết định §7.1 (a) yêu cầu "kiểm lại obstacle **sau bước recenter**". Đo lại: `rg recenter` trong `imposition_core/src/mixed_nesting/` **không có kết quả**. Lane manifest không có bước recenter — pose là **tuyệt đối trong hệ tờ** ngay từ solver, và `validator.rs` §7 chạy trên layout cuối với `FixedObstacleOverlap` / `ObstacleClearanceTooSmall` / `SheetEdgeClearanceTooSmall` theo clearance dị hướng.

Nên yêu cầu "kiểm lại sau recenter" được thoả **về mặt cấu trúc**: chỉ có một layout, validate một lần trên chính layout đó. Recenter (`x_off/y_off`, `original_cell_y` trong `imposition_finalize.py`) là chuyện của lane legacy; nếu lô nối route sau này đưa recenter vào đường manifest thì mới phải kiểm lại — ghi vào rủi ro của lô đó.

C0-8 là hành vi có chủ đích đã ghi trong audit 27-08, không phải bug. Nhưng nó có hệ quả vận hành: khi chạy `run_dev.bat` để verify Chặng A, công cụ standalone **cũng** hiện. Người kiểm tay phải phân biệt hai đường, nếu không sẽ báo "tính năng đã chạy" trong khi đang bấm vào công cụ lab.

---

## 7. Sáu quyết định trình chủ sản phẩm

Mỗi mục có hiện trạng đo được, các lựa chọn, và khuyến nghị kèm lý do. Lô A1 sẽ khoá quyết định vào contract, nên đổi sau sẽ tốn hơn nhiều.

### 7.1. Obstacle CNC và dấu canh

**Hiện trạng:** contract đã có đủ 4 loại `gripper`, `sheet_mark`, `cnc_exclude_zone`, `keep_out`, mỗi obstacle là một component multipolygon riêng, có `obstacleId` để artifact giải thích vì sao một vùng bị bỏ trống. `part_to_obstacle` clearance tách riêng khỏi `part_to_part`.

**Cần quyết:** ai dựng danh sách obstacle, và kiểm lại ở thời điểm nào.

- **(a) Server dựng, kiểm hai lần** — backend materialize boong/nhíp/dấu canh thành `fixedObstacles` trong hệ toạ độ tờ trước khi solve, rồi **kiểm lại sau bước recenter** của layout.
- **(b) Server dựng, kiểm một lần trước solve** — rẻ hơn, nhưng nếu layout được recenter sau khi solve xong thì mọi obstacle đã kiểm trở nên vô nghĩa.

**Khuyến nghị (a).** Recenter là phép dịch cả cụm; nó không đổi quan hệ part↔part nhưng đổi quan hệ part↔obstacle và part↔biên. Kiểm một lần là đúng ngay trước và sai ngay sau. Chi phí thêm chỉ là một lượt validate O(n) trên layout cuối, rẻ hơn một tờ giấy bị dao chạm nhíp.

### 7.2. Hole và fill rule

**Hiện trạng đo được — ba tầng, và hai tầng render đang làm NGƯỢC NHAU:**

| Tầng | Ngữ nghĩa hiện tại | Bằng chứng | Mức |
|---|---|---|---|
| Solver Rust | Lỗ **ghi nhận nhưng coi là vật liệu đặc** khi collision/score | `model.rs:648-650` | AUTO |
| Clip lane **legacy** | `W n` **nonzero**, `_polygon_from_rings` **cố ý bỏ lỗ** → artwork **VẪN IN** trong cửa sổ/lỗ treo. Comment ghi rõ lý do: "người thiết kế vẫn in đủ, dao mới là thứ cắt" | `pdf_ops.py:606, 618`; `nup_clip_shape.py:115, 133-135` | AUTO |
| Clip lane **manifest mới** | `W* n` **even-odd**, giữ lỗ → vùng lỗ **ĐỂ TRẮNG** | `imposition_pdf_form.py:625`; test raster `test_nup_clip_shape_render.py:228-273` | **ARTIFACT** |
| Kế hoạch §9 | ghi even-odd | tài liệu | — |

Đây không phải chuyện fill rule nào "đúng về mặt PDF". Hai lane cho **hai bản in khác nhau** cho cùng một khuôn: lane cũ in mực dưới cửa sổ rồi dao cắt bỏ, lane mới để trắng cửa sổ. Kế hoạch ghi even-odd, lane mới đã làm even-odd, nhưng **không ai chốt** rằng đó là hành vi in mong muốn — nó đến từ việc code theo kế hoạch.

**Cần quyết hai câu tách biệt:**

1. **Vùng lỗ/cửa sổ có được in mực không?** Đây là câu nghiệp vụ thuần, không phải kỹ thuật.
   - **(a) Có in — theo lane legacy.** Giữ nguyên thói quen sản xuất hiện tại của xưởng. Lane manifest mới phải đổi `W* n` → `W n` và bỏ lỗ khỏi clip.
   - **(b) Không in — theo lane mới.** Tiết kiệm mực, nhưng **đổi hành vi in** so với mọi job tem/CNC đang chạy. Nếu chọn (b) thì phải trả lời: khách hàng cũ in lại đơn cũ sẽ nhận bản khác bản trước, có chấp nhận không?
   - **(c) Theo loại lỗ.** Lỗ treo/cửa sổ dán màng → in (a); lỗ khoét thật xuyên giấy → để trắng (b). Đúng nghiệp vụ nhất, nhưng cần thêm một trường phân loại lỗ trong contract.
2. **Solver có được đặt chi tiết vào lỗ của chi tiết khác không?**
   - **(a) Không — lỗ là vật liệu đặc.** Giữ nguyên. An toàn, mất một chút hiệu suất với hộp có cửa sổ lớn.
   - **(b) Có — lỗ là vùng trống dùng được.** Phải kiểm thêm: chi tiết nằm trong lỗ vẫn giữ clearance với vành lỗ, và cặp lồng nhau phải nhất quán khi lật tờ CNC.

**Khuyến nghị: câu 1 chọn (a) cho Chặng A, câu 2 chọn (a).**

Lý do câu 1: hai lane in ngược nhau là rủi ro lớn nhất tôi tìm được trong chặng này, và nguyên tắc rollout đã chốt là "giữ nguyên artwork/CUT/marks hiện hữu". Chặng A là canary chứng minh **đường chạy**, không phải chỗ đổi hành vi in. Đưa (b) hoặc (c) thành đề xuất riêng sau khi có artifact so sánh cạnh nhau trên một khuôn có cửa sổ thật, để chủ xưởng nhìn hai bản in rồi quyết.

Lý do câu 2: (b) mở một lớp lỗi mới ngay khi cái cơ bản còn chưa qua cổng, mà lợi ích chỉ xuất hiện ở nhóm hình có cửa sổ lớn. Ghi vào backlog sau Cổng B.

**Nếu chủ sản phẩm chọn (a) cho câu 1**, lô A1 phải sửa `imposition_pdf_form.py:625` và test artifact tương ứng — tức test `test_manifest_clip_outer_hole_even_odd_tren_artifact` sẽ bị đảo kỳ vọng. Đây là **đổi test có chủ đích**, phải ghi lý do trong báo cáo lô, không phải "sửa cho xanh".

### 7.3. Ngữ nghĩa gap

**Hiện trạng:** kernel đã có 3 lớp clearance dị hướng `{x_mm, y_mm}` trong sheet-space. Nhưng adapter hardcode `gapMm = 0.0`, và nhánh CNC còn nén `gap = max(gap_x, gap_y)` (`cnc_render.py:360`, đã xác minh; dòng `:357` mới là chỗ đọc `gridStrategy` và chỉ cho nhánh S&R).

**Cần quyết:** map `gapX/gapY` của UI vào 3 lớp clearance thế nào.

- **(a)** `part_to_part = {gapX, gapY}` từ UI; `part_to_sheet_edge` lấy từ lề tờ đã có; `part_to_obstacle` mặc định bằng `part_to_part` nhưng cho phép override riêng.
- **(b)** Cả ba lớp đều lấy `max(gapX, gapY)` cho đơn giản, khớp hành vi CNC hiện tại.

**Khuyến nghị (a).** (b) làm mất chính cái năng lực mà contract vừa dựng, và nó giữ lại đúng chỗ nén `max()` mà báo cáo Lô 0 đã chỉ ra là bug tiềm ẩn của nhánh gang CNC. Kèm điều kiện: khi `gapX ≠ gapY`, artifact phải ghi rõ cả hai trong report để thợ in đối chiếu.

### 7.4. Metric compactness

**Cần quyết** metric nào là con số so sánh chính thức giữa baseline và smart.

- **(a) `placedCount` cho autofill, `sheetCount` cho quantity, compactness chỉ là tie-break.** Hai con số này là cái thợ in nhìn và cái quyết định tiền giấy.
- **(b) Compactness (diện tích dùng / diện tích khả dụng) làm metric chính.**

**Khuyến nghị (a).** Compactness là đại lượng dẫn xuất; hai layout cùng `sheetCount` nhưng compactness khác nhau thì tốn giấy như nhau. Dùng compactness làm metric chính sẽ có ca "thắng metric mà thua giấy". Định nghĩa tie-break đề xuất: cùng `sheetCount` thì chọn layout có tờ cuối trống nhiều nhất, vì tờ đó dễ tận dụng cho đơn sau.

### 7.5. Profile và ngân sách tìm kiếm

**Hiện trạng đo được** (`control.rs:422-449`):

| Profile | trial | orient/part | beam | refine | restart | eval budget | Ngân sách/trial |
|---|---:|---:|---:|---:|---:|---:|---:|
| Fast | 4 | 12 | 4 | 2 | 1 | 30.000 | ~7.500 |
| Balanced | 12 | 32 | 8 | 6 | 3 | 100.000 | ~8.333 |
| Tight | 32 | 96 | 16 | 18 | 8 | 300.000 | ~9.375 |

Doc comment trong `control.rs` ghi tốc độ đo được ≈9.700 lượt đánh giá pose/giây, tương ứng Fast ≈3 s, Balanced ≈10 s, Tight ≈31 s. Baseline **không** nạp ngân sách, nên hạ trần không bao giờ làm mất sàn an toàn.

**Giả thuyết `[SUSPECTED]` về việc profile không đơn điệu:** ngân sách là work budget **dùng chung cho cả run** (`RunControl` giữ đúng một `StopCriterion`). Chia ra thì ngân sách mỗi trial gần như phẳng (7.500 → 9.375, tăng 1,25×), trong khi nhu cầu công việc của mỗi trial tăng mạnh: `orient` ×8, `beam` ×4, `refine` ×9. Hệ quả suy ra: ở Tight, mỗi trial bị cắt sớm hơn trong chính vòng tìm của nó, có thể chưa kịp refine — nên kết quả có ca tệ hơn Balanced. **Chưa đo. Đây là giả thuyết, không phải kết luận.**

**Cần quyết:**

- **(a)** Ngân sách phải **tỉ lệ theo nhu cầu mỗi trial**, tức `evaluation_budget` cấp theo trial thay vì chia chung, hoặc nâng trần Tight cho đủ `trial × công việc mỗi trial`. Đánh đổi: Tight sẽ chạy lâu hơn 31 s.
- **(b)** Giữ trần thời gian ~3/10/31 s là bất khả xâm phạm, và **giảm** độ rộng enumeration của Tight cho vừa ngân sách.

**Khuyến nghị: đo trước, quyết sau.** Đây là quyết định duy nhất trong sáu mục mà tôi đề nghị **không** chốt bằng suy luận. Việc đúng là một phép đo hẹp trong Chặng B: chạy `GEO_INTERLOCK_CHU_L` và `ST_GANG_QUANTITY_5LOAI` ở cả ba profile, in ra `terminationReason` và số lượt evaluation đã dùng. Nếu Tight kết thúc bằng `WorkBudgetExhausted` trong khi Balanced kết thúc bằng `Finished`, giả thuyết được xác nhận và (a) là đường đúng. Nếu không, phải tìm nguyên nhân khác. Cần chủ sản phẩm cho biết **trần thời gian nào là chấp nhận được với thợ in** — đó là ràng buộc nghiệp vụ tôi không tự đặt được.

### 7.6. Cancel SLA và chính sách fallback

**Hiện trạng:** `RunControl::checkpoint` đã ghi mục tiêu độ trễ hủy ≤1 s, đã có checkpoint riêng cho pha baseline (tag `[LO0-5 FIX 2026-08-27]`). `StopCriterion` phân biệt rõ: `time_budget_ms = None` → work-plan cố định, cam kết bit-identical theo seed; `Some(ms)` → thêm deadline wall-clock, chỉ cam kết best-so-far hợp lệ. `TerminationReason` phân biệt `Cancelled` / `Deadline` / `WorkBudgetExhausted` / `MaxSheetsReached`.

**Cần quyết ba câu:**

1. **Cancel SLA.** Đề xuất **≤1 s tại checkpoint**, đúng mục tiêu code đã ghi. Cancel **không** được tạo final manifest.
2. **Timeout trước khi có kết quả smart.** Đề xuất: **luôn giữ baseline đã validate**, ghi `terminationReason = deadline` và provenance nói rõ kết quả đến từ đường nào. Người dùng nhận layout dùng được, không nhận lỗi.
3. **Smart kém baseline.** Đề xuất: **chọn baseline, ghi provenance, export không được tự đổi winner.** Và câu hỏi nghiệp vụ kèm theo: khi điều này xảy ra, UI có nói cho người dùng biết không?
   - **(a) Có, một dòng ghi chú trong report:** "Đã thử nesting theo đường bế, phương án lưới cho kết quả tốt hơn nên giữ lưới."
   - **(b) Im lặng, chỉ ghi vào manifest.**

**Khuyến nghị (a).** Người dùng chọn một option mới rồi nhận kết quả của option cũ mà không được giải thích sẽ báo là bug — đúng rủi ro mà báo cáo Lô 0 đã nêu khi phân tích phạm vi hiển thị option. Một dòng ghi chú rẻ hơn nhiều so với một vòng hỗ trợ.

---

## 8. Kết luận và điều kiện mở Chặng A

**Re-baseline PASS.** Lõi và contract đạt `AUTO` với số đo khớp tài liệu. Không phát hiện hồi quy nào so với các số ngày 27–28/08.

**Release vẫn NO-GO**, không đổi so với tài liệu tiến độ, vì ba lý do độc lập:

1. Đường production chưa nối: writer stub, không có consumer, `GridStrategy` chưa có giá trị mới → artifact và runtime của đường sản xuất đều `UNKNOWN`.
2. Chất lượng solver chưa qua Cổng B: 8/9 ca cardinal bằng hoặc hơn free-angle; S&R tam giác thua baseline ~45%.
3. **Mới phát hiện (C0-9):** hai lane render đang in vùng lỗ ngược nhau, và chưa ai chốt hành vi nào là đúng. Đây là chốt chặn phải mở **trước** lô A1, vì A1 sẽ khoá nó vào contract.

Trạng thái đúng để ghi vào master matrix:

> **Lõi: AUTO (đo lại 2026-08-28). Contract/lifecycle: AUTO, còn 5 hở đã định danh. Primitive Form: ARTIFACT ở một số hành vi hẹp. Tích hợp production: chưa bắt đầu. Artifact writer/runtime: UNKNOWN. Release: NO-GO.**

**Cổng Chặng 0 — cần chủ sản phẩm duyệt:**

- [ ] §7.1 obstacle CNC: chọn (a) hay (b)
- [ ] §7.2 câu 1 — **vùng lỗ/cửa sổ có in mực không**: chọn (a) in / (b) để trắng / (c) theo loại lỗ
- [ ] §7.2 câu 2 — solver có đặt chi tiết vào lỗ không: chọn (a) hay (b)
- [ ] §7.3 gap semantics: chọn (a) hay (b)
- [ ] §7.4 metric compactness: chọn (a) hay (b)
- [ ] §7.5 budget/profile: duyệt việc **đo trước**, và cho biết trần thời gian chấp nhận được với thợ in
- [ ] §7.6 cancel SLA + fallback: duyệt 3 đề xuất, chọn (a) hay (b) cho việc thông báo
- [ ] Xác nhận số solver Lô 0 dùng lại được, hoặc yêu cầu đo lại hẹp

Sau khi duyệt, lô A1 làm đúng 5 file như prompt bàn giao đã định, cộng một việc phát sinh từ §3.5: đối chiếu `imposition_pdf_form.py` với `imposition_pdf_form.py.rej` trước khi tin bản hiện tại.

Feature production giữ **OFF** trong suốt chặng này. Không stage, không commit, không xoá scratch.

---

## 9. Tài liệu liên quan

- `docs/TIEN_DO_NESTING_TU_DO_TEM_CNC_2026-08-28.md`
- `docs/PROMPT_BAN_GIAO_NESTING_TU_DO_TEM_CNC_2026-08-28.md`
- `docs/BAO_CAO_LO_0_NESTING_TU_DO_TEM_CNC_2026-08-27.md`
- `docs/BAO_CAO_AUDIT_TICH_HOP_NESTING_TEM_CNC_2026-08-27.md`
- `docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md`
- `docs/PRYNX_MASTER_AUDIT_MATRIX.md` — cần cập nhật sau khi cổng này được duyệt
