# Audit VDP: căn giữa nhưng chữ tràn khung

Ngày: 2026-09-21. HEAD: `0c8a347`, audit working tree có sửa của người dùng. **Chưa sửa production.**

## Kết luận

Đã tái hiện đúng kiểu lệch phải của ảnh người dùng bằng component LIVE hiện tại, với cả Arial, UTM Edwardian Bold và UTM ViceroyJF. Không phải chỉ do font thư pháp, file nặng hay zoom.

Nguyên nhân lớn nhất trên LIVE: `inline-block` đo chữ dài hơn khung, nằm lệch trong line box; `scaleX` lại co container rộng bằng khung quanh tâm container. Chữ được co đủ bề ngang nhưng không được đặt lại đúng tâm. Có thêm lỗi baseline/chiều cao, lỗi đặt gốc glyph trong PDF và lệch hợp đồng giữa ba renderer.

Phân biệt quan trọng: chọn **Căn lề: Giữa** chỉ là căn ngang. Nút căn đối tượng theo trang trong VdpAlignPanel di chuyển KHUNG, không tự sửa vị trí nét chữ bên trong. Căn giữa cũng không tự bảo đảm nội dung nằm trọn khung.

## Phạm vi, nguồn và mức bằng chứng

- Ảnh người dùng: trường `Name BM`, LIVE TEXT; chưa lấy được payload chính xác của trường này. Các số đo dưới đây là ca kiểm thử cô lập, không phải đo trực tiếp ảnh người dùng.
- Dùng file font thật trên Windows, nạp xong font trước khi đo. Không sửa font hay PDF khách.
- 15 ca cơ sở: 3 font × chữ ngắn/dài/khung hẹp/khung thấp/hai dòng; `fontSize=32`, `autoFit=true`, căn giữa, leading=1.
- Browser: trích **nguyên component VdpAutoFitText từ working tree**, transpile TypeScript và chạy React thật trong Chromium headless. Chỉ thêm CSS utility tương đương cho fixture; scale=.75 để 1 px tương ứng 1 pt của PDF đối chứng.
- Backend: gọi `process_chunk` thật; render PDF và PNG server-preview cùng input ở 2 px/pt, đo pixel nét chữ tối, loại đường khung đỏ. Một ca chạy tiếp toàn bộ `run_vdp_engine` qua schema và final writer; bbox final trùng chunk.
- Thêm 6 ca hợp đồng backend: center/left/right, rotation90, leading2, autoFit=false.
- Đối chứng CSS trên trang kiểm thử: giữ nguyên scaleX, chỉ đặt chiều rộng tự nhiên và neo tâm nội dung; không áp vào source sản phẩm.
- Mức: **AUTO + ARTIFACT**, chưa RUNTIME trong WebView PrynX đang mở, chưa nghiệm thu installer. Không suy từ số test xanh rằng mọi font/cấu hình đã đúng.

## Trace đường chạy sống

Các path dưới đây tương đối với `D:/pdfcompare`, dòng tại thời điểm audit:

1. Chọn căn lề và tự co: `desktop/src/components/preprocess-tools/DataMergeTool.tsx:2069,2083` cập nhật `alignment/autoFit`.
2. LIVE: DataMergeTool `:1103` cập nhật vdpLivePreview → `LivePageFrame.tsx:7077` resolveFieldLiveText → `:7160` VdpAutoFitText → `:1987-2003` đo rộng → `:2019,2027,2048` translateY/scaleX → browser paint.
3. PNG: DataMergeTool `:1176` → `desktop/src/lib/api.ts:1609` → `/api/vdp/preview`, route `backend/app/api/routes/vdp.py:1045,1109` → `vdp_preview.py:207` render_one_record → ReportLab Paragraph trong `vdp_engine.py:1185-1267` → ghép PDF → raster PNG.
4. Xuất: DataMergeTool `:1394` → api.ts `:904` → `/api/vdp/generate`, route `vdp.py:498,381` → run_vdp_engine `:1819,1903/1906` → process_chunk `:1285,1408` → PdfiumVdpTextRenderer.add_text_field `:1462` → build_pdf_bytes `:1481` → merge trực tiếp `:1482` → writer chunk `:1521` → final PDF.
5. Route được đăng ký tại `backend/app/main.py:385`. Schema `backend/app/schemas/vdp.py:37-47` có `rotation`, `alignment`, `autoFit`, `lineHeight`; không có `angle`.

Đơn vị field hiện là CSS-mm lịch sử: backend nhân `72/25.4 * .75`. Fixture chuyển ngược đúng hệ này. **Không coi riêng hệ số .75 là bug.**

## Finding đã xác nhận

### VDPALIGN21.01 — P1, effort S-M — LIVE tự co ngang nhưng mất tâm chữ

