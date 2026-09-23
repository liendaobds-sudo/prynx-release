# Audit: bù xén xong sang Bình tem bế không còn thấy phần bù

> **Đính chính sau phản hồi người dùng: ca cần kiểm là nguồn bù2mm + hở2mm, phải còn1mm mỗi bên.** Lượt đầu chỉ thử nhánh lưới và giải thích thêm gap0 đã không trả lời đúng hiện tượng mất hết. Đã tìm và tái hiện một lỗi khác trong nhánh **true-shape nesting**: với cùngPDF bù2mm, gap2/2, bleed_setting2, clip vẫn trùng đường bế nên vòng bù mất hết. Xem BXHAND21.03 ở mục7. Đây là lỗi độc lập với giá trị bleedẩn0; không cần tăng gap4mm để chữa ca2/2 này.

Ngày 2026-09-21. HEAD `703ffc2604ad5e5ff0ef391d9684e05688693c2b`.
**Audit-only. Không sửa production, không thay file khách.** Working tree đang có bản sửa xuất ảnh của người dùng/phiên khác; giữ nguyên các thay đổi đó.

## Kết luận và giới hạn

Đã tái hiện **mất vòng bù trong PDF sau khi bình**, bằng cách chạy thật StickerEngine tạo bù 2mm rồi đưa chính PDF đó qua run_nup_engine. PDF bù xén nguồn vẫn có vòng bù và hash không thay đổi; phần bù bị **clip khỏi bản bình**, không phải được xóa khỏi file nguồn.

Hai yếu tố được xác nhận:

1. Clip của tem bế bị giới hạn bởi nửa khoảng hở tem. Hở0mm → clip sát đường bế → không còn phần bù ngoài đường bế. Hở2mm → giữ tối đa1mm; muốn clip cho phép2mm thì hai chiều hở phải ít nhất4mm, đồng thời giới hạn bleed phải đủ.
2. **Giá trị `bleed` vẫn tác động đến clip nhưng UI lại ẩn nó ở Bình tem bế.** Nếu giá trị ẩn này bằng0, dù nguồn đã bù2mm và hở4mm, vòng bù vẫn gần như mất hoàn toàn. Bù xén và Bình tem bế không dùng chung nguồn dữ liệu về độ rộng bleed.

**Chưa tái hiện việc chỉ bấm chuyển công cụ, chưa bấm bình, làm phần bù biến mất ngay trên viewer nguồn.** Lượt này không có PDF/screenshot đúng ca người dùng để gắn hiện tượng đó với một job cụ thể. Không dùng kết quả kiểm PDF sau bình để tuyên bố đã chứng minh lỗi đổi màn thuần túy.

## 1. Truy vết bàn giao file

Các đường dẫn dưới đây tương đối với `D:/pdfcompare`:

- `desktop/src/components/preprocess-tools/StickerTool.tsx:865-895`: nhận blob/path của job bù xén, `await onFileFixed(...)`, sau đó mới bật `isSuccess`.
- `desktop/src/components/ImpositionTab.tsx:1479+`: `commitWorkingFile` dựng File từ kết quả, dùng path kết quả nếu có; `:1633` cập nhật `setFile(newFile)` và blobURL.
- `StickerTool.tsx:282-296`: nút sang Bình tem bế đổi `activeDashboardTool/taskMode`, không tự mở lại PDF gốc. Nút bước tiếp theo nằm trong khối `isSuccess` tại`:1696+`.
- Nhánh nhiều tem: `StickerCutlineTool.tsx:167-190` cũng chờ `onFileFixed`, kiểm `committed === false` trước khi báo hoàn tất; nút chuyển công cụ xuất hiện sau `completedExport`.

**TRACED, chưa RUNTIME:** chưa thấy đường chuyển công cụ này chủ động thay file kết quả bằng file gốc. Test revision/commit liên quan đạt, nhưng không đủ để loại hết race trên máy người dùng.

### Các lớp hiển thị không được nhầm với dữ liệu bù xén

- `ImpositionTab.tsx:912+` chỉ bật classic overlay khi active tool là`sticker`; đổi công cụ sẽ bỏ overlay.
- Tuy nhiên `StickerSheetWorkspace.tsx:53-84` cho thấy overlay classic là SVG đường cắt `fill=none`, không phải bitmap/artwork bù xén. Không thể lấy việc overlay tắt làm bằng chứng toàn bộ bleed artwork đã mất.
- `LivePageFrame.tsx:5913-5938`: `showBleedView` chỉ vẽ viền đỏ chỉ dẫn. Bật nút mắt không sửa hay khôi phục phần bleed đã bị writer clip.
- `AcrobatViewer.tsx:2576` truyền kích thước khuôn vào chế độ Bình tem bế; consumer `LivePageFrame.tsx:7406+` chỉ ghi nhãn W/H, không phải lệnh crop ảnh.

