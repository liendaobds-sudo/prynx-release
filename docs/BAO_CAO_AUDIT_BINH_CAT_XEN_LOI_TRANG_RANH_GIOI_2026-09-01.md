# Báo cáo audit Bình cắt xén — dải trắng tại ranh giới hai trang A5

> Ngày audit: 2026-09-01
>
> Audit unit: `W2-U01-CLIPOWN` — UI → planner → placement → clip → PDF mở lại
>
> Baseline: `codex/pre-release-audit-2026-08-04` tại `8bc0a219b2ec53cc9cc06adb4b9a7cd11c341dff`
>
> Trạng thái: `ARTIFACT + AUTO`; Lô 1 `§CLIPOWN.1` đã sửa và đã verify trên đúng PDF nguồn của người dùng qua public `run_nup_engine()`, chưa nâng `RUNTIME` app/installer; Lô 2 `§CANONFAIL.1` còn mở

## 1. Kết luận điều hành

Đã tái hiện đúng triệu chứng người dùng mô tả: hai trang A5 thành phẩm `148 × 210 mm` đặt sát nhau trên một tờ A4 ngang `297 × 210 mm`, tại đường ráp xuất hiện một dải trắng trên riêng trang được vẽ trước.

Finding trực tiếp là:

- `§CLIPOWN.1 [FIXED] P1`: ở layout `mixed_guillotine`, mỗi sản phẩm có một `blockId`. Renderer cũ tính “mép ngoài” theo bbox riêng của từng block, nên ranh giới giữa hai sản phẩm bị cả hai bên coi là mép ngoài và đều được nở full bleed. Trang vẽ sau mang nền trắng opaque trong vùng bleed, phủ ngược vào `3 mm` thành phẩm của trang trước. Lô 1 nay tính ownership theo láng giềng hình học trên toàn tờ, độc lập với `blockId`/`cluster_idx`.
- Nghi ngờ của người dùng đúng ở khu vực **clip**, nhưng toán tử clip PDF `re W n` không sai. Sai số nằm ở **quyền sở hữu clip** được tính trước writer; writer chỉ thực thi đúng rectangle sai đã nhận.

Audit còn xác nhận một finding độc lập trên cùng đường N-Up:

- `§CANONFAIL.1 [CONFIRMED] P1`: chuẩn hóa `/UserUnit`, `/Rotate` và gốc MediaBox đang fail-open. Với `/Rotate=45` không hợp lệ, engine ghi cảnh báo rồi vẫn xuất PDF, bỏ mất phép xoay thay vì dừng an toàn như hợp đồng PageBox đã chốt.

Người dùng đã duyệt riêng Lô 1. Bản sửa chạm hai file production và một file regression, không cập nhật snapshot/golden. `§CANONFAIL.1` độc lập, chưa được duyệt và chưa sửa trong lô này.

Sau bản vá, đúng PDF nguồn người dùng cung cấp — chỉ ghi tên file `Adjusted page size 1.pdf`, không lưu đường dẫn Desktop cá nhân — đã đi qua public `run_nup_engine()` ở cả nhánh chẩn đoán `mixed_guillotine` và nhánh `sequential` mà planner chọn cho nguồn đồng nhất. Cả hai đều xuất 4 tờ A4, mỗi tờ đúng 2 lệnh `Do`; clip của nhánh `sequential` gặp seam chính xác và raster không có cross-paint. Vì vậy ca nguồn thực tế đạt `EXACT CUSTOMER ARTIFACT VERIFIED` ở tầng backend/artifact; thao tác UI và bản cài thật vẫn là cổng riêng.

## 2. Bất biến phải giữ

