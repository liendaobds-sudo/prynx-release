# Kế hoạch hợp nhất Bù xén - Tạo đường cắt lần 2

**Ngày:** 2026-09-06

**Trạng thái:** `ĐÃ DUYỆT · ĐÃ TRIỂN KHAI LUỒNG CHÍNH · CÒN NGHIỆM THU RUNTIME/ARTIFACT`

**Phạm vi:** hợp nhất trải nghiệm **PDF/PNG đã có biên** và **Tách nhiều tem** trong công cụ Bù xén - Tạo đường cắt.

**Không phải:** thay đổi `Bế tem nhãn` thành `Xén vuông góc`, thay đổi solver bình bản, hay build release.

Người dùng đã duyệt làm hết kế hoạch và tiếp tục qua các lô, không xin duyệt lại từng lô. Tài liệu
giữ tiêu chí đích bên dưới để đối chiếu, không coi các gate runtime chưa chạy là đã đạt. Tiến độ và
giới hạn triển khai thực tế ở mục 11; nhật ký commit/test ở `HOP_NHAT_BU_XEN_FIXES_2026-09-06.md`.

## 1. Quyết định chính

Hợp nhất **một workspace người dùng**, nhưng giữ **nhiều adapter xử lý bên trong**.

Người dùng không phải chọn trước file thuộc “PDF/PNG” hay “Ảnh AI nhiều tem”. Họ chọn file,
bấm một hành động nhận diện, kiểm tra kết quả, rồi chọn cách xuất. Engine phía sau vẫn được phép
chọn vector, Alpha, nền đơn giản, AI hoặc fallback thủ công theo bằng chứng.

```text
File / trang đang mở
      ↓
Inspect nhẹ (không AI)
      ↓
Nhận diện tự động + cảnh báo
      ↓
Mask/revision dùng chung → preview CUT
      ↓
Thiết lập bù xén / đường cắt
      ↓
Giữ nguyên tấm  |  Tách từng tem  |  ZIP PNG
```

## 2. Vì sao kế hoạch cũ không được dùng lại nguyên xi

Kế hoạch cũ vẫn là tài liệu tham khảo và được giữ tại:

[`KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_2026-08-15.md`](D:/pdfcompare/docs/KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_2026-08-15.md)

Nhưng lần hợp nhất trước đã được người dùng thử rồi revert. Phân tích hiện tại cho thấy hai
mode không chỉ khác nhãn UI:

| Thành phần | PDF/PNG đã có biên | Tách nhiều tem |
|---|---|---|
| UI | `StickerTool` | `StickerSheetPanel` + workspace |
| State | thiết lập công cụ/Working PDF | `StickerSheetSession`, page, mask revision, edits |
| Entry/backend | `/pdf-tools/sticker-dieline` | `/api/sticker-sheet/*` |
| Điểm mạnh | preserve CutContour, object selection, Xén vuông góc, recipe cũ | tách instance, cọ, refine, PDF/ZIP từng tem |
| Writer | `StickerEngine`/canonical preview | `export_sticker_sheet_document`/canonical mask |
| Rủi ro khi gộp thô | raster hóa hoặc mất page box/CutContour | mất split, edits, thứ tự trang hoặc revision |

**[USER-REPORTED]** bản hợp nhất cũ cho trải nghiệm tệ và đã bị revert.

**[CONFIRMED - code]** hai nhánh hiện có state owner và writer khác nhau.

**[HYPOTHESIS]** lỗi của lần cũ là thay đổi UI, state, routing và export contract cùng lúc trước khi
parity được khóa; kế hoạch lần 2 coi đây là giả thuyết cần kiểm bằng characterization, không xem là
kết luận runtime.

## 3. Mô hình sản phẩm mới

### 3.1. Nguồn nhận diện không còn là mode UI

Thay `StickerSourceMode` như một quyết định đầu vào bằng một chiến lược nội bộ:

```text
DetectionStrategy:
  existing-cut → vector/Alpha có bằng chứng → simple-bg → AI → manual/review
```

Thứ tự và điều kiện:

1. CutContour thật: giữ vector, không raster hóa.
2. Alpha/SMask/vector silhouette có bằng chứng: dùng mask hiện hữu.
3. Nền đơn giản: connected-components và nhận diện bóng màu nếu đủ bằng chứng.
4. AI: fallback hoặc lựa chọn nâng cao có chủ đích; không nạp AI chỉ vì người dùng chọn file.
5. Không đủ bằng chứng: giữ nguồn, báo lý do, yêu cầu review/chọn lại.

`strategy=auto` là mặc định của user-facing flow. `ai`, `alpha`, `simple-bg` vẫn tồn tại như
advanced action để khắc phục một proposal sai; không xóa route tương thích trong giai đoạn di trú.

### 3.2. Một hợp đồng mask, hai ý định xuất

Không gộp mọi thứ thành một engine duy nhất. Tạo contract chung ở mức session/page:

```text
StickerSourceSession
  source_kind, source_revision, source_page, page_order
  boundary_source, strategy_confidence, needs_review, warnings

StickerMaskRevision
  labels/instances, Alpha, edits, raw/refinement capability
  revision, fingerprint, owner(tabId, sessionId, pageNumber)

StickerGeometrySettings
  cut_mode, offset, bleed, corner, fill_holes, crop, color, tuning

StickerOutputIntent
  keep_sheet | split_instances | png_zip
```

Hai adapter vẫn được giữ:

- `Preserve/ClassicAdapter`: preserve CutContour/vector, object selection, page canvas và
  canonical classic preview.
- `StickerSheetAdapter`: mask từng instance, edits/cọ, split PDF/ZIP và document export.

Cả hai adapter đọc cùng `StickerMaskRevision` và `StickerGeometrySettings`; khác nhau ở cách
đóng output, không khác nhau ở quyết định “thân tem nằm đâu”.

### 3.3. Luồng bù xén và tạo đường cắt dùng chung

Đây là phần nghiệp vụ trung tâm của công cụ, không phải bước phụ của nhận diện:

```text
Mask thân tem đã duyệt
   ↓
Xác định CUTContour / đường cắt
   ↓
Offset hình học (mm)
   ↓
Bleed / bù xén theo chiến lược màu
   ↓
Crop hoặc giữ nguyên canvas/page box
   ↓
PDF có CUT / PDF từng tem / ZIP PNG
```

`StickerGeometrySettings` dùng chung phải bao phủ các field hiện có:

| Nhóm | Field | Hợp đồng |
|---|---|---|
| Đường cắt | `cut_mode` | `original`, `alpha`, `bleed`, `none`; không tự đổi mode khi đổi nguồn |
| Bù xén | `offset_mm`, `bleed_mm` | đơn vị mm; validate, giữ số lẻ; không dùng offset để “chữa” mask sai |
| Góc/chi tiết | `corner_style`, `fill_holes`, `min_detail_area_mm2` | preserve/round/miter; topology/lỗ phải được giữ hoặc cảnh báo |
| Làm mượt | `cutline_smoothness`, `cutline_fidelity`, `curve_tension`, `cutline_denoise` | thuộc page/mask revision; đổi giá trị phải invalidate preview đúng page |
| Màu bù xén | `bleed_color_type`, `solid_bleed_cmyk`, `bleed_sides` | image/trajectory/inpaint/solid; không lấy màu từ bóng/halo khi chưa có background contract |
| Canvas | `crop_to_sticker`, page expansion | crop là ý định xuất, không được làm mất phần bù xén; reopen phải đo Media/Crop/Trim/Bleed |
| CUT có sẵn | `preserve_existing_cut`, `vector_geometry_ref` | giữ byte/content/page box khi đủ điều kiện; generic vector không tự coi là CUT |

