# KẾ HOẠCH PPE NATIVE VIEWER THUẦN RUST — 2026-08-13

## 1. Quyết định kiến trúc

PrynX sẽ xây **Viewer chính + thumbnail bằng PPE Native Viewer thuần Rust**.

- Không dùng PDF.js, MuPDF, PDFium, Adobe/Foxit hoặc PDF engine bên ngoài trong đường pixel của Viewer.
- Không xóa PDFium khỏi toàn dự án. Print, Compare, Edit/Geometry, Preflight, VDP, N-up, Sticker và consumer khác giữ nguyên cho tới khi có kế hoạch riêng.
- Có thể dùng codec/phân tích hẹp (`flate2`, JPEG decoder, LittleCMS, font parser...) vì đó không phải PDF engine.
- PDF specification, test golden và artifact Acrobat đã duyệt là nguồn chân lý.

## 2. Mục tiêu trải nghiệm

```text
T0 nhận file
  → PageShell đúng tỷ lệ, không trong suốt
  → lấy page 1 và viewport geometry
  → render PPE frame vào back surface
  → decode/validate xong mới swap
  → nền: scene/resource/page kế cận/thumbnail
```

Bất biến:

1. Không chờ metadata toàn tài liệu để hiện trang 1.
2. Không raster toàn trang khổng lồ khi người dùng chỉ nhìn một viewport.
3. Không tokenize/giải mã lại cùng Form/Pattern/Type3/font/image ở mỗi zoom.
4. Không xóa frame cũ trước khi frame mới hợp lệ.
5. Request stale không được swap, cache hoặc báo ready.
6. `display-preview` và `color-verified` là hai trạng thái khác nhau; PPE chưa sound không được gắn nhãn chính xác.

## 3. Kiến trúc đích

```text
Local file / mmap / range reader
        ↓
PPE ObjectStore
  xref lazy · ObjStm lazy · encryption policy
        ↓
PageIndex + ViewerPageGeometry
        ↓
SceneCompiler / DisplayList IR
  bounds · CTM · clip · dependency · capability
        ↓
Document ResourceStore
  Form · Pattern · Shading · Font/Glyph · Image/Mipmap
        ↓
TileScheduler
  active-first · latest-wins · cancellation · RAM gate
        ↓
PPE raster
  InkSpace · CMYK/spot · ICC · transparency/overprint
        ↓
SurfacePool / double buffer
        ↓
WebView compositor + text/annotation overlay
```

## 4. Các khối kỹ thuật

### 4.1. ObjectStore và PageIndex

- Mở file bằng reader/mmap có thể lấy vùng; không materialize toàn file vào JS hoặc `Vec` eager trong session Viewer.
- Đọc header/trailer/xref tối thiểu; lập index offset/generation/object stream.
- Phân giải page tree theo nhu cầu; page 1 và dependency active được ưu tiên.
- Object stream chỉ giải object được yêu cầu; cache theo document identity.
- Có giới hạn decompression bảo vệ file độc, nhưng chỉ giảm trên tier RAM thấp khi đó là policy tài nguyên; không cap vô điều kiện máy mạnh.

### 4.2. SceneCompiler / DisplayList IR

Compiler biến content stream và stream lồng thành IR bất biến:

- primitive PPE;
- bounds bảo thủ page/device;
- CTM và clip;
- resource ID;
- alpha/blend/overprint/OCG;
- child Form/Pattern/Type3;
- capability và lý do hạ soundness.

Scene được replay ở nhiều DPI/clip mà không parse lại. Form cycle, pattern quá sâu và malformed stream phải có guard + trạng thái lỗi rõ.

### 4.3. ResourceStore

Cache sống theo document session, không theo một `Renderer` ngắn hạn:

- `FormProgram`, `PatternProgram`, `ShadingProgram`;
- `FontProgram`, CMap, glyph outline/raster;
- image source, decoded chunk và mipmap;
- ICC/color transform phù hợp profile/intent.

Mọi key phải chứa document revision; cache màu phải chứa profile/intent/simulation. Eviction LRU theo byte và gate RAM theo quy ước PrynX.

### 4.4. Image pipeline

- Culling bbox trước decode.
- Decode theo vùng/row/chunk nếu codec cho phép.
- Xây mipmap từ source một lần theo ngân sách; tile fit lấy mức phù hợp, zoom lấy mức cao hơn.
- Giữ `/Decode`, Indexed, SMask, CMYK/DeviceN, ICC và overprint chính xác.
- JPX/JBIG2 chưa hỗ trợ phải trả capability, không bỏ im lặng.

