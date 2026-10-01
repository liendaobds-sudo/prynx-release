# Audit hộp cứng nam châm (PRYNX-RMB-01) — 2026-10-01

## Phạm vi và mức bằng chứng

Audit unit: tạo mẫu `rigid_magnetic` với `L=220, W=160, D=60, T=2`, xem khuôn 2D, gập 3D và xuất/nesting PDF.

Đường chạy đã trace:

`ParamPanel.tsx` → `useBoxStore`/`generateDieline()` → `engine.ts` → `generateRigidMagneticBox()` → `DielineCanvas2D`/`DielineScene3D` → `exportPDF.ts`/`productionPDF.ts`/`exportNestingPDF.ts`.

Bằng chứng hiện đạt `TRACED + ARTIFACT-PROBE`; chưa chạy thao tác trên Tauri dev/release và chưa có mẫu cắt vật lý của xưởng. Các finding dưới đây đã được tự kiểm tra lại bằng source và probe, không chỉ suy từ snapshot.

## Đối chiếu quy cách thực tế

Hộp dạng magnetic closure book-style thực tế gồm khay greyboard bốn vách và một cover riêng gồm back/lid/front flap; các tấm cover có khe bản lề được bắc bởi giấy áo và giấy lót. Nam châm thường nằm trong pocket/blind hole, được phủ bởi wrap/liner. Mép áo thường 10–20 mm; greyboard thường 1,5–3 mm. Nguồn tham khảo: [Custom Boxez — Magnetic closure boxes](https://customboxez.co.uk/packaging/styles/magnetic-closure-boxes) (phần “How it is built”, “Magnets set into the board”, “Wrap, turn-ins and overhang”). Đây là căn cứ cấu tạo, không phải công thức bù phổ quát cho mọi vật liệu.

## Phát hiện đã xác nhận

### §RMB.1 — P0 — Xuất nesting dùng sai model và bỏ mảnh cover

**[CONFIRMED — source + artifact probe]**

- Engine đã coi RMB là hộp hai mảnh và tính riêng khay/bìa tại `desktop/src/lib/dieline/engine.ts:60-76, 365-377`.
- Nhưng nút xuất trong `desktop/src/components/dieline-tool/DielineTool.tsx:222-228, 520-533` chỉ nhận `tray|double_tray`; RMB rơi vào `buildNestingPdfBlob(dieline, nestingResult, ...)` và `downloadProductionNestingPDF(dieline, nestingResult, ...)`.
- Hai helper `desktop/src/lib/dieline/exportNestingPDF.ts:355-358` và `desktop/src/lib/dieline/productionPDF.ts:142-145` cũng chỉ split `tray`/`double_tray`; `trayParts.ts:29` từ chối RMB.
- Vì vậy vị trí tính cho khay được dùng để vẽ **toàn model nguyên cụm**. Cover result không được đưa vào output.

Probe PDF `docs/audit/RMB_NESTING_PROBE_2026-10-01.pdf` dùng `result.nestingResult` của khay: PDF có 3 placement nhưng bounds tới `x=1310 mm` trên trang rộng `1090 mm`, có **87 điểm ngoài trang**. Ảnh render cho thấy mỗi placement chứa khay và cover chồng/cắt ra ngoài khổ.

**Ảnh hưởng:** file nesting không thể dùng để làm khuôn sản xuất.

### §RMB.2 — P0 — Split làm mất lỗ nam châm và đường áo bồi

**[CONFIRMED — source + probe]**

- Generator thêm cung lỗ nam châm vào `allPaths` tại `RigidMagneticBox.ts:141-144, 257-260`, nhưng `panel.paths` của `tray_front`/`cover_flap` tại `:150, 266` không chứa chúng.
- `splitRigidMagneticDieline()` tại `RigidMagneticBox.ts:422-432` dựng `allPaths` mới bằng `panels.flatMap(p => p.paths)`, nên các cung lỗ biến mất.
- Tám đoạn `BLEED` giấy áo tại `RigidMagneticBox.ts:361-380` chỉ nằm ở `model.allPaths`, không thuộc panel nào; split cũng làm mất toàn bộ.

Preset probe đo được:

| Model | CUT | CREASE | BLEED |
|---|---:|---:|---:|
| Gốc | 38 | 7 | 8 |
| Split khay | 12 | 8 | 0 |
| Split bìa | 10 | 6 | 0 |

Split chỉ còn 22 CUT thay vì 38, tức mất 16 cung Bezier của bốn lỗ nam châm; đường áo 15 mm cũng mất.

**Ảnh hưởng:** PDF tách mảnh không có pocket nam châm và không có biên wrap cần để bồi giấy.

### §RMB.3 — P1 — Ba pivot bản lề cover lệch cạnh hình học 5 mm

**[CONFIRMED — source + probe]**

`spineGap = 2*T + 1` tại `RigidMagneticBox.ts:87`, bằng 5 mm với preset.

- `cover_flap`: nếp thật `creaseFlap` ở `yFlapTop`, nhưng `pivotEdge` lại ở `yTopBot` (`:246-247, 270`).
- `cover_top`: nếp thật `creaseTop` ở `yTopTop`, nhưng `pivotEdge` ở `ySpineBot` (`:284-299`).
- `cover_spine`: nếp thật `creaseSpine` ở `ySpineTop`, nhưng `pivotEdge` ở `yCoverBaseBot` (`:310-325`).

Probe `docs/audit/RMB_EVIDENCE_2026-10-01.json` đo khoảng cách pivot tới outline của cả ba panel là `[5,5]` mm.

**Ảnh hưởng:** 3D gập quanh đường không phải cạnh chung; cover có thể bay, tạo khe hoặc chồng sai. Đây là vi phạm bất biến pivotEdge của `prynx-dieline`.

### §RMB.4 — P1 — Generator không tạo cấu trúc góc V-groove/corner stay thật

**[CONFIRMED — source]**

Comment đầu file mô tả “4 góc phay rãnh chữ V”, nhưng `RigidMagneticBox.ts:101-106` chỉ tạo bốn đường CREASE hình chữ nhật quanh đáy; các vách tại `:128-212` là các tấm chữ nhật với ba cạnh CUT. Không có đường vát chéo/miter, relief góc, corner stay/tape allowance hay biên dạng V-groove.

Nguồn cấu tạo độc lập mô tả tray greyboard được V-groove/score ở góc, dựng lên và giữ bằng corner stay tape. Vì vậy model hiện chỉ là sơ đồ panel chữ nhật, chưa phải khuôn vật liệu carton lạnh có góc gia công.

**Ảnh hưởng:** cắt/phay thực tế không có thông tin để tạo góc hộp cứng; 3D chỉ mô phỏng một khay giấy gập.

### §RMB.5 — P1 — Vị trí pocket nam châm có thể nằm ngoài vật liệu mà không cảnh báo

**[CONFIRMED — source + probe]**

- Công thức tâm pocket dùng `yTrayBot - magnetOffset` và `yFlapBot + magnetOffset` tại `RigidMagneticBox.ts:135, 251`.
- `validateParams.ts:65-71` chỉ clamp độc lập; không kiểm `offset`, `diameter/2` với `D`, `flapH`, mép và khoảng cách giữa hai pocket.
- UI cho phép `flapH=20`, `offset=50`, `Ø25` (`ParamPanel.tsx:633, 688-689`).

Probe đi qua `generateDieline()` → `validateParams()` cho thấy `warnings=[]` trong các ca:

- `D=10, Ø10, offset=12`: lỗ khay chạy `y=-7..3`, vượt vách `y=0..10`.
- `D=60, flapH=20, offset=50, Ø10`: lỗ tai chạy `y=-29..-19`, nằm hoàn toàn ngoài tai.
- `Ø25, offset=10`: lỗ vượt biên panel ở cả khay và tai.

**Ảnh hưởng:** pocket có thể bị cắt thủng/đứt khỏi phôi; artifact vẫn qua validation vì validator chỉ kiểm contour tổng.

### §RMB.6 — P1 — `rigidTurnIn=15` bị thay thành bleed mặc định 3 mm khi export

**[CONFIRMED — source + probe]**

- Generator ghi biên áo bồi 15 mm dưới tag `BLEED` tại `RigidMagneticBox.ts:361-380`.
- `withBleedPaths()` xóa BLEED cũ và dựng lại bleed mặc định tại `bleedContours.ts:370-379`.
- Export gọi hàm này tại `exportPDF.ts:73-74` và `productionPDF.ts:86, 102`.

Probe đo:

- model gốc: BLEED bbox `x=350..604, y=-96.5..376.5`;
- sau `withBleedPaths`: BLEED bbox `x=-3..592, y=-84.5..364.5`.

Tám nét áo bồi gốc bị thay bằng 70 đoạn bleed 3 mm. `rigidTurnIn` không còn được bảo toàn trong PDF.

**Ảnh hưởng:** artwork/wrap die-line không cung cấp mép bồi theo thông số RMB.

## Coverage gap đã xác nhận

**[CONFIRMED]** Generator đã được import vào `geometry.test.ts:53-70`, `contourValidator.test.ts:34-79` và `legend.test.ts:35-51`, nhưng bị bỏ khỏi các mảng thực chạy tại `geometry.test.ts:73-78`, `contourValidator.test.ts:528-534`, `legend.test.ts:54-59`. Vì vậy các property test không chạy RMB.

`generators.test.ts:1249-1339` chỉ kiểm panel count, tên parent, góc 90°, số hole và số panel sau split; không kiểm export, pivot-to-crease, hole containment, corner geometry hay magnet pair alignment.

Đã chạy các suite liên quan: **211 passed, 0 failed** (40,35 giây). Kết quả này không phủ được các bất biến nêu trên vì coverage registry bị thiếu.

## Findings cần xác nhận thêm

### §RMB.7 — P1 — Mô hình vật tư chưa tách đủ core/wrap/liner/pocket

**[SUSPECTED — cần chốt spec vật liệu với người dùng/xưởng]**

`DielineModel` chỉ có CUT/CREASE/BLEED, panel outline và hole. Các nguồn cấu tạo thực tế tách greyboard core, outer wrap, inner liner, pocket/blind hole và corner stay. Cần xác nhận sản phẩm muốn xuất:

1. khuôn greyboard;
2. khuôn giấy áo ngoài;
3. giấy lót trong;
4. bản đồ pocket nam châm (blind hole/milling, không mặc định CUT xuyên);
5. ghi chú bồi/gập và vật liệu khác nhau cho khay/bìa.

Không dùng finding này để tự chọn công thức kích thước trước khi có mẫu/spec xưởng.

## Đề xuất lô sửa sau khi duyệt

### Lô A — chặn artifact sai (tối đa 5 file)

1. Sửa split để giữ path lỗ và wrap đúng mảnh, hoặc đưa chúng vào cấu trúc sở hữu rõ ràng.
2. Nối `rigid_magnetic` vào `DielineTool`, `NestingCanvas`, `exportNestingPDF`, `productionPDF` để khay/bìa dùng đúng kết quả nesting.
3. Thêm hậu kiểm kích thước/placement và test artifact PDF.

### Lô B — bất biến hình học 2D/3D (tối đa 5 file)

1. Chốt lại định nghĩa cạnh hinge và sửa ba `pivotEdge` về cạnh CREASE chung thật.
2. Bổ sung guard pocket containment, count chỉ nhận 0/1/2 và cảnh báo khi pocket không nằm trong panel.
3. Bổ sung hình học góc V-groove/relief theo mẫu xưởng được duyệt; không suy công thức từ thumbnail.

### Lô C — test và vật tư (tối đa 5 file)

1. Đưa RMB vào tất cả registry/property tests.
2. Thêm fixture độc lập (SVG/PDF hoặc mẫu đo) cho một kích thước chuẩn.
3. Nếu cần xuất sản xuất, mở rộng schema để phân biệt core/wrap/liner/pocket và ghi rõ blind-hole vs through-cut.

## Kết luận

Mẫu RMB ở thời điểm audit ban đầu **NO-GO cho xuất khuôn sản xuất**. Có lỗi P0 đã được chứng minh ở nhánh nesting/export và lỗi P1 ở split, pivot, pocket boundary và vật liệu góc. Snapshot/generator tests xanh chỉ chứng minh model hiện tại tự nhất quán ở mức cấu trúc đơn giản; chưa chứng minh khuôn đúng quy cách thực tế.

## Cập nhật triển khai sau khi được duyệt — 2026-10-01

Đã sửa và kiểm chứng các phần có bằng chứng đủ:

- **Lô A:** split giữ cung CUT của lỗ nam châm và 8 cạnh BLEED áo bồi; `withBleedPaths()` không thay áo bồi RMB bằng bleed mặc định; export kỹ thuật/sản xuất và preview nesting đi đúng nhánh khay + bìa; phân loại path preview và split engine không còn phụ thuộc object identity sau JSON.
- **Lô B:** ba `pivotEdge` của bìa trùng mép CREASE thật; validator kẹp đường kính/tâm pocket để vòng lỗ nằm trong vách và tai.
- **Kiểm chứng:** `src/lib/dieline` — **599 passed, 2 skipped**; test tương tác `NestingCanvas` — **4 passed**; `tsc --noEmit` — xanh; `git diff --check` — không lỗi.

Chưa tự suy thêm biên dạng V-groove/corner stay hoặc schema core/wrap/liner/pocket vì chưa có bản vẽ xưởng được duyệt. Bundle sidecar native chưa được sinh lại trong lượt này; cần chạy `npm run build:dieline-sidecar` trước dev/release tiếp theo để runtime native nhận source mới.
