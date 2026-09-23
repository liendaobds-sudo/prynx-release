# Audit xuất ảnh: sai màu so với workflow Illustrator/Photoshop

> Bổ sung file khách trong ngày21/09: đã nhận và kiểm `test/xuat anh`. `prynx.jpg` thực tế làRGB/JPEG100, tái xuất cùngPDF khớp decodedpixel100%; ảnhchụpCMYK/JPEG90 không khớp thiếtlập filegửi. Illustrator làCMYK khôngICC, nguồn cóOutputIntentGRACoL. CMYK táixuất có4kênh và sốmực nền gầntrùngAI nhưng vẫntagFOGRA39. Xem `DOI_CHIEU_FILE_KHACH_XUAT_ANH_2026-09-21.md`. Giới hạn “chưa có cặpfilekhách” bên dưới là baseline trước khi nhậnfile; chưa có GUIreplay/RIP/bảnin. Không gán lỗioverprint cho mẫu này.

Ngày2026-09-21. HEAD `703ffc2604ad5e5ff0ef391d9684e05688693c2b`. Working tree sạch lúc bắt đầu. **Chỉ audit; không sửa production, không đổi profile hệ thống, không gửi lệnh in.**

## 1. Kết luận điều hành

Phản ánh sai màu có cơ sở kỹ thuật: đã tái hiện **4 vấn đề trên artifact thật** qua hàm xuất production. Hai vấn đề ưu tiên cao:

1. CMYK ICCBased nguồn có profile khác FOGRA39 bị giữ nguyên kênh rồi gắn FOGRA39. Đây là đổi cách diễn giải màu, không phải chuyển ICC để giữ diện mạo.
2. RGB và CMYK dùng hai renderer với semantics overprint khác nhau. Fixture cùng một PDF cho vùng chồng màu **hồng ở RGB**, nhưng **xanh tím ở CMYK**; Ghostscript mô phỏng overprint cùng profile xác nhận kết quả xanh tím.

Hai vấn đề thêm: Grayscale dùng phép RGB→L không quản lý ICC rồi gắn Gray Gamma2.2; WebP grayscale thực tế lưu RGB nhưng gắn ICC một kênh GRAY.

Không thể kết luận đây chính là nguyên nhân của mọi phản hồi khách: chưa có PDF nguồn và cặp file xuất PrynX/Adobe của ca khách, chưa biết cấu hình RIP/driver. Bằng chứng hiện tại đạt **AUTO + ARTIFACT**, chưa A/B GUI Illustrator/Photoshop, chưa đo bản in vật lý.

**Không phải thiếu ICC toàn bộ**, và tăng DPI/chất lượng JPEG không chữa hai lỗi chính: hai ca đã kiểm lại300DPI vẫn giữ sai khác màu. Các bản sửa AA/UserUnit/ICC/cancel ngày30–31/07 và08/09 không bị gọi lại là chưa sửa.

## 2. Luồng đang chạy

Các đường dẫn tương đối với D:/pdfcompare:

- `desktop/src/components/AcrobatViewer.tsx` chuẩn bị working PDF → `workspace/ExportImageModal.tsx:231-277` → `desktop/src/lib/api.ts:699,743` gửi `/api/export/images` hoặc `/images/batch`.
- `backend/app/main.py:390` đăng ký router export. Route single `export.py:671+`, batch`:788+` đẩy việc render vào scheduler/threadpool; batch`:761` cũng gọi cùng `render_pdf_to_images`.
- RGB/Gray: `backend/app/api/routes/export.py:457,514-517,583-592` → pypdfium2 render → Pillow RGB/L → nhúng sRGB hoặc Gray Gamma2.2 → PNG/JPEG/TIFF/WebP.
- CMYK: `export.py:327,352,377` → `backend/app/core/print_engine/facade.py:1357-1406` → `native/src/print_engine_py.rs:1329-1407` → PPE cmyk_export, ColorManager, render_page_managed → to_process_cmyk → Pillow TIFF/JPEG và ICC FOGRA39.
- Export UI/schema nhận RGB/Gray/CMYK nhưng không truyền profile đích/nguồn, rendering intent hoặc overprint. UI`:481` có ghi CMYK dùngFOGRA39; không nói tùy chọn này hoàn toàn bị giấu. Facade mặc địnhFOGRA39, relative colorimetric, simulate_overprint=true.

