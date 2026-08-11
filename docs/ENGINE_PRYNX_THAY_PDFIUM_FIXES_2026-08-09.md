# NHẬT KÝ TRIỂN KHAI ENGINE PRYNX THAY PDFIUM

**Ngày bắt đầu:** 2026-08-09  
**Kế hoạch SSOT:** `docs/KE_HOACH_ENGINE_PRYNX_THAY_THE_PDFIUM_2026-08-09.md`  
**Quy tắc:** mỗi lô tối đa 5 file, test đỏ → sửa nhỏ → test xanh → verify toàn crate.

## Gate 0A — Correctness bounded soft-mask

**Trạng thái:** hoàn tất code và kiểm thử tự động; chưa xác nhận bằng corpus khách hoặc
runtime Tauri cài đặt.

### File thay đổi

1. `print_engine/src/content/interp.rs`
   - Pixel `/Alpha` trong lề khử răng cưa ngoài `/BBox` dùng đúng `TR(0)` thay vì ghi cứng 0.
   - Clip chữ giữ đồng thời mask và `Region`; tại `ET` giao cả hai với clip hiện hành.
   - Guard-band soft-mask bằng bán kính lấy mẫu 3 px nhân số tầng còn lại; tối đa 12 px
     cho giới hạn bốn tầng, không còn magic number tách khỏi giới hạn độ sâu.
2. `print_engine/tests/render_transparency.rs`
   - Khóa `TR(0)` ngay ngoài đủ bốn cạnh `/BBox`.
   - Khóa đỉnh image soft-mask ngoài cửa sổ clip một tầng.
   - Khóa nested image soft-mask với origin khác 0 bằng oracle bounded/full-frame từng kênh.
   - Điều chỉnh ngân sách fixture bounded để chứa guard tối đa nhưng vẫn không đủ full-frame.
3. `print_engine/tests/render_text.rs`
   - Khóa text clip nhỏ + `/BBox` sentinel dưới ngân sách chặt; output trong glyph vẫn còn mực.
4. `docs/KE_HOACH_ENGINE_PRYNX_THAY_THE_PDFIUM_2026-08-09.md`
   - Đánh dấu ba finding Gate 0A đã đóng tự động và giữ ba finding Gate 0B ở trạng thái mở.
5. `docs/ENGINE_PRYNX_THAY_PDFIUM_FIXES_2026-08-09.md`
   - Nhật ký bằng chứng của lô này.

### Bằng chứng test đỏ

- `alpha_soft_mask_guard_pixels_outside_every_bbox_edge_use_transfer_of_zero`:
  cạnh trái nhận `0`, trong khi oracle yêu cầu khoảng `64` cho `TR(0)=0,25`.
- `text_clip_bounds_a_following_sentinel_soft_mask_under_tight_budget`:
  trả `MemoryBudgetExceeded` vì `ET` chưa cập nhật `clip_region`.
- `bounded_soft_mask_keeps_image_peak_just_outside_clip_window`:
  mất đỉnh cách pixel cần đo đúng 3 px.
- `bounded_nested_image_soft_masks_match_full_frame_with_nonzero_origin`:
  guard cố định 3 px vẫn cho K bounded bằng 0 trong khi oracle full-frame bằng 255;
  điều này chứng minh footprint phải cộng dồn theo độ sâu lồng.

### Bằng chứng sau sửa

- `cargo test --locked --test render_transparency`: `43 passed`.
- `cargo test --locked --test render_text`: `15 passed`.
- `cargo test --locked`: `587 passed`, không cập nhật golden.
- `cargo check --locked`: đạt.
- `git diff --check` trên toàn bộ 5 file của lô: đạt.

### Giới hạn xác minh

- `cargo fmt --all -- --check` còn báo format drift đã có sẵn ở nhiều file ngoài lô
  (`ink.rs`, `raster/mask.rs`, `text/outlines.rs` và các integration test khác). Không chạy
  autoformat toàn crate để tránh chạm thay đổi hiện hữu ngoài phạm vi Gate 0A.
- Chưa benchmark lại PDF khách; Gate 0A là correctness gate, không phải lô tối ưu decode ảnh.
- Gate 0B tiếp tục xử lý ba finding RAM/API; sau lô đó mới có thể gọi Gate 0 hoàn tất.

## Gate 0B — MemoryBudget và API SoftMask

**Trạng thái:** hoàn tất code và kiểm thử tự động; chưa benchmark PDF khách hoặc xác nhận
runtime Tauri cài đặt.

### File implementation của lô

1. `print_engine/src/ink.rs`
   - Thêm `MemoryLease` RAII dùng chung reservation với `InkBuffer`.
   - Mở constructor `InkBuffer::new_soft_mask` và mẫu `SoftMask::values/values_mut`
     cho caller ngoài crate.
2. `print_engine/src/raster/mask.rs`
   - Tính scratch mask + coverage của `Rasterizer` vào budget root/child.
   - Đặt chỗ lazy cho ring scratch; đường production dùng API checked để không nuốt
     `MemoryBudgetExceeded`, còn API `fill_adjust_ring` cũ vẫn giữ nguyên kiểu trả về.
   - Khóa reservation được trả cả khi drop và khi cấp ring thất bại.
3. `print_engine/src/content/interp.rs`
   - Root và child rasterizer dùng budget chung.
   - Chỉ bật RGB luminosity sidecar khi có `ColorManager` thực sự dùng được.
4. `print_engine/tests/render_transparency.rs`
   - Khóa unmanaged RGB dưới ngân sách chặt.
   - Khóa budget root và rasterizer cục bộ; fail có kiểm soát, không OOM/leak.
5. `print_engine/tests/api_compat.rs`
   - Compile/run như crate bên ngoài: tự tạo, điền và truyền `SoftMask` vào rasterizer.

### Bằng chứng test đỏ

- External API dừng ở `E0624`: `new_soft_mask` là `pub(crate)`.
- Unmanaged DeviceRGB luminosity trả `MemoryBudgetExceeded` vì sidecar 13 byte/pixel
  được cấp dù đường CMYK cuối cùng không dùng.
- Rasterizer gốc với ngân sách đúng bằng buffer vẫn render thành công; rasterizer cục bộ
  cũng vượt ngân sách mà không báo lỗi trước khi thêm lease.

### Bằng chứng sau sửa

- `cargo test --locked --test api_compat`: `1 passed`.
- `cargo test --locked --test render_transparency`: `46 passed`.
- `cargo test --locked`: `593 passed`, không cập nhật golden.
- `cargo check --locked`: đạt.
- `git diff --check` trên 5 file implementation: đạt.

### Giới hạn xác minh

- Chưa benchmark lại PDF khách; việc này thuộc Lô 1, không tự suy diễn thành mức tăng tốc.
- Chưa build/kiểm installer Tauri; các test hiện tại là native crate và integration contract.

## Lô 1 — bỏ decode lặp image `/SMask` trên file khách

**Trạng thái:** hoàn tất code, kiểm thử tự động và benchmark release trên artifact khách;
chưa xác nhận đường chạy Tauri/PyO3 end-to-end.

### File implementation của lô

1. `print_engine/src/image/sampler.rs`
   - Đọc một component mask trực tiếp, không tạo `Vec` component cho từng pixel.
   - Ghi nhận dung lượng mẫu để cache tính đúng vào ngân sách bộ nhớ.
2. `print_engine/src/image/filters.rs`
   - Mượn stream nén cho tới filter đầu tiên bằng `Cow`, tránh bản sao trung gian.
3. `print_engine/src/content/interp.rs`
   - Cache `Arc<SampledImage>` theo `ObjectId` trong một lần render.
   - Chỉ cache colorspace tự chứa; mỗi lần `Do` vẫn áp lại CTM, clip, alpha và blend.
   - Cache có `MemoryLease`; thiếu ngân sách thì bỏ cache nhưng không đổi kết quả render.
4. `print_engine/src/ink.rs`
   - Cung cấp reservation tạm thời dùng chung cho cache ảnh.
5. `print_engine/tests/render_image.rs`
   - Khóa hai Form dùng chung một ảnh nhưng khác CTM và khác resource colorspace.

### Bằng chứng sau sửa

- `cargo test --locked --test render_image`: **30 passed**.
- `cargo check --locked`: đạt.
- `cargo test --locked`: **595 passed**, không cập nhật golden.
- `git diff --check` trên 5 file implementation: đạt (chỉ cảnh báo chuyển LF/CRLF của
  working tree).

### Benchmark cold process, release

