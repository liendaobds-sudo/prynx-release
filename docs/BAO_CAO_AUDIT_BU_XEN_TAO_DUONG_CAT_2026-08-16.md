# Báo cáo audit toàn diện — Bù xén / Tạo đường cắt — 2026-08-16

> Phạm vi: công cụ **Bù xén — Tạo đường cắt** (`StickerTool`) cả hai mục tiêu hình học
> (Bế tem nhãn, Xén vuông góc), từ UI → recipe → route → engine → artifact.
> Audit unit liên quan trong master matrix: `W2-U03`, `W2-U04`, `W2-U05`.
> Mức bằng chứng đợt này: **TRACED** (đọc code + đối chiếu hợp đồng hai đầu).
> Chưa chạy artifact/runtime mới trong đợt này — xem mục 5.

## 1. Tóm tắt điều hành

Luồng đã qua nhiều đợt audit (2026-07-28, 07-30, 08-01, 08-04, 08-07…) nên phần hình
học lõi khá vững: khóa PDFium bọc đủ trong `sticker_engine.py`, trần raster theo khổ
trang có sẵn, `bleed_sides` dùng chung một parser ba tầng, lớp đọc `localStorage`
validate và tự dọn key hỏng.

Khoảng trống còn lại **không nằm ở hình học** mà ở **biên hợp đồng và đường phát lại**:

- Ba công thức `shape_mode` khác nhau giữa chạy tay / ghi recipe / phát lại recipe →
  recipe cho ra khuôn bế khác bản đã duyệt.
- `edge_bite_mm` vẫn được gửi khi ô nhập đã ẩn → mất nội dung sát mép, im lặng.
- Nhánh Lật gương không kiểm `response.ok` → JSON lỗi bị commit như PDF, thay thế
  tài liệu đang mở.
- `offset_mm` / `bleed_mm` là hai tham số hình học quan trọng nhất nhưng là hai tham
  số **duy nhất** không validate ở backend (tham số phụ `edge_sample_inset_mm` thì có
  đủ `isfinite` + clamp).
- Không có `AbortController`; nút chạy lại không disable → job nặng chồng nhau.

Về hiệu năng: RAM-gating tổng thể **đúng nguyên tắc dự án** (máy ≥16 GB không bị cap),
không có hard-cap vô điều kiện. Điểm nóng còn lại là **số lần raster lặp** (trang 1 bị
raster tới 3 lần trong luồng phổ biến nhất), **pre-pass AI không có trần px** trên máy
mạnh, và **peak RAM khi merge chunk** ở nhánh song song.

## 2. Phát hiện — hợp đồng & tính năng

