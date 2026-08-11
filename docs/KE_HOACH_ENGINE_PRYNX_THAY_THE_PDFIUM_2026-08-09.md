# KẾ HOẠCH PHÁT TRIỂN ENGINE PRYNX THAY THẾ PDFIUM TRONG VIEWER

**Ngày:** 2026-08-09  
**Mốc source:** `89a9048d1d5eb71d64171e8c9195782da064d36a`  
**Nguồn khảo sát:** `docs/BAO_CAO_THAM_KHAO_THAY_THE_PDFIUM_2026-08-09.md`  
**Trạng thái:** đã duyệt; implementation từ Gate 0 đến hết Lô 7 đã hoàn tất. Mặc định vẫn
`current` cho tới khi corpus/runtime/installed-artifact của Lô 7B đủ gate; Lô 8 chưa bắt đầu.  
**Quyết định sản phẩm:** phát triển engine riêng PrynX; không thêm renderer PDF bên ngoài
vào runtime hoặc installer.

## 1. Mục tiêu

Xây **PrynX Render Engine** bằng chính lõi Rust `print_engine`/PPE để dần thay PDFium
trong Viewer, theo ba kết quả người dùng nhìn thấy:

1. Trang đúng màu xuất hiện ngay từ khung đầu, không phát PDFium sai màu rồi đổi hình.
2. Zoom, pan và chuyển trang chỉ dựng phần thực sự cần; tài nguyên đã giải mã được dùng lại.
3. Viewer, soft-proof, separations và TAC dùng chung cách diễn giải PDF/màu.

Tên gọi trong kế hoạch:

- **PPE core:** crate Rust `print_engine`, chịu trách nhiệm parse content, raster, mực,
  transparency và color management.
- **PrynX Render Engine:** hệ hoàn chỉnh gồm coordinator, PPE worker, document session,
  cache và Viewer compositor.
- **PDFium compatibility lane:** đường tạm thời cho capability PPE chưa phủ; không phải
  kiến trúc đích và không được phát khung sai màu trên trang rủi ro.

## 2. Phạm vi và ngoài phạm vi

### Trong phạm vi

- Pixel hiển thị full-page, viewport tile và thumbnail của Viewer.
- PPE document session, page program, resource cache, cancellation và worker process.
- Pipeline màu chính xác, cache bitmap và compositor nền + viewport.
- Mở rộng capability cần thiết để PPE nhận dần các nhóm PDF đang do PDFium dựng.
- Rollout có feature flag, shadow render, fallback và rollback.

### Ngoài phạm vi đợt này

- Không thay PDFium đồng loạt trong in, edit, layer, geometry, flatten, VDP, sticker,
  export và các backend khác.
- Không thêm MuPDF, Poppler, PDF.js hoặc renderer PDF khác làm runtime dependency.
- Không viết lại toàn bộ PDF object parser ngay; tiếp tục dùng `lopdf` phía dưới PPE cho
  tới khi số đo chứng minh chính parser là nút thắt.
- Không thay format file đầu ra hay hành vi nghiệp vụ chế bản.
- Không xóa PDFium DLL trước khi Viewer PPE đạt đủ capability và rollout gate.

## 3. Bất biến không được vi phạm

1. **Đúng trước, nhanh sau.** Không nhận một tối ưu nếu pixel/soundness sai dù benchmark đẹp.
2. Trang rủi ro chỉ được hiện pixel cùng pipeline PPE/color-managed; không dùng PDFium làm
   ảnh tạm để rút ngắn số `first visible`.
3. Full-page nền và viewport tile phải cùng profile, intent, engine version và document identity.
4. Cache không được che lỗi: output `ink_unsound`/degraded không gắn nhãn accurate và không
   ghi vào accurate cache.
5. Máy `<8 GB` mới giảm mạnh, `8–15 GB` giảm nhẹ; máy `>=16 GB` không bị hạ chất lượng,
   DPI hoặc hard-cap worker/cache vô điều kiện.
6. Không đặt `[profile.release]` vào Cargo.toml; LTO chỉ bật trong build production bằng env.
7. Mỗi lô tối đa 5 file production/test; có test đỏ, test xanh, benchmark và log sửa riêng.
8. Một hồi quy runtime do user báo sẽ dừng toàn đợt, khoanh đúng lô và sửa/revert lẻ.

## 4. Baseline hiện tại

### 4.1. File trọng điểm

`CMNM2026 - Giay moi_BLUE - in.pdf` đang đi PPE-only. Số đo cold process gần nhất:

| Trang | 24 DPI |
|---|---:|
| 1 | khoảng `1,09–1,19 s` |
| 2 | khoảng `0,43–0,45 s` |
| 3 | khoảng `0,45–0,48 s` |
| 4 | khoảng `1,12 s` |

Trang 1 và 4 dùng lặp ảnh CMYK Flate `4042 × 2696` kèm SMask cùng kích thước:

- khoảng `103,9 MiB` dữ liệu giải nén qua hai lần dùng;
- khoảng `21,8 triệu` cấp phát nhỏ khi dựng alpha hiện tại;
- thời gian trang 1 @12/24/48/96 DPI gần như có cùng sàn decode.

### 4.2. Vòng đời request hiện tại

- Mỗi `ppe_softproof()` tạo lại `ColorManager`, mở lại `lopdf::Document` và tạo `Renderer`.
- Cache cuối chỉ giữ PNG theo DPI/clip; không giữ Document, decoded operations, ảnh, mask,
  font hoặc shading xuyên hai request 24 → 36 DPI/viewport.
