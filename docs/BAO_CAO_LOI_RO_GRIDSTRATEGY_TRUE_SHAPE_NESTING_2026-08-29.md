# BÁO CÁO LỖI — `gridStrategy = true_shape_nesting` rò sang Bình cắt xén

**Ngày:** 2026-08-29
**Người báo:** session đang làm preview realtime cho Bình cắt xén (không phải session làm lô A4a/A4b)
**Thuộc lô:** A4a-3 / A4b-4 (rollout + cổng vào `true_shape_nesting`)
**Mức:** P1 — chặn hoàn toàn Bình cắt xén, người dùng không tự gỡ được từ UI ở bản phát hành
**Trạng thái:** chưa sửa. Tôi **không** chạm vào các file của lô này để tránh ghi đè công việc đang dở.

---

## 1. Hiện tượng người dùng báo

Bấm Bình ở **Bình bài xén** (guillotine, không die-cut) và nhận:

```
Không bình được trang: Nesting tối ưu theo đường bế chỉ dùng cho Bình tem bế
và Bình Bế Rớt CNC.
```

Người dùng chưa từng chọn cách xếp đó trong Bình cắt xén — vì option không hiện ở
công cụ này.

## 2. Cách tái hiện

1. Vào **Bình tem bế** (hoặc **Bình CNC**), `taskMode = nup`.
2. Mục **Cách xếp** → chọn **Nesting tối ưu theo đường bế**.
3. Chuyển sang **Bình bài xén**.
4. Bấm Bình → lỗi trên.

Ca thứ hai cùng gốc: ở bước 2 giữ nguyên công cụ, chỉ đổi sang **Bình trang
(S&R)** → lỗi `"chưa mở cho Bình trang (S&R)"` từ `_guard_scope`.

## 3. Nguyên nhân gốc

`gridStrategy` là thiết lập **lưu bền và nhớ theo profile**:

- `desktop/src/components/imposition-tools/store/slices/nupSlice.ts:85` — có trong `NUP_PERSIST_KEYS`.
- `desktop/src/components/imposition-tools/store/profiles.ts:11` — có trong danh sách khoá profile.

Còn `shouldShowTrueShapeNestingOption(...)`
(`desktop/src/components/imposition-tools/trueShapeNestingRollout.ts:66-78`) chỉ là
cổng **hiển thị**. Docstring của nó ghi *"đây là điểm chặn duy nhất"* — chỗ đó nói
quá phạm vi thật: nó chặn cái người dùng **thấy**, không chặn cái hệ thống **gửi**.

Chuỗi rò đầy đủ:

| # | Chỗ | Việc xảy ra |
|---|---|---|
| 1 | `GridSettingsSection.tsx:518` | `<select value={gridStrategy}>`. Điều kiện tắt → `<option>` biến mất, **giá trị trong store không đổi** |
| 2 | `processHandlers.ts:288` | `gridStrategy: isGuillotine \|\| isDieCut \|\| isCnc ? settings.gridStrategy \|\| 'simple_auto' : 'simple_auto'` — guillotine truyền thẳng |
| 3 | `nup_engine.py:283` | `if is_true_shape_nesting_requested(settings): return run_true_shape_nesting(...)` — chạy **trước** mọi kiểm tra công cụ |
| 4 | `nup_true_shape_nesting.py:56-68` | `is_true_shape_nesting_requested` **chỉ đọc `gridStrategy`**, không đọc công cụ |
| 5 | `nup_true_shape_nesting.py:80-83` | `_tool_from_settings` thấy guillotine không có `imposerMode=='cnc'` cũng không có `isDieCutMode` → `ValueError` |

Backend hành xử **đúng** ở bước 5. Lỗi nằm ở chỗ giá trị đến được đó.

## 4. Vì sao P1 chứ không phải P3

Cờ rollout ở dev **luôn bật**:

```ts
// trueShapeNestingRollout.ts
export function isTrueShapeNestingEnabled(isDevelopment, releaseEnabled = false) {
  return isDevelopment || releaseEnabled;
}
```

