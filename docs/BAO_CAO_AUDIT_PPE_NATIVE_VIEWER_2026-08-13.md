# BÁO CÁO AUDIT PPE NATIVE VIEWER — 2026-08-13

## 0. Chốt phạm vi và trạng thái

**Mục tiêu người dùng:** mở và hiển thị PDF lớn/nặng trong Viewer PrynX nhanh, nét và ổn định như Acrobat, nhưng lõi hiển thị phải là **PPE thuần Rust do PrynX phát triển**.

**Phạm vi audit:**

- Viewer chính (`AcrobatViewer` → `usePdfLoader` → `useTileRenderer` → `LivePageFrame`).
- Thumbnail trong `ThumbSidebar`.
- PPE Rust trong `print_engine` và worker/Tauri chỉ khi nằm trên đường pixel Viewer.
- Luồng mở file, metadata, raster, cancellation, cache, transport và compositor.

**Ngoài phạm vi:** Print/Print Preview, Compare, Edit/Geometry, Preflight/Output Preview, VDP, N-up, Sticker, dieline và các consumer PDFium khác. PDFium ở các consumer này **được giữ nguyên**.

**Trạng thái:** audit tĩnh + trace code + kiểm artifact Standee. Chưa sửa engine, chưa build, chưa chạy lại ứng dụng. Vì vậy các finding tối đa đạt `TRACED`; chưa gắn nhãn `RUNTIME` hoặc tuyên bố đạt chỉ số tốc độ.

**Quyết định kiến trúc:** không đưa PDF.js, MuPDF, Adobe, Foxit hay một PDF engine bên ngoài vào runtime Viewer. Các thư viện công khai chỉ được tham khảo ở mức ý tưởng: operator/display list có thể tái sử dụng, render task có thể hủy, viewport có transform thống nhất và surface có ownership rõ. PDF specification và artifact Acrobat đã duyệt vẫn là nguồn chân lý.

## 1. Kết luận điều hành

PPE hiện **đã có nền tảng tốt**, không phải một renderer rỗng:

- Có `RenderSession`, document identity, generation và stale-file check.
- Có `PageProgram` cho content stream trang, culling ảnh ngoài viewport, cancellation hợp tác và worker process.
- Có InkSpace CMYK/spot, ICC, transparency, optional content và các cảnh báo soundness.
- Có chính sách viewport tile, latest-wins, cache URL và giữ frame cũ ở phía WebView.

Tuy nhiên, PPE hiện chưa có kiến trúc cần thiết để đạt trải nghiệm “mở lên nét ngay” trên file lớn. Năm nút thắt chính là:

1. `lopdf` đang đọc toàn bộ file/object vào bộ nhớ khi mở; PPE còn dựng descriptor của **mọi trang** trước khi trả session.
2. Ảnh giao với viewport vẫn giải mã toàn bộ ảnh nguồn; chưa có decode theo vùng, mipmap hoặc downsample theo nhu cầu.
3. Mỗi render vẫn đi qua `InkBuffer → PNG → IPC → Blob → WebView decode → <img>`, tạo thêm encode/copy/decode và đỉnh RAM.
4. Display list/resource graph chưa bao phủ Form/Pattern/Type3/font/glyph; các phần lồng vẫn diễn giải lại.
5. Viewer chính và thumbnail hiện còn gọi đường PDFium; metadata/risk cũng có thể chặn mount trang trước first paint.

**Kết luận go/no-go:**

- **Không nên promote PPE hiện tại thành Viewer mặc định** chỉ bằng cách đổi một cờ engine.
- **Nên tiếp tục PPE Native Viewer theo lộ trình nhiều pha**, bắt đầu bằng baseline và object store lazy.
- Với Standee, lỗi “không dựng được trang này” hoặc chờ rất lâu **không có bằng chứng do Rotate/page box**; nguyên nhân có xác suất cao hơn là chi phí decode/raster/transport và khả năng chịu surface lớn.

## 2. Ground truth — file Standee

Nguồn: `C:\Users\Khanh Pham\Desktop\Standee_800x1600mm-1.pdf`, đọc bằng `pypdf 6.14.2` trong `backend\venv` và đối chiếu artifact raster đã có.

