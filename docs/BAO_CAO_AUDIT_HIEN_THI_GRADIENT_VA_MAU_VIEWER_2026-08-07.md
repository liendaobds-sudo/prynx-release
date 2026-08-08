# BÁO CÁO AUDIT — HIỂN THỊ GRADIENT VÀ MÀU TRONG PDF VIEWER

**Ngày:** 2026-08-07  
**Audit unit:** `W7-U03` — PDF Viewer fidelity: PDFium → raster → transport → WebView  
**Baseline audit:** working tree tại commit `a503c79`, có thay đổi chưa commit từ công việc khác. Giai đoạn audit ban đầu chỉ cập nhật tài liệu; kết quả triển khai sau khi duyệt nằm ở §12.  
**Triệu chứng:** cùng một trang PDF, Acrobat hiển thị nền xanh cyan và chuyển sắc mượt; PrynX ngả tím, dải cong đậm hơn và gradient kém mượt.

## 1. Kết luận điều hành

Đã xác định được nguyên nhân chính trên đúng PDF khách:

1. PDF dùng tổ hợp màu/phối trộn rủi ro cao: `DeviceCMYK`, `DeviceN`, màu spot `Separation`, transparency group CMYK, soft mask và blend mode `SoftLight`/`Overlay`, nhưng **không có `/OutputIntents`**.
2. Ảnh raw do PDFium 149 của PrynX raster hóa đã lệch đáng kể so với Acrobat, trước khi qua JPEG hoặc WebView: MAE toàn vùng đối chiếu `20,342` mức RGB.
3. Khi render có quản lý màu theo giả định `FOGRA39 → sRGB`, ảnh khớp Acrobat rất gần: MAE `4,547`. Đây là bằng chứng mạnh rằng khác biệt chính nằm ở cách chọn không gian CMYK mặc định và compositing màu/transparency, không nằm ở CSS.
4. JPEG q90 hiện tại làm giảm fidelity và có thể làm banding nặng thêm, nhưng trên đúng artifact này mức sai chỉ khoảng `1–2` mức/kênh. Đây là nguyên nhân phụ, hạ từ P1 xuống P2.
5. Engine PPE hiện có cho kết quả gần Acrobat (`MAE 4,663`) nhưng mất khoảng `2,5–2,6 giây/trang` sau warm-up, chậm hơn PDFium nhiều lần. Vì vậy không nên thay toàn bộ Viewer bằng PPE một cách vô điều kiện.

**Chốt nguyên nhân:** dải cong là đối tượng thật trong thiết kế. PrynX làm nó nổi quá mạnh do đường raster PDFium hiện tại không tái hiện cùng phép quản lý màu CMYK/transparency như Acrobat; nén JPEG q90 chỉ làm phần chuyển sắc xấu thêm.

## 2. Artifact và khả năng tái hiện

| Artifact | Kết quả |
|---|---|
| PDF nguồn | `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf` |
| SHA-256 | `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184` |
| Kích thước | `17.869.243` byte; 4 trang; `748,346 × 561,260 pt`; PDF 1.4 |
| Ứng dụng tạo | Adobe Illustrator 24.2 / Adobe PDF Library 15.00 |
| Ảnh PrynX | phần trang thực `838 × 244`, khớp crop của render PDFium rộng 838 px tại `y=384` |
| Ảnh Acrobat | `1210 × 352`, khớp crop trang rộng 1210 px tại `y=556` |
| OutputIntent | Không có |
| Mốc màu Acrobat | Chưa có cấu hình Working CMYK/Output Preview của Acrobat; kết luận FOGRA39 là suy luận từ phép khớp pixel, không phải metadata PDF |

Trang 1 và trang 4 dùng cùng nền; vùng người dùng chụp nằm trên trang 1 và được đối chiếu theo đúng kích thước, không phải so ảnh đã co về một tỷ lệ tùy ý.

## 3. Luồng Viewer đã truy vết

```text
PDF đang mở
  ↓
AcrobatViewer → useTileRenderer.ts
  ↓ invoke('render_pdf_page')
desktop/src-tauri/src/lib.rs::render_tile_jpeg
  ↓
PDFium 149.0.7825.0 → RGBA 8-bit
  ↓
JPEG quality=90, không gắn ICC tại call-site
  ↓
Blob(type='image/jpeg')
  ↓
LivePageFrame <img>, không có CSS filter/color transform
```

