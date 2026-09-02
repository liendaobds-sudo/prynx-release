# BÁO CÁO LÔ A1 — CONTRACT NÉT BẾ VÀ KHOÁ PATH ITEM

**Ngày:** 2026-08-28
**Chặng:** A (canary đường production cho gang, khoá cardinal) — lô đầu tiên
**Nhánh:** `codex/pre-release-audit-2026-08-04`, HEAD `c863931` (không commit trong lô này)
**Cổng Chặng 0:** đã được chủ sản phẩm duyệt ngày 2026-08-28
**Trạng thái:** **PASS** — chờ duyệt để sang lô kế

---

## 1. Mã lô và mục tiêu

Theo `docs/PROMPT_BAN_GIAO_NESTING_TU_DO_TEM_CNC_2026-08-28.md`, Lô A1 phải đóng hợp đồng nét bế trong RenderBundle V2 và sửa khoá path item cho mảng số. **Không nối UI, không đổi solver, không đổi hành vi in.**

Lô được **tách thành hai** vì gộp lại sẽ vượt trần 5 file:

| Lô | Mục tiêu | Số file |
|---|---|---:|
| **A1a** | `RenderCutSourceFilterV2` / `RenderCutStrokeV2` / `RenderCutStyleV2` strict + canonical 6 chữ số + hash/reconstruction sau restart + simplex/CNC duplex độc lập | 4 |
| **A1b** | `_path_item_key` đọc được cả mảng số, có kiểm arity, không ném lỗi | 2 |

Prompt đề xuất gộp cả 6 việc vào một lô 5 file, nhưng khi tính đủ **nơi chứa test** cho `_path_item_key` thì thành 6 file. Quy tắc bất di bất dịch #15 nói rõ: cần file thứ 6 thì tách lô. Tôi tách, và mỗi lô đều có test riêng ở đúng chỗ.

---

## 2. File đã đổi — chính xác

### Lô A1a (4 file)

| File | Loại | Thay đổi |
|---|---|---|
| `backend/app/core/nesting_production_adapter.py` | WIP untracked | 3 dataclass mới + 5 hàm canonical mới; `cutStyle` vào `RenderBundleV2`, vào parse, vào đường dựng lại sau restart |
| `backend/app/core/nesting_imposition_bundle.py` | WIP untracked | 3 spec typed mới + `cut_style` trong `ImpositionRenderContext` + hàm `_cut_style()` validate và phát ra bundle |
| `backend/tests/test_nesting_imposition_bundle.py` | WIP untracked | +54 test cho contract nét bế |
| `backend/tests/test_nesting_production_lifecycle.py` | WIP untracked | helper `_cut_style()` cho `_bundle()`; +5 test vòng đời manifest |

### Lô A1b (2 file)

| File | Loại | Thay đổi |
|---|---|---|
| `backend/app/workers/nup_artwork.py` | tracked modified | `_path_item_coords()` mới; `_path_item_key()` viết lại; `_numeric_path_item_key()` thành alias; `_path_matches_target_items()` fail-closed |
| `backend/tests/test_nup_artwork_path_key.py` | **mới** | 22 test cho khoá path item |

Không chạm `imposition_pdf_form.py`, không chạm route, không chạm UI, không chạm `imposition_core`/`native`, không cập nhật golden, không stage, không commit.

---

## 3. Contract và bất biến đã đóng

### 3.1. `cutStyle` — nét bế thành dữ liệu bất biến

Trước lô này, bundle mang `marks.cut` (nét bế đi ra **trang nào**, dày mỏng khối chèn, chế độ khổ khuôn) nhưng **không** mang hai thứ writer bắt buộc phải biết:

- **nhận diện** nét bế trong file nguồn bằng tiêu chí gì;
- **vẽ** nét CUT ra tờ bằng màu và độ dày nào.

Hai thứ đó đang nằm rải trong tham số runtime (`target_color`, `target_spot`, `die_names_lower`). Nếu để vậy, preview và export có thể chọn **hai tập nét khác nhau** trên cùng một file mà không ai phát hiện — đúng loại lỗi mà nguyên tắc "preview và export dùng cùng một manifest" tồn tại để chặn.

Contract mới, đặt ở gốc bundle:

```json
"cutStyle": {
  "sourceFilter": {
    "mode": "spot",
    "spotNames": ["cutcontour"],
    "processColor": null,
    "colorTolerance": 0.01,
    "dieLayerNames": [],
    "geometryToleranceMm": 0.1
  },
  "stroke": {
    "widthMm": 0.25,
    "colorSpace": "cmyk",
    "components": [0.0, 1.0, 0.0, 0.0],
    "separationName": null,
    "overprint": false
  }
}
```

Bất biến được khoá:

1. **Hai tiêu chí nhận diện không được song song.** `mode=spot` bắt buộc có `spotNames` và bắt buộc `processColor=null`; `mode=process` bắt buộc ngược lại. Không có đường nào cho writer phải tự chọn giữa hai tiêu chí.
2. **Đúng số kênh màu theo không gian màu**: cmyk 4, rgb 3, gray 1, separation 1. Mỗi kênh trong `[0..1]`.
3. **`separationName` chỉ tồn tại khi `colorSpace=separation`**, và bắt buộc có khi đó.
4. **Miền vật lý có trần**: `widthMm` trong `(0, 10]`, `colorTolerance` trong `[0, 0.5]`, `geometryToleranceMm` trong `(0, 1]`. Nét bế dày 50mm là lỗi nhập, không phải lựa chọn nghiệp vụ.
5. **Tên được chuẩn hoá một lần, ở một chỗ**: NFC, cắt khoảng trắng biên, hạ chữ thường, loại trùng, sắp theo byte UTF-8, tối đa 128 ký tự, không ký tự điều khiển. Nhờ vậy `"  CutContour  "` và `"cutcontour"` không tạo hai fingerprint khác nhau cho cùng một ý định.
6. **Số lượng tử đúng 6 chữ số** qua `_quantized_float`, nên `0.2500004` và `0.25` cho cùng hash.
7. **Từ chối boolean, NaN, Inf, field lạ, field thiếu** ở mọi tầng. `overprint` phải là `bool` thật, không nhận `1`.
8. **Một bundle chỉ có MỘT `cutStyle`** — nằm ở gốc, không nằm trong từng side hay từng part. Front/Back/Cut của cùng tờ **không thể** lệch nét bế; bất biến này được bảo đảm ở cấp kiểu, không cần test canh.
9. **`cutStyle` là đầu vào authoritative, không phải giá trị dẫn xuất.** Đường dựng lại sau restart (`_resolver_bundle_from_canonical`) giữ nguyên nó và canonicalize lại để phát hiện file bị sửa. Đổi `cutStyle` là đổi `renderBundleHash`, `inputHash` và `layoutFingerprint` — manifest cũ thành stale, đúng như hợp đồng #9 của prompt.

Builder (`nesting_imposition_bundle.py`) áp **cùng luật** với adapter và chặn sớm, để người dùng nhận lỗi ở tầng đúng chứ không phải ở biên adapter.

Mặc định chọn theo thói quen file khách Việt Nam: nhận nét bế theo kênh spot `cutcontour`, vẽ ra bằng Magenta 100% CMYK dày 0,25mm. Mặc định này giữ mọi test builder cũ xanh không cần sửa.

### 3.2. `_path_item_key` — sửa một lỗi sẽ nổ ở lô A2/A3

Đây là phát hiện đáng kể của lô, và nó **nặng hơn** mô tả trong prompt.

Prompt ghi "sửa `_path_item_key` cho numeric array", nghe như một chỗ trả `None` sai. Thực tế đo được:

```
>>> _path_item_key(('l', 0.0, 0.0, 10.0, 0.0))
AttributeError: 'float' object has no attribute 'x'
```

Hàm **ném lỗi**, không phải trả `None`. Và caller tại `nup_artwork.py:948-953` bọc mọi exception thành:

```python
raise RuntimeError(f"Không thể tách đường khuôn bế khỏi trang in {src_page_idx + 1}.")
```

Nên hệ quả là **hỏng cả job bình** với thông điệp chỉ sai chỗ. Người dùng sẽ đi kiểm file nguồn trong khi lỗi nằm ở kiểu dữ liệu nội bộ.

Vì sao nó sẽ nổ ở A2/A3: hai bên so khớp tới từ hai producer khác nhau và dùng hai dạng dữ liệu khác nhau.

| Bên | Nguồn | Dạng item |
|---|---|---|
| `target_items` | `pdf_content_parser` → `die_items_cache['items']` | object `Point`/`Rect` |
| `current_path` | `strip_color_from_stream` dựng tại chỗ | mảng số phẳng |