1. Với hai trim cell sát nhau và gap bằng 0, hai output clip phải dừng đúng tại cùng một seam; không được giao nhau và không được để hở.
2. Với gap `g`, mỗi phía chỉ được tràn tối đa `min(bleed, g/2)` về phía ô kề.
3. Chỉ cạnh thật sự lộ ra ngoài tập placement mới được nhận full bleed; `blockId`/product identity không được quyết định cạnh hình học.
4. Thứ tự paint không được làm thay đổi nội dung nhìn thấy trong trim của placement khác.
5. Nếu PDF cần canonicalize mà canonicalization thất bại, job phải dừng có lỗi tiếng Việt; không được dùng file thô để xuất tiếp.

## 3. Trace dọc luồng live

### 3.1 UI và payload

- Frontend chỉ gửi khổ tờ, bleed, gap, lề, layout và số lượng tại `desktop/src/lib/processHandlers.ts:295-412`.
- Frontend không gửi `clipMask`, `clip_mask` hoặc `blockId`; vì vậy transport UI không tạo rectangle clip lỗi.
- Preview lấy cell backend rồi vẽ hình SVG màu qua `renderCellShape` tại `desktop/src/components/imposition-tools/sections/GridPreview.tsx:686,3604`. Nó không render artwork PDF, không thực thi source/output clip và không mô phỏng thứ tự paint. Vì vậy preview vẫn sạch khi PDF thật có white overpaint.

### 3.2 Planner và materialize placement

- `/nup-start` chuyển settings vào N-Up tại `backend/app/api/routes/imposition.py:920-1129`.
- `nup_engine.py:2454-2562` đọc khổ thành phẩm từng trang, tạo plan `mixed_guillotine` và materialize placements.
- `mixed_guillotine_adapter.py:175-217`, đặc biệt dòng `198`, gán `cell["blockId"] = product_id`.

### 3.3 Tính clip và ghi PDF

- Trước bản vá, worker tính bbox riêng theo khóa `(cluster_idx, blockId)`; `place_one_artwork()` coi mọi cạnh trùng bbox block là mép ngoài và nở full bleed.
- Sau bản vá, `nup_artwork.compute_output_clips()` giải bốn cạnh theo láng giềng placement trên **toàn bộ output sheet** bằng sweep + range-max index `O(N log N)`, không quét mọi cặp và không thêm hard cap.
- Gap 0 dừng hai clip tại cùng seam; gap `g` cho mỗi phía tối đa `min(bleed, g/2)`; cạnh không có láng giềng giữ full bleed. Projection được nới bảo thủ để clip chữ nhật không chui vào trim của placement chỉ chạm/gần góc.
- `_CLIP_COORD_EPSILON_PT = 0.01 pt` hấp thụ sai số cộng/làm tròn dưới điểm in tại seam. Dung sai chỉ quyết định có nhận ra láng giềng hay không; khoảng cách vẫn được tính bằng tọa độ thật, nên khe dương rất nhỏ `0.005 pt` vẫn được chia đúng `0.0025 pt` mỗi phía thay vì bị ép về 0.
- `nup_process_chunk.py` chỉ dùng đường mới khi `not is_die_cut and not page_sheet_mode`, tính một lần mỗi tờ rồi truyền `output_clip` tường minh vào từng placement. Tem bế/CNC và Page Sheet tiếp tục dùng hợp đồng bbox block cũ.
- Sentinel riêng trong `place_one_artwork()` phân biệt “không truyền override” với override `None` khi bleed bằng 0; các consumer legacy không đổi hành vi.
- `pdf_ops.py:598-639` chuyển rectangle sang `re W n` đúng tọa độ. Writer không tự nới clip và không phải nguồn của overlap.

`nup_artwork.compute_block_bbox()` được giữ làm API legacy cho Tem bế/CNC và consumer ngoài phạm vi. Bình cắt xén thường không còn dùng bbox block để quyết định ownership clip.

## 4. Tái hiện artifact đúng ca 2 A5 → A4

### 4.1 Fixture và settings

PDF nguồn có hai trang:

- MediaBox `154 × 216 mm`;
- trim nội dung `148 × 210 mm`;
- bleed `3 mm` mỗi cạnh, được tô nền trắng opaque;
- trim trang 1 màu đỏ, trim trang 2 màu xanh để nhìn rõ ownership.

Settings live:

- tờ A4 ngang `297 × 210 mm`;
- `layoutType=mixed_guillotine`, `gridStrategy=optimal_auto`;
- bleed UI `3 mm`;
- `gapX=gapY=splitGap=0`;
- số lượng mỗi trang bằng 1.

Artifact chẩn đoán nằm tại:

- `C:\Users\Khanh Pham\AppData\Local\Temp\prynx_audit_a5_mixed\two_a5_bleed.pdf`;
- `C:\Users\Khanh Pham\AppData\Local\Temp\prynx_audit_a5_mixed\two_a5_mixed_out.pdf`;
- `C:\Users\Khanh Pham\AppData\Local\Temp\prynx_audit_a5_mixed\two_a5_mixed_out.png`.

### 4.2 Bằng chứng content stream

Output có đúng một tờ và hai lệnh `Do`:

```text
Trang 1: -7.0860 -8.5035 436.5354 612.2835 re W n
Trang 2: 412.4416 -8.5035 436.5354 612.2835 re W n
```

Suy ra:

- clip trang 1 kết thúc tại `429.4494 pt`;
- clip trang 2 bắt đầu tại `412.4416 pt`;
- hai clip overlap `17.0078 pt = 6 mm = 2 × bleed`;
- seam trim đúng nằm tại `x ≈ 420.9455 pt`;
- trang 2 paint sau, nên bleed trắng bên trái của nó phủ `8.5039 pt = 3 mm` vào trim đỏ.

### 4.3 Bằng chứng raster

Raster PDFium scale 4, đo trên hàng giữa và kiểm liên tục theo chiều cao:

```text
đỏ   : pixel x = 5..1649
trắng: pixel x = 1650..1683  (34 px ≈ 8,5 pt = 3 mm)
xanh : pixel x = 1684..3362
```

Dải trắng không phải anti-alias một pixel; nó rộng đúng bleed UI và kéo dài toàn seam.

### 4.4 Negative control

Chạy cùng fixture và cùng settings hình học nhưng đổi `layoutType=sequential`:

```text
clip trang 1 kết thúc tại x = 420.9455 pt
clip trang 2 bắt đầu tại x = 420.9455 pt
raster: đỏ x=5..1683, xanh x=1684..3362, không có pixel trắng ở seam
```

Negative control chứng minh source Form, PageBox và writer có thể tạo seam kín; lỗi xuất hiện khi ownership được chia theo hai `blockId` của `mixed_guillotine`.

### 4.5 Artifact hồi quy sau bản vá

Regression dùng lại đúng fixture hai trang A5 có bleed trắng opaque trên A4 ngang và kiểm hai tầng:

- content stream có hai `re W n` gặp nhau tại seam trim `x = 148,5 mm`, không overlap; hai mép ngoài vẫn nhận đủ bleed `3 mm`;
- raster trang PDF thật không còn dải trắng `3 mm` trong dải dò quanh seam, chỉ cho phép dung sai anti-alias tối đa bốn pixel gần trắng;
- unit test riêng khóa khe dương `4 pt` được chia `2 pt` mỗi phía và khóa ca hai placement chạm góc không để clip chữ nhật đi vào trim của placement kia;
- `test_output_clips_tolerate_sub_point_rounding_overlap_at_zero_gap` khóa ca hai cạnh đáng lẽ cùng seam nhưng lệch/chồng nhau dưới `0.01 pt` sau cộng và làm tròn; control khe dương `0.005 pt` vẫn giữ đúng nửa khe mỗi phía.

### 4.6 Kiểm chứng trên đúng PDF nguồn của người dùng

Nguồn được định danh mà không ghi đường dẫn Desktop cá nhân:

- tên file: `Adjusted page size 1.pdf`;
- SHA-256: `E7D9B7EC5849416CD5F6A77BF936387263F1397D21F0A5D63926B98E0AF2F691`;
- 8 trang đồng nhất, khổ khoảng `145 × 205 mm`;
- MediaBox và CropBox có gốc khác 0; TrimBox, BleedBox và ArtBox không được khai báo;
- SHA-256 của nguồn không đổi sau toàn bộ lượt chạy.

Public `run_nup_engine()` đã được gọi trực tiếp theo hai cấu hình có mục đích khác nhau:

1. `mixed_guillotine`, bleed `3 mm`: probe chẩn đoán ownership trên chính nội dung khách;
2. `sequential`, bleed `2 mm`, gap `0`: đúng route mà planner chọn cho nguồn 8 trang đồng nhất.

Cả hai cấu hình đều tạo 4 tờ A4 và mỗi tờ có đúng 2 lệnh `Do`. Ở cả 4 tờ của route `sequential`, hai interval clip theo trục x là:

```text
[(15.5908, 420.9455), (420.9455, 826.3002)] pt
```

Hai clip gặp nhau đúng tại `x = 420.9455 pt`, không overlap và không hở. Raster quanh seam cho thấy:

- tờ 2: phía trái màu cam có `0/23` pixel trắng; phía phải vốn là vùng trắng của source có `23/23` pixel trắng;
- tờ 3: phía trái vốn là vùng trắng của source có `22/23` pixel trắng; phía phải màu cam có `0/23` pixel trắng.

Việc vùng màu cam vẫn sạch ở phía thuộc ownership của nó trong cả hai thứ tự nội dung chứng minh rằng, trong output sau bản vá, phần trắng chỉ nằm đúng phía placement có source trắng; không có Form kề paint xuyên seam. Canonicalization của file này thành công dù Media/Crop có gốc khác 0; kết quả đó không đóng `§CANONFAIL.1`, vì finding độc lập này chỉ xảy ra khi canonicalization bắt buộc **thất bại** rồi N-Up fail-open.

## 5. Vì sao lỗi chỉ xuất hiện ở một số trường hợp

Overlap hình học tồn tại khi:

1. hai placement kề nhau thuộc `blockId` khác;
2. bleed UI lớn hơn 0;
3. khoảng tách giữa hai block nhỏ hơn bleed theo hướng đó;
4. vùng bleed của Form vẽ sau có nội dung opaque — thường là nền trắng.

Nếu bleed trong suốt, rectangle vẫn overlap nhưng Form vẽ sau không xóa artwork trước nên mắt thường có thể không thấy. Thứ tự paint giải thích vì sao chỉ một trong hai trang bị “lòi trắng”.

Một cơ chế thứ cấp giải thích vì sao lỗi còn mang tính “một vài trường hợp”: planner lưu nhiều trường hình học độc lập rồi cộng lại, nên hai cạnh đáng lẽ cùng seam có thể lệch/chồng nhau vài phần nghìn point sau vòng serialize/deserialize. Dung sai cũ `1e-6 pt` quá nhỏ làm sweep bỏ sót láng giềng ở đúng các tọa độ chịu sai số này và cạnh lại nhận full bleed. Dung sai `0.01 pt` nhỏ hơn nhiều một pixel in đã khóa ca hiếm đó, đồng thời không nuốt khe dương thật.

Bleed UI hiện mặc định `2 mm` tại `desktop/src/components/imposition-tools/store/slices/marksSlice.ts:61` và khi mở file mới chỉ tự thay nếu detector trả giá trị lớn hơn 0 tại `ImposerDashboard.tsx:1108-1136`. Đây là điều kiện khuếch đại có thật, nhưng việc có nên reset bleed về 0 theo file mới là quyết định UX riêng; chưa gắn nó thành nguyên nhân gốc khi chưa chốt ý nghĩa persistence.

