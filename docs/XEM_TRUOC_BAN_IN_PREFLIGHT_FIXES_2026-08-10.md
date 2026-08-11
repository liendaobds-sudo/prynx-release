# Tiến độ sửa Xem trước bản in / Preflight — 2026-08-10

Tài liệu này theo dõi các lô sửa đã được duyệt từ
`BAO_CAO_AUDIT_XEM_TRUOC_BAN_IN_PREFLIGHT_2026-08-10.md`.

> **Trạng thái mới nhất — 2026-08-10:** các ghi chú “chưa có Tauri runtime”,
> “Show/Preview deferred” và “E4 deferred” ở những lô lịch sử bên dưới đã được
> thay thế bởi Lô G và đợt nghiệm thu Tauri dev ở cuối tài liệu. Build/installer
> chưa chạy theo chỉ đạo của người dùng.

## Lô 1 — giảm lớp phủ và subscription thừa

- Giữ bitmap Viewer khi toàn bộ bản kẽm đang bật; chỉ dựng lớp phủ khi người dùng
  thay đổi tập bản kẽm.
- Bỏ các subscription Output Preview không được dùng trực tiếp ở
  `ImpositionTab` và `AcrobatViewer`.
- Verify tự động: 13 test Output Preview, typecheck và toàn bộ frontend đạt tại
  thời điểm chạy lô.
- Kết quả runtime: **không đạt**. Người dùng xác nhận thao tác mở panel vẫn tạo
  cảm giác reload; kết luận hoàn thành của lô này đã bị vô hiệu.

## Lô 1b — cô lập lifecycle của Viewer

Phạm vi: 4 file code/test, không thay backend hoặc engine render.

- `OutputPreviewHost.tsx`: chuyển subscription `showOutputPreview` sang consumer
  độc lập nằm cạnh Viewer. `ImpositionTabInner` không còn nhận thay đổi này, nên
  mở/đóng panel không làm shell chứa `AcrobatViewer` render lại.
- `useWorkspaceStore.ts`: các reset `[]`/`null`/`false` của Output Preview trở
  thành idempotent; cleanup lặp lại không đánh thức `LivePageFrame`. Đóng panel
  giữ nguyên reference mảng kẽm khi mảng đã rỗng.
- `OutputPreviewHost.test.tsx`: khóa hồi quy rằng mở và đóng panel không render
  lại shell, không render lại consumer kẽm, không remount Viewer; cleanup rỗng
  không phát store update.
- `ImpositionTab.tsx`: luôn mount host hẹp thay cho điều kiện đọc state tại shell.

### Verify

- Output Preview: `15 passed`.
- TypeScript: `tsc --noEmit -p tsconfig.app.json` đạt.
- ESLint hai file mới: đạt.
- Toàn frontend: `2.146 passed, 2 skipped, 1 failed`. Ca thất bại độc lập ở
  `StickerSheetPanel.test.tsx` vì test vẫn tìm slider `Độ bo cong đường bế` đã
  không còn trong UI hiện tại; chạy riêng vẫn thất bại giống hệt. Lô này không
  chạm module Sticker Sheet.

### Chốt runtime còn thiếu

Chưa được phép ghi “đã sửa hoàn toàn” cho tới khi chạy lại đúng chuỗi trong Tauri:
mở PDF thật → Preflight → **Xem trước bản in** và xác nhận Viewer không hiện spinner,
không mất bitmap trang, không đổi zoom/scroll và log không có lượt `[PDF-LOAD] start`
mới.

## Lô 1c — chặn Vite tự reload ở lần mở Web Worker đầu tiên

Trace runtime đã tách được hai lần thao tác liên tiếp:

- `09:01:52.664`: lần đầu bấm, `hasForm=false`; Viewer và trang vẫn cùng DOM
  identity, ảnh sẵn sàng, không có overlay trắng. JS context bị thay trước khi
  cửa sổ trace 5 giây kết thúc.
- `09:01:54`: Vite tạo `node_modules/.vite/deps/pako.js` lần đầu.
- `09:02:03.812`: bấm lần hai; trace chạy đủ `52` mẫu/5 giây và không reload.

