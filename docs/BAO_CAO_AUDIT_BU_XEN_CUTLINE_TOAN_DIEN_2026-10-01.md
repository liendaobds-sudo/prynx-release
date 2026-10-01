# Báo cáo audit toàn diện Bù xén (Bleed) và Tạo đường cắt (Cutline) — 2026-10-01

## Tóm tắt

Audit read-only trên source hiện tại của PrynX, bao gồm luồng Classic StickerTool, Sticker Sheet, preview Canvas/SVG, xuất PDF, nhánh xử lý song song nhiều trang, màu bù xén, vòng đời cache và test liên quan.

Bốn lỗi đúng hành vi đã xác nhận:

1. **P1 — Fan-out nhiều trang làm mất toàn bộ dao Đứt (ThruCut).** Route/luồng tuần tự nhận các trường thrucut, nhưng nhánh ProcessPool không truyền chúng xuống worker; worker dùng mặc định thrucut_enabled=False.
2. **P1 — Preview contour_offset của dao Đứt vẽ sai hình.** Canvas luôn dựng khung chữ nhật bo góc cho contour_offset; PDF writer dùng đường offset theo contour thật. Với contour lõm/chữ L, hai hình khác nhau.
3. **P2 — Nét preview và nét PDF không cùng hợp đồng góc/nắp.** SVG ép round/round cho mọi kiểu; PDF writer không ghi j/J, nên dùng mặc định PDF miter/butt.
4. **P2 — Nhãn kích thước preview sai ở nhánh giữ nền trắng theo page box cục bộ.** Fallback Canvas coi chiều rộng luôn là 100 mm; trang 210×297 mm hiện thành 100×141,4 mm.

Ba rủi ro hiệu năng/vòng đời đã xác nhận ở mức source:

- Cache frame Classic là Map không có eviction trong suốt vòng đời tài liệu/tab.
- Cache hình học backend giữ tối đa 20 entry bằng hard cap, không gate theo RAM tier.
- Alpha fast path tạo ImageBitmap/alpha buffer nhưng không đóng bitmap; kết quả _localFastAlphaPreview được tính nhưng không được trả ra/render.

Phần bleed có pipeline và test tự động cho image/trajectory/inpaint/solid, auto/white-boundary và CMYK/spot, nhưng chưa có bằng chứng runtime với Illustrator, Acrobat hoặc WebView ở zoom 700–1600%, cũng chưa có ma trận PDF artifact chứng minh sạch tuyệt đối halo/viền đen/rò RGB cho mọi mode. Vì vậy chưa thể kết luận yêu cầu “100% sạch” đã đạt.

## Mức bằng chứng

- **TRACED:** entry UI/API → schema/route → engine/export → PDF resources/content stream.
- **AUTO:** các bất biến được test tự động ở các nhóm bên dưới.
- **ARTIFACT:** các test hiện có kiểm PDF bytes/raster/Spot ở fixture; chưa đủ toàn bộ mode và chưa có renderer ngoài.
- **RUNTIME:** chưa đạt cho Tauri/WebView, Acrobat/Illustrator hoặc máy bế.

Worktree đang có thay đổi của đợt audit khác. Kết quả test phản ánh source hiện tại; không reset hoặc ghi đè các thay đổi đó.

## Luồng đã truy vết

### Classic StickerTool → PDF

- UI đóng gói offset_mm, corner_style, curve_tension, bleed_mm, bleed_color_type, cutline_denoise và bốn lề dao Đứt tại desktop/src/components/preprocess-tools/stickerToolPolicy.ts:240-270 và phần payload tiếp theo.
- Route backend/app/api/routes/pdf_tools.py:1479-1987 parse/clamp tham số, sau đó gọi StickerEngine.process_pdf.
- Engine nhận bốn lề dao Đứt tại backend/app/workers/sticker_engine.py:9186-9216; dùng buffer/join style và ghi CutContour/Spot.
- PDF writer ghi /CutContour CS, 1.0 SCN, 1.0 w tại backend/app/workers/sticker_engine.py:10100-10137. ColorSpace dùng Separation/DeviceCMYK, C1=[c,m,y,k]; mặc định route không truyền cut_color, nên engine dùng CMYK 0/100/0/0 (magenta).

### Sticker Sheet → preview/export

- Preview overlay dựng path tại desktop/src/components/preprocess-tools/StickerSheetWorkspace.tsx:116-170,270-299.
- Export API desktop/src/lib/stickerSheetApi.ts:543-616 và schema backend/app/schemas/sticker_sheet.py:341-373 không có trường thrucut; worker backend/app/workers/sticker_sheet_export.py:1280-1300,1560-1580 cũng không nhận dao Đứt.
- Route gom các tùy chọn export tại backend/app/api/routes/sticker_sheet.py:841-863.