| Thuộc tính | Giá trị đã xác minh |
|---|---|
| Dung lượng | `20.624.091` byte |
| SHA-256 | `D3AFDAA6C3940F0431FE26EA3CBEEDB8E59FE85C2A802DB49A95BE856868F61C` |
| Header | `%PDF-1.7` |
| Trang / mã hóa | `1` / không mã hóa |
| MediaBox | `[0, 0, 2267,72, 4960,63] pt` |
| CropBox | trùng MediaBox |
| Rotate / UserUnit | `0` / `1` |
| OutputIntent | có |
| Ảnh 1 | `3150 × 6299`, DeviceCMYK, FlateDecode |
| Ảnh 2 | `3120 × 3120`, DeviceCMYK, FlateDecode |

Ước lượng pixel:

- Trang ở 92 dpi: khoảng `2898 × 6339 = 18,37 MP`.
- Trang ở 96 dpi: khoảng `3024 × 6614 = 20,00 MP`.
- Ảnh 1: `19,84 MP`, mẫu RGBA tương đương khoảng `75,7 MiB` trước các buffer phụ.
- Ảnh 2: `9,73 MP`, mẫu RGBA tương đương khoảng `37,1 MiB`.

Do MediaBox = CropBox, Rotate = 0 và UserUnit = 1, không có cơ sở xếp lỗi lệch/cắt của Standee vào nhóm page-box/rotation. File này là corpus tốt để đo đúng chi phí ảnh CMYK lớn và đường truyền surface.

## 3. Đường chạy live đã trace

### 3.1. Mở file và metadata

```text
AcrobatViewer
  → usePdfLoader
  → Tauri get_pdf_viewer_bootstrap
  → render_worker::bootstrap_with_policy
  → viewer_bootstrap_in_process / PDFium worker
  → setNumPages + setPageDim + mount LivePageFrame
```

Bằng chứng:

- `desktop/src/hooks/viewer/usePdfLoader.ts:424-480`: native PDF lấy path, gọi `get_pdf_metadata`/HTTP fallback khi cần.
- `desktop/src/hooks/viewer/usePdfLoader.ts:522-550`: gọi `get_pdf_viewer_bootstrap`; nếu response thiếu `colorRisk`, loader chờ full metadata trước khi mount.
- `desktop/src/hooks/viewer/usePdfLoader.ts:572-623`: sau bootstrap mới set kích thước, số trang, order và `markReady`.
- `desktop/src-tauri/src/lib.rs:1897-1930`: Tauri command bootstrap dispatch worker hoặc `viewer_bootstrap_in_process`.
- `desktop/src-tauri/src/lib.rs:1952-1987`: đường in-process mở document PDFium, lấy số trang/kích thước/risk.
- `desktop/src-tauri/src/lib.rs:1991-2015,2018-2050`: metadata đầy đủ là một command riêng và vẫn mở/đọc document native.

### 3.2. Trang chính và tile

```text
LivePageFrame / LiveTile
  → useTileRenderer.getTileUrl
  → RenderCoordinator
  → Tauri render_pdf_page (display) hoặc render_ppe_page (accurate)
  → worker process / in-process
  → PNG bytes
  → Blob URL
  → new Image() decode
  → <img> swap vào frame
```

Bằng chứng:

- `desktop/src/hooks/viewer/useTileRenderer.ts:345-460`: native path tạo request display và gọi `render_pdf_page`; bytes được bọc thành `Blob('image/png')`.
- `desktop/src/hooks/viewer/useTileRenderer.ts:498-642`: PPE accurate gọi `render_ppe_page`, nếu lỗi capability có thể rơi compatibility lane khi mode `hybrid`, sau đó vẫn tạo Blob URL.
- `desktop/src-tauri/src/lib.rs:2610-2730`: `render_pdf_page` dispatch worker/in-process và trả `tauri::ipc::Response::new(data)`.
- `desktop/src-tauri/src/lib.rs:2733-2827`: `render_ppe_page` cũng trả PNG qua `tauri::ipc::Response`.
- `desktop/src/components/workspace/LivePageFrame.tsx:663-763`: preload bằng `new Image()`, đợi decode rồi mới gán `imgRef.current.src`.
- `desktop/src/components/workspace/LivePageFrame.tsx:952-964`: surface cuối là `<img>` với `objectFit: 'fill'`.

