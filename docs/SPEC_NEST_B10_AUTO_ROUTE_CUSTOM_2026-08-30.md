# SPEC — Lô B10: Tự động định tuyến nesting theo phân loại hình

Ngày: **2026-08-30**. Đơn vị: `W7-U14`. Nối tiếp B7/B9 (true-shape đã nhanh) + B8 (grid NO-GO).
Trạng thái: **CHỐT 1 — SPEC, chưa đụng engine. CHỜ DUYỆT.**

## 1. Chính sách (người dùng chốt)

- **Hình dạng cụ thể (named)** — tam giác, chữ nhật, ngũ giác, lục giác, hình thang, bình
  hành, búa, tạ, mũi tên, tròn/elip — **đã có logic riêng, KHÔNG được đụng.**
- **Hình dạng đặc biệt (special)** — đường bế không khớp mẫu có tên — **dùng true-shape
  nesting** (`mixed_nesting`, engine đã tối ưu ở B7/B9).
- **Dàn nhiều mẫu (gang) lẫn cả cụ thể + đặc biệt** → **quy cả tờ về đặc biệt** (true-shape).
  Lý do kỹ thuật: một tờ chỉ chạy được MỘT engine; chỉ true-shape xử được hình đặc biệt,
  nên khi có ít nhất một mẫu đặc biệt thì cả gang phải đi true-shape.

Đây là **định tuyến TỰ ĐỘNG theo phân loại hình**, không phải một tùy chọn người dùng bấm.

## 2. Phân loại: "đặc biệt" = `CUSTOM`

`settings['detectedShapesByPage']` (map trang → shapeType) là nguồn phân loại, có sẵn ngay
tại điểm dispatch. Giá trị named = `TRIANGLE/RECTANGLE/PENTAGON/HEXAGON/DUMBBELL/HAMMER/
TRAPEZOID/PARALLELOGRAM/ARROW/CIRCLE_ELLIPSE`; **special = `CUSTOM`** (mặc định khi không
khớp mẫu). Người dùng có thể override shapeType ở dropdown; giá trị override là chân lý.

> **Cần xác nhận:** "đặc biệt" = đúng `CUSTOM`? (RECTANGLE vẫn là named → giữ lưới+L-shape,
> KHÔNG đi true-shape.) Nếu bạn có khái niệm "đặc biệt" khác (vd một cờ riêng), báo để sửa.

## 3. Gốc hiện tại (điểm cắm)

`backend/app/workers/nup_engine.py::_run_nup_engine_impl` (~dòng 283):

```python
if is_true_shape_nesting_requested(settings):        # CHỈ đọc gridStrategy == 'true_shape_nesting'
    return run_true_shape_nesting(...)
if settings.get('imposerMode') == 'cnc': ...          # CNC renderer
... else: lưới/sticker orchestrator (engine chuyên biệt cho named)
```

- `is_true_shape_nesting_requested` (nup_true_shape_nesting.py) hiện đọc **duy nhất** cờ
  `gridStrategy` do người dùng chọn (canary dev). → Đổi sang định tuyến theo phân loại.
- `_tool_from_settings`: true-shape chỉ cho die-cut/CNC; guillotine raise. → Guillotine (Bình
  cắt xén) **không đụng**, luôn lưới chữ nhật.
- `_guard_scope`: đang chặn `step_repeat` + `page_sheet_mode` + `mixed_guillotine`. → Nới cho
  `step_repeat` khi job là die-cut/CNC + CUSTOM; **giữ chặn** page_sheet (nguyên tấm) và
  mixed_guillotine.
- Named GANG hiện đi MaxRects theo bbox (`solve_auto_fill_mixed`…), KHÔNG phải tiler chuyên
  biệt (tiler chuyên biệt chỉ chạy cho S&R một-mẫu). "Không đụng named" = giữ NGUYÊN cả hai:
  tiler S&R chuyên biệt lẫn đường MaxRects gang-toàn-named.

## 4. Thiết kế — một quy tắc thống nhất

Thay điều kiện dispatch bằng vị ngữ **phân loại**:

```
should_route_true_shape(settings) :=
    tool ∈ {sticker_imposer, cnc_imposer}          # die-cut/CNC (guillotine loại)
    AND NOT page_sheet_mode
    AND layout_type != 'mixed_guillotine'
    AND any(shape == CUSTOM for shape in job designs)   # có ít nhất 1 mẫu đặc biệt
```

Vị ngữ này phủ **cả ba ca** người dùng nêu bằng một mệnh đề:
- S&R (step_repeat, một mẫu) CUSTOM → true-shape.
- Gang một-mẫu CUSTOM → true-shape.
- Gang lẫn named + CUSTOM → có CUSTOM ⇒ true-shape cả tờ ("quy về đặc biệt hết").
- Mọi job toàn-named → `should_route = false` → **engine cũ, không đụng.**

Điểm cắm: `_run_nup_engine_impl` gọi `should_route_true_shape` **trước** nhánh sticker/lưới;
`run_true_shape_nesting` đã nhận gang đa-mẫu (file 357 tem đã chạy). `_guard_scope` nới cho
step_repeat như trên.

### 4.1 Bỏ tùy chọn thủ công (auto hoá)

Vì định tuyến theo hình, người dùng KHÔNG còn bấm "Nesting theo đường bế" nữa. Đề xuất:
- Gỡ option `true_shape_nesting` khỏi dropdown "Cách xếp"; với die-cut/CNC + CUSTOM, hiển thị
  trạng thái thông tin "Nesting theo đường bế (tự động cho hình đặc biệt)".