| Mã | Mức | Bằng chứng | Vấn đề | Ảnh hưởng |
|---|---|---|---|---|
| §BX.F01 | P1 | `StickerTool.tsx:449-459` vs `:531` vs `recipeRunners.ts:296-300` | Ba công thức `shape_mode` cho cùng thao tác. Default `cornerStyle='preserve'`: chạy tay gửi `auto_safe`, ghi recipe `contour`, phát lại gửi `contour` | Recipe phát lại ra hình cắt khác bản đã duyệt (`auto_safe` ép hình chuẩn, `contour` giữ mép ảnh) |
| §BX.F02 | P1 | `StickerTool.tsx:441` vs `:991` | Ô "Độ lẹm mép" chỉ hiện với `image/trajectory/inpaint`, nhưng giá trị cũ vẫn gửi khi chọn `solid`; engine clip artwork theo giá trị đó (`sticker_engine.py:8372`, `:8967`) | Đặt lẹm 2 mm rồi đổi sang "Đổ màu trơn" → mất 2 mm nội dung sát mép cả 4 cạnh, không ô nào nói ra |
| §BX.F03 | P1 | `StickerTool.tsx:404-405`; đối chiếu `recipeRunners.ts:266` đã kiểm | Nhánh Lật gương không kiểm `finalRes.ok` trước `.blob()` | Download 404/400 → blob JSON lỗi được commit qua `onFileFixed`, hiện "thành công", tài liệu đang mở bị thay bằng file rác |
| §BX.F04 | P1 | `StickerTool.tsx:400` (không `.catch`), `:571-575` | `bleedRes.json()` không bọc; sidecar trả HTML → message kỹ thuật lọt UI | Thợ in thấy `Unexpected token '<'…`, vi phạm quy ước thông báo lỗi |
| §BX.F05 | P1 | không có `AbortController` (grep 0 hit); `:1163-1174` nút "Hình cắt sai?" không `disabled` | Không huỷ được job; bấm nhiều lần → nhiều job PDFium song song; đóng tab vẫn `setState` khi response về | File lớn bấm sai phải chờ hết; máy đứng |
| §BX.F06 | P2 | `pdf_tools.py:1389`, `:1391` (ngoài `try`) vs `:1488-1494` | `offset_mm`/`bleed_mm` không `isfinite`, không clamp, không bắt `ValueError` | `float('abc')` → 500 trần; `'1e309'` → `inf` vào hình học; recipe hỏng gửi `'NaN'` |
| §BX.F07 | P2 | `recipeRunners.ts:277`, `:279`, `:286` | Playback bỏ qua toàn bộ clamp của UI | Recipe sửa tay/build cũ đưa giá trị ngoài khoảng xuống engine |
| §BX.F08 | P2 | `pdf_tools.py:1390` default `"round"` vs FE/recipe `preserve` | Default hai đầu lệch nhau | Request thiếu field → bo tròn góc khuôn ngoài ý muốn |
| §BX.F09 | P2 | `StickerTool.tsx:591-596` chỉ normalize trong handler, không ở initializer | Khôi phục `solid` + hex RGB từ storage cũ: UI hiện 4 ô CMYK `0,0,0,0` nhưng payload gửi `#FFFFFF` → backend đi nhánh RGB (`pdf_tools.py:1500-1512`) | Vùng bù xén đổ DeviceRGB trong bài CMYK → tách phim sai |
| §BX.F10 | P2 | `StickerTool.tsx:483-487` ghi cả khi `null`; `pdf_tools.py:1652` chỉ phát header khi có `width_mm`+`height_mm` | Thiếu header (multi-page, selection) → **xoá** `detectedShapeType/Params` đã có | Panel Bình tem bế mất thông tin hình đã dò, rơi về `RECTANGLE` cho tem tròn |
| §BX.F11 | P2 | `pdf_tools.py:1668-1671` `X-Sticker-Pages`/`-Boxes` không cap; FE **không đọc** (grep `desktop/src`) | Header JSON hàng chục KB cho file nhiều trang, payload chết | Nghi vấn response bị từ chối/cắt ở h11/WebView2 → job xong mà không nhận được file. Cần repro ≥200 trang |
| §BX.F12 | P2 | `pdf_tools.py:1666` phát `X-Sticker-Cut-Confidence`; FE không đọc | Van an toàn hiện tên hình mà không hiện độ tin cậy | Tin nhận dạng sát ngưỡng, không bấm "Hình cắt sai?" |
| §BX.F13 | P3 | `recipeRunners.ts:275`, `:280` thiếu hai nhánh `cutMode==='alpha'` mà UI có (`StickerTool.tsx:432`, `:435`) | Playback với `alpha` bật `remove_white_bg`, `corner_style` khác | Biên alpha bị dò lại bằng mask nền trắng |
| §BX.F14 | P3 | `StickerTool.tsx:92-97` + `:355-371` | `localStorage` không scope `tabId`; một effect ghi cả 14 key khi bất kỳ dep đổi | Nhiều tab cùng mounted ghi đè thiết lập của nhau |
| §BX.F15 | P3 | `StickerTool.tsx:98` `let warnedAboutStickerStorage` | Boolean toàn cục xuyên tab — vi phạm bất biến `prynx-architecture` | Nhẹ: tab thứ hai không log cảnh báo storage |
| §BX.F16 | P3 | `StickerTool.tsx:257-266` | Nút chuyển tiếp không làm gì, không nói gì khi tool bị disable | Bấm không phản hồi |
| §BX.F17 | P3 | `StickerTool.tsx:384-387` luôn `uploadPDF` | Nhánh Lật gương không dùng đường tắt `file_path` mà nhánh kia đã có | File lớn: Lật gương chậm hơn vô lý |
| §BX.F18 | P3 | `:668, 673, 681-683, 707, 727-729, 861-863` hardcode; comment EN `:251, 274-276, 306-308, 422-425, 515-517` | Text UI không qua i18n; comment tiếng Anh | Đổi sang EN thì giao diện nửa nạc nửa mỡ |
| §BX.F19 | P3 | `:397` array vs `:444` comma-string cho cùng `bleed_sides`; nhánh `'none'` không reachable | Một khái niệm hai kiểu wire + dead branch | Nợ hợp đồng |

