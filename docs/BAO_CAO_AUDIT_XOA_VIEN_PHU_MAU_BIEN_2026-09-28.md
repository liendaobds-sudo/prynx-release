# Audit xóa viền và phương án phủ viền bằng màu theo biên

Ngày: 2026-09-28. Baseline: `bc3d6d5b1761e5c5309eb589ec6eb58ac31b3f58` cùng working tree đang có thay đổi của phiên khác.

**Cập nhật sau duyệt “tiến hành đi”: lô A–E đã triển khai theo từng batch ≤5 file và verify tự động.** A sửa visible box; B sửa commit/revision; C thêm engine fill vector; D1 nối API + response echo; D2 nối parent fail-closed; E thêm lựa chọn UI/i18n. Bằng chứng hiện đạt SOURCE + AUTO + ARTIFACT; chưa nghiệm thu runtime Tauri/PDF khách/RIP. Các số đo baseline bên dưới được giữ để truy vết, không phải kết quả sau vá.

## 1. Kết luận điều hành

Engine đã có sẵn. Việc nâng cấp chủ yếu là nối kết quả dò biên với engine kéo màu và đường công bố working PDF, không phải viết một thuật toán xử lý ảnh mới.

Hiểu yêu cầu sản phẩm trong báo cáo này:

- **Xóa viền:** xén khổ trang theo phần nội dung; giữ hành vi hiện tại.
- **Phủ viền bằng màu theo biên:** giữ nguyên khổ trang, kích thước và vị trí artwork; chỉ thay vùng viền đã chọn bằng màu/nội dung kéo từ mép tương ứng. Không phải lấy một màu trung bình rồi đổ cả trang.

Có hai engine tái sử dụng đáng chú ý:

1. **Kéo dải mép bằng vector** ở `_rectangle_vector_bleed_commands`: phù hợp nhất làm hướng ưu tiên cho chế bản vì không chuyển CMYK/spot/ICC sang RGB. Cần adapter đặt/clip dải vào đúng viền trong khổ gốc.
2. **Kéo nền raster** ở `_edge_canvas`: đã có `image`, `trajectory`, `inpaint`, `mirror`, hỗ trợ bốn padding khác nhau. Hữu ích khi cần tiếp tục dải màu hoặc làm mượt, nhưng lớp nền mới là ICCBased sRGB, không tương đương bảo toàn toàn bộ dữ liệu màu in.

Không nên gọi nguyên chuỗi `auto-trim → resize về khổ cũ`: Resize tự căn giữa artwork, làm thay đổi vị trí, và đang có hai lỗi dependency được xác nhận dưới đây.

Phát hiện chính: **3 lỗi trong luồng xóa viền/commit** và **2 lỗi ở engine Resize dự kiến tái dùng**. Kiểm thử baseline hiện hữu xanh không bảo vệ các ca này.

## 2. Phạm vi và mức bằng chứng

- UI Viewer “Khử viền dư”, dữ liệu working PDF đã sắp/xoay trang, request, engine dò biên, PDF xuất, callback công bố và consumer kế tiếp.
- Resize/kéo nền và rectangle bleed chỉ được khảo sát như dependency phục vụ lựa chọn mới; không audit toàn bộ Sticker/Resize/màu.
- Đã đọc audit/fixes Resize 31/07, PageBox 04/08, Resize transparency 03/08 và master matrix. Không báo lại các lỗi xoay trang/threadpool đã sửa trong những đợt đó.
- Phát hiện UI đạt `AUTO`: callback trích trực tiếp từ AST source, store/hook/materialize thật, PDF bytes thật; HTTP/renderer được mock ở ranh giới I/O. **Không phải click-test GUI.**
- Hình học và dependency đạt `ARTIFACT`: tạo PDF tổng hợp, gọi engine đang chạy, parse lại, render PDFium/Poppler và đo pixel. Root tự chạy lại các probe quan trọng.
- Chưa thao tác trên Tauri/installer, chưa có PDF khách đại diện, chưa nghiệm thu RIP/bản in. Không nâng lên `RUNTIME`.