Điểm reachable đã xác minh:

- `desktop/src/hooks/viewer/useTileRenderer.ts:86-102`: native bytes luôn được đóng thành `image/jpeg`.
- `desktop/src/hooks/viewer/useTileRenderer.ts:106-131`: fallback PDF.js cũng `canvas.toBlob(..., 'image/jpeg', 0.9)`.
- `desktop/src-tauri/src/lib.rs:1424-1660`: PDFium render sang RGBA rồi mọi nhánh đi qua JPEG q90.
- `desktop/src-tauri/src/lib.rs:395`: cache token `v6_userunit_q90`, tile đĩa dùng `.jpg`.
- `desktop/src/components/workspace/LivePageFrame.tsx:2838-2905`: ở fit/100%, full-page q90 là lớp ảnh cuối; tile sắc chỉ phủ khi zoom đòi hỏi độ phân giải cao hơn.
- `LivePageFrame` không áp CSS filter, blend mode hay phép đổi màu lên ảnh trang.

## 4. Cấu trúc màu của PDF nguồn

Parse trực tiếp trang lỗi cho thấy:

- Catalog không có `/OutputIntents`.
- Page transparency group khai báo `/CS /DeviceCMYK`.
- `/CS0` là `/DeviceN` gồm Cyan, Magenta, Black, alternate `/DeviceCMYK`, dùng function type 4.
- Có hai màu spot `Separation`: `VietinBank Dark Blue` và `VTB RED`, alternate `/DeviceCMYK`.
- `/Sh0` là axial shading type 2 trong `DeviceN`.
- ExtGState có blend mode `/SoftLight`, `/Overlay`, nhiều `/SMask` kiểu luminosity và alpha `0,399994`.
- Form lớn chứa ảnh `4042 × 2696`, 8 bpc, `/DeviceCMYK`, `/FlateDecode`, intent `/RelativeColorimetric`, kèm soft mask.

Vì không có OutputIntent, cách diễn giải `DeviceCMYK` phụ thuộc vào CMYK working space/default của renderer. Khi tổ hợp này còn đi qua transparency và spot alternate, khác biệt giữa hai compositor trở nên dễ thấy hơn một phép đổi màu CMYK đơn giản.

## 5. Đo định lượng

### 5.1. Tách PDFium khỏi JPEG và WebView

Đã dùng đúng `pdfium.dll` 149 đi kèm desktop để xuất raw PNG trước encoder, rồi so với ảnh Acrobat ở cùng kích thước/crop:

| Cặp so sánh | MAE RGB tổng | Dịch trung bình theo kênh |
|---|---:|---:|
| PDFium raw → Acrobat | `20,342` | `(+20,38; -6,70; +13,14)` |
| Poppler → Acrobat | `21,125` | `(+24,95; -12,68; +7,93)` |
| Ghostscript FOGRA39 → sRGB → Acrobat | `4,547` | `(+1,01; -2,87; -1,53)` |
| PPE hiện có → Acrobat | `4,663` | `(+1,02; -2,73; -1,90)` |

PDFium raw đã lệch trước transport. Poppler có hành vi gần PDFium. Hai đường render có quản lý màu theo FOGRA39 đều gần Acrobat rõ rệt. Đây là bằng chứng đủ để nâng nguyên nhân màu từ `[SUSPECTED]` lên `[CONFIRMED]` trên artifact này.

### 5.2. Mức đóng góp của JPEG q90

So raw PDFium với chính ảnh q90 được tạo từ raw:

| Vùng | MAE R/G/B | P95 sai số tuyệt đối |
|---|---:|---:|
| Toàn trang | `(1,101; 0,963; 1,486)` | `5` |
| Crop người dùng | `(1,069; 1,261; 1,902)` | `6` |
| Vùng gradient trơn trên-trái | `(0,633; 0,573; 0,727)` | `2` |

JPEG vẫn là bước mất dữ liệu không cần thiết đối với fidelity, nhưng không tạo ra sai màu lớn. Nó là yếu tố phụ của banding/khối DCT.

### 5.3. Sai khác còn lại giữa raw repo và ảnh chụp PrynX

Với crop `838 × 244`, ảnh PrynX chụp từ ứng dụng lệch so với raw PDFium 149 của repo trung bình `(+24,88; -1,22; -1,99)`; so với q90 là `(+24,28; -1,22; -1,90)`.