Lệnh đo trực tiếp `print_engine/examples/perf_profile.rs`, cùng artifact:
`C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1, năm lần mỗi DPI;
bảng ghi median `render_ms`.

| DPI | Baseline trước Lô 1 | Sau Lô 1 | Thay đổi |
|---:|---:|---:|---:|
| 12 | 1,066 s | 0,231 s | −78,3% |
| 24 | 1,089 s | 0,246 s | −77,4% |
| 48 | 1,157 s | 0,310 s | −73,2% |
| 96 | 1,467 s | 0,574 s | −60,9% |

Mốc 24 DPI đạt mục tiêu Lô 1 (`0,35–0,65 s`) và nhanh hơn baseline trên máy đo.
Kết quả này là thời gian native PPE, chưa phải latency hiển thị hoàn chỉnh của Tauri
(mở sidecar, HTTP, encode PNG và scheduling vẫn cần đo riêng). Wall-time `plate_stats`
trên cùng máy ở 24 DPI là khoảng `0,286–0,298 s` trang 1, `0,296–0,302 s` trang 2,
`0,320–0,332 s` trang 3 và `0,284–0,292 s` trang 4; số này có cả chi phí khởi động tiến
trình nên chỉ dùng làm kiểm tra không hồi quy tương đối.

### Kết luận và giới hạn

Nút thắt giải mã lặp của trang 1 đã được xử lý và có bằng chứng đo được; chưa được phép
suy ra rằng toàn bộ viewer đã nhanh như Acrobat. Bước tiếp theo là **Lô 2A — PPE
RenderSession trong Rust**, sau khi người dùng xác nhận benchmark artifact và trước khi
đưa cache/session vào đường PyO3 hoặc Tauri.

## Lô 2A — PPE RenderSession native

**Trạng thái:** hoàn tất implementation, kiểm thử và benchmark native; chưa nối session
vào PyO3/backend/Tauri nên thay đổi này chưa xuất hiện trong Viewer đã cài đặt.

### Năm file implementation/test của lô

1. `print_engine/src/session.rs`
   - Thêm owner `RenderSession` giữ `lopdf::Document`, page descriptor, `ColorManager` và
     resource cache qua nhiều lượt render.
   - Identity khóa canonical path, size, mtime/ctime, engine version, intent/OCG; profile
     màu có thêm fingerprint nội dung. PDF/profile được kiểm stamp trước–sau lúc nạp.
   - Save-over làm tăng generation, xóa cache/descriptor cũ và render lại; bitmap bị bỏ nếu
     nguồn tiếp tục đổi trong lúc render. `close`/`invalidate` là terminal, không tự hồi sinh.
   - Cache ảnh có budget tường minh, thống kê hit/miss/eviction/bytes, overhead bảo thủ và
     eviction LRU. Budget `0` hoặc không đủ chỉ tắt cache, không làm sai/fail render.
2. `print_engine/src/lib.rs`
   - Mở module và re-export hợp đồng session/identity/stats; API stateless cũ vẫn giữ nguyên.
3. `print_engine/src/page.rs`
   - Chuẩn bị page box/resources/blend-space một lần; content stream giải nén lười một lần.
   - API stateless chỉ dựng descriptor trang được yêu cầu, không quét descriptor mọi trang.
4. `print_engine/src/content/interp.rs`
   - Renderer nhận cache resource của session nhưng vẫn áp CTM, clip, alpha, blend ở mỗi `Do`.
   - Giữ cache cục bộ theo request để chuỗi A→B→A không thrash khi cache session nhỏ.
   - Cache kèm và phát lại warning của pha decode; lượt warm không được nâng sai `accuracy`.
5. `print_engine/tests/render_session.rs`
   - Khóa parity toàn plane với API cũ, cache warm, cache thiếu budget, A→B→A, save-over,
     nhãn in-memory, close/invalidate và hai owner đồng thời.

### Bằng chứng sau sửa

- `cargo test --locked --test render_session --test render_image --test render_page`:
  **80 passed**.
- `cargo check --locked`: đạt.
- `cargo test --locked`: **605 passed**, không cập nhật golden.
- `git diff --check` trên năm file của lô: đạt (chỉ cảnh báo chuyển LF/CRLF của working tree).

### Benchmark release trên artifact khách

Artifact: `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1,
24 DPI, cache session 128 MiB. Ba process, mỗi process một lượt cold và năm lượt warm:

| Chỉ số | Kết quả |
|---|---:|
| Mở session, median 3 process | 30,8 ms |
| Render đầu, median 3 process | 265,1 ms |
| Render warm, median 15 lượt | 25,2 ms |
| Cache sau render đầu | 98.075.424 byte |
| Miss sau render đầu / sau 6 lượt | 2 / 2 |
| Hit sau render đầu / sau 6 lượt | 0 / 10 |

Khung đầu vẫn tương đương Lô 1; lượt warm nhanh hơn khoảng 10 lần vì không mở lại PDF,
không dựng lại descriptor và không giải mã lại hai ảnh lớn. Đây là thời gian native PPE,
không bao gồm PyO3, HTTP, PNG/PIL, scheduler hay compositor của Viewer.

### Giới hạn chuyển sang Lô 2B

- `build_page_descriptors` vẫn duyệt/clone resources toàn bộ trang khi mở; cần benchmark corpus
  >2.000 trang trước khi quyết định lazy thêm, không suy diễn từ file khách bốn trang.
- `ResourceCacheStats.bytes` là cache ảnh, chưa phải tổng RSS của `Document`/LUT ICC. Lô 2B
  phải đặt budget theo tier RAM thật và đo peak RSS toàn process.
- `SharedRenderSession` cố ý serialize một renderer. Coordinator Lô 2B phải coalesce/hủy request
  zoom cũ để request mới không xếp hàng sau công việc đã lỗi thời.

## Lô 2B — Session qua PyO3/backend

**Trạng thái:** hoàn tất bridge và hợp đồng backend; chưa tự động gắn session vào vòng đời
tab Viewer (thuộc Lô 2C).

### Thay đổi chính

- Thêm `PpeRenderSession` PyO3 sở hữu một `RenderSession`, một mutex riêng và owner token.
  Hai tài liệu không đi qua khóa toàn cục; request cùng tài liệu được serialize sau khi nhả GIL.
- Open/profile/resource cache sống qua nhiều lượt render. API stateless cũ vẫn tồn tại;
  build native cũ và PDF cần qpdf-recovery tiếp tục đi compatibility lane này.
- Generation tăng tuyệt đối. Request cũ, trùng generation, cancel hoặc close đều bị loại
  trước raster, sau lúc chờ mutex và sau raster; bitmap cũ không được trả về Python.
- Session core quy mực sang sRGB bằng đúng `ColorManager` đã giữ, không dựng ICC manager
  lại từng frame. Save-over được kiểm tiếp sau color conversion.
- Timing đo ở đúng biên core/Python: `open`, `parse`, `resource`, `raster`, `color`, `encode`.
  Save-over đang refresh không còn bị ghi nhầm toàn bộ thành `resource`.
- Cache session có policy RAM riêng: máy `<8 GB` và `<16 GB` giảm; máy `>=16 GB` co giãn
  theo RAM khả dụng, không có hard-cap cố định. Thiếu cache chỉ decode lại, không hạ pixel.
- `SoftProofEngine` nhận session tùy chọn. Khi coroutine bị hủy, nó nâng generation native
  ngay; `PpeRequestSuperseded` không được rơi xuống PDFium rồi tạo response cùng generation.
- Session được đối chiếu lại với đúng đường dẫn PDF, profile và rendering intent trước khi
  tiêu thụ generation. Handle native được snapshot dưới khóa; race render/close được phân loại
  là response cũ thay vì rơi sang PDFium.
- Decode ảnh, nén PNG/JPEG và base64 đều có hậu kiểm generation; encode/base64 chạy ngoài
  event loop. Timing của ảnh PPE bị loại được tách khỏi timing của ảnh PDFium cuối cùng.

### Bằng chứng kiểm thử

- `cargo check --locked` cho `print_engine` và `native`: đạt; toàn bộ `print_engine` đạt
  **607/607 test**.
- `cargo test --locked --test render_session`: **12/12 đạt**, gồm sRGB/timing, save-over,
  refresh lỗi tạm thời, close/invalidate, parity, cache và hai owner đồng thời.
- Wheel release mới được cài vào test-site tách biệt; năm nhóm test PPE/cache/ICC đạt
  **118/118**.
- Riêng hai file contract Lô 2B đạt **61/61**, gồm test PyO3 trực tiếp cho owner/cancel/
  generation trùng; test backend cho 24→36 DPI→viewport, sai identity, race close/render và
  generation đổi trong lúc encode.
- `cargo test` của executable native biên dịch xong nhưng test harness Windows thoát
  `0xc0000022` trong môi trường dev đang hoạt động; wheel CPython release ở test-site tách biệt
  đã chạy toàn bộ test binding ở trên. Đây không phải lỗi compile hay test pixel PPE.