**[CONFIRMED / AUTO]** Consumer: LivePageFrame `:1993-1996,2035-2053`.

`measureRef` là inline-block rộng tự nhiên N; parent rộng W có text-align:center, white-space:pre. Khi N>W, quan sát DOM thật cho thấy inline-block bắt đầu từ cạnh trái parent, không từ `(W-N)/2`. Sau đó scaleX=W/N co parent quanh tâm W/2, khiến cả khối chữ dịch phải. Đây không phải lỗi tính duy nhất của glyph thư pháp: Arial cũng tái hiện.

Khung W=360, H=50; sai số tâm ngang tính theo pixel nét chữ:

| Font | LIVE hiện tại | Đối chứng neo lại nội dung | Tràn phải LIVE hiện tại |
|---|---:|---:|---:|
| Arial | +43.5 px | -0.5 px | 42 px |
| UTM Edwardian Bold | +27 px | +3 px | 25 px |
| UTM ViceroyJF | +20 px | +0.5 px | 20 px |

Khung hẹp W=200: lệch tâm LIVE lần lượt +58 / +54 / +51.5 px. Chữ ngắn không cần co thì không có độ lệch lớn này. Đây giải thích vì sao chỉ một số record/tên dài bị lệch dù cùng chọn Giữa.

Đối chứng không phải bản sửa hoàn chỉnh: còn ink overhang, baseline, nhiều dòng, font-load và zoom cần test. Không đem đoạn chỉnh DOM của harness chép thẳng thành production fix.

### VDPALIGN21.02 — P1, effort M — Không kiểm phần nét vượt chiều cao khung

**[CONFIRMED / ARTIFACT]** Consumer LIVE `:2012-2027`; PDFium `vdp_engine.py:277-282,299-301`; ReportLab `:1236-1256`.

- LIVE dịch xuống cứng `fontPx*.22`, dù mỗi font có ascent/descent khác nhau. Các comment “khớp 100%” không phải bằng chứng.
- Backend mới đặt baseline theo `fontSize` và số dòng, không dùng `bottom/top` glyph vừa đo để đặt block dọc. Backend cũ căn paragraph/leading chứ không căn bbox nét chữ.
- AutoFit ở các nhánh chỉ co X, giữ chiều cao. Việc co ngang là lựa chọn hiện hữu, **không tự nó bị coi là sai**; thiếu bảo đảm/cảnh báo chiều cao là gap khi UI ghi “vừa khung”.

Ngay khung cao 50 pt, dòng Viceroy có nét cao khoảng 33 pt vẫn vượt đáy 1.5 pt trên PDF, do được đặt thấp; LIVE vượt 3 px. Với khung cao 24 pt, Viceroy PDF vượt đáy14.5 pt, Edwardian15.5 pt; LIVE hai trường vượt16 px. Hai dòng trong khung50pt: PDF Viceroy vượt17.5pt, Edwardian18.5pt.

Không thể sửa triệt để bằng cách “cộng thêm một offset” hoặc clip phần vượt: phải thống nhất baseline/font metrics, dùng ink bounds kiểm containment; khi không đủ chiều cao cần chính sách rõ (co đều/giữ cỡ và cảnh báo/nới khung theo lựa chọn).

Picker `vdp_text_picker.py:534-551,795-807` đang cố giữ baseline nguồn. Vì vậy sửa căn dọc phải phân biệt **giữ baseline khi chuyển text gốc thành field** với **căn khối chữ trong khung**, tránh làm các mẫu đã khớp bị nhảy.

### VDPALIGN21.03 — P2, effort S-M — PDF đo bbox nhưng quên bù gốc trái glyph

**[CONFIRMED / ARTIFACT]** `vdp_engine.py:292-296` lấy bounds l,b,r,t nhưng chỉ giữ `r-l`; `:303-323` đặt origin tại x theo width, không trừ `l*sx`.

Nếu l khác0, bbox nét thật sẽ lệch l*sx khỏi vị trí đã căn. Edwardian dòng dài trong khung360pt: PDF có bbox `[105,93.5,464.5,127.5]` trong khung `[100,75,460,125]`; lệch tâm ngang4.75pt và tràn phải4.5pt. Chạy toàn bộ run_vdp_engine vẫn có đúng bbox này, không chỉ object trung gian.

Preview ReportLab dùng stringWidth/advance và browser dùng offsetWidth; các giá trị này không đồng nhất với ink bbox, nhất là font script. Cần tách advance dùng bố trí chữ khỏi ink dùng bù origin/kiểm tràn, không tùy tiện dùng thay nhau.

### VDPALIGN21.04 — P1, effort M — Nhánh xuất chữ mới không cùng hợp đồng với preview

