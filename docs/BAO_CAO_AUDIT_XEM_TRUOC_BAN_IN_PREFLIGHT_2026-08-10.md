# Báo cáo audit — Xem trước bản in / Preflight Output Preview

- **Ngày:** 2026-08-10
- **Audit unit:** `W7-U05`
- **Hành động người dùng:** mở PDF → bấm **Xem trước bản in** → quan sát trang và danh sách bản kẽm.
- **PDF đối chứng:** `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`
- **SHA-256:** `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184`
- **Đối chứng thị giác:** ảnh PrynX và Acrobat Pro do người dùng cung cấp; Acrobat đang chọn **U.S. Web Coated (SWOP) v2**.
- **Mức bằng chứng hiện tại:** `RUNTIME` trên Tauri dev + `AUTO/ARTIFACT` cho các
  contract màu/composite liên quan. Build và installed/clean-user smoke chưa chạy
  theo chỉ đạo; các đoạn “còn chờ runtime/deferred” bên dưới là lịch sử tại thời
  điểm từng lô và được thay thế bởi phần kết luận cập nhật ở cuối báo cáo.

## Kết luận điều hành tại baseline trước sửa

1. **Không tìm thấy lệnh reload trên đường chạy của nút này.** Cảm giác “app refresh” chủ yếu là một lần thay toàn bộ mặt trang: PrynX giữ trang Viewer trong lúc chờ, sau đó đắp một lớp nền trắng và sáu PNG kẽm lên toàn trang. Cùng lúc, hai component lớn đang subscribe thừa vào mảng kẽm nên toàn cây Viewer bị render lại mỗi khi lớp phủ đổi.
2. **Ảnh ghép hiện tại không phải ảnh màu do PPE dựng.** PPE trả đúng các mặt phẳng lượng mực; frontend đổi mỗi mặt phẳng thành một màu RGB rồi chồng bằng CSS `mix-blend-multiply`. Phép này không phải CMYK/spot → ICC → sRGB như Acrobat.
3. **Hai mực pha tùy biến bị gán màu theo MD5 của tên mực.** PDF đã khai rõ tint transform/alternate CMYK, nhưng contract separations không chuyển dữ liệu đó lên UI. Vì vậy `VietinBank Dark Blue` bị biến thành đỏ nâu và làm gần như toàn bộ chữ/logo trong preview đổi sang đỏ.
4. **Profile mô phỏng bị hard-code FOGRA39**, trong khi ảnh Acrobat đang dùng SWOP v2. PDF không có OutputIntent, nên lựa chọn profile này ảnh hưởng trực tiếp đến kết quả xem.
5. **Metadata hiển thị sai:** PDF khai transparency group DeviceCMYK trên cả bốn trang, nhưng PPE response không trả các field tương ứng; UI mặc định thành `Trong suốt: Không`. Native cũng đã tính `coverage_pct`, nhưng facade làm rơi field này.
6. **PPE không phải phần cần viết lại.** Trên đúng file này, ảnh color-managed do PPE dựng với SWOP v2 khớp ảnh Acrobat rất gần. Vấn đề chính là contract + compositor + state UI của Output Preview.

## Đường chạy sống đã trace

```text
PreflightTool: “Xem trước bản in”
  → ImposerDashboard.setShowOutputPreview(true)
  → ImpositionTab mount OutputPreviewTab
  → GET /preflight/separations/{file_id}/{page}?dpi=150&render_mode=accurate&profile_id=fogra39
  → SeparationEngine.extract_separations
  → print_engine.facade.separations
  → native ppe_separations
  → PPE InkBuffer: C/M/Y/K + spot alpha planes
  → outputPreview.worker: mỗi plane → PNG màu cố định + alpha
  → LivePageFrame: nền trắng + CSS mix-blend-multiply
```

Mắt xích chính:

- Entry: `desktop/src/components/preprocess-tools/PreflightTool.tsx:217-224`.
- State mở panel: `desktop/src/components/imposition-tools/ImposerDashboard.tsx:168`.
- Mount panel và truyền setter toàn cục: `desktop/src/components/ImpositionTab.tsx:2685-2695`.
- Fetch hard-code `dpi=150`, `profile_id=fogra39`: `desktop/src/components/OutputPreviewTab.tsx:298-369`.
- Dựng PNG từng plate: `desktop/src/workers/outputPreview.worker.ts:57-101` và `desktop/src/lib/outputPreviewPixels.ts:55-75`.
- Lớp trắng + multiply: `desktop/src/components/workspace/LivePageFrame.tsx:3536-3549`.
- API: `backend/app/api/routes/preflight.py:949-975`.
- PPE routing: `backend/app/core/separations.py:174-257` → `backend/app/core/print_engine/facade.py:674-800` → `native/src/print_engine_py.rs:660-802`.

## Đo trên artifact thật

### 1. Kết quả PPE separations hiện tại — trang 1, 150 DPI

- Kích thước: `1559 × 1169`.
- Thời gian engine trong probe: `0,93 giây`.
- Engine/accuracy: `ppe / rip_separations`.
- Sáu plate: C, M, Y, K, `VietinBank Dark Blue`, `VTB RED`.
- `khuon be` không xuất hiện ở trang 1; PPE trả plate này khi render trang 3.
- Response không có `page_has_transparency`, `blending_color_space`, `spot_inks`.

Màu UI nhận được:

| Mực | RGB hiện tại | Nguồn hiện tại | Alternate CMYK thật trong PDF | SWOP v2 → sRGB |
|---|---:|---|---:|---:|
| VietinBank Dark Blue | `171, 60, 76` | MD5 tên mực | `100, 45, 0, 30%` | `0, 97, 150` |
| VTB RED | `211, 60, 134` | MD5 tên mực | `0, 100, 60, 10%` | `216, 46, 83` |
| khuon be | `220, 173, 143` | MD5 tên mực | `65, 0, 100, 0%` | `104, 189, 81` |

Ba colorspace nằm ở object `4308 0`, `4326 0`, `4296 0` của PDF. Đây là dữ liệu màu có sẵn trong file, không cần đoán theo tên.

### 2. Đối chiếu pixel với hai ảnh người dùng cung cấp

Phương pháp: crop đúng hình trang trong screenshot, resize output engine về cùng kích thước và đo MAE RGB. Đây là phép đối chiếu màn hình, **không phải ΔE của bản in vật lý**. Hàng “blur 3 px” giảm nhiễu do scale/chữ và nhấn mạnh sai lệch mảng màu lớn.

| Ảnh dựng | Ảnh đối chứng | MAE RGB | MAE sau blur 3 px |
|---|---|---:|---:|
| Composite CSS hiện tại | Screenshot PrynX | **1,398** | **0,496** |
| Composite CSS hiện tại | Screenshot Acrobat | **12,856** | **12,063** |
| PPE + FOGRA39 | Screenshot Acrobat SWOP v2 | **7,320** | **6,332** |
| PPE + SWOP v2 | Screenshot Acrobat SWOP v2 | **2,485** | **1,321** |

Kết quả đầu tiên chứng minh probe đã tái tạo đúng chính ảnh lỗi của PrynX. Kết quả cuối chứng minh đường PPE color-managed hiện có đã đủ gần ảnh Acrobat khi dùng cùng profile.

### 3. Inventory mực và transparency thật

| Trang | Spot có trong resources |
|---:|---|
| 1 | VietinBank Dark Blue, VTB RED |
| 2 | Không |
| 3 | khuon be |
| 4 | VietinBank Dark Blue, VTB RED |

Acrobat liệt kê tập mực của tài liệu nên ở trang 1 vẫn thấy `khuon be` với giá trị điểm đo `0%`. PrynX chỉ liệt kê colorant PPE gặp khi render trang hiện tại. Scanner `_detect_spot_inks()` hiện trả `[]` trên chính PDF này, nên cũng không bù được inventory toàn tài liệu.