- `Renderer` có font cache trong một lần render, nhưng ảnh XObject chưa có cache theo ObjectId.
- Accurate Viewer đi HTTP → Python → PyO3 → Rust → Python/PIL → PNG → HTTP → WebView.

### 4.3. Capability PPE cần đóng trước khi thay toàn bộ Viewer

| Nhóm | Hiện trạng |
|---|---|
| Vector, text, Form, image, shading 1–7, tiling pattern | Đã có, tiếp tục khóa parity |
| Transparency group/soft mask/blend | Có; Gate 0 đã đóng tự động, tiếp tục khóa parity |
| Knockout transparency group | Chưa có |
| JPXDecode/JBIG2Decode | Chưa có |
| Blend Hue/Saturation/Color/Luminosity | Đang xấp xỉ |
| Optional Content | Hiện dùng cấu hình `/Print`; Viewer cần thêm cấu hình `/View` |
| Annotation/widget appearance | Chưa có đường render trong PPE |
| Font không nhúng | Cần fallback font từ caller; hình học có thể approximate |
| PDF lỗi/encrypted/XFA/JS | Phải có policy fail-loud hoặc compatibility lane rõ ràng |

### 4.4. Blocker hiện tại trước mọi tối ưu tiếp theo

Rà chéo bounded soft-mask đã xác nhận:

1. `[Đã đóng Gate 0A]` `/Alpha` sai `TR(0)` tại dải 1 px ngoài `/BBox`.
2. `[Đã đóng Gate 0A]` Text clip chưa đồng bộ `clip_region`.
3. `[Đã đóng Gate 0A]` Guard-band 1 px chưa đủ cho soft mask lồng lấy mẫu bán kính 3 px.
4. `[Đã đóng Gate 0B]` RGB sidecar có thể cấp phát thừa khi không có ColorManager.
5. `[Đã đóng Gate 0B]` MemoryBudget chưa bao phủ đủ raster/mask cục bộ.
6. `[Đã đóng Gate 0B]` API `SoftMask` công khai chưa nhất quán với constructor `pub(crate)`.

Gate 0A đã có pixel oracle bounded/full-frame, test bốn cạnh `/BBox`, text clip dưới
ngân sách chặt và nested mask origin khác 0. Gate 0B đã thêm test RAM chặt, lease
release và compile contract external; bước tiếp theo là Lô 1 tối ưu image `/SMask`.

## 5. Kiến trúc đích

```text
React Viewer Compositor
  └── PrynX Render Coordinator
      ├── owner / generation / priority / cancellation
      ├── document-scoped bitmap cache
      └── PPE Worker Manager
          ├── interactive lane
          ├── background/prefetch lane theo RAM + CPU
          └── PPE Document Session
              ├── lopdf::Document mở một lần
              ├── ColorManager/profile mở một lần mỗi pipeline
              ├── Page Program/decoded operations cache
              ├── Resource Cache
              │   ├── image + image SMask
              │   ├── font/glyph
              │   ├── Form/Pattern/Shading
              │   └── page descriptor/boxes/OCG
              └── clipped raster → PNG/buffer → compositor
```

### 5.1. Document identity

Mọi session/cache phải khóa theo:

```text
canonical path + size + mtime_ns + ctime_ns + engine version
+ profile ID/fingerprint + intent + OCG mode
```

File bị save-over cùng path phải đóng session cũ và không được trả bitmap cũ.

### 5.2. Request contract

```text
request_id, owner_id, page_instance_id, generation
purpose(interactive|background), priority
document_identity, page, rotation, page_box
dpi/scale, clip(x,y,w,h)
color_pipeline, profile, intent, OCG mode
```

Response phải trả bitmap size, engine/session version, cache tier, timing từng công đoạn,
`degraded`, `ink_unsound` và lý do warning. Generation cũ bị bỏ trước encode/decode/composite.

### 5.3. Cache ownership và ngân sách

- Cache resource sở hữu bởi document session, không bởi từng tile.
- Cache bitmap sở hữu theo document + page/pipeline và ref-count theo tab.
- Mọi cache Rust phải có byte accounting/RAII lease trong MemoryBudget.
- Thiếu RAM: bỏ cache/prefetch trước, không làm giảm độ chính xác pixel cuối.
- Máy `>=16 GB`: pool/cache co giãn theo RAM còn trống và CPU; không dùng trần cố định làm
  máy mạnh chậm đi.

## 6. Roadmap triển khai theo lô

### Gate 0A — Sửa correctness soft-mask

**Mục tiêu:** benchmark PPE chỉ được dùng sau khi bounded soft-mask đúng pixel.

**Trạng thái 2026-08-09:** hoàn tất kiểm thử tự động; chưa xác nhận bằng corpus/runtime Tauri.
Nhật ký bằng chứng: `docs/ENGINE_PRYNX_THAY_PDFIUM_FIXES_2026-08-09.md`.

Tối đa 5 file dự kiến:

1. `print_engine/src/content/interp.rs`
2. `print_engine/src/content/gstate.rs`
3. `print_engine/src/ink.rs`
4. `print_engine/tests/render_transparency.rs`
5. `print_engine/tests/render_page.rs`

Việc làm:

- Dùng đúng `TR(0)` ngay ngoài bốn cạnh `/BBox`.
- Đồng bộ text clip với `clip_region`.
- Tính guard-band dựa trên footprint lấy mẫu thật cho nested soft-mask.
- Khóa `q/Q`, CTM tại `gs`, group isolated/non-isolated và origin khác 0.

Gate:

- Pixel oracle full-page/bounded đạt tại biên và nested mask.
- Toàn bộ `print_engine` test xanh; không cập nhật golden chỉ để che sai khác.

### Gate 0B — MemoryBudget và API SoftMask

Tối đa 5 file dự kiến:

**Trạng thái 2026-08-09:** hoàn tất kiểm thử tự động; chưa benchmark PDF khách hoặc
xác nhận runtime Tauri.

1. `print_engine/src/ink.rs`
2. `print_engine/src/raster/mask.rs`
3. `print_engine/src/content/interp.rs`
4. `print_engine/tests/render_transparency.rs`
5. `print_engine/tests/api_compat.rs` mới

Việc làm:

- Tính mọi raster/mask/scratch cục bộ vào cùng ngân sách.
- Không cấp RGB sidecar khi đường render không thể sử dụng nó.
- Cung cấp API SoftMask nhất quán cho integration caller hoặc thu hẹp API có chủ đích.
- Test như crate bên ngoài để khóa compile contract.

Gate:

- Ngân sách chặt fail có kiểm soát, không OOM và không leak reservation.
- Máy đủ RAM không bị thêm cap hoặc đường copy mới.

### Lô 1 — Bỏ decode lặp image SMask trên file khách

Đây là quick-win hiệu năng đầu tiên sau Gate 0, đúng 5 file:

1. `print_engine/src/image/sampler.rs`
2. `print_engine/src/image/filters.rs`
3. `print_engine/src/content/interp.rs`
4. `print_engine/src/ink.rs`
5. `print_engine/tests/render_image.rs`

Việc làm:

- Đọc một component mask không cấp phát `Vec` từng pixel.
- Không dựng alpha `f32` toàn ảnh nếu có thể lấy mẫu trực tiếp từ mask đã decode.
- Bỏ copy `raw.to_vec()` trước khi filter thật sự sinh output.
- Cache `Arc<SampledImage>` theo ObjectId trong phạm vi một render.
- Cache chỉ áp tài nguyên có colorspace tự chứa; resources theo scope khác phải bypass.
- Tính byte cache vào MemoryBudget; thiếu ngân sách thì render đúng theo đường cũ.

Gate hiệu năng đề xuất:

- Trang 1 @24 DPI: `0,35–0,65 s` hoặc nhanh hơn baseline ít nhất 40%.
- Trang 2–3: không chậm quá 5%.
- 12/24/48/96 DPI: RGB/alpha/soundness parity.
- Hai Form dùng cùng ảnh nhưng khác CTM/clip/alpha vẫn ra đúng.

### Lô 2A — PPE RenderSession trong Rust

**Mục tiêu:** mở Document/profile một lần và dùng lại qua nhiều render.

**Trạng thái 2026-08-09:** hoàn tất implementation native, 10 test session và benchmark
release trên file khách. Session chưa được nối qua PyO3/backend/Tauri; giới hạn này thuộc Lô 2B.

Tối đa 5 file dự kiến:

1. `print_engine/src/session.rs` mới
2. `print_engine/src/lib.rs`
3. `print_engine/src/page.rs`
4. `print_engine/src/content/interp.rs`
5. `print_engine/tests/render_session.rs` mới

Session giữ:

- `lopdf::Document` + identity;
- page descriptors/boxes/resources;
- ColorManager theo profile/intent;
- resource cache có budget và thống kê hit/miss.

API cũ `render_page_*(&Document, ...)` tiếp tục tồn tại làm compatibility wrapper để không
đập toàn bộ backend trong một lô.

Gate:

- Open/close/invalidate/save-over/concurrent owner test xanh.
- Render qua session pixel-equal với API cũ.
- Không giữ Document/session mồ côi sau owner cuối hoặc TTL an toàn.

### Lô 2B — Session qua PyO3/backend hiện tại

**Trạng thái 2026-08-09:** hoàn tất implementation, test bridge Python và benchmark
file khách. API session đã sẵn sàng cho coordinator; Viewer chưa tự thuê session cho
đến Lô 2C.

Danh sách năm file ban đầu thiếu hai điểm đăng ký/public API và timing phải đo trong
core. Vì vậy implementation được tách thành hai tiểu lô, mỗi tiểu lô vẫn không quá 5 file:

**2B.1 — core/PyO3 (4 file):**

1. `print_engine/src/session.rs`
2. `print_engine/tests/render_session.rs`
3. `native/src/print_engine_py.rs`
4. `native/src/lib.rs`

**2B.2 — backend/contract (5 file):**

1. `backend/app/core/print_engine/facade.py`
2. `backend/app/core/print_engine/__init__.py`
3. `backend/app/core/softproof.py`
4. `backend/tests/test_ppe_facade.py`
5. `backend/tests/test_icc_and_color_preview.py`

Việc làm:

- Thêm open/render/close session theo document identity.
- Serialize đúng một session nếu ColorManager/cache không Sync; các document khác vẫn có thể
  chạy song song theo worker/process.
- Giữ API stateless làm fallback trong một release.
- Trả timing `open/parse/resource/raster/color/encode` thay vì một số tổng mơ hồ.

Gate:

- Request 24 → 36 DPI → viewport cùng trang phải hit Document/resource cache.
- Tab khác không chiếm/hủy session sai owner.
- Python cancel/disconnect không để response stale ghi cache.

Kết quả gate:

- 24 → 36 DPI → viewport cùng trang tăng `image_hits`, không tăng `image_misses`.
- Native và facade đều từ chối owner sai, generation cũ hoặc generation bị dùng lại.
- Cancel nâng generation ngay; thread native có thể còn hoàn tất raster nhưng RGB bị bỏ
  trước khi về Python. Cache Viewer hiện có tiếp tục không ghi response khi waiter mất.
