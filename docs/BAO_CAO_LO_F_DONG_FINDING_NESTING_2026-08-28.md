# BÁO CÁO LÔ F — ĐÓNG DANH SÁCH FINDING TỒN

**Ngày:** 2026-08-28
**Chặng:** A — đợt dọn finding, xen giữa A4a-3 và A4b
**Trạng thái:** **PASS**

---

## 1. Mục tiêu

Xử lý toàn bộ finding còn mở sau A4a-3. Không phải finding nào cũng đóng bằng cách sửa code: ba trong số đó đóng bằng **đo và bác bỏ**, và một cái phải **dừng lại chờ chủ dự án** vì nó đổi hành vi sản xuất.

| Mã | Kết quả | Cách đóng |
|---|---|---|
| A4a-1 | **ĐÓNG** | sửa code (F1) — nhưng chẩn đoán ban đầu của tôi **sai** |
| A3-1 | **ĐÓNG** | sửa contract + writer (F2) |
| A4a-3 | **ĐÓNG** | cờ backend + nung build (F3) |
| A1-1 | **ĐÓNG** | xoá file, sau khi xác minh nó rỗng nghĩa (F4) |
| A1-2 | **BÁC BỎ giả thuyết** | đo, không sửa (F5) |
| A2-1 | **PHÂN LOẠI LẠI — chờ duyệt** | đo, không sửa (F6) |
| C0-7 | **ĐÃ ĐO**, kết quả sắc hơn giả thuyết | đo, không sửa (F7) |
| C0-6 | vẫn mở, thuộc Chặng B | không chạm |
| A4a-2 | vẫn mở, nợ kỹ thuật có chủ đích | không chạm |

---

## 2. F1 — A4a-1: tôi đã chẩn đoán sai, và đây là lỗi thật

Ở báo cáo A4a tôi viết `OutputPreviewLayout.test.tsx` đỏ do **"ô nhiễm state giữa test"**. Sai. Tôi kết luận mà **chưa đọc thông điệp lỗi** — đúng loại suy diễn mà `prynx-task-loop` cấm.

Lỗi thật:

```
Error: Test timed out in 5000ms.
```

Không phải sai assertion, không phải ô nhiễm state. Test render cả Output Preview rồi thao tác ~40 bước; chạy riêng mất ~2,7s, nhưng trong lượt `vitest run` toàn bộ (297 file song song) thì tranh CPU đẩy nó vượt trần 5s mặc định.

**Sửa:** nới trần cho **đúng test đó** (`}, 20000)`), không nâng `testTimeout` toàn cục — nâng toàn cục sẽ che các test treo thật.

**Kết quả:** `npx vitest run` toàn bộ → **297 file, 3144 passed, 2 skipped, 0 failed**.

Đã đính chính vào cả hai báo cáo A4a và A4a-3 thay vì để lại kết luận sai.

**File:** `desktop/src/components/OutputPreviewLayout.test.tsx` (1 file).

---

## 3. F2 — A3-1: đóng lỗ hợp đồng do chính lô A1 của tôi tạo ra

`RenderCutStrokeV2` cho phép `colorSpace = "separation"` nhưng không mang alternate colorspace, nên writer buộc phải fail-closed. Đây là thiết kế thiếu một trường ở lô A1.

**Contract mới:** `stroke.alternate = {space, components}`, bắt buộc khi `colorSpace = separation`, bắt buộc `null` khi khác. Thêm một kiểm nghiệp vụ: alternate không được toàn 0 — tint 1.0 phải ra màu **thấy được**, nét vô hình là lỗi im lặng tệ nhất của một lớp dao.

**Writer** giờ dựng colorspace thật:

```
[/Separation /cutcontour /DeviceCMYK << /FunctionType 2 /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>]
```

Tint transform type 2: tint 0 → trắng, tint 1 → đúng màu alternate — đúng ngữ nghĩa RIP mong đợi khi kênh spot không tồn tại trên máy.

**Test đảo có chủ đích:** `test_separation_bi_tu_choi_ro_rang_thay_vi_bia_mau` → `test_separation_dung_colorspace_that_tren_artifact`. Test mới đọc thẳng object trong PDF đã ghi: `/Separation`, tên kênh, `/DeviceCMYK`, `FunctionType 2`, `C0`/`C1`; kiểm content stream có `CS` + `SCN` và **không** rơi về `K`; và raster để chắc nét vẫn thấy được. Thêm `test_separation_thieu_alternate_bi_tu_choi` cho ca thiếu alternate.