#### Hai mục tiêu hình học không được trộn

**Bế tem nhãn** dùng biên mask/CutContour tự do, offset, bù xén theo ảnh và crop theo tem.
`StickerTool`/canonical classic và `StickerSheetAdapter`/document export phải cùng dùng mask,
nhưng được phép có writer adapter riêng.

**Xén vuông góc** tiếp tục giữ contract riêng: cạnh bù xén, `edge_bite_mm`, `bleed_sides`,
lật gương, màu dải và n-up. Không đưa các field này vào mask AI hoặc để việc đổi strategy
tem làm reset chúng.

#### Quy tắc theo capability

- Có `existing-cut` và user chọn giữ: preserve path/vector; không raster hóa chỉ để hợp nhất UI.
- Có mask nhưng không có vector: dựng CUT từ mask đã duyệt; preview và export dùng cùng
  canonical geometry/fingerprint.
- Có nhiều instance: một mask revision/page có nhiều CUT; `Giữ nguyên tấm` và `Tách từng tem`
  chỉ đổi output intent, không chạy nhận diện lại.
- Bóng/halo đã bị loại khỏi mask: bleed màu phải đọc `background_rgb`/provenance đã duyệt;
  không lấy pixel ngoài mép mới bằng một sampler khác giữa classic và multi.
- Không đủ bằng chứng màu: giữ mask/đường cắt an toàn, hiện cảnh báo và cho phép review;
  không tự mở rộng bù xén qua bóng.

#### Tiêu chí artifact của bù xén

Mỗi lô hợp nhất phải mở lại PDF và kiểm:

1. số CUT, số instance và topology/lỗ;
2. đường CUT không chạy vào bóng, nhưng không ăn vào viền/artwork;
3. offset/bleed đo lại đúng mm sau writer;
4. màu bù xén không dùng halo sai và đúng colorspace contract;
5. crop/page expansion không cắt mất bù xén;
6. preview geometry và path trong PDF khớp fingerprint;
7. preserve CutContour thật giữ content stream/page box theo đúng ý định.

### 3.4. Capability thay cho ẩn cả khu vực

UI suy ra capability từ manifest/session:

```text
canPreserveExistingCut
canSplitInstances
canEditMask
canRefineAi
canRebuildCutline
canKeepSheet
canExportZip
```

Ẩn là thu gọn, không xóa state. Thiết lập Offset, bù xén, kiểu góc, crop, màu, lấp lỗ và page
order phải sống qua việc đổi chiến lược. `Bế tem nhãn` và `Xén vuông góc` vẫn là hai mục tiêu
hình học; các control edge bite, bleed sides, lật gương, cut-first-page và n-up không bị đưa vào
nhánh nhận diện tem một cách ngầm định.

## 4. Luồng người dùng đích

### Trạng thái chính

```text
empty
  → source-ready
  → inspecting
  → detecting
  → mask-review
  → mask-ready
  → exporting
  → error/retry
```

### Giao diện đề xuất

```text
Bù xén - Tạo đường cắt

Nguồn: file.pdf · Trang 1/3
Trạng thái: Chưa nhận diện
[ Nhận diện tem và tạo đường cắt ]

Đã nhận diện: 5 tem · Biên: tự động · Cần kiểm tra: có
[ Giữ nguyên tấm ] [ Tách từng tem ]

Preview mask / CUT
  [Giữ] [Xóa] [Gộp] [Undo] [Redo]

▸ Nhận diện nâng cao: Alpha · Nền đơn giản · AI
▸ Tinh chỉnh đường bế: Khử bóng · Bám sát · Độ bo · Lọc chi tiết

[Lưu PNG] [Tạo PDF có đường cắt]
```

Sau khi nhận diện, con số instance và cảnh báo phải hiển thị trước khi người dùng xuất. Không
đổi tự động từ “Giữ nguyên tấm” sang “Tách từng tem” chỉ vì nhận được nhiều instance; đó là một
quyết định output intent, cần được người dùng thấy và kiểm.