## 3. Đường chạy đã xác minh

### 3.1 Xóa viền

| Mắt xích | Bằng chứng hiện hành |
|---|---|
| Nút, phạm vi, cạnh và lề bổ sung | `desktop/src/components/AcrobatViewer.tsx:2910`; lề 0–20 mm, chọn trang hiện tại/toàn bộ, cạnh theo hướng đang xem |
| Chốt working PDF | `AcrobatViewer.tsx:384`; `useWorkingPdf.ts:93` materialize thứ tự/xoay/nhân bản trước upload; không phải dùng file gốc chưa sửa |
| Gửi request | `AcrobatViewer.tsx:445`; `pages` 1-based, `margin_mm`, `trim_sides` |
| Route thực và quyền | `backend/app/main.py:384` đăng ký router; `preflight.py:115` quyền `pdf.crop`; `preflight.py:1251` route; `schemas/preflight.py:383` schema |
| Điều phối | `preflight.py:1260` gọi `run_in_threadpool`; engine bọc PDFium theo từng thao tác, CV ngoài khóa |
| Detector | `page_boxes.py:342` đo viền màu phẳng theo từng cạnh; `:1626` render 200 DPI vật lý; `:1645` gọi detector |
| Writer | `page_boxes.py:1690` đổi bbox pixel sang tọa độ trang; `:1701` thay MediaBox/CropBox, bỏ box phụ; `:1719` lưu file mới sau khi đủ điều kiện mọi trang |
| Download/công bố | `AcrobatViewer.tsx:472` download kết quả rồi `onEditCommit`; prop nối vào `ImpositionTab.tsx:4518`, callback thật ở `:2151` |
| Consumer | `usePdfLoader.ts:380`, `AcrobatViewer.tsx:2694`, `useWorkingPdf.ts:93` và đường Save `ImpositionTab.tsx:3707` |

**Hành vi có chủ đích, không coi là bug:** detector hiện bỏ được viền màu phẳng, không chỉ trắng. `trim_sides` tường minh là yêu cầu xén đủ các cạnh đó trên mọi trang; thiếu một cạnh thì dừng không xuất artifact. Legacy `None` vẫn tự dò/bỏ qua trang mơ hồ. Rail mảnh sát mép bị bỏ trong explicit mode là quyết định `TRIM.FORCE`, đã có regression. Xén bằng page box không phải xóa/redact toán tử nội dung khỏi PDF.

### 3.2 Engine phủ màu

| Thành phần | Khả năng thật và giới hạn |
|---|---|
| `sticker_engine.py:8209` `_rectangle_vector_bleed_commands` | Dùng Form XObject cho dải cạnh/góc, không lọc trắng và không đổi màu sang RGB. Tách `sample_inset_pts` khỏi `edge_bite_pts`. Nhận bleed scalar + sides, không nhận bốn độ rộng độc lập. |
| Consumer vector thật | `pdf_tools.py:1476` → `StickerEngine.process_pdf` → `sticker_engine.py:11212` → writer `:11598`, lưu `:11901`. Nhánh rectangle/image đang dùng thật, không phải code chết. |
| `resize_background_engine.py:181` `_edge_canvas` | `image` kéo pixel biên; `trajectory` giữ hướng dải màu; `inpaint` làm mượt; `mirror` phản chiếu. `pads=(left,right,bottom,top)` đã có. |
| `sticker_engine.py:7792,7877` | Hai hàm rectangle smooth/trajectory được `_edge_canvas` gọi trực tiếp. |
| `resize_background_engine.py:257` `_add_background_image` | Sinh RGB + SMask, nhúng sRGB, lớp nền dưới Form và lớp cleanup gần mép phía trên; không raster hóa toàn artwork. |
| Consumer Resize thật | `PageResizerTool.tsx:27` → `processHandlers.ts:1064` → `api.ts:1422` → `pdf_tools.py:853` → `pdf_tools_engine.py:692` → `resize_pages_with_background`, save `:814`. |
| `page_boxes.py:1795` `add_mirror_bleed` | Giữ vector nhưng chủ ý nới khổ quanh vùng trim; không phải phủ viền bên trong trang. |