- `resolveGridStrategy` (B7 §GRIDSTRATEGY-LEAK) + migration v12 vẫn giữ để dọn giá trị cũ đã
  lưu; nay chúng thành phòng thủ tầng hai (không còn ai tạo ra `true_shape_nesting` mới).

### 4.2 Fallback (khác đường thủ công)

Đường thủ công cũ **fail-closed** (người dùng chủ động chọn ⇒ lỗi nếu không chạy được). Đường
**tự động** thì khác: nếu true-shape lỗi/hết giờ cho một hình CUSTOM, **lùi về lưới bbox** (đúng
hành vi CUSTOM hiện tại) thay vì báo lỗi — vì người dùng không chủ động chọn nesting, không nên
chặn job. Ghi cảnh báo chẩn đoán. (Cần bạn duyệt hướng fallback này.)

## 5. Vì sao đúng và không hồi quy

- **CUSTOM lõm**: B8 đã đo lưới bbox **thua** true-shape (skyline-bbox 316 vs NFP 351, −10%).
  Nên chuyển CUSTOM từ lưới → true-shape là **thắng/hoà mật độ**, thêm cả xoay. Không hồi quy.
- **Named**: `should_route=false` ⇒ đi đúng engine cũ ⇒ **byte-identical** (golden named là gate).
- **Guillotine**: loại khỏi vị ngữ ⇒ không đụng.
- **Tốc độ**: B9 đã hạ true-shape 357 tem 27,9s→8,8s ⇒ auto-route không gây chậm khó chịu.

## 6. Verify (gate cứng)

1. **Golden NAMED không đổi** — S&R + gang toàn-named cho layout Y HỆT (không đụng engine cũ).
   Đây là gate quan trọng nhất của "ko được động vào".
2. **CUSTOM S&R + gang**: đo true-shape vs lưới bbox hiện tại — placedCount/util ≥ (thắng cho
   lõm, hoà cho lồi). Golden mới cho đường CUSTOM auto-route (bless có lý do).
3. **Routing test**: gang [named + CUSTOM] → true-shape; gang toàn named → engine cũ; guillotine
   → lưới; page_sheet/mixed_guillotine → vẫn engine cũ (không lọt true-shape).
4. **Fallback test**: true-shape lỗi trên một CUSTOM → lùi lưới, job vẫn ra kết quả.
5. **Preview ≡ thực thi** cho đường CUSTOM auto-route (parity pose).
6. Backend `-k "nesting or mixed_nesting or sticker"` xanh; `cargo test` không đụng (chỉ đổi
   định tuyến Python; Rust engine giữ nguyên).

## 7. Phạm vi + phân lô (≤5 file/lô)

- **Lô B10-1 (định tuyến, cốt lõi):** `nup_engine.py` (thay điều kiện dispatch bằng
  `should_route_true_shape`), `nup_true_shape_nesting.py` (`is_true_shape_nesting_requested`
  hoặc hàm phân loại mới + nới `_guard_scope` cho step_repeat die-cut/CNC + fallback) + test
  routing/guard. **Chưa đụng UI.**
- **Lô B10-2 (UI):** `GridSettingsSection.tsx` (ẩn option, hiện trạng thái auto), dọn phần thừa
  của tùy chọn thủ công; test.
- **Lô B10-3 (golden + benchmark):** golden CUSTOM auto-route + golden named-không-đổi;
  benchmark CUSTOM S&R/gang; báo số.

## 8. Rủi ro + rollback

- **Named lọt nhầm sang true-shape** = hồi quy nặng (mất tiler chuyên biệt). Chặn bằng: vị ngữ
  chỉ kích khi có CUSTOM; golden named là gate cứng.
- **Đổi output job CUSTOM die-cut đang chạy** (lưới → true-shape): là thay đổi layout có chủ
  đích; cần bless golden mới + chứng minh thắng/hoà (không hồi quy mật độ).
- **Fallback**: nếu chọn fail-closed thay vì lùi-lưới, một CUSTOM không nest được sẽ chặn job.
  Đề xuất lùi-lưới; chờ bạn duyệt.
- **Rollback:** đặt định tuyến sau một cờ (`PRYNX_NEST_AUTO_ROUTE_CUSTOM`); tắt cờ ⇒ về hành vi
  hiện tại (CUSTOM → lưới, true-shape chỉ khi bấm tay). Không đụng schema/engine Rust.

## 9. Câu hỏi chờ chốt trước khi vào Lô B10-1

1. "Đặc biệt" = đúng `CUSTOM` (mọi named kể cả RECTANGLE giữ engine cũ)?
2. Fallback khi true-shape lỗi trên CUSTOM: **lùi về lưới** (đề xuất) hay báo lỗi?
3. Bỏ hẳn tùy chọn "Nesting theo đường bế" thủ công (auto hoàn toàn) — đồng ý?

---

## 10. CHỐT (người dùng duyệt 2026-08-30)

Trả lời 3 câu §9 + tinh chỉnh quan trọng: **dùng chính dropdown "Xếp tối ưu / Lưới đơn giản"
làm công tắc cho tem đặc biệt** — không cần option "Nesting theo đường bế" riêng.

**Quy tắc cuối (thay §4):**

```
route_true_shape(settings) :=
    tool ∈ {sticker_imposer, cnc_imposer}        # die-cut/CNC; guillotine loại
    AND NOT page_sheet_mode
    AND layout_type != 'mixed_guillotine'
    AND gridStrategy == 'optimal_auto'           # "Xếp tối ưu"
    AND any(design.shape == CUSTOM)              # có ≥1 mẫu đặc biệt
```

