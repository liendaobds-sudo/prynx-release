# Kế hoạch triển khai Bình nguyên tấm decal - phiên bản 2

## 1. Trạng thái, bối cảnh và mục tiêu

- Trạng thái: Đã cập nhật sau review code, chưa bắt đầu triển khai.
- Tài liệu review: `docs/REVIEW_KE_HOACH_BINH_NGUYEN_TAM_DECAL.md`.
- Phạm vi: Công cụ **Bình tem bế** trên desktop và backend imposition.
- Mục tiêu: Coi toàn bộ một trang PDF, ví dụ một tấm sticker A5 hoàn chỉnh, là một đơn vị sản phẩm để nhân bản hoặc dàn nhiều mẫu lên khổ in.
- Không commit cho đến khi người dùng kiểm tra và yêu cầu.

Yêu cầu bảo toàn:

- Toàn bộ sticker trên tấm.
- Các đường kiss-cut `CutContour` bên trong.
- Các mẫu trang trí không có đường cắt.
- Vector, DeviceCMYK/ICC, spot color, transparency, clipping, OCG/layer, font và soft mask.
- Không raster hóa nội dung trang nguồn.
- Không sửa hoặc ghi đè PDF nguồn.

### 1.1. Vì sao cần chế độ này

Sản phẩm thực tế là một tấm decal A5 hoàn chỉnh, gồm nhiều sticker đã có đường kiss-cut và các chi tiết trang trí khác. Khách hàng mua và sử dụng cả tấm A5. Khi bình lên khổ in lớn, đơn vị cần nhân bản là cả tấm A5, không phải từng sticker bên trong.

Chế độ này là sự kết hợp có chủ đích:

- Nội dung của cả trang được giữ như một khối PDF nguyên vẹn.
- Footprint, lưới, khoảng cách tấm, bleed ngoài tấm và dấu xén dùng quy tắc của Bình cắt xén.
- Các `CutContour` bên trong chỉ là nội dung; chúng không tham gia footprint hoặc nesting.

### 1.2. Hai quyết định sản phẩm đã chốt sau review

1. Report dùng nhãn riêng **Bình nguyên tấm decal**. Không dùng nhãn chung `Cắt xén`, không tắt report và không giả lập report theo từng khuôn tem.
2. Bleed do người dùng quyết định hoàn toàn qua ô `Bleed`. App không dò artwork, không suy luận từ `TrimBox/BleedBox` và không tự thay đổi giá trị. Kích thước thành phẩm được tính từ kích thước trang nguồn trừ bleed ở bốn cạnh.

### 1.3. Ngoài phạm vi giai đoạn này

- Không chỉnh riêng sticker hoặc `CutContour` bên trong tấm khi đang bình nguyên tấm.
- Không tự sinh bleed bằng kéo giãn, mirror hoặc raster.
- Không scale các mẫu khác kích thước thành phẩm về cùng một cỡ.
- Không thêm thuật toán dấu xén mới.
- Không thêm lựa chọn thủ công `một dao/hai dao`.
- Không thay đổi logic Bù xén/Tạo đường cắt.

## 2. Mô hình sản phẩm và UI

### 2.1. Hai lựa chọn độc lập

Trong Bình tem bế có hai chiều lựa chọn:

#### Đơn vị bình

- `Từng tem`: hành vi hiện tại.
- `Nguyên tấm decal`: lấy toàn bộ trang PDF làm một sản phẩm.

#### Tác vụ hiện có

- `Bình trang (S&R)`: nhân bản một mẫu.
- `Dàn nhiều mẫu`: dàn nhiều mẫu khác nhau.

| Đơn vị bình | Tác vụ | Kết quả |
|---|---|---|
| Từng tem | Bình trang | Nhân bản một mẫu tem |
| Từng tem | Dàn nhiều mẫu | Dàn nhiều mẫu/khuôn tem |
| Nguyên tấm decal | Bình trang | Nhân bản nguyên tấm đang chọn |
| Nguyên tấm decal | Dàn nhiều mẫu | Mỗi trang PDF là một mẫu tấm decal |

### 2.2. Không thêm kiểu xén một dao/hai dao

Số tọa độ xén được suy ra từ khoảng cách placement:

- `gapX = 0`: hai cạnh đứng trùng nhau, dùng chung một tọa độ xén.
- `gapX > 0`: hai cạnh đứng tách nhau, có hai tọa độ xén.
- `gapY = 0`: hai cạnh ngang trùng nhau, dùng chung một tọa độ xén.
- `gapY > 0`: hai cạnh ngang tách nhau, có hai tọa độ xén.

Tái sử dụng `pdfcompare_native.compute_mark_coords(...)`. Không viết thuật toán marks mới.

