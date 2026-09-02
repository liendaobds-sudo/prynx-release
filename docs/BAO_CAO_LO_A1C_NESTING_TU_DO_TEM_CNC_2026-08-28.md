# BÁO CÁO LÔ A1c — THỐNG NHẤT HÀNH VI IN VÙNG LỖ

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ hai
**Trạng thái:** **PASS** — chờ duyệt để sang Lô A2

---

## 1. Mã lô và mục tiêu

Đóng finding **C0-9** phát hiện ở Chặng 0: hai lane render đang in vùng lỗ **ngược nhau**.

| Lane | Toán tử clip | Vùng lỗ / cửa sổ | Bằng chứng |
|---|---|---|---|
| Legacy (mọi job tem/CNC đang chạy) | `W n` nonzero, `_polygon_from_rings` bỏ lỗ | **CÓ mực** | `pdf_ops.py:606, 618`; `nup_clip_shape.py:115, 133-135` |
| Manifest mới (WIP) | `W* n` even-odd, giữ lỗ | **TRẮNG** | `imposition_pdf_form.py:625` + test raster |

Quyết định của chủ sản phẩm ở cổng Chặng 0, §7.2 câu 1: **phương án (a)** — giữ hành vi in hiện hữu của xưởng, vùng lỗ **vẫn in mực**, dao mới là thứ cắt. Lô này sửa lane mới cho khớp lane sản xuất.

---

## 2. File đã đổi — chính xác 4 file

| File | Loại | Thay đổi |
|---|---|---|
| `backend/app/workers/nup_clip_shape.py` | tracked modified | `build_manifest_clip_rings` chỉ trả vòng ngoài, cố ý bỏ lỗ |
| `backend/app/workers/imposition_pdf_form.py` | intent-to-add | `_clip_stream` phát `W n` thay cho `W* n` |
| `backend/tests/test_nup_clip_shape_render.py` | tracked modified | Đảo kỳ vọng test artifact + thêm 1 test bạn đôi cho lớp CUT |
| `backend/tests/test_imposition_pdf_form.py` | intent-to-add | Sửa test transform vốn đọc vòng lỗ từ artwork clip |

Không chạm adapter, bundle, route, UI, Rust. Không cập nhật golden. Không stage, không commit.

---

## 3. Contract và bất biến đã đóng

### 3.1. Tách rõ hai lớp dùng hai tập ring khác nhau

Điểm cốt lõi: **CUT cần lỗ, artwork clip thì không.** Trước lô này cả hai đi qua cùng một hàm nên buộc phải dùng cùng tập ring.

| Hàm | Tập ring | Dùng cho |
|---|---|---|
| `transform_manifest_polygon_rings` | outer **+ holes** | lớp CUT — dao vẫn cắt cửa sổ |
| `build_manifest_clip_rings` | **chỉ outer** | artwork clip — mực vẫn in trong cửa sổ |

Tách ở tầng builder chứ không ở tầng painter, để không ai phải nhớ truyền đúng tập ring cho từng lớp.

### 3.2. Vì sao không dùng hướng vòng để phân biệt outer và hole

Cách "tự nhiên" là kiểm dấu diện tích: outer CCW, hole CW. Cách đó **sai** ở đây, và đây là chỗ dễ mắc bẫy:

`_assert_unit_isometry(sheet_frame, determinant_sign=None)` (`imposition_affine.py`) **cho phép det = −1** cho SheetFrame, vì mặt sau CNC là phép phản chiếu thật (`[-1, 0, 0, 1, W, 0]`). Mirror **đảo dấu diện tích**, nên một vòng ngoài CCW của mặt trước trở thành CW ở mặt sau. Kiểm hướng trên ring đã biến đổi sẽ **từ chối oan** artwork mặt sau CNC.

Test `test_clip_va_form_cung_sheetframe_g[sheet_frame1--1]` đang khoá đúng ca det = −1 này, nên nếu tôi đi đường hướng vòng thì nó sẽ đỏ.

Cách đúng: phân biệt **trước** khi biến đổi, nơi cấu trúc còn tường minh. `RenderPolygonV1` có đúng một `outer` + danh sách `holes`, nên artwork clip luôn ra **đúng một ring** — bất biến ở cấp cấu trúc, không cần suy luận hình học. Có assert canh điều đó.

### 3.3. Painter này chỉ vẽ artwork, đã xác minh

Thay đổi chỉ an toàn nếu CUT không đi qua painter đang sửa. Đã xác minh hai lớp chặn:

- `embed_manifest_page_form` từ chối mọi `form_variant` khác `RAW_FORM_VARIANT` (`imposition_pdf_form.py:462-465`), thông điệp: *"formVariant chưa được materialize; không được chỉ đổi cache key để giả lập tách CUT"*.
- `render_manifest_artwork` từ chối `placement.side == "cut"` (`nup_artwork.py:1386-1389`), thông điệp: *"CUT phải đi writer vector riêng, không được paint như artwork"*.