`pako` chỉ được import bên trong `outputPreview.worker.ts`, nên Vite không phát
hiện ở startup từ `index.html`. Lần worker đầu tiên chạy, dependency optimizer
phát hiện bare import mới rồi reload dev page; lần sau cache đã ấm nên hoạt động.
Giả thuyết form-submit bị bác bỏ trực tiếp bởi `hasForm=false`.

Sửa tại `vite.config.ts`: thêm `pako` và `diff` (dependency còn lại chỉ xuất hiện
trong worker) vào `optimizeDeps.include`. `run_dev.bat` dùng `vite --force`, vì
vậy hai dependency được prebundle ngay khi dev server khởi động thay vì lúc user
mở tính năng lần đầu.

Verify tĩnh/tự động:

- Regression cấu hình `viteWorkerOptimizeDeps.test.ts`: đạt.
- Typecheck: đạt.
- Frontend production build: đạt, `3.546` module transformed; worker Output
  Preview được bundle thành artifact riêng.

Runtime cold-start đã được người dùng xác nhận đạt sau khi khởi động lại đầy đủ
`run_dev`: lần bấm đầu tiên không còn reload. Trace DOM/store tạm đã được gỡ sau
khi chốt nguyên nhân; chỉ giữ regression và cấu hình prebundle.

## Lô A — nguồn sự thật inventory, metadata, coverage và màu spot

Phạm vi code: 5 file, theo chốt parity `§OP.2`, `§OP.4`, `§OP.5`, `§OP.8`.

- `ink_manager.py`: thay regex chuỗi object bằng traversal thật qua Page Resources,
  Form XObject, Pattern và Shading; tách inventory toàn tài liệu/sự hiện diện theo
  trang; đọc Transparency Group, blending space và FunctionType 2/3 tint transform.
- Màu spot có alternate CMYK được quy sang sRGB bằng đúng ICC mô phỏng. Khi tint
  transform không đọc được, contract ghi rõ nguồn fallback thay vì giả vờ đó là màu
  từ PDF.
- Inventory metadata được cache theo path + size + mtime. Lần Save/Replace làm đổi
  identity nên cache cũ bị loại. Tier `<8 GB`/`<16 GB` giảm số tài liệu giữ nóng;
  máy `>=16 GB` tăng tuyến tính theo RAM, không có trần cố định.
- `facade.py`: giữ `coverage_pct` native, alternate CMYK, color source, inventory
  document/page, transparency và blending; spot không có trên trang hiện tại vẫn
  có metadata với coverage `0%`.
- `separations.py`: fallback trả cùng contract và toàn bộ render/traversal blocking
  được đưa khỏi event loop. Đường đo TAC không quét inventory tài liệu lặp O(n²).
- `/preflight/inks`: chạy traversal trong worker thread; Ink Manager dùng cùng một
  nguồn inventory với Output Preview.

### Artifact PDF khách

File SHA-256 `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184`:

```text
document colorants = C, M, Y, K, VietinBank Dark Blue, VTB RED, khuon be
page 1 spots       = VietinBank Dark Blue, VTB RED
page 3 spots       = khuon be
4/4 page           = Transparency / DeviceCMYK

SWOP spot RGB:
VietinBank Dark Blue = [0, 97, 150]
VTB RED              = [216, 46, 83]
khuon be              = [104, 189, 81]
```

Độ phủ native nay đi hết facade; probe trang 1 ở 36 DPI trả Dark Blue
`4,7624%`, VTB RED `0,0371%`, `khuon be=0%` vì không có trên trang.

### Hiệu năng và verify

- Cold inventory trên PDF khách: `255,43 ms`.
- Cache hit khi đổi trang: `0,36 ms`.
- Quy ba alternate CMYK qua ICC SWOP: trung bình `18,929 ms`.
- `py_compile` 5 file: đạt.
- Regression mới synthetic hai trang, trong đó spot trang 2 nằm trong Form XObject:
  `3 passed`.
- PPE/ICC/routing/API/overprint liên quan: `130 passed`.
- `git diff --check`: đạt; chỉ có cảnh báo line-ending LF→CRLF đã tồn tại theo
  cấu hình worktree.
- Ruff chưa chạy vì module không được cài trong `backend/venv`; không dùng Python
  global để tạo kết quả sai môi trường.

### Chốt runtime còn thiếu

Backend contract và artifact đã đạt. Cần smoke trên app thật sau auto-reload/restart:

1. mở PDF khách → Xem trước bản in;
2. header nhận 3 spot, trang 1 vẫn có 2 spot đang hiện diện;
3. swatch Dark Blue xanh đậm, VTB RED đỏ;
4. metadata báo `Trong suốt: Có`, blending `DeviceCMYK`;
5. Ink Manager liệt kê đủ 7 kênh.

Chưa chuyển Lô B trước khi smoke này đạt, để giữ đúng chốt mỗi lô của audit workflow.

## Lô B1 — đồng bộ Rendering Intent qua Separations/ICC

Phạm vi code: 5 file backend — `ink_manager.py`, `print_engine/facade.py`,
`separations.py`, route `preflight.py` và schema `preflight.py`.

- Endpoint Separations nhận thêm `intent` với cùng enum bốn giá trị như Viewer
  Accurate và Soft-Proof.
- PPE native nhận `render_intent`; alternate CMYK của spot được quy qua ICC với
  đúng intent đã chọn thay vì luôn Relative.
- Đường PDFium xấp xỉ và endpoint `separations-by-path` dùng cùng contract.

Verify: `py_compile` 5 file đạt; bộ PPE/ICC/API sau khi thêm regression đạt
`125 passed`.

## Lô B2 — một Simulation state theo workspace tab

Phạm vi code: 5 file — `useWorkspaceStore.ts`, `OutputPreviewTab.tsx`,
`SoftProofPanel.tsx` và hai locale Output Preview.

- `outputPreviewProfileId` và `outputPreviewRenderingIntent` nằm trong
  `WorkspaceContext`; mỗi `ImpositionTab` tạo một store riêng nên không có state
  profile xuyên tab.
- Profile và intent được đưa lên đầu panel, có lựa chọn hiển thị rõ; Separations
  gửi cả hai tham số; Soft-Proof nhận state controlled, không còn state cục bộ
  riêng.
- Profile mặc định vẫn là FOGRA39/Relative để không đổi hành vi âm thầm; người
  dùng có thể chọn SWOP v2 ngay tại khối Simulation.

Verify: typecheck đạt; regression state hai tab, Output Preview và i18n nằm trong
bộ frontend liên quan.

## Lô B3 — nối Simulation vào Viewer và identity cache

Phạm vi production: `AcrobatViewer.tsx`, `useTileRenderer.ts`,
`LivePageFrame.tsx`, `renderCoordinator.ts`; regression bổ sung khóa routing,
cache profile/intent và chuyển Simulation khi mở panel.

- FOGRA39 + Relative giữ đường native worker nhanh hiện tại.
- Profile/intent khác (ví dụ SWOP + Perceptual) đi thẳng `/preflight/viewer-accurate`
  với request body động; không thử worker native bị ghim FOGRA trước.
- `renderOwnerId`, generation, pipeline identity và accurate tile key đều mang
  profile/intent; bitmap của profile cũ không thể trả cho profile mới.
- Khi mở Output Preview trên trang detector xem là an toàn, `LivePageFrame` buộc
  PPE nhưng giữ bitmap đang đọc cho tới khi ảnh mới decode xong; không tháo Viewer
  cha, không chèn spinner vào lớp đang hiển thị.

Verify tự động:

- frontend typecheck đạt;
- bộ Viewer/Output Preview liên quan: `63 passed`;
- backend parity/ICC/PPE/cache/session/API: `161 passed`;
- probe PDF khách với SWOP + Perceptual: PPE, ba spot, `Transparency=True`,
  `DeviceCMYK`.

### Trạng thái sau Lô B

`§OP.8` đã đạt `AUTO` ở contract/state/cache và `ARTIFACT` trên probe thật.
`§OP.1` chỉ giảm một phần: all-on dùng bitmap color-managed; subset/solo vẫn còn
lớp CSS plate approximation cho tới Lô C/Lô 4. `§OP.9` (Overprint đúng nghĩa),
`§OP.10` (inventory Ink Manager runtime) và `§OP.11` (thứ tự section Acrobat) vẫn
mở cho các lô kế tiếp.

Chưa nâng bằng chứng lên `RUNTIME`: phiên làm việc này không có dev server/Tauri
đang chạy, nên chưa thao tác lại cold-open → chọn SWOP → đổi intent trên app thật.
Toàn frontend hiện có `2.156 passed, 2 skipped` và 4 ca đỏ độc lập ở
StickerCutline/Logo Rebuild đang có thay đổi khác trong worktree; không phải ca
thuộc Lô B.