- Save-over tự refresh identity/generation. File đang ghi dở làm request hiện tại lỗi an
  toàn nhưng không giết session vĩnh viễn; request sau có thể refresh lại.
- Timing được trả riêng `open/parse/resource/raster/color/encode`; refresh save-over cũng
  được phân lại đúng `open/parse`, không dồn sai vào `resource`.

### Lô 2C — PPE Viewer Session Manager

**Trạng thái 2026-08-09:** hoàn tất runtime backend + frontend owner lifecycle, test tự
động và benchmark route trên file khách. Triển khai được tách thành hai tiểu lô,
mỗi tiểu lô không quá 5 file:

**2C.1 — identity/session/admission (5 file):**

1. `backend/app/core/ppe_viewer_session.py` mới
2. `backend/app/core/viewer_accurate_cache.py`
3. `backend/app/api/routes/preflight.py`
4. `backend/app/schemas/preflight.py`
5. `backend/tests/test_ppe_viewer_session.py` mới

**2C.2 — lifecycle/client/gate (5 file):**

1. `backend/app/main.py`
2. `desktop/src/hooks/viewer/useTileRenderer.ts`
3. `desktop/src/hooks/viewer/useTileRenderer.test.ts`
4. `backend/tests/test_viewer_accurate_cache.py`
5. `backend/tests/test_icc_and_color_preview.py`

Việc làm:

- Lease/ref-count session theo tab/document revision.
- Active request có priority cao hơn prefetch; owner cuối đóng session.
- Invalidate cache/session nguyên tử khi file thay đổi.
- RAM tier điều khiển số session nền, không hạ DPI cuối.

Gate mục tiêu warm:

- Trang đã mở: first correct frame/cache-resource khoảng `0,10–0,30 s` tùy nội dung.
- Zoom-stop → sharp trên trang đã warm: P50 `<=150 ms`, P95 `<=350 ms` là gate đề xuất;
  phải đo trước sửa để chốt lại nếu corpus chứng minh ngưỡng không thực tế.

Kết quả gate:

- Route thật trên file khách: cold 24 DPI `337,2 ms`, warm 36 DPI `100,3 ms`, viewport
  256×256 warm `68,5 ms`; hai request warm đều dưới gate P50 `150 ms`.
- Full-page owner và viewport owner khác nhau nhưng dùng chung một logical session owner;
  manager chỉ mở 1 native session và image miss không tăng sau lần cold.
- Owner/generation native là nội bộ; hai tab không hủy nhầm. Interactive vượt
  background còn chờ, nhưng không hứa preempt native job đã bắt đầu trước Lô 5.
- Owner cuối/TTL đóng session; active render và native close đang chạy được ref-count/
  shield đúng. RAM pending-close vẫn nằm trong pool, không mở chồng cùng revision.
- DELETE/POST đảo thứ tự được khóa bằng generation watermark; request cũ không
  hồi sinh owner và cleanup cũ không đóng generation mới trong React StrictMode.
- **151/151** test backend, **18/18** test hook Viewer và typecheck đều đạt.

### Lô 2D — Zoom hot-path và preemption sớm

**Trạng thái 2026-08-09:** hoàn tất. Kéo phần token/checkpoint cần cho Viewer từ Lô 5 lên
trước Lô 3, đồng thời tối ưu đúng hai pass đang chiếm thời gian trên PDF khách.

- Bỏ pad viewport 256 px, snap 64 px; settle wheel `90 → 48 ms`, giữ bitmap cũ tới khi ảnh
  mới sẵn sàng. Không hạ DPI/chất lượng.
- Color FOGRA39→sRGB frame lớn chạy song song và byte-exact; P50 `~550 → 85,7 ms`.
- Soft-proof dùng alpha mask đúng pixel; đo mực vẫn giữ lấy mẫu bảo thủ 7×7.
- Fast path CMYK không cấp phát theo pixel và parallel SoftLight group theo hàng.
- Native generation nối vào `CancelToken`; stale render warm thoát P50/P95 `3,4/3,6 ms`,
  request cuối chỉ còn queue overhead P50/P95 `5,8/6,4 ms`.
- Vùng nhìn 1984×1152 @288 DPI đạt P50/P95 `949,7/977,1 ms`; đường cũ có pad khoảng
  `3.871 ms`. RGB ổn định qua bảy lượt.
- Gate: 612 test core, 4 test native slot, 120 backend, 56 frontend và typecheck đều đạt.

Phần codec Flate lạnh chưa checkpoint giữa stream vẫn nằm ở Lô 5B. Preemption Viewer warm
đã đủ bằng chứng để bật settle 48 ms, nhưng không được suy rộng thành mọi codec đều thoát
trong 4 ms.

### Lô 3A — PPE worker process native, chưa route UI

**Mục tiêu:** bỏ chi phí HTTP/Python/PIL khỏi đường Viewer và cách ly crash/OOM.

Tối đa 5 file dự kiến:

1. `desktop/src-tauri/Cargo.toml` — chỉ thêm path dependency, không thêm release profile
2. `desktop/src-tauri/src/pdf_engine/ppe_worker.rs` mới
3. `desktop/src-tauri/src/pdf_engine/mod.rs`
4. `desktop/src-tauri/src/main.rs`
5. `desktop/src-tauri/src/lib.rs`