Cả bốn page dictionary đều khai:

```text
/Group << /S /Transparency /CS /DeviceCMYK /I false /K false >>
```

Do PPE result bỏ field metadata, frontend dùng `result.page_has_transparency ?? false` và hiển thị sai thành “Không”.

## Phát hiện

### `§OP.1` — `[CONFIRMED]` P0 — Composite mặc định sai mô hình màu nhưng mang badge RIP

- **Sink/consumer sống:** `ppe_separations` trả lượng mực → worker tạo RGBA màu cố định → `LivePageFrame` dùng `mix-blend-multiply` trên nền trắng.
- **Bất biến bị vi phạm:** “RIP · PrynX PPE” chỉ đúng cho **mặt phẳng lượng mực**; nó không chứng nhận ảnh composite CSS là color-managed.
- **Bằng chứng:** CSS composite khớp screenshot PrynX (`MAE 1,398`) nhưng lệch Acrobat (`12,856`); PPE+SWOP giảm còn `2,485`.
- **Ảnh hưởng:** người dùng mở Output Preview và thấy ngay một bản màu sai, dù engine đã có khả năng dựng bản đúng hơn.

### `§OP.2` — `[CONFIRMED]` P0 — Màu spot tùy biến bị bịa từ MD5 thay vì đọc tint transform

- `_lookup_spot_rgb()` rơi vào hash fallback tại `backend/app/core/separations.py:115-157`.
- Facade gọi helper này cho mọi spot tại `backend/app/core/print_engine/facade.py:641-654`.
- PDF khai alternate CMYK rõ ràng; bảng phía trên chứng minh `Dark Blue` bị trả thành đỏ nâu và `khuon be` bị trả thành be thay vì xanh.
- **Consumer sống:** RGB sai được ghi vào từng PNG tại `outputPreview.worker.ts:79-89`, rồi tham gia composite toàn trang.

### `§OP.3` — `[CONFIRMED]` P1 — Profile mô phỏng Output Preview bị hard-code FOGRA39

- Request luôn gửi `profile_id=fogra39` tại `OutputPreviewTab.tsx:306-309`.
- Ảnh Acrobat đang dùng `U.S. Web Coated (SWOP) v2`; PDF không có OutputIntent.
- Cùng PPE, đổi FOGRA39 → SWOP làm MAE với ảnh Acrobat giảm `7,320 → 2,485`.
- Registry hiện đã tìm được profile SWOP trên máy; vấn đề là Output Preview không cho chọn và không dùng chung state profile với phần Soft-Proof.

### `§OP.4` — `[CONFIRMED]` P1 — PPE contract làm rơi metadata transparency/blending/coverage

- Native đã trả `coverage_pct` tại `native/src/print_engine_py.rs:747-754`.
- Facade chỉ chuyển `name/color/alpha_data/is_spot`, bỏ coverage tại `facade.py:766-799`.
- PPE result không có `page_has_transparency`, `blending_color_space`, `spot_inks`; frontend khai các field optional và mặc định `false/DeviceCMYK/[]` tại `OutputPreviewTab.tsx:32-44, 344-353`.
- Trên artifact, UI báo “Trong suốt: Không” trong khi PDF và Acrobat đều là “Có/Yes”.

### `§OP.5` — `[CONFIRMED]` P1 — Danh sách colorant là theo trang, không phải inventory tài liệu như Acrobat

- `ppe_separations` chỉ đăng ký spot gặp trong content của trang đang render.
- `_detect_spot_inks()` dùng regex trên chuỗi page object/refs tại `separations.py:294-362`; probe thực tế trả `[]` dù PDF có ba spot.
- Trang 3 render bằng PPE vẫn trả đúng `khuon be`, nên đây **không phải** PPE không hiểu spot; lỗi là inventory/contract UI.
- **Ảnh hưởng:** từ trang 1 người dùng có thể tưởng tài liệu không có kênh bế.

### `§OP.6` — `[CONFIRMED]` P1 — “Refresh” là full-page overlay swap cộng re-render thừa

- Khi fetch bắt đầu, `clearPagePreview()` thay nhiều global state và tạo mảng rỗng mới: `OutputPreviewTab.tsx:192-214, 298-303`.
- Khi worker xong, UI cập nhật toàn bộ plate list; `LivePageFrame` chèn đột ngột một `div` nền trắng phủ kín trang tại `LivePageFrame.tsx:3536-3549`. Không có giữ bitmap/cross-fade.
- `ImpositionTab` subscribe `separationPlates` nhưng không đọc giá trị ở đâu ngoài selector: `ImpositionTab.tsx:150,176`.
- `AcrobatViewer` cũng subscribe `separationPlates` và bốn overlay URL không dùng trực tiếp: `AcrobatViewer.tsx:102-150`. Vì setter luôn ghi array mới, mỗi lần bật/tắt plate làm cây Viewer lớn render lại.
- Không có `window.location.reload()` trên đường này; lệnh reload duy nhất trong desktop source là nút phục hồi của `ErrorBoundary`. Không có ancestor `<form>` cho nút đang audit, nên thiếu `type="button"` không phải root cause hiện tại.

### `§OP.7` — `[CONFIRMED]` P2 — Test xanh nhưng không kiểm điều người dùng đang thấy

- 68 backend test liên quan và 10 frontend test Output Preview hiện đều xanh.
- Frontend test chỉ khóa RGBA, TAC và identity trang; không render/so composite, không kiểm profile, spot alternate, transparency hoặc “không đổi pixel khi mở panel”.
- Backend test spot dùng tên Pantone đã có trong bảng, nên không đi qua nhánh MD5 đang làm hỏng hai spot tùy biến của file khách.

## Giả thuyết đã bác bỏ / hiệu chỉnh

- `[DISPROVED]` **PPE tách sai toàn bộ kẽm:** PPE trả đúng sáu plane của trang 1, nhận đủ DeviceN/DeviceCMYK/DeviceGray/Separation và tự khai `rip_separations`. Ảnh PPE+SWOP khớp Acrobat gần; lỗi chính nằm sau plane output.
- `[DISPROVED]` **nút submit form làm reload:** không có form ancestor trên đường component hiện tại.
- `[DISPROVED]` **`khuon be` hoàn toàn không được engine hỗ trợ:** render trang 3 trả đúng plate này; phần thiếu là inventory toàn tài liệu ở trang 1.
- `[EXPECTED]` **Acrobat và FOGRA39 không trùng tuyệt đối:** PDF không gắn OutputIntent; muốn parity phải chọn cùng Simulation Profile, không thể coi một profile là chân lý duy nhất.

## Kế hoạch sửa đề xuất — chờ duyệt

### Lô 1 — Chặn nháy/“refresh” và re-render thừa (tối đa 5 file)

1. `desktop/src/components/OutputPreviewTab.tsx`: panel hiện ngay nhưng không xóa/đắp lại trang khi tất cả plate còn bật; giữ bitmap Viewer đang đúng màu trong lúc tải metadata.
2. `desktop/src/components/ImpositionTab.tsx`: bỏ subscription vào giá trị `separationPlates` không dùng.
3. `desktop/src/components/AcrobatViewer.tsx`: bỏ các subscription overlay không được component tiêu thụ; để `LivePageFrame` là consumer hẹp.
4. `desktop/src/components/preprocess-tools/PreflightTool.tsx`: thêm `type="button"` phòng ngừa khi layout về sau đặt vào form.
5. Thêm component regression: mở panel không remount Viewer, không chèn nền trắng khi all-on, thay plate không làm shell render lại.

### Lô 2 — Khép contract metadata + inventory tài liệu (tối đa 5 file)