### 4.5. Tile renderer

- Tile neo theo page coordinates; clip dùng cùng transform với full page.
- Active viewport ưu tiên hơn nền và thumbnail.
- Hủy request cũ ở cả scheduler và worker; generation kiểm lại trước commit.
- Giữ tile/surface cũ khi wheel/pan; chỉ thay khi target phủ đủ viewport.
- Tile seam-safe và device-pixel snap kế thừa policy hiện có.

### 4.6. Surface/compositor

- Surface RGBA premultiplied có pool và ownership.
- Double buffer: back surface hoàn tất → validate kích thước/identity → swap trong một frame.
- Shared buffer WebView2 là một spike tùy chọn; phải đo copy, decode, texture upload, lifetime và security trước khi chọn.
- PNG chỉ là transport tạm/canary; không để nó định hình API engine lâu dài.

## 5. Roadmap theo phase/lô

### Phase 0 — Baseline, chưa đổi engine

**Lô 0A (≤5 file):** fingerprint artifact/corpus ngoài repo, harness FSP/FCVF/blank-gap, log
parse/resource/raster/encode và phép đo WebView gộp decode/swap/compositor, peak working set core;
`scene_ms` chưa áp dụng khi SceneCompiler chưa tồn tại, RSS toàn cây và ảnh Acrobat reference là gate
runtime/artifact còn mở chứ không được suy từ self-test tĩnh.

**Gate:** 30 cold + 30 warm tối thiểu cho Standee; số liệu P50/P95, peak working set core và một
phép đo RSS toàn cây ứng dụng riêng; không build production.

Phép đo WebView ở Lô 0A tách hai lane để không trộn số: FSP/FCVF trang chính chạy với panel
thumbnail đóng và phải xác nhận trạng thái này ở từng lượt; thumbnail hiện tại có baseline riêng vì
còn dùng PDFium. Đóng thumbnail trong phép đo trang chính không miễn gate Phase 7: sau cutover phải
đo lại Viewer + thumbnail và chứng minh cả hai không còn call site/runtime call PDFium.
Report lane trang chính phải mang scope `end-to-end-webview-main-page-thumbnail-closed`; không được
gọi tắt là baseline toàn Viewer. Lô 0A mới tương quan PPE fulfilled phát sinh sau trigger với pixel
theo path/trang/ưu tiên và hình học request↔`LiveTile` (DPI/xoay/clip/phủ viewport) trong cùng transition,
chưa có request ID từ compositor gắn trực tiếp vào surface; event identity này là hợp đồng phải bổ
sung trước khi dùng phép đo để khẳng định parity request → pixel tuyệt đối.

### Phase 1 — ObjectStore lazy

**Lô 1A (≤5 file):** object store, xref store, page index, session adapter, unit test.

**Gate:** page 1 không cần materialize object table toàn tài liệu; save-over, identity, cancel và malformed PDF có test.

### Phase 2 — Scene IR

**Lô 2A (≤5 file):** scene types, compiler, page program adapter, dependency graph, golden replay test.

**Gate:** cùng scene replay ở fit/100/200% cho pixel/geometry parity; Form/Pattern/Type3 không compile lặp.

### Phase 3 — Resource/image

**Lô 3A (≤5 file):** resource store, font/glyph cache, image source, mipmap/region sampler, tests.

**Gate:** Standee viewport không giải mã lặp toàn ảnh; CMYK/SMask/ICC/spot parity; cache hit/miss có số đo.

### Phase 4 — Tile/coordinator

**Lô 4A (≤5 file):** PPE scheduler, generation contract, cancellation bridge, tile coverage, tests.

**Gate:** no stale commit, no blank gap sau frame đầu, active-first; máy ≥16 GB không bị cap bất biến.

### Phase 5 — Surface spike

**Lô 5A (≤5 file):** Tauri bridge, surface pool, JS receiver, feature flag, benchmark.

**Gate:** shared surface chỉ được promote nếu ổn định lifetime và nhanh/RSS tốt hơn PNG. Nếu không đạt, giữ abstraction và tiếp tục tối ưu engine; không đổi mục tiêu PPE.

### Phase 6 — Capability/correctness

**Lô 6A (≤5 file):** codec/capability matrix, transparency/knockout, font/CMap, annotation/encryption policy, corpus tests.