| Hình | Xếp tối ưu (`optimal_auto`) | Lưới đơn giản (`simple_auto`) |
|---|---|---|
| **CUSTOM (đặc biệt)** | **true-shape nesting** (mới) | lưới bbox (như cũ) |
| Named (cụ thể) | tiler chuyên biệt (như cũ) | lưới đơn giản (như cũ) |
| Gang lẫn named+CUSTOM | có CUSTOM ⇒ **true-shape cả tờ** | lưới bbox cả tờ |

- **Q1 = CUSTOM.** RECTANGLE và mọi hình có tên → engine cũ.
- **Q2 = lùi về lưới.** true-shape lỗi/hết giờ trên CUSTOM ⇒ degrade về đúng đường
  `simple_auto` (lưới bbox), job vẫn ra; không fail-closed (vì người dùng không chủ động
  chọn nesting, chỉ chọn "tối ưu").
- **Q3 = bỏ option `true_shape_nesting`.** "Xếp tối ưu" nay hàm ý nesting cho hình đặc biệt.
  `resolveGridStrategy` + migration v12 giữ nguyên làm phòng thủ giá trị cũ.

Điểm cắm dispatch đổi từ `is_true_shape_nesting_requested` (đọc cờ thủ công) sang
`route_true_shape` (phân loại). Interceptor đặt TRƯỚC sticker orchestrator; chỉ chộp đúng ca
`CUSTOM + optimal_auto`, mọi ca khác rơi xuống engine cũ nguyên vẹn.

Bắt đầu **Lô B10-1** (định tuyến backend + fallback + test).

---

## 11. Lô B10-1 — Định tuyến backend (ĐÃ XONG + verify)

**File:** `nup_true_shape_nesting.py`, `nup_engine.py`, `tests/test_nesting_auto_route_custom.py`.

- `route_true_shape(settings)` — vị ngữ §10, cộng loại **1 Dao** (xem §13.1). Gói sau **cờ master
  `true_shape_nesting_enabled()`** (dev mở, release HOLD, test DEV_MODE=false ⇒ tắt).
- `_job_has_special_shape` + `_shape_is_special` — "quy về đặc biệt hết"; đặc biệt = rỗng/CUSTOM/lạ,
  hình có-tên = 10 giá trị non-CUSTOM của `ShapeType`. Chỉ xét trang SL>0 (else autofill).
- `_guard_scope` nới cho **S&R CUSTOM** khi `route_true_shape` True; vẫn chặn page_sheet /
  mixed_guillotine / S&R hình-có-tên.
- Dispatch `nup_engine._run_nup_engine_impl`: `_manual = is_true_shape_nesting_requested`
  (chỉ đọc `gridStrategy`), `_auto = route_true_shape`. Vào true-shape nếu một trong hai; **auto
  lỗi → lùi engine cũ**, **manual lỗi → ném** (fail-closed).

> **Quyết định cờ (đổi so với §8 rollback):** KHÔNG dùng env `PRYNX_NEST_AUTO_ROUTE_CUSTOM` riêng.
> Lý do: frontend không đọc được env backend ⇒ preview/export sẽ lệch. Dùng chung cờ master
> `true_shape_nesting_enabled` ↔ `TRUE_SHAPE_NESTING_ENABLED` (cặp parity đã có) — vừa là kill
> switch, vừa bảo đảm preview và export CÙNG quyết định. Test an toàn vì conftest đặt DEV_MODE=false.

**Verify:** `tests/test_nesting_auto_route_custom.py` (32) + `tests/test_nesting_dispatch_route.py`
(8, §13.2) xanh.

## 12. Lô B10-2 — Frontend auto-route (ĐÃ XONG + verify)

**File:** `trueShapeNestingRollout.ts`, `sections/GridPreview.tsx`, `sections/GridSettingsSection.tsx`
+ test (`trueShapeNestingRollout.test.tsx`, `GridPreview.mixedDuplex.test.tsx`,
`GridSettingsSection.mixedGuillotine.test.tsx`).

- `shouldUseTrueShapeNesting(...)` — **bản sao thuần** của `route_true_shape` (cùng 7 điều kiện,
  cùng phân loại đặc biệt, cùng loại 1 Dao). `GridPreview` tính `usesTrueShape` MỘT LẦN rồi thay
  toàn bộ `gridStrategy === "true_shape_nesting"` (routing preview, cache key, debounce, render).
- **Token giao thức preview:** endpoint `/preview-layout/jobs` (và `/preview-layout` sync) vẫn đòi
  `strategy == 'true_shape_nesting'`. Khi `usesTrueShape`, body gửi token đó; còn "Cách xếp" người
  dùng vẫn là `optimal_auto` cho export. Một luật định tuyến (`usesTrueShape` ↔ `route_true_shape`),
  preview khớp export. Không thêm surface định tuyến thứ ba ở backend.
- **Bỏ option thủ công** `true_shape_nesting` khỏi dropdown. `resolveGridStrategy` + migration v12
  giữ làm phòng thủ giá trị rò cũ (§GRIDSTRATEGY-LEAK).

**Verify (Windows thật):** `npm run typecheck` = 0; vitest 87 test (3 file) pass; eslint 6 file = 0.

## 13. Lô B10-3 — Golden + benchmark + phát hiện 1 Dao

### 13.1 Phát hiện + vá lỗ hổng 1 Dao (khi soi parity preview↔export)

`route_true_shape` ban đầu KHÔNG loại `cutType == 'one_dao'`. 1 Dao = cắt **chữ nhật** (đã xác
nhận qua `nup_layout_solver.rectangle_inking_is_allowed` — 1 Dao ⇒ inking chữ nhật được phép).
Một job 1 Dao dò ra CUSTOM sẽ **auto-route nhầm** sang true-shape. Đã thêm loại `one_dao` ở **cả**
backend (`route_true_shape`) **và** frontend (`shouldUseTrueShapeNesting`) + test hai phía.

