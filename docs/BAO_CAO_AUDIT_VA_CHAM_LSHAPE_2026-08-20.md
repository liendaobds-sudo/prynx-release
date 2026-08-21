# Báo cáo audit va chạm ốc với L-shape — Bế tứ giác 1 Dao

> Ngày: 2026-08-20
> Audit unit: `W2-U03-LS-PONT` — bế tứ giác/1 Dao, bố cục L-shape và vùng cấm ốc
> Phạm vi: L-shape solver, finalize placement, resolver pont và parity preview/export
> Trạng thái: `TRACED + ARTIFACT + AUTO + FIXED + VERIFIED`

## Kết luận điều hành

Đã tái hiện bằng đúng ảnh nguồn người dùng và xác nhận kết quả nghiệp vụ cần giữ là **26 tem/tờ**.

Ảnh nguồn `Thu Hồng 1 hộp card kt 5x9cm ok.png` có kích thước `1063×591 px` ở `299.9994 DPI`, tương đương `90.00084×50.03811 mm`. Với preset tờ `320×430 mm`, lề giấy `5 mm`, hở tem `0 mm`, ốc tròn `5 mm` và lề ốc `7 mm`, solver sinh 27 placement thô:

- Khối chính `blockId=0`: 24 tem, bố cục 4 hàng × 6 tem.
- Khối phụ đáy `blockId=2`: 3 tem.
- Hai tem ở hai đầu hàng biên của khối chính đi vào vùng cấm ốc.

Kết quả đúng sau xử lý va chạm là:

- Khối chính còn 23 tem: ba hàng đủ 6 tem và một hàng biên còn 5 tem, được canh giữa trong **không gian riêng của khối chính**.
- Khối phụ đáy vẫn đủ 3 tem và giữ nguyên vị trí.
- Tổng cộng `23 + 3 = 26` tem; không còn va ốc và không có tem chồng nhau.

Nguyên nhân trực tiếp của hồi quy 25 tem/lệch khối chính là tâm tạm của toàn hình L sau `finalize_placements()` đã bị dùng nhầm làm điểm neo cuối cho reflow. Bounding box của khối phụ có thể kéo tâm xử lý hàng/cột của khối chính sang một bên. Dịch cứng toàn hình L để giữ số lượng cũng không đúng hợp đồng của ca này vì làm khối chính rời tâm dự kiến.

Bản sửa cuối dùng reflow theo vai trò khối:

1. Nếu chính khối phụ va ốc, thử dịch cứng riêng toàn khối phụ trước.
2. Nếu va chạm còn ở khối chính, chỉ reflow khối chính trong bounding box ban đầu của chính nó:
   - Có khối phụ đáy: ưu tiên co/canh theo hàng.
   - Có khối phụ phải: ưu tiên co/canh theo cột.
3. Ghép lại khối phụ không đổi và chỉ nhận kết quả khi toàn layout hết va ốc, không chồng tem.

Đây cũng khớp với hành vi chủ đích của script Illustrator gốc: fill đáy xử lý hàng của khối chính; fill phải xử lý cột của khối chính; không dùng bounding box hỗn hợp làm tâm cuối cho riêng khối chính.

## Artifact và cấu hình tái hiện

| Thuộc tính | Giá trị |
|---|---:|
| File nguồn | `Thu Hồng 1 hộp card kt 5x9cm ok.png` |
| Raster | `1063×591 px` |
| DPI | `299.9994` |
| Kích thước suy ra | `90.00084×50.03811 mm` |
| Khổ tờ | `320×430 mm` |
| Lề giấy | `5 mm` |
| Hở tem gốc | `0 mm` |
| Ốc | Tròn, `5 mm` |
| Lề ốc | `7 mm` mỗi cạnh |
| Candidate thô ở gap 0 | 27 tem = main 24 + aux đáy 3 |
| Kết quả đúng | 26 tem = main 23 + aux đáy 3 |

Harness trên cùng hình học cho kết quả cuối ổn định:

| Hở tem | Kết quả sau collision |
|---:|---:|
| `0 mm` | `26 tem/tờ` |
| `0.5 mm` | `26 tem/tờ` |
| `1 mm` | `26 tem/tờ` |

Giá trị `0` vì vậy không còn là một nhánh đặc biệt làm layout lệch hoặc mất thêm tem.

### Artifact bổ sung — A3 lỡ và sai khác gap 0/2

Cùng file nguồn trên preset `A3 lỡ 320×450 mm`, lề giấy `3 mm`, ốc tròn
`5 mm` và lề ốc `7 mm` đã phơi ra một lỗi độc lập ở bước chọn candidate trước
collision:

| Hở tem | Kết quả cũ | Kết quả đúng sau sửa |
|---:|---:|---:|
| `0 mm` | `25 tem/tờ`, lệch khối | `27 tem/tờ` |
| `0.5 mm` | có thể rơi còn `26 tem/tờ` | `27 tem/tờ` |
| `1 mm` | `27 tem/tờ` | `27 tem/tờ` |
| `2 mm` | `27 tem/tờ` | `27 tem/tờ` |

Ở `gap=0`, có hai candidate cùng 27 tem. Candidate cũ của Rust là main
`21` + aux đáy `6`, footprint khoảng `300.229×440.268 mm`; nó nằm sát mép,
va ốc và resolver xóa còn 25. Candidate đúng là main xoay `24` + aux đáy
`3`, footprint khoảng `300.229×410.041 mm`; candidate này không va ốc nên
giữ nguyên đủ 27.

## Đường chạy đã trace

```text
UI AdvancedSettingsSection
  → GridPreview payload
  → /imposition/preview-layout
  → solve_l_shape_layout
  → finalize_placements
  → resolve_pont_collisions_on_placements
  → smart_resolve_collisions
      → dịch riêng khối phụ nếu chính khối phụ va ốc
      → reflow riêng khối chính nếu va chạm còn ở block 0
  → đổi abs_x/abs_y về x/y tương đối cho preview

Export:
UI ImposerDashboard
  → nup_engine + finalize_placements
  → nup_process_chunk
  → smart_resolve_collisions
  → PDF
```

Các mắt xích chính:

- Solver L-shape gắn `blockId=0/1/2`: [shape_layouts.py](../backend/app/workers/sticker_imposer_pkg/shape_layouts.py).
- Finalize giữ `blockId` explicit: [imposition_finalize.py](../backend/app/workers/imposition_finalize.py).
- Dịch khối phụ, reflow khối chính và epsilon va ốc: [pont_collision.py](../backend/app/workers/pont_collision.py).
- Preview quy đổi vị trí collision đã resolve về tọa độ tương đối: [imposition.py](../backend/app/api/routes/imposition.py).
- Regression của ca này: [test_pont_collision_lshape_auxiliary_reflow.py](../backend/tests/test_pont_collision_lshape_auxiliary_reflow.py).

## Phát hiện và trạng thái

### §LS-PONT.1 — P1 — Metadata vai trò khối bị mất trước collision

**Trạng thái: `[FIXED 2026-08-20]`** · Correctness/parity · Effort S

Solver đã phát `blockId=0/1/2`, nhưng finalize trước đây không giữ metadata này ở đường gọi mặc định. Resolver vì thế không phân biệt được khối chính, khối phụ phải và khối phụ đáy.

Bản sửa giữ mọi `blockId` explicit; `with_block_id=True` vẫn là fallback tương thích cho caller cũ dùng `pageIdx`.

### §LS-PONT.2 — P1 — Reflow dùng tâm toàn L thay cho tâm riêng khối chính

**Trạng thái: `[FIXED 2026-08-20]`** · Correctness · Effort M

`finalize_placements()` canh toàn hình L để tạo tọa độ tuyệt đối trước khi dò ốc. Vị trí này là đầu vào hợp lệ cho collision, nhưng bounding box hỗn hợp không phải điểm neo cuối cho hàng/cột của khối chính.

