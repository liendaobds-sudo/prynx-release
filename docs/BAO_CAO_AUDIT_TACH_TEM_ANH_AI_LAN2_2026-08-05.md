# Báo cáo audit Tách tem từ ảnh AI - lần 2 - 2026-08-05

## 1. Phạm vi và kết luận điều hành

Audit đúng sáu phản ánh runtime của người dùng trong luồng:

`Mở ảnh -> Bù xén - Tạo đường cắt -> Ảnh AI nhiều tem -> sửa mask -> xuất PDF CutContour`.

Đã trace từ UI/store/worker qua API, session, engine mask, writer PNG/PDF và mở lại
artifact thật. Sáu phản ánh đều có nguyên nhân trên đường chạy live. Ngoài ra, lượt tái hiện
trên ảnh người dùng còn xác nhận một lỗi rớt GPU -> CPU có thể làm tác vụ thất bại khi thiếu RAM.

| Mã | Mức | Trạng thái | Kết luận |
|---|---:|---|---|
| §AI2.UI1 | P2 | `[CONFIRMED]` | UI lộ tên model, thư viện xử lý và thời gian từng tầng |
| §AI2.VIEW1 | P1 | `[CONFIRMED]` | Workspace không có hand/pan; canvas luôn chiếm chuột cho cọ/gộp |
| §AI2.COLOR1 | P1 | `[CONFIRMED]` | Overlay tô màu cả lòng tem; RGB preview còn lấy từ kết quả tách nền thay vì RGB nguồn |
| §AI2.SIZE1 | P0 | `[CONFIRMED]` | Ảnh không DPI đổi từ quy ước 72 DPI của cửa mở file sang 300 DPI khi xuất AI, làm nhỏ 4,1667 lần |
| §AI2.CUT1 | P1 | `[CONFIRMED]` | Contour phức tạp có thể fallback hoàn toàn về polyline; chưa có cơ chế giữ góc lõm nhọn theo đoạn |
| §AI2.ROUTE1 | P1 | `[CONFIRMED]` | Ảnh nguồn bị đổi thành PDF rồi không được truyền tới chế độ AI, nên phải chọn lại |
| §AI2.RUNTIME1 | P1 | `[CONFIRMED]` | Khi DirectML OOM, code tạo session CPU trước khi giải phóng session GPU; đã tái hiện `bad allocation` |

Không build installer, không phát hành và không sửa mã production trong giai đoạn audit này.

## 2. Đường chạy đã truy vết

### 2.1 Entry và state

1. Ảnh mở từ App đi vào `ImpositionTab.initialFile`.
2. `ImpositionTab.tsx:455-502` gọi `imageFileToPdfIfNeeded()` rồi chỉ giữ file PDF trong
   workspace; ảnh nguồn không có state riêng.
3. `ImpositionTab.tsx:2911-2933` mount `ImposerDashboard` nhưng không truyền ảnh nguồn.
4. `ImposerDashboard.tsx:1488-1497` chỉ truyền `pdfFile` tới `PreprocessingRouter`.
5. `PreprocessingRouter.tsx:253-262` chỉ truyền PDF tới `StickerCutlineTool`.
6. `StickerCutlineTool.tsx:85-94` đổi sang `StickerSheetPanel`; panel chỉ biết
   `state.sourceFile`, nên tab đang mở ảnh vẫn phải chọn lại.

### 2.2 Analyze và preview

1. `StickerSheetPanel.tsx:40-45` warmup model khi panel mount.
2. `stickerSheetStore.ts:159-213` gửi ảnh, lấy preview/labels/uncertainty và lưu object URL
   theo tab.
3. `sticker_sheet.py:136-160` chạy analyze qua heavy-job scheduler và tạo session trên đĩa.
4. `sticker_sheet_engine.py:221-245` lấy cả RGBA từ kết quả tách nền, sau đó chỉ thay Alpha.
5. `sticker_sheet_session.py:135-160` dùng RGBA đó làm `preview.png`.
6. `StickerSheetWorkspace.tsx:286-296` chồng overlay worker lên preview.

### 2.3 Export và artifact