### 13.2 Golden "hình có tên KHÔNG đổi" — gate đã thỏa

- Golden layout-math (`tests/golden/`) chạy solver THUẦN (`solve_optimal_layout`, sticker
  `solve_*`). B10 **chỉ đổi định tuyến dispatch, không đụng solver** ⇒ golden bất biến. `-k nesting`
  = **1045 pass / 2 skip** (file nguồn thật), golden pass.
- `tests/test_nesting_dispatch_route.py` (8) chốt ở TẦNG DISPATCH: named / simple_auto / 1 Dao /
  cờ-tắt → engine cũ (bẫy `pdf_lib.open`); CUSTOM+optimal (tem bế & CNC) → `run_true_shape_nesting`;
  auto lỗi → lùi engine cũ; manual lỗi → ném. Không cần PDF/engine native.

### 13.3 Golden CUSTOM auto-route + benchmark = hoạt động RELEASE-FLIP

Feature **dev-on / test-off** qua `true_shape_nesting_enabled()`, nên trong bộ test golden hiện
KHÔNG có layout CUSTOM nào đổi (auto-route không kích). Việc phải làm **khi bật cờ release**:

1. **Bless golden CUSTOM die-cut** (layout đổi grid→true-shape — có chủ đích, soi diff trước khi
   `-u`; đây là "đổi output job đang chạy" ở §8).
2. **Benchmark** CUSTOM S&R + gang. Lưu ý: B10 **không đổi engine** — perf true-shape đã đo ở
   B7/B9 (357 tem 27,9s→8,8s). Cái đổi là CUSTOM đi true-shape thay vì lưới bbox; **thắng/hoà mật
   độ** theo số B8 (skyline-bbox 316 vs NFP 351, +11% ca lõm). Benchmark release chỉ để xác nhận
   trên máy phát hành, không phải cổng chặn của B10-3.

### 13.4 Preview ≡ export

`usesTrueShape` (FE) và `route_true_shape` (BE) đọc cùng các trường job (isDieCut=stickerLike=
dieGeometryMode; imposerMode; shapesByPage=previewDetectedShapesByPage=detectedShapesByPage;
cutType; gridStrategy; targetQuantitiesByPage) và cùng logic ⇒ CÙNG quyết định. Parity pose/hình
học đã có `tests/test_nesting_preview_capacity.py` + `tests/test_nesting_finishing_parity.py`.

**Trạng thái B10: B10-1/B10-2/B10-3 XONG. Golden-bless + benchmark CUSTOM chờ mốc bật cờ release.**

## 14. Hậu kiểm (khi chạy dev) — vá 2 lỗi đường S&R + bàn giao phiên

Chạy thử dev (cờ bật) tem **đặc biệt + Bình trang (S&R) + Xếp tối ưu** hiện lỗi preview:
"Nesting tối ưu theo đường bế chưa mở cho Bình trang (S&R)". Truy vết ra **hai** lỗi cùng gốc —
`gridStrategy` trong settings không phản ánh lựa chọn thật ở từng đường:

### 14.1 Gốc

- **Preview** dựng settings qua `settings_from_preview_request`, hardcode `gridStrategy='true_shape_nesting'`
  (TOKEN, di sản thời có option thủ công). `route_true_shape` đòi `gridStrategy=='optimal_auto'`
  ⇒ trả **False** ⇒ `_guard_scope` chặn S&R.
- **Export** đi `optimal_auto`. `attach_preview_session_reference` lại chỉ nhận TOKEN
  (`is_true_shape_nesting_requested`) ⇒ job auto-route KHÔNG gắn tham chiếu phiên ⇒ process con
  **solve lại** (mất bàn giao preview→export mà B7/B9 dựng).

### 14.2 Sửa — một vị ngữ hợp nhất

Thêm `wants_true_shape_nesting(settings) := is_true_shape_nesting_requested(settings) OR
route_true_shape(settings)` — ĐÚNG hợp mà dispatch `_run_nup_engine_impl` đang dùng
(`_manual OR _auto`). Dùng ở:
- `_guard_scope` (S&R): cho qua khi TOKEN (đường preview) **hoặc** auto-route CUSTOM.
- `attach_preview_session_reference`: gắn tham chiếu cho cả token lẫn auto-route. `job_identity_key`
  KHÔNG phụ thuộc `gridStrategy` nên preview (token) và export (optimal_auto) cùng khoá ⇒ tra đúng
  phiên ⇒ export render từ manifest, không solve lại.

`settings_from_preview_request` GIỮ token (không phá `job_identity_key` / test parity). Ranh giới
"chỉ CUSTOM mới nest" vẫn đúng: frontend chỉ gửi token khi `usesTrueShape` (CUSTOM); S&R hình
CÓ TÊN không token + `route_true_shape=False` ⇒ vẫn chặn (giữ tiler chuyên biệt).

### 14.3 Test

- `test_nesting_session_handover.py`: thêm `test_auto_route_optimal_tai_dung_phien` (export
  optimal_auto tái dùng phiên preview token); đổi 2 test "strategy khác" sang `simple_auto` (ca
  không-nesting thật).
- `test_nesting_auto_route_custom.py`: thêm `wants_true_shape_nesting` (token/route/độc lập cờ) +
  guard S&R token (đường preview).
- `test_nup_true_shape_nesting_entry.py`: `test_step_repeat_bi_chan` → tách thành
  `test_step_repeat_token_duoc_phep` (S&R CUSTOM được) + `test_step_repeat_named_van_bi_chan`
  (S&R named vẫn chặn).