### Benchmark qua Python trên artifact khách

Artifact: `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1,
cache resource 128 MiB, wheel release mới:

| Chỉ số | Kết quả |
|---|---:|
| Mở session, median 3 lượt | 36,3 ms |
| Render đầu 24 DPI, median 3 lượt | 283,8 ms |
| Render warm 24 DPI, median 15 lượt | 40,7 ms |
| Zoom warm 36 DPI, median 3 lượt | 91,2 ms |
| Viewport 256×256 warm ở 36 DPI, median 3 lượt | 62,6 ms |
| Cache ảnh giữ lại | 98.075.424 byte |
| Miss sau 8 lượt | 2 |
| Hit sau 8 lượt | 14 |

Qua `SoftProofEngine` và encode PNG lossless: khung đầu 24 DPI khoảng 296,9 ms, khung
warm cùng DPI khoảng 43,8 ms, viewport 256×256 ở 36 DPI khoảng 68,8 ms. Timing viewport
tách được khoảng 0,3 ms resource, 44,4 ms raster, 17,0 ms color và 5,6 ms encode.

Trong process benchmark tách biệt, working set tăng từ 18,1 MiB lên 62,8 MiB sau open và
165,9 MiB sau cold render; peak trong lần đo là 232,8 MiB, rồi hạ về 37,8 MiB sau close/GC.
Resource cache báo 98.075.424 byte. Peak cao hơn cache vì còn document, ICC, scratch và RGB
đầu ra; đây là lý do Lô 2C phải quản tổng lease giữa nhiều tab thay vì cấp ngân sách này cho
từng session độc lập.

Một PDF tổng hợp 2.000 trang trắng mở native khoảng 38,3 ms; số này chỉ chứng minh số
trang đơn giản chưa làm chậm đáng kể, không thay cho corpus nhiều resource/content.

## Lô 2C — PPE Viewer Session Manager

**Trạng thái:** hoàn tất nối session vào route Viewer, vòng đời tab/file, hàng đợi
theo document và pool RAM nhiều session. Chưa thay cho gate smoke bản Tauri đã đóng gói.

### Thay đổi chính

- Session vật lý được chia sẻ theo cùng snapshot revision PDF + CMYK/RGB ICC + intent;
  full-page nền và viewport có request owner riêng nhưng dùng chung `session_owner_id`
  của tab/tài liệu. Chuỗi 24→36 DPI→clip vì vậy không mở lại PDF/profile.
- Native owner và generation là token nội bộ tăng tuyệt đối. Hai tab cùng gửi
  generation `1` không thể hủy nhầm nhau; generation HTTP chỉ là admission/latest-wins
  của request bên ngoài.
- Mỗi document có lane riêng. Interactive vượt background còn chờ, trong khi hai
  document khác không bị một khóa toàn cục chặn nhau. Request hết waiter được
  kiểm lại ngay trước native, không tích backlog zoom cũ sau mốc cache `started`.
- Cache key và manager nhận cùng một identity snapshot. Route hậu kiểm sau render và
  trước response, kể cả disk-hit; save-over PDF/ICC làm request cũ trở thành `409`
  thay vì ghi pixel revision mới dưới khóa cũ.
- Frontend nhả owner khi đổi file/unmount; backend có TTL sweeper cho WebView crash. Owner
  cuối chỉ đóng sau active lease cuối, không cắt ngang render đang chạy.
- DELETE mang generation watermark: POST cũ đến sau cleanup không hồi sinh owner, nhưng
  DELETE cũ cũng không đóng nhầm binding generation mới. Watermark `0` giữ React
  StrictMode setup lần hai hoạt động, không dùng tombstone owner vĩnh viễn.
- Pool persistent co giãn theo RAM: máy `<8 GB`/`<16 GB` giảm cache nền; máy `>=16 GB`
  không hard-cap số document hay DPI. Khi hết pool, background được hoãn còn
  interactive chạy transient cache `0`, không hạ pixel/chất lượng.
- RAM của wrapper đang close vẫn nằm trong reservation. Close là task do manager sở hữu
  và được shield khỏi cancellation của HTTP caller; request cùng revision đợi close
  thật xong mới reopen, tránh double-residency/peak RSS giả.

### Bằng chứng kiểm thử và benchmark route thật

- Năm suite backend PPE/facade/cache/ICC/API: **151/151 đạt**.
- Test hook Viewer: **18/18 đạt**; `tsc --noEmit`: đạt.
- Riêng manager: **13/13 đạt**, gồm shared-owner, priority, stale interest, open muộn,
  owner release giữa render, eviction, pending-close accounting và caller-cancel trong lúc close.

Artifact khách trang 1 qua đúng route `viewer-accurate`, PNG lossless, cùng logical owner:

| Request | End-to-end |
|---|---:|
| Cold full-page 24 DPI | 337,2 ms |
| Warm full-page 36 DPI | 100,3 ms |
| Warm viewport 256×256 @36 DPI | 68,5 ms |

Cả ba request dùng `session=native`, `engine=ppe+lcms`; manager giữ đúng **1 document /
1 owner / 1 native session**. Sau DELETE owner cuối, documents/owners/sessions và reservation RAM
đều về `0`. Đo trực tiếp session trên cùng chuỗi cho `image_misses=2` không tăng,
`image_hits` tăng `0 → 2 → 4`; cold/warm/viewport lần lượt 307,4/98,5/65,9 ms.

### Giới hạn còn lại sau Lô 2C

- Chưa smoke zoom/pan/chuyển trang trên bản Tauri production mới đóng gói; benchmark
  trên dùng wheel release và route/backend thật.
- Cancel Lô 2B bảo đảm **bỏ response**, chưa dừng CPU giữa content stream; checkpoint vật lý
  thuộc Lô 5.
- Page descriptor/content đã giải nén chưa nằm trong budget cache ảnh. Corpus nhiều trang,
  nhiều resource phải được đo và chuyển sang Page Program/LRU ở Lô 4 nếu vượt gate RSS.
- Identity file theo SSOT hiện dùng canonical path + size + mtime/ctime. Một công cụ cố ý
  ghi đè cùng byte-size và phục hồi nguyên timestamp là edge case còn lại; chưa được phép
  tuyên bố chống stale tuyệt đối cho trường hợp metadata bị giả giữ nguyên.

## Lô Zoom hot-path — làm nét vùng nhìn và hủy CPU thật

**Trạng thái:** hoàn tất source, test và benchmark native release; ứng dụng dev đang mở phải
khởi động lại để nạp extension mới vì Windows không cho ghi đè `.pyd` đang được sidecar giữ.

### Thay đổi chính

- Viewport chỉ dựng vùng thực sự nhìn thấy, bỏ pad 256 px mỗi phía và giảm snap từ 256 xuống
  64 px. Bitmap cũ vẫn được scale/giữ tới khi bitmap mới decode xong; không hạ DPI hay dùng
  CSS sharpen.
- Settle sau wheel giảm `90 → 48 ms` sau khi PPE có hủy CPU thật; timer vẫn gom burst wheel
  để không sinh request theo từng frame.
- `DeviceCMYK` đọc bốn component trực tiếp, không dựng `Vec` nhỏ theo từng pixel; `/Decode`
  riêng từng kênh vẫn được giữ và có test khóa.
- Viewer soft-proof lấy đúng alpha của soft-mask tại pixel như PDF/Acrobat. Phép cực đại 7×7
  chỉ còn ở `ink_accurate`, nơi cần bảo thủ chống false-clean khi đo mực.
- FOGRA39→sRGB của frame lớn được chia theo Rayon bằng transform LittleCMS cùng profile/
  intent/cached semantics của đường tuần tự. Bảy lượt cho cùng một hash RGB; phương án
  `NO_CACHE` cho sai byte đã bị loại.
- `SoftLight` non-isolated process group có fast path theo hàng, chỉ bật khi đúng bốn process
  planes, không RGB sidecar/spot/external mask; mọi trường hợp khác giữ scalar.
- Thêm `CancelToken` dùng chung từ `PpeRenderSession` tới core. Checkpoint nằm ở operator,
  recursion, từng hàng ảnh/gradient/mesh/pattern, output soft-mask, biên group và trước/sau
  quy màu. `PpeError::Cancelled` luôn đi thẳng thành `PPE_STALE_REQUEST`, không bị đổi thành
  trang degraded hay rơi xuống PDFium.
- Slot cancel khóa generation mới hơn, chống request cũ cài token trễ; guard cũ không xóa
  token mới. Có hậu kiểm ngoài `py.detach` để cancel/close sát thời điểm trả bytes vẫn bỏ ảnh.

Cache resource hoàn chỉnh đã decode trước checkpoint được phép giữ lại cho request mới;
bitmap/PNG/response lỗi thời không được phát hoặc ghi cache kết quả.

### Benchmark release trên PDF khách

Artifact: `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1,
288 DPI, FOGRA39, session warm.

