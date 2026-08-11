# BÁO CÁO THAM KHẢO TRƯỚC KHI THAY PDFIUM

> **Quyết định sản phẩm sau báo cáo:** các renderer bên ngoài trong tài liệu này chỉ là
> nguồn tham khảo kiến trúc, **không phải dependency hoặc phương án runtime của PrynX**.
> Roadmap được chốt theo hướng phát triển engine riêng tại
> `docs/KE_HOACH_ENGINE_PRYNX_THAY_THE_PDFIUM_2026-08-09.md`.

**Ngày:** 2026-08-09  
**Mốc source:** `89a9048d1d5eb71d64171e8c9195782da064d36a`  
**Phạm vi:** Viewer, worker render, PPE màu chính xác, khả năng thay backend render và
phạm vi loại PDFium khỏi toàn dự án.  
**Trạng thái:** khảo sát và lập kế hoạch; **chưa sửa thêm engine/runtime**.  
**Artifact trọng điểm:** `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`.

## 1. Kết luận điều hành

Không nên bắt đầu bằng một kế hoạch chung chung mang tên “thay PDFium”. PrynX đang dùng
PDFium và PPE cho hai nhiệm vụ khác nhau:

1. **PDFium** dựng nhanh trang thông thường, thumbnail, metadata, in và nhiều thao tác PDF.
2. **PPE** dựng trang màu rủi ro trong không gian mực rồi mới quy FOGRA39 → sRGB.

Với đúng PDF khách đang chậm, trang được định tuyến **PPE-only** để không phát màu PDFium
sai. Vì vậy:

> **Chỉ thay PDFium sẽ không làm file này hiện nhanh hơn.** Muốn một engine thay thế giải
> quyết được cả tốc độ lẫn màu, engine đó phải thay được cả vai trò color-managed của PPE.

Hướng nên làm trước khi quyết định:

- Giữ kiến trúc backend có thể hoán đổi.
- Đo A/B ba đường trên cùng corpus: PDFium progressive, PPE sau khi đóng các lỗi hiện tại,
  và MuPDF bản đánh giá có giấy phép phù hợp.
- Chỉ quyết định di chuyển Viewer sau khi một ứng viên vượt đồng thời gate tốc độ, màu,
  cancellation, RAM và giấy phép.
- Không viết lại toàn bộ parser/rasterizer PDF từ đầu trong giai đoạn này.

**Ứng viên đáng đánh giá nhất nếu chấp nhận giấy phép thương mại là MuPDF.** Nó có display
list tái sử dụng, scissor, hủy qua cookie, render đa luồng từ display list, ICC, Separation,
DeviceN và overprint. Bản AGPL không được đưa vào sản phẩm đóng mà chưa giải quyết giấy phép.

**Quick-win đáng thử trước khi đổi engine là PDFium progressive.** API `Start/Continue/Close`
đã có trong chính header và binding đang dùng, nhưng PrynX hiện gọi API render đồng bộ cấp cao
và hủy bằng cách kết thúc cả worker.

## 2. Ba phạm vi phải tách riêng

| Phạm vi | Ý nghĩa | Mức ảnh hưởng |
|---|---|---|
| Thay PDFium của Viewer | Chỉ thay full-page/tile/thumbnail/metadata hiển thị | Có thể làm trang thường nhanh hơn; **không trực tiếp sửa trang PPE-only** |
| Thay cả PDFium + PPE hiển thị | Một engine vừa nhanh vừa đúng CMYK/spot/transparency | Là bài toán cần benchmark màu và giấy phép; MuPDF là ứng viên đầu tiên |
| Loại PDFium khỏi toàn PrynX | Thay cả Viewer, in, layer, object geometry, flatten, export, VDP, sticker và fallback backend | Một chương trình di trú lớn, không phải một lô tối ưu Viewer |

Trong source hiện tại có ít nhất **56 file production** tham chiếu PDFium/pypdfium2:
44 file backend, 5 file Tauri và 7 file native. Vì vậy câu “thay PDFium” phải luôn ghi rõ
phạm vi nào trong ba phạm vi trên.