- `test_nesting_preview_capacity.py`: bỏ ca `step_repeat` khỏi danh sách "ngoài phạm vi" (S&R nay
  trong phạm vi cho tem đặc biệt).

**Verify:** `-k nesting` = **1058 pass / 2 skip**.

## 15. Lô B10-4 — S&R true-shape: MỖI MẪU MỘT TỜ (Cổng Chặng B)

Hậu kiểm §14 mở khóa S&R cho true-shape, nhưng lộ ra: `build_true_shape_nesting_job` lấy TẤT
CẢ trang làm mẫu rồi engine **gang** cả 12 mẫu lên một tờ — trong khi "Bình trang (S&R)" phải
là **lặp một mẫu mỗi tờ** (engine lưới cũ: N mẫu → N tờ đồng nhất). Người dùng chốt **phương án
A**: mỗi mẫu một tờ riêng, nest sát; preview hiện tờ của mẫu đang xem qua pager. Đây chính là
"Cổng Chặng B" mà pipeline cố ý hoãn (`_render_context`: "Chặng A chỉ mở nhánh gang").

**Bất biến kỹ thuật:** engine true-shape chỉ gang trong MỘT job (một `ProductionNestingJobInput`
→ một manifest, mọi part chung tờ). Không có cờ "mỗi part một tờ". ⇒ S&R phải tách **N job
single-design** rồi ghép tờ ở tầng preview/export. Gộp N manifest tay là bất khả (mỗi solve có
`renderBundleHash` riêng, placement gắn `sourceRevision`).

### 15.1 Kiến trúc (6 lô, mỗi lô verify)

1. **Build** (`nup_true_shape_nesting.py`): tách `_assemble_nesting_job` (giữ nhánh gang
   byte-identical), thêm `build_true_shape_nesting_jobs()` → **danh sách** job. `step_repeat`/`sr`
   → mỗi mẫu (trang tham gia) một job `autofill_single_sheet` (1 part, `max_sheets=1`,
   `quantity=None`); nup → `[một job gang]`. Trang tham gia = `sorted(_page_quantities)` nếu có
   khai SL, ngược lại `_autofill_pages`. Mỗi job một `manifest_id` (publication độc lập).
2. **Preview** (`nesting_preview_capacity.py`): tách `_project_sheet_cells`; nhánh sớm
   `_build_step_repeat_preview` solve từng mẫu → `sheets[]` (một `BackendLayoutSheet`/mẫu:
   cells+diePolylines+pageIdx+dims, `totalItems`=sức chứa mẫu đó), `sheetsNeeded`=ΣN,
   `isMixedPreview=False` (mỗi tờ một mẫu, không nhãn trộn), top-level `cells`=tờ 0.
3. **Export** (`nup_true_shape_nesting.py`): nhánh `_run_step_repeat_export` render từng mẫu ra
   PDF tạm rồi `_concat_pdf_pages` (pikepdf, giữ nguồn mở tới `save`). front + trang CUT là TRANG
   riêng (không OCG) nên nối trang là đủ; report stamp per-mẫu. `_write_step_repeat_progress` cho
   UI không kẹt 0/0.
4. **Bàn giao phiên** (parity preview≡export): `_attach_step_repeat_references` gắn **DANH SÁCH**
   tham chiếu (một mỗi mẫu) — ALL-OR-NOTHING (thiếu một mẫu ⇒ không gắn, export tự solve cả loạt);
   `_run_step_repeat_export` nếu thấy list đúng số mẫu → `load_referenced_manifest` +
   `render_stored_production_nesting` từng mẫu (fail-closed khi miss), không solve lại. Quan trọng
   vì autofill ngân sách ~1ms không tất định qua ranh giới process. `SESSION_REFERENCE_SETTING` nay
   là dict (nup) HOẶC list (S&R); đường run đơn chỉ thấy dict (S&R rẽ trước).
5. **Frontend** (KHÔNG đổi mã): `sheets[]` đi qua đúng đường `convertedResult` dùng chung (đổi
   pt→mm), pager ◄/► render khi `sheets.length>1`, nhãn "tờ X / N", `totalSheets=sheetsNeeded`,
   cells vẽ từ `diePolylines`. Không có cổng theo layoutType chặn nesting.
6. **Verify + docs**: dưới đây.

### 15.2 Verify (Windows thật)

- Backend `-k nesting`: **1070 pass / 2 skip** (từ 1058, +12 test B10-4). Gồm:
  test build (gang giữ nguyên + S&R N job), preview sheets[], export nối tờ, **bàn giao thật**
  `test_step_repeat_handoff_moi_mau_tai_dung` (nguồn 2 trang: preview solve 2 → gắn list 2 →
  export tái dùng cả 2, `calls==[]` không solve lại).
- Frontend: `npm run typecheck` = 0; `GridPreview.mixedDuplex.test.tsx` 18 pass (thêm test pager
  nesting nhiều tờ); eslint file chạm = 0.

### 15.3 Giới hạn đã biết (theo dõi)

- **Report số tờ theo SL:** job S&R là autofill (`quantity=None`) nên report hiện "1 tờ/mẫu" (tờ
  đại diện), chưa nhân theo SL đặt như engine lưới (`sheets_needed = ceil(qty/sức_chứa)`). Hình
  học/parity đã đúng; chỉ con số "in bao nhiêu tờ" cho mỗi mẫu là phần tinh chỉnh sau.
- **Golden/benchmark** cho S&R CUSTOM vẫn là hoạt động mốc bật cờ release (§13.3): feature
  dev-on/test-off, layout S&R đổi gang→per-design là có chủ đích, bless khi flip.