| Chỉ số | Trước | Sau |
|---|---:|---:|
| Viewport cũ có pad, khoảng 2816×1792 | 3.871 ms | không còn dùng |
| Vùng nhìn 1984×1152, wall P50 | 1.761 ms | **949,7 ms** |
| Vùng nhìn 1984×1152, wall P95 | — | **977,1 ms** |
| Color conversion P50 | khoảng 537–551 ms | **85,7 ms** |
| Raster P50 hiện tại | khoảng 1.210 ms | **859,7 ms** |
| Cancel → render cũ thoát P50/P95 | khoảng 1.010 ms chờ thêm | **3,4 / 3,6 ms** |
| Queue overhead của request cuối P50/P95 | khoảng 1.010 ms | **5,8 / 6,4 ms** |

So với đường cũ có pad, thời gian native giảm khoảng **75,5%**. So đúng cùng vùng nhìn,
giảm khoảng **46%**. Bảy lượt steady có cùng SHA-256 RGB
`93033aa1acdc79c99aff88766825b6074edf6044a0aff42c10b5f65dfd93ec77`.
Token/checkpoint không làm thoái hóa steady path có ý nghĩa: median trước/sau token
`949,2 / 949,7 ms` (khoảng `+0,05%`).

### Bằng chứng kiểm thử

- `print_engine`: **612/612 đạt**.
- Native generation/cancel slot: **4/4 đạt**; `cargo check --locked` và release build đạt.
- Backend chạy bằng đúng `.pyd` release mới: **120/120 đạt**.
- Frontend zoom/tile mục tiêu: **56/56 đạt**; `tsc --noEmit` đạt.
- `git diff --check`: đạt; chỉ có cảnh báo LF/CRLF của worktree Windows.

### Phần còn lại

- Không thể hứa cache-miss toàn viewport là `0 ms`: raster 2,29 triệu pixel vẫn khoảng
  0,86 giây. Bước lớn tiếp theo là PPE worker binary (Lô 3), Page Program/bounds (Lô 4)
  và song song image raster có kiểm soát.
- Flate/codec đang giải nén một stream lạnh chưa có checkpoint bên trong codec; checkpoint
  trước/sau decode vẫn fail-closed. Đây là phần Lô 5B còn lại, không phải lý do giữ settle 90 ms
  trên artifact warm của Viewer.

## Lô compositor — hòa trộn mờ → nét

**Trạng thái:** code và test tự động đạt; cần người dùng xác nhận cảm giác trên WebView thật.

- Nguyên nhân nhún còn lại: `LiveTile` có transition 50ms nhưng callback `ready` đồng thời
  thay `visible = target`, làm tile cũ bị unmount ngay khi tile nét bắt đầu hiện.
- Tile cũ nay được giữ dưới tile mới tới hết crossfade. Thời gian thay đổi từ 80–160ms theo
  log2 tỷ lệ mật độ raster; chênh lệch nhỏ chuyển nhanh, chênh lệch lớn chuyển êm hơn.
- `prefers-reduced-motion` đưa thời gian về 0. Không dùng CSS blur/filter, không tạo request
  render trung gian và không thay DPI/màu.
- Scheduler gộp callback DOM `onLoad` lặp, hủy timer target cũ khi generation zoom mới đến,
  và reducer vẫn từ chối callback stale.
- `onTileReady` chỉ bắt đầu retirement sau khi chính `<img>` hiển thị load xong; preload decode
  không còn retire tile cũ sớm.

Gate tự động: bốn suite zoom/tile **59/59 đạt**, `tsc --noEmit` đạt và `git diff --check` đạt.
Runtime HMR không đọc được từ task Codex hiện tại vì không có terminal app gắn kèm; không được
tuyên bố cảm giác chuyển tiếp đã đạt trước khi kiểm tay trên đúng file khách.

## Lô coverage-aware — bỏ “đảo nét” khi zoom-out

**Trạng thái:** code và test tự động đạt; cần kiểm tay chuỗi zoom-out trên WebView thật.

- Nguyên nhân phản hồi mới: viewport tile cũ được giữ chỉ theo `reuseGroup`, không kiểm tra
  ảnh đó còn phủ đủ khung nhìn rộng hơn sau khi thu nhỏ. Phần giữa vì thế nét, còn các mảng
  mới lộ xung quanh rơi về nền full-page mật độ thấp.
- Tile cũ nay chỉ được trình bày cùng target mới khi rect đã scale của nó phủ đủ cả bốn cạnh
  viewport sống; có tolerance 1 CSS px để không nháy vì sai số làm tròn. Thiếu bất kỳ cạnh nào
  thì compositor tạm dùng nền đồng đều rồi fade target mới vào, không để lại một “đảo nét”.
- Runway 64 device px đã bị **rút lại sau phản hồi runtime**: nó tăng khoảng 18% pixel nhưng
  không giải quyết độ tương phản của nền 36 DPI. PPE trở lại pad 0 + snap 64; coverage-aware
  vẫn giữ để không trình bày tile cũ khi thiếu một cạnh.
- Coverage được kiểm ở hệ trang chưa xoay sau inverse-map nên dùng chung cho 0/90/180/270.
  Không thêm render trung gian, worker, cache cap, CSS blur/filter hoặc thay đổi DPI/màu.

Gate tự động: sáu suite zoom/tile **92/92 đạt**, `tsc --noEmit` đạt và `git diff --check` đạt
(chỉ còn cảnh báo LF/CRLF của worktree Windows). Chưa có bằng chứng runtime cho cảm giác thực tế;
cần mở lại đúng PDF khách, zoom nét một vùng rồi thu nhỏ một và nhiều nấc để xác nhận.

## Hotfix fast-first — khôi phục first-paint và ổn định độ nét

**Trạng thái:** code/typecheck/test tự động đạt; phản hồi runtime trước hotfix xác nhận kiến trúc
PPE-only thất bại, cần người dùng kiểm lại bản HMR mới trước khi đóng finding.

Ảnh runtime cho thấy trang trắng với “Đang dựng hình…” và zoom nhảy mạnh mờ → nét. Truy code
xác nhận hai nguyên nhân:

1. Trang detector đánh dấu rủi ro bị ép `accurate-only`; PDFium first-paint đã bị loại khỏi DOM,
   nên cold-open phải chờ PPE xong mới có pixel đầu tiên.
2. Full-page accurate bị chốt ở `0,375× = 36 DPI`, trong khi viewport dùng DPI màn hình. Đây là
   độ lệch mật độ có chủ đích quá lớn, không thể chữa bằng crossfade hoặc runway.

Thay đổi:

- PDFium display và PPE accurate trở thành hai layer độc lập. PDFium luôn render/decode/hiện
  trước; PPE chỉ được enable sau callback DOM của display, nên không tranh CPU/I/O first-paint.
- Full-page accurate tăng trần từ 36 lên 144 DPI. Ở zoom cao hơn, chỉ viewport PPE chạy để
  không raster cả trang lớn; lớp display cùng kích thước target vẫn xuất hiện trước.
- PPE fade 160 ms trên display đã nét. Vì hai ảnh có cùng box/mật độ mục tiêu, chuyển pha chủ yếu
  còn là hiệu chỉnh gradient/màu, không phải cú nhảy bitmap cực mờ → cực nét.
- Zoom-out qua ngưỡng tiling unmount viewport cũ và trả về nền display đồng đều; không giữ
  “đảo nét”. Pad PPE trở lại 0, loại khoảng 18% pixel tăng thêm của thử nghiệm trước.

Bằng chứng tự động tại thời điểm hotfix đầu: bảy suite Viewer **100/100 đạt**, `tsc --noEmit` đạt, `git diff --check`
đạt (chỉ cảnh báo LF/CRLF Windows). Log native đang chạy gần nhất cho full-page PDFium `zoom=1`
ghi core khoảng `81–100 ms`; đây chưa phải `open → DOM visible`, nên không dùng để tuyên bố
runtime đã đạt cho tới khi kiểm lại đúng PDF khách.

### Sửa state machine — PDFium chỉ cold-open, không lặp theo zoom

Phản hồi runtime tiếp theo xác nhận hotfix fast-first đầu vẫn sai: mỗi target zoom đều dựng
PDFium rồi PPE, nên màu/gradient lặp “sai → đúng” liên tục. Bản sửa mới biến pipeline thành
state machine một chiều theo từng file/trang:

1. `cold-open`: cho phép một frame display để không trắng trang;
2. `accurate-committed`: ngay khi `<img>` PPE đầu tiên load thật trong DOM, khóa trang sang
   accurate-only; PDFium base/viewport không còn phát request theo zoom;
3. zoom sau đó giữ bitmap accurate cũ, chỉ retire sau khi accurate target mới đã hiện và fade
   đủ 160 ms;
4. full-page accurate cũ vẫn mounted dưới viewport. Nếu frame đúng đầu tiên đến từ viewport,
   engine warm thêm fallback full-page 144 DPI ở nền để zoom-out không lộ lại PDFium.

Gate sau state machine: bảy suite Viewer **102/102 đạt**, `tsc --noEmit` đạt và
`git diff --check` đạt (chỉ cảnh báo LF/CRLF Windows). Runtime WebView vẫn phải kiểm lại bằng
chuỗi zoom liên tục; không coi finding đóng chỉ từ test tự động.

### Khôi phục bất biến kế hoạch chính — PPE là first correct frame

**Thay thế quyết định F5/F6 ở trên.** Phản hồi runtime xác nhận ngay cả một frame PDFium lúc
cold-open vẫn tạo chuyển màu/gradient sai → đúng và trái với bất biến đã duyệt: trang rủi ro
không được dùng PDFium làm ảnh tạm.

- Trang rủi ro không còn mount full-page hoặc viewport display layer; việc không mount là bắt
  buộc vì một `LiveTile` chỉ bị disable vẫn có thể khôi phục bitmap PDFium cũ từ cache.
- PPE không chờ `displayLayerReady`; request correct-color bắt đầu ngay khi trang được phép render.
- Cold-open dùng PPE 24 DPI trước, sau đó PPE target 96–144 DPI hoặc viewport nâng nét. Hai frame
  dùng cùng profile/intent/pipeline nên không còn đổi hue hay phân dải theo engine.
- Frame đầu tiên hiện không fade; các generation PPE sau chỉ crossfade trên bitmap PPE cũ.
- Callback tile mang scale thật để coarse frame không bị đánh dấu nhầm là target đã hoàn tất.
- PDFium chỉ còn compatibility lane của trang không bị detector đánh dấu rủi ro.

Gate tự động sau lô sửa: bảy suite Viewer **103/103 đạt** và `tsc --noEmit` đạt. Chưa tuyên bố
runtime đạt cho tới khi mở lại đúng PDF khách trong Tauri và kiểm cold-open + zoom liên tục.

### F9 — Cold-open phải đọc được ngay, không phát PPE coarse 24 DPI

**Thay thế quyết định cold-open 24 DPI của F8.** Phản hồi runtime bác bỏ cách “đúng màu trước,
nâng nét sau”: dù không còn đổi hue/gradient, frame 24 DPI vẫn làm trang vừa mở mờ đến mức không
đọc được và còn đặt request target nét phía sau một lượt render không có giá trị sử dụng.

Baseline được khóa bằng hai test đỏ trước khi sửa:

1. mức fit `0,3–0,5×` kéo full-page PPE xuống chính mức hiển thị, chỉ tương đương khoảng 29–48 DPI;
2. `LiveTile accurateOnly` gọi tuần tự `0,25× → 1×`, nên frame 24 DPI được đưa lên DOM trước.

Hợp đồng mới:

- full-page PPE có sàn `1× = 96 DPI`, trần `1,5× = 144 DPI`; mức fit không còn hạ DPI theo
  `visibleScale`;
- `accurateOnly` xin thẳng target PPE, bỏ hoàn toàn lượt coarse 24 DPI;
- trong chuỗi wheel, bitmap PPE nét đang có tiếp tục được scale tạm; target mới chỉ thay thế sau khi
  nhịp render đã ổn định và ảnh mới load thật trong DOM;
- trang màu rủi ro vẫn PPE-only, không đưa PDFium trở lại; compatibility lane của trang thường không đổi.

Bằng chứng tự động sau sửa: test tái hiện hẹp **21/21 đạt**, bảy suite Viewer **103/103 đạt** và
`tsc --noEmit` đạt. Đây là bằng chứng source/test; cold-open thực tế chỉ được đóng khi người dùng mở
lại đúng `CMNM2026 - Giay moi_BLUE - in.pdf` trong Tauri và xác nhận chữ đọc được ngay ở mức fit.

## Lô 3A — PPE chạy trực tiếp trong native render worker

**Trạng thái:** prototype process/IPC và benchmark PDF khách đạt; chưa route Viewer UI ở lô này.

Thay đổi:

- `desktop/src-tauri` liên kết trực tiếp crate Rust `print_engine`; không thêm renderer hoặc
  dependency runtime bên ngoài.
- Protocol worker hiện nhận cả `Scale + Display` và `Dpi + Accurate + ColorVerified`; hai nhánh
  khóa chéo để PDFium không nhận request PPE và PPE không nhận request display.
- PPE worker giữ `RenderSession` theo document revision + profile + intent, dùng lại decoded image,
  page descriptor và ColorManager qua nhiều request.
- FOGRA39 chỉ được resolve từ thư mục ICC nội bộ đã pin; profile ID/path tùy ý bị từ chối.
- Memory/render cache co theo RAM còn trống và số lane thật. Máy `<8 GB`/`<16 GB` có ceiling chống
  swap; máy `>=16 GB` không có hard-cap cố định.
- Trang có `ink_unsound` hoặc `degraded` bị fail-closed, không được gắn nhãn `color-verified`.

Baseline test đỏ: worker trả `Display worker chưa nhận raster DPI của PPE.` cho request accurate.
Sau sửa, module worker đạt **20/20 test**, 2 runtime test được giữ `ignored` có chủ đích; runtime
PPE process được chạy riêng bằng executable thật và đạt.

Benchmark process worker trên `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1, 96 DPI, PNG lossless:

| Lượt | Total | Render | Encode | PNG |
|---|---:|---:|---:|---:|
| Cold session | **635 ms** | 586 ms | 9 ms | 488.969 byte |
| Warm cùng session | **372 ms** | 360 ms | 9 ms | 488.969 byte |

Gate build: `cargo check --offline --locked` đạt. Đây mới là worker core; Viewer vẫn đang gọi route
HTTP backend cho accurate cho tới Lô 3C. Lô 3B phải chốt priority/session pool và artifact ICC trước
khi bật đường native cho UI.

### Lô 3B — Priority, session pool và ICC tự chứa

- `accurate` không còn bị hiểu mặc định là background: viewport priority `<100` đi lane tương tác;
  nền/prefetch priority `>=100` đi lane nền và có thể bị preempt.
- Session pool giữ 1 document ở máy `<8 GB`, 2 document ở máy `8–<16 GB`; máy `>=16 GB` không
  hard-cap trong trạng thái bình thường. Chỉ khi RAM khả dụng dưới 4 GiB hoặc 10% tổng RAM mới thu
  LRU xuống 1 session để tránh swap.
- FOGRA39 654.352 byte được nhúng vào executable và materialize theo SHA-256 trong cache tạm. Worker
  release không còn phụ thuộc cây source/backend hoặc biến môi trường profile trên máy khách.
- Pipeline namespace tăng thành `ppe-fogra39-relative-png-v4-native-worker`, chặn cache v3 che khác
  biệt transport/profile của đường mới.

Gate: module worker **22/22 test đạt**, 2 runtime test giữ ignored; runtime process thật trên PDF khách
đạt cold `664 ms`, warm `365 ms`, encode `9 ms`; `cargo check --offline --locked` đạt. Chưa route UI
trước khi Tauri command và frontend cùng dùng namespace v4 trong Lô 3C.

## Lô 3C — Viewer accurate đi thẳng native PPE worker

**Trạng thái:** hoàn tất code, test và smoke route trên đúng PDF khách trong Tauri dev;
cửa sổ thật còn cần người dùng chốt cảm giác zoom/pan trước khi sang Page Program.

Thay đổi:

- Tauri có `render_ppe_page` và `release_ppe_session_owner`; accurate frame đi IPC trực
  tiếp, dùng pipeline v4, không vòng HTTP/Python/PIL ở đường thường.
- Worker protocol tăng `1 → 2`, mang `session_owner_id` riêng với request/layer owner.
  Một session vật lý giữ tập owner theo tab; chỉ owner cuối rời mới đóng. Sweeper thu owner
  WebView crash sau TTL 10 phút.
- Pool RAM thấp không evict session của tab còn sống: document vượt 1/2 slot chạy transient
  cache 0 nhưng giữ nguyên DPI/pixel. Tier `>=16 GB` tiếp tục không hard-cap khi RAM bình thường.
- Frontend chỉ fallback route backend khi Tauri trả mã ổn định
  `PPE_NATIVE_FALLBACK_BEFORE_START`; mọi lỗi sau khi worker bắt đầu hoặc soundness lỗi đều
  fail-closed. Cleanup HTTP chỉ chạy nếu phiên thật sự từng dùng compatibility fallback.
- Hủy group/viewport gọi đồng thời AbortController và physical `cancel_pdf_render`; full-page
  accurate cùng trang vẫn được giữ làm nền trong lúc viewport mới chờ.

Bằng chứng test đỏ trước sửa:

- Test route native có **8 ca đỏ**: accurate vẫn gọi HTTP, không có command PPE/release,
  pipeline frontend còn v3 và cancel không chạm request worker vật lý.

Bằng chứng sau sửa:

- `cargo test --offline --locked pdf_engine::render_worker::tests`: **24 passed**, 2 ignored.
- Bảy suite Viewer liên quan: **105/105 đạt**.
- `npm run typecheck`, `cargo check --offline --locked`, `cargo build --offline --locked`:
  đạt; rustfmt/diff/trailing-whitespace check đạt.
- Runtime process worker trên `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1, 96 DPI:
  cold **645 ms**, warm **358 ms**, PNG **488.969 byte**.
