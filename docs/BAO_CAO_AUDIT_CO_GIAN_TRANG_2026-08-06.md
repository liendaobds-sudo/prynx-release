# BÁO CÁO AUDIT CÔNG CỤ "CO GIÃN TRANG (RESIZE)"

**Ngày:** 2026-08-06
**Phạm vi:** đúng công cụ *Co giãn trang (Resize)* end-to-end — `PageResizerTool.tsx` → `processHandlers.runResize` → hoặc `PageResizer.resizePages` (pdf-lib) hoặc `POST /pdf-tools/resize` → `resize_pages_smart` → `resize_pages` / `resize_pages_with_background` / `_raster_resize` + downsample.
**Ngoài phạm vi:** downscale ảnh nói chung, resize panel/cửa sổ UI, xén viền (đã audit 2026-07-31), giữ tỷ lệ từng trang (2026-08-01), transparency (2026-08-03).
**Trạng thái:** Giai đoạn 1–2 xong. **Chưa sửa gì.** Chờ duyệt danh sách.

## 1. Kết luận điều hành

Tính năng có **bốn engine song song** cho cùng một yêu cầu người dùng: pdf-lib (frontend), `resize_pages` (pikepdf vector), `resize_pages_with_background` (content-aware), `_raster_resize`. Ba đợt audit trước đã đồng bộ *scale mode* và *khổ đích* giữa chúng, nhưng **chưa đồng bộ cách đọc trang nguồn**. Đó là chỗ phát sinh phát hiện nặng nhất của đợt này.

Phát hiện P0 duy nhất, đã tái hiện bằng số đo: `resize_pages` **mất nội dung trên trang có `/Rotate ≠ 0`**. Cùng một file, cùng tham số, frontend giữ 4/4 dấu góc còn backend chỉ còn 2/4 và ảnh bị dán lệch. Người dùng thấy: co giãn xong mất một phần bài, và mất hay không **phụ thuộc file to hay nhỏ 50 MB** (ngưỡng chọn route), tức là không tái hiện được theo ý muốn — dạng lỗi tệ nhất trong sản xuất.

Ba phát hiện P1 còn lại đều thuộc nhóm "cùng nút bấm, khác kết quả": frontend không mang `TrimBox/BleedBox/ArtBox` sang file mới (backend có mang), nhánh nền động/khóa trục **bỏ** heuristic downsample 300 DPI, và màu nền trơn bị ghi đè trắng khi bật *Resize theo nội dung*.

### Bằng chứng đo (§G.1)

Trang A4 `595×842 pt`, `/Rotate=90`, 4 ô đỏ `40×40 pt` ở 4 góc. Resize `fit` về `100×100 mm`, render `scale=2` (567×567 px), đếm cụm đỏ liên thông:

| Đường xử lý | Số dấu góc còn lại | Bbox cụm |
|---|---:|---|
| Frontend pdf-lib (`resizePages`) | **4 / 4** | (83,0)–(483,26), (83,540)–(483,566) |
| Backend `resize_pages` (vector) | **2 / 4** | (83,166)–(109,192), (83,540)–(109,566) |
| Backend `resize_pages_smart` mode `auto` | **2 / 4** | như trên (đi đúng `resize_pages`) |
| Backend content-aware (`fixed_width`) | **4 / 4** | khổ ra `283.46 × 200.31 pt` |

Nguyên nhân: `xobj = src_page.as_form_xobject()` sinh `/BBox [0 0 595 842]` kèm `/Matrix [0 -1 1 0 0 595]` — nội dung sau khi lật chiếm `842×595` nên phần vượt `/BBox` bị **clip**; đồng thời `src_w/src_h` đọc thẳng từ MediaBox **không hoán đổi theo `/Rotate`** nên tỉ lệ `fit` tính trên khổ chưa xoay. Đường content-aware không bị vì có `_canonicalize_rotated_page_for_mirror()` bake `/Rotate` trước (`resize_background_engine.py:525`).

## 2. Bảng phát hiện