### 2.3. Dropdown Đơn vị bình

Thêm dropdown **Đơn vị bình** ngay phía trên dropdown **Tác vụ**.

Dropdown chỉ xuất hiện khi:

```text
activeTool === 'sticker_imposer'
```

Các lựa chọn:

- `Từng tem`
- `Nguyên tấm decal`

### 2.4. UI khi chọn Từng tem

Giữ nguyên toàn bộ UI và hành vi hiện tại:

- Hở tem.
- Nhận diện hình khuôn.
- Kiểu dao.
- Offset khuôn.
- Nesting theo contour.
- Pont.
- Tách trang khuôn.
- Thiết lập master die.

### 2.5. UI khi chọn Nguyên tấm decal

Hiển thị:

- `Tác vụ`: Bình trang hoặc Dàn nhiều mẫu.
- `Khoảng cách tấm`, tái sử dụng `gapX/gapY`.
- `Bleed`, tái sử dụng trường hiện có.
- `Dấu xén`: Không dấu, bốn góc ngoài, hoặc guillotine.
- Chiều dài, khoảng hở, độ dày và style dấu xén.
- Lề tờ in, khổ giấy và căn chỉnh.
- Cho phép xoay 0/90 độ theo khả năng layout hiện tại.
- Số lượng.

Đổi nhãn theo ngữ cảnh:

- `Hở tem` thành `Khoảng cách tấm`.
- `Số lượng` thành `Số tấm decal`.

Ẩn:

- Nhận diện hình khuôn.
- `Mặc định/1 Dao`.
- `dieSizeMode`.
- `dieOffsetMm`.
- Nesting polygon theo đường bế.
- Hở block phụ theo hình tem.
- Pont bế.
- Tách trang khuôn.
- Thiết lập master die.

Tái sử dụng component Bleed và Dấu xén hiện có. Không tạo bộ state/component trùng lặp chỉ cho nguyên tấm.

## 3. Ranh giới kiến trúc bắt buộc

`impositionUnit` là state giao diện để ghi nhớ lựa chọn trong Bình tem bế. Nó không phải cờ định tuyến backend.

Frontend dẫn xuất:

```ts
const pageSheetMode =
    activeTool === 'sticker_imposer'
    && s.impositionUnit === 'page_sheet';

const stickerGeometryMode =
    activeTool === 'sticker_imposer'
    && !pageSheetMode;

const dieGeometryMode =
    activeTool === 'cnc_imposer'
    || stickerGeometryMode;
```

Ý nghĩa:

- `pageSheetMode`: cả trang là item chữ nhật, dùng layout và marks kiểu guillotine.
- `stickerGeometryMode`: Bình tem bế kiểu hiện tại mới dùng contour/khuôn tem.
- `dieGeometryMode`: logic hình học bế dùng cho CNC và Từng tem.

Payload chỉ gửi boolean đã dẫn xuất `page_sheet_mode`. Không gửi raw `impositionUnit` cho backend. Đây là lớp cách ly bắt buộc để state giao diện không thể tắt luồng bế của CNC hoặc làm đổi N-Up.

### 3.1. Ma trận routing

| Công cụ | Đơn vị | `page_sheet_mode` | `isDieCutMode` hiệu dụng | Hình học |
|---|---|---:|---:|---|
| Bình tem bế | Từng tem | false | true | die contour |
| Bình tem bế | Nguyên tấm | true | false | page rectangle inset theo bleed người dùng |
| CNC | Không áp dụng | false | true | CNC/die contour |
| N-Up/cắt xén | Không áp dụng | false | false | guillotine rectangle |

Backend không được suy ra `page_sheet_mode` từ tên tool, `impositionUnit` hay `isDieCutMode`.

## 4. State, profile và tương thích preset

Thêm:

```ts
impositionUnit: 'sticker' | 'page_sheet'
```

Mặc định:

```ts
impositionUnit: 'sticker'
```

Tái sử dụng:

```text
bleed
gapX
gapY
markType
markOffset
markLength
markThickness
markStyle
layoutType
targetQuantity
targetQuantitiesByPage
```

Không thêm:

```text
sheetBleed
sheetGap
sheetMarkType
sheetTrimMode
```

Chi tiết:

- Khai báo type, default và setter trong `nupSlice.ts`.
- Thêm vào `NUP_PERSIST_KEYS` và profile thuật toán để Bình tem bế nhớ lựa chọn.
- Các profile ngoài Bình tem bế phải có fallback rõ ràng là `sticker`, hoặc `switchToolProfile` phải áp default khi key không có trong profile đích.
- Mọi nơi sử dụng `impositionUnit` phải kèm điều kiện `activeTool === 'sticker_imposer'`.
- Không bump version persist chỉ để thêm key này; cơ chế merge hiện tại lấy default cho key cũ bị thiếu.
- Preset cũ thiếu `impositionUnit` phải mở ở chế độ `sticker`.
- Test chuyển `sticker(page_sheet) -> CNC -> N-Up -> sticker` để chứng minh không rò hành vi.