1. `stickerSheetStore.ts:233-249` gửi edit, DPI, offset và bleed.
2. `sticker_sheet_export.py:83-107` dựng RGBA; `:110-140` crop từng instance.
3. `_extract_stickers()` thêm padding cố định 3 px, không theo mm/DPI.
4. `_png_pages_to_pdf()` dùng DPI request để quy pixel thành point.
5. `sticker_sheet_export.py:226-246` gọi nhánh Alpha đã audit của `StickerEngine`.
6. Artifact thật được mở lại bằng pikepdf và render lại ở 300 DPI.

## 3. Bằng chứng theo phản ánh

### §AI2.UI1 - lộ chi tiết triển khai

- `StickerSheetWorkspace.tsx:253` hiển thị “đang nạp mô hình AI”.
- `StickerSheetPanel.tsx:100-102` hiển thị trực tiếp `BiRefNet-lite`, `OpenCV` và thời gian.
- Test UI hiện không có oracle cấm tên model/thư viện xuất hiện.

Yêu cầu UI đã chốt: trạng thái dùng “Đang khởi động engine...” theo yêu cầu người dùng;
không hiển thị tên model, thuật toán, thư viện, tầng xử lý hoặc số đo kỹ thuật.

### §AI2.VIEW1 - thao tác view và thao tác mask bị trộn

- `StickerSheetWorkspace.tsx:157-205`: pointer trái luôn là cọ hoặc gộp.
- `:207-211`: chỉ Ctrl+wheel mới zoom.
- Không có hand tool, Space+drag, middle-drag, pan state hoặc hint phân biệt thao tác.
- Canvas `touch-none cursor-crosshair` ở `:287-296` nằm trên cùng và nhận toàn bộ pointer.

Hướng sửa: tách rõ **Di chuyển** và **Sửa vùng tem**. Space tạm thời chuyển sang hand;
chuột giữa luôn pan; khi hand đang hoạt động tuyệt đối không sinh stroke/merge. Pan/zoom không
gọi backend và không đưa bitmap vào React state.

### §AI2.COLOR1 - preview bị ám màu

- `stickerMaskProtocol.ts:141-145` tô màu instance cả phần trong với Alpha 42 khi chọn và 18
  khi không chọn, tương đương phủ màu khoảng 16,5% và 7,1% lên artwork.
- `sticker_sheet_engine.py:230-245` giữ RGB do model trả về thay vì RGB nguồn đã chuẩn hóa.
- `sticker_sheet_session.py:135-150` ghi RGB đó thành preview.

Vì vậy PDF có thể trông đúng hơn preview, trong khi view bị đổi màu. Hướng sửa là overlay chỉ
vẽ biên/cảnh báo, lòng tem trong suốt hoàn toàn; RGBA production lấy RGB nguồn, model chỉ cung
cấp Alpha.

### §AI2.SIZE1 - sai kích thước vật lý

Hai nguồn chân lý đang mâu thuẫn:

- `imageNormalizer.ts:imagePagePoints()` dùng **72 DPI** khi ảnh không có metadata DPI để giữ
  hành vi mở ảnh hiện tại.
- `stickerSheetStore.ts:102` và cảnh báo UI dùng **300 DPI** mặc định khi cùng ảnh đó đi qua
  chế độ AI.

Đo ảnh mẫu 1313x1198 px, không DPI:

| Luồng | Kích thước vật lý |
|---|---:|
| Mở ảnh bình thường, mặc định 72 DPI | 463,197 x 422,628 mm |
| Chế độ AI, mặc định 300 DPI | 111,167 x 101,431 mm |

Tỷ lệ sai là `300 / 72 = 4,1667`. Ngoài ra:

- `stickerSheetStore.ts:208` chỉ lấy `dpi[0]`, bỏ `dpi[1]`; ảnh DPI X/Y khác nhau sẽ sai chiều cao.
- `sticker_sheet_export.py:118` dùng padding 3 px; padding vật lý thay đổi theo DPI.

Nghi vấn “`StickerEngine(dpi=300)` làm sai scale” đã được `[DISPROVED]`: tại điểm đó PNG đã
được đặt lên trang PDF bằng point; 300 chỉ là độ phân giải raster nội bộ của engine.

