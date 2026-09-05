# Audit bù xén / tạo đường cắt: bóng màu và mất mảng tem AI

Ngày: 2026-09-05. Audit unit: `W2-U03-SHADOW` / `W2-U04-SHADOW`.

**Trạng thái: AUDIT XONG, CHỜ DUYỆT SỬA. Không thay đổi source production.**

## 1. Kết luận

Đã tái hiện cả hai lỗi người dùng báo bằng đúng PDF, gọi detector và writer production hiện hành, mở lại PDF kết quả và render bằng Poppler:

1. **Một tem / PDF-PNG đã có biên:** mask dò nền giữ cả bóng nâu bên dưới; đường CutContour bám theo bóng thay vì mép vàng thật.
2. **Tách nhiều tem:** BiRefNet-lite loại bóng nhưng cũng bỏ mảng artwork bên phải. Sai hỏng đã có trong Alpha thô của model, trước bộ khử bóng. Gate chấp nhận AI vì vẫn có một tem và IoU toàn hình đạt **89,34%**, vượt ngưỡng **80%**.
3. **Tắt Khử bóng không sửa được ca này:** `shadow_exclusion` bằng 0 toàn ảnh; bật/tắt trả cùng labels. Vùng lá xanh có Alpha thô bằng 0 nên các bước tinh chỉnh hình học đường cắt không thể tự phục hồi phần artwork đó.
4. Lỗi đi tới PDF xuất, không chỉ nằm ở giao diện: một ROI nội dung bên phải 25 x 26 pixel bị `/SMask` biến thành trong suốt hoàn toàn. File PDF nguồn không bị sửa.

Đề nghị ưu tiên bảo vệ thân tem trước, sau đó phát triển nhận diện bóng màu riêng và dùng chung ở hai chế độ. Không chữa bằng co contour toàn cục, tăng dung sai nền tùy ý hoặc ép mọi tem thành hình tròn.

## 2. Đầu vào, phạm vi và mức bằng chứng

| Thuộc tính | Bằng chứng |
|---|---|
| Nguồn | `D:\pdfcompare\test\test bu xen.pdf` |
| SHA-256 trước và sau | `C601B12447EF362A7F9EAE77AD18630A360E8150B8E85A5174C1A1CFBD10B08B` |
| PDF | 1 trang, 749.446 byte, 50 x 50,2757 mm, không có CutContour/vector/Alpha nguồn |
| Artwork | Một bitmap 594 x 594, ICCBased RGB, nằm trong Form XObject; đọc đệ quy mới thấy |
| Lưới phân tích production | 591 x 594 pixel, DPI x/y theo kích thước vật lý, xấp xỉ 300 DPI |
| Model thật | `birefnet-lite`; local ONNX SHA-256 `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333` |
| Source baseline | HEAD `669b92dbb3a343633c578df6fea9872514c6ef22`; hash bốn file worker trong JSON bằng chứng |
| Thay đổi có sẵn | Workspace đã dirty ở nesting/auth/master matrix; không hoàn tác hoặc sửa các source đó |

Thiết lập kiểm artifact: `original`, offset 0 mm, bleed 0 mm, `preserve`, đặc ruột, không crop trang; smoothness/fidelity/tension 50, min detail 1 mm². Denoise classic 30 và multi 50 theo mặc định hai nhánh. Đây là cấu hình kiểm tái hiện, **không suy rằng người dùng đã chọn chính xác các mức này trong ảnh**.

Đã đạt `TRACED + PROBE`, có **artifact lỗi thật đã parse/render**. Chưa nâng toàn audit unit lên `AUTO`/`ARTIFACT` theo thang master matrix vì chưa có regression khóa toàn bộ hành vi đúng: bỏ bóng đồng thời giữ thân tem. Chưa có `RUNTIME` Tauri/cài đặt hoặc chạy máy bế.

## 3. Kiến trúc / đường chạy đã trace

### 3.1. Chọn chế độ và nhận diện

- `desktop/src/components/preprocess-tools/StickerCutlineTool.tsx:40`, `:257`: hai chế độ mount `StickerTool` hoặc `StickerSheetPanel`.
- Classic: `useClassicCutlinePreview.ts:123` chọn chiến lược; `:425` gọi detect với `previewOnly: true`.
- Multi: `StickerSheetPanel.tsx:191` -> `stickerSheetStore.ts:1111` -> `desktop/src/lib/stickerSheetApi.ts:298`; mặc định `preview_only: false`, `birefnet-lite`, Alpha 128.
- `backend/app/main.py:377` đăng ký router; `backend/app/api/routes/sticker_sheet.py:259` -> `:280` truyền đúng field xuống `detect_sticker_source`.
- PDF mẫu vào `backend/app/workers/sticker_source_pipeline.py:2821`: `_background_detection` -> classic chỉ nâng AI khi roughness gate bật; multi gọi bước nâng một-tem khi `preview_only=False`.