## Findings đã xác nhận

### §BLEED.CUT.PARALLEL-THRUCUT — P1/M — [CONFIRMED]

**Bất biến:** xuất cùng một cấu hình phải giữ dao Đứt, shape, lề bốn phía, bán kính và spot giữa luồng tuần tự và luồng nhiều trang.

**Bằng chứng:**

- process_pdf gọi _process_parallel tại sticker_engine.py:9534-9559, nhưng danh sách đối số không có thrucut_enabled, thrucut_shape, thrucut_margin_mm, bốn thrucut_margin_*_mm, thrucut_radius_mm, spot hoặc màu.
- _process_parallel dựng args_list tại sticker_engine.py:13529-13535; vì kw không có các trường trên, thrucut_enabled rơi về False.
- Worker gọi lại process_pdf tại sticker_engine.py:9066-9110, chỉ nhận các giá trị mặc định; bốn lề riêng cũng không được truyền.

**Ảnh hưởng:** PDF nhiều trang đủ điều kiện fan-out có thể không có ThruCut/spot ngoài cùng, dù UI đã bật hai dao. Đây là sai khác giữa trang/worker và giữa preview với file xuất.

**Giải pháp sau khi duyệt:** truyền trọn bộ thrucut qua fan-out và worker; thêm test artifact so sánh tuần tự/song song với contour lõm, lề bất đối xứng, spot name/color và kiểm tra stream/resource.

### §BLEED.CUT.CONTOUR-OFFSET-PREVIEW — P1/M — [CONFIRMED]

**Bất biến:** preview dao Đứt phải có cùng hình học với Spot ThruCut trong PDF.

**Bằng chứng source và probe:**

- buildThrucutSvgPath tại StickerSheetWorkspace.tsx:116-170 chỉ có nhánh ellipse; mọi shape còn lại, gồm contour_offset, gọi buildSvgRoundedRect từ bounding box.
- PDF writer tại sticker_engine.py:10140-10157 dùng cut_poly.buffer(thrucut_margin_pts) cho contour_offset.
- Probe hàm thật trên contour chữ L 100×100 px với margin 3/radius 2 cho thấy SVG preview đúng bằng rounded bounding-box, bao phủ cả vùng rỗng góc lõm; Shapely buffer của PDF không bao phủ vùng đó.

**Ảnh hưởng:** preview cho contour lõm/chữ L có thể cho người dùng duyệt một hình, nhưng PDF gửi máy bế một hình khác.

**Giải pháp sau khi duyệt:** trả path contour-offset canonical từ backend preview hoặc dùng cùng một serializer hình học; thêm fixture chữ L/concave so sánh SVG path với path parse từ PDF.

### §BLEED.CUT.STROKE-CONTRACT — P2/S — [CONFIRMED]

**Bất biến:** preview và Spot CutContour phải giữ cùng kiểu góc/nắp khi chọn preserve/round/miter.

**Bằng chứng:**

- Canvas ép strokeLinecap=round và strokeLinejoin=round cho main và ThruCut tại StickerSheetWorkspace.tsx:271-280,287-297, không phụ thuộc cornerStyle.
- PDF writer chỉ ghi màu và độ rộng tại sticker_engine.py:10105-10107, không ghi toán tử j/J; PDF mặc định là miter join/butt cap.
- Engine có chọn join style hình học trước đó, nhưng stroke envelope trên góc nhọn vẫn khác giữa SVG và PDF.

**Ảnh hưởng:** ở zoom lớn, đầu nét/góc nhọn của preserve/miter có thể khác preview dù tâm path gần nhau.

**Giải pháp sau khi duyệt:** đưa corner style vào hợp đồng preview; đặt linecap/linejoin SVG tương ứng và ghi j/J PDF tương ứng. Regression phải render góc nhọn, đo tip/diện tích và kiểm cả main/ThruCut.

### §BLEED.CUT.SHEET-DUAL-KNIFE — P1/M — [CONFIRMED SCOPE GAP]

Sticker Sheet có lựa chọn Tách từng tem/Giữ nguyên tấm, nhưng API/schema/export chỉ có một CutContour. Không có thrucut_enabled, shape, margin, radius hoặc ThruCut spot trong:

- stickerSheetApi.ts:543-616;
- sticker_sheet.py:341-373,841-863;
- sticker_sheet_export.py:1280-1300,1560-1580.