Hướng sửa: kích thước mm của tài liệu đang mở là nguồn chân lý. Ảnh không DPI dùng cùng quy
ước 72 DPI hiện hành; DPI X/Y được giữ độc lập; padding chuyển sang mm rồi mới đổi sang pixel.

### §AI2.CUT1 - răng cưa, nhiều node và mất góc lõm nhọn

Artifact 9 tem hiện tại `tmp/research/sticker_sheet_e2e_9.pdf`:

- trang 1: 152 cubic; trang 9: 162 cubic;
- không có line fallback trên hai trang này, nhưng mật độ cubic vẫn cao.

Ảnh chụp hình sao người dùng cung cấp cho thấy yêu cầu vừa làm mượt vùng cong, vừa giữ đỉnh và
góc lõm. Nhánh Alpha hiện tại fit cả ring như một đường cong liên tục. Khi guard không chấp nhận
candidate, nó fallback toàn ring về polyline; không có phân đoạn “corner -> line/điểm neo” và
“smooth span -> cubic”. Lượt probe từ ảnh chụp màn hình đã cho 296 line, 0 cubic; ảnh này chỉ là
ảnh chụp có overlay nên không dùng để đánh giá chất lượng nhận diện, nhưng xác nhận được nhánh
fallback polyline là reachable.

Hướng sửa an toàn: phát hiện corner theo góc quay + độ dài vật lý, khóa cả corner lồi và lõm làm
điểm neo, fit Bézier riêng từng span trơn, rồi chạy lại topology/Hausdorff/safe-envelope. Không
tăng `simplify` chung vì sẽ cắt mất notch và góc lõm hình sao.

### §AI2.ROUTE1 - file đang mở không được tái sử dụng

Ảnh nguồn vẫn tồn tại trong `initialFile`, nhưng `ImpositionTab` đổi biến cục bộ thành PDF và
không truyền nguồn qua `ImposerDashboardProps`. Đây là mất hợp đồng state, không phải giới hạn
backend: `stickerSheetApi.ts:93-98` đã hỗ trợ gửi thẳng native path của ảnh.

Hướng sửa: giữ `sourceImageFile` theo tab trước khi normalize; truyền xuyên 5 file tới
`StickerCutlineTool`; khi đổi sang Ảnh AI và state chưa analyze, tự dùng ảnh đang mở. Tab nền và
file đã thay không được nhận nhầm nguồn.

### §AI2.RUNTIME1 - fallback GPU -> CPU giữ đồng thời hai session

Tái hiện trên máy thật với ảnh người dùng:

1. DirectML lỗi `8007000E Not enough memory resources`.
2. `_switch_to_cpu()` trong `birefnet_engine.py:101-109` gọi `_create_session(CPU)` trước khi
   thay/xóa session GPU trong `_sessions`.
3. CPU load tiếp tục thất bại `bad allocation`.

Hướng sửa: tách session GPU khỏi cache, đóng/giải phóng tham chiếu và thu gom tài nguyên trước
khi tạo CPU session; khóa regression bằng fake session có theo dõi `close`/lifecycle. Đây là
stability fix, không thêm cap cho máy mạnh.

## 4. Khoảng trống test hiện tại

- Không có component test cho Space/middle pan, hand-vs-mask và tab nền.
- Overlay test chỉ yêu cầu Alpha > 0 trong lòng tem, vô tình khóa chính hành vi ám màu.
- Không có test parity kích thước giữa mở ảnh bình thường và export AI cho ảnh không DPI.
- Không có test DPI X/Y khác nhau hoặc padding vật lý qua 72/300/600 DPI.
- API test chỉ kiểm CutContour tồn tại, không kiểm node/mm, short-segment ratio, góc lõm nhọn,
  page box hoặc scale.
- Không có test current-image -> đổi mode -> analyze không mở picker.
- Fallback DirectML -> CPU chưa kiểm giải phóng session lỗi trước khi nạp session mới.

## 5. Lô sửa đề xuất - chờ duyệt

Mỗi lô tối đa 5 file; hết lô chạy test hẹp rồi mới sang lô tiếp theo.