### 3.2. Mask -> preview -> file

- `sticker_sheet_engine.py:786`: model -> raw Alpha (`:826`) -> shadow exclusion (`:839`) -> labels/clean Alpha.
- `sticker_sheet_session.py:642`, `:700`: promote lưu RGB/Alpha/labels, giữ nguồn; đưa session vào review, không tự bỏ bước xác nhận.
- `sticker_cutline_preview.py:804`, `:959`, `:1018`, `:1106`: đọc mask -> dựng hình học -> fit -> cache đường đã duyệt.
- **Classic thật:** `StickerTool.tsx:674` gửi canonical reference; `pdf_tools.py:1751` snapshot qua `sticker_sheet_export.py:247`; `pdf_tools.py:1809` truyền approved override vào `StickerEngine.process_pdf`. Không detect lại khi canonical reference hợp lệ.
- **Multi thật:** `sticker_sheet.py:637` -> `export_sticker_sheet_document` (`sticker_sheet_export.py:1131`) -> đọc mask/RGB (`:1268`) -> PNG RGBA -> `_png_pages_to_pdf` (`:706`) -> `StickerEngine.process_pdf` (`:1057`).
- Consumer làm mất nội dung: `_build_edited_rgba` đặt Alpha 0 ngoài labels (`sticker_sheet_export.py:542`); giữ nguyên tấm cũng đặt Alpha 0 ngoài labels (`:623`); PDF nhúng transparency (`:735`).
- Writer đường cắt `sticker_engine.py:11141`; lưu PDF `:11466`.

Hai nhánh artifact cuối đã chạy đúng primitive production tương ứng. Không gọi route HTTP, watermark/licensing, browser hoặc Tauri. Trong điều tra từng có một PDF control dùng mask classic qua document writer; **đã thay bằng artifact canonical classic thật**, JSON và ảnh giao cuối chỉ mô tả bản sau.

## 4. Phát hiện đã xác nhận

| Mã | Trạng thái | Mức | Effort | Phát hiện |
|---|---|---|---|---|
| `§SHADOW.1` | `[CONFIRMED]` | P1 | M-L | Biên nền phẳng của một tem giữ bóng màu, rồi tạo đường cắt ngoài mép thật |
| `§SHADOW.2` | `[CONFIRMED]` | P1 | M | Gate nâng AI chỉ dùng số tem/IoU tổng, nhận mask đã mất artwork cục bộ; lỗi đi tới PDF |

### §SHADOW.1 - Bóng màu được nhận như một phần thân tem

**Sink/consumer:** classic detect -> mask -> canonical preview -> approved override -> CutContour trong PDF.

`sticker_background.py:140` chỉ bỏ vùng gần màu nền nối với biên. Trên file mẫu, màu nền đo được là trắng, tolerance 12, confidence 1. Bóng nâu vượt dung sai này nên nằm lại trong foreground. `_background_detection` (`sticker_source_pipeline.py:1026`) không có nhánh nhận diện bóng màu cho silhouette một component này; các nhánh phục hồi composite/vỏ trắng yêu cầu cấu trúc khác. Roughness gate (`:1144`) không bật khi contour bóng đủ mượt.

Điểm ảnh trên bóng, gốc tọa độ trái-trên của lưới phân tích:

| Điểm (x,y) | RGB nguồn | Alpha mask classic |
|---|---|---:|
| (295,590) | (214,183,148) | 255 |
| (200,578) | (220,189,160) | 255 |

Ảnh dưới là **PDF canonical classic được mở lại**, offset/bleed đều 0; đường màu hồng vẫn ôm phần bóng phía dưới:

![PDF classic: đường cắt ôm bóng nâu](audit/BU_XEN_SHADOW_2026-09-05/single_artifact.png)

**Điểm cần phân biệt:** confidence nền = 1 không phải confidence mép cắt đúng = 1.

Bộ `_remove_attached_neutral_shadow` (`sticker_sheet_engine.py:375`) hiện chỉ dò luma 96..248, chroma <=16, và chỉ nhận khi biên sau bóc trắng >=88%, cải thiện >=8% (`:476`). Đây là guard **có chủ đích** bảo vệ artwork xám và tem không có viền trắng, không phải một nhánh đang bị gọi sai. Bóng mẫu có sắc nâu, tem có viền vàng, nên không thuộc điều kiện đã được chứng minh của bộ đó.

