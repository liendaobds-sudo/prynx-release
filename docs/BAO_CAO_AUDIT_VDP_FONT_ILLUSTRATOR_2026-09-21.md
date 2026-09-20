# Audit font VDP khi mở một trang bằng Illustrator - 2026-09-21

Trạng thái: **CHỜ DUYỆT SỬA**. Chỉ audit source, PDF thật và quan sát Illustrator2025; không sửa production, font hệ thống hoặc tài liệu đang mở.

## 1. Kết luận

Có **hai hiện tượng khác nhau**, không nên chữa bằng một lần đổi tên font:

1. **Hàng dấu chấm dùng font gốc đã không được Illustrator nhận đúng.** Ngay tab PDF gốc ccccccccccc.pdf đang mở đã báo thiếu UTMTimes và UTMViceroyJF. UTMTimesBold và UTMEdwardianBold vẫn được nhận. Không phải VDP vừa làm mất riêng font hàng chấm.
2. **Chữ VDP được tạo lại dưới dạng TrueType subset, vẫn là text trong PDF, nhưng không giữ được live text sau import Illustrator.** Bản PDF trang3 trước và sau tách có font nhúng, ToUnicode và text giống nhau. Trong Illustrator, bản sau VDP chỉ còn1font trong Find/Replace Font: UTMTimes của hàng chấm; ba font chữ VDP không còn là font sống.
3. **Bản sửa tên đăng ký hiện tại chưa đổi font name thật ghi vào PDF.** PDF trước và sau sửa vẫn dùng cùng ba BaseFont. Chỉ đổi alias ReportLab không đủ.
4. Có lỗi riêng: resolver fontName-only mới trả Arial cho3font UTM đang có trên máy. Đây là lỗi fallback có đường chạy thật, nhưng **không phải nguyên nhân trực tiếp đã quan sát trong PDF hiện tại**, vì PDF này vẫn nhúng đúng các font UTM.

Đã khoanh tầng lỗi chính tới hợp đồng font-export/import, loại trừ bước tách trang làm mất font. **Chưa cô lập bằng A/B việc trường cmap, naming hay embedding flags nào khiến Illustrator quyết định outline từng font.** Không hứa chỉ đổi một flag/tên sẽ giải quyết được.

## 2. File và bằng chứng

Các file giữ nguyên:
- Template đã xóa trường để đi VDP: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/vdp_templates/vdp_clean_7ed45b2816.pdf.
- Output123trang: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/vdp_a73398900cb84f148ff5a3f99cff47ff.pdf.
- File cầu nối thật, trang3: C:/Users/Khanh Pham/AppData/Local/Temp/prynx_VDP_ccccccccccc_123records_p3_1789924723816.pdf.
- Bản VDP cũ để đối chiếu tên: vdp_d979d66922594c75b542bcc05a095ecc.pdf trong cùng results.

Metadata template: Creator=CorelDRAW2020, Producer=Corel PDF Engine22.0.0.412. VDP output Producer=PDFium; file tách Producer=pdf-lib.

Template sạch còn hai text-run hàng chấm, **87 dấu chấm mỗi hàng**, dùng /FLPTJD+UTMTimes. Ba trường nội dung đã bị xóa để renderer VDP viết lại, đúng workflow chọn text thành trường.

Ở trang3 output và trang tách:
- Hai run dấu chấm87ký tự.
- Ba run chữ VDP dùng TrueType nhúng, độ dài24/25/23ký tự trên ca này.
- Có thể trích Unicode bằng parser; không phải chỉ còn đường cong trong file PrynX giao đi.
- So mọi FontFile2/FontFile3 và ToUnicode của trang: **hash trùng hoàn toàn**.
- Toàn chuỗi text trích ra: **hash trùng hoàn toàn**.

Không ghi tên cá nhân trong evidence; chỉ lưu độ dài/phân loại run chữ và digest.

## 3. Bảng font