## 2. Đường clip làm mất bleed khi bình

`ImposerDashboard.tsx:1708` truyền `bleed: s.bleed` vào cấu hình thực thi; `:2311` cũng gửi sang preview. `GridPreview.tsx:2461` đổi mm→pt cho backend.

`backend/app/workers/nup_engine.py:586` tính bleed_pt → `nup_process_chunk.py:964-965`:

```python
clip_off_x = min(gap_x / 2.0, bleed_pt) if gap_x > 0 else 0.0
clip_off_y = min(gap_y / 2.0, bleed_pt) if gap_y > 0 else 0.0
```

`nup_artwork.py:1144-1150` dựng vùng clip quanh trim; `:1386-1393` nở contour theo `min(clip_off_x, clip_off_y)` rồi giao với vùng clip; `:1451-1466` gửi clip vào writer.

Với tem contour trong nhánh đã kiểm:

```text
bleed cho phép hiện = min(bleed_setting, gapX/2, gapY/2)
```

Đó là giới hạn vẽ, không phải thao tác tạo thêm phần bù. Nguồn có bleed lớn hơn thì phần nằm ngoài giới hạn không được vẽ vào tờ xuất.

Tài liệu `BAO_CAO_AUDIT_BINH_TEM_BE_CLIPMASK_CAN_GIUA_2026-09-13.md` đã chốt clip đồng nhất quanh tem bế để không đè tem hàng xóm. Vì vậy **không coi mọi clip theo nửa gap là bug mới** và không đề xuất gỡ clip vô điều kiện. Điểm chưa ổn là giới hạn ẩn/không khớp nguồn và việc mất bleed không được giải thích tại luồng thao tác.

## 3. Finding

### BXHAND21.01 — P1 / effort M — Tham số bleed bị ẩn nhưng vẫn quyết định artifact

**[CONFIRMED / ARTIFACT]**

- `GridSettingsSection.tsx:656+` ẩn ôTràn lề khi `dieGeometryMode=true`; comment ghi rằng bleed không tác dụng ở bế tem.
- `AdvancedSettingsSection.tsx:1683+` cũng chỉ hiện bleed cho booklet và có cùng giả định.
- Consumer thực tế vẫn dùng giá trị này để tính clip như trên. Probe hở4mm chỉ đổi bleed_setting2→0 làm vòng bù gần như biến mất.
- `marksSlice.ts:61-64` giữ `bleed` trong state độc lập. `StickerTool.tsx:379,447` dùng `bleedMm` riêng, lưu preference riêng; nút chuyển công cụ không bàn giao độ rộng bù như metadata sản xuất.
- `ImposerDashboard.tsx:1117-1149` có auto-detect từ PDF nhưng **return sớm với sticker_imposer/cnc_imposer**. Vì vậy ngay khi PDF bù có TrimBox/BleedBox đúng, đường này không tự đồng bộ độ rộng bleed cho Bình tem bế.

Kích thước layout lấy theo đường khuôn không có nghĩa bleed không tác dụng. Nhầm hai khái niệm này khiến UI giấu tham số vẫn ảnh hưởng đến phần được in.

### BXHAND21.02 — P2 / effort S-M — Không giải thích việc chỉ giữ một phần bleed nguồn

**[CONFIRMED về hành vi + khoảng trống hợp đồng]**

Nguồn đã bù2mm không được bảo đảm giữ đủ2mm sau bình: có thể bị giảm còn1mm hoặc0mm theo gap. Không có chốt trong đoạn bàn giao này để đối chiếu “bleed đang có” với “bleed còn được vẽ” hoặc thông báo sẽ bị cắt giảm. Lượt xuất vẫn báo thành công bình thường.

Giới hạn nửa gap có lý do hình học khi hai tem sát nhau, nhưng cần hiển thị rõ hậu quả và lựa chọn sản xuất. Không nên âm thầm tăng gap làm giảm sức chứa, hoặc bỏ clip để bleed đè artwork tem khác.

## 4. Tái hiện xuyên engine và đo file thật

Fixture riêng: trang60×60mm, hình tròn xanh đường kính danh nghĩa40mm. Chạy `StickerEngine(dpi=150).process_pdf` với `cut_mode=alpha`, bleed2mm, bù màu đỏ, remove_white_bg=true. Khuôn nhận diện khoảng39.84mm do raster contour; đây không phải audit độ chính xác nhận dạng.

PDF sau bù có MediaBox/CropBox/BleedBox rộng hơn TrimBox; render có vòng đỏ rõ. Sau đó chạy `run_nup_engine` thật, die-cut S&R/simple_auto trên tờ100×100mm, lề10mm, không boong/dấu xén, tách trang CUT.