## 5. Characterization bắt buộc trước khi sửa UI

Lô 0 chỉ tạo fixture/manifest/artifact expected; **không đổi production code**.

| Mã | Ca | Expected tối thiểu |
|---|---|---|
| U0-01 | PDF có CutContour thật | preserve vector/content/page box; không AI |
| U0-02 | PDF vector/raster không CutContour | nhận diện đúng capability, không đoán generic vector là dao |
| U0-03 | PNG/JPG một tem, nền trắng/Alpha | một mask; bù xén và CUT khớp classic hiện tại |
| U0-04 | PDF/ảnh nhiều tem có bóng | instance count, bóng, viền và artwork; không mất mảng |
| U0-05 | Nhiều trang, reorder/duplicate | source_page ↔ working_page đúng; export order không đổi sai |
| U0-06 | `Xén vuông góc` | edge bite, bleed sides, lật gương, màu, crop giữ hợp đồng cũ |
| U0-07 | Recipe record/playback | output step, settings, page order, warning và cancel đúng |
| U0-08 | Native drop/tab nền | chỉ active tab nhận file; tab nền/đã đóng không nhận |
| U0-09 | True-shape ring 11 đỉnh | phân biệt vòng kín với Bézier hở; không dùng magic number 11 |

Mỗi fixture lưu manifest, mask revision, settings, CutContour count, page boxes, rendered PNG và
hash. File khách không đưa vào Git; dùng fixture tổng hợp hoặc evidence đã được duyệt.

## 6. Lộ trình triển khai

Mỗi lô production tối đa 5 file, verify và commit riêng. Theo chỉ thị tiếp tục toàn bộ của người
dùng, không dừng xin duyệt lại từng lô; phần nghiệm thu runtime còn thiếu phải ghi rõ và vẫn là
điều kiện trước khi bỏ compatibility hoặc chứng nhận phát hành.

### Lô 0 - Characterization

- Fixture/expected/artifact cho U0-01..U0-09.
- Không sửa UI/engine.
- Chốt expected behavior và câu chữ “Nhận diện tự động”.

**Gate:** tất cả flow có baseline; U0-09 đã tái hiện hoặc được bác bỏ bằng artifact thật.

### Lô 1 - Canonical source/session adapter

- Nối `StickerSourceSession`/page revision chung cho classic và sheet.
- Giữ `StickerTool`/`StickerSheetPanel` hiện tại làm hai consumer cũ.
- Không xóa `/pdf-tools/sticker-dieline` hoặc `/api/sticker-sheet/*`.
- Canonical reference, preserve vector, edits và source fingerprint phải cùng contract.

**Gate:** artifact classic và sheet cùng mask/geometry cho cùng input; recipe cũ không đổi.

### Lô 2 - Unified workspace UI

- Outer shell chỉ còn một workspace và nút nhận diện tự động.
- Hai consumer cũ được đưa thành adapter/capability, không copy toàn bộ form vào panel mới.
- Progressive disclosure cho AI/refine; giữ các control Xén vuông góc riêng.
- Feature flag hoặc compatibility switch để revert UI mà không revert backend.

**Gate:** click-smoke Tauri, picker/native drop, tab nền, page navigation, cancel/retry.

### Lô 3 - Output/recipe parity

- `keep_sheet`, `split_instances`, `png_zip` dùng cùng revision/fingerprint.
- Recipe record/playback và localStorage migration giữ key cũ.
- PDF/ZIP reopen, page boxes, output order, warning/error/cancel được hậu kiểm.

**Gate:** regression U0-01..U0-08, artifact parse/render, recipe playback.

### Lô 4 - Dọn compatibility sau nghiệm thu