| Nội dung | Font PDF gốc/template | Font PDF VDP | Ghi nhận trong Illustrator |
|---|---|---|---|
| Hai hàng dấu chấm | FLPTJD+UTMTimes, Type0/CIDFontType0C, nhúng207byte | Giữ nguyên | Thiếu UTMTimes ngay ở tab gốc và bản sau VDP |
| Trường kiểu Viceroy | NUTCHH+UTMViceroyJF, CID/CFF | AAAAAA+UTM-ViceroyJF, TrueType | Gốc báo thiếu Viceroy; sau VDP không còn font sống của trường |
| Trường EdwardianBold | EMUNDF+UTMEdwardianBold, CID/CFF | AAAAAA+UTMEdwardianBold, TrueType | Gốc nhận được, sau VDP không còn trong Fonts in Document |
| Trường TimesBold | AZGOII+UTMTimesBold, CID/CFF | AAAAAA+UTMTimesBold, TrueType | Gốc nhận được, sau VDP không còn trong Fonts in Document |

207byte là subset chỉ chứa glyph cần cho hàng chấm, **không tự nó là bằng chứng font hỏng hoặc bị cắt mất dữ liệu**.

Ba TrueType subset VDP:
- Có ToUnicode.
- Có FontFile2.
- Embedded name tables vẫn giữ tên từ font cài.
- cmap trong subset chỉ có platform1/encoding0/format6 (Mac), các mã8bit theo bộ con ReportLab.
- OS/2 version0, fsType=6.
- FontDescriptor flags regular=4; hai font bold=262148.

Những chi tiết này mô tả format thực, **không gắn nhãn PDF không hợp lệ chỉ vì không dùng CID Unicode**. Khả năng đọc/in PDF và khả năng nhập thành text chỉnh sửa trong Illustrator là hai tiêu chí khác nhau.

## 4. Quan sát Illustrator thật

Dùng Computer Use, chỉ xem tab và Type > Find/Replace Font; không bấm Change/Change All hoặc Save.

- Bản trang3 sau VDP: Fonts in Document=(1), Missing Fonts=1; font duy nhất UTMTimes.
- Tab ccccccccccc.pdf: Fonts in Document=(4), Missing Fonts=2; thiếu UTMViceroyJF và UTMTimes, hai font bold có biểu tượng TrueType bình thường.
- Screenshot người dùng có cảnh báo Illustrator đã reinterpret PDF và outline một số text để giữ hình thức.
- Các tài liệu đang mở thuộc phiên người dùng; có tài liệu đã có dấu* trước audit. Đây là quan sát trạng thái thực, **không phải fresh reopen A/B cô lập toàn bộ lịch sử chỉnh sửa**.
- Trong quá trình quan sát có guard phát hiện thao tác người dùng/timeout; không dùng tọa độ cũ để bấm tiếp, không lưu tài liệu.

Runtime quan sát xác nhận khác biệt font sống giữa hai tài liệu đang mở. PDF được đo riêng ở trên xác nhận chữ/font vẫn tồn tại trước import.

## 5. Trace đến consumer

Source dưới D:/pdfcompare:

VDP:
vdp_text_picker.pick_text_to_vdp_field -> fontName/fontFile trong field -> vdp_engine.process_chunk:1095-1105 đăng ký -> render_one_record:961-1041/ReportLab Paragraph hoặc drawString -> ReportLab TTFont.addObjects -> overlay Form -> PDFium import_pages:1519 -> pikepdf save.

Font tĩnh:
Template Resources/Contents được copy sang record ở vdp_engine.py:1120-1174. Font hàng chấm không được tái nhúng/chuẩn hóa qua _register_font_family của trường VDP.

Bàn giao:
designAppLauncher.extractPagesForExternalEdit:230 copyPages -> :249 save -> external_app launch Illustrator. Không tìm thấy đường createOutline cho text trong luồng này. So artifact trước/sau copyPages chứng minh font program và text không đổi.

ReportLab:
backend/venv/Lib/site-packages/reportlab/pdfbase/ttfonts.py:1300 tạo BaseFont từ **self.face.name**, không phải alias đăng ký; :1318+ tạo ToUnicode/FontDescriptor.

## 6. Finding

### VDPFONT21.01 - P1 / effort M-L - Handoff VDP chưa giữ font sống trong Illustrator

[CONFIRMED] về kết quả interoperability; ARTIFACT + quan sát runtime, chưa cô lập từng yếu tố importer.

VDP không giữ nguyên font object/encoding của trường gốc mà dựng một TrueType subset mới từ font trên máy. File vẫn là text hợp lệ để xem/trích/in, nhưng quá trình import AI đã không giữ được live text như người dùng cần.