Nên đổi `_clip_stream` không thể ảnh hưởng lớp CUT.

---

## 4. Lệnh test và kết quả

### 4.1. Phạm vi hẹp quanh vùng sửa

```powershell
backend\venv\Scripts\python.exe -m pytest backend/tests/test_nup_clip_shape_render.py `
  backend/tests/test_imposition_pdf_form.py -q
```

```
22 passed, 1 warning in 3.06s
```

Chi tiết file clip:

```
test_manifest_clip_vung_lo_van_duoc_in_muc_tren_artifact PASSED
test_manifest_cut_rings_van_giu_lo_de_dao_cat            PASSED
```

### 4.2. Bộ verify bắt buộc (7 file + test A1b)

```
337 passed, 1 warning in 15.11s
```

Lô A1 để lại 336; chênh **+1** đúng bằng test bạn đôi mới cho lớp CUT.

### 4.3. Toàn bộ backend

```
4163 passed, 19 skipped, 3 warnings in 508.52s (0:08:28)
```

### 4.4. Cargo, typecheck, vitest

| Lệnh | Kết quả |
|---|---|
| `cargo test --manifest-path imposition_core/Cargo.toml -q` | 292 passed, 0 failed |
| `npm.cmd run typecheck` | exit 0, không diagnostics |
| `npx.cmd vitest run` (mixed-nesting) | 7 file, 234 passed |
| `py_compile` 4 file | exit 0 |
| `git diff --check` | exit 0 |

### 4.5. Hai mutation test — chứng minh test có bắt lỗi

Đổi kỳ vọng test là việc dễ bị lạm dụng, nên tôi chứng minh test mới **thật sự khoá hành vi**, không phải nới cho xanh.

**Mutation 1 — trả lỗ về artwork clip** (`holes=()` → `holes=frozen.holes`):

```
4 failed, 18 passed
  test_manifest_clip_vung_lo_van_duoc_in_muc_tren_artifact   FAILED
  test_manifest_cut_rings_van_giu_lo_de_dao_cat              FAILED
  test_clip_va_form_cung_sheetframe_g[sheet_frame0-1]        FAILED
  test_clip_va_form_cung_sheetframe_g[sheet_frame1--1]       FAILED
```

Test raster bắt được vì với `W n` và vòng lỗ ngược hướng, nonzero **vẫn khoét** lỗ → điểm trong lỗ trở lại trắng.

**Mutation 2 — đổi lại `W* n`:**

```
1 failed, 5 passed
  test_manifest_clip_vung_lo_van_duoc_in_muc_tren_artifact   FAILED