Hai mode cùng tên `image` trong Resize và Sticker **không đồng nghĩa về pipeline màu**. Không dùng câu “giữ nguyên CMYK/spot” để mô tả lớp nền raster của Resize.

## 4. Bảng phát hiện đã xác nhận

| Mã | Mức / effort | Phạm vi | Kết luận |
|---|---|---|---|
| §WBR28.01 | P1 / M | Xóa viền | CropBox vượt MediaBox bị ánh xạ sai, vừa cắt vào artwork vừa còn trắng. |
| §WBR28.02 | P1 / M | Công bố kết quả | **Đã sửa lô B:** working revision mới, reload metadata, không double-bake; còn thiếu runtime GUI/native. |
| §WBR28.03 | P1 / S–M | Tác vụ bất đồng bộ | **Đã sửa lô B:** lease/revision CAS trước publish, chặn tab đóng/recording/stale; còn thiếu runtime GUI/native. |
| §WBR28.04 | P2 / S | Dependency Resize | Import helper cũ bị nuốt lỗi, OutputIntent không sang PDF kết quả. Chưa đo sai lệch màu in. |
| §WBR28.05 | P1 / M | Dependency Resize | UserUnit làm hình học mask khác Form; cleanup phủ mất artwork trong ca `/UserUnit=2`, `/Rotate=90`. |

### §WBR28.01 — `[CONFIRMED]` Sai hệ quy chiếu vùng nhìn thấy

**Trạng thái sau lô A: FIXED ở SOURCE + AUTO + ARTIFACT; RUNTIME pending.** `auto_trim` đã dùng bbox hữu hiệu từ chính renderer. Poppler ở cả bốn rotation: giữ đủ 5.120 pixel marker, trắng còn 0,5188%, giống pixel control. Bằng chứng lỗi phía dưới là lịch sử trước sửa; chi tiết verify ở nhật ký.

**Sink/consumer:** `page_boxes.py:1618` lấy CropBox raw làm hệ quy chiếu; PDFium thực tế render giao CropBox/MediaBox; `:1690` dùng hệ quy chiếu sai để đổi pixel; `:1701` ghi box mà Viewer/RIP đọc.

Hai PDF đối chứng có MediaBox `[0,0,200,100]`, cùng artwork `[40,10,160,90]` và một dải xanh rộng 4 pt ở mép trái. CropBox lần lượt `[20,0,200,100]` và `[20,-10,220,110]`. Poppler render nguồn hai file **giống pixel hoàn toàn**.

Sau xóa đủ bốn cạnh, rotation 0:

- Đối chứng: box `[39.8,10.071942,160.04,90.28777]`; dải xanh 5.120 pixel; trắng 0,5188% (AA/độ phân giải dò).
- Crop vượt Media: box `[42,2.086331,175.6,98.345324]`; dải xanh còn 2.560 pixel, **mất 50%**; trắng **26,8607%**.
- Tái hiện ở cả 0/90/180/270 độ; không suy quy ước trục chỉ bằng công thức.

Bằng chứng: [JSON](audit/WHITE_BORDER_2026-09-28/auto_trim_evidence.json), [ảnh đối chứng](audit/WHITE_BORDER_2026-09-28/auto_trim_comparison.png), [probe](audit/WHITE_BORDER_2026-09-28/probe_auto_trim.py).

Đề xuất: detector và phép đổi pixel phải dùng **cùng visible box hữu hiệu** với renderer; validate giao rỗng, rotation/UserUnit và origin. Không chỉ clamp box đầu ra vì nội dung đã bị định vị sai trước đó.