1. `backend/app/core/separations.py`: thay regex scan bằng traversal resources thật; trả inventory document colorants và page-presence riêng.
2. `backend/app/core/print_engine/facade.py`: giữ `coverage_pct`, metadata PPE và schema plate đầy đủ.
3. `backend/app/api/routes/preflight.py`: response nói rõ `document_colorants`, `page_colorants`, transparency và blending space.
4. `backend/tests/test_ppe_facade.py`: fixture multipage có spot chỉ ở trang khác + custom spot.
5. `backend/tests/test_icc_and_color_preview.py`: khóa `Transparency=Yes`, `DeviceCMYK`, coverage và không silent-default.

### Lô 3 — Composite color-managed từ chính lần render PPE (tối đa 5 file)

1. `native/src/print_engine_py.rs`: ở chế độ xem, giữ spot plane nhưng thu tint alternate; xuất thêm composite sRGB từ cùng `InkBuffer` và cùng ICC, không render trang lần hai.
2. `backend/app/core/print_engine/facade.py`: chuyển composite/profile/spot alternate qua contract, không gọi `_lookup_spot_rgb()` khi PDF có alternate thật.
3. `desktop/src/components/OutputPreviewTab.tsx`: thêm Simulation Profile ở vị trí tương đương Acrobat; mặc định theo OutputIntent nếu có, nếu không dùng lựa chọn người dùng.
4. `desktop/src/components/workspace/LivePageFrame.tsx`: dùng composite PPE cho trạng thái all-on; CSS plate chỉ còn fallback có nhãn xấp xỉ.
5. Test Rust/backend/frontend khóa ba màu custom và parity all-on theo profile.

### Lô 4 — Bật/tắt plate chính xác, tức thời

- Giữ `InkBuffer` trang trong session PPE theo document/page/profile; request tiếp theo chỉ đổi tập colorant rồi quy ICC, không parse/raster lại PDF.
- Dùng generation/latest-only để click nhanh không cho ảnh cũ thắng ảnh mới.
- LRU/RAM phải theo profile phần cứng của dự án: máy `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `≥16 GB` không hard-cap vô điều kiện.
- Chỉ bắt đầu lô này sau benchmark Lô 3; nếu composite từ buffer đã đủ nhanh thì không thêm GPU/WASM không cần thiết.

## Acceptance criteria

1. Bấm **Xem trước bản in**: panel xuất hiện ngay; pixel trang không đổi khi tất cả plate đang bật; không có nền trắng nháy và không có mốc `frontend: Home interactive` mới.
2. Trang 1 với profile SWOP v2: composite all-on đạt MAE RGB `≤3` so với baseline Acrobat đã duyệt; không dùng CSS multiply dưới badge “RIP”.
3. Spot swatch lấy từ tint transform + profile: Dark Blue là xanh đậm, VTB RED là đỏ, `khuon be` là xanh; không dùng hash khi alternate hợp lệ.
4. Trang 1 liệt kê đủ 7 plate của tài liệu; `khuon be` có giá trị điểm đo `0%` ở trang 1 và có dữ liệu khi sang trang 3.
5. Metadata trang 1: `Transparency=Yes`, blending `DeviceCMYK`.
6. Panel/metadata không chậm hơn baseline engine hiện tại (`~0,9 giây` ở 150 DPI trên máy audit); composite all-on không render PDF lần hai.
7. Bật/tắt plate warm-session dùng latest-only, không flash ảnh cũ; ngưỡng p95 được chốt sau benchmark, mục tiêu ban đầu `≤200 ms` trên máy audit.
8. Có regression synthetic + artifact fixture ẩn danh; test phải khóa composite/profile/metadata/state, không chỉ khóa alpha plane.

## Verify đã chạy

```text
backend venv:
pytest -q test_ppe_facade.py test_print_engine_routing.py
          test_icc_and_color_preview.py test_overprint_preview_ppe.py
→ 68 passed