**File (6):** `nesting_production_adapter.py`, `nesting_imposition_bundle.py`, `nesting_imposition_render.py`, `test_nesting_imposition_bundle.py`, `test_nesting_production_lifecycle.py`, `test_nesting_imposition_render.py`.

**Khai báo vượt trần 5 file.** Contract dùng exact-fields nên thêm một trường buộc cập nhật 3 fixture test. Tôi chọn làm một lô 6 file thay vì tách, vì tách sẽ để lại cây test **đỏ** giữa hai lô — tệ hơn là vượt một file. Nêu ra thay vì lặng lẽ.

---

## 4. F3 — A4a-3: cờ backend và nung vào build

**Phát hiện phụ đáng chú ý:** `build_production.ps1` chỉ nung `FEATURE_GATING` và `LOGO_REBUILD`. Cặp `VITE_MIXED_NESTING_ENABLED` / `PRYNX_MIXED_NESTING_ENABLED` **không được nung**, dù `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` nói "build_production.ps1 (P15a) nung cặp". Tài liệu đó **stale**.

Hệ quả thực tế của Mixed Nesting vẫn đúng (thiếu biến ⇒ HOLD ở cả hai bên), nhưng nó **ngầm** chứ không được ghim, và không có guard nào chặn bật lệch. Ghi thành finding F3-1 để chủ dự án quyết riêng — sửa nó là đổi hợp đồng build của một tính năng khác.

**Đã làm cho cặp cờ của lô này:**

- `backend/app/core/nesting_rollout.py` (mới): `true_shape_nesting_enabled()` theo **đúng** khuôn `routes/mixed_nesting._runtime_enabled` để hai đường không có hai định nghĩa "dev" khác nhau. Module nhẹ, không import route/engine/native.
- `build_production.ps1`: nung `VITE_TRUE_SHAPE_NESTING_ENABLED = "false"` + `PRYNX_TRUE_SHAPE_NESTING_ENABLED = "false"`; thêm vào snapshot env để build không làm bẩn shell người chạy; thêm vào guard `throw` ở **cả hai chốt** (trước bundle, trước manifest).
- `docs/CAU_HINH_ENV.md`: ghi biến mới.
- `backend/tests/test_nesting_rollout.py` (mới): 13 test.

Test khoá cả những thứ dễ trôi: chỉ chuỗi `"true"` mới mở (không nhận `1`/`yes`), bản Nuitka không mở chỉ vì `DEV_MODE` còn sót, cờ tách khỏi Mixed Nesting, và **build script phải có guard ở cả hai chốt** — kiểm bằng cách đếm số lần khớp regex trong chính file script.

`build_production.ps1` đã kiểm cú pháp bằng `Parser::ParseFile`: **0 lỗi**.

**File (4).**

---

## 5. F4 — A1-1: xoá `.rej` sau khi xác minh

`backend/app/workers/imposition_pdf_form.py.rej` có **đúng 1 hunk**, nội dung là đổi `source_pdf` → `source_path=source_path`. Đo lại lần cuối trước khi xoá:

- `source_path=source_path` trong file thật: **1 chỗ** (đã áp);
- `source_pdf,` còn sót: **0 chỗ**.

Nghĩa là hunk đó đã được áp bằng đường khác và `.rej` không mang thay đổi nào. **Đã xoá.**

---

## 6. F5 — A1-2: giả thuyết của tôi bị BÁC BỎ

Tôi từng nghi crash PDFium trong lượt pytest toàn bộ là do module cũ chưa bọc `pdfium_guard()`, cụ thể `geometry_reader._list_objects_locked` chạy song song với thread nền `combine_jobs._sweep_loop`.

Đo lại:

1. `geometry_reader.list_objects` **ĐÃ** bọc `pdfium_guard("geometry_list_objects")` từ audit 2026-07-29 §C.1. Hai hàm PDFium khác cùng file (`get_text_object_props`, `list_image_placements`) cũng đã bọc.
2. `combine_jobs._sweep_loop` **không chạm PDFium** — nó chỉ quét record job và xoá path. Frame của nó trong dump chỉ là một thread nền đang ngủ, không phải bên tham gia.

Vậy cả hai nửa của giả thuyết đều sai. Crash đó xảy ra **1 lần trong hơn 6 lượt full** và tôi không tái hiện lại được, nên nó vẫn là một lần xuất hiện đơn lẻ **chưa giải thích được** — nhưng tôi ghi `[DISPROVED]` cho hướng `pdfium_guard` để lần sau không đi lại đường cụt.