Hai font bold vốn được Illustrator nhận trong tab gốc cũng không còn trong danh sách font của bản VDP. Vì vậy “cài font là đủ” hoặc “đổi tên font đăng ký là đủ” đều chưa được bằng chứng ủng hộ.

Cần test writer/font contract tương thích chỉnh sửa (Unicode/CID mapping, glyph IDs, tên font và embedding hợp lệ) hoặc handoff native text từ metadata VDP đã resolve. Không được chỉ bảo đảm PDF hiển thị đúng rồi tuyên bố Illustrator chỉnh sửa được.

### VDPFONT21.02 - P2 / effort S-M - Font tĩnh đã thiếu ngay từ đầu, không được xử lý bởi bản sửa trường VDP

[CONFIRMED] source/template issue + gap preflight.

Font file tồn tại trên Windows:
- C:/Windows/Fonts/UTM Times.ttf: nameID6 là “UTM Times”.
- C:/Windows/Fonts/UTM ViceroyJF.ttf: nameID6 là “UTM ViceroyJF”.
- C:/Windows/Fonts/UTMTimesBold.ttf: nameID6 “UTMTimesBold”.
- C:/Windows/Fonts/UTM EdwardianB.ttf: nameID6 “UTMEdwardianBold”.

PDF gốc lại gọi UTMTimes/UTMViceroyJF không dấu cách. Các nameID6 có khoảng trắng là bất thường theo quy định PostScript naming của OpenType. Đây là mismatch cần xử lý, nhưng chưa chứng minh rằng đổi duy nhất dấu cách sẽ đủ cho mọi trường hợp Illustrator.

Hàng chấm là text font thật, không phải nét dash vector. VDP copy lại font cũ nên sửa font cho ba trường động không thể tự sửa font của87dấu chấm mỗi dòng.

Hướng: preflight/resolve font gốc đúng face; nếu đây chỉ là đường trang trí, có thể chọn chuyển riêng hàng chấm thành nét chấm vector. **Không outline các trường nội dung cần sửa.**

### VDPFONT21.03 - P1 / effort S - Resolver mới âm thầm dùng Arial dù font thật có trên máy

[CONFIRMED] AUTO + live consumer traced.

Chạy trực tiếp:
| Tên yêu cầu | vdp_text_picker resolver | vdp_engine._resolve_system_font |
|---|---|---|
| UTMTimes | UTM Times.ttf | arial.ttf |
| UTMViceroyJF | UTM ViceroyJF.ttf | arial.ttf |
| UTMEdwardianBold | UTM EdwardianB.ttf | arial.ttf |
| UTMTimesBold | UTMTimesBold.ttf | utmtimesbold.ttf |

Resolver engine đoán filename từ chuỗi đã bỏ dấu cách, không dùng cùng registry/face resolver với picker. Không tìm được thì trả Arial, không báo rằng đã đổi typeface.

Consumer thật: process_chunk:1101-1105 dùng fallback này khi fontFile thiếu/không còn tồn tại; render_one_record:964 cũng đi cùng nhánh. Recipe/import/job chỉ còn fontName có thể in sai font dù máy có font đúng.

**Không gán lỗi này là nguyên nhân của ca outline hiện tại:** artifact hiện tại nhúng UTM, không phải Arial. Đây là lỗi riêng vừa được thêm khi cố sửa font.

## 7. Vì sao bản sửa alias chưa có hiệu quả

Đo thực tế:
- _get_font_postscript_name(UTM ViceroyJF.ttf) -> UTMViceroyJF.
- Registry alias -> UTMViceroyJF.
- ReportLab face.name -> UTM-ViceroyJF.
- PDF BaseFont -> AAAAAA+UTM-ViceroyJF.

Tương tự UTMTimes alias khác face UTM-Times. Hai bản VDP cũ/mới đều ghi:
AAAAAA+UTM-ViceroyJF, AAAAAA+UTMEdwardianBold, AAAAAA+UTMTimesBold.

Như vậy bản sửa mới thay alias ở tầng đăng ký, chưa thay hợp đồng font program/encoding mà Illustrator thực sự đọc. Không nên tiếp tục đổi tên đoán mò.

## 8. Những kết luận chưa được phép suy ra