## Lô C1 — Overprint đúng nghĩa và metadata cấu trúc

Phạm vi: route `preflight.py` và hai regression backend
`test_overprint_preview_ppe.py`, `test_ppe_facade.py`.

- Dựng knockout và overprint bằng cùng PPE/profile/intent; trả ảnh mô phỏng
  lossless PNG làm composite chính và giữ diff PNG thành artifact chẩn đoán.
- `page_has_overprint` chỉ đọc ExtGState được gọi thật bằng `gs`, lần theo Form
  XObject được gọi bằng `Do` và chặn vòng tham chiếu; không suy từ pixel diff hay
  từ resource chưa được dùng.
- PDF khách trang 1 trả `False` và diff 0; fixture spot Overprint thật cùng Form
  XObject lồng nhau bảo vệ hai nhánh dương tính.

Verify tập trung backend: `45 passed`, 1 warning Pydantic đã biết.

## Lô C2 — composite chính, chẩn đoán riêng và latest-only

Phạm vi: `OutputPreviewTab.tsx`, `SoftProofPanel.tsx`, regression
`OutputPreviewOverprint.test.tsx` và hai locale Output Preview — đúng 5 file.

- Nút Mô phỏng Overprint hiển thị `overprint_image`; checkbox “Hiện vùng thay
  đổi chẩn đoán” mới chuyển sang `diff_overlay` màu cam.
- Request dùng Simulation Profile/Intent đang chọn; Soft-Proof nhận cùng trạng
  thái Overprint.
- Generation + `AbortController` loại response stale. Đổi trang/profile/intent,
  hủy thao tác hoặc đóng Output Preview đều dọn overlay khỏi Viewer.

Verify sau cleanup cuối: typecheck đạt; 8 file test Output Preview/Viewer tập
trung `39 passed`; `git diff --check` đạt.

### Trạng thái sau Lô C

`§OP.9` đạt `AUTO`; probe PDF khách và fixture PDF đạt bằng chứng artifact cho
nhánh không/có Overprint. `RUNTIME` vẫn chờ smoke Tauri. Các khoảng trống còn lại
là `§OP.1` subset/solo composite, `§OP.10` shortcut/Ink Manager runtime và
`§OP.11` bố cục workflow thuộc Lô D.

## Lô D1 — section theo workflow và nhóm Process/Spot

Phạm vi 4 file: `OutputPreviewTab.tsx`, regression DOM
`OutputPreviewLayout.test.tsx` và hai locale.

- Thứ tự section: Simulation → Display → Separations → Sampling/TAC → Metadata
  → Advanced → Actions; Simulation và Separations mở mặc định.
- Process/Spot là hai nhóm độc lập. Checkbox nhóm chỉ thay đổi các kênh của nhóm
  đó; solo và số phủ mực tại điểm vẫn giữ nguyên.
- Mọi lệnh Spot → CMYK được chuyển khỏi danh sách kẽm xuống section “Sửa file”
  có màu cảnh báo và mô tả rõ đây là thao tác tạo PDF mới.
- Điều hướng trang và badge RIP/Xấp xỉ luôn nằm ở đầu panel.

Verify: typecheck đạt; vòng D1 `13 passed`.

## Lô D2 — route thật cho Ink Manager

Phạm vi đúng 5 file: `PreprocessingRouter.tsx`, `preprocessRouterTools.ts`,
`types.ts`, `toolRegistry.ts` và `toolPanel.test.ts`.

- Đăng ký `inkmanager` vào registry với capability `prepress.convert_colors`.
- Nối component `InkManagerTool` có sẵn vào router tiền xử lý; guard snapshot
  không còn coi đây là key lạ rồi trả về `none`.
- SSOT `WORKSPACE_TOOL_PANEL` và `PREPROCESS_ROUTER_TOOLS` được cập nhật cùng lô.

Verify: typecheck đạt; routing/registry/entitlement `24 passed`.

## Lô D3 — shortcut có guard và mở đúng panel

Phạm vi 4 file: `OutputPreviewTab.tsx`, regression DOM và hai locale.