## 3. Phát hiện — hiệu năng

| Mã | Mức | Bằng chứng | Vấn đề | Ảnh hưởng |
|---|---|---|---|---|
| §BX.P01 | P1 | `sticker_source_pipeline.py:286-290`, `:290-299` | Pre-pass AI: `max_edge_px = None` trên máy ≥16 GB; giữ `pdfium_guard` qua `to_pil().convert().copy()` | Tờ 1600 mm @300 DPI ≈ 18 898 px cạnh, ba buffer toàn khung; nhánh không-cap nằm trong khóa PDFium toàn process |
| §BX.P02 | P1 | `sticker_source_inspector.py:208`, `sticker_source_pipeline.py:290`, `sticker_engine.py:7555` | Trang 1 bị raster **3 lần** trong luồng "Bỏ nền trắng + tạo đường cắt" | Thời gian và RAM gấp ba ở bước tốn nhất |
| §BX.P03 | P1 | `pdf_tools.py:1529` + `:1644`; `heavy_job_scheduler.py:70-78` | `_sticker_job_slot` là `BoundedSemaphore(1)` acquire **blocking** SAU khi đã chiếm heavy slot + thread AnyIO; `kind="pdf-tools"` không có kind-gate | 3 job tem đồng thời chiếm hết heavy slot mà chỉ 1 chạy → merge/split/resize/OCR xếp hàng oan |
| §BX.P04 | P1 | `sticker_engine.py:9317`, `:9648-9668` | Parent giữ mọi chunk bytes trong `results` + mở pikepdf trên `BytesIO` cố ý không close | Peak RAM parent ≈ 2× tổng output, đúng lúc worker vừa nhả RAM |
| §BX.P05 | P2 | `pdf_tools.py:1526`, `sticker_engine.py:7480-7503` | DPI cứng 300; trần chỉ theo hình học, không theo RAM; tờ lớn tụt về ~95–152 DPI mà log `DPI CAP` chỉ bật khi `self.debug` | Máy 8 GB không được giảm gì ở tầng DPI; thợ in tờ lớn không biết đường cắt đang ở ~95 DPI |
| §BX.P06 | P2 | `sticker_engine.py:6866-6867` | Mid-tier 8–16 GB dùng `min(cpu-1, 2)`; bảng chuẩn của dự án là `min(cores, 4)` | Máy 12 GB/8 nhân chỉ 2 worker → gần 2× thời gian |
| §BX.P07 | P2 | `sticker_engine.py:9463-9472` | Ước lượng RAM/worker chỉ dùng khổ **trang đầu** | Bìa nhỏ + ruột tờ lớn → ước lượng thấp → quá nhiều worker → pool crash → sticky tuần tự |
| §BX.P08 | P2 | `sticker_engine.py:6790`, `:7000-7013` | `_STICKER_PARALLEL_MIN_PAGES = 6` vô điều kiện | File 2–5 trang tờ lớn chạy tuần tự trên máy 16 nhân |
| §BX.P09 | P2 | `sticker_engine.py:9670`, `pdf_tools.py:1635`, `:1641` | Serialize toàn bộ PDF **3 lần**/job (engine save → `restore_sticker_page_canvas` → `_safe_watermark`) | 3 lần đọc/ghi + 2 `os.replace` trên file hàng trăm MB, trong một suất admission |
| §BX.P10 | P2 | `sticker_engine.py:8725-8735`, `:6417-6423` | Guard trong `_banded_*_fill` trả `False` GIỮA vòng lặp sau khi đã ghi nhiều tile → caller làm lại full-ROI | Ca xấu ~2× chi phí nearest/inpaint |
| §BX.P11 | P3 | `sticker_engine.py:9475-9486` | `STICKER_MAX_WORKERS` bị kẹp bởi `available = cpu-1` | Escape hatch chỉ giảm được, không nới — lệch nguyên tắc "env luôn thắng" |
| §BX.P12 | P3 | `sticker_engine.py:7481` | `MAX_MEGAPIXELS = 40_000_000` là nhánh chết (cạnh dài đã kẹp 6000 → tổng ≤36 Mpx) | Gây ảo giác "đã chặn theo megapixel" |
| §BX.P13 | P3 | `sticker_engine.py:8492`, `:8821` | `debug_output/*.png` ghi vào cây repo, không dọn | Đĩa phình khi bật `STICKER_DEBUG` |