Nên chỉ cần một lần chọn thử trên bản dev là `true_shape_nesting` được ghi vào
localStorage. Nếu bản phát hành tắt cờ (`PRYNX_TRUE_SHAPE_NESTING_ENABLED=false`,
đúng mặc định HOLD hiện tại) thì:

- option **không bao giờ hiện lại** → người dùng không có đường nào chọn lại từ UI;
- giá trị đã lưu vẫn đi xuống backend → **mọi** job Bình cắt xén báo lỗi này.

Đây là trạng thái tự khoá. Vì vậy sửa logic thôi là chưa đủ, phải có migration
persist.

## 5. Đề xuất sửa

Ba lớp. Lớp 1 và 2 là bắt buộc.

### 5.1. Chuẩn hoá giá trị, không chỉ ẩn option

Thêm vào chính `trueShapeNestingRollout.ts` (giữ nguyên tính thuần, test được đủ
tổ hợp) một hàm:

```ts
export function resolveGridStrategy(params: {
  enabled: boolean;
  activeTool: string;
  taskMode: string;
  gridStrategy: string;
}): string
```

Trả về `'optimal_auto'` khi `gridStrategy === TRUE_SHAPE_NESTING_STRATEGY` mà
`shouldShowTrueShapeNestingOption(params)` là `false`; ngược lại trả nguyên giá trị.

Rồi cho **cả hai** callsite đi qua nó:

- `GridSettingsSection.tsx` — dùng cho `<select value={...}>`, để UI không hiển thị
  một lựa chọn không tồn tại;
- `processHandlers.ts:288` — dùng khi dựng `backendSettings`, để không gửi đi.

Đây đúng khuôn mẫu `store/profiles.ts` đã dùng cho `layoutType` qua
`normalizeProfileTaskMode` / `normalizeProfileLayoutType` (`profiles.ts:47-75`):
cùng vấn đề, cùng cách giải.

Vì `taskMode` đã nằm trong điều kiện, hàm này đóng luôn ca `step_repeat` ở §2.

### 5.2. Migration persist

Nâng version trong `store/persist.ts` và map `true_shape_nesting` đã lưu về
`optimal_auto`. Tiền lệ nằm ngay trong file: migration `version < 11` đã map
`inking_rows` / `inking_columns` → `simple_auto` (`persist.ts:214-232`) vì đúng lý do
này — *"để dropdown Cách xếp không bị giá trị không hợp lệ sau khi nạp lại"*.

### 5.3. KHÔNG nới cổng backend

`nup_true_shape_nesting.py` ghi rõ chủ đích *"Fail-closed, không âm thầm đổi cách
xếp"*. Quyết định đó **đúng** và nên giữ: khi người dùng thật sự chọn nesting trong
công cụ được hỗ trợ mà không chạy được thì phải báo lỗi, không được lặng lẽ rơi về
lưới grid.

Đừng sửa `is_true_shape_nesting_requested` thành có kiểm công cụ để "cho qua" —
làm vậy là biến một job người dùng đã chọn nesting thành job grid mà không nói gì,
đúng cái mà docstring của module đang cấm. Gốc bệnh ở frontend.

Nếu muốn thêm một lớp phòng thủ ở backend thì hướng an toàn là **thông báo dẫn
đường** thay vì nới cổng, ví dụ nêu rõ giá trị đến từ thiết lập đã lưu của công cụ
khác và chỉ cách đổi lại — chứ không đổi hành vi.

## 6. Lưu ý va chạm: tôi đang sửa `nup_engine.py`

Để tránh hai bên ghi đè nhau, đây là phần tôi đã thay đổi trong worktree này
(chưa commit):

| File | Thay đổi |
|---|---|
| `backend/app/workers/nup_engine.py` | Tách closure `build_chunk_args(start_sheet, end_sheet, chunk_idx)` làm **nguồn duy nhất** dựng tuple 58 args cho `process_chunk`; thêm cờ `_sheet_plan_only` cho `_run_nup_engine_impl` trả `NupSheetRenderPlan` thay vì ghi file. Không đổi một phần tử nào của tuple args. |
| `backend/app/workers/nup_sheet_render.py` | **Mới.** `NupSheetRenderPlan`, `nup_sheet_plan()`, `render_nup_sheet()` — render một tờ bằng chính `process_chunk` của export. |
| `backend/tests/test_nup_engine_sheet_plan_parity.py` | **Mới.** 32 test / 10 ca, chốt bất biến "render một tờ ≡ tờ đó trong chunk của đường xuất". |
| `backend/app/api/routes/imposition.py` | Preview Bình cắt xén đo khổ thành phẩm bằng `resolve_guillotine_trim` như export. |
| `backend/tests/test_nup_logical_cropbox.py` | +5 test parity khổ thành phẩm. |