### 3.3. Thumbnail

- `desktop/src/components/acrobat/ThumbSidebar.tsx:173-236`: thumbnail native gọi trực tiếp `render_pdf_page`, tạo Blob URL riêng, chạy scheduler background và hủy request khi unmount.
- `desktop/src/components/acrobat/ThumbSidebar.tsx:364-383,460-498`: thumbnail bị trì hoãn tới khi trang chính phát `prynx-main-tile-ready` hoặc hết 700 ms; chỉ các item trong vùng quan sát mới tải.

### 3.4. PPE worker và session

- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1393-1601`: lấy session PPE, render vùng, chuyển RGB và encode PNG.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1433-1450`: pool session giữ một mutex trong suốt việc tìm/điều chỉnh pool.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1513-1553`: session được tạo/cache theo document/profile; `entry.session.render_page_srgb_region_timed` chạy trên session mutable.
- `print_engine/src/session.rs:552-633`: `RenderSession::open...` đọc file, parse và dựng page descriptors trước khi trả session.
- `print_engine/src/session.rs:871-949`: mỗi render lấy descriptor rồi gọi `render_page_descriptor`.

## 4. Phát hiện đã xác minh

Severity dùng theo ảnh hưởng trên đường Viewer; `TRACED` không có nghĩa đã đo runtime.

### §V.1 — `[CONFIRMED]` P1 / M — Mở PPE eager toàn file và toàn bộ cây trang

**Sink/đường chạy:** `render_ppe_page` → `render_accurate_png` → `RenderSession::open_with_profile_paths_timed` → `Document::load_from` → `build_page_descriptors`.

**Bằng chứng:**

- `print_engine/src/session.rs:572-575`: `Document::load_from(BufReader::new(file))`.
- `print_engine/src/session.rs:611-622`: `build_page_descriptors(&document)` chạy ngay trong open.
- `print_engine/src/page.rs:132-158`: lặp qua toàn bộ `doc.get_pages()`, đọc box/resources/rotate cho từng trang.
- Dependency đang khóa là `lopdf 0.44.0` (`print_engine/Cargo.lock:405-428`). Source dependency hiện hành cho thấy `load_from` đọc hết input vào `Vec` (`lopdf/src/reader.rs:77-90`), sau đó `read()` nạp object/xref (`:782-861`) và `load_objects_raw()` đi qua toàn bộ reference table (`:968-1077`).

**Tác động:** first page không thể bắt đầu từ một object/page tối thiểu; tài liệu dài hoặc nhiều object phải trả chi phí parse/object stream trước. Với Standee một trang, toàn bộ 20 MB vẫn phải đọc; với tài liệu hàng trăm/trăm nghìn object, chi phí tăng theo file chứ không theo vùng đang nhìn.

**Consumer live:** `render_accurate_png` đọc kết quả session ở `render_worker.rs:1535-1541`.

**Cách sửa đề xuất:** thay bằng `PpeObjectStore` clean-room: mmap/file-range, xref index lazy, object stream index lazy, page tree index lazy; chỉ materialize page 1 và dependency của viewport. Không sửa bằng cách thêm một cap vô điều kiện.

### §V.2 — `[CONFIRMED]` P1 / M — Ảnh giao viewport vẫn giải mã toàn nguồn

**Sink/đường chạy:** `Renderer::draw_image` → `decode_image_cached` → `decode_image_with_cancel`.

**Bằng chứng:**

- `print_engine/src/content/interp.rs:2507-2518`: chỉ cull khi bbox ảnh hoàn toàn ngoài buffer; nếu giao viewport thì gọi decode.
- `print_engine/src/image/sampler.rs:301-357`: đọc Width/Height và chạy toàn bộ filter chain.
- `print_engine/src/image/sampler.rs:362-452`: unpack/decode thành `SampledImage` có kích thước nguồn; soft mask cũng tạo buffer theo kích thước ảnh (`:455-501`).
- `print_engine/src/page.rs:222-227` ghi rõ buffer đích theo clip nhưng ảnh nguồn giao viewport vẫn cần decode đầy đủ.

**Tác động trên Standee:** ảnh CMYK `3150×6299` vẫn có thể phải giải Flate/unpack khoảng 19,84 MP ngay cả khi người dùng chỉ nhìn một vùng nhỏ. Mỗi tile ở zoom/pan có thể lặp chi phí nếu cache không giữ được mẫu.

**Cách sửa đề xuất:** image resource có nhiều mức lấy mẫu; decode trực tiếp vùng/scanline khi codec cho phép; với Flate CMYK dùng row index/chunk và mipmap theo document budget; giữ semantics `/Decode`, ICC, SMask, overprint. Không hạ DPI của viewport để che chi phí nguồn.

### §V.3 — `[CONFIRMED]` P1 / M — Pipeline PNG/IPC/Blob/decode nằm giữa PPE và compositor

**Sink/đường chạy:** Rust `PngEncoder`/`Response` → JS `ArrayBuffer` → `Blob` → `new Image()` → `<img>`.

**Bằng chứng:**

- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1582-1591`: PPE encode RGB thành PNG.
- `desktop/src-tauri/src/lib.rs:2721-2727,2821-2827`: trả bytes bằng `tauri::ipc::Response::new`.
- `desktop/src/hooks/viewer/useTileRenderer.ts:450-460,639-642`: tạo Blob URL.
- `desktop/src/components/workspace/LivePageFrame.tsx:691-763`: tạo Image, đợi decode rồi swap.