## 4. Điều đã kiểm và **không** phải bug

- **Khóa PDFium**: mọi lời gọi pdfium/pypdfium2 trong `sticker_engine.py` đều bọc
  `pdfium_guard()` (`:7296, 7367, 7455, 7484, 7541, 7555, 9376, 9382, 9457`); vùng khóa
  không bao encode/ghi đĩa. `sticker_page_canvas.py`/`sticker_bleed_masks.py` dùng
  pikepdf/cv2 nên không cần khóa.
- **RAM-gating**: `_auto_sticker_hw_profile` và `_cap_sticker_workers` chỉ giảm khi
  `<16 GB`; không có hard-cap vô điều kiện. `_MAX_CONCURRENT_STICKER = 1` là **cố ý**
  (đã có comment §C.3) vì engine tự trải worker theo RAM.
- **Ownership theo tab**: `useWorkspaceStore` và `useImposerSettingsStore` đều là
  context **per-tab**, không phải singleton → kết quả không nhảy tab. Không có
  `window.addEventListener` trong `StickerTool`.
- **Path traversal**: `/preflight/download` đã containment đúng (`preflight.py:433-441`);
  `file_path` của `/sticker-dieline` chặn `..`, symlink, đuôi file.
- **Validate UI**: `ToolNumberInput` chặn NaN/Infinity/ngoài khoảng; lớp đọc
  `localStorage` validate và tự dọn key hỏng. Không sửa hai phần này.

## 5. Khoảng trống bằng chứng (chưa nâng trạng thái)

- Mọi số RAM/px trong mục 3 là **số học từ hằng số trong code**, không phải đo runtime.
- §BX.F11 cần repro file ≥200 trang để biết tầng nào vỡ trước.
- §BX.P03 / §BX.P06 chưa đo thời gian chờ thật và chưa benchmark máy 8–16 GB.
- Chưa chạy lại artifact (parse page boxes của PDF xuất) trong đợt này.

## 6. Lô sửa

| Lô | File | Nội dung |
|---|---|---|
| A | `pdf_tools.py` | §BX.F06, F08, F11, F12 (phát đủ header nhỏ) |
| B | `stickerToolPolicy.ts`, `StickerTool.tsx`, `recipeRunners.ts` | §BX.F01, F02, F03, F04, F07, F09, F10, F13, F19 |
| C | `StickerTool.tsx`, `StickerCutlineTool.tsx` | §BX.F05, F12 (đọc confidence), F15, F16 |
| D | `sticker_engine.py` | §BX.P05, P06, P07, P08, P11, P12 |
| E | `sticker_source_pipeline.py` | §BX.P01 |

**Hoãn, cần đo + duyệt riêng** (đổi kiến trúc điều phối hoặc I/O, rủi ro hồi quy máy
mạnh): §BX.P02, P03, P04, P09, P10, F14, F17, F18. Ghi rõ lý do trong
`docs/BU_XEN_TAO_DUONG_CAT_FIXES_2026-08-16.md`.
