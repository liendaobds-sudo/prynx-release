# Báo cáo audit điều khiển làm mượt đường bế — 2026-08-10

## 1. Kết luận điều hành

Bốn điều khiển hiện tại **đều được nối vào engine thật** và preview dùng cùng nhóm
Bézier với PDF xuất. Tuy nhiên, “có hoạt động” không đồng nghĩa “hoạt động đúng và
dễ hiểu”. Audit xác nhận:

- `Độ mượt` có tác dụng rõ nhất: trên đúng ảnh 9 tem, nó giảm 2.610 xuống 624 đoạn
  cubic và giảm dao động độ cong từ 1.874 xuống 336 lần đổi dấu. Đổi lại, sai lệch
  hình học không đơn điệu; mức 100% lệch tối đa khoảng 1,235 mm so với biên tham
  chiếu.
- `Bám sát hình gốc` có vùng chết lớn ở nguồn 72 DPI. Trên file khách, mức 0%, 25%
  và 50% tạo đúng cùng một path. Mức 100% tăng lên 1.673 đoạn nhưng vẫn không đạt
  ngân sách bám sát được yêu cầu ở một số tem vì engine âm thầm chọn fallback rộng
  hơn.
- `Sức căng` chỉ đổi tay nắm Bézier, không đổi node. Trên file khách, hai cực chỉ làm
  quỹ đạo đổi tối đa khoảng 0,148 mm, nhưng độ nhảy curvature lớn nhất tăng từ
  25,657 lên 83,054 /mm. Nó có thể làm chuyển động giật hơn dù hình nhìn gần như
  không đổi.
- `Lọc chi tiết rời` đúng là lọc **component tách rời theo mm²**; nó không xóa râu,
  bóng hoặc gợn còn dính vào tem chính. Trên file khách, 0,5–5,0 mm² cho cùng kết
  quả, còn mức 0 tạo PDF thật có 4.586 đoạn, 338 đoạn dưới 0,25 mm và 728 khớp vượt
  1°.
- Với hình sao và khe lõm 300 DPI, mọi vị trí của ba thanh hình học rơi về cùng
  `safe-fallback`; các thanh hoàn toàn mất tác dụng. PDF thật của sao có 3 đoạn ngắn
  nhất 0,070 mm và 15 khớp vượt 1°; khe lõm có 6 đoạn ngắn nhất 0,133 mm và 17
  khớp vượt 1°. Tên `safe-fallback` không phản ánh đúng artifact cuối.

Vì vậy, cấu hình trong ảnh chụp `Mượt 100 / Căng 83 / Bám sát 50 / Lọc 1 mm²`
không phải một cấu hình “tối ưu chung”. Trên file 9 tem nó tạo 624 cubic, không có
đoạn dưới 0,25 mm, nhưng dịch quỹ đạo tối đa 1,231 mm so với biên tham chiếu. Phần
lớn thay đổi đến từ `Độ mượt 100%`; `Sức căng 83%` chỉ làm 6/9 tem đổi dưới 0,01 mm,
ba tem còn lại đổi khoảng 0,10–0,113 mm.

## 2. Phạm vi và nguồn sự thật

Audit unit: **người dùng kéo bốn thanh trong preview ảnh AI nhiều tem → nhìn đường
bế → xuất PDF → đọc lại lệnh `/CutContour` thật**.

Baseline:

- HEAD: `89a9048d1d5eb71d64171e8c9195782da064d36a`;
- working tree đang có nhiều thay đổi chưa commit từ các phiên khác; audit không
  reset, không ghi đè và chưa sửa hành vi production;
- session thật:
  `C:\Users\Khanh Pham\AppData\Local\Temp\PrynX-dev\results\sticker_sheet_sessions\b56d1bbe4d0c440f8c06b6d36aa1c144`;
- 9 tem, 1.313 × 1.198 px, xấp xỉ 72 DPI;
- `labels.npy` SHA-256
  `EF7620E829829F3CC325C1605998F15F372BC0E115CF857BBCD56C5488B5FDDC`;