Native hiện dùng trong probe: `backend/venv/Lib/site-packages/pdfcompare_native/pdfcompare_native.cp311-win_amd64.pyd`, mtime2026-09-21 09:23:58, SHA256 `950b45c85538aef1b59ce4b02bc6a2d01de7b9ce9cf34bb3741a79e580115f44`. Không rebuild hoặc cài lại.

## 3. Corpus và oracle

8 PDF kiểm thử độc lập, không có dữ liệu khách:

- ICCBased CMYK vector: SWOP vàFOGRA39 cùng6bộ số màu.
- ICCBased CMYK image: SWOP, cùng6ô màu.
- DeviceCMYK + OutputIntent: SWOP vàFOGRA39, cùng6ô.
- ICCBased RGB: AdobeRGB1998 vàsRGB, cùng6ô.
- Overprint: nềnC100, vùngM100 đặt `/op true`, `/OP true`, `/OPM 1`.

Đã xuất16ảnh RGB/CMYK từ8PDF ở72DPI,4ảnhgray theo4format; thêm2ảnh300DPI để loại giả thuyết độ phân giải. Đọc lại mode, số kênh, ICC header/description/hash và pixel giữa ô (không lấy biên anti-alias/JPEG). Kiểm fixtureCMYK dùng TIFF lossless.

Oracle ICC: LittleCMS qua Pillow, profile nguồn thựcUSWebCoatedSWOP, profile đích là **chính bundleFOGRA39 của PrynX**, relative colorimetric+BPC; không so hai profile đích khác nhau rồi gọi là engine sai. Oracle overprint: Ghostscript10.04.0, `-dOverprint=/simulate`, nguồnCMYK vàđíchRGB chỉ định tường minh.

Đã xem bảng3hàng source/proof/export và cặp overprint. Các phép ΔE bên dưới là **ΔE76 từ Lab8bit**, có lượng tử; không gọi là ΔE00, không phải số đo máy quang phổ hay mức sai của mọi file khách.

## 4. Finding xác nhận

### EXPCOLOR21.01 — P1 / effort M-L — Giữ số CMYK nhưng đổi profile, làm đổi diện mạo

**[CONFIRMED / ARTIFACT]**

Consumer: `print_engine/src/color/space.rs:286-293` thấy ICCBased4kênh thì gọi alternate DeviceCMYK, bỏ qua transform profile nhúng. DeviceCMYK`:235-244` giữ nguyên4kênh. `export.py:352,406,435,440` lại gắn FOGRA39 cho ảnh.

Đây là bất biến có chủ đích ở **đo mực/TAC**: không được chuyển profile để làm số mực400% thành số thấp hơn rồi báo đạt. Nhưng dùng cùng chính sách cho **ảnh xuất cần giữ màu** và gắn profile khác tạo lỗi. Không sửa blanket chính sách giữ mực của separations/TAC.

Kết quả đo:

- Hai PDF vectorSWOP/FOGRA39 cùng số màu cho **CMYK output giống nhau từng sample** và cùng ICCFOGRA39, dù diện mạo nguồn khác nhau. ImageICCBasedSWOP cũng bị giữ số tương tự; không chỉ vector.
- M100SWOP có diện mạo sRGB tham chiếu `(236,0,140)`; PrynX trảM100 nhưng tagFOGRA39, khi proof thành `(230,0,126)`.
- C100SWOP: `(0,174,239)` → PrynX/FOGRA39 `(0,159,227)`.
- Trong6ô, ΔE76 khoảng **3.0–6.176** khi diễn giải đúng profile nguồn so với filePrynX đã tag. Đây không phải lỗi nénJPEG vì đoTIFF.
- Chuyển SWOP→FOGRA39 bằngICC thực sự có thay đổi số kênh; ví dụM1008bit `(0,255,0,0)` thành `(5,242,0,0)`. Không buộc mọi workflow phải dùng đúng tuple này: preserveK/intent/BPC/gamut policy có thể khác; điểm đã chứng minh là hiện không làm chuyển ICC4kênh mà vẫn thay profile.
- FixtureDeviceCMYK đổi OutputIntentSWOP↔FOGRA39 không đổi pixel ở cảRGB/CMYK. Export chưa dùng OutputIntent để quyết định policy màu; không tự suy được điều kiện in tài liệu. Không coi OutputIntent là lệnh bắt mọi workflow phải convert, nhưng khi không dùng phải công khai quy tắc fallback/preserve.

