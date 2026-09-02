# Báo cáo lô §NEST-FINISHING-KEYS + §NEST-WRITER-PONT

Ngày 2026-08-28. Ba báo lỗi từ chủ dự án trên bản dev:

1. Preview không khớp kết quả chạy.
2. Không thấy tem nào được xoay, dù kết quả xếp khá kín.
3. Ốc bế và report không xuất hiện; nhiều thiết lập đang thiếu.

Lô này sửa **ốc bế** (mục 3, phần chặn sản xuất nặng nhất) và **năm lỗi ánh xạ khoá**. Mục
1 và 2 đã truy ra nguyên nhân chính xác, ghi ở cuối, chưa sửa trong lô này.

## Nguyên nhân mục 3 — nặng hơn "thiếu ánh xạ"

Ốc bế, dấu xén và report **được map đúng, validate rất kỹ, canonicalize, đưa vào
`renderBundleHash` và `layoutFingerprint`** — rồi chết ở writer.

`nesting_imposition_render.render_production_nesting` chỉ đọc **bốn** khoá của renderBundle:
`outputSides`, `parts`, `sheetFrames`, `cutStyle`. Nó không bao giờ đọc `renderBundle.marks`
(ốc + dấu xén) lẫn `renderBundle.artifactOptions` (report). Writer này được viết mới cho
lane nesting và đơn giản là **thiếu hẳn code vẽ** — không có hàm vẽ ốc, không có hàm stamp
report, không có hàm vẽ dấu xén.

Lane cũ có `nup_marks._draw_ponts_on_page` và `nup_output_finalize._stamp_reports`, nhưng
`nup_engine.py:283` `return run_true_shape_nesting(...)` trả sớm nên nhánh nesting không bao
giờ chạm tới chúng.

Điều này cũng giải thích vì sao trang CUT lại đúng: `cut.separatePage` và `cutStyle` tình cờ
nằm trong bốn khoá writer chịu đọc.

## Đã sửa: writer vẽ ốc bế

`backend/app/workers/nesting_imposition_render.py`

- `_pont_stream()` — bốn ốc góc: `circle` (hình đặc, bốn cung Bézier) và `l_corner`/
  `l_inverted` (một polyline ba điểm, miter join `0 j`).
- `_pont_corner_centers_pt()` — tâm bốn ốc, **đảo trục y đúng một lần**. Lane cũ tính trong
  hệ pymupdf top-down (`cy_T = marginTop + radius`); writer ghi toán tử PDF thô nên y đi từ
  dưới lên. Đảo thiếu hoặc đảo hai lần thì lề trên/dưới hoán vị mà **số ốc vẫn là 4**, nên
  mọi test đếm toán tử vẫn xanh — chỉ đo trên tờ mới thấy.
- `_pont_guides_stream()` — vạch guide, cùng bẫy đảo trục.
- `_pont_sides()` — ốc trên trang in, và trên trang CUT khi `cut.pontsOnCutFile`.
- Ốc vẽ **sau** artwork để hình không đè lên dấu canh của thợ.
- Màu: registration CMYK 100/100/100/100, giữ đúng `nup_marks` (`color = (1,1,1,1)`). Không
  dùng đen RGB — đen RGB chỉ lên kẽm K nên khi in tách màu ốc mất trên ba kẽm còn lại.
  Mục tiêu là **parity với lane lưới**: cùng file, cùng thiết lập ⇒ hai lane ra tờ giống nhau.
- `PRODUCTION_WRITER_VERSION` → `nesting-manifest-writer-v2-pont`.

### Đo trên file khách

`test/test nesting.pdf`, 3 mẫu, tờ 320×430mm, ốc 5mm lề 7mm, 1 guide BL:

| kiểu ốc | trang | màu reg fill | màu reg stroke | cung Bézier | `f` | `S` |
|---|---|---|---|---|---|---|
| `circle` | in | 1 | 1 | 16 | 4 | 1 |
| `circle` | CUT | 1 | 1 | 16 | 4 | 51 |
| `l_corner` | in | 0 | 2 | 0 | 0 | 5 |
| `l_corner` | CUT | 0 | 2 | 0 | 0 | 55 |

Đọc: `circle` cho 4 hình đặc (4 ốc × 4 cung = 16) + 1 guide. `l_corner` cho `S=5` = 4 góc L
+ 1 guide. Trang CUT thêm 50 nét bế. Ốc có trên **cả** trang in và trang CUT, đúng
`pontsOnCutFile=True`.

## Đã sửa: năm lỗi ánh xạ khoá

`backend/app/workers/nup_nesting_finishing.py`. Cả năm đều **im lặng** — không exception,
không log, chỉ là thiết lập của người dùng biến mất trên tờ in.

| Lỗi | Tên/hành vi sai | Đúng | Hệ quả |
|---|---|---|---|
| 1 | `guide{i}Position` | `guide{i}Pos` | `guides` **luôn rỗng** |
| 2 | `guide{i}OffsetX/OffsetY` | `guide{i}OffX/OffY` | Độ lệch guide luôn 0 |
| 3 | Bỏ qua `guide{i}Enabled` | Đọc cờ | Sửa 1+2 mà thiếu cái này thì vẽ cả guide đã tắt |
| 4 | `range(1, len(_GUIDE_POSITIONS)+1)` | `range(1, 3)` | Trộn "số vị trí hợp lệ" (4) với "số guide UI có" (2) |
| 5 | Report chỉ lọc `fieldOrder` | Lọc thêm cờ `showX` | `fieldOrder` mặc định có cả 13 field ⇒ vẽ cả field đã tắt |
| 6 | `reportLamination` chỉ nhận `int` | Nhận cả float nguyên | JSON gửi `1.0` ⇒ **mất cán màng** |

Nguồn chân lý cho từng khoá: `desktop/src/components/imposition-tools/types.ts`,
`backend/app/schemas/pont.py` (`normalize_pont_settings`),
`desktop/src/lib/reportPreview.ts` (`SHOW_FLAG_KEY`).

### Một test đã tự khoá luôn cái bug

`test_nesting_finishing_parity.py::test_oc_be_toi_duoc_job` **xanh** trước lô này, vì
fixture của nó cũng dùng `guide1Position` — sai y như bản hiện thực. Hai bên khớp nhau nên
test xác nhận một hành vi không tồn tại ngoài thực tế.

Đã sửa fixture về tên khoá thật và thêm `backend/tests/test_nup_nesting_finishing_keys.py`
(27 test) so với **nguồn chân lý** chứ không so với chính bản hiện thực. Trước lô này module
`nup_nesting_finishing` không có test đơn vị nào.

## Verify

| Hạng mục | Kết quả |
|---|---|
| `test_nup_nesting_finishing_keys.py` | 27 passed (mới) |
| `test_nesting_finishing_parity.py` | 12 passed (fixture đã sửa) |
| `test_nesting_imposition_render.py` | 32 passed (thêm 11 test ốc) |
| `test_sticker_engine_e2e.py` | 158 passed |
| Full backend | **4551 passed, 19 skipped = 4570**, khớp `--collect-only` 4570, EXITCODE=0 |
| Đối chiếu số nền | 4532 (trước lô) + 27 (keys) + 11 (ốc) = 4570 |

### Đã kiểm test bắt lỗi

| Đột biến | Kết quả |
|---|---|
| `guide{i}Pos` → `guide{i}Position` | 4 đỏ |
| Bỏ kiểm `guide{i}Enabled` | 2 đỏ |
| Bỏ lọc cờ `showX` | 2 đỏ |
| `reportLamination` về int-only | 2 đỏ |
| `pont_sides` → `frozenset()` (writer không vẽ ốc) | **9 đỏ** |
| Đảo trục y của ốc (hoán vị lề trên/dưới) | 1 đỏ — `test_le_tren_va_le_duoi_khong_bi_hoan_vi` |
| Đảo trục y của guide | 1 đỏ — `test_guide_tren_va_duoi_khong_bi_hoan_vi` |