File khách có Media/Crop/Trim/BleedBox không đồng nhất vẫn có thể làm màu trắng nguồn dễ lộ hơn. Tuy nhiên backend cố ý dùng bleed UI làm nguồn sự thật và không để TrimBox ghi đè lựa chọn này; không được báo riêng việc bỏ TrimBox là bug.

## 6. Finding

### §CLIPOWN.1 `[FIXED]` — P1 / effort M

**Mô tả:** cạnh hình học được phân loại theo bbox của từng `(cluster, block)` thay vì theo láng giềng placement trên toàn tờ. Ranh giới giữa hai product trở thành “mép ngoài” cho cả hai phía.

**Thiệt hại:** artwork trong trim bị thay bằng bleed/nền trắng của trang khác. Đây là lỗi artifact sản xuất, không chỉ sai preview hoặc report.

**Reachability:** UI `mixed_guillotine` → product `blockId` → bbox block → `cell_out_clip` → `re W n` → Form vẽ sau. Ca A5 thật đã đi qua toàn bộ đường live.

**Bằng chứng:** content stream overlap `6 mm`; raster mất đúng `3 mm` trim trên toàn seam; negative control sequential sạch.

**Bản sửa:** `compute_output_clips()` tính ownership theo láng giềng toàn tờ với độ phức tạp `O(N log N)`; worker gate đúng `not is_die_cut and not page_sheet_mode` và truyền override clip tường minh. Dung sai seam `0.01 pt` khóa sai số cộng/làm tròn của các ca hiếm mà không nuốt khe dương `0.005 pt`. Regression A5 → A4 đã khóa content stream + raster; unit test khóa gap dương, full outer bleed, corner-touch và tiny-overlap tại gap 0.

**Trạng thái verify:** `13 passed` khi chạy riêng file regression; `32 passed` khi chạy nhóm mixed export + adapter + logical CropBox. Hai lượt có chồng lấp, không cộng thành 45 test độc lập. Compatibility rộng đạt `89 passed` cho mixed/logical + clip-shape/cut-border/page-fallback/homogeneous và `44 passed` cho CNC + sheet-plan parity; lượt 44 chạy ngoài sandbox vì Windows named pipe. Review độc lập đối chiếu parity với brute-force trên `15.800` cấu hình; probe synthetic đạt khoảng `0,34 s` cho 10k placement và `1,44 s` cho 40k placement. Warning Pydantic là cảnh báo baseline cũ, không phát sinh từ bản vá. Đúng PDF nguồn khách đã đạt `EXACT CUSTOMER ARTIFACT VERIFIED` qua public `run_nup_engine()`: 4 tờ A4, 2 `Do`/tờ, clip gặp seam chính xác và raster không cross-paint. Chưa nâng `RUNTIME` vì chưa thao tác lại trên app/installer thật.

### §CANONFAIL.1 `[CONFIRMED]` — P1 / effort S

**Mô tả:** `canonicalize_page_space_file()` tại `backend/app/workers/page_space_canonicalization.py:93-142` bắt mọi exception rồi trả `(source_path, False)`. `run_nup_engine()` tại `nup_engine.py:261-272` dùng file đó mà không kiểm việc canonicalization bắt buộc đã thất bại.

**Vi phạm hợp đồng:** `docs/PAGE_BOX_FIXES_2026-08-04.md:51-56` chốt lỗi chuẩn hóa hoặc `/Rotate` không hợp lệ phải dừng an toàn. `PlanExecutor` đã có guard tương ứng tại `backend/app/core/plan_executor.py:137-155`; N-Up chưa có.

**Probe:** nguồn `200 × 100 pt`, `/Rotate=45`. Engine log “bỏ qua canonicalize; dùng file gốc” rồi vẫn tạo `rotate45_out.pdf` `935 byte`. Form output có `/Matrix [1 0 0 1 0 0]`, tức góc không hợp lệ bị bỏ im lặng.