Control quan trọng: nguồn ICCBasedFOGRA39 xuấtFOGRA39 giữ số là hợp lý; **không kết luận mọi CMYK đều sai**. AdobeRGB3kênh được xử lý: ô(.2,.6,.4) raRGB `(0,154,99)` thay vì sRGB `(51,153,102)`. Không nói toàn engine bỏ mọi ICC.

### EXPCOLOR21.02 — P1 / effort M-L — RGB không mô phỏng overprint như CMYK

**[CONFIRMED / ARTIFACT]**

Consumer: RGB dùng `page.render` tại `export.py:583` không có policy overprint; CMYK mặc định `simulate_overprint=True` tại facade`:1364,1401`, native`:1372+`.

Fixture nềncyan vàmagentaoverprint cho kết quả giữa vùng chồng:

| Đường | Pixel |
|---|---|
| PrynX RGB PNG | RGB `(237,2,140)` — magenta |
| PrynX CMYK TIFF | CMYK `(255,255,0,0)` — C+M |
| CMYK TIFF proof bằng đúngICCFOGRA39→sRGB | RGB `(49,39,131)` — xanh tím |
| Ghostscript `Overprint=/simulate`, cùngprofile | RGB `(49,39,131)` — trùng proofCMYK |

Sai khác này lớn hơn khác biệtCMM/ICC nhỏ: một bên đã knockoutcyan. Khi đã raster thànhRGB sai semantics, driverin phía sau không thể biết phải khôi phục lớpcyan. 300DPI vẫn raRGB `(237,2,140)`.

Không nói Illustrator luôn mô phỏngoverprint với mọi thiết lập. Kết luận là PrynX chưa có hợp đồng nhất quán giữa output modes; để soAdobe phải cùng trạng tháioverprint/proof.

### EXPCOLOR21.03 — P2 / effort S-M — Gray Gamma2.2 được gắn sau một phép grayscale không ICC

**[CONFIRMED / ARTIFACT; policy gap về bảo toàn sáng]**

Consumer: `export.py:592` gọi `.convert('L')`, còn`:517` chọn profileGrayGamma2.2. Pillow dùng weighted lumaITU-R601, không phải ICCsRGB→GrayGamma2.2.

| Ô sRGB | PrynXGrayPNG/TIFF | LCMS→chính profileGrayGamma2.2 xuất kèm |
|---|---:|---:|
| Đỏ100% |76|129|
| Lục100% |150|219|
| Lam100% |29|71|

Đây là khác biệt thuật toán về độ sáng, không phải metadata DPI. Có thể thiết kế grayscale theo luma nghệ thuật, nhưng hiện không có policy nêu rõ và không tương đương chuyểnprofileGray để giữ độ sáng. Không khẳng địnhPhotoshop mặc định dùngGamma2.2; workflowAdobe phải chọn cùnggrayprofile khi nghiệm thu.

### EXPCOLOR21.04 — P2 / effort S — WebP grayscale: RGB pixels đi với ICCGRAY

**[CONFIRMED / ARTIFACT]**

Consumer: `export.py:627-632` dùngprofilegraychoWebP giốngPNG. Pillow/codecWebP lưu ảnh thànhRGB; mở lại modeRGB3kênh nhưng headerICC là`GRAY`1kênh. Với chính filexuất, `ImageCms.profileToProfile(..., outputMode='RGB')` trả **cannot build transform**.

Cần biến đổi gray quaICC sangRGB và gắnprofileRGB phù hợp, hoặc chặn mode không hỗ trợ. Không chỉ đổi nhãnprofile nếu giá trị chưa thuộc không gian mới.

## 5. Những kết luận không được suy rộng

- RGB/CMYK/Gray hiện đều có nhúngICC; lỗi không phải đơn giản “quênICC”.
- CMYK không đi vòngRGB→CMYK bằngPillow; PPE trả4kênh thật.
- SourceFOGRA39 đơn giản vàICCBasedRGBcontrol có thể đúng; không ép mọi tài liệu qua cùng một lượtconvert mới.
- PNG/WebP không hỗ trợ4kênhCMYK và đã bị chặn; đây là hành vi đúng.
- GiữKthuần, spot/DeviceN vàTAC cần chính sách riêng; không làm round-trip toàn bộ ink-accurate chỉ để screenshottrônggiốngAdobe.
- Chưa audit toàn bộ gradient/blendmode/transparency/spot/fallbackfont củaPPE trong lượt này. Tài liệu cũ đã có proofgap; không tự đóng bằng22ảnhpatchphẳng.
- JPEG lossy, gamutRGB/CMYK, profilemáy/giấy và quản lýmàu kép ởdriver cũng có thể gây lệch, nhưng **chưa có bằng chứng về cấu hình máy khách** để đổ lỗi cho chúng.

