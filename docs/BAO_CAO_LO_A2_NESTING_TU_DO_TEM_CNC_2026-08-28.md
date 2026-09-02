# BÁO CÁO LÔ A2 — MIỀN XOAY SERVER-OWNED VÀ CỔNG ROLLOUT CARDINAL

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ ba
**Baseline:** HEAD `8bc0a21` (đã được chủ dự án xác nhận là commit phụ thuộc workstream vòng đời tiến trình)
**Trạng thái:** **PASS** — chờ duyệt

---

## 1. Mã lô và mục tiêu

Lô A2 theo prompt bàn giao: *"thêm `autofill_single_sheet` và `quantity_fulfillment`, fixed obstacles, baseline candidate/provenance, stale source và commit fence"*, cộng quyết định §7.1/§7.3 của cổng Chặng 0.

**Điểm quan trọng nhất của lô này là kết quả khảo sát, không phải lượng code viết ra.** Đo lại từng hạng mục trước khi làm, hầu hết đã tồn tại. Việc đúng là **không viết lại**, và tập trung vào một lỗ thật sự nguy hiểm.

| Hạng mục A2 theo prompt | Trạng thái đo được | Bằng chứng |
|---|---|---|
| `layoutIntent` + cả hai intent | **đã có** | `nesting_production_adapter.py` (`_canonical_part`, kiểm `maxSheets=1` cho autofill), `nesting_imposition_bundle.py` |
| `fixedObstacles` | **đã có**, đủ 4 loại + provenance + 3 mã lỗi | `model.rs:582-601, 1079-1096`; `_canonical_obstacles` |
| baseline candidate / provenance | **đã có**, tagged enum không dùng boolean fallback | `model.rs:1752-1756`, `manifest.provenance` được store kiểm |
| stale source | **đã có** | `nesting_source_pin.NestingSourceStaleError`, `source_revision.py` |
| commit fence | **đã có**, spawn-safe | `nesting_production_orchestrator.ProductionCommitFence` |
| gọi kernel trực tiếp, không nested job | **đã có** | `solve_production_nesting` gọi `handle.solve_production` một lần |
| gapX/gapY dị hướng | **đã có** | `ClearanceSpec` 3 lớp; `normalize.rs:459-465` |
| **miền xoay khoá được cardinal** | **CHƯA — bị ghi cứng `free`** | §3 dưới đây |

Nên A2 thu về đúng một việc, làm cho chắc: biến miền xoay thành tham số server-owned tường minh, mặc định cardinal, có cổng rollout fail-closed.

---

## 2. File đã đổi — chính xác 3 file

| File | Loại | Thay đổi |
|---|---|---|
| `backend/app/core/nesting_production_adapter.py` | WIP untracked | 5 hàm canonical mới cho miền xoay; tham số `rotation_policy` + `allow_continuous_rotation`; bỏ 2 chỗ ghi cứng `free` |
| `backend/tests/test_nesting_production_lifecycle.py` | WIP untracked | Sửa 2 test khoá hành vi cũ; +32 test mới (30 hợp đồng/cổng + 2 test native thật) |
| `docs/BAO_CAO_CHANG_0_NESTING_TU_DO_TEM_CNC_2026-08-28.md` | tài liệu | Đính chính C0-4 (một nửa là false positive) và §7.1 |

Không chạm bundle, writer, route, UI, Rust. Không cập nhật golden. Không stage, không commit.

---

## 3. Lỗi đã đóng, và đo bằng probe trước khi sửa

### 3.1. Miền xoay bị ghi cứng `free` — không callsite nào khoá được cardinal

Đo trực tiếp trước khi sửa: đưa vào request một policy cardinal rồi in ra thứ engine thật nhận:

```
CALLER GUI : {"defaultRotation": {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}, "reflection": "forbidden"}
ENGINE NHAN: {"defaultRotation": {"mode": "free"}, "reflection": "forbidden"}
```

Không lỗi, không cảnh báo. Nguyên nhân: `orientationPolicy` được ghi cứng ở **hai** chỗ trong `build_production_request` (`solver_config` và `engine_request`).