Vì vậy Sticker Sheet không thể xuất hai dao, trong khi Classic StickerTool có. Nếu yêu cầu hai dao áp dụng cho cả hai chế độ, đây là lỗ hổng chức năng phải bổ sung hợp đồng end-to-end.

**Giải pháp sau khi duyệt:** quyết định contract sản phẩm; nếu áp dụng, thêm fields vào UI/schema/API/worker và test artifact cho PDF tách tem và PDF giữ tấm. Nếu chỉ Classic hỗ trợ hai dao, hiển thị giới hạn rõ trong UI và thêm test bảo vệ.

### §BLEED.PREVIEW.PAGE-BOX — P2/S — [CONFIRMED]

Nhánh page-box cục bộ tạo preview 210×297 (đơn vị mm) tại useClassicCutlinePreview.ts:297-360, nhưng overlay gọi resolveCutlineBoundingBoxes(preview) không truyền pageWidthMm. Fallback trong StickerSheetWorkspace.tsx giả định mọi preview rộng 100 mm. Probe path trang A4 cho badge 100.0×141,4 mm thay vì 210×297 mm.

**Giải pháp sau khi duyệt:** trả bounding_boxes kèm đơn vị vật lý từ builder hoặc truyền physical page size; bỏ fallback 100 mm khỏi đường hiển thị chính; thêm test badge.

## Findings hiệu năng/vòng đời

### §BLEED.PERF.FRAME-CACHE — P2/M — [CONFIRMED]

useClassicCutlinePreview.ts:532-533 dùng Map cho pageSourceCacheRef và previewCacheRef; frame mới được thêm khoảng :997-1007, chỉ clear khi document/generation đổi khoảng :568-574. Kéo slider qua nhiều key trong một tab giữ lại toàn bộ path string/canonical reference. Đây là retained working set, chưa có số đo RSS để gọi là leak.

**Giải pháp:** đo RSS và byte path theo ảnh/page; sau đó áp dụng eviction theo vòng đời và RAM tier. Máy >=16 GB không được cap vô điều kiện; máy yếu mới giảm working set theo policy.

### §BLEED.PERF.GEOMETRY-CACHE — P2/M — [CONFIRMED]

sticker_cutline_preview.py:1278-1293 nói chỉ giữ working set mới nhất nhưng giữ đến 20 entry bằng hard cap chung. Cache entry chứa prepared_instances và alpha/geometry liên quan. Điều này có thể giữ nhiều ảnh lớn trên máy yếu, đồng thời làm giảm công suất máy mạnh theo cap không gate RAM.

**Giải pháp:** đo kích thước entry/RSS; dùng policy RAM-tier thống nhất với cache khác, hoặc xóa theo revision/page ownership. Không đặt cap mới áp dụng cho mọi máy.

### §BLEED.PERF.ALPHA-FASTPATH — P2/M — [CONFIRMED SOURCE RISK]

useClassicCutlinePreview.ts:423-447 tạo ImageBitmap và alpha buffer nhưng không gọi bitmap.close() trong success/cancel/error cleanup. _localFastAlphaPreview tại :455-490 được tính mỗi thay đổi offset nhưng bị bỏ qua bằng eslint và không đi vào state/render. Đây là cấp phát và CPU không tạo lợi ích hiển thị trong đường chạy hiện tại.

**Giải pháp:** hoặc nối fast path vào state sau khi chứng minh parity, hoặc bỏ tính toán dead; luôn đóng bitmap trong finally; đo RSS/latency trước và sau.

## Bleed/color và rò RGB

### Điều đã có bằng chứng tự động

- Route và policy truyền các mode image/trajectory/inpaint/solid; Sticker Sheet có auto theo white-boundary ratio.
- Engine có nhánh flatten/composite, ICC/sRGB hoặc DeviceCMYK và Flate/SMask; test hiện có kiểm seam, alpha, CMYK purity, spot và continuity.
- CutContour resource là Separation/DeviceCMYK; mặc định là 100% magenta qua C1=[0,1,0,0].

### Khoảng trống chưa được chứng minh

- Chưa có artifact matrix đủ bốn mode × RGB/CMYK/alpha × page boxes × crop/keep-sheet, render ở tương đương 700%, 1000% và 1600%.
- Chưa có kiểm trực tiếp trong Illustrator/Acrobat/WebView để bắt halo một pixel, viền đen hoặc un-premultiplied RGB leak sau rasterization của renderer.
- Test dirty-RGB hiện kiểm buffer/pipeline ở mức thấp hơn PDF artifact; không đủ để khẳng định sạch 100%.
- Preview Canvas không mô phỏng bleed color: hook/preview options chỉ mang hình học Cutline; Sticker Sheet dùng ảnh preview và SVG path, không render kết quả bleed mode. Đây là khoảng trống WYSIWYG màu, không phải bằng chứng mọi mode đang sai.