Ở file thật, nhánh đúng phải bỏ đúng một tem trong hàng biên 6 tem rồi canh 5 tem còn lại theo tâm khối chính. Resolver block-aware hiện:

- Chỉ nhận layout một mẫu có đủ vai trò block L-shape hợp lệ.
- Reflow riêng `blockId=0`.
- Giữ các placement phụ không đổi.
- Kiểm lại va ốc và overlap trên toàn bộ kết quả trước khi trả về.

### §LS-PONT.3 — P1 — Khối phụ không có chiến lược dịch cứng riêng

**Trạng thái: `[FIXED 2026-08-20]`** · Correctness · Effort M

Khi chính `blockId=1/2` va ốc, nhánh lưới chung có thể xóa hoặc dồn từng tem. Bản sửa sinh vector từ biên hình học thật và dịch nguyên khối phụ, chỉ nhận ứng viên làm giảm va chạm mà không tạo va chạm mới hoặc chồng tem.

### §LS-PONT.4 — P1 — Tiếp tuyến vùng an toàn bị tính là va chạm

**Trạng thái: `[FIXED 2026-08-20]`** · Geometry correctness · Effort S

Shapely `intersects()` trả `True` cả khi hai biên chỉ tiếp tuyến với diện tích giao bằng 0. Collision pont hiện dùng hằng riêng:

```text
PONT_COLLISION_EPS_PT2 = 1e-9
```

Chỉ giao có diện tích lớn hơn epsilon này mới là xâm lấn vùng cấm. Ngưỡng `MIN_OVERLAP_AREA_PT2=1.0` vẫn dành riêng cho kiểm tra tem–tem; không còn bị dùng lẫn cho pont.

### §LS-PONT.5 — P1 — Preview làm rơi vị trí đã resolve

**Trạng thái: `[FIXED 2026-08-20]`** · Preview/export parity · Effort S

Resolver thay đổi `abs_x/abs_y`, nhưng preview tương đối trước đây có thể trả lại `cell.x/y` cũ. Preview hiện đổi ngược tọa độ tuyệt đối đã resolve về `x/y`, vì vậy phép dịch/reflow nhìn thấy trên preview khớp dữ liệu worker dùng để xuất.

### §LS-PONT.6 — P1 — Footprint khối phụ xoay dùng sai kích thước

**Trạng thái: `[FIXED 2026-08-20]`** · Geometry correctness · Effort S

Base polygon hình học được dựng từ ô đầu tiên. Với khối phụ xoay 90°, footprint collision hiện được co theo `width/height` hiệu dụng của từng placement, tránh dùng nhầm chiều của khối chính.

### §LS-PONT.7 — P1 — Rust/Python chọn khác candidate khi gap bằng 0

**Trạng thái: `[FIXED 2026-08-20]`** · Solver parity/correctness · Effort M

`gap=0` không tạo secondary gap explicit nên runtime đi native Rust; `gap=2`
đi bản Python. Rust cũ vừa thiếu bước canh giữa khối hẹp theo trục ghép, vừa
phá hòa chỉ theo thứ tự duyệt. Vì vậy hai giá trị hở chạy hai bố cục khác nhau
dù gap 0 có candidate 27 tem sạch va chạm.

Bản sửa đồng bộ hai engine:

- Canh giữa khối chính/phụ hẹp hơn trước khi tạo placement cuối.
- Khi hòa sản lượng, ưu tiên độ thoáng mép rồi footprint nhỏ hơn ở mọi gap;
  không tạo một vách rơi hành vi ngay phía trên giá trị 0.
- Khóa parity Rust/Python trên dải gap `0/0.5/1/2 mm` bằng file/kích thước tái hiện.

### §LS-PONT.8 — P1 — Hai khối fill có thể chồng nhau ở góc

**Trạng thái: `[OPEN — TÁCH LÔ]`** · Solver geometry · Effort M

