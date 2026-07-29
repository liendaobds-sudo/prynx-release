# Log sửa — Audit hệ toạ độ parser

Báo cáo gốc: `docs/BAO_CAO_AUDIT_HE_TOA_DO_PARSER_2026-07-28.md`
Ngày: 2026-07-28

## Lô 1 — Lưới an toàn (XONG)

Không đổi một dòng logic nào.

| File | Thay đổi | Mã | Cách kiểm |
|---|---|---|---|
| `backend/app/workers/pdf_content_parser.py` | Khai báo hệ toạ độ của `rect`/`items` trong docstring `parse_content_stream`: nêu rõ y bị lật quanh `mb[3]-mb[1]`, x giữ raw, `Δ = (+mb[0], −mb[1])`, hai chỗ ngoại lệ, và cảnh báo phải sửa `pdf_ops.ShapeBuilder` cùng commit | §1.1, §1.3 | `pytest tests` |
| `backend/tests/test_nup_canonical_origin.py` | Thay số magic `(60,-20,240,60)` bằng `PAGE_RELATIVE_DIE` + `PARSER_DELTA`; đổi parser sang hệ page-relative thì chỉ cần đặt `PARSER_DELTA = (0,0)` | §4.1 | `pytest tests/test_nup_canonical_origin.py` |
| `backend/tests/test_parser_translation_invariance.py` (mới) | 15 test bất biến dịch | §4.2, §4.3, §3.1, §3.2 | `pytest tests/test_parser_translation_invariance.py` |

Nội dung bộ test mới: cùng nội dung vẽ trên hai trang khác gốc MediaBox (`[0,0,200,100]` vs `[50,30,250,130]`) → kết quả consumer phải trùng.

- Tiền đề: `test_parser_delta_is_pure_translation` — Δ đúng bằng `(+mb[0], −mb[1])` cho mọi path.
- Bất biến: `_select_from_paths`, `classify_shape`, `_poly_to_trim_coords`, `transform_die_point` (kèm cả 4 trạng thái xoay ô), `build_shapely_polygon_from_paths`, `detect_die_shapes` (PDF **thật**, không `_FakeDoc` — bịt §4.3), `page_has_die`.
- Ghim ngoại lệ đã biết: `test_artwork_bbox_is_the_known_exception` (§3.1 — kích thước bất biến, gốc lệch đúng Δ), `test_fix_hairlines_roundtrip_cancels_on_offset_page` (§3.2 — raw 40 → parser 60 → ghi lại 40).

Hai test cuối là **chốt chống sửa lệch pha**: sửa parser hoặc `ShapeBuilder` một phía sẽ làm chúng đỏ.

## Lô 2a — Bịt đường hở detect-shape (XONG)

| File | Thay đổi | Mã |
|---|---|---|
| `backend/app/workers/nup_engine.py` | Thêm context manager công khai `canonical_page_space(source_path, job_id)` bọc `_canonicalize_page_space`, tự dọn file tạm kể cả khi thân block ném ngoại lệ | §2.1 |
| `backend/app/api/routes/imposition.py` | `_compute_detect_response` chạy trong `canonical_page_space(...)`; tách thân thành `_detect_on_canonical` để giữ nguyên `try/finally` đóng doc | §2.1 |

### Lệch đã đo, làm cơ sở cho lô này

```
Rotate=0   preview doc = (200.0, 100.0) | export (sau canon) = (200.0, 100.0) | KHỚP
Rotate=90  preview doc = (200.0, 100.0) | export (sau canon) = (100.0, 200.0) | >>> LỆCH <<<
```

Đây là **điều chỉnh nội dung báo cáo**: §2.1 ban đầu ghi lo ngại về gốc MediaBox lệch, nhưng đo ra thì với gốc lệch mọi consumer đã bất biến (lô 1 chứng minh) nên không có lệch quan sát được. Lệch thật đến từ `/Rotate ≠ 0` — export hoán w/h, đọc thô thì không. Trang `/Rotate=90` khổ 200×100 báo trim 200×100 trong khi export dựng theo 100×200.

Test thêm vào `test_nup_canonical_origin.py`: `test_canonical_page_space_cm_removes_temp`, `..._on_exception`, `..._passthrough_when_already_canonical` (không được xoá file gốc của người dùng), `test_rotated_page_trim_matches_export_after_fix`.

## Lô 2b — Bịt đường hở preview-layout (XONG)