- “Quản lý mực” mở `inkmanager`; “Đặt hộp trang” mở `crop`.
- Cả hai đi qua `useWorkspaceToolActivationGuard`, đóng Output Preview rồi mở
  panel phải; panel hẹp dưới 280 px được trả về 390 px giống menu công cụ chuẩn.
- Test khóa active tool, số lần đóng panel, trạng thái panel phải và điều hướng
  trang vẫn nhìn thấy khi Display đang thu gọn.

Verify cuối: typecheck đạt; vòng D3 `35 passed`; regression rộng 15 file
Viewer/Output Preview/routing/i18n `99 passed`; toàn frontend `2.161 passed,
2 skipped, 3 failed` với cả 3 failure thuộc mock StickerCutline ngoài phạm vi;
diff/whitespace check đạt.

### Trạng thái sau Lô D

`§OP.11` đạt `AUTO`. `§OP.10` đã có route và shortcut thật nhưng vẫn cần kiểm
inventory trên app thật. Chưa có listener dev/Tauri ở `5173` hoặc backend ở
`8321`, nên chưa nâng Lô B–D lên `RUNTIME` trong phiên này.

## Lô E1 — Sample Size có đơn vị và đường hover thật

### E1a — contract backend (2 file)

- `separations.py` trả `render_dpi` cho PPE, fallback và nhánh không thể kiểm TAC.
- Regression ICC/Separations khóa DPI request → response; `25 passed`, py_compile
  đạt.

### E1b — toán lấy mẫu và tọa độ xoay (3 file)

- Thêm helper thuần lấy một pixel hoặc trung bình vùng tròn theo mm/DPI.
- `LivePageFrame` chuẩn hóa tọa độ theo kích thước trang chưa xoay.
- 5 regression khóa point, average, DPI, mép trang, fail-loud và tọa độ xoay.

### E1c — nối UI Output Preview (4 file)

- Bỏ listener `pdf-hover` không có producer; subscribe `hoveredPdfPosition` của
  đúng WorkspaceContext/tab bằng store listener để không render React 20 lần/s.
- UI chọn Điểm (1 px) hoặc trung bình Ø1/3/5 mm, hiển thị số pixel + DPI artifact.
- Fixture DOM khóa % từng kênh/TAC từ đường hover thật.

Verify cuối E1: typecheck đạt; 6 file test frontend `36 passed`; backend
`25 passed`. Chưa có Tauri runtime.

## Lô E2 — Warning Opacity dùng chung cho lớp cảnh báo

### E2a — state theo workspace/tab

- Thêm `outputPreviewWarningOpacity` mặc định `1`, clamp `0..1` tại store và setter
  no-op khi giá trị không đổi.
- Thêm cờ `outputPreviewOverprintDiagnosticActive` để Viewer phân biệt composite
  chính với ảnh diff chẩn đoán.

### E2b — điều khiển Hiển thị và lifecycle Overprint

- Thêm slider “Độ mờ cảnh báo” trong khối Hiển thị; giá trị phần trăm ghi thẳng về
  state của đúng tab.
- Mô phỏng Overprint đặt cờ chẩn đoán `false`; bật diff đặt `true`; hủy, đổi cấu
  hình hoặc unmount đều dọn cờ về `false`.

### E2c — chính sách opacity tại Viewer

- Gamut Warning và TAC Heatmap dùng opacity cảnh báo chung.
- Diff Overprint chỉ dùng opacity này khi cờ chẩn đoán bật; composite Overprint và
  Soft-Proof luôn giữ opacity `1`.
- Helper thuần có regression cho từng loại overlay, biên `0..1` và `NaN`.

Verify cuối E2: typecheck đạt; regression rộng Output Preview/Viewer/store/i18n
`12 file / 57 passed`. Chưa có Tauri runtime.


## Lô E3 — Art/Trim/Bleed từ PageBox thật

### E3a — hình học và identity

- Dùng `rectMmToFrac()` đã được khóa bởi audit PageBox W1 để đổi tọa độ PDF
  dưới-trái sang CropBox Viewer trên-trái, có `/Rotate` 0/90/180/270.
- Helper chỉ trả box có cờ `has_* = true`, kẹp vào vùng CropBox nhìn thấy, loại
  hình học sai/suy biến và từ chối response của frame trang khác.