Trong scenario golden `320×450`, tem `80×50`, gap `2`, candidate L-shape cũ
có đồng thời fill phải và fill đáy; hai vùng fill phủ qua góc chung và sinh hai
cặp tem chồng thật. Lỗi này không xuất hiện ở file Thu Hồng vì candidate được
chọn chỉ có main + một aux đáy, nhưng solver public không được coi raw count có
overlap là sản lượng hợp lệ. Cần tách lô riêng để giới hạn miền fill hoặc loại
candidate overlap trước khi xếp hạng, kèm golden mới; không trộn lén vào bản vá
va ốc hiện tại.

## Hành vi được chốt

- `gap=0` cho phép các biên tem/khối chạm nhau nếu diện tích overlap bằng 0.
- Tiếp tuyến với biên ngoài của vùng an toàn ốc không phải là xâm lấn.
- Khối phụ va ốc được ưu tiên dịch nguyên khối.
- Khối chính va ốc được reflow trong không gian riêng; khối phụ không được kéo tâm cuối của hàng/cột chính.
- Candidate L-shape phải được canh khối và phá hòa trước collision; không được chọn một candidate sát ốc rồi xóa tem nếu candidate cùng sản lượng sạch va chạm vẫn tồn tại.
- Không dịch toàn hình L chỉ để giữ số lượng nếu phép dịch làm sai canh tâm nghiệp vụ.
- Mọi kết quả đều phải qua hai chốt toàn cục: hết va ốc và không tem nào chồng nhau.

## Xác minh đã có

Đã chạy bộ regression hẹp:

```text
backend/venv/Scripts/python.exe -m pytest \
  -p no:cacheprovider \
  tests/test_pont_collision_lshape_auxiliary_reflow.py -q
```

Kết quả: **14 passed**.

Bộ này phủ:

- Giữ `blockId` qua finalize.
- Footprint khối phụ xoay 90°.
- Tiếp tuyến vùng cấm.
- Dịch cứng khối phụ phải/đáy ở hở 0.
- Từ chối helper L-shape khi một block phụ trộn hướng xoay.
- Parity tọa độ preview tương đối.
- Layout solver thực tế có khối phụ va ốc.
- File Thu Hồng `90.00084×50.03811 mm`: raw 27 → 26, hàng biên 5 tem canh tâm riêng và aux đáy 3 tem giữ nguyên.
- A3 lỡ `320×450 mm`, lề `3 mm`: gap `0/0.5/1/2` đều chọn main xoay 24 + aux đáy 3; native/Python parity và giữ đủ 27.

Đã chạy bộ regression liên quan collision, N-up, pont/CNC, solver và golden:
**141 passed**. Lõi Rust đạt **38 passed** (`37` unit + `1` parity); chỉ còn
một cảnh báo Pydantic deprecation có sẵn.

Smoke test qua đúng endpoint `/api/imposition/preview-layout` với PDF chuyển từ ảnh nguồn
đạt ở gap `0/0.5/1 mm`: mỗi response có 26 cell, không trùng tọa độ, không tràn tờ,
không va ốc và giữ đúng thứ tự placement sống sót.

Với preset A3 lỡ, endpoint thật sau khi nạp native build cuối trả `27` cell ở
cả gap `0/0.5/1/2 mm`; cả bốn trường hợp đều có main xoay 24 + aux đáy 3.

`py_compile` cho ba module đã sửa và `git diff --check` đều đạt.

## Khoảng trống bằng chứng còn lại

- Chưa dùng kết quả của một lần chạy backend toàn bộ để tuyên bố không hồi quy toàn dự án.
- Chưa có đối chiếu pixel của PDF xuất cuối trong Tauri/WebView sau bản sửa cuối; đây là bước runtime thủ công riêng nếu cần phát hành ngay.
- §LS-PONT.8 là finding solver riêng còn mở; không ảnh hưởng artifact A3 đã xác minh.