Worker tự-spawn cùng `PrynX.exe`, dùng framed binary protocol và giữ PPE RenderSession lâu dài.
Prototype chưa được route từ UI; chỉ benchmark/parity với backend hiện tại.

Gate:

- Handshake pin protocol/app/engine/profile version.
- Path/identity validation, timeout, crash/restart và shutdown sạch.
- Process UI không giữ raster PPE nặng.
- Output/timing/soundness parity với PyO3 đường cũ.

### Lô 3B — PPE Worker Manager và hardware policy

Tối đa 5 file dự kiến:

1. `desktop/src-tauri/src/pdf_engine/ppe_worker.rs`
2. `desktop/src-tauri/src/lib.rs`
3. `desktop/src-tauri/src/security.rs`
4. test Rust trong `ppe_worker.rs`
5. `desktop/src-tauri/tauri.conf.json` nếu cần bundle profile/resource

Policy:

| RAM | PPE lane |
|---|---|
| `<8 GB` | 1 interactive; background chỉ mượn khi idle |
| `8–15 GB` | 1 interactive + tối đa 1 background hoạt động |
| `>=16 GB` | luôn bảo lưu interactive; background co giãn theo CPU/RAM còn trống |

Cancel/preempt phải áp đúng request lease; không kill nhầm tab/document khác.

### Lô 3C — Route Viewer accurate sang native PPE worker

**Trạng thái 2026-08-09:** hoàn tất code, test tự động và smoke đúng PDF khách qua
Tauri dev; còn chốt cảm giác zoom/pan bằng mắt trên cửa sổ thật trước khi sang Lô 4.

Năm file implementation/test thực tế:

1. `desktop/src/hooks/viewer/useTileRenderer.ts`
2. `desktop/src/hooks/viewer/renderCoordinator.ts`
3. `desktop/src-tauri/src/pdf_engine/render_worker.rs`
4. `desktop/src-tauri/src/lib.rs`
5. `desktop/src/hooks/viewer/useTileRenderer.test.ts`

Việc làm:

- Accurate request đi binary IPC tới PPE worker, không vòng HTTP/Python/PIL.
- Giữ backend PPE cho separations/TAC/action; chỉ Viewer đổi đường.
- Blob/cache key mang PPE engine/session/profile version.
- Nền PPE đúng màu tiếp tục hiện trong lúc viewport PPE nét hơn đang chờ.

Gate:

- Không white flash, không PDFium flash, không hue seam.
- Cache hit/stale/cancel/multi-tab test xanh.
- Feature flag cho phép về đường backend cũ trong cùng release.

Kết quả:

- Accurate frame đi `render_ppe_page` qua IPC và dùng namespace
  `ppe-fogra39-relative-png-v4-native-worker`; không gọi HTTP/Python/PIL ở đường thường.
- Chỉ lỗi `PPE_NATIVE_FALLBACK_BEFORE_START` (worker off/spawn chưa gửi request) mới về
  route backend. Lỗi render/soundness sau-start tiếp tục fail-closed.
- Cancel group/viewport vừa abort HTTP compatibility vừa gọi `cancel_pdf_render` để loại
  request worker vật lý. Session owner tách khỏi request owner, ref-count theo tab; tab A
  không đóng cache của tab B. Owner WebView crash được sweeper thu sau TTL.
- Máy `<8 GB`/`<16 GB` giữ policy 1/2 session persistent; khi hết chỗ và mọi owner còn
  sống, tài liệu mới chạy transient cache 0 thay vì đóng session tab khác hoặc hạ DPI.
  Máy `>=16 GB` vẫn không hard-cap khi RAM bình thường.
- Gate: worker **24/24 đạt**, 2 runtime test giữ ignored; bảy suite Viewer **105/105 đạt**;
  typecheck, `cargo check --offline --locked`, dev build, rustfmt/diff check đạt.
- Process worker đúng PDF khách đạt cold/warm 96 DPI **645/358 ms**, PNG 488.969 byte.
  Tauri dev thật ghi trang 1 `IPC_PPE=713 ms` (`worker=669 ms`) và trang 2 `865 ms`.
  Đây là bằng chứng route/runtime; chưa thay cho duyệt bằng mắt độ mượt zoom/pan.

### Lô 4A — Page Program: parse content một lần

**Trạng thái 2026-08-09:** hoàn tất code, parity test và benchmark native. Kết quả đo trên
PDF khách chỉ tiết kiệm khoảng `0,258 ms` decode content mỗi lần replay; đây là nền cho Lô 4B,
không phải lời giải cho độ trễ Viewer `600–900 ms`. Runtime log cho thấy nút thắt kế tiếp là
cancel đang giết cả worker và làm mất RenderSession/cache, nên phải đóng cooperative cancellation
trước khi tiếp tục mở rộng bounds của Lô 4B.

Tối đa 5 file dự kiến:

1. `print_engine/src/page_program.rs` mới
2. `print_engine/src/content/mod.rs`
3. `print_engine/src/content/interp.rs`
4. `print_engine/src/page.rs`
5. `print_engine/tests/render_page_program.rs` mới

Bước đầu không phát minh IR lớn. Chỉ cache page descriptor, decoded operation list và resource
scope; `Renderer` nhận operations đã decode. API chạy bytes cũ còn làm wrapper parity.

Gate:

- Cùng page program replay ở nhiều DPI/clip/rotation cho output parity.
- Parse time gần 0 ở lần render thứ hai.
- Không giữ tham chiếu resource sai qua Form/Pattern/Type3 scope.

### Chốt hiệu năng giữa Lô 4A và 4B — Cooperative cancellation transport

