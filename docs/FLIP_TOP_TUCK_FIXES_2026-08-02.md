# NHẬT KÝ TRIỂN KHAI — FLIP TOP TUCK

Ngày: 2026-08-02
Chủ đề: thêm loại hộp `flip_top_tuck` từ `khuon-01.svg`.

## 1. Hợp đồng đã chốt

- `boxType`: `flip_top_tuck`
- Generator: `generateFlipTopTuckBox`
- Variant/code: `ftt_self_lock` / `PRYNX-FTT-01`
- Preset: `L=200`, `W=200`, `D=60`, `T=0,5`, `C=0,5` mm
- Cấu trúc: 13 panel, 12 CREASE, một CUT ngoài kín, bảy CUT hở có chủ đích
- Bbox fixture: `(-60, -20) → (261, 519,5)`, kích thước `321 × 539,5 mm`

## 2. Các lô đã thực hiện

| Lô | Thay đổi | Verify hẹp |
|---|---|---|
| A | Hợp đồng, hằng số, generator, dispatch và export | Generator/geometry/export test đạt |
| B | Catalog, store, form, i18n, runtime validation TS | Store/form/variant/typecheck đạt |
| C | Allow-list Python/Rust và route feature gate | `16 passed`; Rust `5 passed` |
| D | Contour, bleed, property hình học, CUT/CREASE đặc thù | Toàn bộ `src/lib/dieline`: `574 passed`, `2 skipped` |
| E | Golden master, regression, shared geometry, diện tích gần đúng | `48 passed` với `--update=none`; chỉ hai tệp snapshot dieline đổi |
| F | Wiring mặt in cap âm Z và động học 13 panel | `86 passed` cho UI/store/mockup3d |
| G | Thumbnail và bundle sidecar | `3 passed`; build Vite + WebView check đạt |
| H | Phản hồi ảnh: chú thích điểm, BLEED và bo vai `#25/#34` | Test hẹp `108 passed`; toàn bộ dieline `577 passed`, `2 skipped` |

## 3. Fix phát hiện trong lúc verify

### §FTT.2 — Outline vách trước nắp

Property test với ca co nhỏ `60×60×10, T=3` chứng minh hai pivot khóa góc lệch outline cha `2,8735 mm`. Nguyên nhân: outline `lid_front` dùng bù nắp `T` ở cạnh trên, làm hai biên bên bị xéo. Đã sửa outline về `x=0→B`; CUT/CREASE 2D không đổi. Sau sửa, test hình học chạy thêm nhiều seed đều đạt.

### §FTT.5 — Chú thích PDF

`buildDimensionSvg` trước đây cho loại chưa biết rơi về nhánh RTE và ghi sai `G` cùng bốn mặt thân. Đã thêm nhánh `flip_top_tuck` đo trên panel thật và chỉ ghi `L/W/D`; test khóa không xuất hiện nhãn `G`.

### §FTT.2 — Mặt in 3D

Renderer chỉ chuyển cap âm Z cho pizza/tray/double-tray. Đã thêm `flip_top_tuck` và test wiring để artwork ngoài hướng ra ngoài sau gấp.

## 4. Ma trận verify cuối

- `npm run typecheck`: đạt.
- `npx vitest run src/lib/dieline`: `29` file đạt, `577` test đạt, `2` skipped.
- Test UI/store/3D chọn lọc: `5` file, `86/86` đạt.
- Geometry property test: chạy lặp thêm hai seed độc lập, mỗi lượt `43/43` đạt.
- Golden master ở chế độ không ghi: `2` file, `48/48` đạt.
- Backend venv pytest: `16/16` đạt.
- `cargo check`: đạt; `cargo test dieline_request`: `5/5` đạt.
- `npm run gen:variant-thumbs`: `3/3` đạt và chỉ thêm `PRYNX-FTT-01.svg`.
- `npm run build:dieline-sidecar`: đạt; `npm run check:dieline-webview`: đạt.
- `git diff --check`: đạt.
- Lint toàn repo: bị chặn bởi backlog ngoài phạm vi (`1461` lỗi, `106` cảnh báo); generator mới chạy riêng đạt lint.