Phần đỏ tăng thêm này chưa được phép quy hoàn toàn cho WebView. Cần ghi nhận chính xác build/runtime DLL của bản PrynX đã chụp, trạng thái overlay và cấu hình màu màn hình. Đây là nhánh còn mở, nhưng không làm thay đổi kết luận rằng raw PDFium đã không khớp Acrobat.

### 5.4. Chi phí hiệu năng trên artifact này

Probe một lượt trên trang 1 bằng PDFium 149:

| Rộng | Render raw | PNG encode / bytes | JPEG q90 encode / bytes |
|---:|---:|---:|---:|
| 838 px | 308 ms | 4 ms / 444.524 B | 133 ms / 107.866 B |
| 1210 px | 172 ms | 7 ms / 771.707 B | 249 ms / 193.623 B |
| 1497 px | 235 ms | 10 ms / 1.050.611 B | 334 ms / 268.092 B |

PNG encode nhanh hơn JPEG trên thiết kế này nhưng payload/cache lớn khoảng 4 lần. Đây chỉ là probe theo nội dung, chưa đủ để chọn codec toàn cục. PPE đạt màu gần Acrobat nhưng khoảng `2,5–2,6 giây/trang` sau warm-up, nên đường chính xác màu phải có cache và chính sách kích hoạt phù hợp.

## 6. Findings

### `§GV.1` — `[CONFIRMED]` P2 — JPEG q90 làm giảm fidelity của mọi trang/tile

Native và fallback đều ép ảnh qua JPEG q90, kể cả full-page tại fit/100%. Sai số đo được nhỏ hơn nhiều nguyên nhân màu chính, nhưng bước này làm mất gradient/soft mask và có thể tạo banding. Finding cũ `§R.6` vẫn đúng, severity phù hợp là P2.

### `§GV.2` — `[CONFIRMED]` P1 — Raw PDFium đã lệch màu đáng kể so với Acrobat

MAE `20,342` xuất hiện ở raw PNG trước JPEG/CSS. Vì vậy chỉ đổi MIME, tăng JPEG q98 hoặc sửa CSS không thể chữa màu cyan → tím trên PDF này.

### `§GV.3` — `[CONFIRMED]` P1 — Đường màu hiện tại không đáp ứng PDF CMYK/DeviceN + transparency không gắn OutputIntent

Artifact chứa đúng tổ hợp CMYK, DeviceN/spot, shading, soft mask và blend mode; không có OutputIntent. Render FOGRA39 → sRGB giảm MAE từ `20,342` xuống `4,547`. Suy luận hợp lý nhất là Acrobat đang dùng một CMYK working profile gần FOGRA39, còn đường PDFium hiện tại dùng cách diễn giải/composite khác.

Không được diễn đạt finding này thành “Acrobat luôn đúng tuyệt đối”: PDF không gắn OutputIntent, nên bản thân file không quy định duy nhất màu thiết bị. Yêu cầu sản phẩm ở đây là PrynX hiển thị gần workflow Adobe mà người dùng đang dùng.

### `§GV.4` — `[CONFIRMED]` P2 — Full-page tại fit/100% cũng cần được xử lý

Chỉ đổi codec của tile sắc ở zoom cao sẽ không tác động ảnh mà người dùng đang chụp. Full-page render và tile zoom phải dùng cùng hợp đồng màu, nếu không khi tile phủ lên sẽ đổi màu từng mảng.

### `§GV.5` — `[SUSPECTED]` P1 — Runtime đã chụp còn thêm một biến đổi đỏ

Ảnh PrynX lệch thêm khoảng +24 mức ở kênh đỏ so với raw của DLL trong repo. Cần trace build/runtime, overlay và màn hình trước khi chốt là WebView color management hay DLL khác phiên bản.

### `§GV.6` — `[CONFIRMED]` P2 — Thiếu regression fixture/golden cho fidelity màu Viewer

Test hiện có bảo vệ cache, `/UserUnit`, RAM và kích thước; chưa có oracle cho DeviceCMYK/DeviceN/transparency, raw-versus-transport và màu cuối.

### `§GV.7` — `[CONFIRMED]` P1 cấu hình — asset mang tên sRGB thực ra là Adobe RGB (1998)