| Hở tem | bleed_setting của Bình | Clip ngoài khuôn tối đa | Pixel đỏ ở trang IN |
|---:|---:|---:|---:|
| Nguồn bù xén |2mm|chưa bình|20298|
|0mm|2mm|0mm|0|
|2mm|2mm|1mm|7860|
|4mm|2mm|2mm|17707|
|4mm|0mm|0mm|6|

6pixel còn lại là vệt biên/AA, không phải vòng bù có độ rộng sử dụng được. Các ca không cùng số tem/tờ: gap0 xếp4, các ca còn lại xếp1 trên khổ thử; **không dùng tổng pixel làm tỷ lệ phần trăm mất bleed**. Con số dùng kiểm có/mất vòng bù; mức clip lấy từ công thức và hình học.

Đã xem nguồn và ảnh IN của các ca gap0/2/4, xác nhận phù hợp phép đo. Hash PDF bù trước/sau bình không đổi. Bằng chứng này bác giả thuyết nguồn bị thay trong chính phép thử, nhưng không thay thế việc nhận đúng file/màn hình người dùng.

QA nằm tại `D:/printsolutions-main/product/xep quan ao/tmp/pdfs/bleed-handover-20260921/`; harness `tmp/audit_bleed_handover.py`. Evidence gọn: `docs/audit/BLEED_HANDOVER_2026-09-21.json`.

## 5. Verify

- 5 assertion artifact: nguồn có vòng bù; gap0 mất; gap2 còn một phần; gap4 cho vòng rộng hơn; bleed_setting0 mất dù gap4. Đạt.
- Backend `tests/test_nup_clip_shape.py`: **10 passed**,1warningPydantic có sẵn.
- Frontend StickerTool.ui + StickerCutlineTool + ImpositionTab.stickerSourceRevision: **46 passed /3file**.
- Test xanh xác nhận các hợp đồng đã có, không chứng minh thao tác đổi màn của user không còn lỗi.
- Harness lần đầu dừng do consolecp1252 không in được emoji trong report; đã đổi stdout của **scriptQA** sangUTF8 và chạy hoàn tất. Không coi lỗi harness đó là lỗi production.

## 6. Hướng sửa đề xuất, chờ duyệt

1. Bàn giao metadata rõ: đường bế, artwork bounds, bề rộng bleed có sẵn và vùng bleed cho phép in. Không dùng giá trị globalẩn có thể đến từ công cụ khác để quyết định cắt ảnh.
2. UI cho thấy phần bleed thực sự được giữ sau gap; cảnh báo trước khi mất/giảm. Không nhất thiết thêm nhiều ô nhập: có thể hiển thị “Nguồn2mm → giữ1mm do hở2mm”.
3. Giữ clip chống chồng; nếu muốn đủ2mm mỗi tem thì đề xuất hở≥4mm với cả hai chiều, nhưng người dùng quyết định đánh đổi sức chứa.
4. Test bàn giao file/revision và raster trước/sau theo cùng case; bổ sung ca giá trịẩn0/khác bleed nguồn, nguồn bên ngoài, gap bất đối xứng, từng tem/nguyên tấm và nesting trước khi mở rộng kết luận.

**Cần thêm để chốt phần đổi màn ngay lập tức:** PDF vừa bù xén và ảnh màn hình lúc vừa chuyển sang Bình tem bế, chưa bấmThực thi; hoặc xác nhận hiện tượng đang nói đến preview/tờ sau khi bình. Chưa gắn severity cho lỗi đổi file/ẩn bleed ngay khi đổi màn vì chưa tái hiện.

Theo skill audit/deep-audit của dự án, dừng ở báo cáo và chờ duyệt; không sửa source, không restart ứng dụng, không đụng bản sửa xuất ảnh đang diễn ra.

## 7. BXHAND21.03 — P1 — True-shape nesting clip sát đường bế, bỏ bleed dù gap2mm

**[CONFIRMED / ARTIFACT]** — finding chính mới cho kiểu lỗi người dùng nhấn mạnh.

### Nguyên nhân chính xác

`backend/app/core/nesting_production_pipeline.py:638-651` dùng cùng `polygon` cho:

```python
cut_contour=polygon,
artwork_clip_path=polygon,
```

Không nở artwork clip theo nửa gap, không đưa phầnbleed nguồn vào hìnhclip. `ProductionNestingJobInput` có `part_gap` nhưng không có hợp đồng retained/sourcebleed riêng. `nup_true_shape_nesting.py:1066` chuyển gapX/Y vào clearance đểxếp; giá trị này không trở thành offsetclip.