Chỉ sau khi có runtime evidence mới cân nhắc bỏ selector/mode cũ. Route cũ và migration reader
được giữ ít nhất một vòng release; không xóa để “làm sạch” trước khi có rollback path.

## 7. Điều kiện thành công về UX

Không tuyên bố “thân thiện hơn” chỉ vì số nút giảm. Bản hợp nhất phải đạt:

- User mới không phải đoán file thuộc mode nào.
- File chỉ được inspect nhẹ khi chọn; AI chỉ chạy sau hành động rõ ràng.
- Một nút nhận diện trả mask và cảnh báo có thể hiểu được.
- Người dùng thấy rõ số tem, biên đang dùng và output intent.
- Đổi strategy không tự reset Offset, bù xén, crop, page order hoặc tab owner. Nếu nhận diện lại
  tạo mask mới, phải cảnh báo/xác nhận trước khi bỏ edits gắn với mask cũ; không âm thầm mất nét sửa.
- Preserved CutContour không bị raster hóa.
- Multi-instance không mất thứ tự, cardinality hoặc mask revision.
- Undo/redo/cancel/stale response không ghi ngược vào tab/session khác.
- Fallback khi mơ hồ phải giữ kết quả an toàn và cho biết bước tiếp theo.

## 8. Rủi ro và cách kiểm soát

| Rủi ro | Cách kiểm soát |
|---|---|
| Preserve vector bị raster hóa | `canPreserveExistingCut`, artifact page/content hash, adapter riêng |
| Split PDF/ZIP lệch page order | page map source↔working + expected manifest |
| Recipe multi chưa có vé commit | characterization playback trước UI migration |
| AI fallback nặng bất ngờ | `auto` deterministic trước; scheduler/RAM policy hiện hữu; warning/cancel |
| True-shape 11 điểm bị vẽ hở | metadata `closed/kind`, không phân loại theo length |
| UI mới ẩn thiết lập cũ | capability chỉ thu gọn; migration/read old localStorage |
| Revert hợp nhất thất bại | mỗi lô một commit, feature flag, giữ route/adapter cũ |

## 9. Các commit checkpoint hiện có

Các mốc source đã commit trước kế hoạch hợp nhất:

```text
4f914f4  Bù xén: bảo vệ thân tem và loại bóng mềm
59abcf1  Nesting: nối dấu canh CNC vào hợp đồng preview
8941dc0  Preview: đồng bộ parity Tem và CNC
1204abd  Auth: giảm trùng challenge và xử lý rate limit
64129a6  Nesting: tái dùng cache baseline trong autofill
```

Lô hợp nhất mới phải tạo commit riêng và không gộp vào các mốc trên. Rollback dùng `git revert`
theo commit; không dùng `reset --hard` trên worktree có thay đổi người dùng.

## 10. Các quyết định đã duyệt

Hướng triển khai đã được người dùng duyệt:

1. UI mặc định là **Nhận diện tự động**.
2. Sau khi nhận diện, user chọn **Giữ nguyên tấm** hoặc **Tách từng tem**.
3. `Bế tem nhãn` và `Xén vuông góc` vẫn là hai mục tiêu hình học riêng.
4. Advanced strategy được giữ trong “Nhận diện nâng cao”.
5. Characterization U0-01..U0-09 là tiêu chí kiểm chứng, không được xóa khoảng trống để ghi đạt.

Mục tiêu ban đầu là hoàn tất corpus Lô 0 trước khi đổi UI. Thực tế mới có coverage mapping và một
phần regression/artifact; quá trình triển khai đã tiếp tục nhưng không có nghĩa gate này hoàn tất.
Nhật ký và báo cáo characterization giữ nguyên giới hạn đó để nghiệm thu sau.

## 11. Tiến độ thực tế và các điều kiện còn mở