| Mã | Mức | Effort | Bằng chứng | Kết luận |
|---|---|---:|---|---|
| §G.1 | **P0** | M | `backend/app/workers/pdf_tools_engine.py:238-247` đọc `mediabox` làm `src_w/src_h`, chỉ dùng `/Rotate` cho `auto_orientation`; `:265` `as_form_xobject()`. Đo: 2/4 dấu góc so với 4/4 ở frontend | Trang `/Rotate≠0` bị clip mất nội dung + tỉ lệ sai. Sửa: bake `/Rotate` (dùng `_canonicalize_rotated_page_for_mirror` sẵn có) trước khi lấy MediaBox và tạo XObject. |
| §G.2 | **P1** | S | `desktop/src/lib/preprocessEngine/PageResizer.ts` không đọc/ghi `TrimBox/BleedBox/ArtBox` (grep trong `preprocessEngine/` không có kết quả). Đo: FE `TrimBox: MẤT`; BE cùng file cho `[44.944 3.367 238.521 280.098]` | Cùng nút bấm, file ≤50 MB mất định nghĩa bleed/trim, file >50 MB thì giữ. Sửa ở route frontend theo đúng công thức `_tx_box` của backend. |
| §G.3 | **P1** | S | `processHandlers.ts:676-679` nhánh `wantEdgeFill \|\| lockedAxis \|\| wantResizeByContent` dùng `targetDpi = typeof settings.targetDpi === 'number' ? … : 0`; nhánh thường `:727-730` có `isDownsizing ? 300 : 0` | Chọn nền động/khóa một chiều thì mất downsample mặc định → A1→A5 vẫn ~300 MB, mọi tác vụ sau chậm. Đây đúng lý do `resize_pages_smart` tồn tại. |
| §G.4 | **P1** | S | `processHandlers.ts:678` truyền cứng `'#ffffff'` cho `bg_fill_color`, trong khi `effectiveFillMode` có thể là `'solid'` khi `wantResizeByContent` bật mà không `lockedAxis` | Đổ màu trơn + Resize theo nội dung ⇒ nền ra **trắng**, không phải màu người dùng chọn. (Với `lockedAxis` là chủ đích theo §R.5, không tính.) |
| §G.5 | P2 | S | `pdf_tools_engine.py:198-199` `pages_to_resize` rỗng khi chuỗi trang không parse được; `resize_background_engine.py:53-78` cũng bỏ qua âm thầm | `applyTo` = `"abc"` ⇒ file ra y nguyên (đo: MediaBox vẫn `595×842`), không lỗi, không cảnh báo. Nên trả 422 ở biên API. |
| §G.6 | P2 | S | `pdf_tools_engine.py:179-199` tự parse `a-b`, `resize_background_engine.py:53-78` parse lần hai, `PdfSplitter.parseRanges:24-45` lần ba | Ba bản parse khác nhau về clamp/`start>end`/khoảng trống ⇒ đợt sửa sau dễ lệch lại. Gom một helper backend + giữ parity test với FE. |
| §G.7 | P2 | S | `pdf_tools.py:629` `@router.post("/resize/inspect-transparency")` không có `license_info: dict = Depends(require_license)` như `/resize` (`:508`) | Router có `dependencies=[Depends(require_license)]` ở cấp `:44` nên **không phải lỗ bảo mật**; chỉ là bất đối xứng về `license_info` dùng cho watermark/log. Mức thấp, ghi nhận để nhất quán. |
| §G.8 | P3 | S | `PageResizerTool.tsx:264-273` đoạn cảnh báo lật gương hardcode tiếng Việt giữa các nhãn đã đi qua `t('preprocess.pageResizer:…')` | Bản EN hiện ra chữ Việt ở đúng chỗ cảnh báo dễ gây in sai nội dung. |
| §G.9 | P2 | M | Chưa có test nào cho `/Rotate≠0` trên `resize_pages`: `backend/tests/test_resize_smart.py`, `test_resize_edge_background.py` (grep `Rotate` trong `pdf_tools_engine.py` chỉ ra `:240` và `-dAutoRotatePages`) | §G.1 sống được vì thiếu phủ. Mỗi fix §G.1–G.4 phải đi kèm regression, gồm một ca **parity FE↔BE** trên cùng file. |

### Đã kiểm và **không** đưa vào danh sách

- `_raster_resize` với trang xoay: render qua pdfium nên tôn trọng `/Rotate`, cho 750 px đỏ trên canvas 284×284 — **không** clip. Không phải bug.
- `resize_pages` xoá `/TrimBox` in-memory rồi ép `CropBox = MediaBox`: đúng chủ đích giữ bleed, đã ghi rõ trong comment. Không sửa.
- Chính sách box khác nhau giữa FE (heuristic CropBox < 99% MediaBox) và BE (MediaBox-only): FE chỉ dùng CropBox khi rõ ràng nhỏ hơn nên **thực tế trùng kết quả** cho file xén phá huỷ; giữ nguyên, không đủ bằng chứng gọi là lỗi.
- Không có hard-cap vô điều kiện nào mới trong đường resize; `resize_background_engine` có comment nói rõ không cap DPI nền trên máy mạnh — đúng quy tắc 1.
- `pdfium_guard()` đã bọc đúng ở `_render_path_page_rgb`. Đúng quy tắc 3.

## 3. Quick-win (nếu chỉ làm được một lô)

§G.1 → §G.3 → §G.4. Ba việc này gộp lại là "resize không mất bài, không phình dung lượng, ra đúng màu nền", chạm 2 file.

## 4. Thứ tự sửa đề xuất theo lô

1. **Lô 1 — `/Rotate` backend (P0).** `pdf_tools_engine.py` (+ test mới `backend/tests/test_resize_rotate_parity.py`). Bake `/Rotate` trước khi đo MediaBox và tạo Form XObject; tag `RESIZE (audit 2026-08-06 §G.1)`. Verify: pytest resize + đo lại 4/4 dấu góc.
2. **Lô 2 — hợp đồng route frontend.** `processHandlers.ts` (§G.3, §G.4) + `PageResizer.ts` (§G.2) + `processHandlers.test.ts` + `preprocessEngine.test.ts`. Verify: `npm run typecheck` + vitest tập trung.
3. **Lô 3 — biên API & parser.** `pdf_tools.py` (422 cho chuỗi trang rác — §G.5), gom parser dùng chung (§G.6), `inspect-transparency` nhận `license_info` (§G.7). Verify: pytest `test_pdf_tools*`.
4. **Lô 4 — i18n cảnh báo lật gương (§G.8).** `PageResizerTool.tsx` + `vi/en` locale. Verify: typecheck + vitest.
5. **Closeout.** Ghi `docs/CO_GIAN_TRANG_FIXES_2026-08-06.md`, rà diff, smoke thật trên file khách có trang xoay.

Mỗi lô ≤5 file, verify xong mới sang lô kế. Không chạm thay đổi khuôn bế/updater đang có trong working tree.