`backend/app/assets/icc/sRGB.icc` được `ImageCms` nhận diện là `Adobe RGB (1998)`, trong khi registry `backend/app/core/icc_profiles.py` quảng bá nó là `sRGB IEC61966-2.1` và ưu tiên file bundle. Đây là lỗi cấu hình thật, có thể làm sai các luồng Soft-Proof/ICC với nguồn DeviceRGB. PDF hiện tại chủ yếu CMYK và PPE vẫn khớp Acrobat, nên finding này **không phải nguyên nhân chính của ảnh đang báo**; cần sửa/test bằng fixture RGB riêng.

## 7. Giả thuyết đã bác bỏ

| Giả thuyết | Trạng thái | Bằng chứng |
|---|---|---|
| CSS filter/gradient của giao diện đổi màu PDF | `[DISPROVED]` | Ảnh trang không có filter/color transform; raw PDFium đã lệch. |
| JPEG q90 một mình tạo màu tím/dải cong lớn | `[DISPROVED]` | q90 chỉ khoảng 1–2 mức/kênh; raw PDFium đã MAE 20,342. |
| Dải cong hoàn toàn do codec tự sinh | `[DISPROVED]` | Dải cong là transparency/blended object có thật trong PDF; renderer chỉ làm nó nổi mạnh hơn. |
| Chèn `/DefaultCMYK` ICCBased FOGRA39 đơn giản vào PDF sẽ sửa PDFium | `[DISPROVED]` | PDFium sau chèn đạt MAE `20,671`, không tốt hơn bản gốc `20,342`; lần render đầu còn tăng chi phí nạp ICC. |
| Chỉ tăng JPEG lên q98 là đủ | `[DISPROVED]` | Không sửa được raw color/compositing đã lệch trước encoder. |

## 8. Root-cause tree

```text
Triệu chứng: tím hơn + dải cong đậm + gradient kém mượt
├── [CONFIRMED, chính] PDF không có OutputIntent
│   └── DeviceCMYK/DeviceN/spot + transparency/soft mask/blend
│       └── PDFium và Acrobat diễn giải/composite khác nhau
├── [CONFIRMED, phụ] mọi ảnh Viewer bị nén JPEG q90
│   └── thêm lượng tử hóa/banding nhưng không gây màu lệch lớn
└── [SUSPECTED] build/runtime hoặc display path thêm đỏ so với raw repo
```

## 9. Kế hoạch sửa đã được duyệt

Theo quy trình audit hai chốt, mã nguồn không được áp trước khi duyệt. Người dùng đã duyệt kế hoạch và các kết quả triển khai được chốt tại §12.

### Lô 1 — Khóa artifact và detector trang rủi ro, tối đa 5 file

- Tạo fixture tối thiểu không chứa dữ liệu khách: CMYK/DeviceN + transparency + không OutputIntent.
- Thêm test raw-versus-transport và detector các dấu hiệu: page group CMYK, CMYK image, DeviceN/Separation, SMask/blend mode, thiếu OutputIntent.
- Ghi rõ DLL/runtime identity để đóng `§GV.5`.

### Lô 2 — Loại suy giảm transport, tối đa 4 file

- Thử PNG/lossless cho full-page và tile trong chế độ chất lượng cao; native và PDF.js fallback dùng cùng MIME contract.
- Bump cache version/extension; không dùng lại tile q90 cũ.
- Benchmark bytes, encode time, peak cache/RSS trên corpus ảnh, vector, scan và ba tier RAM. Không hard-cap máy `≥16 GB`.

Lô này cải thiện gradient nhưng **không được quảng bá là đã sửa màu CMYK**.

### Lô 3 — Chế độ màu chính xác cho trang rủi ro, tối đa 5 file/lần

- Prototype đường render color-managed bằng PPE/engine tương đương, cache theo trang/zoom/profile.
- Cân nhắc tự động kích hoạt khi detector chắc chắn hoặc tùy chọn UI `Màu chính xác (chậm hơn)`; phải hiển thị trạng thái rõ ràng.
- Full-page và tile phải cùng pipeline màu để không đổi màu theo mảng khi zoom.
- Không áp post-process ICC lên RGB đã raster sai, vì thông tin CMYK/spot/transparency đã mất.

### Lô 4 — Sửa profile sRGB bị gắn nhãn sai

- Thay asset bằng sRGB thật, xác minh fingerprint/description lúc test.
- Chạy corpus RGB và CMYK để tránh sửa luồng này làm hồi quy luồng khác.