**[CONFIRMED / ARTIFACT]** Xuất đi PDFium `:1408-1482`, PNG vẫn đi ReportLab `vdp_preview.py:207`. Ba biểu diễn không dùng chung layout thực tế dù docstring còn nói parity.

| Thiết lập cùng input | PNG preview | PDF xuất |
|---|---|---|
| rotation=90 | Nét dọc, bbox≈31×49pt | Vẫn ngang, bbox≈359.5×34pt |
| lineHeight=2, một dòng | Bbox y=77.5..111.5 | y=93.5..127.5; lệch16pt |
| autoFit=false, dòng dài | ReportLab tự wrap thành hai dòng | PDFium giữ một dòng, tràn trái21pt/phải32pt |

Rotation là lỗi truyền hợp đồng rõ: caller mới đọc `field.get('angle',0)` ở `:1473`, trong khi UI/schema dùng `rotation`; nhánh cũ `:999` đọc đúng rotation. Không được vá bằng đổi riêng tên key mà bỏ qua pivot và đổi W/H giống preview.

## Gap kiểm thử và điểm cần rà tiếp

- 31 test backend và7 test frontend liên quan **đều pass** trên code đang audit nhưng vẫn có lỗi trên. Property parity trong `tests/vdp/test_preview_properties.py:173+` chỉ so hằng số/công thức/identity render_one_record; không chứng minh process_chunk thật còn dùng renderer này cho straight text. Tham số rotation chỉ được kiểm thuộc enum, không đo ảnh xoay.
- VdpAlignPanel test kiểm di chuyển khung, không đo vị trí chữ trong browser thật. DOM mô phỏng không tự có font metrics thật.
- [SUSPECTED, chưa xếp severity] `fitHeightToText` tại DataMergeTool `:899-928` đo token/textContent chưa resolve record, fontName không dùng fontName_local, giả wrap theo space, leading cứng1.2, khác chính renderer. Cần test riêng nút “Thu khung theo chữ”.
- Nhánh xoay, faux bold/italic, font fallback, loading font, tracking, chữ cong/wave, trường ngoài trang, fontSize/lineHeight null/0 và Unicode tổ hợp chưa phủ hết. Không gọi đây là audit toàn bộ VDP đã sạch.
- Không mở lại audit zoom hay sửa renderer font/Illustrator trong lượt này. Font audit trước đó không tự đóng bằng renderer mới.

## Lộ trình sửa đề xuất — chờ duyệt

1. Lô LIVE ≤5 file: tách đo và hiển thị, neo khối chữ đúng trước/sau scale; test browser thật cho trái/giữa/phải, chữ dài/ngắn, font loaded, nhiều dòng và zoom. Không dùng overflow:hidden để che lỗi.
2. Lô layout dùng chung ≤5 file: baseline + advance/ink + rotation/pivot + policy fit; PNG và PDF dùng cùng kết quả bố trí. Bù origin glyph; giữ live text, không outline/rasterize để né vấn đề.
3. Lô preflight/QA ≤5 file: kiểm toàn bộ record để báo trường tràn và mức co quá lớn; cập nhật kiểm thử parity bằng final PDF và ảnh, rồi nghiệm thu đúng file/mẫu trong PrynX.

Tiêu chí: tên thay đổi không trôi tâm khi autoFit; baseline có chính sách nhất quán; không âm thầm mất dấu/đuôi chữ; PNG/LIVE/final PDF cùng rotation và dòng; không làm hỏng giữ text gốc hoặc khả năng sửa font trong Illustrator.

## Chứng cứ và cách chạy

Evidence gọn: `docs/audit/VDP_ALIGNMENT_2026-09-21.json`.

QA cô lập hiện lưu tại `D:/printsolutions-main/product/xep quan ao/tmp/`: audit_vdp_alignment.cjs, audit_vdp_alignment_control.cjs, audit_vdp_alignment.py, audit_vdp_alignment_extra.py; align-browser.json, align-evidence.json, align-extra.json; các PDF/PNG align-* chỉ là fixture kiểm thử, không phải file khách. Đã xem contact sheet3font và ảnh đại diện, đo tự động toàn bộ ca.

Lệnh đã chạy:

```powershell
# Backend cwd D:/pdfcompare/backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_vdp_engine.py tests/test_vdp_text_picker.py tests/test_vdp_curved_text.py tests/vdp/test_preview_properties.py
# 31 passed, một cảnh báo Pydantic config class deprecated.
# Desktop cwd D:/pdfcompare/desktop
npx vitest run src/components/preprocess-tools/VdpAlignPanel.test.tsx src/lib/vdpUtils.test.ts
# 7 passed / 2 files.
```

Không typecheck/build/restart ứng dụng vì không sửa production. Không commit. Theo skill audit/deep-audit, dừng tại báo cáo để người dùng duyệt hướng sửa.
