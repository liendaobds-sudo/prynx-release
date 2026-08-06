# Nhật ký sửa — Audit "Co giãn trang (Resize)" 2026-08-06

Báo cáo gốc: [BAO_CAO_AUDIT_CO_GIAN_TRANG_2026-08-06.md](BAO_CAO_AUDIT_CO_GIAN_TRANG_2026-08-06.md).
Sửa theo lô ≤5 file, mỗi chỗ gắn tag `RESIZE (audit 2026-08-06 §G.x)`.

## Lô 1 — §G.1 (P0) Mất nội dung trên trang `/Rotate≠0`

| Mục | Nội dung |
|---|---|
| File | `backend/app/workers/pdf_tools_engine.py`, `backend/tests/test_resize_rotate_parity.py` (mới) |
| Thay đổi | Trước khi đo MediaBox và dựng Form XObject, bake `/Rotate` bằng `_canonicalize_rotated_page_for_mirror` (bọc `try/except` cho góc không bội 90). |
| Lý do | `as_form_xobject()` phát `/BBox` theo khổ CHƯA xoay kèm `/Matrix` lật ⇒ nội dung tràn ra ngoài BBox và bị cắt; đồng thời `src_w/src_h` đọc trước xoay nên tỉ lệ `fit` sai. |
| Kiểm tra | `pytest tests/test_resize_rotate_parity.py -q` → 9 passed. Chứng minh không rỗng: monkeypatch hàm bake thành no-op, case 90° chỉ đếm được **2/4** dấu góc — đúng con số đo trong báo cáo. Không hồi quy: `test_resize_smart.py` + `test_resize_edge_background.py` → 65 passed / 1 skipped; `-k "resize or pdf_tools"` → 113 passed / 1 skipped. |

## Lô 2 — §G.2, §G.3, §G.4 (P1) Hợp đồng frontend ↔ route

| Mã | File | Thay đổi | Lý do |
|---|---|---|---|
| §G.2 | `desktop/src/lib/preprocessEngine/PageResizer.ts` | Sau `drawPage`, mang `TrimBox/BleedBox/ArtBox` sang trang mới qua phép biến đổi `txBox` (theo gốc nhúng `box.left/box.bottom`, kẹp trong khổ đích). Đọc thẳng `(srcPage.node as any).TrimBox?.()` — **không** dùng `getTrimBox()` vì pdf-lib tự bịa hộp từ CropBox/MediaBox khi file không khai báo. | File ≤50 MB đi đường frontend bị mất bù xén / đường trim, trong khi đường backend vẫn giữ. |
| §G.3 | `desktop/src/lib/processHandlers.ts` | Thêm `isDownsizingByProbe()`; nhánh chỉ-backend đổi `settings.targetDpi ?? 0` thành `?? (probe ? 300 : 0)`. Probe trả `false` ngay khi `file.size > FE_SIZE_LIMIT` (không nạp pdf-lib với file lớn), ngược lại đọc trang 0 và so khổ đích với khổ nguồn. | Nhánh backend đánh rơi mặc định downsample ⇒ A1→A5 vẫn ~300 MB. Giữ hành vi cũ cho file lớn nên không có cap vô điều kiện. |
| §G.4 | `desktop/src/lib/processHandlers.ts` | `backendFillColor` = màu người dùng chọn khi `effectiveFillMode === 'solid'`, còn lại `'#ffffff'`. | Trước đây hardcode `'#ffffff'` nên "màu đặc + co giãn theo nội dung" luôn ra nền trắng. |
| Test | `desktop/src/lib/processHandlers.test.ts` (+5 case), `desktop/src/lib/preprocessEngine/preprocessEngine.test.ts` (+1 case) | Heuristic 300 DPI bật/tắt/đè bằng lựa chọn tường minh; màu đặc truyền đúng arg [7]/[8]; nhánh khoá trục vẫn ép trắng; TrimBox/BleedBox co đúng tỉ lệ 0.5. | Bộ test cũ pin `targetDpi: 0` nên không phủ được nhánh mới. |
| Kiểm tra | `npm run typecheck` sạch; `npx vitest run src/lib/processHandlers.test.ts src/lib/preprocessEngine` → **51 passed**. |

## Lô 3 — §G.5, §G.6, §G.7 (P2) Biên API & parser