## 10. Acceptance criteria

1. Fixture rủi ro có test tự động phân biệt raw PDFium, transport và accurate path.
2. Lossless transport pixel-equal với raw bitmap; không tạo banding mới ở fit, 100%, 200%.
3. Accurate path trên artifact tương đương đạt MAE RGB `≤5` so với baseline đã duyệt, hoặc ngưỡng màu perceptual được thống nhất.
4. Full-page và tile không đổi hue khi lớp tile xuất hiện.
5. Không đọc lại cache `v6_userunit_q90` sau thay codec/pipeline.
6. Có benchmark `render_ms`, `encode_ms`, bytes/tile, peak cache/RSS; máy `≥16 GB` không bị hạ chất lượng/công suất vô điều kiện.
7. Xác minh thủ công trên Windows thật bằng đúng PDF nguồn và ít nhất 6 fixture: RGB axial/radial, CMYK, DeviceN/spot, soft mask, transparency + OutputIntent/no OutputIntent.

## 11. Trạng thái audit

## 12. Kết quả sau phê duyệt và triển khai

Các lô đã được người dùng duyệt và triển khai:

- `§GV.1/§GV.4`: full-page, tile, thumbnail native và fallback PDF.js chuyển sang PNG lossless; cache mới `v7_userunit_lossless_png`, đuôi `.png`; bộ dọn cache nhận PNG mới và JPEG legacy.
- `§GV.2/§GV.3`: thêm detector theo trang cho CMYK/DeviceN/Separation/transparency/OutputIntent; trang rủi ro tự dùng PPE + FOGRA39 → sRGB qua endpoint `viewer-accurate`.
- Accurate mode chỉ dựng trang active và tắt tile PDFium, nên không đổi hue theo từng mảng khi zoom. Nút `CMYK✓` cho phép tắt/bật; `CMYK!` báo fallback.
- `§GV.5`: metadata ghi đường dẫn/kích thước/mtime của `pdfium.dll`, app version và cache version thực chạy.
- `§GV.6`: thêm regression test detector, metadata, định tuyến accurate, DPI parity và pixel-equal PNG.
- `§GV.7`: mọi profile sRGB được LittleCMS xác minh danh tính; asset Adobe RGB bị gắn nhãn sai bị cách ly, resolver dùng sRGB hệ điều hành hoặc sRGB built-in của LittleCMS.

Đo lại đúng PDF nguồn sau sửa profile và qua chính `SoftProofEngine` mới:

| Chỉ số | Kết quả |
|---|---:|
| Engine / accuracy / MIME | `ppe+lcms` / `rip_softproof` / `image/png` |
| Kích thước so | `1210 × 907`, crop `y=555` khớp ảnh Acrobat |
| MAE RGB tổng | `4,6632` |
| Dịch trung bình R/G/B | `(+1,022; -2,727; -1,896)` |

**Trạng thái audit unit:** `ARTIFACT` cho detector → accurate renderer → PNG transport và đối chiếu đúng PDF khách; còn chờ `RUNTIME` bằng thao tác mở file trong cửa sổ Tauri thật và xác nhận nút `CMYK✓`/màu nhìn thấy trên màn hình người dùng.

### Cập nhật phản hồi runtime và hiệu năng

- Người dùng đã xác nhận màu/gradient trong app mượt; lớp accurate sau đó được chuyển
  sang progressive `display → accurate` để PDFium không phải chờ PPE.
- `§GV.P3`: endpoint accurate có cache PNG lossless theo nhận dạng PDF + profile + DPI
  + intent, single-flight chống render trùng và Viewer dựng trước hai trang liền kề.
- Đo qua đúng HTTP Viewer trên PDF audit: `2,8786 s` (miss) → `0,1296 s`
  (disk-hit), khoảng **22×** ở lần xem lại; không đổi DPI/profile/đầu ra màu.
- Chi tiết benchmark công đoạn, test và giới hạn trang đầu chưa từng dựng nằm tại
  `docs/HIENTHI_MAU_VIEWER_FIXES_2026-08-07.md`.

**Mức bằng chứng hiện tại:** màu/gradient đạt `RUNTIME`; cache đạt `RUNTIME-HTTP` và
đang chờ người dùng xác nhận cảm giác chuyển trang trên cửa sổ Tauri sau bản sửa mới.