## 5. Kiểm tra trực quan và giới hạn

- Thumbnail 2D đã raster hóa, đối chiếu với hai ảnh tham chiếu và đúng thứ tự/cấu trúc tổng thể.
- Phiên `localhost:5173` tải được nhưng chưa đăng nhập bản quyền, nên nút công cụ PRO không mở. Không bypass đăng nhập.
- Cần kiểm tay trong phiên đã đăng nhập: kéo fold `0→100%`, quan sát bốn khóa góc/lid_front và xuất PDF đo lại `200 × 200 × 60 mm`.

## 6. Bảo toàn thay đổi ngoài phạm vi

Các thay đổi song song ở API/combine/logo và `backend/scratch/` không thuộc đợt này; không sửa, không stage, không commit.

## 7. Sửa theo phản hồi ảnh ngày 2026-08-03

- [VERIFIED] Bổ sung sáu chú thích A–F cho các mốc bản lề nắp, đầu khe khóa hông,
  đỉnh lưỡi khóa giữa và tâm khe nhận phía trước. Nút DEV `Chú thích điểm` đã có dữ liệu.
- [VERIFIED] Hai cung debug `#25/#34` trước đây truyền góc sắc ảo làm tâm cho
  `arcToBezier`, khiến tiếp tuyến bị xoay 90° và tạo vết khuyết. Tâm cung đã được
  dời đúng một bán kính; endpoint và bbox giữ nguyên, chỉ control point đổi.
- [VERIFIED] BLEED của `flip_top_tuck` nay ưu tiên contour CUT ngoài khép kín đã
  sample Bezier, không còn lấy outline panel 3D giản lược rồi đi tắt qua các cung.
- [VERIFIED] Golden master được cập nhật đúng hai cung chủ đích; thumbnail catalog
  và bundle sidecar đã sinh lại. Typecheck, lint bốn tệp sửa, `29` file dieline
  (`577 passed`, `2 skipped`) và `70/70` test UI/3D chọn lọc đều đạt.

## 8. Sửa chiều gập và đường khuôn 3D ngày 2026-08-03

- [VERIFIED] §FTT.9 đổi đúng panel `Y2→Y3` thành đáy gốc, panel `Y0→Y1`
  thành nắp; cây gập mới là đáy → vách sau `−90°` → nắp `−90°`.
- [VERIFIED] Mọi CUT ngoài, khe và relief đã thuộc panel tương ứng; outline 3D
  lấy mẫu trực tiếp từ Bezier nên bo, lưỡi khóa và mép nắp bám khuôn 2D.
- [VERIFIED] §FTT.10 đặt CUT/CREASE 3D lên cap `−T/2` khi mặt ngoài dùng
  `outerFaceNegativeZ`, thay vì luôn đặt nhầm trên cap `+T/2`.
- [VERIFIED] Fixture `200×200×60` đóng nắp trùng tâm đáy ở cao độ `60 mm`;
  cả 13 panel dựng thành solid kín, không có cạnh hở hoặc cạnh phi-manifold.

## 9. Khoét rãnh cài xuyên solid 3D ngày 2026-08-03

- [VERIFIED] §FTT.11 chuyển hai khe khóa hông và khe nhận khóa trước từ CUT
  centerline thuần túy thành ba vòng khoét hẹp `0,6 mm` chỉ dành cho solid 3D.
  Khuôn 2D, kích thước CUT và golden master không đổi.
- [VERIFIED] Đường kỹ thuật mặc định tắt không còn làm mất dấu rãnh: ba khe vẫn
  xuyên sáng qua giấy và có tường cạnh do `ExtrudeGeometry` dựng tự động.
- [VERIFIED] Raycast xuyên tâm cả ba khe không chạm cap; fixture và 100 bộ tham
  số ngẫu nhiên giữ geometry khép kín. Property test được chạy độc lập ba lượt.
- [VERIFIED] Render headless trực tiếp từ generator + `buildPanelSolid` đã soi
  rõ hai khe dọc ở cánh đáy và khe ngang ở mép trước nắp.