| Mã | File | Thay đổi | Lý do |
|---|---|---|---|
| §G.6 | `backend/app/core/page_selection.py` (mới), `pdf_tools_engine.py`, `resize_background_engine.py` | Một parser DÙNG CHUNG: `parse_page_selection` / `validate_page_selection`. Parser inline ~28 dòng trong `resize_pages` và thân `_parse_pages` đều uỷ quyền về đây (giữ nguyên tên hàm cho caller). | Ba bản parser lệch nhau ở dải hở (`7-`) và token rác. |
| §G.5 | `pdf_tools_engine.py` | `resize_pages_smart` gọi `validate_page_selection(apply_to)` khi `apply_to` là `str`. | Chuỗi sai cú pháp trước đây ra tập RỖNG ⇒ trả file y nguyên, người dùng tưởng đã đổi khổ. Route `/resize` sẵn có `except ValueError → 422` nên lỗi nổi lên đúng cách. Đặt ở engine chứ **không** ở route vì cổng god-file ratchet chốt `pdf_tools.py` ở 1933 dòng — và nâng trần là quyết định của con người, không phải sửa cho test xanh. |
| §G.7 | `backend/app/api/routes/pdf_tools.py` | `inspect_resize_transparency_endpoint` nhận `license_info: dict = Depends(require_license)`. | Đối xứng guard giấy phép với các route resize khác. Không phải lỗ hổng — router đã có `dependencies=[Depends(require_license)]`. |
| Kiểm tra | `pytest tests/test_page_selection.py -q` → 28 passed; `pytest tests/ -q -k "resize or pdf_tools or page_selection or god_file"` → **156 passed, 1 skipped** (gồm cổng ratchet, `pdf_tools.py` đúng 1933 dòng). |

## Lô 4 — §G.8 (P3) i18n cảnh báo lật gương

| Mục | Nội dung |
|---|---|
| File | `desktop/src/components/preprocess-tools/PageResizerTool.tsx`, `desktop/src/i18n/locales/vi.json`, `en.json` |
| Thay đổi | Chuỗi cứng tiếng Việt tách thành 6 key `preprocess.pageResizer:canh_bao_lat_guong_*` (chia mảnh để giữ 3 đoạn `<strong>` mà không cần `<Trans>`), thêm bản vi + en. |
| Kiểm tra | JSON parse OK cho cả hai locale; `npm run typecheck` sạch; 51 test frontend vẫn xanh. |

## Bổ sung — §G.10 (P2) Khổ khóa một chiều làm "Kiểu tỷ lệ" biến mất

> **Đã được §G.11 bên dưới sửa lại một phần**: kết luận "khóa một chiều chỉ hỗ trợ `fit`" trong mục này là sai; danh sách đúng là `['fit','center_no_scale']`.

User báo: chọn "Cùng chiều rộng"/"Cùng chiều cao" thì khối chọn kiểu tỷ lệ ẩn hẳn.

| Mục | Nội dung |
|---|---|
| File | `desktop/src/components/preprocess-tools/PageResizerTool.tsx`, `PageResizerTool.test.ts`, `vi.json`, `en.json` |
| Nguyên nhân | Điều kiện `{pageSizeMode === 'fixed' && (…)}` bọc CẢ khối, nên khổ khóa một chiều mất luôn nhãn "2. Kiểu tỷ lệ" — người dùng tưởng mất tính năng. Ràng buộc gốc là thật: `resize_background_engine` ném `ValueError` khi `size_mode != "fixed"` mà `scale_mode != "fit"` (vì khóa một chiều tự suy chiều còn lại theo tỷ lệ nội dung). |
| Thay đổi | Khối luôn hiển thị; danh sách lựa chọn lọc qua hàm thuần `allowedScaleModes(pageSizeMode)` (`fixed` → 4 kiểu, khóa một chiều → chỉ `fit`), `value` ép về `'fit'` khi khóa một chiều, kèm ghi chú lý do (key `khoa_mot_chieu_chi_ho_tro_vua_khit`, vi + en). Danh sách kiểu tỷ lệ tách thành `SCALE_MODE_OPTIONS(t)`. |
| Lý do chọn cách này | Không nới ràng buộc engine (sẽ ra lỗi 422 hoặc hình sai), chỉ chữa chỗ UI im lặng. `applyPageSizeMode` vẫn ép `scaleMode: 'fit'` như trước nên state luôn hợp lệ. |
| Kiểm tra | `npm run typecheck` sạch; `PageResizerTool.test.ts` → 18 passed (thêm 4 case: `allowedScaleModes` cho `fixed`/mặc định, thu về `['fit']` cho `fixed_width`/`fixed_height`, và render thật xác nhận nhãn "Kiểu tỷ lệ" + "Thu vừa khít" vẫn còn, "Ép bóp méo" đã biến mất); phạm vi rộng hơn `src/lib/processHandlers.test.ts src/lib/preprocessEngine src/components/preprocess-tools` → **127 passed / 15 file**. |