Không sửa gì. Đóng hướng điều tra sai còn giá trị hơn để nó nằm trong backlog như một manh mối tưởng đúng.

---

## 7. F6 — A2-1: phân loại lại, KHÔNG sửa, cần chủ dự án quyết

`cnc_render.py:360` nén `gap = max(gap_x, gap_y)`. Trước đây tôi để nó ở P2 như một chỗ cần sửa. Đo lại thì kết luận khác.

**Đo được:**

- Biến `gap` đã nén được dùng ở **đúng hai chỗ**, cả hai trong nhánh **gang**: `compute_packer_exclude_zones` và `build_cnc_gang_layout`.
- Packer nhận **gap scalar** theo thiết kế: `build_cnc_gang_layout` → `build_cnc_front_layout` → `packer.insert(w + gap, h + gap, ...)`. Gap được cộng vào **cả hai** trục.

**Nghĩa là `max()` là BẢO THỦ, không phải sai.** Với gapX=2, gapY=5 thì cả hai trục dùng 5 — không bao giờ đặt sát hơn mức người dùng yêu cầu. Đây là **mất tối ưu vật liệu** theo trục X, không phải lỗi an toàn.

**Sửa nó có nghĩa là:** đổi contract packer từ scalar sang dị hướng ở `build_cnc_front_layout`, `_ratio_fill_layout`, `build_cnc_gang_layout`, `compute_packer_exclude_zones` — và **đổi layout đầu ra** của mọi job CNC gang đang chạy: số con/tờ khác, vị trí khác, số tờ khác.

Đó là **đổi hành vi nghiệp vụ trên đường sản xuất legacy**. Theo `prynx-audit-workflow`, việc này cần chủ dự án duyệt riêng và cần đo trước/sau. Tôi **không tự sửa**.

Ghi chú thêm từ docstring của `build_cnc_gang_layout`: packing hiện theo hình chữ nhật bao của `trim`, và nesting đa giác cho gang được ghi rõ là "cải tiến tương lai, không nằm trong phạm vi này". Nên A2-1 thuộc cùng nhóm cải tiến đó, không phải nợ của đợt nesting.

---

## 8. F7 — C0-7: đã đo, kết quả SẮC HƠN giả thuyết

Giả thuyết ban đầu của tôi: ngân sách mỗi trial gần như phẳng trong khi nhu cầu mỗi trial tăng, nên Tight bị cắt trước khi refine xong.

Đo thật trên native, cùng ca (2 mẫu × 40 con, tờ 320×450, `timeBudgetMs` = None để chạy work-plan xác định):

| profile | terminationReason | placed | sheets | attempts | orientEval | poseRefinements | ms |
|---|---|---:|---:|---:|---:|---:|---:|
| fast | `work_budget_exhausted` | 80 | 1 | 1.588 | **180** | 28.405 | 4.117 |
| balanced | `work_budget_exhausted` | 80 | 1 | 1.874 | **144** | 98.120 | 19.338 |
| tight | `work_budget_exhausted` | 80 | 1 | 1.915 | **138** | 297.964 | 26.509 |

Ba điều đo được, quan trọng hơn giả thuyết cũ:

1. **Cả ba profile đều kết thúc bằng `work_budget_exhausted`**, không lần nào `all_placed`. Ngân sách luôn là ràng buộc chặn, ở mọi profile.
2. **`poseRefinements` ≈ đúng bằng `evaluation_budget`** (28.405/30.000 · 98.120/100.000 · 297.964/300.000). Toàn bộ ngân sách bị **refinement pose** tiêu thụ.
3. **`orientationEvaluations` GIẢM khi profile tăng**: 180 → 144 → 138. Ngược hẳn ý định — Tight được cấu hình 96 góc đề xuất/chi tiết so với 12 của Fast, mà lại thử **ít** hướng hơn.

Điểm 3 là nguyên nhân thật của "profile không đơn điệu": `refinement_rounds` tăng 2 → 6 → 18, mỗi lượt refine nạp evaluation, nên profile cao dồn ngân sách vào **tinh chỉnh cục bộ vài ứng viên đầu** và còn lại ít cho việc **khám phá hướng**. Nhiều ngân sách hơn nhưng dùng sai chỗ.

**Một số đo phụ, ngược tài liệu:** comment trong `control.rs` ghi ~9.700 pose eval/s ⇒ Fast ≈3s, Balanced ≈10s, Tight ≈31s. Đo thật: Balanced 98.120 eval trong 19,3s ≈ **5.080 eval/s**, tức ~2× chậm hơn con số ghi trong code. Trần thời gian trong comment không phải thứ máy thật làm được.