Consumerthật: `nesting_imposition_bundle.py:808-809` serialize cutContour/artworkClipPath → `nup_artwork.py:1756-1771` build_manifest_clip_rings rồi paint_manifest_page_form → PDF thật. `nup_clip_shape.py:437-470` chỉ transform cácđỉnh, khôngbuffer/nở thêm. Vì thế file vẫn cóbleed ngoài đườngbế, nhưng writerkhông cho nóhiện trongbản bình.

Reachability: `nup_engine.py:428-431` gọi run_true_shape_nesting khi explicit token hoặc autoroute; `nup_true_shape_nesting.py:210-250` autoroute Xếp tốiưu + ít nhất1shapeCUSTOM khi rolloutbật và không bịcompatibility/qualityfallback. Không đồngnhất mọi Xếp tốiưu với true-shape: namedshapes/lưới/fallback vẫn cóđường khác.

### Đối chứng cùng nguồn, cùng2mm/2mm

Dùng **chính PDF cóvòngđỏ bù2mm** của mục4, không sửaPDFnguồn; mộttem trên tờ100mm, gapX=gapY=2mm, bleed_setting=2mm.

| Nhánh | Phần bù mong đợi | Kết quả raster trang IN |
|---|---|---|
| Legacy simple_auto |1mm mỗi bên|Còn vòngđỏ;7860pixelđỏ|
| Production true-shape |1mm mỗi bên|Mất vòngđỏ;chỉ6pixelbiên/AA|

Probe thật đi `build_true_shape_nesting_job` → `run_production_nesting_job(commit=False)` → native solve → productionPDFwriter. Fixturehìnhtròn được chọn **explicit protocoltoken** để cô lập renderer true-shape; không khẳng định autoroute sẽchọn nestingcho mọi hìnhtròn. NguồnCUSTOM trênUI cóđường autoroute như trace trên, nhưng chưa lấyđượcshape/manifest của phiênkhách cụthể.

Đọc lại renderbundle thấy `artworkClipPath == cutContour` chínhxác. Manifest báo placedCount1,unplaced0,validation.valid=true; validator chỉ xácnhận hìnhđang môhìnhhóa khôngvachạm, không kiểm việcbleed đãbịbỏ. Đã xemPDF raster và assertclipidentity/biếnmất vòngbù. Phầnbleed_setting2 khôngbị0hóa trongsettingsQA, nên khôngquy lỗi nàycho giátrịẩn0 ởfinding trước.

### Bằng chứng và giới hạn

QA: `tmp/audit_bleed_true_shape.py`, `tmp/pdfs/bleed-handover-20260921/true-shape-gap2-bleed2.pdf`, PNG, renderbundle, manifest vàtrue-shape-evidence.json trong workspace. Tạo source snapshot tạm qua pipeline đãđược cấpquyền; khôngcommitmanifest vào khojobuser, khôngsửasourceproduction.

- Test sourcegeometry+autoroute: **70passed**,1warningPydantic;2artifactassertions mớiđạt. Kếtquả10backend/46frontend ởmục5 làlượttrước, khôngcộng lại thành ca mới.
- ComputerUse khôngđược cấpquyền truycậpPrynX; dừngUI, khôngđi đườngkhác đểvượt quyền. Vìvậy chưa xácnhận rằng chínhphiênkhách đangởtrue-shape, chưa nângRUNTIME.
- Groupingnone choN-Up bịguard từchối ởlượtQAđầu; sửa **fixture** sangfree_gang đúnghợpđồng. Khôngsửa guard.

### Hướng sửa cần giữ đúng yêu cầu

Tách3hình: **đườngbế**, **vùngartworkđượcgiữ**, **footprintxếp/clearance**. Nguồnbù2mm +gap2mm phảiđưa vùngartwork nở1mm vào preview/export, khôngđổi đườngbế, khôngtănggap4mm đểnébug. Cần xửlý hở bấtđốixứng vàgiữ bleedtrongngân sách nửagap.

Adapter hiệnyêucầu footprint chứaartworkClipPath (`nesting_source_geometry.py:343`, `nesting_production_adapter.py:834-839`). Khôngchỉ thêm buffer1mm ởwriter: phảiđồngbộ bundle/validation/fingerprint và khôngđếm gapha lần làm giảm sứcchứa. Giữpreview/export cùngclip đãgiải, kiểmartifact2/2 trước khi mở rộng quaCNC.

**Rút lại cách giải thích trước:** gap0 mấtbleed làcontrol khác, khôngphải nguyênnhân đượcphép áp cho ca hở2mm củauser. Côngthức nửagap ởnhánhlưới không chứngminh nhánhnesting cũng làmđúng. Chưa sửaproduction; chờduyệt theo quytrìnhaudit.