## 6. Đối chiếu tài liệu chính thức

- Illustrator cho chọnColorModel vànhúngICC khi xuấtJPEG/TIFF; đổi môhình màu có thể ảnh hưởng vùngtrongsuốt. [Adobe: Export artwork](https://helpx.adobe.com/illustrator/using/exporting-artwork.html).
- Photoshop tách PhotoshopManagesColors vàPrinterManagesColors. KhiPhotoshopquản lýmàu, Adobe yêu cầutắt quản lýmàu ởdriver đểkhông ghiđèchuyểnđổi; chọn đúngprofilemáy/giấy. [Adobe: Printing color management](https://helpx.adobe.com/photoshop/using/printing-color-management-photoshop1.html).
- `.convert('L')` dùngITU-R601luma, không phảiICCtransform. [Pillow: Image.convert](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.Image.convert).
- Ghostscript `/simulate` giữoverprint khi đầu raRGB/Gray. [Ghostscript: Overprint](https://ghostscript.readthedocs.io/en/master/Use.html).

Do đó tiêu chí “giốngAdobe” phải cùngfile, profile, intent/BPC, overprint, nềnflatten vàdriver/RIP; không chỉ cùng300DPI hoặc cùngCMYK.

## 7. Verify và bằng chứng

```powershell
# D:/pdfcompare/backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_export_images.py tests/test_icc_and_color_preview.py
# 70 passed, 1 Pydantic warning có sẵn.
# D:/pdfcompare/desktop
npx vitest run src/components/workspace/ExportImageModal.test.ts
# 10 passed.
```

Probe chính: `D:/printsolutions-main/product/xep quan ao/tmp/audit_export_color_20260921.py`; assertion độc lập: `verify_export_color_audit.py`. Artifacts trong `tmp/pdfs/export-color-20260921/`, `evidence.json`, `verification.json`. 7nhómassertion đạt; lỗiLCMSWebP là expectederror xác nhậnmismatch, không phải thiếudependency.

Ghostscript đã dùng cúpháp đúng`-dOverprint=/simulate` cho lượtđối chứng cuối. Lượt thửcúpháp cũ`SimulateOverprint` bịthôngbáo khônghỗtrợ, **không dùng làm evidence**.

Mode/profile tests hiện hữu chủyếu kiểm ICCtồn tại/sốkênh/render thànhcông.70+10testxanh không chứngminh appearance/fidelity print. Không chạyCargo/typecheck/build vìkhông sửaproduction; khôngthay native/app đangmở.

## 8. Đề xuất sửa theo lô — CHỜ DUYỆT

1. **Chốt hợp đồng xuất màu và tách khỏi đo mực:** xácđịnhprofile nguồn ICCBased/DefaultColorSpace/OutputIntent/fallback; chọngiữprofile/sốmực khi phùhợp hoặcchuyểnsangprofileđích cóýthức. Cầnprofile/intent/BPC/preserveK rõràng; khônggánFOGRA39cho sốthuộcprofilekhác. KhôngtácđộngTAC/separations ngoàiýmuốn.
2. **Đồng bộ raster màu và overprint:** chọnengine/đườngproof cóhợpđồng chungchoRGB/CMYK; RGBpreview thường vàRGBsảnxuất cầnphânbiệt. VớiPPE cócaunsoundphải fail-loud, khôngâmthầm fallbacksai màu; khôngRGBhoátrước rồiđổiCMYKgiả.
3. **Gray/WebP:** ICCtransformđúngđích; validateprofile-space↔pixel-mode khiđọc lạifile.
4. **Khóa regression:** SWOP/FOGRA/AdobeRGB/sRGB, vector+image, pureK/spot/overprint, transparency, multipage; ICCdigest, pixel/ΔE, warning vàartifact. Mỗi lô≤5file, verifyrồi nghiệmthu filekhách vàbảnin.

Cần ca khách để kếtluậncuối: cùng1PDFgốc, 1ảnhPrynX, 1ảnhIllustrator/Photoshop, thiếtlậpformat/profile/intent/overprint, vàđườngin(RIP/driver,máy,giấy). Khôngcần khách tựsửa màu trước khi gửi vì sẽlàm mất đối chứng.

Theo skillprynx-audit-workflow/deep-audit, dừng ởbáocáo; chưathực hiện bất kỳ bảnvá nào.