**Trạng thái B10-4: XONG (Lô 1–6), verify đủ. Chờ bật cờ release để bless golden + benchmark.**

## 16. Lô B10-5 — CỔNG CHẤT LƯỢNG: "Xếp tối ưu" không bao giờ thua "Lưới đơn giản"

### 16.1 Lỗi người dùng báo

Trên file thật: **"Xếp tối ưu" 43 con/tờ** trong khi **"Lưới đơn giản" 54 con/tờ** — kém 20%.
Một lựa chọn tên "tối ưu" mà cho kết quả tệ hơn lựa chọn "đơn giản" là hỏng lời hứa, không phải
đánh đổi. Hai cơ chế cộng dồn (đã đọc code, không suy diễn):

1. **Autofill tắt hẳn pha tìm kiếm.** `AUTOFILL_TIME_BUDGET_MS = 1` (1ms) ⇒ chỉ còn baseline
   greedy xếp lần lượt từ dưới-trái. Lý do ghi trong code: đo 5 ca thấy search không thắng
   baseline ở miền góc cardinal.
2. **Footprint đóng gói bị phình.** `derive_packing_footprint` nới 0,2mm rồi **nhân đôi dần tới
   3mm** cho đủ trần 256 đỉnh; tem bo tròn mượt dễ vượt trần. Hở tem của người dùng cộng thêm
   lên trên ⇒ mỗi con chiếm chỗ to hơn đường bế thật.

Cả hai là hạn chế kernel; số đo Lô 0 vốn đã ghi kernel thua tiler/lưới ở 8/9 ca. Kết luận: KHÔNG
được tin nesting vô điều kiện.

### 16.2 Thiết kế — đo cả hai, lấy đường tốt hơn

Module mới `backend/app/core/nesting_quality_gate.py`:

- `grid_capacity_for_page(...)` đo sức chứa **đường cũ** bằng đúng `compute_sticker_layout_for_page`
  (nguồn chân lý dùng chung của preview+export ở đường cũ) + `sticker_capacity_after_pont` (trừ ốc
  y như nesting coi ốc là vật cản) ⇒ con số so được. Bọc `pdfium_guard()` vì chạy trong
  `run_in_threadpool`. Lỗi/không đo được ⇒ trả **0** = "không có ý kiến", không chặn nesting.
- `grid_capacity_from_settings` (export, camelCase/mm) và `grid_capacity_from_request` (preview,
  snake_case/point) là hai bộ chuyển đơn vị duy nhất ⇒ hai bên đo CÙNG một số.
- **`grid_beats_nesting(...)` là quyết định DUY NHẤT**, dùng chung preview+export, phân theo intent:
  - `autofill_single_sheet` ("tự lấp đầy tờ"): so **con/tờ**, `grid >= nesting` ⇒ lưới thắng
    (hoà nhường lưới: rẻ hơn, đúng hành vi trước §B10).
  - `quantity_fulfillment` ("đủ số lượng đặt"): so **số tờ phải in**,
    `ceil(qty/grid) < nesting_sheets` ⇒ lưới thắng (hoà **giữ nesting**).
- `GridBeatsNestingSignal(Exception)` — cố ý **không** kế thừa `ValueError`, vì route đổi
  `ValueError` thành 422 và job registry gắn `NESTING_PREVIEW_INVALID_REQUEST`; cả hai hiện ra như
  lỗi. Đây không phải lỗi mà là "đổi đường".

### 16.3 Điểm nối

- **Preview** (`nesting_preview_capacity.py`): gác sau khi có sức chứa nesting. Gang (nup) chỉ gác
  khi ĐÚNG một mẫu — gang nhiều mẫu ở đường cũ đi MaxRects theo bbox nên không so một-một. S&R gác
  theo **TỔNG** hai bên (`_enforce_quality_gate_totals`) vì export chỉ chạy được một engine cho cả
  lượt ⇒ hai bên phải quyết cùng mức.
- **Phục hồi preview** (không đổi giao thức, không sửa frontend):
  - sync `/preview-layout`: `except GridBeatsNestingSignal` đặt TRƯỚC `except ValueError`, trả
    `preview_layout(req.model_copy(update={"strategy": GRID_PROBE_STRATEGY}), license_info)`.
  - async job: bắt trong `_default_runner` (nơi DUY NHẤT còn giữ `request` gốc — `PreviewJobSnapshot`
    cố ý không mang request ra khỏi khóa registry) và trả layout đường cũ ⇒ job vẫn `completed`,
    frontend nhận kết quả bình thường. Kèm theo: `submit(license_info=...)` để worker dựng được
    preview đường cũ (đường cũ tự kiểm entitlement).
  - **BẤT BIẾN**: chiến lược ĐO (`GRID_PROBE_STRATEGY = 'optimal_auto'`) phải TRÙNG chiến lược TRẢ
    VỀ, nếu không con số cổng đo được không phải con số người dùng nhận. Có test khoá.
- **Export** (`nup_true_shape_nesting.py`): gác ở cả đường bàn giao (manifest preview) lẫn đường tự
  solve, rồi ném `ValueError` để `_run_nup_engine_impl` **dùng lại đường degrade đã có** (auto-route
  lỗi ⇒ rơi xuống lưới/sticker theo đúng công cụ). Không thêm nhánh dispatch mới. CHỈ áp cho
  auto-route: token thủ công là yêu cầu tường minh nên giữ fail-closed.

### 16.4 Lỗi tôi tự gây và đã sửa trong lô này

