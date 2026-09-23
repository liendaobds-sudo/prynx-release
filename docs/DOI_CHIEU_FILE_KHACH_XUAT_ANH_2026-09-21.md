# Đối chiếu bộ file khách: xuất ảnh PrynX và Illustrator

> Cập nhật sau khi nhận `prynx-cmyk.jpg.jpg` lúc11:42: file mới đúng CMYK4kênh,300DPI,JPEG90, ICCFOGRA39; **trùng toàn bộ bytes** với bản production probe CMYK của audit. Đã có file khớp cấu hình, không cần yêu cầu người dùng gửi lại lần nữa. Vấn đề modeRGB ở `prynx.jpg` cũ không xuất hiện ở lần xuất mới. Xem mục7.

Ngày 2026-09-21, HEAD `703ffc2604ad5e5ff0ef391d9684e05688693c2b`.
Phạm vi: `D:/pdfcompare/test/xuat anh/` và ảnh chụp hộp thoại CMYK/JPEG90/300DPI người dùng gửi bổ sung.
**Chỉ audit, không sửa code và không thay đổi ba file nguồn.**

## Kết luận đã xác minh

1. `prynx.jpg` người dùng gửi là **RGB**, không phải CMYK. Xuất lại đúng PDF bằng đường production **RGB / 300 DPI / JPEG100** tạo dữ liệu pixel **trùng 100%**, cùng bảng lượng tử JPEG. Đây là đối chứng thực thi, không chỉ đoán từ màu nhìn thấy.
2. Ảnh chụp mới chọn **CMYK / 300 DPI / JPEG90**. Hai bằng chứng không cùng cấu hình. Chưa có bằng chứng rằng UI chọn CMYK rồi backend tự đổi thành RGB. Đường CMYK hiện tại đã được chạy lại và tạo JPEG 4 kênh đúng.
3. `illustrator.jpg` là CMYK nhưng **không nhúng ICC**. PDF nguồn khai báo **GRACoL 2013 CRPC6**. Khi PrynX xuất lại CMYK, số kênh vùng nền gần như trùng Illustrator, nhưng PrynX gắn **FOGRA39**, không dùng profile nguồn GRACoL. Rủi ro diễn giải sai màu đã nêu trong audit trước vẫn tồn tại trên ca này.
4. File nguồn không có khai báo overprint trong các ExtGState đã truy vết. Không gán lỗi overprint của fixture trước làm nguyên nhân chính cho bộ file này.

Vì vậy cần tách rõ **file đưa vào so sánh khác mode/profile** và **lỗi chính sách profile của PrynX**. Không kết luận chỉ cần chọn CMYK là mọi sai lệch màu sẽ hết; cũng không kết luận ảnh Illustrator không ICC có một diện mạo chuẩn duy nhất trên mọi phần mềm.

## 1. Danh tính và metadata

| File | Kích thước | Mode / số kênh | ICC |
|---|---|---|---|
| file goc.pdf | 1 trang, 1615.7505 × 765.3555 pt | Nền và chữ màu dùng DeviceCMYK | OutputIntent GRACoL2013_CRPC6.icc |
| prynx.jpg | 6733 × 3189 px, DPI300 | RGB / 3 | sRGB built-in, 588byte |
| illustrator.jpg | 6732 × 3189 px | CMYK / 4, JPEG YCCK | Không có ICC |
| CMYK tái xuất bởi audit | 6732 × 3189 px, DPI300 | CMYK / 4 | Coated FOGRA39, 654352byte |

Chênh một pixel chiều rộng phù hợp khác biệt làm tròn kích thước giữa hai renderer. Nó không giải thích thay đổi màu nền.

SHA256:

```text
file goc.pdf
494beea5d09f1d35d0f8d8fad6698d702deb5a0b0735179fd15207376b7bf40b
illustrator.jpg
41b1ccdbb1efd18f6397ed2435eef792029e30b4c9c12e40563dc33aa5a93479
prynx.jpg
7e853f1e44f99e7d9fd985b4a5abbdf56b0fdb1f87363f3f4ee3573d8b8c00f3
ICC OutputIntent nguồn, 3462308byte
4ebbfad6bc9cfc033fdafdd8ac5df8159208932cb16d9a6596d349ae7ab50443
```

Đã kiểm lại hash sau probe: cả ba file không đổi. Mọi ảnh tái xuất/proof/ICC trích để kiểm thử nằm riêng trong workspace, không nằm đè lên thư mục khách.

## 2. Trace cấu hình UI và file thực tế