## Bổ sung — §G.11 (P1) Khổ khóa một chiều PHẢI dùng được "Giữ nguyên ở giữa"

User nêu ca thật: *tem 5×10 cm, đưa về chiều cao 15 cm, chọn "Giữ nguyên ở giữa" → trang thành 7.5×15 cm nhưng con tem vẫn 5×10 cm nằm giữa.* Kết luận ở §G.10 ("khóa một chiều chỉ hỗ trợ `fit`") là **SAI** và bị thay thế bởi mục này.

| Mục | Nội dung |
|---|---|
| Nguyên nhân gốc | `resize_background_engine` gộp HAI đại lượng khác nhau vào một biến `fit_scale`: (a) tỷ lệ **dựng khổ trang** — suy chiều còn lại từ tỷ lệ nội dung gốc; (b) tỷ lệ **vẽ nội dung**. Hai giá trị chỉ trùng nhau ở kiểu `fit`. Vì gộp nên `center_no_scale` không biểu diễn được, và thay vì tách biến, code cũ dựng một `ValueError` chặn luôn ca đó. Ràng buộc lặp lại ở 3 tầng: guard engine, guard route, và ép `'fit'` ở `processHandlers`. |
| `backend/app/workers/resize_background_engine.py` | Tách `page_scale` (dựng khổ) khỏi `fit_scale` (vẽ nội dung): khóa một chiều đặt `fit_scale = 1.0` khi `scale_mode == 'center_no_scale'`. Guard đổi thành `scale_mode not in {"fit", "center_no_scale"}`. Toàn bộ hạ nguồn (`draw_width_pt`, `offset_*`, `render_scale`, ma trận `cm`) vốn đã đọc `fit_scale` nên tự đúng, không phải sửa. |
| `backend/app/api/routes/pdf_tools.py` | Guard route nới đúng theo engine; giữ `pdf_tools.py` đúng **1933 dòng** (không đụng trần ratchet). |
| `desktop/src/lib/processHandlers.ts` | Chỉ hạ về `'fit'` khi kiểu đang chọn là `fill`/`stretch`; `center_no_scale` đi thẳng xuống backend. |
| `desktop/src/components/preprocess-tools/PageResizerTool.tsx` | `allowedScaleModes(khóa một chiều)` → `['fit','center_no_scale']`; `applyPageSizeMode` chỉ hạ `'fit'` khi kiểu hiện tại không còn hợp lệ; `shouldShowBackgroundFill` trả `true` cho khóa một chiều + `center_no_scale` (tem 5×10 trong trang 7.5×15 CÓ vùng trống cần nền) và `false` cho `fit` (khổ đích vừa khít). Ghi chú UI thay bằng key `khoa_mot_chieu_giai_thich_ty_le` (vi + en) mô tả cả hai kiểu. |
| Vì sao vẫn chặn `fill`/`stretch` | Khổ đích được sinh ra đúng tỷ lệ nội dung nên không còn phần dư để lấp hay bóp — hai kiểu này vô nghĩa ở khóa một chiều. |
| Kiểm tra | `pytest tests/test_resize_edge_background.py -q` → **50 passed** (thêm: tem 50×100 mm + `fixed_height` 150 mm ra trang 75×150 mm với ma trận vẽ `1.0` và offset 12.5/25 mm; `fill`/`stretch` vẫn `ValueError`; route nhận `center_no_scale`, route chặn `fill`/`stretch`). `tests/test_god_file_ratchet.py` xanh. `npm run typecheck` sạch; vitest `PageResizerTool.test.ts` + `processHandlers.test.ts` → **46 passed**. |

## Còn mở

- **§G.9** — phủ test `/Rotate≠0` giờ đã có cho đường `resize_pages` (Lô 1); đường nền động (`resize_background_engine`) vẫn chưa có case xoay.
- **Smoke thật**: cần mở PrynX, chạy Co giãn trang trên tài liệu khách có trang xoay 90°/270° và file >50 MB (đi nhánh backend) để xác nhận DPI mặc định + màu nền đặc đúng như test.
- Các phát hiện ngoài phạm vi (nếu có) đã ghi trong mục "phát hiện thêm" của báo cáo gốc, không sửa trong đợt này.