## 3. Bằng chứng trên đúng file khách

### 3.1. Đường render đang sống

```text
color-risk bootstrap
  → trang được đánh dấu accurate
  → useTileRenderer chọn pipeline accurate
  → POST /preflight/viewer-accurate
  → ppe_softproof
  → print_engine render CMYK/spot/transparency
  → FOGRA39 → sRGB → PNG
```

Đường này không gọi PDFium để dựng pixel cuối của trang rủi ro. Bằng chứng code:

- `desktop/src/hooks/viewer/useTileRenderer.ts:203-241`: chọn `accurate` và raster DPI.
- `desktop/src/hooks/viewer/useTileRenderer.ts:277-362`: accurate đi sidecar PPE, không đi
  `render_pdf_page` của PDFium.
- `desktop/src/components/workspace/LivePageFrame.tsx:564-580`: `accurateOnly` chỉ xin PPE.
- `desktop/src/components/workspace/LivePageFrame.tsx:3215-3271`: nền và viewport accurate đều
  dùng cùng pipeline PPE.

### 3.2. Nút thắt trang 1 không phải JPEG/PDFium

Phân tích object và benchmark release xác nhận:

- Ảnh object `4357`: `4042 × 2696`, DeviceCMYK, 8 bpc, `FlateDecode`;
  `14,53 MB` nén → `43,59 MB` mẫu.
- SMask object `4356`: cùng kích thước, DeviceGray, `FlateDecode`;
  `0,54 MB` nén → `10,90 MB` mẫu.
- Trang 1 gọi cùng ảnh qua hai Form `4330` và `4428`; lần thứ hai chỉ lộ khoảng 10 pt ở mép
  nhưng hiện vẫn giải mã toàn bộ ảnh và mask.
- Một lần render tạo 2 decode ảnh chính + 2 decode mask, khoảng `103,9 MiB` dữ liệu giải nén
  trước các bản sao phụ.
- `decode_soft_mask()` dựng alpha `f32` toàn nguồn và `components_at()` cấp phát `Vec` cho
  từng pixel; hai mask tạo khoảng **21,8 triệu cấp phát nhỏ**.

Điểm code:

- `print_engine/src/image/sampler.rs:227-349`: mỗi `decode_image()` giải filter, unpack mẫu
  và gọi lại `decode_soft_mask()`.
- `print_engine/src/image/sampler.rs:353-394`: dựng `Vec<f32>` toàn ảnh cho SMask.
- `print_engine/src/image/sampler.rs:56-65`: `components_at()` cấp phát một `Vec` mỗi lần gọi.
- `print_engine/src/content/interp.rs:2199`: mỗi lần gặp `Do` lại gọi `decode_image()`, chưa có
  cache ảnh theo object.
- `print_engine/src/image/filters.rs:104`: copy stream nén ngay từ đầu bằng `raw.to_vec()`.

Benchmark cold process hiện tại:

| Trang / DPI | Render |
|---|---:|
| Trang 1 @24 DPI | khoảng `1,14 s` trung vị |
| Trang 2 @24 DPI | khoảng `0,425 s` |
| Trang 3 @24 DPI | khoảng `0,448 s` |
| Trang 4 @24 DPI | khoảng `1,116 s` |
| Trang 1 @12/24/48/96 DPI | `1,066 / 1,089 / 1,157 / 1,467 s` |

Thời gian gần như không đổi từ 12 đến 24 DPI chứng minh đây là sàn giải mã ảnh nguồn,
không phải số pixel đầu ra. Tối ưu bounded ExtGState soft-mask vừa làm cũng không chạm nút
thắt này, vì đây là **image `/SMask`**.

### 3.3. Hiện có nhiều PDFium khác phiên bản

| Artifact | Phiên bản | Vai trò hiện thấy |
|---|---:|---|
| `desktop/src-tauri/bin/pdfium.dll` | `149.0.7825.0` | Viewer/Tauri; được bundle qua `tauri.conf.json` |
| `backend/venv/.../pypdfium2_raw/pdfium.dll` và `native/pdfium.dll` | `126.0.6462.0` | sidecar/pypdfium2; release script copy `native/pdfium.dll` |
| `native/pdfium_lib/bin/pdfium.dll` | `150.0.7857.0` | artifact native/build riêng |