Hai đột biến đảo trục chỉ bị bắt bởi test **đo pixel**; các test đếm toán tử đều xanh.
Đó là lý do hai test đó dùng lề bất đối xứng (trên 5mm, dưới 25mm) và probe cả vị trí
**phải trống**.

### Một bẫy quy trình gặp trong lô này

Lượt full suite đầu báo 7 lỗi ở `test_sticker_engine_e2e.py`. Chạy lại sạch: 158/158 xanh.
Nguyên nhân: tôi sửa `nesting_imposition_render.py` **trong lúc** suite đang chạy, mà file
test đó import đường writer. **Không chạy full suite nền song song với việc sửa source** —
kết quả không dùng được và tốn 13 phút.

## Mục 1 và 2: nguyên nhân đã truy ra, chưa sửa

### Mục 2 — không xoay

Miền góc server cấp là cardinal `[0, 90, 180, 270]` (`_CARDINAL_ROTATION_POLICY`,
`nesting_production_adapter.py:103`). Nhưng phương án công bố **luôn là baseline**, và
`baseline_angles(Discrete, FirstAllowed)` chỉ lấy **góc đầu tiên = 0°**
(`baseline.rs:179-190`). Bộ tối ưu — thứ duy nhất thử 90/180/270 — chưa bao giờ hoàn tất
một lượt vì nó đắt gấp ~12 lần baseline (xem
`BAO_CAO_NEST_BASELINE_UNBOUNDED_2026-08-28.md`).

Nên "nest rất kín" là công của baseline greedy; xoay chưa từng xảy ra.

Có một hướng rẻ hơn `NFP-INCREMENTAL-1` để có xoay ngay, **cần đo trước khi làm**: baseline
thử 0° trước, chỉ khi không đặt được mới thử 90/180/270. Chi phí chỉ phát sinh đúng lúc cần
xoay, không phải mọi lần. Mã đề xuất: `NEST-BASELINE-ROTATE-ON-FAIL`.

### Mục 1 — preview lệch

Hai engine khác nhau, không phải sai số. Preview đi engine lưới JS (`GridPreview.tsx`),
export đi engine nesting Rust. `NupGridSolver.ts:1031` đã chặn `true_shape_nesting` không cho
vào solver lưới, nhưng phần tính "Sức chứa" của preview vẫn đi đường cũ — nên nó báo **41**
con/tờ trong khi engine thật cho **46**.

Hai đường khác nhau thì không có cách nào khớp. Preview phải render **từ manifest**, giống
công cụ Mixed Nesting standalone đã làm (`previewGeometry.ts` + `nesting_preview_session`).

## Còn lại

| Mã | Việc | Ưu tiên |
|---|---|---|
| `NEST-WRITER-TRIM` | Writer vẽ dấu xén từ `renderBundle.marks.trim` | P0 |
| `NEST-WRITER-REPORT` | Writer stamp report từ `renderBundle.artifactOptions` | P0 |
| `NEST-PREVIEW-1` | Preview render từ manifest thay vì engine lưới | P0 |
| `NEST-BASELINE-ROTATE-ON-FAIL` | Baseline thử góc cardinal khi 0° không đặt được | P1, đo trước |
| `NFP-INCREMENTAL-1` | Miền hợp lệ tăng dần — chỗ có 10–100× | P1 |
| `NEST-CUTSTYLE-UI` | `build_cut_style_spec` còn trả mặc định; UI chưa có ô | P2 |
| `NEST-EXPORT-UNIQUE` | `exportUniqueSheets` chưa được writer dùng | P2 |