- `rgba.png` SHA-256
  `CBD1966D55FFFA23CBE9556C9F5BDBDE916267DF2DA9117DE5B20F29CC24195C`.

Hai hash trên trùng tuyệt đối với session
`fe28a85f97624eb184feb9f31dbc7427` đã dùng ở lượt đo preview trước, nên đây là
cùng mask/ảnh đã được người dùng thử, không phải fixture thay thế.

Bộ đối chứng tổng hợp chạy ở 72 và 300 DPI gồm: tròn, chữ nhật bo góc, sao, hoa 12
cánh, khe lõm hẹp, hình có lỗ, bốn mảnh rời 0,2–4,0 mm² và biên gợn có râu dính.

Các số đo:

- số lệnh cubic/path/component/lỗ;
- Hausdorff so với `ideal_geometry` sau marching-squares + offset và trước fairing;
- thay đổi diện tích, chu vi và topology;
- đoạn dưới 0,25 mm, node hở, khớp vượt 1°;
- độ nhảy curvature và số lần đổi dấu curvature;
- fingerprint path, độ nhạy giữa các nấc và parity preview/PDF.

Ngưỡng 0,25 mm và 1° là oracle hiện có của chính PrynX, không được tuyên bố là
chuẩn chung cho mọi máy bế vật lý.

## 3. Trace dọc từ UI tới PDF thật

| Mắt xích | Bằng chứng live |
|---|---|
| UI | `StickerSheetPanel.tsx:275–320` dựng bốn slider và gọi `setCutlineTuning`. |
| State | `stickerSheetStore.ts:956–1009` ghi bốn giá trị; `:1600–1668` đưa chúng vào request tuần tự. |
| Desktop API | `stickerSheetApi.ts:343–350` đổi sang bốn field snake_case. |
| Schema | `backend/app/schemas/sticker_sheet.py:218–232` nhận 0–100 và 0–25 mm². |
| Route | `backend/app/api/routes/sticker_sheet.py:370–404` gọi worker preview live. |
| Chuẩn bị biên | `sticker_engine.py:3900–3996` marching-squares, lọc component, offset theo mm và giữ topology/lỗ. |
| Fit live | `sticker_engine.py:3656–3853` lọc Gaussian, simplify, spline C2/G1, Hausdorff và motion guard. |
| Fallback | `sticker_engine.py:4040–4075` dựng fallback nhưng không chạy lại motion guard cuối. |
| Preview | `sticker_cutline_preview.py:225–315` gọi đúng helper trên từng tem và trả SVG path. |
| Export | `sticker_sheet_export.py:385–431` gọi cùng helper, đưa `path_groups` vào `alpha_path_overrides`. |
| Writer | `sticker_engine.py:7241–7253` khôi phục override và ghi thẳng Bézier vào `/CutContour`. |

Kết luận trace: không có “slider giả” và không có fitter thứ hai ở frontend. Preview
và PDF cùng thuật toán. Vì vậy, lỗi hình học đo ở helper preview cũng đi vào artifact
cuối; bốn PDF đối chứng đã được xuất và parse lại để xác minh điều này.

## 4. Phân biệt các khái niệm đang bị trộn trong UI

### 4.1 Smooth Tool

Adobe mô tả Smooth Tool là thao tác **cục bộ**: người dùng quét lên đoạn path cần
làm mượt, có thể quét lặp lại; trục điều khiển là `Accurate ↔ Smooth`. Kéo về Accurate
giữ độ phức tạp, kéo về Smooth giảm anchor và irregularity. Đây là một trade-off duy
nhất, không phải ba thanh toàn cục độc lập.