**Quan hệ với lỗi A5:** finding này độc lập, không tạo dải trắng trong fixture A5 chuẩn. Nó có thể gây sai khổ/vị trí trên PDF có `/Rotate`, `/UserUnit` hoặc gốc MediaBox đặc biệt khi canonicalization lỗi.

Đúng file khách có gốc Media/Crop khác 0 đã canonicalize thành công trong lượt kiểm chứng trên; đây là positive control của đường thành công, không kiểm tra và không khép hành vi fail-open khi canonicalization lỗi.

### §CLIPPREVIEW.1 `[CONFIRMED][PROOF GAP]`

Preview chỉ là sơ đồ placement nên không thể bắt white overpaint, source clip hoặc paint order. Không dùng ảnh preview sạch làm bằng chứng PDF artifact sạch. Regression phải parse content stream và raster PDF thật.

## 7. Các giả thuyết đã loại trừ hoặc giữ mở

| Giả thuyết | Trạng thái | Bằng chứng |
|---|---|---|
| Writer phát sai toán tử clip PDF | `[DISPROVED]` | `pdf_ops.py` phát đúng rectangle đầu vào; rectangle ownership đã sai từ trước |
| UI gửi `clipMask` sai | `[DISPROVED]` | payload không có clip/mask/block identity |
| Chênh ISO `2 × A5 = 296 mm` so với A4 `297 mm` tạo seam | `[DISPROVED]` | phần dư 1 mm được căn ra hai mép ngoài; fixture sequential sạch tại seam |
| Cut border gây dải trắng | `[DISPROVED]` | mặc định tắt và khi bật chỉ thêm stroke vector sau artwork |
| Fit/Actual size của N-Up gây co trang | `[DISPROVED]` | `scaleMode` thuộc Booklet, không nằm trong N-Up settings |
| PageBox khác thường tự gây cross-paint sau bản vá | `[NOT REPRODUCED FOR SUPPLIED SOURCE]` | đúng nguồn có gốc Media/Crop khác 0 đã canonicalize thành công; 4 tờ đều có clip kín seam và raster không cross-paint. Artifact sau sửa không đủ để phủ nhận mọi tương tác lịch sử, và không được dùng để đóng `§CANONFAIL.1` |

## 8. Kiểm thử và khoảng trống coverage

Baseline audit trước bản vá:

```text
28 passed, 1 warning
backend/tests/test_mixed_guillotine_export.py
backend/tests/test_mixed_guillotine_adapter.py
backend/tests/test_nup_logical_cropbox.py
```

Ma trận backend mở rộng liên quan PageBox/clip từng đạt `41 passed`; test frontend liên quan payload/guillotine từng đạt `99 passed`. Đây là bằng chứng baseline, không được cộng vào kết quả verify sau bản vá.

Verify sau bản vá, theo từng lệnh độc lập:

```text
.\backend\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider backend/tests/test_mixed_guillotine_export.py
13 passed

.\backend\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider backend/tests/test_mixed_guillotine_export.py backend/tests/test_mixed_guillotine_adapter.py backend/tests/test_nup_logical_cropbox.py
32 passed
```

Lệnh 32 test đã bao gồm 13 test của file regression; hai số không được cộng. Không cập nhật snapshot/golden.

Review độc lập còn chạy oracle brute-force trên `15.800` cấu hình và không thấy lệch parity. Benchmark synthetic của helper đạt khoảng `0,34 s` với 10k placement và `1,44 s` với 40k placement; đây chưa phải benchmark runtime app đầy đủ.

Compatibility evidence bổ sung, không cộng dồn mơ hồ với các lượt trên:

- `89 passed`: mixed/logical + clip-shape, cut-border, page-fallback và homogeneous;
- `44 passed`: CNC + sheet-plan parity, chạy ngoài sandbox vì Windows named pipe;
- warning Pydantic quan sát được là cảnh báo cũ của baseline, không do Lô 1 sinh ra.