### §WBR28.02 — `[CONFIRMED → FIXED AUTO]` Sai loại commit sau xóa viền

**Đường chạy:** `AcrobatViewer.tsx:391` bake working PDF → `:474` gọi `onEditCommit` → `ImpositionTab.tsx:2209` gắn `__editCommit=true`, `:2242` giữ order/rotation.

**Consumer thật:** `usePdfLoader.ts:380` return trước nạp metadata; `AcrobatViewer.tsx:2694` còn dùng dimensions/rotation cũ; `useWorkingPdf.ts:172` tiếp tục đọc order, `:190` copy trang và cộng rotation. `setFile` không tự reset các state này.

Probe chạy callback/hook thật xác nhận hai biểu hiện của cùng một nguyên nhân:

1. PDF kết quả 160×60 pt nhưng Viewer giữ `266,6667×133,3333 px`, tức metadata nguồn 200×100 pt ở 96 DPI; loader không nạp lần hai.
2. Nguồn đã bake order `[3,1,1]`, rotation `[90,0,180]`. Commit không xóa state đã bake; lần materialize kế tiếp biến nhãn trang `[3,1,1]` thành `[1,3,3]`, rotation thành `[270,90,270]`.

Đề xuất: dùng đường công bố **working revision mới có thay geometry**, không gắn cờ object-edit. Reset đúng state đã bake và reload metadata; giữ Undo/tab ownership. Đường sẵn có `commitWorkingFile` (`ImpositionTab.tsx:1503`, reset tại `:1682`) là nền tảng cần nối đúng, không sửa semantics object-edit cho mọi caller.

### §WBR28.03 — `[CONFIRMED → FIXED AUTO]` Kết quả cũ thay nhầm revision mới

**Sink:** `AcrobatViewer.tsx:445` giữ closure nguồn, chờ upload/HTTP/download, rồi gọi commit mà không kiểm revision. `ImpositionTab.tsx:2224` publish `setFile` không kiểm nguồn của job. `autoTrimBusy` chỉ disable nút khử viền/Áp dụng, không khóa toàn tài liệu.

Probe trì hoãn response, đổi store sang `newer.pdf` 500×400 pt, rồi trả kết quả job cũ: file cuối trở thành `trimmed.pdf` 160×60 pt. Đây là thay working document trong app, **không phải đã chứng minh ghi đè file gốc trên ổ đĩa**.

Đề xuất: capture revision sau preparation barrier, dùng xuyên download và kiểm ngay trước publish; response cũ bị bỏ, không tạo Undo snapshot sai. Cơ chế sẵn có: `commitWorkingFile` nhận `expectedDocumentRevision`, kiểm ở `ImpositionTab.tsx:1517`; không cần phát minh cờ boolean toàn cục.

### §WBR28.04 — `[CONFIRMED]` Rơi OutputIntent trong dependency

**Sink:** `resize_background_engine.py:504` import `_copy_output_intents`; `sticker_engine.py:41` hiện chỉ có `copy_output_intents`; `except Exception: pass` tại `:507` nuốt lỗi. Hàm thật ở `pdf_ops.py:43` đã có hợp đồng sao chép profile.

Public caller `resize_pages_smart` xuất 6 artifact, nguồn đều có một OutputIntent, kết quả đều không có. Đã parse PDF thật; **chỉ kết luận mất metadata**, không suy ra một mức ΔE hay sai màu trên mọi PDF. Vector rectangle engine là đường khác và có test bảo vệ OutputIntent.

Đề xuất: import đúng helper, test profile bytes/hash xuyên writer. Không lấy pipeline này nguyên trạng làm nền cho tính năng mới.

### §WBR28.05 — `[CONFIRMED]` Mask cleanup phủ mất nội dung khi có UserUnit