desktop Windows:
vitest outputPreviewOverlay + outputPreviewPixels + outputPreviewPanelLayout
→ 10 passed
```

Các test xanh này là baseline, không phủ nhận findings; `§OP.7` chỉ ra chính khoảng trống của chúng.

---

## Tái audit parity UI với Acrobat sau hotfix runtime

- **Thời điểm:** 2026-08-10, sau khi người dùng xác nhận lần mở đầu tiên không còn reload.
- **Ảnh đối chứng Acrobat:** `codex-clipboard-8b45a299-ca9e-489f-9992-279be38290c8.png`.
- **Ảnh PrynX hiện tại:** `codex-clipboard-2436385c-263d-4edd-8954-4726585c8459.png`.
- **Phạm vi:** các điều khiển nhìn thấy trong cửa sổ **Output Preview** của Acrobat và đường chạy tương ứng trong PrynX; không suy rộng thành audit toàn bộ Print Production của Acrobat.

### Kết luận ngắn

PrynX **chưa tương ứng đầy đủ** với Output Preview của Acrobat. Nhận xét của người dùng về thứ tự UI là đúng: Acrobat đặt các quyết định mô phỏng màu ở đầu luồng, sau đó mới tới chế độ hiển thị, danh sách kẽm và phép đo. PrynX hiện mở thẳng danh sách kẽm, đặt profile ICC ở một panel thu gọn cuối cùng, còn Ink Manager và Set Page Boxes nằm ở công cụ khác.

Đây không chỉ là khác bố cục. Ba nhóm sai khác có ảnh hưởng kết quả vẫn còn mở:

1. profile SWOP có sẵn nhưng không điều khiển chung Viewer, Separations và Soft-Proof;
2. nút Overprint của PrynX đang hiển thị lớp đánh dấu pixel khác biệt, không phải trạng thái mô phỏng overprint của trang như Acrobat;
3. inventory mực và metadata transparency/blending vẫn thiếu hoặc dùng giá trị mặc định.

### Trạng thái các finding cũ sau các lô đã duyệt

| Finding | Trạng thái hiện tại | Bằng chứng |
|---|---|---|
| `§OP.1` composite all-on sai | **Giảm một phần** | `buildDisplayedPagePlateOverlays()` nay trả `[]` khi tất cả kẽm bật, nên giữ bitmap Viewer thay vì đắp composite CSS. Khi bỏ/solo kẽm, lớp phủ vẫn là PNG màu cố định + `mix-blend-multiply`. |
| `§OP.2` màu spot theo hash | **Còn mở** | `_plate_color()` vẫn gọi `_lookup_spot_rgb()`; spot tùy biến vẫn rơi vào MD5 tại `separations.py:115-157`. |
| `§OP.3` profile FOGRA39 hard-code | **Còn mở** | Separations gửi `profile_id=fogra39` tại `OutputPreviewTab.tsx:306-309`; Viewer accurate cũng gửi FOGRA39/relative tại `useTileRenderer.ts:319-326,481-489`. |
| `§OP.4` rơi metadata/coverage | **Còn mở** | Probe hiện tại không có `page_has_transparency`, `blending_color_space`, `spot_inks`; `coverage_pct` native vẫn không được facade chuyển vào plate. |
| `§OP.5` inventory theo trang | **Còn mở** | Trang 1 trả 2 spot, trang 3 mới trả `khuon be`; `_detect_spot_inks()` vẫn trả `[]`. |
| `§OP.6` reload/flash lần đầu | **Đã đóng ở runtime dev** | Vite prebundle `pako`/`diff`; người dùng xác nhận cold-open không còn reload. Chi tiết ở `XEM_TRUOC_BAN_IN_PREFLIGHT_FIXES_2026-08-10.md`. |
| `§OP.7` khoảng trống test | **Còn mở** | Test hiện tại khóa pixel plate/heatmap và lifecycle host, chưa khóa ma trận parity UI/profile/metadata/inventory. |

### Ma trận tương ứng Acrobat → PrynX hiện tại

Quy ước: **Đủ** = cùng mục đích và hành vi quan sát; **Khác** = có năng lực gần tương ứng nhưng khác contract/hành vi; **Nơi khác** = app có công cụ nhưng không nằm trong Output Preview; **Thiếu/Sai** = chưa có hoặc dữ liệu không đáng tin.

| Mục trong ảnh Acrobat | PrynX hiện tại | Đánh giá | Bằng chứng / ghi chú |
|---|---|---|---|
| Simulation Profile | Có trong `SoftProofPanel`, mặc định FOGRA39 | **Khác** | Panel bị thu gọn ở cuối. Chọn SWOP chỉ đổi request soft-proof; Separations và Viewer vẫn hard-code FOGRA39. SWOP v2 đã được resolver xác nhận `available=true` trên máy audit. |
| Simulate Overprinting | Soft-Proof mặc định bật overprint; nút riêng dựng diff | **Khác** | Backend trả cả `overprint_image` và `diff_overlay`, nhưng `OutputPreviewTab.tsx:866-879` chỉ dùng `diff_overlay`. Không có một công tắc chung điều khiển ảnh trang. |
| Page has Overprint | Không có field/trạng thái tĩnh | **Thiếu** | `OverprintPreviewToggle` chỉ báo số pixel thay đổi sau khi render hai ảnh; khác với việc đọc cờ/object overprint trong PDF. |
| Simulate Paper Color | Không có điều khiển | **Thiếu** | Rendering intent `absolute` không phải một công tắc mô phỏng màu giấy có nhãn/hành vi tương đương. |
| Set Page Background Color | Không có trong Output Preview | **Thiếu** | Không tìm thấy state/consumer tương ứng trên đường panel. |
| Simulate Black Ink | Không có điều khiển | **Thiếu** | Soft-proof không phơi một lựa chọn mô phỏng black ink riêng. |
| Ink Manager | Có tool riêng | **Nơi khác + sai trên artifact** | `InkManagerTool` không có shortcut trong panel. Probe `InkManagerEngine.list_inks()` trên PDF đối chứng chỉ trả C/M/Y/K, bỏ cả ba spot. |
| Show: All | Không có bộ lọc Show | **Thiếu** | PrynX chỉ bật/tắt kẽm; không có dropdown lọc nhóm đối tượng/chế độ cảnh báo như UI Acrobat. |
| Warning Opacity | Không có | **Thiếu** | Alpha TAC bị cố định `120..220` trong `outputPreviewPixels.ts:87-101`; alpha diff overprint cố định `180` ở route. |
| Show art, trim, & bleed boxes | Không có overlay box trong panel | **Thiếu** | Crop mode của Viewer không phải chế độ hiển thị đồng thời Art/Trim/Bleed trong Output Preview. |
| Set Page Boxes | Có Crop/Set Page Boxes riêng | **Nơi khác** | Route `/preflight/page-boxes` và `/preflight/set-page-boxes` có thật; UI nằm ở `CropDialog`, không nối từ panel. |
| Preview: Separations dropdown | Nhãn “Tách kẽm” cố định | **Thiếu** | Không có preview-mode selector; TAC, Gamut và Overprint là các toggle rời có thể chồng lên nhau. |
| Nhóm Process Plates / Spot Plates | Spot có badge, danh sách cùng một khối | **Khác** | Không có group row/checkbox riêng cho Process và Spot; nút hiện tại chọn/bỏ tất cả. |
| Inventory kẽm toàn tài liệu | Chỉ colorant của trang render | **Sai** | Acrobat ảnh đối chứng liệt kê 7 kẽm từ trang 1; PrynX trang 1 chỉ có 6. Trang 3 mới trả `khuon be`. |
| Bật/tắt từng kẽm | Checkbox + nút solo | **Đủ + có thêm** | PrynX có checkbox từng kẽm, chọn tất cả và solo plate. Trạng thái subset vẫn dùng composite CSS xấp xỉ. |
| % từng kẽm tại điểm trỏ | Có | **Đủ** | Sự kiện `pdf-hover` đọc một pixel plate và cập nhật phần trăm tại `OutputPreviewTab.tsx:371-390`. |
| Sample Size: Point Sample | Cố định một pixel ở raster 150 DPI | **Khác** | Tương đương Point Sample cơ bản, nhưng không có selector/average sample và kích thước mẫu phụ thuộc raster 150 DPI. |
| Total Area Coverage tại điểm | Có hàng TAC | **Đủ** | PrynX cộng phần trăm các plate tại điểm trỏ. |
| TAC warning + ngưỡng 280% | Có ngưỡng và heatmap gradient | **Khác + có thêm** | Heatmap là bổ sung hữu ích; checkbox “Cảnh báo TAC” hiện chỉ đổi màu con số, còn heatmap là toggle khác. Không có Warning Opacity. |
| Page has Transparency | Có dòng UI | **Sai dữ liệu** | Response PPE hiện không có field; UI dùng `?? false`. Artifact có `/Group /S /Transparency` ở cả 4 trang nhưng PrynX báo “Không”. |
| Transparency Blending Color Space | Có dòng UI | **Không đáng tin** | Response PPE hiện không có field; UI dùng mặc định `DeviceCMYK`. Trên file này giá trị trông đúng nhưng là default, không phải metadata đã đo. |
| Rendering Intent | Có trong Soft-Proof | **PrynX có thêm trong panel phụ** | Bốn intent được phơi; cần nhập vào cùng state Simulation thay vì state cục bộ. |
| Gamut Warning | Có overlay + phần trăm | **PrynX có thêm** | Năng lực hữu ích, nên giữ trong nhóm cảnh báo nâng cao. |
| Engine/accuracy badge | Có RIP/Xấp xỉ/PPE | **PrynX có thêm** | Đây là điểm tốt về tính minh bạch, không nên bỏ khi sắp xếp lại UI. |
| Chuyển Spot → CMYK | Có từng kênh/toàn bộ | **PrynX có thêm** | Đây là hành động sửa file, nên tách khỏi nhóm kiểm tra thị giác để tránh bấm nhầm. |
| Điều hướng trang trong panel | Có | **PrynX có thêm** | Hữu ích cho workflow nhiều trang; giữ ở header. |

### Bằng chứng artifact hiện tại

Probe chạy bằng `backend\venv\Scripts\python.exe` trên file SHA-256 nêu ở đầu báo cáo:

```text
_detect_spot_inks(file) → []

Trang 1, PPE accurate, profile SWOP, 72 DPI:
keys → accuracy, detected_spots, engine, has_spot_colors, height,
       max_tac_pct, plates, ppe_*, quality_note, width
plates → Cyan, Magenta, Yellow, Black, VietinBank Dark Blue, VTB RED
page_has_transparency → không có
blending_color_space → không có
coverage_pct từng plate → không có sau facade

Trang 3, PPE accurate, 36 DPI:
plates → Cyan, Magenta, Yellow, Black, khuon be

PikePDF page group, cả 4 trang:
/Group << /S /Transparency /CS /DeviceCMYK /I false /K false >>