**Gate:** unsupported báo rõ và giữ frame trước; không trắng im lặng; Standee color-verified đạt soundness.

### Phase 7 — Viewer/thumbnail cutover

**Lô 7A (≤5 file):** loader, main frame, thumbnail session, engine policy, scanner/tripwire.

**Gate:** không còn call site PDFium trong Viewer/thumbnail; PDFium ngoài phạm vi không bị xóa hay đổi hành vi.

## 6. Hợp đồng trạng thái frame

```text
EMPTY
  → REQUESTED
  → RASTER_READY
  → SURFACE_READY
  → COMMITTED
```

- `RUNTIME_READY` chỉ được phát sau khi compositor đã có nội dung thật.
- `generation`, `documentToken`, `page`, `rotation`, `clip`, `pipeline`, `profile/intent` phải khớp.
- `CANCELLED`/`STALE` không được ghi cache hoặc thay frame.
- PPE lỗi capability: giữ `COMMITTED` cũ, gắn warning; không hạ thành frame trắng.

## 7. Ma trận phạm vi

| Consumer | Đích | PDFium |
|---|---|---|
| Viewer trang chính | PPE scene + tile/surface | không |
| Zoom/pan | PPE viewport | không |
| Thumbnail | PPE session dùng chung | không |
| Text/annotation Viewer | scene/overlay PPE | không |
| Print/Print Preview | giữ đường hiện tại | được phép |
| Compare | giữ đường hiện tại | được phép |
| Edit/Geometry | giữ đường hiện tại | được phép |
| Preflight/VDP/N-up/Sticker | giữ đường hiện tại | được phép |

## 8. Chỉ số nghiệm thu

Mục tiêu đề xuất, phải đo lại sau Phase 0:

- Page Shell P95 ≤ 100 ms.
- Standee FSP cold P50/P95 ≤ 250/500 ms; warm ≤ 120/250 ms.
- Zoom-stop warm P50/P95 ≤ 120/300 ms.
- Blank gap sau khi đã có surface: 0 hoặc tối đa 1 animation frame.
- Không cắt/lệch so Acrobat; biên sai ≤ 1 device px.
- Fit/100%/200% + pan bốn góc; mixed-size/rotation/UserUnit/CropBox origin.
- 30 lượt cold/warm; báo peak working set core + RSS toàn cây riêng, payload bytes; Lô 0A chỉ đo
  tổng ranh decode/swap/compositor, tách decode ms và swap ms khi có surface event identity.

## 9. Corpus bắt buộc

1. Standee theo SHA-256 trong báo cáo audit.
2. RGB vector/text, scan, CMYK, DeviceN/spot, OutputIntent.
3. Transparency, soft mask, gradient/mesh, tiling/shading pattern, overprint, knockout.
4. MediaBox/CropBox/TrimBox khác nhau, origin khác 0, UserUnit, rotation 0/90/180/270.
5. JPX, JBIG2, CCITT, Type3, CFF/Type1, CMap châu Á, font không nhúng.
6. Annotation appearance/link, XFA/JavaScript policy, encrypted/password/malformed.
7. Một trang cực lớn, mixed-size, hàng nghìn trang, save-over, nhiều tab.
8. SSD/HDD/NAS/USB và RAM `<8`, `8–15`, `≥16 GB`.

## 10. Nguồn ý tưởng được phép tham khảo

Chỉ tham khảo hành vi/API công khai để thiết kế PPE:

- PDF.js có `PDFPageProxy.getOperatorList`, viewport và `RenderTask.cancel` — ý tưởng về operator stream có thể tái sử dụng, transform và cancellation; không dùng PDF.js runtime.
- MuPDF mô tả display list có thể replay ở nhiều resolution — ý tưởng cho `SceneCompiler`/IR; không dùng MuPDF runtime.
- WebView2 có shared-buffer API — ý tưởng cho transport surface; phải spike và đo trong PrynX, không coi là zero-copy mặc định.

## 11. Điều kiện bắt đầu sửa

Chỉ bắt đầu Phase 0/Lô 0A sau khi chủ dự án duyệt báo cáo audit và danh sách lô. Mỗi lô ≤5 file, có tag truy vết `PERF (audit 2026-08-13 §V.x)` hoặc tag phù hợp, verify hẹp và cập nhật log trước khi sang lô kế.

**Không build production/installer trong kế hoạch này nếu chưa có chỉ đạo rõ ràng.**