### Cập nhật finding PNG Alpha sau khi xử lý

Đã tái hiện một lỗi riêng với trường hợp người dùng tạo đường cắt theo biên
trong suốt và `bleed_mm=0`: preview có thể đã dùng mask sạch nhưng writer vẫn
chép `/SMask` gốc của PNG vào PDF. Vì vậy các pixel bán trong suốt nhiều màu ở
mép (trắng, đen, cyan, cam và màu tùy ý) vẫn xuất hiện khi phóng to.

Đã bổ sung một helper Alpha-only dùng chung cho preview và export. Helper xóa
mọi pixel bán trong suốt thông với nền ngoài theo mask Alpha; đồng thời xử lý
cả RGB ẩn ở pixel Alpha=0. Pixel nhìn thấy giữ nguyên, còn byte vô hình được
đệm để phép nội suy PDF không kéo màu cũ trở lại. Nó không lấy màu để dựng bù
xén, không tạo lớp bleed và không nới trang. PDF
trung gian được sao độc lập theo trang để resource dùng chung của trang khác
không bị sửa.

Bằng chứng mới: fixture PNG RGBA sáu vòng màu → PDF có `/SMask` → preview
render và `StickerEngine(cut_mode="alpha", bleed_mm=0)`. Kết quả: preview và
mask trong PDF cùng Alpha sạch, không còn dải Alpha mờ, input không bị sửa;
114 test source/alpha/artwork (gồm 7 test mới) và 11 test alpha engine đều đạt.
Chưa có PNG người dùng cụ thể và chưa chạy trực tiếp Illustrator,
Acrobat hoặc WebView, nên vẫn giữ giới hạn WYSIWYG renderer trong phần trên.

## Geometry, denoise, corner và offset

Test hiện có nhiều ca offset âm/dương, preserve/round/miter, denoise, góc nhọn, cubic fitting, continuity, SDF và preview→PDF path. Tuy nhiên chưa có ma trận artifact đầy đủ cho:

- contour lõm/chữ L với contour_offset;
- từng corner style khi render SVG/PDF cùng stroke contract;
- hai dao trên cùng artifact giữa sequential/parallel;
- distortion/co cụm node sau denoise trên fixture ảnh nhiễu thật và góc nhọn.

Trạng thái là AUTO/ARTIFACT một phần, chưa phải RUNTIME/WYSIWYG 100%.

## Test và baseline

### Backend

- Bleed/CUT preview, denoise, seam: **227 passed, 3 warnings**.
- Geometry/simplify/alpha/background: **280 passed, 1 skipped, 1 failed**.
- Failure tái hiện riêng: backend/tests/test_cutline_representation_quality.py::test_dense_round_polyline_can_use_spans_longer_than_twelve — stats["changed"] == False; test yêu cầu changed=True và after_segments <= 5.
- Memory/cache/cleanup: **254 passed, 3 warnings**.
- Jobs/cancel/responsiveness: **39 passed, 1 warning**.
- Identity/continuity/spot/page canvas: **52 passed, 1 warning**.
- Classic/whole-page/homogeneous: **81 passed**; bốn lỗi ban đầu là PermissionError [WinError 5] khi sandbox tạo Windows pipe; chạy lại đúng bốn ca ngoài sandbox: **4 passed, 9 deselected, 1 warning**.
- Contract scanner self-test: **17/17**.

Failure simplify xảy ra trên worktree đang có diff ở cutline_cubic_simplify.py và test tương ứng của đợt audit khác. Cần đối chứng baseline sạch trước khi gán nguyên nhân cho riêng audit Bleed/Cutline.

### Frontend

- 13 nhóm/file Vitest liên quan: **191 passed**.
- npm run typecheck: **pass**.
- Chưa có test cho contour-offset preview-vs-PDF, line join/cap contract, cache eviction/RSS, zoom renderer hoặc badge page box vật lý.

### Hiệu năng

Tài liệu lịch sử ghi cold whole-page khoảng 6–21 s, cache hit khoảng 9–10 ms, Execute 13 trang khoảng 38–45 s (N=1). Đây không phải benchmark mới của source ngày 2026-10-01. Chưa có đo slider frame time, peak/steady RSS sau nhiều vòng kéo/đổi trang/đóng session.

## Lô sửa đề xuất sau khi user duyệt