**Trạng thái 2026-08-09:** hoàn tất code, test toàn Tauri và runtime trực tiếp trên PDF khách.

Runtime log trước sửa chứng minh mỗi nhịp zoom stale lại phát sinh `RENDER_WORKER_SPAWN` vì
`cancel_render_request()` kill cả process. Bản sửa tăng protocol worker `2 → 3`, thêm frame
`Cancel` một chiều và giữ luồng stdin đọc control trong khi PPE đang render. Chỉ pipeline PPE
có `CancelToken` dùng cooperative cancel; PDFium display không có checkpoint nên vẫn giữ kill
fallback cũ. Nếu gửi frame cancel thất bại, parent mới kill worker để không treo request.

Gate đo được trên `CMNM2026 - Giay moi_BLUE - in.pdf`, trang 1:

- cold 96 DPI: **637 ms**;
- warm 96 DPI: **365 ms**;
- stale render 600 DPI viewport thoát sau **3 ms**;
- worker PID trước/sau cancel giữ nguyên (`1052` trong lượt đo);
- render 96 DPI ngay sau cancel: **357 ms**, xác nhận session/cache vẫn warm;
- test worker: **26 passed, 0 failed, 2 ignored**;
- toàn Tauri Rust: **121 passed, 0 failed, 5 ignored**; `cargo check` đạt.

Kết quả này đóng nguyên nhân spawn lạnh theo từng cancel ở đường PPE. Cảm giác zoom/pan trong
cửa sổ Tauri thật vẫn phải được người dùng duyệt; chưa dùng test IPC trực tiếp để tuyên bố đã
đạt ngang Acrobat.

### Lô 4B1 — Hot path shading process/soft mask

**Trạng thái 2026-08-09:** hoàn tất code, test và runtime worker; còn chốt cảm giác bằng mắt
trong Tauri thật.

Profile trên file khách bác bỏ giả thuyết resource program là ưu tiên đầu: session/resource chỉ
`0,2–0,4 ms`, còn raster `662–680 ms`. Một nhánh ảnh CMYK song song chỉ cải thiện `3,1–3,2%`
nên đã gỡ. Nút thắt có lợi ích đủ lớn là shading DeviceN/process trong ba soft mask giao viewport.

Bản sửa song song hóa theo hàng khi và chỉ khi LUT không có spot, không có RGB sidecar, blend tách
kênh và các plane spot nền đều bằng 0; mọi ca khác giữ đường scalar. Không thêm cap máy mạnh.
Hash full-page/viewport giữ nguyên; median wall viewport giảm `742,380 → 653,097 ms` (**12,0%**),
raster giảm `672,381 → 587,552 ms` (**12,6%**). Runtime worker đạt cold/warm 96 DPI
`594–604 / 306–331 ms`, viewport `1600×900 @600 DPI` **449 ms**, cancel `2–3 ms` và worker
vẫn sống. `print_engine` **616 passed**, worker **26 passed**, Tauri **121 passed**.

### Lô 4B2 — Ảnh Flate + soft mask theo DPI/clip

**Trạng thái 2026-08-10:** hoàn tất profile warm-cache, fast-path backdrop soft mask, A/B cùng binary,
pixel parity và runtime worker; còn smoke cảm giác bằng mắt trong Tauri thật.

Profile bác bỏ inflate là nút thắt warm: cache lookup ảnh `4357` chỉ khoảng `0,003 ms`, toàn pass ảnh
chính khoảng `9–10 ms`. Ba ExtGState luminosity mask giao viewport mới chiếm phần lớn thời gian;
riêng việc phủ màu nền `/BC` bằng vòng blend tổng quát tốn khoảng `49–64 ms` mỗi frame.

`InkBuffer::composite_solid` nay fill trực tiếp plane/alpha/RGB sidecar khi màu nền đục, knockout và
blend `Normal`; mọi ca alpha/overprint/blend khác giữ đường scalar. Không thêm cache bitmap, không
đổi DPI/chất lượng, không tăng RAM và không hard-cap máy mạnh. A/B release cùng binary với cache
giống worker: median wall viewport `462,685 → 388,493 ms` (**-16,0%**), raster
`382,489 → 316,725 ms` (**-17,2%**), full-page warm 96 DPI `284,508 → 262,776 ms` (**-7,6%**).
Hai hash chuẩn giữ nguyên; cấu hình một luồng cũng nhanh hơn, không có hồi quy máy yếu.

### Lô 5A — Cancellation token trong PPE core

**Trạng thái 2026-08-10:** hoàn tất. Token đã đi xuyên file/page/session API, operator,
Form/pattern, ảnh/shading/soft-mask và có fixture cancellation chuyên biệt.

Tối đa 5 file dự kiến:

1. `print_engine/src/cancel.rs` mới
2. `print_engine/src/lib.rs`
3. `print_engine/src/page.rs`
4. `print_engine/src/content/interp.rs`
5. `print_engine/tests/render_cancel.rs` mới

Token được kiểm giữa operations, Form/pattern recursion và trước các allocation lớn. Cancel trả
trạng thái riêng, không ghi cache và không bị gắn thành lỗi PDF.

### Lô 5B — Cancellation trong hot loop/codec

**Trạng thái 2026-08-10:** hoàn tất. Flate/LZW/ASCII/RunLength/predictor, trải mẫu ảnh,
SMask và chuyển màu LCMS đều có checkpoint theo block/hàng; JPEG/CCITT giữ checkpoint hai
biên vì thư viện không cung cấp callback giữa lời gọi.

Tối đa 5 file dự kiến:

1. `print_engine/src/image/filters.rs`
2. `print_engine/src/image/sampler.rs`
3. `print_engine/src/shading/eval.rs`
4. `print_engine/src/content/interp.rs`
5. `print_engine/tests/render_cancel.rs`

Flate/ảnh/shading/soft-mask dài phải có checkpoint đủ thường xuyên. Không thêm polling mỗi pixel
nếu benchmark chứng minh gây chậm máy mạnh; dùng block/scanline checkpoint.

Gate:

- Request stale dừng có giới hạn đo được.
- Trang không cancel không chậm quá 5%.
- Cancel không leak MemoryBudget/session lock.

Kết quả chốt: 624 test đạt, 4 benchmark ignored mặc định. A/B release cùng binary cho
checkpoint chưa hủy: Flate median `16,3461 → 16,3477 ms`; LCMS `71,7462 → 72,1281 ms`
(khoảng `+0,53%`, dưới gate 5%). Cancel giữa Flate/predictor/LCMS trả `Cancelled`, ảnh
giải mã dở không được ghi vào cache session và pixel chưa hủy giữ byte-exact.

### Lô 6 — Đóng capability Viewer theo thứ tự rủi ro

**Trạng thái implementation 2026-08-10:** hoàn tất hợp đồng capability/soundness. OCG `/View`
và annotation `/AP` đã dựng; blend không tách kênh exact trên RGB managed. Knockout,
JPX/JBIG2, font thay thế và các ngữ cảnh chưa exact trả trạng thái `unsupported` có mã để
`hybrid` lùi compatibility, không bị nhận nhầm là crash và không gắn color-verified.

Không gộp thành một lô lớn. Mỗi capability có report/test/golden riêng và tối đa 5 file.

Thứ tự đề xuất:

1. **Knockout transparency group** — correctness mực/màu, ưu tiên cao nhất.
2. **OCG `/View` mode** — tách khỏi `/Print`; Viewer và separations không dùng nhầm cấu hình.
3. **JPX/JBIG2** — fail-loud tới khi codec đạt; không trả trang thiếu ảnh.
4. **Annotation/widget appearance `/AP`** — chỉ dựng appearance stream; JavaScript/XFA vẫn
   ngoài scope và phải báo rõ.
5. **Bốn blend mode không tách kênh** — nâng từ approximate hoặc giữ nhãn rõ nếu spec/corpus
   chưa cho phép exact.
6. **Font không nhúng** — mapping font hệ thống/fallback có fingerprint và nhãn geometry.

Mỗi capability chỉ được đổi `ppe_capabilities()` sau khi fixture + corpus + soundness gate đạt.

### Lô 7A — Shadow render và phân nhóm di trú

**Trạng thái implementation 2026-08-10:** hoàn tất. `PRYNX_VIEWER_SHADOW_RENDER=1` dựng PPE
full-page 96 DPI ở lane nền sau frame display sẵn sàng, rồi dựng cùng trang bằng đường `current`
PDFium để đối chiếu; không bitmap shadow nào được composite lên UI. Log chỉ có document/hash
hai artifact, timing hai engine, MAE RGB sau composite nền trắng và soundness/capability code.
Corpus manifest có mẫu số cố định theo năm nhóm và script report/gate tái lập; chưa dùng dữ liệu
rỗng để tuyên bố rollout đạt.

PPE dựng nền ở chế độ shadow nhưng không hiển thị; so timing/soundness/artifact và MAE RGB với
đường hiện tại. Không thu/đẩy nội dung PDF khách; log chỉ chứa hash/metrics khi opt-in.

Nhóm di trú:

1. Trang RGB/vector/text đơn giản.
2. Trang ảnh/scan.
3. Trang CMYK/spot — hiện đã PPE-first.
4. Transparency/pattern/OCG sau khi capability gate tương ứng đạt.
5. Annotation/form chỉ sau Lô 6.

Không dùng một tỷ lệ telemetry không có mẫu số làm gate. Gate là corpus xác định, artifact và
runtime canary có thể tái lập. PDF khách bốn trang là mẫu bắt buộc qua env đã khóa hash;
`--gate` không cho phép bỏ mẫu thiếu.

### Lô 7B — PPE mặc định cho Viewer

**Trạng thái implementation 2026-08-10:** ba mode `current | hybrid | ppe-only` đã chạy xuyên
native bootstrap → React policy. `hybrid` thử PPE cho mọi trang và chỉ fallback khi nhận
`unsupported`; lỗi worker/I/O/OOM vẫn fail-loud. `ppe-only` cấm fallback. Default cố ý giữ
`current` vì chưa có đủ corpus P50/P95/RSS và installed smoke để được phép promote.

Feature modes trong ít nhất một release:

```text
current   = policy hiện hành
hybrid    = PPE mặc định, PDFium compatibility lane theo capability
ppe-only  = QA/required; unsupported phải fail-loud
```

Mặc định chỉ chuyển sang `hybrid` khi:

- corpus Viewer không có P0/P1 mở;
- mọi lượt so PPE–PDFium của toàn bộ mẫu số corpus có MAE RGB `<=5`, không thiếu cặp ảnh;
- P50/P95 và peak RSS đạt theo ba RAM tier;
- multi-tab, rotate, zoom, minimize/restore, print song song và worker crash đạt;
- installed artifact clean-user chứa đúng engine/profile/version.

### Lô 8 — Gỡ PDFium khỏi Viewer

Chỉ sau một release hybrid ổn định:

- xóa route PDFium pixel khỏi Viewer/thumbnail;
- giữ compatibility package có thể rollback trong một release kế;
- không đụng PDFium của print/edit/layer/backend trong lô này;
- cập nhật manifest, NOTICE và verifier theo artifact thật.

Việc loại PDFium khỏi **toàn dự án** phải là audit riêng sau khi Viewer đã đóng, vì đó là 56+
file production và nhiều hợp đồng nghiệp vụ khác.

## 7. Chỉ số nghiệm thu xuyên suốt

### Trải nghiệm

| Chỉ số | Gate đề xuất |
|---|---:|
| Cold first correct frame, file khách trang 1 sau Lô 1 | `0,35–0,65 s` hoặc cải thiện `>=40%` |
| Warm first correct frame sau session | khoảng `0,10–0,30 s` |
| Warm zoom-stop → sharp | P50 `<=150 ms`, P95 `<=350 ms` |
| Pan → viewport sharp | không white flash; P95 không xấu hơn zoom gate |
| Trang 2–3 file khách | không chậm quá 5% so baseline |

Các ngưỡng warm là mục tiêu thiết kế, phải chốt lại bằng baseline runtime trước lô liên quan;
không được sửa số sau khi thất bại chỉ để báo đạt.

### Chất lượng

- `CMNM2026`: MAE RGB so baseline Acrobat đã duyệt `<=5`.
- Full-page/tile: fill đặc pixel-exact; stroke AA giữ gate overlap đã audit.
- Không hue seam, banding mới hoặc đổi màu giữa coarse/base/viewport.
- `ink_unsound`/degraded/warning truyền đủ qua mọi protocol/cache/UI.
- Separations/TAC không dùng output soft-proof đã quy RGB.

### Tài nguyên

- Đo peak RSS theo process và toàn app; đo cache bytes/hit/miss/eviction.
- Không swap/OOM ở tier `<8 GB` với corpus chuẩn.
- Máy `>=16 GB` không chậm quá 10% ở tác vụ không liên quan và không bị hạ chất lượng.
- Background không chiếm lane interactive.

### Ổn định/phát hành

- Worker crash/restart không kéo sập UI hoặc sidecar.
- File save-over không dùng session/cache revision cũ.
- Hai tab cùng file không hủy/đóng session của nhau.
- Build dev không bị LTO chậm; release mới bật LTO qua env như policy hiện có.
- Installer clean-user có manifest/hash/version đúng và không phụ thuộc môi trường dev.

## 8. Ma trận kiểm thử bắt buộc

1. PDF khách trọng điểm và corpus khách đã ẩn danh/hash.
2. RGB vector/text, scan/photo, mixed-size, >2.000 trang.
3. DeviceCMYK, DeviceN/spot, OutputIntent có/không.
4. Image SMask, ExtGState soft-mask, nested mask, isolated/non-isolated/knockout group.
5. Shading 1–7, tiling/shading pattern, Type3, inline image.
6. OCG `/View` và `/Print` mâu thuẫn có chủ đích.
7. CropBox lệch, `/UserUnit`, rotation 0/90/180/270.
8. Annotation/widget appearance, encrypted/malformed/cancel giữa chừng.
9. Bộ test prepress chuẩn ngành cho transparency, overprint, spot và CMS.

Mỗi lô chạy test hẹp trước; trước khi báo hoàn tất phase phải theo ma trận
`prynx-testing`: Rust crate, native binding, backend contract, frontend Viewer và artifact/runtime
phù hợp phạm vi.

## 9. Nhật ký và quyền rollback

- Tạo `docs/ENGINE_PRYNX_THAY_PDFIUM_FIXES_2026-08-09.md` khi bắt đầu sửa.
- Mọi thay đổi gắn tag `PERF/COLOR/CORRECTNESS (audit 2026-08-09 §PRE.<mã>)`.
- Feature flag giữ đường cũ tới hết rollout.
- Cache namespace tăng theo thay đổi pixel contract; không đọc cache cũ bằng suy đoán.
- Không commit/stage chung với thay đổi ngoài phạm vi trong worktree hiện đang bẩn.

## 10. Thứ tự triển khai đề nghị

```text
Gate 0A/0B correctness
  → Lô 1 image SMask/cache quick-win
  → Lô 2A/2B/2C RenderSession
  → Lô 3A/3B/3C native PPE worker + Viewer route
  → Lô 4A/4B Page Program
  → Lô 5A/5B cancellation
  → Lô 6 capability coverage
  → Lô 7 shadow/hybrid rollout
  → Lô 8 gỡ PDFium khỏi Viewer
```

Ba chốt user/runtime bắt buộc:

1. Sau Gate 0 + Lô 1: xác nhận màu và tốc độ đúng file khách.
2. Sau Lô 3C: smoke zoom/pan/chuyển trang trong Tauri thật trước khi xây Page Program tiếp.
3. Trước Lô 7B: duyệt corpus, P50/P95/RSS và installed artifact.

## 11. Chốt duyệt

Đã triển khai đến hết **Lô 7** và dừng trước Lô 8. Runtime worker thật trên PDF khách trang 1
@96 DPI đạt cold **587 ms**, warm **293 ms**, cooperative cancel **3 ms**; OCG `/View` và
annotation `/AP` fixture cũng đi process worker thành công. Đây chưa phải bằng chứng toàn corpus
hoặc cảm giác UI ngang Acrobat: default chỉ được đổi từ `current` sang `hybrid` sau khi chạy đủ
manifest shadow, P50/P95/RSS theo ba tier RAM và installed smoke. Lô 8 tuyệt đối chưa được bắt đầu
trước một release hybrid ổn định.