- Tauri dev mở đúng file khách ghi `PPE_NATIVE_RESULT` trang 1 **669 ms** và `IPC_PPE`
  **713 ms**; trang 2 nền **865 ms**. Log này xác nhận UI đã vào command native v4,
  nhưng không được dùng để tự tuyên bố cảm giác hiển thị đã đạt trước khi duyệt bằng mắt.

## Lô 4A — PageProgram decode một lần, replay nhiều lần

**Trạng thái:** hoàn tất implementation, parity test và benchmark native; chưa làm thay đổi lớn
latency hiển thị thực tế của Viewer.

Năm file implementation/test:

1. `print_engine/src/page_program.rs`
   - `PageProgram::compile()` giữ danh sách operation và inline image đã decode.
2. `print_engine/src/lib.rs`
   - Công bố kiểu `PageProgram` trong API crate.
3. `print_engine/src/content/mod.rs`
   - Re-export PageProgram cho lớp content tương thích.
4. `print_engine/src/content/interp.rs`
   - `Renderer::run_program()` replay chương trình; `run(bytes)` vẫn là wrapper tương thích.
5. `print_engine/src/page.rs`
   - `PageDescriptor` giữ `Arc<OnceLock<PageProgram>>`, không giữ thêm bản content bytes sau compile.
   - Check cancel trước khi compile; parity test khóa 72/144 DPI, viewport và `/Rotate 90`.

Phạm vi cache được giữ bảo thủ: chỉ content stream của trang dùng PageProgram; Form, Pattern và
Type3 vẫn decode trong resource scope riêng để không giữ nhầm resource handle qua scope.

Bằng chứng:

- Test đỏ đầu tiên thiếu `descriptor.program()`; sau sửa, test hẹp đạt **3 passed, 1 ignored**.
- `cargo test --offline --locked`: toàn bộ crate đạt, không cập nhật golden.
- `cargo check --offline --locked`: đạt.
- `git diff --check` trên năm file: đạt; chỉ còn cảnh báo LF/CRLF của working tree.
- Benchmark release trên `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1:
  `PAGE_PROGRAM_DECODE bytes=16146 operations=929 median_ms=0.258 p95_ms=0.287`.

Kết luận đo được: L4A loại một lần decode khoảng **0,258 ms** ở request warm, quá nhỏ so với
độ trễ `600–900 ms` người dùng đang thấy. Log runtime `PrynX_RenderPerf.log` cho thấy nhiều request
zoom liên tiếp phát sinh `RENDER_WORKER_SPAWN`; nguyên nhân là `cancel_render_request()` đang kill
process worker, làm mất toàn bộ RenderSession, image cache và PageProgram. Hạng mục ưu tiên kế tiếp
là cooperative cancellation riêng cho PPE worker; chưa chuyển sang tuyên bố L4B sẽ giải quyết latency.

## Chốt giữa L4A/L4B — Cooperative cancellation giữ worker và cache

**Trạng thái:** hoàn tất implementation, test tự động và runtime IPC trực tiếp trên đúng PDF khách;
chưa duyệt cảm giác bằng mắt trong cửa sổ Tauri thật.

File implementation duy nhất của lô: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.

Thay đổi:

- Protocol worker tăng `2 → 3`, thêm `CancelRequest` là frame một chiều, không chen response vào
  stdout đang chờ response render.
- Worker có luồng control luôn đọc stdin. Với request PPE accurate, luồng này đăng ký `CancelToken`
  trước khi giao render cho luồng chính, nên cancel không thể lọt qua cửa sổ race lúc bắt đầu.
- `RenderOptions` nhận token; PPE trả `RenderResponseStatus::Cancelled`, không ghi PNG/cache lỗi.
- Parent chỉ công bố active lease sau khi frame render đã ghi trọn vẹn. Cancel PPE gửi control qua
  chính stdin đã khóa tuần tự; gửi thất bại mới kill fallback.
- PDFium display/bootstrap/metadata vẫn dùng kill cũ vì không có checkpoint hợp tác. Không thay đổi
  pixel, DPI, chất lượng, worker count hay policy RAM; máy `>=16 GB` không nhận hard-cap mới.
- Render stale tự dọn token sau khi kết thúc; RenderSession, image cache và PageProgram tiếp tục sống
  trong worker cho request kế tiếp.

Bằng chứng tự động:

- `cargo check --offline --locked` của `desktop/src-tauri`: đạt.
- Worker suite trên target sạch: **26 passed, 0 failed, 2 ignored**.
- Toàn Tauri Rust trên target sạch: **121 passed, 0 failed, 5 ignored**.
- `print_engine`: test hẹp PageProgram **3 passed, 1 ignored**; toàn crate và `cargo check` đạt.
- Link test lần đầu trong target dev bị object incremental của watcher xung đột LLVM; chạy lại trên
  `D:\pdfcompare\.tmp\codex-l4c-target` sạch đạt, không xóa hay dừng build dev của người dùng.
- Sau khi không còn process dev, chỉ dọn artifact sinh ra của package `print_engine`
  (`cargo clean -p print_engine`: 625 file/229,6 MiB) trong target chính; `cargo build --offline --locked`
  sau đó đạt. Không xóa toàn bộ target và không chạm source/cache package khác.

Runtime trực tiếp qua parent manager → worker executable mới, dùng
`C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1:

| Ca | Kết quả |
|---|---:|
| Cold 96 DPI | **637 ms** |
| Warm 96 DPI | **365 ms** |
| Hủy stale 600 DPI viewport | **3 ms** |
| Render 96 DPI ngay sau cancel | **357 ms** |

Worker PID giữ nguyên `1052` qua cancel và render sau cancel vẫn ở mức warm. Đây là bằng chứng trực
tiếp rằng lỗi “mỗi nhịp zoom kill worker → spawn lạnh → mất session/cache” đã được đóng ở đường PPE.
Chưa được phép suy rộng thành cảm giác zoom đã ngang Acrobat trước smoke bằng mắt trong app thật.

## Lô 4B1 — Song song shading process trong soft mask

**Trạng thái:** hoàn tất code, pixel-parity, benchmark release và runtime worker trên đúng PDF
khách; cảm giác zoom/pan trong cửa sổ Tauri thật vẫn cần người dùng duyệt.

Khảo sát trước sửa trên viewport `1600×900 @600 DPI` cho thấy phần session/resource chỉ khoảng
`0,2–0,4 ms`, trong khi raster khoảng `662–680 ms` và color khoảng `56–64 ms`. Profile operator
đặt `Do` khoảng `464 ms`, `gs`/soft mask khoảng `199 ms`, `sh` khoảng `36 ms`. Trang 1 có tám
ExtGState soft mask; ở viewport đo có ba mask thực sự giao vùng nhìn. Hai mask nặng dùng shading
DeviceN chỉ quy về bốn kênh process nhưng vòng cũ vẫn composite từng pixel trên một lõi.

Một fast-path ảnh CMYK song song đã được thử trước: hash không đổi nhưng median viewport chỉ tốt
hơn khoảng `3,1–3,2%`; riêng pass trực tiếp chỉ khoảng `1,7–1,8 ms`. Toàn bộ nhánh và trace thử
nghiệm đó đã được gỡ, không để lại đường code không đủ lợi ích.

Bản sửa cuối chạm ba file engine:

1. `print_engine/src/shading/eval.rs`
   - `SampledShading` xác nhận toàn LUT chỉ khai báo bốn kênh process; tint spot bằng 0 vẫn bị coi
     là spot để không làm sai knockout/overprint.