- **Không phải font bị mất khi tách trang:** bytes font/ToUnicode/text đã đối soát bằnghash.
- **Không chứng minh lỗi do xóa PieceInfo:** output VDP đã không có PieceInfo ở catalog/trang trước tách. Khôi phục AI-private data cũ của template có thể làm Illustrator mở nội dung template cũ thay vì dữ liệu record.
- **Không nói PrynX đã outline ba trường:** file trước bàn giao vẫn có Tj/text/font nhúng.
- **Không coi embedded font = chắc chắn edit được:** Illustrator cần font phù hợp và importer phải khôi phục được text model.
- **Chưa chốt một nguyên nhân duy nhất giữa cmap Mac-only, kiểu TrueType subset, naming và flags.** Cần A/B từng yếu tố trên một file kiểm nhỏ và mở sạch trong AI.
- OS/2 v0 fsType6 là metadata cần kiểm cẩn thận. Theo Microsoft, các version cũ có quy tắc xử lý nhiều bit; **không được diễn giải6 thành “cấm nhúng hoàn toàn” và không xóa/sửa permission flags để né vấn đề**.
- Bản kiểm độc lập vdp-font-control-20260921.pdf đã tạo bằng ReportLab với Arial/TimesBold/EdwardianBold, nhưng chưa hoàn thành mở đối chứng trong AI do modal/user-input interference. Không dùng nó làm bằng chứng A/B đã đạt.
- Chưa có nguồn .ai/.cdr native và chưa nghiệm thu CorelDRAW thật; không tuyên bố mọi font/phiên bản đều được giữ sống.

## 9. Lô sửa đề xuất

1. **Resolver chung:** hợp nhất picker/preview/export theo font-file/face identity; không fallback Arial im lặng; ghi đúng requested/resolved/embedded font.
2. **Writer live-text interoperability:** chọn chiến lược nhúng/encoding hợp lệ, bao đủ glyph tiếng Việt; thử Type0/CIDFontType2/Unicode hoặc cơ chế thích hợp và kiểm AI thực. Giữ permissions của font; không sửa font hệ thống.
3. **Handoff cho record:** nếu generic PDF import vẫn không bảo đảm, dựng native editable text từ metadata record/font/geometry trong bridge, không khôi phục PieceInfo template lỗi thời.
4. **Font tĩnh/hàng chấm:** kiểm tra cả template, không chỉ VDP fields; sửa mapping font hoặc xuất riêng đường trang trí thành vector theo lựa chọn đã duyệt.
5. **Nghiệm thu bắt buộc:** mở trang bất kỳ 1/3/cuối trong Illustrator, Find/Replace Font còn các font đúng, chọn được Type text, sửa một chữ rồi mở lại vẫn sống; đối chiếu bố cục/Unicode/màu. Thêm test có/không fontFile, tên có dấu cách/hyphen, CFF/TTF, nhiều record và recipe chuyển máy.

Không lấy “PDF trích text được” thay cho nghiệm thu editability trong Illustrator.

## 10. Test và bảo toàn dữ liệu

- Backend:26pass trong test_vdp_engine, test_vdp_text_picker, test_vdp_curved_text, vdp/test_preview_properties.
- Frontend:11pass trong designAppLauncher, vdpUtils, api.vdpArtifactLease.
- Không sửa test để ép xanh.
- Không thay font, không bấm Change/Change All/Save trong Illustrator; không ghi đè PDF khách, không build/commit.
- Các file PDF và font gốc chỉ đọc. Chỉ tạo fixture font độc lập trong workspace và report/evidence.
- Các quan sát UI có nguồn screenshot trong phiên hội thoại; không giả screenshot tự tạo thành kết quả Illustrator.

## 11. Nguồn và evidence

- docs/audit/VDP_FONT_ILLUSTRATOR_2026-09-21.json.
- D:/printsolutions-main/product/xep quan ao/tmp/audit_vdp_fonts_20260921.py và vdp-font-audit-20260921.json.
- Mẫu kiểm riêng: make_vdp_font_control.py; chưa có kết luận importA/B.
- [Adobe - Fonts FAQ](https://helpx.adobe.com/au/illustrator/using/fonts-faq.html): font có thể được hiển thị nhưng cần font phù hợp để sửa text.
- [Microsoft - OpenType naming](https://learn.microsoft.com/en-us/typography/opentype/spec/name): nameID6 dùng cho PostScript, không nhận dấu cách ASCII32.
- [Microsoft - OS/2 fsType](https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype): semantics quyền nhúng, khác biệtversion và yêu cầu không sửa permissions khi nhúng.