## 5. Audit toàn bộ gate frontend

Không chỉ sửa hai chỗ Bleed và Dấu xén. Phải rà mọi gate đang dùng `stickerLike`, `isDieCut` hoặc chỉ kiểm tra `activeTool === 'sticker_imposer'`.

| Nhóm gate | Hành vi trong Nguyên tấm decal | Điều kiện |
|---|---|---|
| Nhận diện hình khuôn, detected shape, die bbox | Tắt | `dieGeometryMode` |
| `cutType`, `dieSizeMode`, `dieOffsetMm`, `fillBlockGap` | Ẩn và không gửi | `dieGeometryMode` |
| Pont, master die, tách trang khuôn | Ẩn và không gửi | `dieGeometryMode` |
| Bleed tấm | Hiện | `pageSheetMode` hoặc guillotine |
| Marks và cấu hình marks | Hiện | capability guillotine khi `pageSheetMode` |
| Căn chỉnh, lề, khổ giấy | Hiện | luồng rectangle/guillotine |
| Grouping, cluster và split gap | Quy tắc guillotine | không đi nhánh die geometry |
| Preview `isDieCut` | false | truyền `dieGeometryMode` |
| Shape preview | rectangle theo kích thước trang trừ `2 × bleed` | `pageSheetMode` |
| `shapesByPage`, `shapeParamsByPage`, `pontConfig` | Không gửi | chỉ `dieGeometryMode` |
| `separateCutPage`, `pontsOnCutFile` | Tắt | chỉ `dieGeometryMode` |
| Report | Nhãn riêng | `pageSheetMode` |

Các điểm tối thiểu phải audit:

- `GridSettingsSection.tsx`: dropdown, shape controls, gap, bleed và nhãn số lượng.
- `AdvancedSettingsSection.tsx`: nhóm khuôn, alignment, marks, mark handler, guillotine sub-controls, pont và `separateCutPage`.
- `ImposerDashboard.tsx`: auto-detection, batch-capacity, split gap, cluster/grouping, margin mode, marks capability, payload export và props preview.
- `shapeDetectionPolicy.ts`: không ưu tiên detected die khi `pageSheetMode`.
- `GridPreview.tsx`: `isDieCut=false`, dimensions lấy từ kích thước trang và bleed người dùng, không dựng master mold.

Trước khi sửa, tìm toàn dự án theo `stickerLike`, `isDieCut`, `isDieCutMode` và `activeTool === 'sticker_imposer'`; phân loại từng chỗ là identity UI, die geometry hay guillotine geometry. Không thay hàng loạt nếu chưa phân loại.

## 6. Quy tắc kích thước trang và bleed

Khi `pageSheetMode`:

- Không dùng bbox của `CutContour` lớn nhất.
- Không dùng detected shape của từng sticker.
- Không phân tích màu, pixel, vector hoặc khoảng trắng để tìm bleed.
- Không lấy `TrimBox` hoặc `BleedBox` làm nguồn quyết định độ lớn bleed.
- Giá trị duy nhất quyết định bleed là số người dùng nhập trong ô `Bleed`.

Tạo resolver dùng chung, ví dụ:

```text
resolve_page_sheet_geometry(page_rect, user_bleed_mm)
  -> source_rect
  -> trim_rect
  -> trim_width
  -> trim_height
  -> bleed_pt
```

Quy tắc:

1. Chuẩn hóa kích thước trang nguồn từ `MediaBox/page.rect`, có xét rotation theo hệ tọa độ engine hiện tại.
2. `bleed_pt = user_bleed_mm × MM_TO_PT`.
3. Thành phẩm được inset đúng lượng bleed người dùng nhập:

```text
trimWidth  = sourceWidth  - 2 × bleed
trimHeight = sourceHeight - 2 × bleed
```

4. Nếu `bleed=0`, toàn bộ kích thước trang nguồn là thành phẩm.
5. Nếu PDF có `TrimBox/BleedBox`, các box đó được bảo toàn trong Form XObject nhưng không được ghi đè thông số người dùng.
6. Không auto-detect, không clamp theo metadata và không cảnh báo kiểu `PDF không có bleed`.
7. Chỉ validate hình học:
   - `bleed >= 0`.
   - `trimWidth > 0`.
   - `trimHeight > 0`.
   - Các giá trị phải hữu hạn.