2. `print_engine/src/ink.rs`
   - Composite shading theo hàng trên pool Rayon dùng chung khi vùng đủ lớn, blend tách kênh,
     không có RGB sidecar và mọi plane spot trong vùng đều bằng 0.
   - Máy nhiều lõi dùng toàn pool; không thêm worker cap hoặc trần chất lượng. Ca không đủ điều kiện
     quay về đường scalar cũ.
3. `print_engine/src/content/interp.rs`
   - Chọn fast-path sau khi dựng LUT và vẫn giữ checkpoint `CancelToken` theo hàng.
   - `OPM=1`, clip, soft mask, alpha và ChannelMask được tính trước khi giao từng pixel.

Test exact-pixel khóa cả knockout lẫn overprint với năm plane; nếu plane spot có mực, fast-path bắt
buộc từ chối. Hash chuẩn không đổi:

- full 96 DPI: `1099746fa0736a3f`;
- viewport 600 DPI: `a15c619c09de1f93`.

Benchmark release cùng binary, cùng PDF và cùng viewport:

| Đại lượng median | Trước | Sau | Thay đổi |
|---|---:|---:|---:|
| Wall viewport 600 DPI | 742,380 ms | 653,097 ms | **-12,0%** |
| Raster viewport 600 DPI | 672,381 ms | 587,552 ms | **-12,6%** |
| Wall full-page warm 96 DPI | 544,284 ms | 508,668 ms | **-6,5%** |

Khi bật resource cache giống worker, core đạt warm 96 DPI **272 ms** và ba lượt viewport
**402/410/416 ms**. Runtime qua parent manager và executable Tauri mới:

| Ca | Trước L4B1 | Sau L4B1 |
|---|---:|---:|
| Cold 96 DPI | 637 ms | **594–604 ms** |
| Warm 96 DPI | 365 ms | **306–331 ms** |
| Viewport `1600×900 @600 DPI` | chưa có số worker hoàn chỉnh | **449 ms** |
| Hủy stale viewport | 3 ms | **2–3 ms** |
| 96 DPI ngay sau cancel | 357 ms | **296–302 ms** |

Bằng chứng hồi quy:

- `print_engine`: **616 passed, 0 failed, 2 ignored**; `cargo check --offline --locked` đạt.
- Worker suite: **26 passed, 0 failed, 2 ignored**.
- Toàn Tauri Rust: **121 passed, 0 failed, 5 ignored**; dev executable build đạt trên target tách
  biệt để không đụng tiến trình dev đang chạy.
- Cooperative cancel vẫn thoát `2–3 ms`, PID worker giữ nguyên và request sau cancel vẫn warm.

L4B1 đã giảm nút thắt thật của frame đầu, nhưng viewport worker **449 ms** vẫn cao hơn gate warm
P95 `350 ms`. Phần còn lại chủ yếu là ảnh Flate `/DeviceCMYK` `4042×2696` kèm `/SMask` và ba
soft mask phải dựng mới khi DPI/clip đổi; chưa được phép tuyên bố ngang Acrobat hoặc đóng phase
runtime trước smoke bằng mắt.

## Lô 4B2 — Fill exact backdrop của luminosity soft mask

**Trạng thái:** hoàn tất code, test exact-pixel, A/B release, cấu hình một luồng và runtime worker
trên đúng PDF khách; chưa smoke cảm giác zoom/pan bằng mắt trong cửa sổ Tauri thật.

### Profile warm-cache

Trace tạm trên session có resource cache `512 MiB` tách được nút thắt còn lại:

- lookup/decode warm của ảnh `4357`: khoảng **0,003 ms**; toàn pass ảnh chính chỉ **9–10 ms**;
- ảnh luminosity `4355`: khoảng **38–40 ms**;
- ba group soft mask `4361`, `4384`, `4391`: khoảng **64–67**, **53–66**, **80–93 ms**;
- riêng bước phủ backdrop `/BC` tổng quát của ba group: tổng khoảng **49–64 ms** mỗi viewport.

Vì vậy giả thuyết inflate/ROI ảnh là ưu tiên warm bị bác bỏ. Cache bitmap mask exact-key cũng không
được thêm: nó không giúp frame đầu khi DPI/clip đổi và làm identity/cache invalidation phức tạp hơn.

### Thay đổi giữ lại

File code duy nhất của lô: `print_engine/src/ink.rs`.

- `InkBuffer::composite_solid` nhận fast-path chỉ khi `alpha == 1`, knockout, blend `Normal`.
- Mỗi plane được fill đúng giá trị nguồn hoặc `0` cho kênh bị knockout; alpha fill `1`.
- RGB sidecar giữ đúng pixel và trạng thái `VALID_DIRTY`; ca không có màu RGB giữ đúng trạng thái
  `INVALID`/`LOSSY` theo mode như đường `composite_at` cũ.
- Vùng lớn dùng pool Rayon chung theo ngưỡng frame đã có; vùng nhỏ hoặc máy một luồng fill tuần tự.
- Mọi alpha, overprint và blend khác tiếp tục đi vòng pixel tổng quát; không đổi RAM budget,
  worker count, cache budget, DPI hay chất lượng.
- Test exact-pixel so fast-path với `composite_at` cho process CMYK, knockout spot và RGB sidecar
  cả khi có/không có `blend_rgb`.

### Số đo A/B cùng binary