| File | Thay đổi | Mã |
|---|---|---|
| `backend/app/api/routes/imposition.py` | `preview_layout`: đổi `if True:` (indent 8, bao trọn thân hàm) thành `with contextlib.ExitStack() as _canon_stack:` → có điểm dọn DUY NHẤT mà **không phải thụt lại** một dòng nào. Mở doc trên `_doc_path = _canon_stack.enter_context(canonical_page_space(file_path))` | §2.1 |

Vấn đề ~15 điểm `doc.close()` rải rác được giải bằng `ExitStack`: nó dọn ở mọi đường ra, kể cả `return` giữa hàm và ngoại lệ. Không cần chạm 15 chỗ đó.

### Bẫy hiệu năng đã tránh

Bản nháp đầu gán lại `file_path = ...canonical...`. **Sai** — `file_path` là thành phần khoá của `_NEST_A_CACHE` (`_sticker_nest_cache_key`, `imposition.py:~3248`) và cache zone (`~1963`), cả hai kèm `os.path.getmtime`. Đường chuẩn hoá là file tạm mang uuid + mtime MỚI mỗi request → mọi request miss cache → preview nesting (NFP) chậm hẳn. Đã sửa thành biến riêng `_doc_path`; khoá cache vẫn bám đường gốc, và điều đó ĐÚNG vì cùng một file luôn chuẩn hoá ra cùng hình học.

### Baseline đo được

Khôi phục bản HEAD của `imposition.py` rồi chạy bộ test mới:

```
FAILED test_preview_cell_matches_export_die_size[90]
FAILED test_preview_cell_matches_export_die_size[270]
FAILED test_rotated_page_is_the_case_that_used_to_diverge
3 failed, 6 passed
```

Đỏ đúng ở 90° và 270° — hai góc hoán w/h. 0° và 180° xanh cả trước lẫn sau, khớp dự đoán.

Con số cụ thể (`/Rotate=90`, đường bế 180×80 trong khung thô):

```
đọc thô (preview cũ) = (180.0, 80.0)
export (canonical)   = (80.0, 180.0)
```

### Test mới — `backend/tests/test_preview_export_canonical_parity.py` (9 test)

- `test_preview_cell_matches_export_die_size` — parametrize 0/90/180/270, ô preview khớp khổ đường bế export dựng.
- `test_rotated_page_is_the_case_that_used_to_diverge` — ghim CẢ hai con số (180×80 vs 80×180) để lệch không âm thầm quay lại.
- `test_preview_does_not_leak_canonical_temp_files`, `..._on_error` — ExitStack dọn ở đường thành công và đường ném ngoại lệ.
- `test_unrotated_file_is_not_rewritten` — file đã chuẩn không sinh file tạm (giữ hiệu năng).
- `test_cache_key_uses_original_path_not_temp` — gọi hai lần cho cùng kết quả, file gốc không bị xoá.

### Một tiền đề sai của tôi, đã sửa

Bản test đầu assert "ô preview == khổ TRANG export" và đỏ ở 0°/180°. Đo lại thì với `is_die_cut=False` khổ ô đến từ `item_w`/`item_h` trong request (UI đã tính sẵn), không từ file. Chỉ nhánh `is_die_cut=True` mới đọc hình học từ file. Test đã viết lại theo đường đó.

## Phạm vi còn lại

`POST /imposition/preview-layouts-batch` (`imposition.py:~3984`) và hàm nest ở `~4063/4114` vẫn mở file thô. Cùng lớp lệch, chưa xử lý trong đợt này — batch chỉ trả *capacity* (số ô/tờ) nên biểu hiện là số lượng ước tính, không phải vị trí. Ghi lại để làm sau.

## Lô 3 — Đổi hợp đồng parser (KHÔNG LÀM, theo khuyến nghị đã duyệt)

Lợi ích thực tế bằng 0: lô 1 đã chứng minh bằng test rằng mọi consumer bất biến dịch, hai ngoại lệ thì một được chốt bảo vệ, một tự triệt tiêu.

## Verify

`backend\venv\Scripts\python -m pytest tests -q` → **1544 passed, 5 skipped** (trước đợt audit này: 1520 passed, 5 skipped). Không golden nào lệch.

Chưa chạy `run_dev.bat` thao tác tay. Cần kiểm bằng tay:
1. Mở file `/Rotate=90`, so khổ thành phẩm UI báo với khổ trên tờ bình thật — cả detect-shape (lô 2a) lẫn preview (lô 2b) phải khớp export.
2. Đo thời gian preview nesting trên file nhiều tem, xác nhận cache vẫn hit (không chậm hơn trước).