Hôm nay cặp này khớp vì mỗi bên dùng đúng hàm khoá của mình. Nhưng manifest production mang `cutContour` dạng **mảng số** (`RenderPolygonV1`). Ngay khi A2/A3 truyền contour từ manifest vào `target_items`, bên target thành mảng số → hàm khoá ném lỗi → job hỏng.

Bản vá:

1. `_path_item_coords()` trải item về danh sách toạ độ phẳng, chấp nhận **cả hai dạng** (`Point`/`Rect` tự trải qua `__iter__`), từ chối `bool`, chuỗi, `None`, object không trải được.
2. `_path_item_key()` kiểm **arity theo lệnh**: `l`=4, `c`=8, `re`=4. Sai arity trả `None` chứ không đoán bù.
3. Chuẩn hoá `re` về `(min, max)` để hai nguồn dựng rect theo thứ tự góc khác nhau vẫn cho cùng khoá.
4. Từ chối NaN/Inf (trước đây `int(round(inf))` ném `OverflowError`).
5. **Không bao giờ ném lỗi** — hàm nằm trong vòng quét content stream của mọi job bình.
6. `_numeric_path_item_key()` giờ chỉ là alias. Hai hàm khoá song song chính là gốc của lỗi này; để hai đường tồn tại là mời lỗi quay lại.

### 3.3. Một bất biến an toàn được làm tường minh

`_path_matches_target_items()` trước đây **bỏ qua** item không khoá được (`if key is not None`). Với bản vá, số item không khoá được tăng lên (arity sai, NaN…), nên hành vi "bỏ qua" trở thành nguy hiểm: candidate bị thu nhỏ, trông như tập con của target, và toán tử vẽ bị đổi thành no-op — **xoá mất artwork của khách**.

Đổi thành fail-closed: nét nào không khoá được thì trả `False` ngay, không xoá. Lý do chọn hướng này: giữ lại nét bế là lỗi **thấy được trên preview**; xoá mất artwork chỉ lộ ra **khi đã in**.

Hôm nay `current_path` luôn có arity đúng nên thay đổi này không đổi hành vi thực tế, nhưng nó biến một giả định ngầm thành một bất biến có test.

---

## 4. Lệnh test và kết quả

Chạy trên Windows thật của dự án, `backend/venv` Python 3.11.9.

### 4.1. Bộ verify bắt buộc của prompt (7 file)

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nesting_imposition_bundle.py `
  backend/tests/test_nesting_production_lifecycle.py backend/tests/test_nesting_source_geometry.py `
  backend/tests/test_imposition_affine_parity.py backend/tests/test_imposition_pdf_form.py `
  backend/tests/test_nup_clip_shape_render.py backend/tests/test_die_detection_page_contour.py -q
```

```
314 passed, 1 warning in 9.08s
```

Baseline Chặng 0 là **255 passed**. Chênh **+59** đúng bằng số test mới (54 ở A1a + 5 ở lifecycle). Không test cũ nào đổi kết quả.

Thêm file test của A1b vào cùng lượt:

```
336 passed, 1 warning in 9.90s
```

### 4.1b. Cargo, typecheck, vitest

Lô này không chạm Rust hay TS, nhưng vẫn chạy đủ theo verify bắt buộc:

| Lệnh | Kết quả |
|---|---|
| `cargo test --manifest-path imposition_core/Cargo.toml -q` | **292 passed, 0 failed** (không đổi so với baseline) |
| `npm.cmd run typecheck` | **exit 0**, không diagnostics |
| `npx.cmd vitest run src/components/mixed-nesting src/lib/mixed-nesting src/stores/useMixedNestingStore.test.ts` | **7 file, 234 passed** |

### 4.2. Test riêng của A1b

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nup_artwork_path_key.py -q
```

```
22 passed, 1 warning in 1.91s
```

### 4.3. Phạm vi hẹp quanh vùng đã sửa

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nup_artwork_path_key.py `
  backend/tests/test_nup_clip_shape_render.py backend/tests/test_nesting_imposition_bundle.py `
  backend/tests/test_nesting_production_lifecycle.py -q
```

```
238 passed, 1 warning in 12.91s
```

### 4.4. Toàn bộ backend suite