**Nếu bạn sửa `_run_nup_engine_impl`:** nhánh `gridStrategy == 'true_shape_nesting'`
ở `nup_engine.py:283` nằm **trước** phần tôi chạm, nên hai bên không đè trực tiếp.
Nhưng vùng dựng `args_list` giờ là một closure, không còn vòng `for` inline — trace
lại trước khi sửa quanh đó.

Full suite sau thay đổi của tôi: **4425 passed, 19 skipped, 0 failed**.

## 7. Hai phát hiện phụ, không thuộc lỗi này

1. **Output N-Up không byte-reproducible.** `pdf_ops.py:580` đặt tên XObject
   `/NupXo{uid}_{page}` với `uid` từ `_stable_pdf_uid` — bộ đếm **phạm vi process**.
   Chạy cùng một job hai lượt cho tên khác nhau dù byte nội dung y hệt. Vô hại với
   bản in, nhưng nếu sau này hash nội dung artifact theo kiểu `renderBundleHash` thì
   sẽ vỡ. Test của tôi phải chuẩn hoá tên theo nội dung mới so được.

2. **`chunk_idx` chỉ vào tên file tạm và log**, không vào nội dung trang
   (`nup_process_chunk.py:1577`). Đây là lý do render một tờ riêng an toàn về kết
   cấu — nên giữ tính chất này nếu sửa quanh đó.

---

## 8. ĐÃ SỬA (2026-08-30)

Sửa theo đúng đề xuất §5 (lớp 1 + 2), **KHÔNG nới cổng backend** (§5.3 giữ nguyên).

**Lớp 1 — chuẩn hoá giá trị (không chỉ ẩn option):**
- `trueShapeNestingRollout.ts`: thêm `resolveGridStrategy({enabled, activeTool, taskMode, gridStrategy})` (thuần) + hằng `DEFAULT_GRID_STRATEGY = 'optimal_auto'`. Trả `optimal_auto` khi giá trị là `true_shape_nesting` mà `shouldShowTrueShapeNestingOption` là `false`; ngược lại giữ nguyên.
- `sections/GridSettingsSection.tsx`: `<select value={resolveGridStrategy({...})}>` — UI không còn hiển thị lựa chọn không tồn tại.
- `lib/processHandlers.ts`: `backendSettings.gridStrategy` đi qua `resolveGridStrategy` (suy `activeTool` từ `imposerMode`, `taskMode` từ `layoutType==='repeat'`) — guillotine/S&R không còn gửi `true_shape_nesting`.

**Lớp 2 — migration persist:** `store/persist.ts` nâng `version 11 → 12`, thêm `migrateLeakedNesting` map `true_shape_nesting` đã lưu → `optimal_auto` ở cả state gốc và mọi `toolProfiles` (đúng khuôn migration inking v11). Gỡ trạng thái tự khoá ở máy đã kẹt giá trị.

**Test + verify (Windows thật):**
- `trueShapeNestingRollout.test.tsx`: +6 test cho `resolveGridStrategy` (giữ ở tem bế/CNC+nup; chuẩn hoá ở guillotine / step_repeat / cờ tắt; giữ nguyên optimal_auto/simple_auto/manual).
- `useImposerSettingsStore.characterization.test.ts`: +1 test migration v11→v12; cập nhật assertion `parsed.version` 11→12.
- `npm run typecheck` sạch; `vitest run` 2 file = 37 passed; `eslint` 6 file sạch.

Còn mở: §7 (tên XObject không byte-reproducible, `chunk_idx`) là phát hiện phụ, chưa thuộc lỗi này.