Root đã tự chạy probe tổng hợp viền vàng: cả 4.809 pixel bóng xám và 4.809 pixel bóng nâu đều được giữ; không tạo shadow exclusion. Không được nới chroma/white-rim gate vô điều kiện để sửa vì có thể xóa mảng in thật.

### §SHADOW.2 - AI mất mảng bên phải nhưng vẫn qua gate

**Sink/consumer:** multi detect -> `_upgrade_single_simple_background_geometry` -> promote/review -> xác nhận -> document writer -> SMask/CutContour.

Tại `sticker_source_pipeline.py:1273`, chỉ yêu cầu AI còn đúng một instance. Tại `:1280`, chỉ kiểm IoU toàn mask với `_SIMPLE_BG_AI_IOU_MIN=0.80` (`:89`). Không có phép kiểm mất chi tiết/artwork hoặc biên bị lùi sâu tại một vùng cục bộ.

| Số đo trên file thật | Giá trị |
|---|---:|
| Diện tích labels classic | 284.623 px |
| Diện tích labels AI multi | 254.285 px |
| IoU labels dùng ở gate | 0,893409879 |
| Số instance trước/sau | 1 / 1 |
| Pixel shadow exclusion | **0** |
| Labels khác nhau khi bật/tắt khử bóng | **0** |
| Điểm lá xanh (550,210) | RGB (44,96,6), **raw Alpha = 0** |
| ROI thân tem x=[495,520), y=[198,224) | 650 px; classic Alpha 255; **SMask PDF multi toàn 0** |

Phần giảm 30.338 px, tức 10,659% mask deterministic, **gồm cả bóng và artwork**. Không gọi đó là tỷ lệ thân tem bị mất. Tương tự, số pixel chroma>40 trong JSON không phân biệt được artwork với bóng nâu; không dùng nó làm oracle.

Ảnh dưới là PDF multi xuất qua `export_sticker_sheet_document`, được mở lại và render. Mảng bên phải và một phần nội dung bên trong đã biến thành trong suốt; đường cắt đi theo vùng khuyết:

![PDF multi: mất artwork bên phải](audit/BU_XEN_SHADOW_2026-09-05/multi_artifact.png)

**Phân giải nguyên nhân:** raw Alpha đã bằng 0 ở nội dung bị mất, trong khi exclusion toàn 0. Vì vậy bộ khử bóng không phải tác nhân xóa thêm mảng đó ở lần chạy này. Nó cũng không thể thêm lại phần AI đã bỏ.

Phép thử backend Alpha threshold 32/64/96/128/192 không khôi phục điểm raw Alpha=0. Các mức dưới 128 là **counterfactual chẩn đoán**, không phải đề xuất một mức UI đang có. API refine/store hỗ trợ Alpha 128..176; panel hiện không có thanh chỉnh Alpha, chỉ có lựa chọn Khử bóng.

Confidence AI 0,614598 cũng không phải phép kiểm bảo toàn thân: `_instance_quality` (`sticker_sheet_engine.py:525`) chỉ đo độ mơ hồ quanh biên đang được giữ, không đối chiếu nội dung nguồn bị bỏ bên ngoài.

**Giới hạn severity:** session vẫn yêu cầu review/xác nhận; không có bằng chứng bỏ qua xác nhận hoặc ghi đè mất PDF nguồn. P1 là tính đúng của nhận diện và file được xuất khi chấp nhận mask đó.

## 5. Chống kết luận sai và nghi vấn còn mở

- `[DISPROVED cho ca mẫu]` Khử bóng hậu xử lý xóa mảng bên phải: exclusion=0, on/off giống hệt.
- `[EXPECTED]` Không bóc artwork xám/viền màu bằng thuật toán white-rim cũ; test `test_neutral_artwork_without_white_shell_is_not_mistaken_for_shadow` bảo vệ điều này.
- `[EXPECTED]` Chế độ classic và multi dùng `preview_only` khác nhau có lịch sử tối ưu/chất lượng. Finding nằm ở kết quả bóng/mất nội dung được chấp nhận, không phải cứ hai mode khác nhau là sai.
- `[EXPECTED]` UI hiện ẩn warning/confidence trong panel là chủ đích đã được test; không báo lại như một bug mới. Nếu muốn cảnh báo riêng vùng AI vừa loại, đó là thay đổi UX cần duyệt.
- `[SUSPECTED, ngoài hai finding chính]` Cọ Giữ lại có thể cập nhật SVG nhưng chưa thay bitmap preview; writer có phục hồi RGB nguồn (`sticker_sheet_export.py:536`) và Alpha (`:543`). Cần thao tác Tauri thật để kết luận tính trực quan của cọ; chưa sửa.
- Không kết luận do fitter, renderer PPE hay thiếu `fill_holes`: mảng mất đã có ở Alpha đầu vào; artifact kiểm đang bật đặc ruột. Không khẳng định mọi sai khác spline chỉ do detector vì hai mode đang có denoise khác nhau.