Bản đầu so `placedCount` với sức chứa lưới ở **mọi** intent — sai đơn vị. Với
`quantity_fulfillment`, `placedCount` là **số con đã đặt** (đặt 6 thì xếp đúng 6), nên so với
"lưới 18 con/tờ" là so hai đại lượng khác nhau và cổng chặn oan nesting dù nó đã hoàn thành đơn
trong một tờ. Test thật `test_preview_contract_thuc_te_den_route_va_process_con_khong_solve_lai`
bắt được ngay. Đã tách theo intent như §16.2 và thêm test hồi quy
`test_quantity_fulfillment_khong_so_placed_voi_suc_chua`.

### 16.5 Verify

- `tests/test_nesting_quality_gate.py`: **26 test** (luật so theo intent, đo sức chứa lưới THẬT =
  70 = 7×10 cho khuôn 40mm/hở 2mm trên 320×430/lề 5, parity mm↔point, tín hiệu không phải
  ValueError, export lùi engine cũ, token thủ công không bị can thiệp, lưới=0 không chặn).
- Backend `-k nesting`: **1095 pass / 2 skip** (từ 1070). Không hồi quy.

### 16.6 Còn lại (không nằm trong lô này)

Cổng bảo đảm người dùng **không bao giờ nhận kết quả tệ hơn**, nhưng KHÔNG sửa gốc hai cơ chế
§16.1. Việc nên làm tiếp, có số đo trước/sau:

1. Đo lại mức phình footprint trên file thật (log tolerance + số đỉnh); nếu escalation tới 1,6–3mm
   là thủ phạm thì cân nhắc nâng trần đỉnh thay vì phình hình — chính tài liệu nội bộ đã kết luận
   "ép đỉnh làm mất vật liệu thật −4,3%, độ trung thực của hình thắng số lượt thử".
2. Cân nhắc bật lại search cho autofill (env `PRYNX_NEST_AUTOFILL_SEARCH_MS`) và đo, vì kết luận
   "search không thắng baseline" được đo TRƯỚC khi có cổng và chỉ trên 5 ca.

## 17. Lô B10-6 — Preview tiến triển S&R gần realtime

### 17.1 Mục tiêu và nhịp xuất bản

Tem đặc biệt dùng **Bình trang (S&R) + Xếp tối ưu** vẫn giữ true-shape nesting của B10-4,
nhưng không bắt người dùng nhìn trạng thái chờ trong toàn bộ thời gian solve:

- Sau **250 ms**, frontend gọi `/imposition/preview-layout` với cùng payload công việc, chỉ đổi
  `strategy` thành `optimal_auto`, rồi xuất bản ngay lưới/tiler cũ làm **provisional preview**.
- Sau **750 ms**, frontend mới bắt đầu job `/imposition/preview-layout/jobs` với token
  `true_shape_nesting`. Solve nặng tiếp tục chạy nền; không hạ ngân sách, chất lượng hay số worker
  trên máy mạnh.
- Chỉ nhánh S&R true-shape dùng cơ chế tiến triển này. Các chế độ khác giữ đường preview hiện tại.

Hai đồng hồ độc lập nên provisional có thể hiện từ mốc 250 ms mà không làm job nesting khởi động
sớm hơn mốc 750 ms. Test fake-timer khóa chính xác bốn biên 249/250/749/750 ms.

### 17.2 Quyền quyết định và hàng rào publication

Frontend **không** so `totalItems` hay tự phán đường nào tốt hơn: đại lượng đó chỉ mô tả tờ đang
xem, trong khi quality gate backend so chất lượng toàn job. Trường `strategyUsed` của kết quả
terminal là trọng tài duy nhất:

- `true_shape_nesting` ⇒ nesting thắng, nâng preview provisional lên kết quả terminal.
- chiến lược legacy ⇒ quality gate chọn đường cũ; giữ nguyên provisional đã thấy, không repaint
  hay downgrade bằng một response terminal cùng loại đến muộn.

Generation fence chặn response thuộc lần cấu hình cũ. Trong cùng một generation, publication rank
`0/1/2` lần lượt biểu diễn chưa xuất bản / provisional / terminal; rank thấp không được ghi đè rank
cao. Vì vậy provisional trả muộn không thể đè terminal, và kết quả terminal cũ không thể đè lần
cấu hình mới.

Khi backend terminal chọn legacy, hoặc người dùng chốt provisional bằng hủy/lỗi nền, diagnostic
publication mang `forceLegacyGrid=true`. `ImposerDashboard` chỉ giữ cờ cho đúng request ở trạng
thái `applied`; generation mới phát `pending` ngay trước debounce để xóa quyết định cũ. Cờ đi qua
`ImpositionTab` và `processHandlers` tới settings export, rồi `route_true_shape()` trả `False` cho
đúng lượt đó. Nhờ vậy export dùng engine lưới đã hiển thị thay vì tự solve true-shape lại; terminal true-shape không
mang cờ này. Frontend vẫn không tự so sức chứa: backend quyết winner khi job hoàn thành, còn hủy là
quyết định tường minh của người dùng dừng nâng cấp nền. Cache lưu kèm decision; cache hit tăng
generation và phát lại `applied`, nên chuỗi A legacy → B pending → quay lại A vẫn khôi phục cả
layout lẫn `forceLegacyGrid`, không chỉ khôi phục hình vẽ.

### 17.3 Lỗi, hủy và vòng đời diagnostic

- Nesting lỗi hoặc bị hủy chỉ giữ provisional **nếu nó đã được xuất bản**; không chờ vô hạn một
  provisional request đang treo và không để loading kẹt.
- Mỗi request có diagnostic `job_id` độc lập. Nếu hủy trước khi POST job trả HTTP 202, diagnostic
  `pending` được terminalize ngay; `job_id` về muộn vẫn bị gửi lệnh hủy nên không rò solve nặng.