**Tác động:** thêm thời gian encode, cấp phát/copy payload, giải mã PNG trong WebView và upload texture. Với surface lớn, đỉnh RAM không chỉ là `InkBuffer`; còn có PNG bytes, Blob, decoded image và bitmap đang hiển thị. Đây là đường có thể giải thích hiện tượng “khung trong suốt/Loading” dù Rust đã hoàn tất raster.

**Cách sửa đề xuất:** tạo `SurfacePool` RGBA premultiplied có ownership/generation; thử nghiệm WebView2 shared buffer ở một spike riêng; chỉ giữ PNG làm compatibility/canary trong thời gian chuyển đổi. Không tuyên bố zero-copy trước khi đo.

### §V.4 — `[CONFIRMED]` P1 / M — Display list/resource graph chưa đủ dài sống

**Bằng chứng:**

- `print_engine/src/page_program.rs:1-5,13-35`: chỉ cache operator của content stream trang và ảnh nội tuyến; Form/Pattern/Type3 vẫn decode lúc thực thi.
- `print_engine/src/content/interp.rs:603-625`: `execute()` gọi `PageProgram::compile(data)` cho stream lồng.
- `print_engine/src/content/interp.rs:2048-2205`: Form XObject lấy `decompressed_content()` rồi chạy lại.
- `print_engine/src/content/interp.rs:3245-3275,3361-3579`: shading/tiling pattern được đọc và chạy lại theo lần render.
- `print_engine/src/content/interp.rs:350-355,470-518`: `font_cache` và `image_cache` là field của một `Renderer`; renderer mới được tạo trong `page.rs:317-328` cho mỗi lượt.
- Cache sống qua session tại `print_engine/src/session.rs:268-277` chỉ lưu `images`, không lưu compiled form/pattern/font/glyph/shading.

**Tác động:** zoom/pan/re-render cùng tài liệu vẫn lặp tokenize/resolve/parse cho resource lồng; chữ và form phức tạp không hưởng lợi đầy đủ từ session. Đây là khoảng cách cốt lõi so với mô hình display list có thể replay nhiều độ phân giải.

**Cách sửa đề xuất:** `SceneCompiler` tạo IR bất biến có node bounds, CTM, clip và dependency; `ResourceStore` theo document giữ FormProgram, PatternProgram, ShadingProgram, FontProgram/GlyphOutline và image mipmap. Cần cycle/depth guard và namespace theo document/profile.

### §V.5 — `[CONFIRMED]` P1 / S — First paint còn bị ràng bởi metadata/risk và PDFium

**Bằng chứng:**