**Đường chạy:** `resize_background_engine.py:582` lấy kích thước raw sau crop → `:626` tính placement → `:651` tính raster/mask theo số raw; Form tại `:768` lại mang `/Matrix=[2,0,0,2,0,0]` từ `/UserUnit=2`; overlay tại `:775` vì thế che vùng artwork thật.

Fixture `UserUnit=2`, `Rotate=90`, `center_no_scale`, `image`: marker xanh có trong nguồn, biến mất sau pipeline. Bản sao diagnostic bỏ **duy nhất stream cleanup cuối** làm marker hiện lại tại `[155.25,249.75,175.25,269.75] pt` trong PDFium. Poppler độc lập: marker source/output/no-cleanup lần lượt 1.600/0/6.400 pixel.

Poppler build dùng ở probe không áp UserUnit nguồn, nên chỉ dùng đối chứng đó để xác nhận tồn tại marker, không so tỷ lệ vật lý hai ảnh nguồn/kết quả. Không kết luận sai rằng artwork luôn bị thu nhỏ 2×: Form đã tự mang hệ số 2.

Đề xuất: thống nhất đơn vị vật lý giữa geometry, mask, Form và placement. **Bỏ cleanup không phải bản sửa**; nó chỉ là control chẩn đoán, còn cleanup đang bảo vệ seam ở các ca khác.

Bằng chứng chung dependency: [probe](audit/WHITE_BORDER_2026-09-28/probe_resize_reuse.py), [JSON root chạy lại](audit/WHITE_BORDER_2026-09-28/resize_reuse_evidence.json), PDF/PNG nhỏ trong `audit/WHITE_BORDER_2026-09-28/resize_reuse_artifacts/`.

## 4.1. Trạng thái triển khai sau khi user duyệt

### Engine và API

- `PageBoxesEngine.auto_trim` nhận `mode="trim"|"fill"`; trim là mặc định tương thích. Fill giữ nguyên Media/Crop/Trim/Bleed/ArtBox, `/Rotate`, `/UserUnit`, annotation, OutputIntent và vị trí/tỷ lệ artwork; chỉ thêm các Form/vector dải màu vào viền đã dò.
- Helper vector nhận bốn độ rộng `(left, right, bottom, top)` nhưng nhánh scalar và consumer Sticker cũ giữ nguyên. Adapter dùng point vật lý, clip even-odd bảo vệ bbox nội dung, `q/Q` cô lập CTM/clip nguồn và fixed-point `.16f` để PDF không sinh số mũ.
- Fill fail-closed với `margin_mm != 0`, mode lạ, trang/cạnh thiếu, và trang có transparency/Pattern theo bộ dò tài nguyên hiện hữu (bảo thủ). Không raster/flatten ngầm, không tự chuyển sang trim; chỉ ghi output sau khi mọi trang/cạnh đạt.
- Schema `AutoTrimRequest.mode` mặc định `trim`; route trả `AutoTrimResponse` bắt buộc echo mode. ValueError nghiệp vụ → 422; 404/500 giữ hợp đồng. Quyền Free vẫn là `pdf.crop`.

### Parent và UI

- Parent gửi `mode`, kiểm echo trước download/commit (fill bắt buộc `fill`; trim chấp nhận sidecar cũ thiếu echo nhưng từ chối echo trái ngược), giữ lease/revision/Undo/recording guards của lô B.
- Viewer có hai lựa chọn **Xóa viền** và **Phủ màu theo biên**; fill ẩn lề bổ sung và gửi `margin_mm=0`, giữ phạm vi tất cả/trang hiện tại và các cạnh đã chọn. Các control khóa khi đang xử lý; copy VI/EN nói rõ fill giữ khổ/vị trí và trang transparency/Pattern chưa hỗ trợ.

### Verify sau triển khai