8. Nếu `2 × bleed` lớn hơn hoặc bằng chiều rộng/chiều cao trang, hủy an toàn và báo bleed không hợp lệ.

Ví dụ:

```text
Trang nguồn: 154 × 216 mm
Bleed người dùng: 3 mm
Thành phẩm: 148 × 210 mm
```

Nếu trang nguồn là 148 × 210 mm nhưng người dùng vẫn nhập bleed 3 mm, thành phẩm được tính là 142 × 204 mm. Đây là kết quả theo thông số người dùng, không phải lỗi cần app tự sửa.

Resolver được dùng nhất quán tại:

- Item dimension ban đầu.
- Guard dàn nhiều mẫu khác kích thước.
- Solver layout.
- Preview.
- Clip khi đặt Form XObject.
- Vị trí marks.
- Report kích thước thành phẩm.

### 6.1. Dàn nhiều mẫu

Giai đoạn đầu chỉ hỗ trợ các trang có cùng kích thước thành phẩm sau khi trừ bleed người dùng.

Nếu khác quá tolerance:

- Hủy an toàn và báo lỗi rõ ràng.
- Không scale các trang.
- So sánh `trimWidth/trimHeight` đã tính, không so `TrimBox`.
- Cho phép xoay 90 độ chỉ khi layout hiện tại hỗ trợ và kích thước sau xoay tương thích.

## 7. Quy tắc bleed và clip

Có hai khái niệm độc lập:

- Bleed sticker: bù xén quanh từng sticker bên trong tấm; đã là nội dung trang và phải giữ nguyên.
- Bleed tấm: dải nằm bên trong mép trang nguồn, có độ rộng đúng bằng giá trị người dùng nhập.

Ô `Bleed` là nguồn sự thật duy nhất:

- App không kiểm tra file có bleed thật hay không.
- App không đọc page box để đoán bleed.
- App không thay đổi giá trị người dùng nhập.
- App giả định người dùng đã chuẩn bị PDF với lượng bleed tương ứng.
- Mặc định của ô vẫn là 0; không tự đặt 3 mm.

Khi đặt trang nguồn:

- Đặt toàn bộ nội dung trang nguồn, gồm phần bleed người dùng đã khai báo.
- Đường xén nằm inset vào đúng giá trị bleed.
- Clip riêng theo từng placement/cell.
- Không để bleed của tấm này chồng vào vùng thành phẩm tấm bên cạnh.
- Test riêng `gap=0, bleed=3 mm` và `gap=5 mm, bleed=3 mm`.

## 8. Preview và split gap

### 8.1. Kích thước và hình preview

Sửa `resolvePreviewItemDimension()`:

- Từng tem: ưu tiên detected die dimension như hiện tại.
- Nguyên tấm: dùng kích thước trang nguồn trừ `2 × bleed` người dùng, bỏ detected die.

Mỗi placement nguyên tấm là rectangle theo kích thước trang trừ `2 × bleed` người dùng. Thumbnail hiển thị toàn trang, gồm sticker, trang trí, nền và kiss-cut.

### 8.2. Preview và export phải đồng nhất

Preview, batch-capacity và export dùng chung:

- Item width/height.
- Gap X/Y.
- Bleed người dùng nhập.
- Lề.
- Số hàng/cột.
- Tọa độ placement.
- Layout type.
- Split gap và mark clearance.

### 8.3. Một nguồn tính split gap

Tách công thức thành helper dùng chung cho ba đường payload:

- `dieGeometryMode`: giữ quy tắc hở tem/CNC hiện tại.
- `pageSheetMode`: dùng quy tắc guillotine, gồm khoảng trống cho marks.
- Nếu marks là `guillotine` hoặc `corners`, `clusterGap` không đặt riêng hoặc `clusterGapMode === 'mark'`:

```text
markClearance = markLength + markOffset
splitGap = 2 × markClearance
```

- Nếu người dùng đặt `clusterGap` riêng thì dùng giá trị đó theo quy tắc hiện có.
- Không duy trì ba bản sao công thức khác nhau trong `ImposerDashboard.tsx`.

## 9. Payload frontend và API

Không gửi raw state:

```ts
// Cấm:
impositionUnit: s.impositionUnit
```

Ba đường payload bắt buộc đồng bộ:

1. Batch-capacity.
2. Preview.
3. Export.

Cả ba chỉ gửi:

```ts
page_sheet_mode: pageSheetMode
```

Khi `pageSheetMode`:

- Bình trang gửi `layoutType=repeat`; Dàn nhiều mẫu giữ layout phù hợp.
- Gửi gap, bleed, marks và cấu hình marks.
- `isDieCutMode=false`.
- `shapeType=RECTANGLE`.
- Không gửi detected shape làm footprint.
- Không ép `cutType=one_dao`.
- `separateCutPage=false`; không gửi pont/master die.
- Marks dùng capability guillotine, không dùng capability `diecut`.
- Margin, grouping, cluster và split gap dùng quy tắc guillotine.

API:

- Nhận `page_sheet_mode`, default `false`.
- Validate boolean.
- Không suy ra từ `impositionUnit`.
- Nếu `imposerMode='cnc'` và `page_sheet_mode=true`, hủy an toàn hoặc chuẩn hóa về false; ưu tiên hủy để lỗi không bị che.

## 10. Backend routing

Ngay đầu `run_nup_engine`, trước mọi lần đọc `isDieCutMode`, chuẩn hóa bản sao settings:

```python
page_sheet_mode = bool(settings.get("page_sheet_mode", False))

if page_sheet_mode:
    if (settings.get("imposerMode") or "").lower() == "cnc":
        raise ValueError("page_sheet_mode không áp dụng cho CNC")
    settings = {
        **settings,
        "isDieCutMode": False,
        "cutType": "default",
        "separateCutPage": False,
    }
```

Không dùng phương án chỉ tạo một biến `effective_is_die_cut` cục bộ. `nup_engine.py` đọc `settings.get('isDieCutMode')` ở nhiều gate, gồm các gate chạy trước biến `is_die_cut`; vì vậy phải ghi đè bản sao settings ngay đầu.

Khi `page_sheet_mode`:

- Bỏ `_find_largest_die_path()` cho footprint.
- Bỏ polygon nesting và genuine die.
- Dùng nhánh guillotine rectangle.
- Dùng resolver kích thước trang và bleed người dùng ở §6.
- Guard mixed-size theo kích thước thành phẩm đã tính.
- Cho phép marks.
- Không strip hoặc sửa `CutContour`.
- Mọi placement có `cell.blockId` và `original_cell_y` hợp lệ trước khi chuyển sang native marks.

`page_sheet_mode` là identity riêng cho report và log. `isDieCutMode=false` chỉ chọn đường layout/render không strip contour; nó không được làm mất identity **Bình nguyên tấm decal**.

## 11. Report Bình nguyên tấm decal

Tách report page-sheet khỏi gate `if is_die_cut`.

Nhãn:

```text
Bình nguyên tấm decal
```

Nội dung tối thiểu:

- Tên/mã bài.
- Kích thước một tấm sau khi trừ bleed người dùng.
- Khổ tờ in.
- Số hàng × số cột hoặc số tấm trên mỗi tờ.
- Khoảng cách tấm X/Y.
- Số lượng yêu cầu.
- Số tờ in cần chạy.
- Số mẫu khi Dàn nhiều mẫu.

Không dùng fallback `Cắt xén`. Không báo cáo theo die zone vì các die bên trong chỉ là nội dung.

## 12. Nhân bản PDF bằng Form XObject

Tái sử dụng `show_pdf_page()` trong `pdf_ops.py`:

- Chuyển toàn bộ trang nguồn thành Form XObject.
- Nhúng mỗi trang nguồn một lần.
- Mỗi bản sao chỉ gọi `Do` với ma trận vị trí.
- Không raster hóa.
- Không nhân resource nặng theo số bản.

Phải giữ:

- Vector.
- DeviceCMYK/ICC/spot color.
- `CutContour`.
- Transparency group.
- OCG/layer.
- Font.
- Soft mask.
- Clipping.
- Nội dung trang trí.

Kiểm chứng:

- Mỗi trang nguồn chỉ import thành một Form XObject trong output; số lần đặt tăng bằng số lần `Do`.
- `BBox` chứa vùng nguồn cần dùng; clip thành phẩm/bleed nằm ở placement.
- Hash file nguồn trên đĩa không đổi.
- Stream và resource không bị rewrite bởi bước strip màu.
- So sánh spot color name, DeviceCMYK/ICC, soft mask, transparency, font và clipping trước/sau.
- OCG là điểm chưa thể coi là an toàn chỉ nhờ `as_form_xobject()`: fixture phải kiểm tra `/OC`, `/OCProperties` cấp document và khả năng bật/tắt layer output.

## 13. Dấu xén

Tái sử dụng:

```python
pdfcompare_native.compute_mark_coords(...)
```

Khi nguyên tấm:

- `markType=none`: không vẽ.
- `markType=corners`: bốn góc ngoài.
- `markType=guillotine`: đầy đủ tọa độ xén.

Frontend phải chọn capability có `supportsMarks=true` khi `pageSheetMode`. Không đi qua:

```ts
getImposerCapability('diecut').supportsMarks
```