PDF: `C:\Users\Khanh Pham\Desktop\CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1. Công tắc scalar
chỉ tồn tại trong binary đo và đã được gỡ; mỗi nhánh lấy 9 mẫu viewport, cùng resource cache.

| Median | Scalar | Fast-path | Thay đổi |
|---|---:|---:|---:|
| Wall viewport `1600×900 @600 DPI` | 462,685 ms | 388,493 ms | **-16,0%** |
| Raster viewport | 382,489 ms | 316,725 ms | **-17,2%** |
| Wall full-page warm 96 DPI | 284,508 ms | 262,776 ms | **-7,6%** |

Giả lập một luồng (`RAYON_NUM_THREADS=1`) cũng không hồi quy: median raster viewport
`449,916 → 385,714 ms` (**-14,3%**) và full-page warm `305,162 → 250,109 ms` (**-18,0%**).
Đây là đường fill tuần tự, không dựa vào việc ép thêm worker trên máy yếu.

Hash giữ nguyên ở cả hai nhánh A/B:

- full 96 DPI: `1099746fa0736a3f`;
- viewport 600 DPI: `a15c619c09de1f93`.

### Verify và runtime

- `print_engine`: **617 passed, 0 failed, 2 ignored**; `cargo check --offline --locked` đạt.
- Test exact fast-path mới đạt; ba file Rust liên quan đạt `rustfmt --check` và `git diff --check`.
- Tauri target sạch: **121 passed, 0 failed, 5 ignored**; executable dev build đạt.
- Runtime parent → worker, ba lượt đo cuối: cold 96 DPI median **596 ms**, warm **302 ms**,
  viewport median **436 ms**, sau cancel **295 ms**; viewport luôn giữ hash `a15c619c09de1f93`.
- Cooperative cancel **3–7 ms** trong lượt có viewport hoàn chỉnh trước đó và worker giữ PID; lượt
  chuẩn không chèn viewport vẫn đạt **2–4 ms**. Dao động process-to-process khá lớn nên phần trăm
  cải thiện chỉ lấy từ A/B cùng binary, không lấy từ hai lần worker ở hai mức tải máy khác nhau.

Toàn bộ trace, công tắc scalar và cache benchmark tạm đã được gỡ. Gate kỹ thuật L4B2 đạt, nhưng
viewport worker quan sát vẫn cao hơn mục tiêu P95 `350 ms`; chưa được phép tuyên bố ngang Acrobat
trước smoke UI bằng mắt và lô tối ưu kế tiếp.

## Lô 5 — Cooperative cancellation xuyên codec và chuyển màu

**Trạng thái:** hoàn tất code, regression test và benchmark release; chưa dùng kết quả này để
tuyên bố cảm giác Viewer ngang Acrobat trước smoke UI thật.

### L5B1 — Codec và đường giải mã ảnh

Bốn file của lô con:

1. `print_engine/src/image/filters.rs`
   - Giữ wrapper `decode_chain` tương thích, thêm đường có token.
   - Flate đọc output theo block 64 KiB; LZW/ASCII/RunLength và PNG/TIFF predictor kiểm token
     theo block/hàng.
   - `Cancelled` truyền thẳng qua các lần thử zlib/raw-deflate, không bị nhận nhầm là stream
     Flate bị cắt rồi trả dữ liệu một phần.
2. `print_engine/src/image/sampler.rs`
   - Token đi xuyên unpack sample và ảnh `/SMask`; JPEG/CCITT kiểm trước/sau lời gọi thư viện.
3. `print_engine/src/content/interp.rs`
   - Cache hit/miss đều kiểm token; có checkpoint ngay sau decode để ảnh stale không lọt cache.
4. `print_engine/tests/render_cancel.rs`
   - Khóa pre-cancel, cancel giữa Flate/predictor, không ghi cache và pixel parity.

### L5B2 — Chuyển màu soft-proof

Năm file của lô con:

1. `print_engine/src/color/icc.rs`: LCMS kiểm token theo lô 64K pixel, cả đường tuần tự và Rayon;
   mỗi worker giữ một transform rồi chia nhỏ lời gọi, không tạo transform cho từng lô.
2. `print_engine/src/ink.rs`: dựng CMYK, gộp spot và đóng gói RGB đều có checkpoint; thêm
   `to_srgb_with_cancel` trả `PpeError::Cancelled` riêng.
3. `print_engine/src/session.rs`: session Viewer truyền token tới chuyển màu thay vì chỉ kiểm
   trước/sau toàn pass.
4. `print_engine/src/content/interp.rs`: cung cấp token nội bộ cho tầng session.
5. `print_engine/tests/render_cancel.rs`: cancel giữa LCMS và byte-parity khi token chưa hủy.

### Bằng chứng

- `print_engine`: **624 passed, 0 failed, 4 ignored**; `cargo check --offline --locked` đạt.
- Suite mới: **7 passed, 0 failed, 2 benchmark ignored**.
- Hồi quy ảnh: **30/30**; hồi quy ICC: **12/12**.
- `rustfmt --check` cho bảy file Rust chạm trong Lô 5 đạt.
- Benchmark release cùng binary:

| Pass chưa hủy | Không token | Có token | Chênh lệch |
|---|---:|---:|---:|
| Flate 32 MiB | 16,3461 ms | 16,3477 ms | khoảng +0,01% |
| LCMS 2.097.152 pixel | 71,7462 ms | 72,1281 ms | khoảng +0,53% |

Cả hai thấp hơn gate hồi quy 5%. Test hủy giữa Flate/predictor/LCMS đều trả `Cancelled` trong
giới hạn; ảnh giải mã dở không tăng byte cache session. Không thêm worker, cache, giới hạn RAM,
DPI hay hạ chất lượng; máy `>=16 GB` không nhận hard-cap mới.

## Lô 6 — Capability Viewer và compatibility routing

**Trạng thái:** hoàn tất hợp đồng capability/soundness; các capability chưa exact vẫn được giữ
`false` và định tuyến có cấu trúc, không bật cờ giả.

### OCG `/View` và annotation `/AP`

- Core có `OptionalContentUsage::{Print, View}`; mặc định đo mực vẫn `/Print`, PPE Viewer worker
  dùng `/View`.
- Annotation dựng appearance `/AP /N`, chọn state theo `/AS`, áp `/BBox` + `/Matrix`, fit/clip vào
  `/Rect`; Hidden/Invisible/NoView bị bỏ đúng. Dynamic appearance, XFA, `/OC`, NoZoom/NoRotate và
  widget thiếu `/AP` hạ soundness.
- Test: OCG **18/18**, annotation **5/5**; worker thật trên fixture OCG cold/warm **35/19 ms**,
  annotation **28/11 ms** @96 DPI.

### Blend không tách kênh, knockout và codec ảnh

- `Hue/Saturation/Color/Luminosity` chỉ exact khi blending surface là DeviceRGB có ICC; fixture
  managed RGB khóa parity với `BlendMode::blend_rgb` cho cả bốn mode.
- DeviceCMYK/Other/unmanaged RGB hạ `ink_unsound` để hybrid lùi compatibility. Knockout group
  tiếp tục `transparency_knockout_groups=false`: PPE chưa tách shape khỏi opacity nên không được
  xóa cảnh báo chỉ vì ca opaque đơn giản trông đúng.
- JPX/JBIG2 đều có regression fail-loud; capability tiếp tục khai thiếu codec, không trả trang
  trắng dưới nhãn color-verified.
- Transparency suite **48/48**, image suite **30/30**.

### Font không nhúng và protocol `unsupported`

- Worker nhúng `DejaVuSans.ttf`, dùng chung một `Arc`, fingerprint pin:
  `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954`.
- Font thay thế giúp chữ có hình nhưng trả `geometry_approximation`; hybrid dùng PDFium
  compatibility, PPE-only fail-loud. Không phụ thuộc font hệ thống ngẫu nhiên.
- Protocol worker tăng version `4`, thêm `RenderResponseStatus::Unsupported` và mã:
  `image_codec`, `knockout_transparency`, `unsupported_transparency`, `color_approximation`,
  `geometry_approximation`, `hidden_content`, `unsupported_feature`.
- Unsupported khác hoàn toàn cancel/crash/I/O/OOM; chỉ trạng thái này được hybrid fallback.

## Lô 7A — Shadow render và corpus có mẫu số

**Trạng thái implementation:** hoàn tất; **rollout data gate:** chưa thu đủ runtime corpus.

- `PRYNX_VIEWER_SHADOW_RENDER=1`: sau khi frame display sẵn sàng, PPE dựng đúng một full-page
  96 DPI ở lane background; tiếp đó đường `current` PDFium dựng cùng trang/rotation/96 DPI để
  đối chiếu. Cả hai bitmap shadow đều không đi vào compositor/WebView.
- Log `PPE_SHADOW` chỉ chứa hash identity, hash PNG PPE/PDFium, trang/DPI, timing hai engine,
  MAE RGB sau khi ghép alpha lên nền trắng, status/soundness và fingerprint font; không chứa
  path hoặc byte/nội dung PDF.
- `docs/VIEWER_ENGINE_CORPUS_2026-08-10.json`: năm nhóm bắt buộc
  `simple_rgb_vector_text`, `image_scan`, `cmyk_spot`, `transparency_ocg`, `annotation_form`.
  PDF khách là mẫu bắt buộc của rollout, được gọi qua env `PRYNX_VIEWER_CORPUS_CMYK` và khóa
  SHA-256, không ghi path/tên vào report.
- `scripts/ppe_viewer_shadow_report.py`: sinh fixture OCG `/View` + annotation `/AP`
  deterministic, kiểm hash corpus, đọc log, báo mẫu số tuyệt đối/status/P50/P95 hai engine,
  artifact drift và MAE. `--gate` thất bại nếu thiếu một trang, unsupported/error, thiếu bất kỳ
  cặp so sánh/timing nào, lệch artifact hoặc có một lượt MAE `>5`; `--gate` không được phép đi
  cùng `--allow-missing`. Self-test đạt.

## Lô 7B — Ba mode rollout Viewer

`PRYNX_VIEWER_ENGINE_MODE`:

- `current` (mặc định): giữ policy hiện hành — PPE cho trang detector đánh dấu rủi ro.
- `hybrid`: PPE cho mọi trang; chỉ `PPE_NATIVE_UNSUPPORTED` mới lùi PDFium. Trang đã biết thiếu
  capability được nhớ trong vòng đời file để không thử PPE lặp ở mỗi nấc zoom.
- `ppe-only`: PPE cho mọi trang; unsupported phải fail-loud, không dùng PDFium.

Một request hybrid không trộn hai engine: PPE unsupported không có payload; sau đó mới xin một
bitmap PDFium compatibility. Crash/OOM/I/O sau-start vẫn fail-closed. Mode được trả ngay trong
bootstrap trước khi mount trang; default chưa promote sang hybrid vì chưa đủ corpus/RSS/installed
artifact theo gate kế hoạch.

### Verify tổng Lô 6–7

- `print_engine`: **632 passed, 0 failed, 4 ignored**.
- Tauri full suite cuối: **126 passed, 0 failed, 5 ignored**.
- Viewer: typecheck đạt; hai suite loader/tile policy **38/38**; toàn bộ frontend
  **2.142 passed, 2 skipped**.
- Native: `cargo check` đạt; extension release mới import đúng capability, backend
  `test_ppe_native.py` **28/28**.
- Runtime process thật, PDF khách trang 1 @96 DPI: cold **587 ms**, warm **293 ms**,
  cancel **3 ms**, worker vẫn sống; render sau cancel **318 ms**.
- `maturin develop --release` compile wheel thành công nhưng pip trả non-zero vì một process
  Python đang giữ DLL cũ trong thư mục salvage. Package chính đã là build mới và 28 test Python
  đạt; chưa xóa/giết process ngoài phạm vi một cách mù quáng.

Lô 8 chưa bắt đầu.