- Lô C: **232 passed** (85 ca mới + 147 cũ), gồm 6 regression số PDF exponent; 1 warning Pydantic có sẵn. 600 DPI fixture: overlap adapter giảm lệch PDFium 6.851→5.373, Poppler 4.964→3.936; lõi artwork pixel-identical, halo ≤1px/quantization còn được ghi rõ.
- Lô D1: **79 test API/hợp đồng passed**, gồm POST→download PDF thật, fill/trim/Free/atomic/422/404/500 và response-model exact.
- Lô D2 + E: **144 test frontend phạm vi passed** (13 file, gồm 36 regression parent + DOM AST popup + i18n catalog), `npm run typecheck` exit 0.
- Chưa chạy Tauri runtime, installer, PDF khách đại diện, RIP/bản in; vì vậy trạng thái chưa nâng lên RUNTIME.

## 5. Những điều không gắn thành bug mới

- `[EXPECTED]` Resize tự căn giữa: cùng khổ 200×160 pt, marker `[30,40,40,50]` thành `[80.25,65,90.25,75]` với image/trajectory/inpaint. Đúng chức năng Resize, sai nếu dùng nguyên cho yêu cầu giữ vị trí khi phủ viền.
- `[EXPECTED]` Xóa viền thay MediaBox/CropBox và bỏ box phụ. Mode phủ viền mới phải có policy riêng: giữ các box đang có, không thừa kế chính sách xóa viền.
- `[SUSPECTED]` API `pages=[1,1]` có khả năng xén lặp do renderer giữ nguồn nhưng pikepdf doc đã đổi; UI hiện không sinh danh sách trùng. Chưa chạy probe riêng, không xếp severity.
- `[PROOF GAP]` Corpus barcode/hairline/artwork trắng có chủ đích, nhiều mức pastel/noise, Alpha/OCG/annotation/overprint/spot chưa đủ để khẳng định mọi tài liệu an toàn. Không tự coi mọi mảng trắng/alpha là viền thừa.
- Các lỗi cũ về `/Rotate` trong mirror và event loop ở route auto-trim đã được sửa; baseline hiện hành không tái hiện chúng.

## 6. Phương án ghép tính năng đề xuất

### Giao diện

Giữ một cửa sổ “Xử lý viền”, hai lựa chọn rõ ràng:

| Lựa chọn | Hành vi |
|---|---|
| Xóa viền | Thu khổ trang theo biên dò được; giữ ô “Lề bổ sung”. |
| Phủ viền theo màu biên | Giữ khổ và artwork đúng vị trí; chỉ phủ viền/cạnh đã chọn. Không ngầm dùng “Lề bổ sung” như độ lẹm vào artwork. |

Dùng chung phạm vi trang và bốn cạnh. Hướng tối giản: mode phủ mặc định kéo dải mép (`image`, ưu tiên đường vector), chưa cần bày thêm toàn bộ công cụ Resize. Nếu cần trajectory/inpaint thì hiện lựa chọn nâng cao có mô tả đúng khác biệt về màu/độ mượt. Có preview vùng sẽ thay và cảnh báo không dò được biên; không tự chuyển sang xén khi phủ thất bại.

### Hợp đồng xử lý