- `desktop/src/hooks/viewer/usePdfLoader.ts:522-550`: bootstrap thiếu `colorRisk` thì loader chờ `loadFullMetadata` trước khi set page state.
- `desktop/src/hooks/viewer/usePdfLoader.ts:572-623`: chỉ sau đó mới mount trạng thái trang.
- `desktop/src-tauri/src/lib.rs:1952-1987`: bootstrap in-process dùng PDFium và lấy `bootstrap_color_risk`.

**Tác động:** đường first paint không độc lập với detector/metadata engine. Khi command chậm, binary cũ thiếu field hoặc risk scan gặp file nặng, người dùng có thể thấy khung chờ trước khi có nội dung. Điều này trái mục tiêu PPE-only Viewer và trái yêu cầu “giữ frame cũ tới khi frame mới thật sự sẵn”.

**Cách sửa đề xuất:** PageShell + PPE/PDF parser tối thiểu phải mount trước; risk là tín hiệu ưu tiên accurate, không phải cổng chặn pixel đầu tiên. Frame phải mang nhãn `display-preview`/`color-verified`; PPE lỗi không xóa frame đã có.

### §V.6 — `[CONFIRMED]` P2 / M — Thumbnail là đường render riêng và còn gọi PDFium

**Bằng chứng:** `desktop/src/components/acrobat/ThumbSidebar.tsx:173-236,198-211` gọi `render_pdf_page` với `pipelineIdentity: 'pdfium-display-png-v1'`; mỗi thumbnail tạo Blob riêng.

**Tác động:** thumbnail có thể tranh lane/CPU/RAM với trang chính và không dùng chung document scene/resource PPE. Gate 700 ms giảm tranh chấp nhưng không loại bỏ parser/render trùng.

**Cách sửa đề xuất:** thumbnail dùng chung `ViewerDocumentSession`, `PageProgram`/scene và resource cache; chỉ xin một raster nhỏ từ PPE tile scheduler ở priority nền.

### §V.7 — `[CONFIRMED]` P2 / M — PPE hiện có các capability khiến render accurate bị từ chối

**Bằng chứng:**

- `print_engine/src/image/filters.rs:133-169` chỉ xử lý một tập filter; codec ảnh còn lại trả unsupported.
- `print_engine/src/image/sampler.rs:420-422` trả lỗi cho codec chưa hỗ trợ.
- `print_engine/src/content/interp.rs:2256-2261` đánh dấu knockout transparency chưa dựng exact.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1320-1371` phân loại JPX/JBIG2, transparency, hidden content, màu xấp xỉ và font thay thế thành unsupported/degraded.
- `desktop/src/hooks/viewer/useTileRenderer.ts:555-570` chỉ mode `hybrid` mới được compatibility lane; PPE-only sẽ phải báo capability.

**Tác động:** với file dùng JPX/JBIG2/knockout/font không nhúng, “không dựng được trang” là hành vi có chủ đích của soundness gate hiện tại, nhưng trải nghiệm chưa có lớp giữ frame/giải thích rõ. Với Standee cụ thể, hai ảnh là Flate DeviceCMYK nên finding này **không phải nguyên nhân trực tiếp đã chứng minh**.

**Cách sửa đề xuất:** capability matrix + fail-loud UI; bổ sung codec/feature theo thứ tự corpus; không trả ảnh trắng và không gọi PDFium ẩn trong Viewer.

### §V.8 — `[CONFIRMED]` P2 / S — PPE accurate session chưa tối ưu concurrency theo scene bất biến

**Bằng chứng:**

- `render_worker.rs:1433-1450` giữ khóa pool trong lúc quản lý session.
- `render_worker.rs:1529-1541` gọi render mutable trên `RenderSession`.
- `print_engine/src/session.rs:856-858` `into_shared` dùng `Arc<Mutex<RenderSession>>`.

**Kết luận:** có serialization thật ở cấp session; mức ảnh hưởng tổng thể còn phụ thuộc số worker lane nên cần benchmark, chưa được tự động tuyên bố là lỗi 2×. Kiến trúc scene immutable + render state/tile riêng sẽ cho phép song song an toàn hơn mà không phá PDFium thread-safety ở consumer khác.

## 5. Những phần đã đúng — không được làm ngược

Các điểm sau là `[EXPECTED]`/`[CONFIRMED]` tốt, cần giữ khi thay engine:

- `RenderCoordinator` có identity/generation/latest-wins và không nên để response stale tạo Blob (`desktop/src/hooks/viewer/renderCoordinator.ts:295-350`).
- `LiveTile` đợi ảnh decode trước khi swap (`LivePageFrame.tsx:691-743`), giữ cache URL và revoke có ownership (`:719-730,859-882`).
- Viewport grid neo theo tọa độ trang, active-first và kiểm coverage (`desktop/src/components/workspace/viewportTilePolicy.ts:158-255,301-362`).
- Surface budget 12 MP là **cổng an toàn cho bitmap toàn trang**, không phải cap chất lượng (`desktop/src/components/workspace/renderZoomPolicy.ts:18-53`). Không được biến nó thành hard-cap DPI trên máy mạnh.
- PPE culling ảnh ngoài viewport (`interp.rs:2507-2518`) và cancellation qua filter/sample (`sampler.rs:301-328`, `filters.rs:120-179`) là nền tốt để mở rộng.
- `RenderWarnings` phân biệt mất nội dung, transparency, màu xấp xỉ và geometry (`print_engine/src/error.rs:85-141`); không được nuốt thành trang trắng.

## 6. Phân tích riêng cho Standee

### Điều đã loại trừ

- Không phải Rotate bất thường: `/Rotate 0`.
- Không phải CropBox lệch MediaBox: hai box trùng nhau.
- Không phải UserUnit bị nhân hai lần: `/UserUnit 1`.
- Không phải mã hóa/password.

### Chuỗi chi phí có khả năng cao

```text
20,6 MB PDF
  → đọc/parse object eager
  → giải Flate + unpack toàn ảnh CMYK nguồn
  → render InkBuffer/ICC
  → encode PNG
  → IPC response
  → Blob + WebView PNG decode
  → texture/compositor