Tài liệu đối chiếu: `ANH_AI_NHIEU_TEM_SHADOW_MOTION_FIXES_2026-08-08.md`, phần WHITE-SHADOW và Lô L/M của `BU_XEN_TAO_DUONG_CAT_FIXES_2026-08-16.md`, `BAO_CAO_AUDIT_BU_XEN_BE_TEM_MAU_VIEN_HIEU_NANG_2026-08-19.md`. Những lần sửa cũ chủ yếu kiểm bóng trung tính/offset trắng; không dùng thành công đó để suy ra ca viền vàng/bóng nâu đã được phủ.

## 6. Đề xuất sửa theo lô, chờ duyệt

### Lô A - Chặn mất thân tem cục bộ (ưu tiên trước, tối đa 5 file)

Dự kiến: `sticker_source_pipeline.py`, một helper kiểm ứng viên nếu cần, và 1-2 file test.

- Khi nâng mask nền sang AI, kiểm vùng bị loại theo từng cụm/cung biên, khoảng lùi cục bộ và bằng chứng chi tiết/viền nguồn. IoU và số instance chỉ là điều kiện phụ.
- Không dùng “có màu thì giữ” làm tiêu chí duy nhất: bóng trong ca này cũng có màu. Phải kết hợp sự liên tục của biên, cấu trúc/độ dốc nguồn và vị trí vùng mất.
- Nếu ứng viên có dấu hiệu cắt vào thân tem, không tự nhận làm biên chắc chắn; giữ nguồn, chọn fallback thận trọng và ghi lý do review. **Fallback này chưa đồng nghĩa đã bỏ bóng đúng.**
- Khóa ca thật: ROI nội dung phải còn; ứng viên AI khuyết nhưng IoU 0,89 không được nâng thành kết quả hợp lệ không phân biệt với ca tốt.

### Lô B - Tách thân tem khỏi bóng mềm có màu (tối đa 5 file mỗi lượt)

Dự kiến: helper bóng/biên riêng, integration `sticker_source_pipeline.py` và khi cần `sticker_sheet_engine.py`, tối đa 2 file test.

- Tách ba khái niệm: nền ngoài, dải bóng chuyển sắc, thân tem cần bảo toàn; AI cung cấp gợi ý, không sở hữu đáp án hình học cuối cùng.
- Thử ứng viên theo biên ảnh/gradient ngoài vỏ tem; dùng vành vàng trong mẫu làm bằng chứng địa phương, **không hardcode màu vàng hoặc giả định hình tròn**.
- Bảo vệ artwork, viền trắng/đen/màu, tai/banner nhô, khe lõm thật. Chỉ chấp nhận bỏ bóng khi có đủ bằng chứng và topology/phạm vi mất vẫn an toàn.
- Dùng chung kết quả mask giữa classic và multi cho cùng một tem; preview/canonical reference/export giữ cùng mask đã duyệt.
- Không union toàn mask deterministic với AI (sẽ đưa bóng trở lại), không chỉ siết IoU, không chỉ tăng tolerance hoặc lùi offset toàn chu vi.
- Trường hợp ảnh RGB nhập nhằng không thể tự bảo đảm: giữ review/công cụ chỉnh tay; không hứa tự nhận đúng mọi ảnh AI.

### Lô C - UX vùng mơ hồ (đề xuất sau, chỉ khi duyệt)

Hiển thị phần đang định bỏ và cách chọn lại biên/giữ lại; kiểm cọ trên bitmap thật. Tách riêng tối đa 5 file và verify i18n/UI. Không đưa việc thay đổi chủ đích ẩn warning hiện tại vào Lô A một cách ngầm định.

**Chốt quy trình:** theo `prynx-audit-workflow`, dừng tại báo cáo này. Chỉ sửa sau khi người dùng duyệt; mỗi lô verify xong rồi mới sang lô kế.

## 7. Ma trận nghiệm thu bản sửa