1. Chốt **một working revision** đã bake; cùng revision cho dò biên, xử lý và publish.
2. Dùng chung detector viền màu phẳng của auto-trim. Không thay detector bằng `_find_nonwhite_content_bbox` của Resize rồi làm hai lựa chọn hiểu khác nhau về “viền”.
3. Với từng trang lưu visible box hữu hiệu, box gốc, rotation/UserUnit, bbox nội dung và các cạnh được xác nhận. Đổi mm/pt/raw một lần ở biên thích hợp.
4. Nhánh xóa dùng bbox để thu khổ. Nhánh phủ tính bốn vùng viền, giữ nguyên transform/artwork và box gốc; không center, fit, stretch toàn trang, không lấy trang đầu đại diện.
5. Reuse helper vector để kéo dải cạnh/góc với clip đích. Helper hiện scalar bleed nên adapter phải xử lý viền bất đối xứng bằng đặt/clip từng vùng hoặc mở rộng padding có regression. Không cần viết lại thuật toán kéo màu.
6. Nhánh raster nâng cao mới dùng `_edge_canvas` + SMask, giữ khác biệt RGB/CMYK minh bạch. Lấy mẫu sâu 0,5 mm có sẵn không được biến thành cắt mất artwork. Mask chỉ phủ phần viền được yêu cầu.
7. Một request backend; không vòng download/upload giữa auto-trim, bleed và resize. Giữ cùng quyền `pdf.crop` nếu đây là cùng công cụ; chốt lại nếu sản phẩm muốn phân quyền khác, không mặc nhiên đổi gate sang quyền Resize/Sticker.
8. Hợp đồng API tương thích ngược đã triển khai: thêm `mode="trim"|"fill"` mặc định `trim`, cùng `pages/trim_sides`. Response echo mode bắt buộc để client không nhầm sidecar cũ; client/recipe cũ không đổi kết quả.
9. Output giữ vector, OutputIntent và tài nguyên cần thiết; với mode phủ bảo toàn page boxes/annotation/OCG theo policy đã kiểm. Fail-closed, chỉ publish sau kiểm revision; không sửa đè PDF nguồn.

### Lô triển khai sau khi duyệt

| Lô | Nội dung | Quy mô/verify |
|---|---|---|
| A | Sửa visible box §WBR28.01 | **Đã verify:** core + 59 regression mới, tổng 259 backend. |
| B | Sửa loại commit và stale publish §WBR28.02–03 | **Đã verify:** Viewer/ImpositionTab + 26 regression mới, mở rộng 12 file/137 test. |
| C | Gia cố dependency dùng lại | **Đã verify:** vector fill + 85 regression mới, tổng 232 test; Resize §04–05 vẫn backlog. |
| D1/D2 | Adapter backend + parent hai hành động | **Đã verify:** API 79 test; echo fail-closed và lease/revision parent. |
| E | UI lựa chọn, i18n, tests | **Đã verify:** Viewer selector, hint, margin=0 khi fill, 36 test parent/DOM và catalog. |
| F | Nghiệm thu trên PDF khách/app | Khổ/vị trí, màu, mixed pages, undo/retry, đổi file/tab giữa tác vụ, bản cài đặt nếu cần release. |

Quick-win: sửa tên helper profile là nhỏ; ưu tiên cao hơn về an toàn là commit/revision và hệ tọa độ trước khi bật lựa chọn mới. Không refactor cả god file, không build/release hoặc đổi worker/RAM trong đợt này.

## 7. Kiểm thử và cách tái chạy

Baseline backend, cwd `backend`:

```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_page_boxes_autotrim.py tests/test_mirror_bleed_origin.py tests/test_page_crop_regions.py tests/test_resize_edge_background.py
```

Kết quả: **136 passed**, 1 warning Pydantic cũ, 9,64 giây.

Baseline bổ sung cho chính engine kéo dải vector và nền theo quỹ đạo, cwd `backend`:

```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_engine_e2e.py -k 'rectangle_vector_bleed or rectangle_bleed_uses_visible_size_after_page_rotation or sample_inset'
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_trajectory_bleed.py
```

Lần lượt **8 passed / 150 deselected** và **24 passed**, mỗi lệnh có 1 warning Pydantic cũ. Ca uneven pads trái/phải/dưới/trên `10/0/5/20` giữ lõi nguyên pixel. Tổng baseline backend **168 tests đạt**, không cộng rerun.

Baseline frontend, cwd `desktop`, Windows thật:

```powershell
npx vitest run src/hooks/useWorkingPdf.test.tsx src/hooks/viewer/usePdfLoader.test.tsx src/components/preprocess-tools/PageResizerTool.test.ts src/lib/processHandlers.test.ts
```

Kết quả: **4 file / 122 tests passed**, 5,50 giây.