InkManagerEngine.list_inks(file):
→ chỉ Cyan, Magenta, Yellow, Black; bỏ ba spot.
```

Mức bằng chứng của phần tái audit là `TRACED` + `ARTIFACT` cho response/metadata/inventory. Chưa có runtime automation khóa toàn bộ ma trận UI nên chưa nâng nhánh parity lên `AUTO`.

## Phát hiện parity bổ sung

### `§OP.8` — `[CONFIRMED]` P1 — Không có một nguồn trạng thái Simulation thống nhất

- Soft-Proof giữ `selectedProfile`, `intent` và gamut bằng state cục bộ tại `SoftProofPanel.tsx:25-33`.
- Separations hard-code FOGRA39 tại `OutputPreviewTab.tsx:306-309`.
- Viewer accurate hard-code FOGRA39/relative tại `useTileRenderer.ts:319-326,481-489` và dùng knockout.
- **Consumer sống:** trạng thái all-on giữ bitmap Viewer; vì vậy profile nhìn thấy trong Soft-Proof không nhất thiết là profile của ảnh all-on hoặc dữ liệu kẽm.
- **Hậu quả:** giao diện có profile selector nhưng người dùng không thể coi nó là “Simulation Profile” chung như Acrobat.

### `§OP.9` — `[CONFIRMED]` P1 — Overprint Preview mang tên mô phỏng nhưng UI chỉ dùng lớp diff

- Route dựng đúng cặp knockout/overprint và trả `overprint_image` lẫn `diff_overlay` tại `preflight.py:1721-1803`.
- Frontend chỉ chuyển `data.diff_overlay` vào Viewer tại `OutputPreviewTab.tsx:866-879`; `overprint_image` không có consumer.
- Soft-Proof lại mặc định `simulate_overprint=True`, trong khi Viewer mặc định `False`; hai hành vi không do cùng một toggle điều khiển.
- **Hậu quả:** nút PrynX là công cụ chẩn đoán vùng thay đổi, chưa tương đương checkbox “Simulate Overprinting” và nhãn “Page has Overprint” của Acrobat.

### `§OP.10` — `[CONFIRMED]` P1 — Các dòng metadata/inventory hiện tạo cảm giác parity giả

- Transparency hiển thị “Không” vì field thiếu được mặc định `false`.
- Blending space hiển thị `DeviceCMYK` vì field thiếu được mặc định chuỗi này; trên PDF đối chứng nó đúng ngẫu nhiên.
- Header “2 SPOT” và tổng “6 (2 Spot)” là inventory trang 1, không phải toàn tài liệu.
- Ink Manager riêng cũng bỏ ba spot trên chính artifact.
- **Hậu quả:** bố cục trông gần Acrobat nhưng dữ liệu người dùng dựa vào để chốt file chưa cùng nghĩa.

### `§OP.11` — `[CONFIRMED]` P2 — Thứ tự UI đi ngược thứ tự quyết định prepress

- Acrobat: **Simulate → Show → Preview → Separations → Sampling/TAC → Metadata**.
- PrynX: **Mode/Engine → Page → Plates → TAC/Accuracy → Overprint → Convert → Metadata → Soft-Proof**.
- Profile mô phỏng — biến có thể đổi màu toàn trang — nằm dưới cùng và mặc định đóng; hành động phá hủy/sinh file mới “Convert Spot” lại nằm trước metadata/profile.
- **Hậu quả:** người dùng dễ đọc số kẽm dưới một profile không nhìn thấy, rồi nhầm lớp diff overprint hoặc composite plate là màu in cuối.

## Thứ tự UI đề xuất

Không cần sao chép giao diện Acrobat theo pixel; cần giữ cùng **logic công việc**, đồng thời giữ các năng lực PrynX có thêm:

1. **Header:** tên công cụ, engine/độ tin cậy, điều hướng trang.
2. **Mô phỏng (mở mặc định):** Simulation Profile, Rendering Intent, Simulate Overprinting + “Trang có Overprint”, Paper Color, Black Ink, Background Color; shortcut Ink Manager.
3. **Hiển thị:** Preview mode, Show filter, Warning Opacity, hiển thị Art/Trim/Bleed, shortcut Set Page Boxes.
4. **Bản kẽm (mở mặc định):** group Process và Spot riêng, checkbox theo group/từng kẽm, % tại điểm, solo.
5. **Lấy mẫu & TAC:** Sample Size, TAC tại điểm, ngưỡng, heatmap/cảnh báo.
6. **Thông tin trang:** transparency, blending space, colorants có trên trang so với toàn tài liệu.
7. **Nâng cao PrynX (thu gọn):** gamut, quality note, chế độ xấp xỉ để đối chứng.
8. **Hành động sửa file (tách khối, màu cảnh báo):** chuyển Spot → CMYK; không đặt lẫn với điều khiển preview.

## Kế hoạch sửa parity đề xuất — chờ duyệt

### Lô A — Nguồn sự thật cho metadata và inventory (tối đa 5 file)

1. Traversal Resources/XObject thật để lập `document_colorants` và `page_colorants`, dùng chung cho Separations và Ink Manager.
2. Chuyển `coverage_pct`, alternate color/tint transform, transparency, blending space qua facade/API.
3. Không dùng default “Không/DeviceCMYK” khi field thiếu; UI phải hiện “Chưa xác định”.
4. Test artifact nhiều trang khóa đủ 7 kẽm, page presence và metadata thật.

### Lô B — Một state Simulation dùng chung (tối đa 5 file)

1. Nâng profile/intent/overprint khỏi `SoftProofPanel` lên owner của Output Preview.
2. Cùng state phải điều khiển Viewer composite, Separations conversion, Soft-Proof và Overprint.
3. Dùng OutputIntent nếu file có; nếu không, hiện rõ profile người dùng chọn. Không hard-code âm thầm.
4. Giữ cache key theo profile/intent/overprint để không tái dùng bitmap sai trạng thái.

### Lô C — Overprint đúng nghĩa + trạng thái cấu trúc (tối đa 5 file)

1. Checkbox chính hiển thị `overprint_image` color-managed, không dùng diff làm ảnh mô phỏng.
2. Diff overlay giữ lại như chế độ chẩn đoán nâng cao riêng.
3. `Page has Overprint` phải đọc object/graphics-state thật; không suy chỉ từ số pixel khác biệt.
4. Latest-only/cancel để đổi toggle không flash response cũ.

### Lô D — Sắp xếp lại panel theo workflow Acrobat (tối đa 5 file)

1. Tạo các section theo thứ tự đề xuất; Simulation và Separations mở mặc định.
2. Group Process/Spot + checkbox nhóm; giữ solo và badge PPE.
3. Đưa Convert Spot xuống khối “Sửa file”; thêm shortcut tới Ink Manager/Set Page Boxes.
4. Regression DOM khóa thứ tự section, nhãn, trạng thái mở mặc định và không remount Viewer.

### Lô E — Các điều khiển parity còn thiếu (mỗi nhánh tối đa 5 file)

1. Sample Size có point/average rõ đơn vị và không phụ thuộc ngầm DPI render.
2. Warning Opacity dùng chung cho warning overlays.
3. Art/Trim/Bleed overlay + Show/Preview mode.
4. Paper Color, Black Ink và Background Color chỉ bật khi engine có contract rõ; nếu chưa hỗ trợ thì không dựng checkbox giả.

## Acceptance criteria parity

1. Profile đang thấy ở đầu panel là profile thật của ảnh all-on, separations và soft-proof; chọn SWOP v2 không còn đường nào âm thầm dùng FOGRA39.
2. “Simulate Overprinting” đổi giữa hai composite color-managed; lớp diff chỉ xuất hiện khi người dùng chọn chế độ chẩn đoán.
3. Trên PDF đối chứng, trang 1 liệt kê đủ 7 kẽm tài liệu; `khuon be=0%` tại điểm trang 1 và có dữ liệu ở trang 3.
4. Trang 1 báo `Transparency=Yes`, `Blending=DeviceCMYK` từ response thật; thiếu field phải hiện “Chưa xác định”, không tự điền giá trị có vẻ đúng.
5. Spot swatch lấy tint alternate + profile; không hash tên khi PDF có alternate hợp lệ.
6. Thứ tự section là Simulation → Show/Preview → Separations → Sample/TAC → Metadata → Advanced/Actions.
7. Giữ các điểm mạnh PrynX: page navigation, solo plate, heatmap, gamut và badge độ tin cậy.
8. Hotfix cold-open vẫn đạt: mở panel lần đầu không reload, không remount Viewer và không làm mất bitmap trang.

## Cập nhật sau triển khai Lô B — 2026-08-10

Phần này cập nhật trạng thái finding, không thay đổi bằng chứng lịch sử ở các
mục trên.

### `§OP.8` — giảm từ finding code P1 xuống khoảng trống runtime

- `WorkspaceContext` đã trở thành owner duy nhất của profile/intent theo từng tab.
- Separations, Soft-Proof và Viewer đọc cùng hai giá trị; route Separations và
  PPE native không còn bỏ qua Rendering Intent.
- FOGRA39/Relative giữ native fast path; profile/intent khác đi backend accurate.
- `renderCoordinator`/`LivePageFrame` tách identity theo profile/intent và Output
  Preview giữ bitmap cũ trong lúc ảnh Simulation mới dựng.
- Regression: frontend Viewer/Output Preview `63 passed`; backend parity `161
  passed`; probe artifact SWOP + Perceptual đạt PPE và metadata thật.

Trạng thái bằng chứng hiện tại: `AUTO` cho contract/state/cache + `ARTIFACT` cho
probe PDF khách; `RUNTIME` còn chờ smoke trên Tauri.

### Các finding còn mở sau Lô B

- `§OP.1`: subset/solo vẫn là lớp plate approximation CSS; chưa phải composite
  ICC một lần từ InkBuffer.
- `§OP.9`: nút Overprint vẫn tiêu thụ `diff_overlay`, chưa chuyển sang
  `overprint_image` color-managed và chưa có một toggle mô phỏng chung.
- `§OP.10`: contract Output Preview đã có inventory/metadata, nhưng shortcut và
  màn Ink Manager cần smoke runtime để xác nhận hiển thị đủ 7 kênh.
- `§OP.11`: khối Simulation đã lên đầu panel; thứ tự đầy đủ
  Simulation → Show/Preview → Separations → Sample/TAC → Metadata → Actions vẫn
  dành cho Lô D.

### Giới hạn verify trong phiên này

Không có dev server/Tauri process đang chạy, nên chưa tự thao tác UI thật. Full
frontend có 4 failure ở StickerCutline/Logo Rebuild ngoài phạm vi Lô B; toàn bộ
test file liên quan Output Preview/Viewer đều đạt. Không sửa các failure ngoài
phạm vi để tránh làm loãng bằng chứng audit.

## Cập nhật sau triển khai Lô C — 2026-08-10

### `§OP.9` — đã khép ở mức `AUTO`, còn chờ xác nhận `RUNTIME`

- Endpoint Overprint dựng cặp knockout/overprint bằng cùng PPE, cùng Simulation
  Profile và Rendering Intent. Ảnh đọc chính là `overprint_image` PNG lossless;
  `diff_overlay` màu cam chỉ còn là lớp chẩn đoán do người dùng bật riêng.
- `Page has Overprint` không còn suy từ số pixel khác biệt. Backend chỉ báo Có
  khi gặp graphics state `/OP` hoặc `/op` được gọi thật bởi operator `gs`; việc
  dò tiếp tục qua Form XObject được gọi bởi `Do` và có chặn vòng tham chiếu.
- Request frontend mang profile/intent hiện tại. Soft-Proof nhận cùng trạng thái
  `simulate_overprint`, thay vì tự bật một chế độ riêng không khớp panel chính.
- Generation + `AbortController` bảo đảm response cũ không ghi đè lựa chọn mới.
  Khi đổi trang/profile/intent hoặc đóng panel, request và mọi overlay liên quan
  được dọn, không để ảnh Overprint cũ bám lại Viewer.

Probe trên PDF khách cho trang 1 trả `page_has_overprint=False` và không có pixel
khác biệt lớn hơn ngưỡng; kết quả này phù hợp với content stream của trang đó.
Fixture PPE có spot Overprint thật và fixture Form XObject lồng nhau đều đạt.

Verify sau bản vá dọn overlay cuối:

- frontend typecheck đạt;
- 8 file test Output Preview/Viewer tập trung: `39 passed`;
- backend Overprint/PPE facade tập trung: `45 passed`;
- `git diff --check` trên toàn bộ file production liên quan: đạt.

### Finding còn mở sau Lô C

- `§OP.1`: bỏ/solo một phần kẽm vẫn dùng plate approximation CSS, chưa dựng lại
  composite ICC trực tiếp từ InkBuffer.
- `§OP.10`: contract inventory/metadata đã có test, nhưng Ink Manager và các
  shortcut liên quan vẫn cần kiểm trên app thật.
- `§OP.11`: thứ tự và nhóm điều khiển đầy đủ theo workflow Acrobat thuộc Lô D.

Chưa nâng riêng Lô C lên `RUNTIME`: phiên này chưa có Tauri/dev server để thao
tác chuỗi mở panel → đổi profile/intent → bật Overprint → bật diff → đóng panel.

## Cập nhật sau triển khai Lô D — 2026-08-10

### `§OP.11` — đã khép ở mức `AUTO`, còn chờ xác nhận `RUNTIME`

Panel hiện đi theo thứ tự quyết định prepress đã chốt:

1. Mô phỏng;
2. Hiển thị;
3. Bản kẽm;
4. Lấy mẫu & TAC;
5. Thông tin trang;
6. Nâng cao PrynX;
7. Sửa file.

Simulation và Separations mở mặc định; các section còn lại thu gọn. Điều hướng
trang cùng badge RIP/Xấp xỉ luôn nằm ở vùng đầu panel, không bị giấu khi section
Hiển thị đóng.

- Process (CMYK) và Spot là hai nhóm độc lập, có checkbox nhóm; thao tác nhóm này
  không xóa lựa chọn nhóm kia. Solo và phần trăm tại điểm vẫn được giữ.
- Nút chuyển Spot không còn nằm trong từng dòng kẽm. Từng lệnh và lệnh chuyển tất
  cả nằm trong section cảnh báo “Sửa file”, ghi rõ chúng tạo một PDF mới.
- Shortcut “Quản lý mực” mở route `inkmanager` đã đăng ký thật với capability
  `prepress.convert_colors`; guard không còn trả route về menu trống.
- Shortcut “Đặt hộp trang” mở route `crop` hiện có. Cả hai shortcut đóng Output
  Preview, mở panel phải và khôi phục độ rộng panel tối thiểu nếu trước đó bị thu.
- Regression DOM khóa thứ tự section, trạng thái mở mặc định, nhóm Process/Spot,
  vị trí hành động sửa file, hai shortcut và điều hướng ba trang. Regression host
  có sẵn tiếp tục khóa việc không remount Viewer khi mở/đóng panel.

Verify cuối Lô D:

- frontend typecheck đạt;
- bộ routing/registry/entitlement: `24 passed`;
- vòng Output Preview + routing + i18n: `35 passed`;
- regression rộng Viewer/Output Preview/routing/i18n: `99 passed` trong 15 file;
- toàn frontend: `2.161 passed, 2 skipped, 3 failed`; cả 3 failure đều ở
  `StickerCutlineTool.test.tsx` do mock ngoài phạm vi thiếu
  `previewStickerCutline`, không có failure Output Preview/Viewer;
- `git diff --check` và kiểm whitespace các file mới: đạt.

`§OP.10` đã giảm thêm: Ink Manager không còn là component mồ côi và có đường mở
từ Output Preview. Tuy vậy, việc hiển thị đủ inventory 7 kênh trên đúng PDF khách
vẫn cần smoke Tauri nên finding này chưa được đóng `RUNTIME`.

Các khoảng trống chức năng còn lại không thuộc Lô D: `§OP.1` cho composite khi
bỏ/solo kẽm và nhóm điều khiển parity Lô E (Sample Size, Warning Opacity,
Art/Trim/Bleed, Paper/Black/Background Color) chỉ được thêm khi engine có contract
thật. Hai cổng dev `5173` và backend `8321` đều không có listener trong phiên này.

## Cập nhật sau triển khai Lô E1 — Sample Size

Khảo sát đường chạy phát hiện listener `pdf-hover` trong Output Preview không có
producer nào trong repo. Viewer thật ghi tọa độ vào `hoveredPdfPosition` theo
`WorkspaceContext`, nên phần trăm tại điểm và TAC trước E1 có thể đứng yên.

E1 đã sửa theo contract có đơn vị:

- Separations response khai `render_dpi` từ chính artifact PPE/PDFium.
- Output Preview subscribe thẳng store của tab, không render lại React theo mỗi
  lần rê chuột và không dùng event toàn cục thiếu owner.
- Cỡ mẫu gồm Điểm (1 px) hoặc trung bình vùng tròn Ø1/3/5 mm; mm được đổi sang
  pixel bằng `render_dpi`, không hard-code 150 DPI.
- Tọa độ sau tháo xoay được chuẩn hóa theo chiều rộng/cao trang chưa xoay, không
  theo AABB của trang xoay 90°/270°.
- UI hiển thị số pixel thật của vùng mẫu và DPI artifact để người dùng biết phép
  đo đang dựa trên dữ liệu nào.

Verify: backend ICC/Separations `25 passed`; frontend phép tính/Viewer/DOM/i18n
`36 passed`; typecheck đạt. Trạng thái `AUTO`; runtime Tauri còn chờ.

## Cập nhật sau triển khai Lô E2 — Warning Opacity

E2 đã khép điều khiển độ mờ theo đúng vai trò của từng ảnh trong Output Preview,
không đánh đồng ảnh mô phỏng chính với lớp cảnh báo:

- `outputPreviewWarningOpacity` được giữ trong `WorkspaceContext` của từng tab,
  clamp tại biên `0..1`; slider trong khối Hiển thị dùng trực tiếp state này.
- Gamut Warning và TAC Heatmap nhận độ mờ cảnh báo chung.
- Overprint composite color-managed luôn hiển thị 100%; chỉ ảnh diff nhận độ mờ khi
  cờ chẩn đoán Overprint đang bật.
- Soft-Proof luôn hiển thị 100%, không bị slider cảnh báo làm sai màu mô phỏng.
- Helper thuần khóa chính sách opacity và chặn giá trị ngoài miền để mọi consumer
  dùng cùng một quy tắc.

Verify cuối E2: typecheck đạt; regression Output Preview/Viewer/store/i18n gồm
`12 file / 57 passed`. Trạng thái `AUTO`; runtime Tauri còn chờ.


## Cập nhật sau triển khai Lô E3 — Art/Trim/Bleed PageBox

### Đường dữ liệu và artifact thật

Đã trace đường sống `OutputPreviewTab` →
`GET /preflight/page-boxes/{file_id}/{page}` → `PageBoxesEngine.get_boxes()` →
`LivePageFrame`. Endpoint trả tọa độ mm vật lý, cờ `has_*` và `/Rotate`; Viewer
hiển thị CropBox nên khung được đổi từ hệ PDF dưới-trái sang hệ Viewer trên-trái,
sau đó mới áp xoay 0/90/180/270.

Probe trực tiếp trên PDF khách SHA-256 đã ghi ở đầu báo cáo:

- trang 1, 2 và 4: Media/Crop/Trim/Bleed/Art đều `264 × 198 mm`;
- trang 3: năm box đều `313,46 × 251,52 mm`;
- cả bốn trang khai tường minh Crop/Trim/Bleed/Art và có `/Rotate=0`.

### Hành vi đã triển khai

- State PageBox mang cả `viewerPageNum` và `sourcePageNum`, được scope theo
  `WorkspaceContext`; response cũ hoặc frame ảo khác trang không được dùng.
- Checkbox “Hiện khung Art/Trim/Bleed” chỉ bật khi response thật có ít nhất một
  cờ `has_artbox`/`has_trimbox`/`has_bleedbox`.
- Giá trị fallback về MediaBox khi box không khai báo không được biến thành khung
  giả. UI nói rõ trường hợp trang không khai báo box hoặc endpoint không đọc được.
- Bleed/Trim/Art dùng ba kiểu nét và màu riêng, không nhận pointer và chỉ phủ đúng
  phần giao với CropBox đang nhìn thấy.
- Shortcut “Đặt hộp trang” vẫn mở công cụ sửa file thật; checkbox mới chỉ quan sát,
  không âm thầm thay đổi PDF.

`Show: All` và dropdown `Preview` của Acrobat chưa được dựng: backend hiện chưa có
contract lọc object theo nhóm màu/chế độ preview tương ứng. Hai điều khiển này được
giữ ở trạng thái deferred thay vì tạo selector chỉ đổi nhãn nhưng không đổi kết quả.

Verify cuối E3: backend PageBox/API `84 passed`; frontend Output Preview/Viewer/
geometry/i18n `14 file / 78 passed`; typecheck đạt. PageBox đạt `ARTIFACT` trên PDF
khách và `AUTO` cho contract/geometry/DOM; runtime Tauri còn chờ.


## `§OP.12` — `[CONFIRMED]` P1 — Bitmap mô phỏng mất owner khi tất cả kẽm bật

`buildDisplayedPagePlateOverlays()` có chủ ý trả mảng rỗng khi tất cả kẽm bật để
giữ bitmap Viewer color-managed. Tuy nhiên `LivePageFrame` trước đó cũng dùng
`separationPlates.some(pageNum)` làm owner chung cho Soft-Proof, Gamut, TAC và
Overprint; vì vậy URL ảnh có thể đã sẵn sàng nhưng không được mount.

Bản sửa thêm `outputPreviewActiveViewerPage` theo `WorkspaceContext`; bốn bitmap
mô phỏng/cảnh báo dùng identity này, còn lớp kẽm vẫn giữ logic riêng. Identity được
dọn khi đổi trang, unmount hoặc đóng Output Preview và không phụ thuộc endpoint
PageBox/quyền `pdf.crop`.

Verify: typecheck đạt; targeted `5 file / 36 passed`; regression rộng Output
Preview/Viewer `14 file / 79 passed`. Trạng thái `AUTO`; runtime Tauri còn chờ.

## Kết quả audit Lô E4 — Paper Color, Black Ink và Background Color

> Đây là kết quả tại thời điểm contract chưa tồn tại. Lô G và smoke Tauri dev ở
> cuối báo cáo đã thay thế trạng thái `DEFERRED` này.

Tài liệu chính thức Adobe xác nhận ba điều khiển có semantics riêng: Paper Color
mô phỏng màu giấy từ simulation profile; Black Ink mô phỏng điểm đen của profile;
Background Color hiển thị màu trang do người dùng chọn. Nguồn:
[Adobe — Preview output](https://helpx.adobe.com/acrobat/using/previewing-output-acrobat-pro.html).

Trace dọc PrynX cho kết quả:

| Điều khiển | Contract hiện có | Kết luận |
|---|---|---|
| Simulate Paper Color | `SoftProofRequest`/route/facade/native chỉ có profile, intent, gamut và overprint. `ColorManager` dùng một intent chung cho cả chiều vào CMYK và chiều proof ra sRGB. | **Deferred** — không được biến checkbox thành alias của intent `absolute`. |
| Simulate Black Ink | Không có field xuyên tầng. `ColorManager` mặc định bật Black Point Compensation; setter nội bộ không được đưa qua session/facade/native. | **Deferred** — chưa có cách chọn riêng hành vi điểm đen của proof profile. |
| Set Page Background Color | Không có field hoặc compositor giấy/mực. Bitmap soft-proof hiện là ảnh RGB opaque; đổi CSS nền trang không làm thay đổi pixel in. | **Deferred** — CSS background sẽ chỉ tạo cảm giác hoạt động giả. |

Probe PPE trên PDF khách, trang 1 ở 36 DPI, cho thấy `relative` và `absolute` khác
toàn bộ `105.094` pixel: MAE `7,4115`, max delta `25`. Vì vậy tự đổi intent khi bật
“Paper Color” sẽ phá lựa chọn Rendering Intent hiện tại chứ không phải phép ánh xạ
tương đương Acrobat.

Không thêm checkbox E4 trong lô này. Contract đúng cần tách intent chuyển màu nội
dung khỏi intent proof ra màn hình, đưa Paper/Black flags vào cache/session/facade/
native, và có compositor giấy dựa trên lượng mực trước khi mở UI. Trạng thái E4 là
`TRACED + ARTIFACT · DEFERRED`, không phải “đã hỗ trợ”.

## Cập nhật sau triển khai Lô F — khép `§OP.1` ở mức `AUTO + ARTIFACT`

Đường subset/solo trước Lô F lấy PNG màu cố định của từng kẽm rồi dùng CSS
`mix-blend-multiply`. Lô F thay toàn bộ consumer sống này bằng composite ICC từ
chính các mặt phẳng lượng mực đã tách:

```text
Separations PPE (một lần)
  → plane u8 + tint→CMYK LUT 33 mẫu cho từng spot
  → chọn tập kẽm
  → cộng process/spot trong native
  → CMYK → sRGB qua Simulation Profile/Intent hiện tại
  → PNG nhị phân latest-only
  → LivePageFrame hiển thị normal, không CSS multiply