Ngoài phạm vi verify bắt buộc, tôi chạy cả `backend/tests` để chắc không có consumer nào khác của bundle bị vỡ:

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests -q
```

```
4115 passed, 19 skipped, 3 warnings in 872.24s (0:14:32)
```

Không có test nào fail trong toàn bộ backend.

### 4.5. Tĩnh

- `py_compile` 6 file đã đổi: exit 0.
- `git diff --check`: exit 0.

### 4.6. Kiểm chứng test có thật sự bắt lỗi (mutation test)

Test xanh không chứng minh test có giá trị. Tôi cố tình bỏ dòng giữ `cutStyle` trong `_resolver_bundle_from_canonical` rồi chạy lại:

```
22 failed, 189 passed
```

Trong đó có đúng hai test mới của lô:

- `test_cut_style_song_sot_qua_persist_va_load_lai_nguyen_byte` — FAILED
- `test_cut_style_bi_sua_tren_dia_thi_load_fail_closed` — FAILED

Đã hoàn nguyên file và chạy lại: **211 passed**. Test bắt được lỗi thật, không xanh vô nghĩa.

### 4.7. Kiểm chứng bản vá A1b trên chính ca gây lỗi

Trước bản vá:

```
>>> _path_item_key(('l', 0.0, 0.0, 10.0, 0.0))
AttributeError: 'float' object has no attribute 'x'
```

Sau bản vá:

```
num_line -> ('l', 0, 0, 100, 0)
match target dang so : True
match target dang obj: True
```

### 4.8. Một lần crash PDFium khi chạy toàn suite — đã điều tra, không thuộc lô này

Lượt chạy toàn suite ĐẦU TIÊN bị **crash native** (faulthandler dump, không phải test fail) ở khoảng 71%:

```
Current thread ... File "pypdfium2/_helpers/document.py", line 367 in get_page
  File "app/core/geometry_reader.py", line 247 in _list_objects_locked
  File "backend/tests/test_move_text_multi_run.py", line 202 in
      test_move_hotline_does_not_corrupt_email_run