```

Mutation 2 chỉ bị bắt bởi hai assert trên content stream (`"W n" in raw`, `"W* n" not in raw`), **không** bị bắt bởi raster — vì với một ring duy nhất, even-odd và nonzero cho cùng kết quả hình. Đây chính là lý do phải assert cả toán tử, không chỉ pixel: nếu ai đó vừa đổi lại `W*` vừa trả lỗ vào clip thì raster mới đỏ, mà lúc đó đã muộn.

Đã hoàn nguyên cả hai mutation, chạy lại: **22 passed**.

### 4.6. Mức bằng chứng

| Hạng mục | Trạng thái |
|---|---|
| Hành vi in vùng lỗ của lane manifest | **ARTIFACT** — parse content stream thật + raster PDF thật, đo điểm trong outer và trong lỗ |
| Lớp CUT giữ lỗ | **AUTO** |
| Writer production đầy đủ | **UNKNOWN** — vẫn là stub, việc của A3 |
| Tauri end-to-end | **UNKNOWN** — lô này không chạm UI |

---

## 5. So sánh baseline solver

**Không áp dụng.** A1c không chạm solver. `placedCount`, `sheetCount`, compactness, runtime, RAM không đổi.

---

## 6. Finding

### 6.1. A1-1 — ĐÃ ĐÓNG, không cần sửa code

`backend/app/workers/imposition_pdf_form.py.rej` có **đúng một hunk** (8 dòng), nội dung là đổi lời gọi `embed_manifest_page_form(destination_pdf, source_pdf, ...)` thành `source_path=source_path`. Đã đối chiếu file thật:

```python
    embedded = embed_manifest_page_form(
        destination_pdf,
        source_path=source_path,
        locator_id=locator_id,
        source_revision=source_revision,
```

Trạng thái đích của hunk **đã có trong file**. Nên `.rej` này không mang thay đổi nào chưa áp — nó là rác của một lần apply patch thất bại rồi sau đó được làm bằng đường khác. **An toàn để xoá.** Tôi không tự xoá vì nó thuộc nhóm scratch chưa xác định chủ; đề nghị chủ dự án xoá cùng đợt dọn 22 file scratch.

### 6.2. Baseline Chặng 0 đã STALE — phiên khác đã commit

Trong lúc tôi làm A1c, một phiên khác đã hoạt động trên cùng repo. Đây là thay đổi ngoài phạm vi của tôi, nhưng nó làm **mất hiệu lực** ảnh chụp trong báo cáo Chặng 0, nên phải ghi lại:

| Hạng mục | Chặng 0 (đầu phiên) | Bây giờ |
|---|---|---|
| HEAD | `c863931` | **`8bc0a21`** `fix(vong-doi-tien-trinh): don sach tien trinh con khi tat app va khi cap nhat` |
| Đồng bộ remote | 0 ahead / 0 behind | **ahead 1** (chưa push) |
| Tổng mục worktree | 95 | **111** |
| Toàn backend | — | 4115 → 4163 passed |

Commit `8bc0a21` (tác giả `kane8800`, 19:23) gồm 15 file thuộc workstream **vòng đời tiến trình** hoàn toàn khác: `office_job_runner.py`, `main.py`, `process_guard.rs`, `lib.rs`, `installer-hooks.nsh`, `AboutModal.tsx`, `UpdateChecker.tsx`, cùng 3 file docs. **Không có file nào của lô A1/A1c trong đó** — tôi đã kiểm `git show --stat` và xác nhận mọi thay đổi của mình còn nguyên trong worktree.

+48 test của toàn backend đến từ phiên đó (`test_office_orphan_sweep.py`, `test_free_token_e2e.py`, `test_pro_feature_enforcement_coverage.py`, `test_sticker_sheet_feature_gate.py`), không phải từ lô này. Đã đối chiếu bằng timestamp file.

Đây đúng là tình huống `prynx-testing` cảnh báo: ảnh chụp `git status` đầu phiên lỗi thời ngay khi phiên khác commit. **Cần re-baseline lại trước khi merge**, và người quyết định push phải biết đang có 1 commit chưa push không thuộc đợt nesting.

### 6.3. Finding còn mở, không đổi so với A1

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| C0-4 | Adapter hardcode `gapMm = 0.0` và `orientationPolicy = free` | P1 | **A2** |
| C0-2 | `nesting_imposition_render.py` còn là stub | P0 cho Chặng A | A3 |
| C0-3 | `GridStrategy` chưa có `true_shape_nesting` ở cả ba nơi | P1 | A4a |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cả run | `[SUSPECTED]` | Chặng B, đo trước |
| A1-2 | Toàn suite có thể crash native trong PDFium khi có thread nền `combine_jobs._sweep_loop` | P2, `[SUSPECTED]` | Đợt bọc `pdfium_guard()` |

Lượt chạy toàn suite của A1c **không** gặp lại crash A1-2 (đây là lượt sạch thứ ba trên bốn).

---

## 7. Kết luận

**PASS.**

- Hai lane render giờ in vùng lỗ **giống nhau**, theo đúng hành vi xưởng đang dùng.
- CUT vẫn giữ lỗ; có test bạn đôi để nếu ai gộp hai đường lại thì đúng một trong hai test sẽ đỏ.
- Việc đổi kỳ vọng test được ghi rõ là **có chủ đích** trong docstring của chính test, kèm trỏ về §7.2 và C0-9, để người sau không hiểu là "sửa cho xanh".
- Có hai mutation test chứng minh test khoá được hành vi ở cả mức content stream và mức raster.
- Không hồi quy: 336 → 337 trong bộ bắt buộc; toàn backend 4163 passed / 0 failed.
- A1-1 đóng lại không cần sửa code.

---

## 8. Lô tiếp theo — A2

**Lô A2 — adapter/manifest/intent (≤5 file).** Nội dung theo prompt bàn giao và các quyết định đã duyệt:

- Bỏ hardcode `gapMm = 0.0` và `orientationPolicy.defaultRotation.mode = "free"` (C0-4); **khoá cardinal** `[0, 90, 180, 270]` cho Chặng A.
- Map `gapX/gapY` vào `clearance.partToPart` theo quyết định §7.3 (a); `partToObstacle` cho override riêng; bỏ chỗ nén `gap = max(gap_x, gap_y)` ở `cnc_render.py:360`.
- Thêm `autofill_single_sheet` và `quantity_fulfillment` với ngữ nghĩa một-tờ-rồi-nhân.
- Fixed obstacles cho boong/nhíp/dấu canh, **kiểm lại sau bước recenter** theo quyết định §7.1 (a).
- Baseline candidate + provenance; stale source; commit fence.
- Tuyệt đối không gọi `/mixed-nesting/jobs` lồng trong N-Up.

Trước khi bắt đầu A2, đề nghị chủ dự án xác nhận hai điểm ở §6.2: có chấp nhận baseline đã dịch sang `8bc0a21` hay không, và commit chưa push đó xử lý thế nào.