```

Ở fit-to-window, frontend đã có policy chuyển trang lớn sang viewport khi surface vượt khoảng 12 MP (`renderZoomPolicy.ts:18-53`). Nhưng policy này chỉ giảm **buffer đích/WebView surface**; nó chưa giảm chi phí giải mã ảnh nguồn ở PPE (§V.2) và chưa bỏ PNG round-trip (§V.3). Vì vậy việc tăng/giảm một cap ở UI không giải quyết tận gốc.

## 7. Kiến trúc PPE Native Viewer đề xuất

```text
File / mmap / range reader
        ↓
PPE ObjectStore (xref lazy, ObjStm lazy, encryption policy)
        ↓
PageIndex + ViewerPageGeometry
        ↓
SceneCompiler / DisplayList IR
  (bounds, CTM, clip, dependency, capability)
        ↓
Document ResourceStore
  (image mipmap, font/glyph, Form, Pattern, Shading)
        ↓
TileScheduler active-first + cancellation
        ↓
PPE tile renderer / InkBuffer / ColorManager
        ↓
SurfacePool + double buffer + generation
        ↓
WebView compositor + text/annotation overlay
```

### 7.1. ObjectStore

- Đọc header/trailer/xref tối thiểu; giữ file mapping hoặc reader range.
- Index page tree mà không materialize mọi stream.
- Object thường chỉ parse khi scene/resource yêu cầu.
- ObjStm chỉ giải object cần thiết; cache index và object theo identity.
- Có giới hạn decompression theo RAM tier và theo object, nhưng không đặt một cap vô điều kiện làm máy mạnh chậm.
- File hỏng/malformed/password phải trả capability/error có mã, không trả trang trắng.

### 7.2. SceneCompiler / DisplayList IR

Mỗi node cần có:

- operator/primitive PPE;
- bounds bảo thủ trong page space và device space;
- CTM/clip dependency;
- resource IDs;
- blend/alpha/overprint/optional-content flags;
- capability/soundness metadata;
- child references cho Form/Pattern/Type3.

Compiler chạy một lần theo document generation. Tile chỉ replay node giao vùng nhìn; không tokenize lại Form/Pattern/Type3 mỗi lần zoom.

### 7.3. ResourceStore

- Cache document-scoped: FormProgram, PatternProgram, ShadingProgram, FontProgram, GlyphOutline, ImageSource và mipmap.
- Cache key luôn gồm document identity; cache màu thêm profile/intent/simulation.
- Image pipeline có đường lấy mẫu vùng và mức phân giải; không decode toàn ảnh nếu tile không cần.
- SMask/transparency/overprint vẫn tính trong PPE ink space trước khi quy màu.

### 7.4. Tile renderer và compositor

- Tile active-first; request mới hủy request stale vật lý.
- Giữ surface cũ trong lúc zoom/pan; chỉ swap back surface sau decode/validate.
- Tile key neo page coordinates, device-pixel snap và seam-safe như policy hiện tại.
- Surface pool tái sử dụng buffer; generation/owner bảo vệ nhiều tab và save-over.
- Shared buffer WebView2 chỉ là transport spike cần đo; không coi là bảo đảm zero-copy.

## 8. Lộ trình triển khai sau khi được duyệt

Mỗi lô tối đa 5 file, verify hẹp xong mới sang lô kế. Danh sách dưới là kế hoạch, chưa phải ủy quyền sửa.

### Phase 0 — Baseline và harness

**Lô 0A (tối đa 5 file):** fingerprint artifact/corpus ngoài repo, trace FSP/FCVF/blank-gap,
đo peak working set core + PNG bytes và phép đo WebView gộp decode/swap/compositor. `scene_ms` chưa
áp dụng khi SceneCompiler chưa tồn tại; RSS toàn cây và reference Acrobat vẫn là gate runtime/artifact
còn mở, không được suy từ self-test tĩnh.

**Làm rõ sau khi triển khai harness:** report WebView của Lô 0A chỉ mang scope
`end-to-end-webview-main-page-thumbnail-closed`; thumbnail cần baseline runtime riêng. Tương quan PPE
request → pixel hiện dừng ở candidate phát sinh sau trigger, khớp path/trang/ưu tiên và hình học
request↔`LiveTile` theo DPI/xoay/clip/phủ viewport; compositor
chưa phát request ID gắn trực tiếp với surface, nên đây chưa phải parity request → pixel tuyệt đối.

**Gate:** có ít nhất 30 lượt cold/warm tách riêng trên máy audit; ghi P50/P95; không đổi engine.

### Phase 1 — PPE file/object layer

**Lô 1A:** `print_engine/src/object_store.rs` mới, `print_engine/src/xref_store.rs` mới, `print_engine/src/page_index.rs` mới, `print_engine/src/session.rs`, test session.

**Gate:** Standee mở được page 1 mà không load toàn object table; identity/save-over/cancel không hồi quy; memory peak giảm hoặc không tăng.

### Phase 2 — Page geometry và scene IR

**Lô 2A:** `page.rs`, `page_program.rs`, `scene.rs` mới, `scene_compile.rs` mới, test golden scene.

**Gate:** Form/Pattern/Type3 dependency, CropBox/origin/rotation/UserUnit và bounds parity đạt artifact; scene replay không đổi pixel trên corpus hiện có.

### Phase 3 — Resource/image pipeline

**Lô 3A:** resource store, font/glyph cache, image source/mipmap, sampler viewport, tests.

**Gate:** Standee fit chỉ decode/tạo dữ liệu cần cho viewport; zoom/pan warm không lặp decode toàn ảnh; CMYK/SMask/ICC parity giữ nguyên.

### Phase 4 — Tile scheduler và surface ownership

**Lô 4A:** render coordinator contract, PPE tile scheduler, surface pool, compositor state, tests.

**Gate:** latest-wins, cancellation, no stale swap, blank gap tối đa một animation frame; active tile luôn thắng thumbnail/prefetch.

### Phase 5 — Shared surface spike

**Lô 5A (tối đa 5 file):** Tauri WebView2 bridge, Rust surface allocator, JS receiver, feature flag/canary, benchmark.

**Gate:** so sánh PNG và shared surface bằng cùng frame/hash/kích thước; chỉ promote nếu tổng thời gian + peak RSS tốt hơn và cleanup/release an toàn. Nếu API không phù hợp build/runtime, giữ surface abstraction và dùng transport khác trong lúc tiếp tục tối ưu PPE.

### Phase 6 — Capability/correctness

**Lô 6A:** JPX/JBIG2 policy/decoder work, knockout/transparency gaps, annotations, encryption/password, CMap/font corpus.

**Gate:** unsupported không còn biến thành trang trắng; UI giữ frame trước và nói rõ “màu/nội dung chưa được kiểm chứng”; Standee không bị hạ soundness.

### Phase 7 — Viewer và thumbnail cutover

**Lô 7A:** loader/bootstrap Viewer, main frame, thumbnail session, engine policy, scanner/tripwire.

**Gate:** Viewer chính + thumbnail không gọi `render_pdf_page`, `get_pdf_viewer_bootstrap`, `get_pdf_metadata` hoặc pipeline `pdfium-display-*`; consumer ngoài Viewer vẫn giữ nguyên call graph.

## 9. Chỉ số nghiệm thu đề xuất

Các số dưới đây là **mục tiêu cần đo**, chưa phải kết quả hiện tại:

| Chỉ số | Mục tiêu đề xuất trên máy audit 32 GB/16 luồng/SSD |
|---|---:|
| Page Shell P95 | ≤ 100 ms |
| Standee FSP cold P50/P95 | ≤ 250 / 500 ms |
| Standee FSP warm P50/P95 | ≤ 120 / 250 ms |
| Zoom-stop warm P50/P95 | ≤ 120 / 300 ms |
| Blank gap sau surface đầu | 0 hoặc tối đa 1 frame |
| FCVF Standee cold/warm P95 | baseline Phase 0, mục tiêu đầu ≤ 900 / 500 ms |
| Geometry so Acrobat | không cắt/lệch; biên ≤ 1 device px |

Bắt buộc kiểm ở fit, 100%, 200%, pan bốn góc; mixed-size, rotation 0/90/180/270; máy `<8 GB`, `8–15 GB`, `≥16 GB`. Máy `≥16 GB` không được cap worker/DPI/chất lượng vô điều kiện.

## 10. Rủi ro và nguyên tắc không được vi phạm

- Không dùng PDFium làm oracle pixel cho Viewer mới; Acrobat đã duyệt + PDF invariants + PPE artifact là oracle.
- Không thêm fallback PDFium ẩn vào PPE-only Viewer. Compatibility chỉ tồn tại ở consumer ngoài phạm vi hoặc trong canary có cờ rõ ràng trước cutover.
- Không xóa frame hợp lệ chỉ vì PPE request mới đang chạy.
- Không để unsupported capability trả PNG trắng/đen mà không có trạng thái.
- Không đưa `[profile.release]`/LTO vào Cargo.toml; build chưa nằm trong audit này.
- Không hard-cap vô điều kiện; mọi giảm cache/prefetch phải gate RAM theo quy ước PrynX.
- Không sửa quá 5 file/lô trước khi verify.

## 11. Khoảng trống bằng chứng còn mở

| Hạng mục | Trạng thái | Bước xác minh tiếp |
|---|---|---|
| FSP/FCVF Standee trên PPE hiện tại | `UNKNOWN`/chưa runtime | baseline harness sau khi được duyệt |
| Tỷ lệ thời gian parse/raster/color/PNG/decode | `TRACED`, chưa đo mới | instrument tại worker + compositor |
| Shared buffer WebView2 | `TRACED` API khả dụng trong SDK, chưa tích hợp | spike riêng trên Windows thật |
| JPX/JBIG2/knockout/CMap | `TRACED` capability gap | corpus + implementation wave |
| Installed/release Viewer call graph | chưa kiểm runtime | scanner + smoke sau canary |
| PDFium consumer ngoài Viewer | giữ nguyên, chưa thay | regression riêng sau mỗi cutover |

## 12. Chốt duyệt

Đề nghị duyệt **kiến trúc PPE Native Viewer thuần Rust** và bắt đầu từ Phase 0/Lô 0A. Báo cáo này dừng tại đây theo quy trình audit PrynX; chưa có thay đổi code để commit hoặc build.