```

Trong dump còn một thread nền đang sống: `app/core/combine_jobs.py:212 in _sweep_loop`.

Điều tra:

1. `test_move_text_multi_run.py` chỉ import `app.core.geometry_reader` và `app.core.stream_editor` — **không** import file nào tôi sửa.
2. Chạy riêng file đó: **4 passed**, không crash.
3. Chạy lại toàn suite **hai lượt** sau đó: **4093 passed / 19 skipped** và **4115 passed / 19 skipped**, không lượt nào crash.

Kết luận: đây là **crash không tất định của PDFium khi chạy cả suite trong một process**, có thread nền `combine_jobs._sweep_loop` sống song song — đúng loại rủi ro mà AGENTS.md #3 đã nêu và việc bọc `pdfium_guard()` cho module cũ đang làm theo lô. Nó **không** do lô A1: file crash không nạp module nào của lô, và pass khi chạy riêng.

Điều tôi **chưa chứng minh được**: race cụ thể giữa `_sweep_loop` và `geometry_reader`. Tôi không tái hiện lại được crash nên không thể chỉ đúng cặp lời gọi. Ghi thành finding A1-2 để đợt bọc `pdfium_guard()` xử lý, không sửa trong lô này.

---

## 5. So sánh baseline solver

**Không áp dụng cho lô này.** A1 không chạm `imposition_core`, `native`, hay bất kỳ đường solver nào. `placedCount`, `sheetCount`, compactness, runtime và RAM **không đổi** vì không có code nào trên đường tính toán bị sửa. Số solver vẫn là số Lô 0 ngày 27-08.

---

## 6. Bằng chứng artifact và runtime

| Hạng mục | Trạng thái |
|---|---|
| Contract `cutStyle` | **AUTO** — 59 test, có mutation test chứng minh test bắt lỗi |
| Khoá path item | **AUTO** — 22 test, kèm tái hiện trực tiếp ca ném lỗi |
| PDF artifact do writer production tạo | **UNKNOWN** — writer vẫn là stub 87 byte, đây là việc của Lô A3 |
| Preview ↔ export cùng manifest trên PDF thật | **UNKNOWN** |
| Tauri dev / installed / release | **UNKNOWN** — chưa chạy `run_dev.bat`; lô này không chạm UI nên không có gì để thao tác tay |

Không lô nào trong A1 nâng được trạng thái lên `ARTIFACT` hay `RUNTIME`, và tôi không tuyên bố ngược lại.

---

## 7. Finding còn mở

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| C0-9 | Hai lane render in vùng lỗ ngược nhau. Chủ sản phẩm đã duyệt phương án (a): giữ hành vi legacy, in mực trong lỗ. Cần đổi `imposition_pdf_form.py:625` từ `W* n` sang `W n` và đảo kỳ vọng test `test_manifest_clip_outer_hole_even_odd_tren_artifact` | P1 | **A1c** (2 file) |
| C0-4 | Adapter còn hardcode `gapMm = 0.0` và `orientationPolicy.defaultRotation.mode = "free"` tại `nesting_production_adapter.py:1679-1683, 1705-1711`. Chặng A phải khoá cardinal, và `gapX/gapY` phải map vào 3 lớp clearance theo quyết định §7.3 | P1 | **A2** |
| C0-3 | `GridStrategy` chưa có `true_shape_nesting` ở cả ba nơi; hai hợp đồng enum Rust và union chuỗi thủ công đang song song | P1 | **A4a** |
| C0-2 | `nesting_imposition_render.py` còn là stub | P0 cho Chặng A | **A3** |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cho cả run, nghi là nguyên nhân profile không đơn điệu | `[SUSPECTED]` | Chặng B, đo trước |
| A1-1 | `backend/app/workers/imposition_pdf_form.py.rej` vẫn nằm cạnh file intent-to-add cùng tên. Tôi **không** đối chiếu trong lô này vì nó thuộc phạm vi A1c/A3 và sẽ làm lô này vượt file | P3 | A1c |
| A1-2 | Chạy `pytest backend/tests` toàn bộ có thể **crash native** trong PDFium (`geometry_reader._list_objects_locked` → `pypdfium2.get_page`) khi thread nền `combine_jobs._sweep_loop` còn sống. Quan sát được 1 lần trong 3 lượt; không tái hiện lại được nên chưa chỉ được race cụ thể. Không do lô A1 — xem §4.8 | P2, `[SUSPECTED]` | Đợt bọc `pdfium_guard()` |

Phát sinh mới trong lô: **một** finding hạ tầng test (A1-2), không phải hồi quy của lô.

---

## 8. Kết luận

**PASS** cho cả A1a và A1b.

- Contract nét bế đã đóng, strict, có mutation test chứng minh test bắt lỗi.
- Một lỗi sẽ làm hỏng job ở lô A2/A3 đã được chặn trước, kèm tái hiện.
- Một bất biến an toàn ngầm đã thành bất biến có test.
- Không hồi quy: bộ verify bắt buộc 255 → 314 passed, chênh đúng bằng số test mới; toàn backend 4115 passed / 19 skipped / 0 failed.
- Không chạm solver, không chạm UI, không đổi hành vi in, không commit.

Một crash PDFium khi chạy toàn suite đã được điều tra và loại trừ khỏi lô này (§4.8), ghi lại thành finding A1-2.

Deviation duy nhất so với prompt: tách A1 thành A1a/A1b thay vì một lô 5 file, vì tính đủ nơi chứa test thì thành 6 file. Đã nêu lý do ở §1.

---

## 9. Lô tiếp theo

Đề xuất theo thứ tự rủi ro giảm dần:

**Lô A1c — đóng C0-9 (2 file).** `imposition_pdf_form.py` đổi `W* n` → `W n` và bỏ lỗ khỏi clip theo quyết định đã duyệt; `test_nup_clip_shape_render.py` đảo kỳ vọng test even-odd và ghi rõ đây là đổi **có chủ đích** theo cổng Chặng 0, không phải sửa cho xanh. Kèm đối chiếu `imposition_pdf_form.py.rej`.

Làm A1c trước A2 vì nó là quyết định nghiệp vụ đã chốt, và để càng lâu thì càng nhiều code mới xây trên ngữ nghĩa sai.

**Lô A2 — adapter/manifest/intent (≤5 file).** Bỏ hardcode `gapMm`/`free`, khoá cardinal cho Chặng A, map `gapX/gapY` vào `part_to_part` với `part_to_obstacle` override riêng theo §7.3, thêm `autofill_single_sheet`/`quantity_fulfillment`, fixed obstacles có kiểm lại sau recenter theo §7.1, baseline candidate + provenance, stale source, commit fence.

Không tự mở rộng phạm vi. Chờ duyệt báo cáo này trước khi bắt đầu A1c.