```

Đường này không parse/raster lại PDF khi click. Trên đúng PDF khách trang 1, SWOP
v2, Relative, 150 DPI, bốn trạng thái tập kẽm hoàn tất trong `92,7–103,8 ms`, so
với `895,4 ms` nếu gọi Soft-Proof toàn trang. Composite đủ kẽm đạt MAE RGB
`0,214767`, max delta `5` so với Soft-Proof PPE cùng profile; endpoint PNG hoàn
chỉnh cho solo Dark Blue mất `114,4 ms`.

Frontend giữ bitmap đúng gần nhất trong lúc yêu cầu mới chạy, hủy generation cũ,
decode PNG trước khi commit và trở về bitmap Viewer tức thì khi bật lại đủ kẽm.
Không còn giai đoạn “ảnh CSS sai → ảnh đúng” ở đường subset/solo. Spot thiếu tint
transform bị fail-loud thay vì hash màu hoặc gắn nhãn RIP sai.

Verify: `cargo check` hai crate đạt; 31 test lõi mực, 85 backend và 65 frontend liên
quan đạt; typecheck đạt. Bằng chứng runtime Tauri vẫn còn thiếu vì DLL dev cũ đang
được một tiến trình Python giữ; bản wheel mới đã được nạp cô lập cho toàn bộ probe
và pytest. Các khoảng trống còn mở của `W7-U05` là `§OP.10` runtime Ink Manager,
Show/Preview object filters, engine E4 và smoke Tauri Lô B–F.

## Kết luận cập nhật sau Lô G và smoke Tauri dev

Phần này thay thế các kết luận “còn mở/deferred” ở những mốc lịch sử phía trên.
Đường chạy hiện tại đã được trace lại tới sink thật:

```text
OutputPreviewTab / LivePageFrame
  → SoftProofRequest hoặc ViewerAccurateRenderRequest
  → /preflight/softproof hoặc /preflight/viewer-accurate
  → SoftProofEngine + PPE viewer session/cache identity
  → print_engine.facade
  → PyO3 ppe_softproof / RenderSession.render_softproof
  → RenderOptions (Show filter tại content sink)
  → ColorManager (Paper/Black/Background ở chiều proof)
  → PNG thật → Viewer