- Hủy job dùng retry có giới hạn và dedupe: tối đa **3 lần**, cách nhau **120 ms**. Mỗi attempt
  có `AbortSignal` và deadline **2.000 ms**; `Promise.race` vẫn nhả cleanup nếu mock/fetch không
  phản ứng với abort. Tổng thời gian xấu nhất là 6.240 ms, không thể giữ UI "đang hủy" vô hạn.
- Không phát trạng thái `aborted` muộn sau khi generation mới đã thay thế request cũ.

### 17.4 Parity đơn vị của quality gate

Hai adapter preview/export dùng cùng hợp đồng đo sức chứa lưới:

- hệ số đổi chính xác `MM_TO_PTS = 72.0 / 25.4`;
- `grid_capacity_from_settings()` truyền `bleed` vào grid probe;
- `settings_from_preview_request()` đổi `bleed` từ point sang mm trước khi dựng settings.

Regression test khóa đối số point chính xác và propagation của `bleed`. Với khuôn thật
`default + die`, bleed không nhất thiết đổi footprint, nên test không áp một giả định hình học sai;
đây vẫn là trường bắt buộc của contract/fallback/identity để preview và export đo cùng payload.

### 17.5 Verify cuối (Windows thật, 2026-08-30)

- Backend toàn miền nesting:
  `pytest tests/ -k "nesting" -q -p no:cacheprovider` ⇒ **1098 passed, 2 skipped,
  3660 deselected**.
- Backend targeted route/parity/quality gate: **95 passed**; `py_compile` ba module liên quan = 0.
- Frontend targeted: `GridPreview.mixedDuplex.test.tsx` ⇒ **34 passed**;
  `previewDiagnosticPolicy.test.ts` ⇒ **2 passed**; `processHandlers.test.ts` ⇒ **53 passed**.
- Frontend typecheck: `npm run typecheck` = 0.
- ESLint tám file frontend chạm trong bản vá cuối = 0.

Các test frontend phủ provisional hiện trước nesting, nesting thắng thì nâng cấp, legacy terminal
không downgrade, response cùng generation không stale-overwrite, cache A→B→A khôi phục decision,
lỗi không chờ provisional treo, hủy vẫn giữ provisional, retry sau lần hủy lỗi, request hủy treo vẫn timeout sau đúng 3 lượt, và
hủy trước HTTP 202 vẫn đóng diagnostic + dọn `job_id` về muộn. Test serialization + dispatch khóa
`forceLegacyGrid` đi từ publication đã chốt tới engine export cũ, không gọi true-shape lại.

### 17.6 Runtime follow-up — cuộn file S&R nhiều trang không solve lại toàn job

Smoke trên file sản xuất 13 trang đã lộ một lỗi vòng đời sau lô verify đầu: lượt mở file solve 13
mẫu là đúng hợp đồng B10-4, nhưng đổi trang viewer làm singular shape/kích thước trang hiện hành
đổi theo, kéo theo cache key đổi và effect submit lại toàn bộ job 13 mẫu.

Bản sửa follow-up tách hai identity và hai terminal outcome:

- `allPageStepRepeatFetchKey` dùng maps hình/shape params/SL của toàn file, loại kích thước và shape
  singular của trang đang xem. Khi job đang chạy hoặc true-shape thắng, cuộn trang không cleanup,
  không gọi provisional mới và không gọi `createNestingPreviewJob` mới.
- Publication true-shape chỉ được tái dùng khi có `sheets[]` và mọi cell mang `pageIdx` nguyên.
  Viewer map trang sang sheet bằng `sheet.cells[].pageIdx`; không dùng `physicalSheetIndex` hay
  ordinal vì trang SL=0 làm danh sách sheet bị nén. Trang không có sheet giữ nguyên lựa chọn.
- Pager ◄/► vẫn độc lập: effect đồng bộ không phụ thuộc `activeSheet`, nên rerender cùng viewer page
  không kéo lựa chọn tay về lại.
- Khi quality gate, cancel hoặc failure chốt legacy, decision vẫn gắn với identity toàn file nhưng
  geometry cache dùng key per-view. Đổi trang chỉ gọi một `/imposition/preview-layout` nhẹ với
  `strategy=optimal_auto` sau 250 ms; route request-local cấm đi vào
  `createNestingPreviewJob`. Hình có tên/non-true-shape vẫn refetch per-page như trước.
- `ImposerDashboard` truyền `safePageIdx` làm danh tính viewer; `shapePageIdx` chỉ còn chọn geometry
  master/inherited.

Regression mới khóa file 13 trang ở đúng **1 provisional + 1 nesting create/result** sau khi đổi
trang và chờ quá 750 ms; khóa mapping `{pageIdx: 0, 2}` khi trang giữa có SL=0; khóa legacy scroll
chỉ thêm một grid request; và khóa named-shape per-page vẫn refetch. Hai interleaving từ semantic
review cũng được khóa: cuộn sang trang mới rồi hủy không cache/callback capacity provisional trang
cũ, và legacy decision vẫn đi tới export trong lúc probe per-view `pending` hoặc sau `failed`; pending
của identity settings mới vẫn xóa decision cũ. Verify follow-up trên Windows:
`GridPreview.mixedDuplex.test.tsx` **34/34** + `previewDiagnosticPolicy.test.ts` **2/2**,
typecheck = 0, ESLint năm file = 0, `git diff --check` = 0. Chưa chạy lại smoke thủ công trên chính
file 13 trang sau bản sửa này.

**Trạng thái B10-6: code và automated verify XONG; cần re-smoke file 13 trang để xác nhận cảm giác UI thực tế.**