Hệ quả nghiêm trọng vì nó sai **đúng hướng nguy hiểm nhất**: kế hoạch rollout yêu cầu Chặng A chạy cardinal, còn số đo Lô 0 cho thấy free-angle **kém** cardinal ở 8/9 ca (`ST_GANG_QUANTITY_5LOAI`: 22 so với 24 con/tờ; CNC S&R tam giác: 77–84 so với 152). Nếu nối route trong tình trạng này thì mọi job production chạy miền góc mà chính số đo của dự án nói là tệ hơn — mà không ai thấy gì bất thường.

### 3.2. Sửa sai một lần, rồi sửa lại cho đúng

Bản sửa đầu của tôi làm `orientationPolicy` của **client** thành authoritative. Test `test_adapter_ep_goc_tu_do_va_khong_tin_rotation_cua_client` đỏ, và **nó đỏ đúng**: tên test nói rõ bất biến là *không tin rotation của client*.

Đọc lại `_public_request()` thì thấy thiết kế hiện hữu rất nhất quán: client gửi `gapMm: 4.0`, `orientationPolicy: fixed 90°`, `parts[0].rotationConstraint: fixed 13°` — và adapter **bỏ hết**, vì cả ba đều là quyết định server. Cho client nới miền xoay bằng payload là mở một lỗ bảo mật/chất lượng.

Bản sửa đúng tách hai chuyện vốn bị gộp:

- **Ai quyết định** miền xoay: vẫn là server, client vẫn bị bỏ qua (giữ nguyên bất biến cũ).
- **Giá trị đến từ đâu**: từ tham số `rotation_policy` tường minh của callsite, **không** từ hằng ghi cứng trong hàm.

Ghi lại vì đây là bài học lặp lại được: một test đỏ với cái tên mô tả bất biến là tín hiệu phải đọc thiết kế, không phải tín hiệu sửa test.

### 3.3. Hợp đồng miền xoay đã đóng

`_canonical_rotation_constraint` khớp đúng schema tagged enum của Rust (`model.rs:271-290`):

| Mode | Tham số bắt buộc | Kiểm |
|---|---|---|
| `free` | không | miền liên tục — bị cổng rollout chặn |
| `fixed` | `angleDeg` | canonical `[0, 360)`, lượng tử 6 chữ số |
| `discrete` | `anglesDeg` | không rỗng, ≤4096, không trùng, sắp tăng dần |
| `ranges` | `arcs` | không rỗng, ≤1024, `sweepDeg ∈ (0, 360]`, sắp theo byte canonical — miền liên tục |
| `inherit` | — | **từ chối**, chỉ hợp lệ ở cấp chi tiết (khớp `ROTATION_INHERIT_NOT_ALLOWED_AT_JOB_LEVEL`) |

Bất biến khác:

1. **Tham số lạc mode bị chặn.** `{"mode": "free", "anglesDeg": [0]}` phải fail, không được lặng lẽ rơi về `free` — cùng tinh thần `require_only` bên Rust.
2. **`reflection` chỉ nhận `forbidden`.** Rust chỉ có một biến thể; nhận giá trị khác là mở đường lật hình âm thầm.
3. **Một object canonical dùng cho cả `solver_config` và `engine_request`.** Nếu hai chỗ dựng riêng thì `solverConfigHash` có thể khớp trong khi engine chạy miền khác — lệch im lặng không test nào bắt được về sau.
4. **Đổi miền xoay là đổi input.** `inputHash`, `layoutFingerprint`, `solverConfigHash` đều đổi theo, nên manifest cũ thành stale đúng hợp đồng #9.
5. **Chuẩn hoá làm hai request cùng ý định cho cùng identity.** `[270, 0.0000004, 90, 180]` và `[0, 90, 180, 270]` ra cùng `inputHash`.

### 3.4. Cổng rollout fail-closed

`allow_continuous_rotation` mặc định **False**: `free` và `ranges` bị từ chối kèm thông điệp nói rõ dùng gì thay thế. Mở free-angle sau Cổng Chặng B là một lời gọi tường minh, không phải sửa hằng số.

Thuộc tính an toàn đáng chú ý: vì mặc định đi qua **cùng** một hàm kiểm, **không thể** đổi mặc định thành free mà vẫn im lặng — xem mutation test ở §4.5.

---

## 4. Lệnh test và kết quả