Đây chưa được kết luận là nguyên nhân của file đang báo, nhưng là rủi ro parity khi nói đến
“thay PDFium toàn dự án”. Trước khi di trú phải chốt một inventory runtime/installer duy nhất.

## 4. Rà soát các engine tham khảo

### 4.1. PDFium hiện tại

Tài liệu public của PDFium ghi rõ toàn bộ API không thread-safe; embedder phải gọi từ một
thread hoặc tự serialize. PrynX dùng process worker là đúng hướng.

PDFium đồng thời có API progressive:

- `FPDF_RenderPageBitmap_Start()` bắt đầu render có callback pause.
- `FPDF_RenderPage_Continue()` tiếp tục theo lát thời gian.
- `FPDF_RenderPage_Close()` giải phóng sau khi hoàn tất **hoặc hủy**.

Binding `pdfium-render 0.8.37` đang có đủ ba hàm, nhưng đường sống PrynX dùng
`render_with_config()` đồng bộ tại `desktop/src-tauri/src/lib.rs:2196-2199`. Khi hủy,
parent kết thúc cả worker tại `desktop/src-tauri/src/lib.rs:2605-2609`.

**Kết luận:** nên prototype progressive/cancel trước khi bỏ PDFium. Nó không sửa màu
DeviceCMYK của file mẫu, nhưng có thể giảm restart worker và thời gian request cũ chặn request mới.

Nguồn chính thức:

- [PDFium `fpdfview.h`: API không thread-safe](https://pdfium.googlesource.com/pdfium.git/+/c9f0b0fe8192aa4555b6516c4fb2d01f5061c0a8/public/fpdfview.h)
- [PDFium progressive rendering API](https://pdfium.googlesource.com/pdfium/+/master/public/fpdf_progressive.h)
- [PDFium BSD license](https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/2028/LICENSE)

### 4.2. PDFium + Skia

PDFium cho phép chọn AGG hoặc Skia, nhưng public header vẫn gọi renderer type này là
**experimental**; build phải chứa backend tương ứng, chọn sai có thể fail ngay lúc init.

**Kết luận:** có thể là một biến benchmark về raster/AA, không được coi là lời giải màu
CMYK/DeviceN và không đưa thẳng vào release.

Nguồn:

- [PDFium renderer type AGG/Skia](https://pdfium.googlesource.com/pdfium.git/+/c9f0b0fe8192aa4555b6516c4fb2d01f5061c0a8/public/fpdfview.h)

### 4.3. MuPDF

MuPDF có các đặc tính gần nhất với kiến trúc Viewer cần có:

- Display list ghi lệnh trang một lần rồi replay nhiều lần, tránh diễn giải lại tài liệu cho
  mỗi mức zoom.
- `fz_run_display_list()` nhận `scissor` để chỉ chạy vùng cần dựng.
- `fz_cookie.abort` cho phép hủy render; có progress nhưng không cam kết upper-bound cho latency hủy.
- Document phải serialize, nhưng display list đã tạo có thể render từ nhiều context/thread,
  kể cả banded rendering.
- Hệ màu hỗ trợ ICC, CMYK, Separation, DeviceN, rendering intent và overprint control.

Điểm chặn là giấy phép: MuPDF phát hành theo AGPL hoặc giấy phép thương mại của Artifex.
Không được đưa bản AGPL vào PrynX đóng trước khi có quyết định pháp lý/thương mại.

**Kết luận:** đây là ứng viên số 1 cho một prototype “unified display + accurate” có feature
flag, nhưng chỉ được ship khi license đã được duyệt và artifact màu vượt PPE hiện tại.

Nguồn chính thức:

- [MuPDF display list và scissor/cookie](https://mupdf.readthedocs.io/en/1.28.0/_static/generated/c/html/display-list_8h.html)
- [MuPDF multi-threading](https://mupdf.readthedocs.io/en/latest/reference/c/overview.html)
- [MuPDF cancellation cookie](https://mupdf.readthedocs.io/en/latest/_static/generated/c/html/structfz__cookie.html)
- [MuPDF ICC, Separation, DeviceN và overprint](https://mupdf.readthedocs.io/en/1.28.0/reference/c/fitz/colors.html)
- [MuPDF license](https://mupdf.com/releases)

### 4.4. PDF.js

PDF.js có worker parsing, `RenderTask.cancel()` và callback `onContinue` cho incremental
rendering. Viewer mẫu chỉ giữ/render canvas trang đang nhìn để giảm RAM. License Apache 2.0.

Tuy nhiên, đây là renderer Canvas/Web tiêu chuẩn; không có bằng chứng nó thay được pipeline
prepress CMYK/spot/overprint của PPE trên corpus PrynX. Source hiện tại đã giữ PDF.js làm
fallback cho file không có native path.

**Kết luận:** giữ làm fallback và nguồn tham khảo scheduler/compositor; không chọn làm engine
màu chính.

Nguồn:

- [PDF.js RenderTask cancel/onContinue](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-RenderTask.html)
- [PDF.js worker/display/viewer layers và Apache 2.0](https://mozilla.github.io/pdf.js/getting_started/)
- [PDF.js chỉ render trang nhìn thấy để giảm RAM](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)

### 4.5. Poppler

Poppler có API partial render và callback abort ở Qt; nhưng core/binding mang GPL. Trên chính
artifact màu, audit trước đã đo Poppler → Acrobat `MAE 21,125`, không tốt hơn PDFium raw
`20,342`.

**Kết luận:** không đưa vào shortlist PrynX đóng và không kỳ vọng sửa màu file mẫu.

Nguồn:

- [Poppler partial render/abort API](https://poppler.freedesktop.org/api/qt5/classPoppler_1_1Page.html)
- [Poppler GPL source header](https://poppler.freedesktop.org/api/cpp/poppler-global_8h_source.html)

### 4.6. PPE tự phát triển

PPE đã chứng minh có thể khớp ảnh Acrobat trên artifact (`MAE 4,6632`) và hiện nhanh hơn
baseline cũ rất nhiều sau các tối ưu shading/soft-mask. Nhưng nó chưa phải renderer Viewer
hoàn chỉnh, và đợt bounded soft-mask hiện tại còn finding correctness/RAM chưa đóng.

Rà chéo độc lập xác nhận các blocker trước khi coi benchmark mới là hợp lệ:

1. `/Alpha` dùng `0` thay vì `TR(0)` ở dải 1 px ngoài `/BBox`
   (`print_engine/src/content/interp.rs:1812`).
2. Clip bằng text cập nhật mask nhưng chưa cập nhật `clip_region` (`:3511`).
3. Guard-band 1 px không đủ cho lấy mẫu soft-mask lồng bán kính 3 px
   (`:1691`, `:3540`; `print_engine/src/ink.rs:2084`).
4. RGB sidecar có thể được cấp phát dù không có ColorManager (`interp.rs:1677`).
5. Một số raster/mask cục bộ chưa được tính đủ vào MemoryBudget
   (`interp.rs:1569`; `raster/mask.rs:98`).
6. API public đổi sang `SoftMask` nhưng constructor chỉ `pub(crate)`
   (`print_engine/src/ink.rs:665`).

**Kết luận:** PPE vẫn là đường chính xác chiến lược, nhưng không nên tuyên bố đã thay được
PDFium/Acrobat trước khi đóng các blocker và có corpus render rộng.

## 5. Findings có bằng chứng

| Mã | Mức / effort | Finding |
|---|---|---|
| `§PDFR.1` | P1 quyết định / S | Thay PDFium Viewer không tác động đường pixel của file đang chậm vì trang đã PPE-only |
| `§PDFR.2` | P1 perf / M | Sàn trang 1 nằm ở decode lặp image Flate + image SMask và hàng triệu cấp phát nhỏ |
| `§PDFR.3` | P1 correctness / M | Bounded soft-mask mới chưa merge-ready dù test hiện tại xanh |
| `§PDFR.4` | P1 kiến trúc / L | “Loại PDFium toàn dự án” chạm ít nhất 56 file production và nhiều hợp đồng không thuộc Viewer |
| `§PDFR.5` | P2 parity / M | Source/build đang có nhiều PDFium DLL khác phiên bản; phải inventory runtime trước di trú |
| `§PDFR.6` | P1 quick-win / M | Progressive API đã có nhưng PrynX chưa dùng; cancel hiện giết worker |
| `§PDFR.7` | P1 lựa chọn / L | MuPDF phù hợp kỹ thuật nhất cho unified renderer nhưng bị chặn bởi AGPL/commercial license |
| `§PDFR.8` | P2 / M | PDF.js phù hợp fallback/scheduler reference, không có bằng chứng prepress color parity |
| `§PDFR.9` | P2 / S | Poppler vừa bất lợi giấy phép vừa không cải thiện màu artifact |
| `§PDFR.10` | P1 chương trình / XL | Viết một engine PDF hoàn chỉnh riêng là roadmap nhiều phase, không phải quick fix Viewer |

## 6. Kế hoạch đề xuất sau khi duyệt

Mỗi lô tối đa 5 file, có baseline/test/artifact xong mới sang lô kế. Không đổi mặc định runtime
trong các lô thử nghiệm.

### Lô 0 — Đóng blocker PPE hiện tại

- Sửa sáu finding bounded soft-mask ở §4.6.
- Thêm test pixel ngay ngoài `/BBox`, text clip, nested mask, MemoryBudget và API external.
- Chỉ sau khi output parity đạt mới dùng benchmark PPE làm mốc quyết định engine.

### Lô A — Tối ưu đúng nút thắt file khách

Tối đa 5 file:

1. `image/sampler.rs`: bỏ alpha `f32` toàn nguồn, đọc một component không cấp phát và giữ
   SMask đã decode.
2. `image/filters.rs`: tránh copy stream nén vô điều kiện.
3. `content/interp.rs`: cache `Arc<SampledImage>` theo ObjectId trong một lần render.
4. `ink.rs`: tính cache vào MemoryBudget bằng lease RAII; không hard-cap máy mạnh.
5. `tests/render_image.rs`: khóa reuse qua Form, CTM/clip/alpha, SMask, `/Decode` và RAM thấp.

Gate đề xuất: trang 1 @24 DPI còn khoảng `0,35–0,65 s` hoặc nhanh hơn ít nhất 40%; trang
2–3 không chậm quá 5%; output và soundness giữ parity ở 12/24/48/96 DPI.

### Lô B — Shootout renderer độc lập, chưa route UI

Tạo harness cùng request contract hiện có, đo:

- PDFium đồng bộ hiện tại.
- PDFium progressive + close/cancel.
- PDFium Skia nếu build đánh giá khả dụng.
- MuPDF bản đánh giá, tách process, chưa bundle release.
- PPE sau Lô 0/A.

Corpus bắt buộc:

1. `CMNM2026 - Giay moi_BLUE - in.pdf`.
2. RGB vector/text và scan/photo.
3. DeviceCMYK, DeviceN/spot, OutputIntent có/không.
4. Transparency group, soft mask image/vector/text và blend modes.
5. OCG, form/annotation, Type3, malformed/encrypted.
6. [Ghent PDF Output Suite 5.0](https://gwg.org/gos5/) cho transparency, overprint,
   CMYK, spot và CMS.

Đo cold/warm first correct frame, zoom/pan tile, cancel latency, cache hit, peak RSS, pixel/color
parity và soundness. Không chọn engine chỉ dựa trên một file hoặc một con số render_ms.

### Lô C — Prototype PDFium progressive trong worker

- Chia render thành lát thời gian; parent có thể cancel mà không kill process ở ca bình thường.
- Interactive request luôn được ưu tiên; background nhường giữa các lát.
- Crash/timeout vẫn giữ cơ chế kill/restart làm tầng bảo vệ.
- Chỉ áp trang display thường; không thay policy màu PPE-only.

Chỉ bật `auto` nếu P95 `supersede → tile mới` tốt hơn mà không tăng crash/RSS và bitmap parity đạt.

### Lô D — Prototype MuPDF có feature flag

- Adapter chạy process riêng, không nối trực tiếp vào process UI.
- Tạo display list một lần/trang; viewport dùng scissor; cancel dùng cookie.
- Cấu hình ICC/OutputIntent/profile giả định cùng contract PPE.
- Không đưa binary vào installer trước khi license thương mại/pháp lý được duyệt.
- Dual-render artifact giữa MuPDF, PPE và Acrobat; mọi sai khác spot/transparency phải fail-loud.

### Lô E — Chốt nhánh sản phẩm

| Kết quả shootout | Quyết định |
|---|---|
| MuPDF đạt màu/tốc độ/RAM và license được duyệt | Di trú **Viewer trước**, giữ PDFium cho in/edit/object APIs; chuyển từng capability sau |
| MuPDF nhanh nhưng không đạt màu | Chỉ cân nhắc display thường; PPE vẫn là accurate engine |
| MuPDF không vượt rõ ràng | Không thay; dùng PDFium progressive + PPE cache/persistent worker |
| PPE đạt target sau cache | Giữ hybrid hiện tại; đầu tư PPE theo capability, không xóa PDFium vội |

### Lô F — Rollout an toàn nếu có engine mới

- Feature flag `current|candidate|required`, fallback trong ít nhất một release.
- Cache key mang engine/version/profile; không tái dùng bitmap chéo engine.
- Installed smoke clean-user, crash/restart, multi-tab, print song song và RAM tier.
- Chỉ gỡ PDFium khỏi một capability khi corpus và artifact của capability đó đạt; không xóa
  dependency toàn dự án trong một lần.

## 7. Gate quyết định

### Tốc độ

- File khách: first **correct-color** frame, không dùng frame PDFium sai màu để làm đẹp số.
- Trang thường: P50/P95 `open → visible`, `zoom-stop → sharp`, `pan → sharp`.
- Cancel: đo `supersede → request cũ dừng` và `supersede → tile mới visible`.
- Cache hit RAM/đĩa phải tách khỏi cold render.

### Chất lượng

- Artifact màu trọng điểm giữ `MAE RGB ≤5` so baseline Acrobat đã duyệt.
- Không banding/hue seam giữa nền và viewport.
- Ghent Output Suite không xuất dấu lỗi ở transparency/overprint/spot/CMS theo cấu hình chuẩn.
- Không output unsound/degraded nào được gắn nhãn accurate hoặc ghi vào cache accurate.

### Tài nguyên và ổn định

- Peak RSS theo từng process và toàn app.
- `<8 GB` giảm background/cache; `8–15 GB` giảm nhẹ; `≥16 GB` không hạ chất lượng hoặc hard-cap
  vô điều kiện.
- Worker crash không kéo sập UI; request kế tiếp tự phục hồi.
- Không regression in, layer, edit, VDP, sticker và export ngoài phạm vi Viewer.

### Pháp lý/phát hành

- Dependency và NOTICE đúng license.
- MuPDF chỉ được bundle sau khi quyền phân phối cho PrynX đã được xác nhận.
- Manifest/hash/version của installer phải chỉ ra chính xác engine/DLL được chạy.

## 8. Chốt duyệt

Khuyến nghị hiện tại:

1. **Không bắt đầu bằng việc xóa PDFium.**
2. Đóng blocker PPE và tối ưu image SMask/cache đúng file khách.
3. Song song làm shootout PDFium progressive và MuPDF bản đánh giá.
4. Dựa vào số đo + license để chọn “giữ hybrid” hay “di trú Viewer sang MuPDF”.
5. Dù chọn MuPDF, di trú Viewer trước; không thay 56 file production trong một đại refactor.

Báo cáo dừng tại đây để chờ duyệt. Chưa có thay đổi runtime/engine nào được thực hiện trong
đợt tham khảo này.