Mỗi lô tối đa 5 file, verify hẹp sau từng lô:

1. **Backend fan-out ThruCut:** sticker_engine.py + test artifact sequential/parallel; truyền đủ trường và kiểm resource/stream.
2. **Canonical contour-offset:** backend preview serializer + StickerSheetWorkspace.tsx + fixture/test SVG↔PDF.
3. **Stroke/page-box parity:** writer + overlay/page-box builder + render tests; thống nhất linecap/linejoin và kích thước vật lý.
4. **Sticker Sheet dual-knife contract:** schema/API/UI/export worker + tests cho tách tem/giữ tấm, nếu sản phẩm xác nhận cần hỗ trợ.
5. **Perf/lifecycle:** bitmap cleanup, cache ownership/RAM-tier, RSS/slider benchmark; tách riêng khỏi lỗi simplify đang có.
6. **Zoom/color artifact gate:** corpus RGB/CMYK/alpha và bốn mode; xuất PDF, raster 700/1000/1600%, đo halo/black edge/RGB contamination; sau đó mới chạy Acrobat/Illustrator/WebView smoke.

## Kết luận

Các kiểm tra hiện có bảo vệ khá tốt nhiều nhánh hình học và bleed ở mức source/test/artifact cục bộ. Audit chưa thể chứng nhận WYSIWYG 100% hoặc sạch halo ở ba renderer.

## Cập nhật sau khi duyệt sửa — 2026-10-01

Các lô sửa đã được thực hiện theo thứ tự nhỏ, mỗi lô có verify riêng:

- Fan-out nhiều trang truyền đủ `thrucut_enabled`, shape, bốn lề, bán kính, spot và màu xuống worker. Regression PDF tách từng tem chứng minh mỗi trang giữ cả `/CutContour CS` và `/ThruCut CS`.
- Writer ghi `j/J` theo `preserve`, `round`, `miter`; overlay SVG dùng cùng quy tắc cap/join.
- Sticker Sheet đã có hợp đồng Bế 2 dao ở UI, schema, API và worker cho cả tách từng tem và giữ nguyên tấm. Khi tách tem, `crop_box` được nới đủ vùng ThruCut nhưng `trim_box` vẫn giữ biên Demi.
- Preview backend trả `thrucut_d` từ cùng path groups canonical với CutContour. Rounded rectangle, ellipse và contour offset đều dùng đúng mm→px theo DPI/scale; frontend ưu tiên path này, fallback cũ chỉ dùng khi server không trả trường canonical.
- Page-box preview truyền kích thước vật lý thay vì giả định 100 mm.
- Cache hình học backend xóa entry cũ khác revision/source và dùng policy RAM tier; máy từ 16 GB không bị hard-cap 20 entry. Fast path alpha cục bộ không còn tạo bitmap thừa.
- Pipeline PNG/Alpha khử bóng tối bán trong suốt chỉ ở ngoài thân tem, giữ viền đen thật, alpha bán trong suốt và RGB gốc; khôi phục dải support để không cắt mất feather. Tùy chọn `shadow_cleanup` đã được truyền từ nhận diện ban đầu và refine.

### Bằng chứng đã chạy

- Backend preview, split, fan-out và simplify liên quan: **75 passed** ở lượt verify cuối; regression split theo ba shape và lề bất đối xứng: **3 passed**; regression canonical preview (ba shape + response): **4 passed**.
- Backend shadow/source/engine: **100 passed, 1 warning**; fixture 2000×2000 đo khoảng **29–33 ms**.
- Frontend preview/export/settings/API: **131 passed** và **49 passed** ở hai nhóm Vitest; `npm run typecheck`: **pass**.
- `py_compile` cho schema, route, source pipeline, preview worker và engine: **pass**.

### Giới hạn còn lại

- Chưa chạy ứng dụng Tauri và chưa raster/đối chiếu bằng Illustrator, Acrobat hoặc WebView ở 700–1600%; vì vậy chưa tuyên bố sạch 100% trên ba renderer.
- Chưa có corpus artifact đầy đủ bốn mode bù xén × RGB/CMYK/alpha × page-box/crop/keep-sheet. Evidence PNG tổng hợp 700/1000/1600% đã được lưu ở `docs/audit/BLEED_CUTLINE_2026-10-01`, nhưng là fixture kiểm soát, không thay cho smoke test renderer thật.
- Một failure simplify đã có từ diff của đợt audit khác (`test_cutline_representation_quality.py::test_dense_round_polyline_can_use_spans_longer_than_twelve`) chưa được gán cho lô này.