Nguồn: [Adobe — Adjust path smoothness](https://helpx.adobe.com/ca/illustrator/desktop/draw-shapes-and-paths/modify-paths/adjust-path-smoothness.html).

### 4.2 Simplify

Simplify giảm anchor trong khi giữ hình gần path gốc. Adobe tách riêng `Corner Point
Angle Threshold`, cho xem `Original/New`, số anchor trước/sau và live preview. Điểm
quan trọng là corner thật có chính sách riêng; không ép mọi góc thành smooth join.

Nguồn: [Adobe — Simplify paths advanced options](https://helpx.adobe.com/au/illustrator/desktop/draw-shapes-and-paths/modify-paths/simplify-paths-advanced-options-overview.html).

### 4.3 Offset Path

Offset tạo một đường song song cách path gốc một khoảng vật lý vào trong/ra ngoài;
nó có `Joins` và `Miter limit`. Offset **không phải** thuật toán làm mượt. PrynX đang
để `offset_mm` tách khỏi bốn slider và buffer trước bước fit, về khái niệm là đúng.

Nguồn: [Adobe — Offset Path](https://helpx.adobe.com/uk/illustrator/desktop/manage-objects/edit-objects/offset-duplicate-objects.html),
[Clipper2 — ClipperOffset](https://angusj.com/clipper2/Docs/Units/Clipper.Offset/Classes/ClipperOffset/_Body.htm).

Clipper2 cũng cảnh báo các đoạn cực ngắn/redundant có thể tạo blemish khi offset và
nên được dọn trước hoặc giữa các lần offset. Việc dọn ở đây phải là loại bỏ đoạn vô
nghĩa trong dung sai rất nhỏ, không phải làm mượt toàn bộ silhouette trước khi offset.

### 4.4 Smoothing spline và fitting Bézier

SciPy định nghĩa tham số `s` của smoothing spline là trade-off giữa residual và độ
mượt; giá trị lớn hơn cho đường mượt hơn. Đây là ràng buộc tổng bình phương có trọng
số, không tự bảo đảm sai lệch cực đại hay giữ góc. Vì vậy PrynX vẫn cần Hausdorff,
normal-error, topology và corner constraint ở ngoài spline.

Nguồn: [SciPy — make_splprep](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.make_splprep.html).

Potrace đưa ra kiến trúc phù hợp hơn cho outline raster: polygon tối ưu → điều chỉnh
vertex → phân loại corner/smooth → chỉ gộp các đoạn cong kề nhau cùng chiều lồi/lõm
và chỉ nhận khi qua tolerance. Corner và đoạn thẳng không bị gộp như curve thường.

Nguồn: [Peter Selinger — Potrace technical paper](https://potrace.sourceforge.net/potrace.pdf).

Thuật toán Schneider là một hướng khác: fit cubic Bézier thích nghi theo sai số,
chia tại điểm lỗi lớn nhất và fit lại. Nó phù hợp để dùng **giữa các corner đã khóa**,
thay vì giảm node đồng loạt.

Nguồn: [Philip J. Schneider — An Algorithm for Automatically Fitting Digitized Curves](https://lhf.impa.br/cursos/tmg/Schneider-1990.pdf).

## 5. Số đo trên đúng ảnh 9 tem

### 5.1 Độ mượt

Giữ `Bám sát = 50`, `Sức căng = 50`, `Lọc = 1 mm²`:

| Độ mượt | Cubic | Max Hausdorff tới biên gốc | Đổi dấu curvature | Đoạn <0,25 mm | Khớp >1° |
|---:|---:|---:|---:|---:|---:|
| 0% | 2.610 | 1,122 mm | 1.874 | 0 | 0 |
| 25% | 1.362 | 1,163 mm | 832 | 0 | 0 |
| 50% | 915 | 1,014 mm | 488 | 0 | 0 |
| 75% | 661 | 1,129 mm | 368 | 0 | 0 |
| 100% | 624 | 1,235 mm | 336 | 0 | 0 |

Nó thật sự giảm complexity/oscillation, nhưng độ bám không đơn điệu. Nguyên nhân là
một thanh đang đồng thời đổi ba đại lượng tại `sticker_engine.py:3685–3697`:

1. sigma của low-pass Gaussian;
2. tolerance của polygon simplify;
3. RMS của periodic smoothing spline.

Do ba phép biến đổi phản ứng khác nhau theo shape và DPI, “mượt hơn” không bảo đảm
“lệch tăng đều” hoặc “ít node tăng đều” trên mọi hình.

### 5.2 Bám sát hình gốc

Giữ ba giá trị còn lại ở mặc định:

| Bám sát | Cubic | Max Hausdorff | Đổi dấu curvature | Fingerprint so với mặc định |
|---:|---:|---:|---:|---|
| 0% | 915 | 1,014 mm | 488 | giống tuyệt đối |
| 25% | 915 | 1,014 mm | 488 | giống tuyệt đối |
| 50% | 915 | 1,014 mm | 488 | baseline |
| 75% | 992 | 0,763 mm | 524 | khác |
| 100% | 1.673 | 0,707 mm | 958 | khác |

Tại 72 DPI, `pixel_mm ≈ 0,353`. Công thức `sticker_engine.py:3682–3684` tạo
`source_budget = 1,2 mm`; các giá trị bám sát từ 0 đến khoảng 48% đều bị clamp về
cùng 1,2 mm. Trên chính file này, candidate ở 50% cũng vẫn nằm trong cùng envelope,
nên 0/25/50 tạo đúng một path.

Ở 100%, ngân sách yêu cầu theo công thức là khoảng 0,42 mm, nhưng một số tem không
có candidate vừa C2/machine-safe vừa đạt mức đó. Code tại `:3841–3852` chọn fallback
trong envelope tuyệt đối lớn hơn mà không báo UI; max thực tế là 0,707 mm.

### 5.3 Sức căng

| Sức căng | Cubic | Đổi tối đa so với 50% | Đổi dấu curvature | Max curvature jump |
|---:|---:|---:|---:|---:|
| 0% | 915 | 0,148 mm | 494 | 24,069 /mm |
| 25% | 915 | 0,074 mm | 492 | 24,069 /mm |
| 50% | 915 | 0 | 488 | 25,657 /mm |
| 75% | 915 | 0,074 mm | 488 | 42,273 /mm |
| 100% | 915 | 0,148 mm | 486 | 83,054 /mm |

Implementation tại `sticker_engine.py:3370–3456` chỉ co/giãn đều tay nắm quanh
node rồi tiến dần về 1 nếu guard hình học từ chối. Nó giữ G1 nhưng không giữ C2; kết
quả đo cho thấy mức “căng” cao làm curvature jump tăng mạnh trong khi hình đổi rất ít.
Đây không tương đương Smooth Tool hay Simplify.

### 5.4 Lọc chi tiết rời

| Ngưỡng | Component xuất | Cubic | Component bị bỏ | Đoạn <0,25 mm | Khớp >1° |
|---:|---:|---:|---:|---:|---:|
| 0 mm² | 24 | 4.586 | 0 | 338 | 728 |
| 0,5 mm² | 9 | 915 | 15 | 0 | 0 |
| 1,0 mm² | 9 | 915 | 15 | 0 | 0 |
| 2,0 mm² | 9 | 915 | 15 | 0 | 0 |
| 5,0 mm² | 9 | 915 | 15 | 0 | 0 |

Code tại `sticker_engine.py:3929–3955` chỉ lọc exterior polygon độc lập theo diện
tích. Đối chứng `attached_noise` cho path giống tuyệt đối giữa 0 và 5 mm² vì râu vẫn
nối với component chính. Điều này đúng với tên “rời”, nhưng UI không nói rõ nó không
phải khử bóng/răng cưa dính biên.

## 6. Artifact hình học khác

### Sao 72 DPI

Nhánh live-bezier ép tất cả join dưới 1°, nên các corner thật bị bo trong envelope.
Mặc định lệch tối đa 0,972 mm; `Bám sát 100` vẫn lệch 0,874 mm. Ảnh overlay:

`../.tmp/sticker_cutline_audit/control_sensitivity_2026-08-10/overlay_star_72dpi.png`

### Sao 300 DPI

Không candidate C2/G1 nào qua điều kiện “mọi join <1°”, nên tất cả slider về cùng
`safe-fallback`. PDF cuối:

- 15 cubic;
- 3 đoạn dưới 0,25 mm, ngắn nhất 0,070 mm;
- 15 join vượt 1°, lớn nhất 138,42°;
- mọi mức mượt/bám sát/căng có cùng geometry.

Một phần corner là chủ đích của ngôi sao; lỗi ở đây không phải “có corner”, mà là
engine không phân loại corner được bảo vệ và lại phát sinh đoạn cực ngắn trong nhánh
được gọi là safe.

### Khe lõm 300 DPI

Tất cả slider cũng về cùng fallback:

- 17 cubic;
- 6 đoạn dưới 0,25 mm, ngắn nhất 0,133 mm;
- 17 join vượt 1°, lớn nhất 106,72°.

### Điểm tốt đã xác minh

- Hình tròn, chữ nhật bo, hoa và lỗ không đổi số component/lỗ trong ma trận đã chạy.
- File 9 tem ở mặc định 50/50/50/1 tạo PDF 915 cubic, 0 đoạn ngắn, 0 node hở,
  0 join vượt 1°, đoạn ngắn nhất 0,656 mm.
- Preview/PDF parity đúng: PDF dùng lại `path_groups`, không fit lại bằng solver khác.
- 10 test hiện có của `test_sticker_cutline_tuning.py` và
  `test_sticker_cutline_preview.py` đều xanh. Đây đồng thời chứng minh coverage hiện
  tại chưa bắt được sharp-shape fallback và đầu mút `Lọc = 0`.

## 7. Finding đã xác nhận

| Mã | Trạng thái | Mức | Effort | Phát hiện |
|---|---|---:|---:|---|
| §CUTSMOOTH.1 | `[FIXED LÔ A]` | P1 | M | Mọi live/retension/fallback đã qua chung final oracle; sao/khe lõm chuyển sang fallback bảo toàn góc và không còn short segment. |
| §CUTSMOOTH.2 | `[MITIGATED LÔ A]` | P1 | M | `Lọc = 0` vẫn tồn tại để Lô B xử lý UX, nhưng artifact không an toàn nay fail-closed; đúng ảnh khách chặn 5/9 tem lỗi thay vì xuất PDF 4.586 cubic. |
| §CUTSMOOTH.3 | `[CONFIRMED]` | P2 | M | `Độ mượt` trộn Gaussian + simplify + spline RMS; complexity giảm nhưng sai lệch hình học không đơn điệu và có thể vượt 1,2 mm. |
| §CUTSMOOTH.4 | `[PARTIAL LÔ A]` | P2 | M | Response đã trả sai lệch thực/fit mode; vùng chết và tính đơn điệu của slider còn thuộc Lô B. |
| §CUTSMOOTH.5 | `[CONFIRMED]` | P2 | S | `Sức căng` tác động yếu, shape-dependent và có thể tăng curvature jump hơn 3×; tên/nhãn không mô tả được tác dụng thật. |
| §CUTSMOOTH.6 | `[PARTIAL LÔ A]` | P2 | S | Backend đã trả số component bị bỏ; attached noise và cách giải thích trên UI còn thuộc Lô B/C. |
| §CUTSMOOTH.7 | `[CONFIRMED]` | P2 | S | Khi có Cutline preview, `StickerSheetWorkspace.tsx:550,575,657` ẩn biên pixel gốc; người dùng không thể bật “Show Original” để so đường mới với quỹ đạo đã duyệt. |
| §CUTSMOOTH.8 | `[PARTIAL LÔ A]` | P2 | S | Đã khóa high-DPI star/notch, offset âm, fallback cuối và export không refit; monotonicity toàn ma trận còn thuộc Lô B. |

## 8. Giải pháp đề xuất

Không giải bằng “giảm node thêm” hoặc “cho nhiều node hơn”. Hai hướng đó chỉ đổi
biểu hiện. Pipeline nên là:

1. Giữ `reference contour` bất biến theo đúng mask đã duyệt.
2. Lọc component rời theo mm²; dọn cạnh zero/redundant trong dung sai nhỏ.
3. Phân loại corner thật bằng turning angle + độ dài support + tính bền qua nhiều
   scale; khóa corner/cusp trước khi smooth.
4. Offset theo mm với join/miter policy; offset vẫn là một chức năng độc lập.
5. Chia ring thành các cung smooth tại corner đã khóa.
6. Fit cubic thích nghi trên từng cung với hard max-deviation/normal-error; chỉ gộp
   các cung cùng convexity và không vượt tolerance, theo tinh thần Potrace/Schneider.
7. Xếp hạng candidate theo topology → corner preservation → max deviation → short
   command → curvature variation; số node chỉ là tiêu chí phá hòa sau cùng.
8. Chạy **một final oracle trên path thực sẽ ghi PDF**, gồm cả fallback và retension.
   Không candidate nào đạt thì giữ kết quả an toàn gần nhất đã preview hoặc báo cần
   xem lại; tuyệt đối không phát path chưa kiểm chỉ để export thành công.

### UI đề xuất

- Thanh chính duy nhất: `Mượt ↔ Bám sát`, giống mô hình Accurate ↔ Smooth của
  Illustrator. Backend trả mức sai lệch thực đạt được, không chỉ giá trị yêu cầu.
- Preset: `Tự động`, `Giữ góc/logo`, `Hình hữu cơ`; preset chỉ chọn policy, không
  thay reference contour.
- Bỏ `Sức căng` khỏi UI chính. Nếu giữ ở mục nâng cao, đổi tên thành
  `Độ dài tay nắm Bézier` và chỉ mở khi có trường hợp thực sự cần.
- `Chi tiết rời`: mặc định `Tự động`, hiển thị “Đã bỏ 15 mảnh dưới 0,5 mm²”. Tùy
  chọn `Không lọc` phải có cảnh báo và vẫn phải qua final machine oracle.
- Luôn có toggle `Biên gốc / Đường bế / Chồng hai đường`; có thể thêm heatmap sai
  lệch. Không ẩn reference ngay khi Cutline xuất hiện.
- Trạng thái đơn giản: `Đạt kiểm tra đường chạy` / `Cần xem lại`; phần nâng cao mới
  hiện max deviation, corner bảo vệ, component bị bỏ và số lệnh.
- Smooth Tool kiểu Illustrator, nếu làm, nên là **cọ cục bộ trên một đoạn path** và
  vẫn bị khóa trong envelope; không nên giả lập bằng một thanh tension toàn cục.

## 9. Kế hoạch sửa theo lô

### Lô A — Chặn artifact không an toàn, tối đa 5 file

1. `sticker_engine.py`: final oracle sau mọi candidate/fallback/retension; thêm corner
   classification tối thiểu và không phát fallback chưa kiểm.
2. `sticker_cutline_preview.py`: trả quality metadata thật.
3. `schemas/sticker_sheet.py`: schema cho `effective_deviation`, `fit_mode`,
   `dropped_components`, `machine_safe`, `protected_corners`.
4. `test_sticker_cutline_tuning.py`: khóa detail=0 và tension/fidelity saturation.
5. `test_sticker_cutline_preview.py`: khóa star/notch 72/300 DPI và preview/PDF
   final-path parity.

Điều kiện qua lô A: không short segment ngoài corner được bảo vệ; không node hở;
fallback phải có cùng oracle với live candidate; nếu không đạt thì fail-closed có lý
do tiếng Việt.

### Lô B — Tách đúng Smooth/Simplify/Corner, tối đa 5 file

1. Refactor fitter thành reference → corner anchors → smooth runs → adaptive cubic.
2. Dùng candidate frontier để trục `Mượt ↔ Bám sát` đơn điệu theo max-deviation.
3. Chỉ merge smooth run cùng convexity, không merge qua corner.
4. Thêm ma trận circle/rounded/star/flower/heart/gear/notch/hole/attached-noise ở
   72/150/300 DPI và 20/50/500/1600 mm.
5. Xuất/parse PDF thật và khóa motion metric trên từng artifact.

### Lô C — UI dễ hiểu, tối đa 4 file

1. `StickerSheetPanel.tsx`: một thanh chính, preset và trạng thái chất lượng.
2. `StickerSheetWorkspace.tsx`: overlay biên gốc + đường bế, toggle so sánh.
3. `stickerSheetStore.ts`: giữ requested/effective setting riêng, không giả vờ đã áp
   mức mà backend phải nới.
4. Test UI/API tương ứng; giữ luồng thumbnail nhiều trang hiện tại.

## 10. Artifact và cách tái hiện

- Số đo đầy đủ:
  `.tmp/sticker_cutline_audit/control_sensitivity_2026-08-10/control_sensitivity.json`
- PDF/content-stream metrics:
  `.tmp/sticker_cutline_audit/control_sensitivity_2026-08-10/artifacts/export_artifacts.json`
- PDF thật:
  `.tmp/sticker_cutline_audit/control_sensitivity_2026-08-10/artifacts/`
- Overlay:
  `.tmp/sticker_cutline_audit/control_sensitivity_2026-08-10/overlay_*.png`
- Harness:
  `.tmp/sticker_cutline_audit/audit_control_sensitivity.py`,
  `.tmp/sticker_cutline_audit/export_control_failure_artifacts.py`.

Verify đã chạy:

```text
backend/venv/Scripts/python.exe -m pytest \
  tests/test_sticker_cutline_tuning.py \
  tests/test_sticker_cutline_preview.py -q

10 passed, 1 warning có sẵn từ Pydantic config
```

## 11. Chốt audit

Không sửa thuật toán trước khi được duyệt. Khuyến nghị duyệt **Lô A trước**, vì đây
là chốt correctness: mọi đường đi, kể cả fallback và đầu mút slider, phải qua cùng
oracle trước khi preview/export. Sau đó mới gộp lại mô hình điều khiển và làm UI theo
Smooth/Simplify đúng nghĩa.

## 12. Kết quả triển khai Lô A — 2026-08-10

Đã triển khai sau khi được duyệt:

- final quality oracle chạy sau live candidate, retension, fallback bảo toàn góc,
  adaptive fallback và fallback legacy;
- join trên 1° chỉ được miễn khi ghép một-một với góc reference bền qua hai thang
  đo; đoạn dưới 0,25 mm và path hở luôn bị từ chối;
- preview trả metadata thật theo từng tem và toàn trang: fit mode, sai lệch thực,
  đoạn ngắn, node hở, góc được bảo vệ, góc giả và component bị lọc;
- preview đổi lỗi hình học thành 422 tiếng Việt; export thiếu override phải dừng,
  không còn âm thầm gọi fitter khác;
- offset âm tiếp tục qua cùng oracle và có adaptive fallback riêng cho Polygon.

Số đo PDF content stream sau sửa:

| Mẫu | Cubic | Đoạn <0,25 mm | Khớp hở | Góc thật được giữ | Đoạn ngắn nhất |
|---|---:|---:|---:|---:|---:|
| Sao 300 DPI | 10 | 0 | 0 | 10 | 17,542 mm |
| Khe lõm 300 DPI | 11 | 0 | 0 | 11 | 4,951 mm |
| Ảnh khách, mặc định, 9 tem | 915 | 0 | 0 | 0 | 0,656 mm |

Artifact mới nằm tại
`.tmp/sticker_cutline_audit/cutline_lot_a_2026-08-10/`.

Verify cuối:

```text
py_compile 4 file production: pass
test_sticker_cutline_tuning.py + test_sticker_cutline_preview.py: 15 passed
sticker sheet/API/export: 76 passed
test_sticker_engine_e2e.py: 129 passed
git diff --check: pass
```

Lô A không tuyên bố đã sửa semantics của ba slider. §CUTSMOOTH.3–7 còn lại phải
đi tiếp qua Lô B/C; đặc biệt `Bám sát = 0` vẫn cùng quỹ đạo mặc định trên mẫu khách.