Khoảng trống còn lại:

1. PDF nguồn thực tế đã được verify; chưa có PDF kết quả lỗi lịch sử để so sánh byte/raster trước–sau trên cùng output;
2. chưa thao tác lại trên app/installer thật;
3. gap dương, tiny-overlap do làm tròn và corner-touch đã được khóa ở mức unit; ca xoay block, `splitGap` dương và hình L vẫn chưa có artifact riêng;
4. đã có parity brute-force và benchmark synthetic tới 40k placement; benchmark end-to-end trong runtime app vẫn chưa chạy.

## 9. Tình trạng triển khai theo lô

### Lô 1 — sửa nguyên nhân trực tiếp, 3 file — hoàn tất

1. `backend/app/workers/nup_artwork.py`: thêm `compute_output_clips()` theo láng giềng hình học toàn tờ, sweep/index `O(N log N)`; gap 0 gặp đúng seam, gap `g` chia tối đa `g/2` mỗi bên; giữ full bleed ở cạnh thực sự lộ, xử lý corner-touch bảo thủ và dùng dung sai seam `0.01 pt` cho sai số làm tròn dưới điểm in.
2. `backend/app/workers/nup_process_chunk.py`: tính ownership một lần mỗi tờ Bình cắt xén thường, gate `not is_die_cut and not page_sheet_mode`, truyền clip tường minh vào placement; giữ đường legacy cho Tem bế/CNC/Page Sheet.
3. `backend/tests/test_mixed_guillotine_export.py`: khóa fixture 2 A5 opaque-white bleed trên A4 bằng content stream + raster; thêm unit gap dương, outer bleed, corner-touch và tiny-overlap tại seam gap 0.

Không đổi `blockId=product_id` vì identity này còn phục vụ plan/marks. Không vá `pdf_ops.py` vì writer đang đúng. Chi tiết thay đổi và bằng chứng nằm tại `docs/BINH_CAT_XEN_LOI_TRANG_RANH_GIOI_FIXES_2026-09-01.md`.

### Lô 2 — khôi phục fail-closed PageBox, 3 file — chưa duyệt/chưa sửa

1. `backend/app/workers/page_space_canonicalization.py`: trả lỗi/raise có cấu trúc thay vì nuốt lỗi bắt buộc.
2. `backend/app/workers/nup_engine.py`: dừng N-Up khi source cần chuẩn hóa nhưng không tạo được file canonical.
3. `backend/tests/test_preview_export_canonical_parity.py`: regression `/Rotate=45`, lỗi ghi file canonical và `/UserUnit`/origin; assert không có output im lặng.

### Sau mỗi lô

- chạy pytest hẹp rồi ma trận PageBox/N-Up liên quan;
- parse `re W n` và `Do` của PDF thật;
- raster seam ở nhiều scale/DPI, không dùng preview SVG làm oracle;
- không cập nhật golden nếu hình học thay đổi ngoài mục tiêu;
- Lô 1 xong mới cân nhắc thay đổi UX bleed/preview trong một audit unit riêng.

## 10. Chốt duyệt

Người dùng đã duyệt và Lô 1 đã hoàn tất ở mức `AUTO + ARTIFACT`; đúng PDF nguồn khách cũng đã đạt `EXACT CUSTOMER ARTIFACT VERIFIED` qua public engine với source hash không đổi, seam kín và raster không cross-paint. Chưa gọi `RUNTIME` vì chưa thao tác qua UI/app hoặc installer thật; nếu có PDF kết quả lỗi lịch sử thì vẫn nên đối chiếu trước–sau trên cùng output. Lô 2 `§CANONFAIL.1` độc lập vẫn giữ `P1 MỞ`, chưa được phép sửa; canonicalization thành công của file khách không đóng finding fail-open này.