### E3b — state theo tab và request latest-only

- Thêm PageBox state mang `viewerPageNum`/`sourcePageNum` và toggle hiển thị theo
  `WorkspaceContext`; đóng Output Preview dọn dữ liệu nhưng giữ lựa chọn hiển thị.
- `OutputPreviewTab` gọi endpoint thật theo trang nguồn, validate response, abort
  request cũ khi đổi trang/unmount và không để response cũ thắng.
- Trang thiếu Art/Trim/Bleed hoặc route lỗi có trạng thái rõ; không dựng checkbox
  có vẻ hoạt động trên dữ liệu fallback.

### E3c — lớp vẽ Viewer và UI

- Thêm lớp PageBox không nhận pointer, đúng frame, đúng phần trăm CropBox; Bleed
  nét liền xanh dương, Trim nét đứt xanh lá, Art nét chấm đỏ.
- Panel liệt kê đúng những box được khai báo cùng kích thước mm thật và giữ shortcut
  Set Page Boxes riêng cho hành động sửa file.
- `Show: All` và dropdown `Preview` được deferred vì chưa có contract lọc object/
  chế độ preview thật; không dựng selector giả.

Verify cuối E3: backend `84 passed`; frontend `14 file / 78 passed`; typecheck đạt.
Probe PDF khách đạt dữ liệu artifact 4 trang. Chưa có Tauri runtime.


### E3d — page identity riêng cho bitmap mô phỏng (`§OP.12`)

- Tách owner của Soft-Proof/Gamut/TAC/Overprint khỏi `separationPlates`: all-on có
  chủ ý trả `[]` để giữ bitmap Viewer nên không thể dùng mảng này xác định trang.
- Thêm active viewer page theo workspace/tab, dọn khi đổi trang/unmount/đóng panel;
  response khác trang không được mount và không phụ thuộc quyền gọi PageBox.
- Verify: typecheck đạt; targeted `36 passed`; regression rộng `14 file / 79 passed`.

## Lô E4 — audit contract lịch sử, chưa dựng UI giả

> Mốc này ghi quyết định đúng **trước khi** Lô G bổ sung contract engine. Trạng
> thái `DEFERRED` bên dưới không còn là trạng thái hiện hành.

- Adobe định nghĩa Paper Color, Black Ink và Background Color là ba hành vi riêng.
- PrynX hiện không có ba field này trong `SoftProofRequest` → route → engine →
  facade → native. `ColorManager` dùng một intent cho hai chiều và luôn bật Black
  Point Compensation; ảnh proof là RGB opaque, không có compositor giấy/mực.
- Probe PDF khách 36 DPI: Relative ↔ Absolute khác toàn bộ `105.094` pixel, MAE
  `7,4115`, max delta `25`; checkbox Paper Color không thể chỉ đổi intent.
- Không thêm checkbox. E4 được ghi `TRACED + ARTIFACT · DEFERRED`; cần một lô engine
  xuyên tầng riêng trước khi nối UI.

## Lô F — composite tập kẽm qua ICC, không raster lại PDF (`§OP.1`)

### F1 — lõi PPE và contract tint spot (5 file)

- `ppe_separations` ở chế độ xem giữ nguyên từng mặt phẳng mực nhưng thu thêm bảng
  `33 × CMYK` từ tint transform của mỗi spot; không rút màu spot về một mẫu 100%.
- Native thêm `ppe_compose_separation_subset`: nhận byte lượng mực đã tách, chỉ cộng
  các kênh đang bật rồi đổi một lần qua cùng `ColorManager`/ICC. Hàm không mở PDF,
  không chạy content interpreter và không raster trang lần hai.
- Facade giải nén zlib có giới hạn đúng `width × height`, từ chối plate lạ/trùng/sai
  kích thước và giữ LUT spot qua biên Python. Spot thiếu alternate được báo riêng,
  không âm thầm mang badge chính xác.
- `cargo check` đạt cho `print_engine` và `native`; 31 test lõi `ink` đạt; facade
  mới cùng toàn file `test_ppe_facade.py`: `43 passed`.

### F2 — endpoint PNG nhị phân (3 file)

- Thêm `POST /preflight/separation-composite` với schema giới hạn 64 kênh, 80 MP,
  profile/intent hợp lệ, identity tập kẽm và LUT đúng 33 mẫu.