Tổng baseline hiện hữu trong phạm vi: **290 tests đạt** (168 backend + 122 frontend). Các probe lỗi bên dưới được ghi riêng, không dùng tổng test xanh để tuyên bố tính năng không còn lỗi.

Probe UI riêng, không thay tests production:

```powershell
npx vitest run --config ../docs/audit/WHITE_BORDER_2026-09-28/ui_contract_probe.config.mts
```

**3/3 probe tái hiện thành công các lỗi hiện tại**; không phải “ba lỗi đã được sửa”. Root chạy lại và đạt cùng assertion.

[Kết quả probe UI và SHA-256 source hiện hành](audit/WHITE_BORDER_2026-09-28/ui_contract_evidence.json).

Probe artifact đã chạy ở baseline, cwd `backend` (sau sửa phải dùng thư mục kết quả khác, không ghi đè JSON/PNG lịch sử bằng các lệnh này):

```powershell
.\venv\Scripts\python.exe -B ..\docs\audit\WHITE_BORDER_2026-09-28\probe_auto_trim.py
.\venv\Scripts\python.exe -B ..\docs\audit\WHITE_BORDER_2026-09-28\probe_resize_reuse.py --poppler 'C:\Users\Khanh Pham\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe'
```

Auto-trim: 8 ca/4 rotation, nguồn đối chứng pixel-identical. Resize: 6 ca + control bỏ overlay và Poppler; không tính rerun thành ca mới. Đã soi PNG. Script dùng dữ liệu tổng hợp, không sửa PDF người dùng.

Không chạy full suite/typecheck toàn dirty tree, không cập nhật golden, không build/native/release, không commit. Các thay đổi có sẵn của user/phiên khác được giữ nguyên.

## 8. Thẻ audit unit / cập nhật ma trận

| Unit | Hợp đồng và ca biên | Bằng chứng | Còn thiếu / bước tiếp |
|---|---|---|---|
| `W3-WBR28-TRIM` | UI → route → detector → box writer → PDF → renderer; mm/raw/visible box, 4 rotation | Lô A §01 đã sửa `SOURCE + AUTO + ARTIFACT`; 59 regression mới, tổng 259 backend đạt; pixel Poppler khớp control | Chờ xác nhận runtime; PDF khách/Tauri, chưa đóng toàn luồng UI |
| `W6-WBR28-COMMIT` | Working revision → output → state/loader/materialize/Save; order/rotation/khổ/CAS | `AUTO`, §02–03 đã sửa; 26 regression mới, 137 test frontend liên quan | Runtime click-test Tauri, metadata renderer/native và OCG Undo toàn hệ thống |
| `W3-WBR28-FILL-DEPENDENCY` | UI Resize → public engine → mask/Form/profile → PDF mở lại | `ARTIFACT`, §04–05 mở; recenter là EXPECTED | Gia cố hoặc tránh nhánh lỗi; test CMYK/spot/alpha và bất đối xứng |
| `W3-WBR28-FILL-NEW` | Lựa chọn phủ viền giữ khổ/vị trí | `AUTO + ARTIFACT-PARTIAL`: engine/API/parent/UI đã nối; 232 backend + 144 frontend phạm vi | PDF khách, Tauri runtime, RIP; transparency/Pattern vẫn fail-closed và seam AA còn giới hạn |

Ma trận chung được bổ sung unit riêng, không nâng toàn bộ `W3-U01 Resize + Crop` khỏi `STALE` chỉ vì các test hẹp đã xanh.

## 9. Chốt duyệt

Chốt ban đầu đã được user duyệt bằng “tiến hành đi”; các lô A–E đã triển khai và verify tự động. Còn cổng nghiệm thu runtime: mở app Tauri, thử PDF khách có rotation/UserUnit/CMYK/spot và mixed pages, kiểm Undo/đổi tab/hủy, rồi kiểm RIP/bản in nếu cần. Không coi tổng test tự động là bằng chứng runtime.