vì capability die-cut hiện tại ép `markType='none'`.

Giữ các thông số:

- `markOffset`
- `markLength`
- `markThickness`
- `markStyle`

Test bắt buộc:

- Gap 0 tạo một tọa độ xén chung.
- Gap lớn hơn 0 tạo hai tọa độ xén.
- Tọa độ trùng được loại bỏ.
- Marks không đi vào thành phẩm.
- Japanese marks khớp trim và bleed.
- Placement nhiều hàng/cột giữ đúng `blockId` và `original_cell_y`.
- Preview, batch-capacity và export dùng cùng split gap/mark clearance.

## 14. Bình trang và Dàn nhiều mẫu

### 14.1. Bình trang

- Dùng trang đang chọn trong viewer.
- Nhân bản kín tờ.
- `targetQuantity` là số tấm decal cần sản xuất.
- Không lấy từng sticker làm item.

### 14.2. Dàn nhiều mẫu

- Mỗi trang là một mẫu tấm decal.
- `targetQuantitiesByPage` là số lượng từng loại tấm.
- Tất cả trang phải cùng kích thước thành phẩm sau khi trừ bleed người dùng trong giai đoạn đầu.
- Không trộn A5 và A6 trong cùng lưới guillotine.

## 15. Test frontend

1. Mặc định `impositionUnit=sticker`.
2. Dropdown chỉ xuất hiện trong Bình tem bế.
3. Nguyên tấm hiện Bleed, Marks, Alignment, lề và khổ giấy.
4. Nguyên tấm ẩn shape detection, cut type, die size/offset, pont, master die và tách trang khuôn.
5. Nhãn Hở tem đổi thành Khoảng cách tấm.
6. Nhãn Số lượng đổi thành Số tấm decal.
7. Bình trang gửi `layoutType=repeat`.
8. Dàn nhiều mẫu giữ layout type phù hợp.
9. Batch-capacity gửi `page_sheet_mode=true`, `is_die_cut=false`, shape rectangle.
10. Preview gửi `page_sheet_mode=true`, không chứa raw `impositionUnit`.
11. Export gửi `page_sheet_mode=true`, không chứa raw `impositionUnit`.
12. Ba payload có cùng routing, dimensions, gap, bleed và split gap.
13. Export giữ `markType=guillotine/corners`, không bị capability die-cut ép `none`.
14. Preview dùng kích thước trang trừ `2 × bleed` thay die dimension.
15. `GridPreview.isDieCut=false`.
16. Preview không nhận shapes, shape params, pont hoặc master die trong page-sheet.
17. Split gap page-sheet dùng công thức guillotine và khớp ở ba đường.
18. Chuyển lại Từng tem khôi phục hành vi cũ.
19. Store nhớ lựa chọn riêng của Bình tem bế.
20. Chuyển `sticker(page_sheet) -> CNC`: CNC vẫn `isDieCutMode=true`, không có `page_sheet_mode=true`.
21. Chuyển `sticker(page_sheet) -> N-Up`: N-Up không có `page_sheet_mode=true`.
22. Preset cũ thiếu key mở với `impositionUnit=sticker` mà không cần migrate version.
23. Characterization của Từng tem, CNC và Bình cắt xén giữ nguyên payload/output.

## 16. Test backend và PDF

Tạo fixture A5 có:

- Hai sticker.
- Hai đường spot `CutContour`.
- Trang trí không có CutContour.
- Ảnh DeviceCMYK.
- Soft mask.
- Transparency.
- OCG/layer.
- MediaBox/page size rõ ràng; có thêm TrimBox/BleedBox khác nhau để chứng minh metadata không ghi đè bleed người dùng.

Test:

1. Nhân bản nguyên tấm 2 × 2.
2. Mỗi bản có đầy đủ artwork và trang trí.
3. CutContour được giữ trong mỗi placement.
4. Không dùng bbox sticker lớn nhất làm footprint.
5. Không chạy polygon nesting.
6. Gap 0 tạo một đường xén chung.
7. Gap 5 mm tạo hai đường xén.
8. Bleed 0 giữ toàn bộ kích thước trang làm thành phẩm.
9. Trang 154 × 216 mm, bleed 3 mm tạo thành phẩm 148 × 210 mm.
10. Cùng một PDF, đổi bleed từ 0 sang 3 mm làm footprint thay đổi đúng 6 mm mỗi chiều.
11. `TrimBox/BleedBox` khác metadata nhưng cùng input bleed phải cho cùng phép tính theo MediaBox/page size.
12. Bleed âm, NaN hoặc `2 × bleed >= width/height` bị hủy an toàn.
13. `gap=0, bleed=3 mm`: clip không chồng thành phẩm hàng xóm.
14. `gap=5 mm, bleed=3 mm`: clip vẫn đúng khi gap nhỏ hơn tổng bleed hai phía.
15. Dàn hai mẫu có cùng kích thước thành phẩm đã tính giữ đúng số lượng.
16. Hai trang có kích thước thành phẩm đã tính khác nhau bị hủy an toàn.
17. Resource Form XObject không bị sửa.
18. Stream nguồn không bị sửa/strip.
19. PDF nguồn không bị ghi đè; hash trước/sau giống nhau.
20. Không raster hóa.
21. Preview và export có cùng placements.
22. `page_sheet_mode` ghi đè `isDieCutMode=false` trước mọi gate.
23. `page_sheet_mode=true` cùng CNC bị hủy an toàn.
24. `markType=guillotine` thực sự tạo marks.
25. Placements nhiều hàng/cột có `blockId` và `original_cell_y`.
26. Form mỗi trang nguồn embed một lần và tái sử dụng qua `Do`.
27. Spot, DeviceCMYK/ICC, soft mask, transparency, font và clipping được giữ.
28. OCG trong Form có membership hợp lệ và layer output bật/tắt được.
29. Report có nhãn `Bình nguyên tấm decal` và đúng số tấm/tờ in.

## 17. Kiểm tra trực quan

Tạo file tạm trong `tmp/pdfs/`:

- Bình trang nguyên tấm, gap 0.
- Bình trang nguyên tấm, gap 5 mm.
- Dàn nhiều mẫu nguyên tấm.
- Không marks.
- Corners marks.
- Guillotine marks.
- Japanese marks.
- File 154 × 216 mm với bleed người dùng lần lượt 0 và 3 mm.
- Hai file cùng MediaBox nhưng metadata TrimBox/BleedBox khác nhau.
- File có OCG/layer thật.
- File có gap nhỏ hơn tổng bleed hai phía.

Render bằng PDFium/Poppler và kiểm tra:

- Không mất sticker hoặc trang trí.
- Không có ô đen hoặc clip sai.
- CutContour đúng vị trí.
- Gap đúng số đo.
- Marks không đi vào thành phẩm.
- Spot CutContour còn tồn tại.
- CMYK và transparency không đổi.
- OCG/layer còn bật/tắt đúng.
- Report mang nhãn Bình nguyên tấm decal và số liệu đúng.
- Hash file nguồn không đổi.

Xóa file tạm sau khi kiểm tra.

## 18. Thứ tự triển khai

### Giai đoạn 0: Characterization

1. Chụp payload Từng tem, CNC và Bình cắt xén ở batch-capacity, preview và export.
2. Lưu expected output/test fixture cho các luồng cũ.
3. Ghi nhận marks, split gap, report và source hash.
4. Dùng các test này làm hàng rào hồi quy.

### Giai đoạn 1: State và routing frontend

1. Thêm `impositionUnit`, setter và default.
2. Thêm profile/fallback; không bump persist version.
3. Tạo `pageSheetMode`, `stickerGeometryMode`, `dieGeometryMode`.
4. Đồng bộ ba payload bằng `page_sheet_mode`, không gửi raw `impositionUnit`.
5. Test chuyển tool và preset cũ.

### Giai đoạn 2: UI và preview

1. Thêm dropdown Đơn vị bình.
2. Phân loại và sửa toàn bộ gate ở §5.
3. Page-sheet dùng capability marks guillotine.
4. Ẩn die controls; hiện bleed/marks/alignment.
5. Tạo helper split gap dùng chung.
6. Preview dùng kích thước trang trừ `2 × bleed` người dùng.
7. Viết test UI và parity ba đường payload.

### Giai đoạn 3: Backend routing và hình học bleed

1. API nhận `page_sheet_mode`.
2. Chuẩn hóa bản sao settings trước mọi gate `isDieCutMode`.
3. Thêm resolver kích thước trang + bleed người dùng.
4. Bỏ die detection/nesting cho page-sheet.
5. Dùng layout guillotine.
6. Guard mixed-size theo kích thước thành phẩm đã tính.
7. Tạo report Bình nguyên tấm decal.
8. Xác minh `blockId` và `original_cell_y`.

### Giai đoạn 4: Render PDF

1. Đặt toàn trang bằng Form XObject.
2. Giữ CutContour và resource.
3. Sinh guillotine marks.
4. Xác minh bleed/clip.
5. Kiểm tra OCG document-level.
6. Kiểm tra file không phình bất thường.
7. Kiểm tra hash nguồn và stream/resource.

### Giai đoạn 5: Hồi quy và QA