- Toán native + encode PNG chạy ngoài event loop; response là `image/png`, không
  base64. Capability dùng cùng quyền `prepress.convert_colors` với Soft-Proof.
- Backend ICC/facade/Overprint/routing/entitlement mở rộng: `85 passed`; riêng
  contract route/schema mới: `2 passed`.

### F3 — Viewer latest-only, bỏ CSS approximation (5 file)

- Khi tất cả kẽm bật, tiếp tục giữ bitmap Viewer color-managed đang có; không dựng
  ảnh trùng và không làm trang nháy.
- Khi bỏ/solo kẽm, frontend debounce 35 ms, hủy request cũ, gửi các plane đã có,
  decode PNG trước rồi mới thay bitmap. Ảnh đúng gần nhất được giữ trong lúc chờ;
  response cũ không thể thắng response mới.
- Composite được đánh dấu `color-managed-composite`; `LivePageFrame` tuyệt đối
  không áp `mix-blend-multiply` lần nữa. Ghi chú “ảnh ghép CSS chỉ để xem” đã bỏ vì
  không còn mô tả đường chạy hiện tại.
- Typecheck đạt; regression rộng Output Preview/Viewer/store/i18n `13 file / 65
  passed`; test DOM khóa request subset, profile/intent, trả về all-on và abort.

### Artifact và hiệu năng trên PDF khách

PDF SHA-256 ở đầu báo cáo, trang 1, SWOP v2, Relative, 150 DPI (`1559 × 1169`, 6
kẽm):

| Phép đo | Thời gian |
|---|---:|
| Tách kẽm PPE ban đầu | `1.450,7 ms` |
| Soft-Proof raster lại toàn trang | `895,4 ms` |
| Ghép đủ/bỏ Black/solo Dark Blue/tắt hết từ plane có sẵn | `92,7–103,8 ms` |
| Endpoint hoàn chỉnh native + PNG, solo Dark Blue | `114,4 ms` |

Composite đủ kẽm so với Soft-Proof cùng PPE/SWOP: MAE RGB `0,214767`, max delta
`5`; thấp hơn acceptance MAE `≤3`. Nghĩa là đường tương tác nhanh hơn khoảng
`8,6–9,7×` so với raster lại và không quay về màu CSS.

Trạng thái `§OP.1`: `AUTO + ARTIFACT`; còn chờ smoke Tauri để nâng `RUNTIME`.
Wheel native mới đã được kiểm trong thư mục cô lập vì một tiến trình Python đang giữ
DLL dev cũ; không dừng tiến trình của người dùng. `cargo test --lib` native đã build
xong nhưng executable bị Windows chặn `0xc0000022`; kiểm thử qua wheel thật vẫn đạt
toàn bộ 85 ca backend nêu trên.

## Lô G — contract thật cho Show/Preview và Paper/Black/Background

Lô này thay thế trạng thái deferred của E3/E4; không biến các checkbox thành alias
CSS hoặc đổi nhãn mà không đổi pixel.

### G1 — chín bộ lọc Show thực thi tại sink PPE

- Contract xuyên tầng nhận đúng chín giá trị: `all`, `device-cmyk`, `device-rgb`,
  `device-gray`, `spot`, `text`, `images`, `line-art`, `smooth-shades`.
- Nhóm object (`text`, `images`, `line-art`, `smooth-shades`) được chặn/cho phép tại
  đúng lệnh vẽ của content interpreter; nhóm color space dùng color space nguồn đã
  khai báo, không suy ngược từ RGB sau render.
- Store, cache identity, Viewer request, schema FastAPI, facade Python và binding
  PyO3 cùng mang filter. Native cũ thiếu capability sẽ fail-loud, không âm thầm trả
  ảnh `all` rồi làm UI có vẻ hoạt động.
- Hai lựa chọn Preview hiện có là `Separations` và `Color Warnings`; nhánh cảnh báo
  dựng Soft-Proof và Gamut thật, còn nhánh Separations giữ đúng inventory/composite.

### G2 — ba lựa chọn E4 tác động ở chiều proof ra màn hình

- `simulate_paper_color` chỉ đổi proof intent CMYK → sRGB sang Absolute
  Colorimetric; intent đưa nội dung nguồn vào không gian mực vẫn giữ nguyên.