```

### Trạng thái findings

| Finding/phạm vi | Trạng thái mới nhất | Bằng chứng chính |
|---|---|---|
| `§OP.1` composite all-on/subset/solo | `RUNTIME` dev | All-on giữ bitmap color-managed; bỏ một kẽm và solo Cyan dựng composite ICC trong smoke, không còn CSS multiply. Artifact all-on MAE `0,214767`, max `5`. |
| `§OP.2–§OP.5` spot/metadata/inventory | `AUTO + ARTIFACT`; inventory đạt `RUNTIME` dev | Tint alternate và metadata đi xuyên facade; Ink Manager trên PDF khách hiển thị đủ C/M/Y/K, Dark Blue, VTB RED và `khuon be`. |
| `§OP.6` reload/flash lần đầu | `RUNTIME` dev | Panel mở không reload/remount Viewer; cold/warm open đều first-visible đồng thời sharp. |
| `§OP.7` khoảng trống test | Đã giảm và có regression | Typecheck đạt; frontend tập trung `148/148`, backend tập trung `182/182`, PPE Rust Show/E4 `9/9`. |
| `§OP.8` Simulation state | `RUNTIME` dev | Đổi SWOP/profile và Rendering Intent làm đổi render identity và trả tile sắc. |
| `§OP.9` Overprint | `RUNTIME` dev | Ảnh Overprint thật được mount; lớp diff chẩn đoán mặc định tắt; regression stale-response đạt. |
| `§OP.10` metadata/Ink Manager | `RUNTIME` dev | Shortcut mở route thật và inventory đủ 7 kênh trên đúng PDF khách. |
| `§OP.11` thứ tự workflow | `RUNTIME` dev | Simulation → Display → Separations → Sampling → Metadata → Advanced → Actions hoạt động trong app thật. |
| `§OP.12` owner bitmap | `RUNTIME` dev | Soft-Proof/Gamut/TAC/Overprint vẫn hiện khi all-on không tạo plate overlay; đổi trang/đóng panel dọn đúng owner. |
| Show/Preview | `RUNTIME` dev + `AUTO` tại sink | Chạy đủ 9 Show và 2 Preview; test PPE chứng minh lọc theo object/color space nguồn, không chỉ đổi state UI. |
| E4 Paper/Black/Background | `RUNTIME` dev + `AUTO` tại engine | Paper đổi proof intent riêng; Black đổi BPC riêng; Background hòa phản xạ giấy/mực và nhận đúng RGB `[216, 201, 167]`. |

Không gọi E4 là pixel-parity tuyệt đối với mọi Acrobat/profile. Bằng chứng hiện có
chứng minh semantics độc lập, pixel contract thật và thao tác Tauri dev; corpus
đối chứng Acrobat rộng hơn vẫn là công việc chất lượng màu riêng nếu cần.

### Báo cáo runtime

- `.tmp/runtime-smoke/tauri-runtime-smoke-report.json`: `42/42`, không fatal,
  `0` console error, `0` HTTP response lỗi; một `ERR_ABORTED` là request cũ bị
  latest-only hủy chủ đích.
- `.tmp/runtime-smoke/cold-warm-open-report.json`: cold `1.909 ms`, warm
  `1.944 ms`; ở cả hai lần first-visible và sharp trùng nhau.
- Viewer: lăn trang `315 ms`; zoom-in dừng → nét `499 ms`; Ctrl+lăn
  `480 ms`; zoom-out `184 ms`; pan `291 ms`; xoay `186 ms`; `0` blank frame.

### Finding phát sinh trong smoke và đã sửa

`/upload/local` có thể hard-link/copy file nguồn cùng mtime cũ. Cleanup trước đây
chỉ xét tuổi file nên có thể xóa một PDF backend vẫn còn đăng ký trong DB, làm
Output Preview 404 sau khi sidecar chạy lâu. Cleanup nay loại path đang được DB sở
hữu trước mọi sweep theo tuổi/áp lực đĩa; regression đạt `8/8` và nằm trong vòng
backend `182/182` nêu trên.

### Cổng còn mở theo chỉ đạo

- Không build production, không tạo/cài installer và không chạy clean-user smoke.
- Vì vậy chỉ ghi `RUNTIME (Tauri dev)`, không ghi `RUNTIME (installed/release)`.
- Cổng release/installed artifact, cùng `§RENDER.11`, vẫn mở; không dùng bằng chứng
  dev để suy rằng bản cài đặt đã đạt.