Không sửa gì — đây là input cho Chặng B, và Chặng B bị gate sau Cổng A. Nhưng giờ Chặng B có **hướng cụ thể** thay vì một giả thuyết: cân lại tỉ lệ giữa refinement và orientation exploration, và cập nhật con số trong comment cho đúng.

---

## 9. Verify

| Phạm vi | Kết quả |
|---|---|
| `test_nesting_rollout.py` | **13 passed** |
| Bộ verify bắt buộc + writer + rollout (11 file) | **444 passed** |
| Toàn bộ `backend/tests` | **4237 passed, 19 skipped, 0 failed** (14:17) |
| `cargo test imposition_core` | **292 passed, 0 failed** |
| `npx vitest run` toàn bộ | **297 file, 3144 passed, 2 skipped, 0 failed** |
| `npm run typecheck` | exit 0 |
| `py_compile` 5 file | exit 0 |
| `build_production.ps1` parse | **0 lỗi cú pháp** (`Parser::ParseFile`) |

### 9.1. Truy nguyên số test, không đoán

Lô A3 để lại 4218. Đếm từng file bằng `pytest --collect-only`:

| File | Sau A3 | Sau F | Chênh |
|---|---:|---:|---:|
| `test_nesting_imposition_bundle.py` | 76 | **79** | +3 (ca reject alternate) |
| `test_nesting_production_lifecycle.py` | 167 | **167** | 0 (chỉ sửa fixture) |
| `test_nesting_imposition_render.py` | 20 | **21** | +1 (tách test separation thành 2) |
| `test_nesting_rollout.py` | — | **13** | +13 (file mới) |
| **Tổng của lô F** | | | **+17** |

4218 + 17 = 4235, nhưng đo được **4237**. Chênh **+2** đến từ `backend/tests/test_file_handler.py` — phiên khác sửa lúc 21:37 trong lúc tôi làm lô này (`git status` là ` M`). Không phải test của tôi, và không có test nào biến mất.

---

## 10. Finding còn lại

| Mã | Phát hiện | Mức | Cần gì |
|---|---|---:|---|
| F3-1 | `build_production.ps1` **không nung** cặp `VITE_/PRYNX_MIXED_NESTING_ENABLED` dù kế hoạch nói đã. Hành vi hiện tại vẫn đúng (HOLD ngầm) nhưng không được ghim và không có guard | P2 | chủ dự án quyết — đổi hợp đồng build của tính năng khác |
| A2-1 | Nén `gap = max(gap_x, gap_y)` ở nhánh CNC gang là **bảo thủ, không sai**. Sửa = đổi contract packer + đổi layout đầu ra job đang chạy | P3 | chủ dự án duyệt + đo trước/sau |
| C0-7 | Đã đo. Nguyên nhân: refinement tiêu hết ngân sách, orientation exploration giảm khi profile tăng | P2 | Chặng B |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| A4a-2 | Wire format `gridStrategy` vẫn chuỗi thuần, chưa tagged `{kind}` | P3 | lô riêng sau Cổng A |
| A1-2 | Crash PDFium 1 lần trong >6 lượt full, **chưa** giải thích được. Hướng `pdfium_guard` đã `[DISPROVED]` | P3 | theo dõi, tái hiện được thì mở lại |

Không còn finding nào ở mức P0/P1.

---

## 11. Kết luận

**PASS.** Bốn finding đóng bằng sửa code, ba đóng bằng đo (trong đó **hai** bác bỏ chính giả thuyết trước đó của tôi), một dừng lại đúng chỗ vì nó đổi hành vi sản xuất.

Hai chỗ tôi tự nhận sai trong đợt này:

1. **A4a-1**: kết luận "ô nhiễm state" mà chưa đọc thông điệp lỗi. Lỗi thật là timeout.
2. **A3-1**: lỗ hợp đồng separation do chính lô A1 của tôi thiết kế thiếu trường.

Và một chỗ tài liệu dự án sai mà tôi phát hiện được nhờ đi kiểm thay vì tin: kế hoạch Mixed Nesting nói build đã nung cặp cờ, thực tế chưa.

**Đường đi tiếp** không đổi: **Lô A4b** nối `processHandlers`/`GridPreview`/`ImposerDashboard`/route, rồi **Cổng Chặng A**. Rủi ro đã biết của A4b là ba callsite payload lệch naming và đơn vị (EXECUTE camelCase+mm, PREVIEW snake_case+point, cộng `preview-layouts-batch`).