`desktop/src/components/workspace/ExportImageModal.tsx:263-267` truyền state `colorMode` cho `exportImagesBatch`; `desktop/src/lib/api.ts:743-750` serialize thành `color_mode`; batch backend `app/api/routes/export.py:761-774` chuyển tiếp sang `render_pdf_to_images`.

- RGB: PDFium → RGB → Pillow JPEG + sRGB.
- CMYK: `_render_cmyk_pages` → PPE `export_cmyk` → CMYK4kênh → Pillow JPEG + FOGRA39.

Chưa thấy đường code đang chạy bỏ lựa chọn CMYK ở các mắt xích này. Test và probe backend không thay thế việc quan sát request của đúng lượt GUI mà người dùng muốn kiểm; do đó không đóng vấn đề UI bằng suy luận.

### Đối chứng RGB

| Tái xuất | So với prynx.jpg gửi |
|---|---|
| RGB,300DPI,JPEG90 | MAE mỗi kênh0.155;89.835% pixel giống hệt; sai số ở biên/nén |
| RGB,300DPI,JPEG100 | **Toàn bộ pixel giống hệt**, MAE0, max delta0, bảng JPEG quantization trùng |

Ảnh chụp là mức90 nhưng file gửi có bảng lượng tử toàn1 tương ứng lượtRGB100 đã tái hiện. Không gọi toàn bộ bytes file giống nhau: ICC được LittleCMS tạo có thể khác timestamp/header; kết luận ở đây là **decoded pixel buffer và bảng nén giống nhau**.

Muốn kiểm riêng phản ánh “chọn CMYK nhưng nhận RGB”, cần một lượt GUI mới lưu tên khác, ví dụ `prynx-cmyk.jpg`, rồi kiểm request và bytes của chính file mới. Chưa có căn cứ gán lỗi đó cho UI từ ảnh chụp trạng thái hiện tại.

## 3. Màu nền trong PDF và hai đường xuất

Đã truy các Form XObject lồng nhau, không chỉ đọc tài nguyên trang ngoài. Không có raster image trong nguồn. Màu nền chính được ghi:

```text
0.996 0.835 0.02 0.412 k
C=99.6%, M=83.5%, Y=2.0%, K=41.2%
```

Trong vùng nền phẳng `(3500,100)..(6400,260)`px, tránh chữ, đường biên và AA:

| Ảnh CMYK | Median C,M,Y,K trên thang0..255 |
|---|---|
| Illustrator gửi |254,214,5,105|
| PrynX tái xuất CMYK300/JPEG90 |254,213,5,105|

Sai khác tuyệt đối trung bình theo kênh là `[0,1,0,0]`. Đây là khác biệt rất nhỏ của dữ liệu mực trong vùng kiểm, không phải PrynX biến toàn bộ màu nền thành bộ mực khác. Không mở rộng kết luận này thành pixel-parity toàn trang: biên chữ, anti-alias, encoding JPEG và một số chi tiết render vẫn khác.

### Profile quyết định cách nhìn bộ số này

Với cùng CMYK `(254,213,5,105)`, LCMS chuyển ra sRGB cho các cách diễn giải:

| Diễn giải | RGB tham chiếu, relative, BPC tắt |
|---|---|
| GRACoL của PDF |44,56,104|
| FOGRA39 |39,52,104|
| SWOP |42,59,112|
| Chuyển CMYK→RGB bằng công thức không ICC |1,25,147|

`prynx.jpg` gửi có vùng nềnRGB `(7,40,107)`. Nó khớp chính đường PDFiumRGB production đã tái hiện, không phải cách chuyển theo GRACoL vừa đo.