### 4.1. Bộ verify bắt buộc (7 file + A1b + native)

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nesting_imposition_bundle.py `
  backend/tests/test_nesting_production_lifecycle.py backend/tests/test_nesting_source_geometry.py `
  backend/tests/test_imposition_affine_parity.py backend/tests/test_imposition_pdf_form.py `
  backend/tests/test_nup_clip_shape_render.py backend/tests/test_die_detection_page_contour.py `
  backend/tests/test_nup_artwork_path_key.py backend/tests/test_mixed_nesting_native.py -q
```

```
407 passed, 1 warning in 12.62s
```

`test_nesting_production_lifecycle.py` riêng: **167 passed** (A1c để lại 135, chênh +32 đúng bằng số test mới).

### 4.2. Toàn bộ backend

```
4195 passed, 19 skipped, 3 warnings in 537.74s (0:08:57)
```

Lượt đầu chạy **chồng** lên mutation test nên tôi không dùng số đó dù nó cũng xanh; đã chạy lại một lượt sạch sau khi hoàn nguyên file và hai lượt cho cùng kết quả. A1c để lại 4163; chênh +32 khớp số test mới.

### 4.3. Cargo, typecheck, vitest

Lô này không chạm Rust hay TS. Kết quả không đổi so với A1c: `cargo test imposition_core` 292 passed / `typecheck` exit 0 / `vitest` mixed-nesting 234 passed.

### 4.4. Tĩnh

`py_compile` 2 file Python: exit 0. `git diff --check`: exit 0.

### 4.5. Mutation test — cổng rollout không thể bị vô hiệu im lặng

Đổi mặc định `_CARDINAL_ROTATION_POLICY` thành `{"mode": "free"}`:

```
122 failed, 45 passed
```

Toàn bộ `_build()` fail vì chính cổng rollout từ chối `free`. Đây là thuộc tính thiết kế quan trọng: **không có đường nào đổi mặc định sang free-angle mà vẫn im lặng** — nó vỡ ầm ĩ ngay tại test đầu tiên thay vì lặng lẽ ship miền góc chưa qua Cổng B. Đã hoàn nguyên, chạy lại: 167 passed.

### 4.6. Hai test native THẬT — khoảng trống nghiêm trọng vừa được lấp

Trước lô này **không có test nào** nối `build_production_request` với native thật; mọi test vòng đời dùng handle giả. Nghĩa là một lệch giữa canonicalization phía Python và `deny_unknown_fields` / tagged enum phía Rust chỉ lộ ra ở runtime của người dùng.

Đã đo bằng probe trên native thật rồi biến thành test:

```
POLICY GUI NATIVE: {"defaultRotation": {"mode": "discrete", "anglesDeg": [0.0, 90.0, 180.0, 270.0]}, "reflection": "forbidden"}
STATUS          : completed
CANDIDATE       : {"kind": "baseline"}
VALIDATION      : {"valid": true, "validatorVersion": 1}
GOC THUC TE     : [0.0]
SO PLACEMENT    : 5
```

Hai test mới:

- `test_request_production_that_duoc_native_chap_nhan_va_ton_trong_cardinal` — native nhận request, validator nói hợp lệ, **mọi** `rotationDeg` trong manifest thuộc tập cardinal đã khai, và `selectedCandidate.kind` là `baseline` hoặc `smart_trial`.
- `test_native_tu_choi_gap_mm_khac_khong_khi_co_production_contract` — chứng minh `gapMm: 0.0` là **bắt buộc**, không phải bỏ sót của adapter.

Cả hai `skipif` khi máy chưa build native, theo đúng pattern của `test_mixed_nesting_native.py`.

### 4.7. Mức bằng chứng

| Hạng mục | Trạng thái |
|---|---|
| Hợp đồng miền xoay + cổng rollout | **AUTO**, có mutation test |
| Request production đi qua native thật, cardinal được tôn trọng | **RUNTIME** ở mức engine — chạy native thật, không phải fake |
| PDF artifact do writer production tạo | **UNKNOWN** — writer vẫn là stub, việc của A3 |
| Tauri end-to-end | **UNKNOWN** — lô này không chạm UI |

Đây là lần đầu trong đợt nesting có bằng chứng ở mức engine thật cho đường production. Vẫn **chưa** phải artifact PDF.

---

## 5. So sánh baseline solver

Không đổi solver, nhưng lô này **đổi miền góc mặc định** nên số đo sẽ khác khi nối route. Theo số Lô 0, chuyển từ `free` sang cardinal là **cải thiện** ở 8/9 ca (ví dụ `ST_GANG_QUANTITY_5LOAI` 22 → 24 con/tờ, tức ~264 → ~242 tờ). Tôi **không** đo lại con số đó trong lô này; nó vẫn là số Lô 0 ngày 27-08 và cần đo lại ở Chặng B.

Kernel/scheduler không đổi ⇒ runtime và RAM không đổi.

---

## 6. Finding

### 6.1. Mới trong lô: đính chính hai phát hiện của Chặng 0

| Mã | Kết luận mới | Bằng chứng |
|---|---|---|
| C0-4 (nửa `gapMm`) | **FALSE POSITIVE.** `gapMm = 0.0` là bắt buộc: Rust trả `LEGACY_GAP_WITH_PRODUCTION_CONTRACT` nếu khác 0 khi có `productionContract`. gapX/gapY đã đi qua `clearance` đầy đủ | `model.rs:861-866`; `normalize.rs:459-465`; test native mới |
| §7.1 (kiểm lại sau recenter) | **KHÔNG ÁP DỤNG** cho lane manifest: không có bước recenter (`rg recenter` trong `mixed_nesting/` không có kết quả). Pose là tuyệt đối trong hệ tờ; `validator.rs` §7 chạy một lần trên layout cuối với `FixedObstacleOverlap` / `ObstacleClearanceTooSmall` / `SheetEdgeClearanceTooSmall` | `validator.rs:506-560` |

Đã cập nhật vào báo cáo Chặng 0 §6.1 và §6.2. Ghi lại thay vì im lặng, vì báo cáo đó là đầu vào của các lô sau.

### 6.2. Còn mở

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| C0-2 | `nesting_imposition_render.py` còn là stub 87 byte | P0 cho Chặng A | **A3** |
| C0-3 | `GridStrategy` chưa có `true_shape_nesting` ở cả ba nơi | P1 | A4a |
| A2-1 | Nhánh CNC legacy còn nén `gap = max(gap_x, gap_y)` (`cnc_render.py:360`). Không ảnh hưởng lane manifest (đã dị hướng), nhưng sẽ lệch khi hai lane cùng chạy | P2 | Lô nối route |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cả run | `[SUSPECTED]` | Chặng B, đo trước |
| A1-1 | `imposition_pdf_form.py.rej` — đã xác nhận không mang thay đổi nào chưa áp, an toàn để xoá | P3 | dọn scratch |
| A1-2 | Toàn suite có thể crash native trong PDFium khi có thread nền `combine_jobs._sweep_loop` | P2, `[SUSPECTED]` | Đợt bọc `pdfium_guard()` |

Lượt toàn suite của A2 **không** gặp lại crash A1-2.

---

## 7. Kết luận

**PASS.**

- Miền xoay giờ là tham số server-owned tường minh, mặc định cardinal, có cổng rollout fail-closed không thể vô hiệu im lặng.
- Bất biến "không tin rotation của client" được giữ nguyên — đã suýt phá nó và test cũ đã chặn đúng.
- Lần đầu có test chạy request production qua **native thật**, lấp một khoảng trống mà 122 test vòng đời trước đó không phủ.
- Hai phát hiện của Chặng 0 được đính chính bằng số đo, không để lại nợ nhận thức cho lô sau.
- Không hồi quy: bộ bắt buộc 407 passed; toàn backend 4195 passed / 0 failed.

---

## 8. Lô tiếp theo — A3

**Lô A3 — writer/artifact (≤5 file).** Hoàn thiện `nesting_imposition_render.py` trên primitive Form đã có. Writer phải render source pin + placement manifest và **không được solve**. Kiểm bằng parse/raster PDF thật: page boxes, artwork vector, CUT/marks/report, Front/[Back]/Cut, source hash.

Đây là lô đầu tiên có thể nâng trạng thái lên **`ARTIFACT`** cho đường production, nên cũng là lô nhiều rủi ro nhất tới giờ. Đề nghị làm từng bước nhỏ và verify bằng file thật sau mỗi bước.

Trước khi bắt đầu, xin xác nhận một điểm sản phẩm: writer nên **tách trang CUT** theo `marks.cut.separatePage` như lane legacy, hay luôn tách? Hiện `outputSides` đã suy từ `separatePage`, tôi sẽ theo đó nếu không có ý khác.