1. Test bốn tổ hợp Đơn vị × Tác vụ.
2. Test gap, bleed, marks và report.
3. Test CMYK/spot/OCG/transparency.
4. Render trực quan.
5. Chạy toàn bộ test imposition, die-cut, sticker, CNC, N-Up và PDF.

## 19. Các file dự kiến thay đổi

Frontend:

- `desktop/src/components/imposition-tools/types.ts`
- `desktop/src/components/imposition-tools/store/slices/nupSlice.ts`
- `desktop/src/components/imposition-tools/store/profiles.ts`
- `desktop/src/components/imposition-tools/store/slices/workspaceSlice.ts`
- `desktop/src/components/imposition-tools/store/persist.ts` chỉ để test/xác minh không cần bump version.
- `desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx`
- `desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx`
- `desktop/src/components/imposition-tools/ImposerDashboard.tsx`
- `desktop/src/components/imposition-tools/shapeDetectionPolicy.ts`
- `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
- Các test store, chuyển tool, UI, preview, batch-capacity và serializer.

Backend:

- `backend/app/api/routes/imposition.py`
- `backend/app/workers/nup_engine.py`
- `backend/app/workers/nup_process_chunk.py`
- `backend/app/workers/nup_artwork.py`
- `backend/app/workers/pdf_ops.py` chỉ khi test chứng minh Form/page box chưa đủ.
- `native/src/imposition/assembler.rs` chủ yếu để test mapping `blockId` và `original_cell_y`; chỉ sửa nếu fixture chứng minh thiếu.
- Các test imposition backend/PDF tương ứng.

Không sửa file chỉ vì nó có tên trong danh sách. Mỗi thay đổi phải gắn với test thất bại hoặc gate đã audit.

## 20. Ma trận chấp nhận cuối cùng

| Nhóm | Tình huống | Kết quả bắt buộc | Mức độ |
|---|---|---|---|
| Routing | page-sheet + PDF có CutContour | không die detect/strip; source hash không đổi | P0 |
| Routing | chuyển page-sheet sang CNC | CNC vẫn die-cut; `page_sheet_mode=false` | P0 |
| Routing | chuyển page-sheet sang N-Up | N-Up không nhận page-sheet | P0 |
| Marks | page-sheet + guillotine | export có marks, không bị ép `none` | P0 |
| Marks | gap 0 | một tọa độ xén chung | P0 |
| Marks | gap > 0 | hai tọa độ xén riêng | P1 |
| Marks | preview/export/batch | cùng split gap và mark clearance | P2 |
| Footprint | trang 154 × 216 mm, bleed 3 mm | footprint 148 × 210 mm | P1 |
| Footprint | metadata TrimBox/BleedBox thay đổi | không đổi phép tính nếu page size và input bleed không đổi | P1 |
| Footprint | input bleed không hợp lệ | hủy an toàn, không tự sửa giá trị | P1 |
| Render | nhân 2 × 2 | mỗi trang nguồn embed một Form, bản sao gọi `Do` | P1 |
| Render | CMYK/spot/soft mask/transparency | giữ resource và hình ảnh | P1 |
| Render | OCG trong Form | layer output còn membership và bật/tắt được | P2 |
| Bleed | gap < 2 × bleed | clip không chồng thành phẩm bên cạnh | P2 |
| Report | nguyên tấm | nhãn và số liệu theo tấm/tờ in | P1 |
| Hồi quy | Từng tem/CNC/N-Up/cắt xén | hành vi cũ không đổi | P0 |

## 21. Tiêu chí hoàn thành và điều kiện bắt đầu

Chỉ bắt đầu triển khai khi:

- Tất cả P0/P1 trong review đã có bước xử lý và test trong tài liệu này.
- Hai quyết định report và bleed ở §1.2 là yêu cầu chính thức.
- Characterization tests của luồng cũ được viết trước.
- Không đụng hoặc hoàn tác thay đổi riêng không liên quan trong worktree.

Tính năng chỉ hoàn thành khi:

- Người dùng chọn được Từng tem hoặc Nguyên tấm decal.
- Bình trang và Dàn nhiều mẫu đều hoạt động với nguyên tấm.
- Gap tự quyết định số tọa độ xén.
- Footprint bằng kích thước trang nguồn trừ đúng bleed người dùng nhập.
- Report đúng theo tấm.
- Sticker, CutContour và trang trí được giữ nguyên.
- Không raster hóa và không sửa PDF nguồn.
- Preview, batch-capacity và export khớp nhau.
- Không ảnh hưởng Từng tem, CNC, N-Up và Bình cắt xén.
- Toàn bộ test vượt qua.
- Render không có clip sai, ô đen hoặc mất nội dung.
- Không commit nếu người dùng chưa yêu cầu.