- `simulate_black_ink` chỉ bỏ Black Point Compensation ở chiều proof để giữ điểm
  đen thật của profile; nó độc lập với Paper Color và Rendering Intent đang chọn.
- `page_background_rgb` hòa vật liệu nền trong PPE từ tỷ lệ phản xạ
  `pixel / paper-white` ở miền tuyến tính. Pixel 0% mực ra đúng màu nền đã chọn,
  vùng có mực vẫn giữ hấp thụ của profile; không phải thay nền trắng bằng CSS.
- Ba field đi đủ UI → Viewer/Soft-Proof → schema/route → cache/session → facade →
  PyO3 → `print_engine::color::icc`, đồng thời nằm trong proof/cache identity để
  ảnh của cấu hình cũ không thể thắng cấu hình mới.

### Verify tự động cuối

- TypeScript typecheck: đạt.
- Frontend Viewer/Output Preview tập trung: `15 file / 148 passed`.
- Backend ICC/PPE/session/cache/API/Ink Manager/cleanup tập trung:
  `9 file / 182 passed`.
- PPE Rust: `7` test Show qua object/color-space sink và `2` test
  Paper/Black/Background đạt.

## Nghiệm thu Tauri dev — Viewer và toàn bộ Lô B–G

Hai báo cáo máy đọc được:

- `.tmp/runtime-smoke/tauri-runtime-smoke-report.json`;
- `.tmp/runtime-smoke/cold-warm-open-report.json`.

Kết quả trên đúng PDF khách `CMNM2026 - Giay moi_BLUE - in.pdf`:

- smoke tổng hợp đạt `42/42`, không fatal, không console error và không có HTTP
  response lỗi; một request accurate bị `ERR_ABORTED` do generation mới thay thế là
  hành vi latest-only chủ đích;
- mở file, lăn sang trang kế, zoom nút, Ctrl+lăn, thu nhỏ, pan và xoay đều giữ tile,
  không có frame trắng; xoay không đổi document identity;
- đổi Simulation Profile và Rendering Intent đi xuyên state/render identity;
- chạy đủ `9` bộ lọc Show và `2` chế độ Preview;
- Paper Color và Black Ink làm đổi pixel contract thật; Background Color truyền
  đúng RGB `[216, 201, 167]`; PageBox lấy từ artifact thật;
- bỏ một kẽm và solo Cyan dùng composite ICC; Overprint dùng ảnh preview thật, lớp
  diff chẩn đoán mặc định tắt;
- lấy mẫu Ø1/3/5 mm, hover, TAC và Heatmap hoạt động;
- shortcut Ink Manager mở đúng route và hiển thị đủ `7` kênh:
  C, M, Y, K, VietinBank Dark Blue, VTB RED, `khuon be`.

Mốc Viewer đo trong cùng smoke: lăn trang `315 ms`, zoom-in dừng → nét `499 ms`,
Ctrl+lăn dừng → nét `480 ms`, thu nhỏ dừng → nét `184 ms`, pan `291 ms`, xoay
`186 ms`; mọi chuỗi đều có `0` blank frame. Đợt cold/warm riêng đạt first-visible
đồng thời sharp ở `1.909 ms` và `1.944 ms`.

Trong lúc smoke còn phát hiện lỗi cleanup thật: file `/upload/local` tạo bằng
hard-link/copy giữ mtime cũ của nguồn, nên sweep 26 giờ có thể xóa file backend dù
DB vẫn sở hữu. Cleanup nay loại mọi path còn đăng ký trong DB trước khi xét tuổi;
`test_storage_pressure_cleanup.py` đạt `8/8`.

### Trạng thái chốt

- `W7-U05`: đạt `RUNTIME` trên Tauri dev cho Lô B–G, gồm `§OP.1`,
  `§OP.6`, `§OP.8–§OP.12`, Ink Manager, Show/Preview và E4.
- Mức `RUNTIME` này chứng minh thao tác và contract trên app dev; không tự suy thành
  pixel-parity tuyệt đối với mọi phiên bản Acrobat/profile/PDF.
- Chưa build, chưa smoke installer/clean-user theo chỉ đạo. Cổng phát hành được giữ
  mở và không bị ghi nhầm là đã đạt.