### Lô A - view, màu overlay và nội dung UI

1. `StickerSheetWorkspace.tsx`: hand/pan, Space override, middle-drag, zoom và hint thao tác.
2. `stickerMaskProtocol.ts`: chỉ vẽ biên/cảnh báo, không phủ màu lòng tem.
3. `stickerMaskProtocol.test.ts`: oracle Alpha lòng tem bằng 0, biên vẫn rõ.
4. `StickerSheetPanel.tsx`: bỏ model/OpenCV/timing khỏi UI.
5. Test workspace mới cho hand-vs-mask và tab nền.

### Lô B - i18n và text không kỹ thuật

1. `vi.json`.
2. `en.json`.
3. `StickerSheetPanel.test.tsx`.
4. `StickerSheetWorkspace.tsx` nếu cần nối key/hint.
5. i18n catalog test hiện có.

### Lô C - giữ ảnh đang mở xuyên routing

1. `ImpositionTab.tsx`.
2. `imposition-tools/types.ts`.
3. `ImposerDashboard.tsx`.
4. `PreprocessingRouter.tsx`.
5. `StickerCutlineTool.tsx`.

### Lô D - màu nguồn và kích thước vật lý

1. `sticker_sheet_engine.py`: model chỉ quyết định Alpha, RGB lấy từ nguồn.
2. `sticker_sheet_export.py`: padding theo mm; giữ scale X/Y.
3. `stickerSheetStore.ts`: mặc định cùng quy ước 72 DPI/current document.
4. `test_sticker_sheet_engine.py`.
5. `test_sticker_sheet_api.py` hoặc store test theo biên hợp đồng cần khóa.

Nếu cần bổ sung field DPI X/Y/schema, tách thành lô D2 riêng thay vì vượt 5 file.

### Lô E - contour thích nghi giữ góc nhọn

1. `sticker_engine.py`: policy tùy chọn cho corner-aware fitting; mặc định cũ không đổi.
2. `cutline_geometry.py`: fit span trơn giữa các corner bị khóa.
3. `sticker_sheet_export.py`: bật policy mới riêng cho Ảnh AI nhiều tem.
4. `test_sticker_engine_e2e.py`: fixture sao/góc lõm/notch + artifact oracle.
5. `test_sticker_sheet_api.py`: parse path/page box của output thật.

### Lô F - fallback GPU -> CPU

1. `birefnet_engine.py`.
2. `test_background_removal_engines.py`.

## 6. Tiêu chí nghiệm thu

- Không còn tên model, OpenCV, thuật toán, logic nội bộ hoặc timing kỹ thuật trên UI.
- Space+drag và chuột giữa pan mượt; hand không tạo edit; tab nền không bắt phím/pointer.
- Pixel trong lòng tem của overlay có Alpha 0; RGB preview khớp nguồn ở vùng không biên.
- Ảnh không DPI xuất cùng scale mm với tài liệu đang mở; không còn hệ số lệch 4,1667.
- DPI X/Y và padding vật lý được khóa bằng test 72/300/600 DPI.
- Fixture sao giữ đúng số đỉnh/góc lõm trên ngưỡng vật lý, không self-intersection, không vượt
  envelope, giảm mạnh short-segment/node nhưng không làm cùn notch.
- File ảnh đang mở tự đi vào AI mode, không bật picker lần hai.
- DirectML OOM rớt CPU thành công hoặc trả lỗi hữu ích, không giữ đồng thời session GPU lỗi và
  session CPU đang tạo.
- Verify bằng typecheck/Vitest/pytest và render artifact PDF. Không build installer trong đợt này.

## 7. Giả định cần người dùng xác nhận

“Giữ đúng kích thước gốc” được hiểu là **mỗi tem giữ đúng tỷ lệ vật lý mm/px của ảnh/tài liệu
đang mở**, còn mỗi trang PDF đầu ra vẫn crop sát từng tem để đưa sang Bình tem bế. Nếu yêu cầu
mỗi trang output phải giữ nguyên toàn bộ khổ ảnh ban đầu, đó là một hành vi sản phẩm khác và cần
chốt riêng trước Lô D.