| Lô | Trạng thái code/bằng chứng | Phần chưa hoàn tất |
|---|---|---|
| 0 — Characterization | Đã lập ma trận; baseline và shadow A/B được giữ; U0-09 đã có metadata/test sửa riêng | Chưa có đủ corpus artifact đối chiếu hai adapter U0-01..08 |
| 1 — Canonical adapter | `ef9d025`, `38d6c2a`: khóa denoise/fingerprint/cache và lỗi stale 409 | Chưa chứng minh mọi kiểu nguồn dùng cùng geometry bằng artifact runtime |
| 2 — Workspace | `0c387f6` là shell ban đầu; `52964a2`, `4fbc9a0`, `15ea61d`, `7bc80a3`, `21015cd` hoàn thiện form/vòng đời/nhận file/bản dịch | Click-smoke Tauri, native drop, nhiều tab và điều hướng còn chờ môi trường đã kích hoạt |
| 3 — Output/recipe | Preference v2, output intent và runner unified-v2 có test; adapter/recipe cũ được giữ | Recipe mask edits/trang tùy biến chưa hỗ trợ; chưa record-save-playback thật và đối chiếu toàn bộ PDF/ZIP |
| 4 — Dọn compatibility | Chưa thực hiện, có chủ đích giữ đường quay lui | Chỉ xét sau nghiệm thu runtime và ít nhất một vòng release |

### Phạm vi bàn giao code

- Workspace chung mặc định, một form bù xén/đường cắt trước và sau nhận diện; không còn hai nút
  bắt người dùng đoán loại nguồn trước khi bắt đầu.
- Mục tiêu Xén vuông góc riêng và tùy chọn PDF nâng cao vẫn truy cập được. Chưa xóa writer/route
  cũ, chưa chuyển mọi capability PDF nâng cao sang mask engine.
- Nhận diện lại giữ source/settings, có cảnh báo bỏ edits; xuất chặn preview chưa sẵn sàng.
- Recipe mới nhận diện lại input của lần phát, dùng fingerprint preview, chặn kết quả cần review,
  hỗ trợ cancel và không giữ đường dẫn output thuộc session đã đóng.

### Mức kiểm chứng

Typecheck, ESLint phạm vi và `git diff --check` đạt; frontend **446 tests / 44 file** và backend
**240 tests** đạt. Đây là bằng chứng tĩnh/tự động, không thay cho thao tác người dùng trên Tauri.
Lần thử Vite dừng ở màn license và thiếu Tauri IPC; không vượt xác thực và đã dọn tab/server tự tạo.

Chưa build installer, push hay release. Khi cần rollback, chỉ revert nhóm commit hợp nhất đã liệt
kê ở nhật ký (theo thứ tự phụ thuộc); giữ checkpoint bóng A/B `4f914f4` và code nesting/auth riêng.

## 12. Bổ sung đã duyệt — custom PDF cùng giao diện

Người dùng yêu cầu bỏ thẻ tóm tắt, bộ đổi file và nhóm “Tùy chọn PDF nâng cao”; tự động và thủ công
phải là hai thao tác trong cùng workspace, không chuyển form. Phần này thay mục “PDF nâng cao vẫn
truy cập được” trong trạng thái lô trước; giữ route legacy nội bộ không đồng nghĩa giữ selector UI.

Đã triển khai các điểm nối cụ thể: lựa chọn object PDF → session/mask canonical → preview → writer
giữ artwork gốc; nhận diện lại theo revision của đúng trang; fence nguồn raw/working và overlay
canvas. Chi tiết bằng chứng, kiểm thử, commit và giới hạn tại
`BAO_CAO_AUDIT_BU_XEN_CUSTOM_PDF_2026-09-06.md` và `HOP_NHAT_BU_XEN_FIXES_2026-09-06.md`.

Không hạ tiêu chí an toàn để ghi hoàn tất: custom có CUT cũ chưa xác định được ownership và CUT
chỉ theo OCG chưa strip an toàn phải báo rõ, không xóa/nhân đôi dao; nghiệm thu Tauri còn mở.