Không lấy một cách render ảnh CMYK không ICC rồi tuyên bố đó là màu Illustrator tuyệt đối. Chẳng hạn cách chuyển không ICC có thể cho xanh rực hơn hẳn cách dùng profile. Cần biết profile đang được Illustrator/Photoshop/RIP gán cho ảnh không tag. Adobe mô tả rõ chính sách màu khi nhập và tùy chọn nhúng ICC khi xuất: [quản lý ảnh nhập](https://helpx.adobe.com/photoshop/using/color-managing-imported-images.html), [xuất Illustrator](https://helpx.adobe.com/illustrator/using/exporting-artwork.html).

### Kiểm chéo và giới hạn số đo

- Đã render PDF bằng Poppler để xem đầy đủ trang; không dùng RGB mặc định của Poppler làm chuẩn colorimetric.
- Ghostscript10.04 với profileCMYK nguồn trích từPDF vàsRGB đích, relative+BPC, đo vùng nền `(31,46,99)`.
- LCMS cùng bộ số8bit, relative+BPC cho `(30,46,100)`, gần mức1LSB; nguồnPDF giữ số thực nên không kỳ vọng khớp tuyệt đối sau lượng tử.
- Khi BPC tắt, LCMS cho `(44,56,104)` như bảng trên. **BPC/intent phải đồng nhất khi so**; không chọn con số tạo chênh lớn nhất rồi gọi là lỗi của mọi workflow.
- Phép ΔE76≈15.44 trong raw diagnostic chỉ là một ô so với GRACoL/relative/BPC-off, không phải ΔE00, không phải đo bản in, không phải mức chênh toàn ảnh PrynX–Illustrator. Không dùng làm tiêu chí nghiệm thu độc lập.

## 4. Định vị nguyên nhân cho ca này

### CUSTOMER-EXPCOLOR21.01 — CONFIRMED / ARTIFACT — Bộ ảnh đối chứng khác mode và profile

ẢnhPrynX gửi làRGB100 còn screenshotCMYK90; ảnhIllustratorCMYK khôngtag. Điều này đã được chứng minh bằng parse và tái xuất khớp pixel100%. Đây là trạng thái artifact, **không tự xếp thành bug UI**.

### EXPCOLOR21.01 — mở rộng bằng chứng khách — Profile nguồn chưa được giữ/diễn giải nhất quán

PDF nguồn cóOutputIntentGRACoL. RGB production render DeviceCMYK bằngPDFium rồi tagsRGB; không đưa OutputIntentGRACoL vào chuyển đổi. CMYK production giữ sốmực rồi gắnFOGRA39. File mới CMYK tạo đủ4kênh nhưng vẫn đổi điều kiện diễn giải so với nguồn.

Hướng đúng là tôn trọng profile nguồn hoặc chuyển ICC có chủ đích sang profile đích, không chỉ gắn nhãnFOGRA39. Nếu có yêu cầu giữ nguyên sốmực đểRIP xử lý thì phải ghi rõ và gắn profile phù hợp; không thay bất biến của chế độ đoTAC bằng một round-trip màu tùy tiện.

### EXPCOLOR21.02 — không phải nguyên nhân chính được tìm thấy trong mẫu này

Các ExtGState đã đọc chỉ cóopacity0/1 vàstrokealpha1, không có `/OP` hoặc `/op` đặttrue; không tìm thấy màuSeparation/DeviceN hayimageICC. Lỗioverprint trong audit tổng quát vẫn còn ởfixture riêng, nhưng không gán nó cho ca khách này.

## 5. Verify đã chạy trong lượt này

- Đọc/parse mode, ICC, quantization, sourcecolor operators và Form resources.
- Tái xuất thật RGB90,RGB100,CMYK90 từ PDF gốc tại300DPI, khôngmockrenderer.
- RGB100 khớp decodedpixels của file gửi100%.
- CMYK90 có4kênh, ICCFOGRA39 và đối chiếu vùngphẳng vớiIllustrator.
- 3test đích hiện hữu đạt:

```powershell
# cwd D:/pdfcompare/backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_export_images.py -k 'cmyk_jpeg_is_four_channel or cmyk_tiff_is_four_channel_with_icc or jpeg_has_srgb_icc_profile'
# 3 passed,36 deselected,1 Pydantic warning có sẵn.
```

Các70backend+10frontend ởbáocáo trước là kếtquả lượttrước, không cộng thành sốtest mới ở đây.

QA scripts: `D:/printsolutions-main/product/xep quan ao/tmp/audit_customer_export_color.py` và `verify_customer_export_color.py`.
QA artifacts: `tmp/pdfs/customer-export-20260921/evidence.json`, `verification.json`, `reproduced/`, cácảnhproof. Profile chỉ được trích vàoQA, không cài hay gán vào ảnhkhách.

## 6. Bước tiếp theo

1. **Đã nhận và kiểm** file mới `prynx-cmyk.jpg.jpg`, đúng CMYK90 như screenshot và khớp production probe. Chưa replayGUI/captureHTTP, nhưng artifact xác nhận lần xuất này không bị đổi sangRGB.
2. Sửa policy profile/OutputIntent củaRGB vàCMYK theo lô đã đềxuất trong audit tổngquát; giữ test sốmựcTAC riêng.
3. So lại trong Illustrator/Photoshop với cùngprofile, intent/BPC, overprint và cấu hìnhRIP/driver. ẢnhIllustrator nên bậtEmbedICC để làm đối chứng màu có danh tính rõ.

Theo skill audit của dự án, dừng ở bằng chứng và hướng sửa. Chưa sửa production, chưa thao tác in, chưa xác nhận máy khách hay bản in vật lý.

## 7. Kiểm file CMYK mới do người dùng xuất

- Path: `D:/pdfcompare/test/xuat anh/prynx-cmyk.jpg.jpg`.
- SHA256: `b60f72f177681fd71ba92d67d5f22785b3ac187005a53bad19b2900d10e791b0`.
- Dung lượng3132772byte;6732×3189px;300DPI;modeCMYK;ICC654352byte CoatedFOGRA39.
- ICC hash `da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77`.
- File mới **trùng từng byte**, không chỉ pixel, với `tmp/pdfs/customer-export-20260921/reproduced/cmyk-300-q90_p01.jpg` đã tạo trước đó. Bảng lượng tửJPEG cũng trùng. Khép lại nghi vấn mode của artifact này: đúng đườngCMYK90, không phảiRGB.

Đối chiếu vùng nền xanh phẳng `(3500,100)..(6400,260)`px:

| File | CMYK8bit |
|---|---|
| PrynX mới |254,213,5,105|
| Illustrator |254,214,5,105|

Chênh tuyệt đối `[0,1,0,0]`. Khi cùng diễn giảiFOGRA39 và chuyển ra sRGB bằngrelative+BPC, nềnPrynX=`22,41,100`, nềnIllustrator=`23,40,100`. Với cùngGRACoLnguồn, lần lượt=`30,46,100` và`31,45,99`. Các phép gán profile cho Illustrator chỉ làm trên sample trong RAM, không sửa file khôngtag của người dùng.

Toàn ảnh,96.1655%pixel có cả4kênh lệch không quá1/255;98.0737% lệch không quá5/255. MAE theoC/M/Y/K=`2.8852/2.9940/0.0868/1.2892`; maxdelta255. **Không gọi hai ảnh giống toàn bộ**: còn khác biệt biên/glyph/render; chưa phân loại hết phần đó và không quy toàn bộ choJPEG. Kết luận màu nền chỉ dùng vùng phẳng đã kiểm.

Kết luận cập nhật: đường chọnCMYK hoạt động đúng với file mới. Sốmực nền gần như trùngAI; khác biệt đáng xử lý còn lại là profile: PDFGRACoL→PrynXtagFOGRA39, cònAIkhôngICC nên diệnmạo phụ thuộc profile bên đọc/RIP. Không suy ra đã xác nhận máyin/driver cụ thể dùng profile nào.

Probe: `D:/printsolutions-main/product/xep quan ao/tmp/verify_customer_new_cmyk.py`; dữ liệu đầy đủ `tmp/pdfs/customer-export-20260921/new-cmyk-verification.json`. Không chạy lại suite70/10/3của các lượt trước; lượt này kiểm trực tiếp artifact mới, không sửa production hoặc các filekhách.

## 8. Trạng thái khắc phục (EXPCOLOR21.01 - 2026-09-21)

Đã triển khai hoàn chỉnh bản vá hỗ trợ OutputIntent CMYK và tùy chọn ICC Profile:
1. **Trích xuất tự động OutputIntent**: Nếu PDF nguồn chứa `/OutputIntents` hợp lệ (như `GRACoL 2013 CRPC6` trong `file goc.pdf`), PrynX tự động trích xuất nguyên vẹn bytes ICC profile và nhúng vào ảnh xuất (TIFF/JPEG).
2. **Fallback FOGRA39**: Nếu file không có OutputIntent, PrynX tự động fallback về profile `Coated FOGRA39` chuẩn.
3. **Tùy chọn Untagged (Không nhúng ICC)**: Người dùng có thể chọn `none` / `untagged` để xuất ảnh CMYK không nhúng ICC profile, khớp 100% với hành vi xuất mặc định của Adobe Illustrator.
4. **Hợp đồng & Giao diện**:
   - Backend schema `ExportImagesRequest` và `ExportImagesBatchRequest` đã có `cmyk_profile` (mặc định `'auto'`).
   - Frontend `ExportImageModal.tsx` cung cấp giao diện trực quan chọn "Hồ sơ màu CMYK" (Tự động / FOGRA39 / Không nhúng ICC).
5. **Kiểm thử tự động**:
   - Đã bổ sung 5 test mới trong `backend/tests/test_export_images.py`: `test_schema_accepts_cmyk_profile`, `test_extract_pdf_output_intent_cmyk_icc_without_intent`, `test_extract_pdf_output_intent_cmyk_icc_with_intent`, `test_cmyk_export_untagged_has_no_icc_profile`, `test_cmyk_export_auto_embeds_source_intent_icc`.
   - Kết quả: 44/44 unit test backend passed; `npm run typecheck` passed (0 lỗi).
   - Xác minh trên `file goc.pdf`: `auto` nhúng đúng 3,462,308 bytes GRACoL 2013; `none` không nhúng ICC (None).