| Ca | Điều kiện bắt buộc |
|---|---|
| PDF mẫu này | Loại vùng bóng dưới, giữ mảng/viền/chữ/lá bên phải; không dùng toàn mask hiện tại làm ground truth |
| Một tem ở cả hai chế độ | Cùng biên thân tem; thay mode không làm mất artwork |
| Viền trắng + bóng xám cứng/mềm | Không hồi quy các ca WHITE-SHADOW hiện có |
| Viền vàng/đen + bóng nâu hoặc xám | Không coi viền in/artwork là bóng, không yêu cầu viền trắng |
| Artwork gần trắng/xám, chi tiết màu thấp | Không xóa vì giống nền hoặc bóng |
| Tem tròn có banner/tai, sao/khe lõm | Không ép ellipse, không mất topology/chi tiết có ý nghĩa |
| Không bóng / Alpha sạch / CutContour sẵn | Không đổi hình đã chắc chắn, không gọi AI thừa |
| PDF xuất | Reopen/đọc SMask + CutContour, render và so ROI; kiểm riêng offset/bleed/đặc ruột/crop |
| Runtime | Tauri thật: nhập PDF -> đổi mode -> preview -> xác nhận -> xuất -> mở lại, cọ Giữ lại/Undo |

Trước khi sửa cần chốt vùng thân/bóng mong muốn bằng annotation trên file mẫu và thêm vài mẫu ngoài tập này. Một ví dụ đẹp không chứng minh thuật toán tổng quát đã an toàn.

## 8. Kiểm thử đã chạy và bằng chứng lưu

### Baseline hiện tại

```powershell
# Trong D:\pdfcompare\backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_sheet_engine.py tests/test_sticker_source_pipeline.py --basetemp=../tmp/audit_shadow_agent/pytest_runtime
# 80 passed, 1 Pydantic warning, 115,37 giây

# Trong D:\pdfcompare\desktop
npx vitest run src/components/preprocess-tools/StickerSheetPanel.test.tsx src/components/preprocess-tools/useClassicCutlinePreview.test.tsx src/lib/stickerSheetApi.test.ts
# 3 file / 29 passed, 76,61 giây; không cập nhật snapshot
```

Hai suite xanh không phủ lỗi thật vừa tìm: bóng tests chủ yếu có white shell và AI mock; gate AI tests chưa có oracle mất mảng màu cục bộ trong khi IoU tổng vẫn đạt. Root đã tự xác minh probe, raw Alpha, số đo và PDF; không dùng riêng kết luận subagent để xếp P1.

Quy trình probe: inspect PDF -> tạo session cô lập -> `detect_sticker_source(auto, preview_only=True/False)` -> lưu Alpha thô/exclusion -> `reprocess_sticker_sheet(shadow_cleanup='off')` -> promote -> `build_sticker_cutline_preview` -> writer tương ứng -> pikepdf đọc đệ quy ảnh/SMask và CutContour -> Poppler render. Chỉ inference local **một lần**, các lần sau dùng cache Alpha cùng pixel/model ở thư mục chẩn đoán cô lập, không tải model/không gửi file ra dịch vụ AI ngoài.

Một inference dưới tải ghi khoảng 65,65 giây; model báo nhả arena do áp lực RAM. Đây là ghi nhận môi trường **N=1**, không benchmark hoặc kết luận hiệu năng mới. Không thay worker/cap/quality/model setting của ứng dụng.

Lần chạy harness đầu vướng stdout Windows cp1252; chạy lại với `-X utf8` thành công. Đây là lỗi harness, không phải finding production. Không chạy full suite/typecheck/build do lượt này không sửa code; chưa chạy UI thật, installer, model full/isnet, bleed khác 0 hoặc một tờ chứa nhiều tem thật.

Bằng chứng cuối lưu tại `docs/audit/BU_XEN_SHADOW_2026-09-05/`:

- `evidence.json`: nguồn, hash, branch, số đo, cấu hình và giới hạn diễn giải.
- `analysis_source.png`, mask classic, raw Alpha AI và shadow exclusion: tách nguyên nhân.
- `single_cutline_preview.json`, `multi_cutline_preview.json`: fingerprint và đường preview.
- `single_artifact.pdf`: canonical classic -> `StickerEngine` -> restore canvas, 1 trang/1 CutContour; giữ artwork RGB gốc, không tự biến thành ảnh AI.
- `multi_artifact.pdf`: document writer production, 1 trang/1 CutContour, SMask ROI nội dung = 0.
- Hai PNG cùng tên: render lại PDF cuối; `multi_artifact_smask_0.png`: SMask trích trực tiếp.

Đây là **artifact tái hiện lỗi, không phải file đã sửa để đưa in**. Source PDF hash trước/sau giống hệt. Không commit, không build, không thay model/cache của ứng dụng; chỉ thêm báo cáo/bằng chứng và cập nhật master matrix.
