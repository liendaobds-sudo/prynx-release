# BÁO CÁO AUDIT HIỆN TRẠNG VÀ KẾ HOẠCH PRYNX RENDER ENGINE

**Ngày:** 2026-08-08  
**Mốc source:** `89a9048d1d5eb71d64171e8c9195782da064d36a`  
**Branch:** `codex/pre-release-audit-2026-08-04`  
**Phạm vi:** mở PDF local, trang đầu, zoom/pan, tile sắc, thumbnail, cache, PDFium,
PPE/CMYK chính xác, cancellation, multi-tab, RAM gate và parity bản cài đặt.  
**Ngoài phạm vi:** không viết lại parser/rasterizer PDF; không sửa code engine trong giai đoạn audit.  
**Worktree lúc audit:** có 2 file Sticker đang sửa ngoài phạm vi; audit không chạm hai file này.

## 1. Kết luận điều hành

PrynX hiện không còn là một Viewer đơn giản. Source hiện tại đã có nhiều mảnh đúng của một
engine hiện đại: giữ ảnh cũ khi zoom, tile viewport ưu tiên 0, cache RAM/đĩa theo identity,
PNG lossless, progressive `display → accurate`, PPE/FOGRA39, RAM gate và print worker
out-of-process.

Tuy nhiên, các mảnh này đang phân tán giữa React, scheduler TypeScript, command Tauri,
PDFium trong process UI và endpoint PPE trong sidecar. Vì vậy PrynX hiện là:

> **một renderer in-process đã tối ưu khá sâu, nhưng chưa phải một Render Engine có quyền
> sở hữu thống nhất đối với request, priority, cancellation, worker, cache và compositor.**

Đề xuất kỹ thuật:

- **Không viết rasterizer PDF từ đầu.** Giữ PDFium làm backend hiển thị nhanh và PPE làm
  backend màu chính xác.
- Xây **PrynX Render Engine** ở tầng điều phối: request generation, foreground/prefetch
  priority, process worker, cancellation thật, cache theo document và compositor tile.
- Tái dùng pattern đã có của `print_worker`: spawn chính `PrynX.exe` với mode worker riêng.
  Như vậy mỗi process có PDFium riêng, không cần thêm binary mới và giảm rủi ro đóng gói.

Có **6 finding P1** và **5 finding P2**. Không có finding P0 đã xác nhận.

Một sự thật phát hành quan trọng: installer rc.4 hiện có được build từ commit `5dd08dd`,
trong khi source audit là `89a9048`. Riêng 8 file Viewer/render chính đã lệch **836 dòng thêm,
77 dòng bỏ**. Vì vậy các tối ưu Viewer ngày 07–08/08 chưa được phép coi là đã đến máy khách.

## 2. Phương pháp và mức bằng chứng

### Audit units

| Mã | Hành động người dùng → kết quả |
|---|---|
| `W7-U04-A` | Mở PDF local → trang đầu nhìn thấy |
| `W7-U04-B` | Ctrl+Wheel/nút zoom → vùng đang nhìn nét trở lại |
| `W7-U04-C` | Pan/scroll/rotate → tile sắc đúng vùng |
| `W7-U04-D` | Trang CMYK rủi ro → display nhanh rồi PPE đúng màu |
| `W7-U04-E` | Chuyển trang/tab/hủy → tác vụ cũ không chặn tác vụ mới |
| `W7-U04-F` | Mở nhiều tab/máy ít RAM → cache và PDFium không phình mất kiểm soát |
| `W7-U04-G` | Source hiện tại → installer khách hàng có đúng engine đó |

### Bằng chứng đã chạy

- Contract scanner self-test: **17/17 đạt**.
- Scanner source hiện tại: **1.225 file**, 0 lỗi đọc, 904 ứng viên; riêng rule
  `PDFIUM_THREAD_WITHOUT_GUARD = 0`. Scanner không thay thế trace xuyên file.
- Frontend Viewer mục tiêu: **5 file test, 46 test đạt**.
- Backend accurate/cache: **17 test đạt, 1 skip**.
- Tauri Rust library: **86 test đạt, 1 ignored**.
- Harness PPE `ink_unsound=true`: kết quả hiện tại vẫn là
  `accuracy=rip_softproof`, `warning=null`, có PNG.
- Harness cancel cache: sau khi waiter bị cancel, renderer vẫn chạy và ghi cache.
- Log runtime gần nhất có sẵn (05/08): tile thường khoảng `35–225 ms`; ca zoom nặng
  trang 2, zoom `4,4817` mất khoảng `835 ms`. Log này có trước các tối ưu 07/08 nên chỉ
  dùng làm baseline lịch sử, không gọi là số sau sửa.
- Artifact CMYK đã đo trước đó: HTTP accurate miss `2,8786 s`, disk hit `0,1296 s`;
  PPE khớp ảnh Acrobat ở MAE RGB `4,6632` trên đúng PDF khách.

**Mức bằng chứng:** `AUTO` cho scheduler/cache/contract; `ARTIFACT` cho PDF CMYK mẫu;
chưa đạt `RUNTIME` cho source `89a9048` trên bản Tauri đã cài.

## 3. Kiến trúc sống đã trace

### 3.1 Mở PDF native

```text
AcrobatViewer.tsx:289
  → usePdfLoader.ts:391 await get_pdf_metadata
  → src-tauri/lib.rs:1438 get_pdf_metadata
  → đọc toàn file + parse /UserUnit + color-risk
  → quét kích thước mọi trang tại lib.rs:1467-1489
  → usePdfLoader set numPages/pageOrder tại :447-488
  → markReady tại :530
  → LivePageFrame được mount và mới bắt đầu xin ảnh trang
```

Metadata hiện vừa là đường warm PDFium, vừa là gate bắt buộc trước ảnh đầu tiên.

### 3.2 Render display và zoom

```text
Ctrl+Wheel useViewerZoom.ts:270-316
  → zoom state gom bằng requestAnimationFrame
  → LivePageFrame nền full-page (debounce 250 ms)
  → TileLayer viewport (settle 90 ms)
  → useTileRenderer.ts
  → nativeTileRenderScheduler priority 0
  → invoke render_pdf_page
  → Tauri spawn_blocking
  → render_tile_png
  → RENDER_LOCK
  → PDFium render → PNG → RAM cache → disk cache → IPC → Blob URL
```

Scheduler chỉ mở một request vật lý. Đây là đúng khi PDFium còn nằm trong một process và
mọi render dùng `RENDER_LOCK`.

### 3.3 Accurate CMYK

```text
Rust color-risk detector
  → AcrobatViewer tự bật CMYK cho trang rủi ro
  → LiveTile display stage: PDFium PNG
  → accurate stage: POST /preflight/viewer-accurate
  → viewer_accurate_cache single-flight + disk cache
  → SoftProofEngine
  → pdfcompare_native.ppe_softproof
  → print_engine render full CropBox trong không gian mực
  → FOGRA39 → sRGB → PIL PNG → base64 → decode → HTTP PNG
```

Accurate mode cố ý tắt tile PDFium để không đổi hue theo từng mảng. Đây là quyết định đúng
về màu ở thời điểm hiện tại, nhưng làm zoom accurate phụ thuộc full-page PPE.

### 3.4 In PDF — pattern tốt đã có

`print_pdf_direct` không chạy PDFium lâu trong process UI. Nó gọi
`print_worker::run_isolated_print` và spawn chính `PrynX.exe --prynx-print-job ...`.
Vì vậy nghi vấn “lệnh in giữ RENDER_LOCK của Viewer” đã bị **bác bỏ**. Pattern self-spawn
này là bằng chứng Render Worker riêng khả thi mà không phải thêm executable mới.

## 4. Những gì đang làm tốt — phải giữ

1. `RENDER_LOCK` bảo vệ PDFium đúng; scanner không tìm thấy callable cùng-file thiếu guard.
2. Scheduler giữ slot cho tới khi native task thật sự kết thúc; cancel không vô tình mở
   thêm PDFium song song.
3. Tile viewport cuối vẫn đúng `zoom × DPR`, nền chỉ chống trắng và đã giảm settle xuống 90 ms.
4. PNG lossless loại banding/JPEG artifact; trên PDF audit encode còn nhanh hơn JPEG q90.
5. Cache native khóa theo path + size + mtime + ctime + render version + page/zoom/clip.
6. Accurate cache khóa đủ PDF/profile/DPI/intent và có atomic write + single-flight.
7. Máy `<8 GB`/`8–15 GB` đã giảm doc/tile/accurate concurrency; máy `≥16 GB` không bị
   hạ chất lượng hoặc hard-cap cache theo chính sách dự án.
8. Thumbnail đi chung scheduler ở priority 500; không chen trước trang chính.
9. Print đã out-of-process; driver/PDFium crash không kéo sập UI.
10. App nền không khởi động tile mới và resume đúng priority khi foreground.

## 5. Findings đã xác nhận

| Mã | Mức / effort | Finding |
|---|---|---|
| `§RENDER.1` | P1 / M | Mở file phải chờ metadata + detector toàn tài liệu trước trang đầu |
| `§RENDER.2` | P1 / L | PDFium Viewer cùng process chỉ có một lane và không cancellation vật lý |
| `§RENDER.3` | P1 / L | Accurate CMYK chỉ render full-page, chưa có accurate viewport tile |
| `§RENDER.4` | P1 correctness / S–M | PPE thiếu nội dung vẫn bị gắn `CMYK✓` và cache như accurate |
| `§RENDER.5` | P1 / M | Accurate prefetch/abandoned request không có priority và vẫn chạy sau cancel |
| `§RENDER.6` | P2 / M | Trang xoay không bao giờ dùng viewport tile sắc |
| `§RENDER.7` | P2 / M | Pan dùng một tile dễ bị thay toàn khối; scroll đo layout mỗi event |
| `§RENDER.8` | P2 / S–M | Mở PDF ở một tab xóa Blob cache của mọi tab |
| `§RENDER.9` | P2 / M | Page LRU cố định 24 trang/doc, không theo RAM/byte |
| `§RENDER.10` | P2 / S | Tile disk cache ghi không atomic và đọc mọi file không rỗng như PNG hợp lệ |
| `§RENDER.11` | P1 release / M | Source Viewer hiện tại chưa nằm trong installer rc.4 đã phát hành |

### `§RENDER.1` — `[CONFIRMED]` P1 — Cold-open bị chặn bởi metadata toàn tài liệu

**Đường sống:** `usePdfLoader.ts:391` await `get_pdf_metadata`; chỉ sau response mới
`setNumPages` ở `:449` và `markReady` ở `:530`. Tauri giữ lock rồi đọc kích thước mọi trang
tại `lib.rs:1446-1489`; trước đó `build_cached_document` còn đọc toàn bytes và parse
`/UserUnit` + color-risk.

**Bất biến bị thiếu:** first-page data phải đủ để hiển thị trang 1; metadata hỗn hợp và detector
toàn tài liệu có thể hoàn tất nền sau. Hiện hai việc bị ghép thành một gate.

**Ảnh hưởng:** càng nhiều trang/dictionary thì khoảng click → first pixel càng phụ thuộc công
việc không cần thiết cho trang đầu. Test 2.001 trang hiện chỉ bảo vệ đọc đủ kích thước, chưa đo
first-pixel latency.

### `§RENDER.2` — `[CONFIRMED]` P1 — Không có cancellation vật lý trong lane PDFium Viewer

- `tileRenderScheduler.ts` dùng `maxConcurrent=1` và chỉ reject Promise khi cancel.
- Test `tileRenderScheduler.test.ts:414-451` xác nhận task mới không chạy trước khi task cũ
  thật sự hoàn tất.
- Tauri không nhận `requestId/cancelToken`; `render_pdf_page` đi `spawn_blocking` rồi giữ
  `RENDER_LOCK` tại `lib.rs:1729-1737`.
- Mọi tab Viewer trong process UI chia sẻ lane này. Print không thuộc lane vì đã self-spawn.

Đây là hành vi an toàn nhưng là trần phản hồi: tile zoom cũ đã bắt đầu có thể chặn tile mới
đúng vùng tới khi PDFium trả về. Tăng semaphore/thread trong cùng process không giải quyết.

### `§RENDER.3` — `[CONFIRMED]` P1 — Accurate mode không có viewport render

- `shouldUseAccurateViewerRender()` chỉ nhận `!isTile`.
- `LivePageFrame.tsx:2882` tắt `needsTiling` khi `accurateColorPage`.
- `print_engine/page.rs:109-130` cấp buffer và chạy renderer theo toàn CropBox.
- Benchmark artifact: riêng PPE render mất `1,216–3,081 s` ở 36 DPI; HTTP miss tổng
  `2,8786 s`. Zoom cao làm số pixel full-page tăng theo bình phương cạnh.

Giữ full-page parity đã tránh seam màu, nhưng không thể đạt cảm giác Acrobat ở zoom/pan.
Đích đúng là PPE tile có clip cùng hệ tọa độ/profile, không bật lại PDFium tile trên nền PPE.

### `§RENDER.4` — `[CONFIRMED]` P1 correctness — `ink_unsound` bị mất ở Viewer

- Native trả `ink_unsound` (`native/src/print_engine_py.rs:287-318`).
- Facade nói rõ UI phải thông báo (`facade.py:438-440`).
- `_render_ppe_softproof()` chỉ log rồi trả `Image` (`softproof.py:278-288`), làm mất cờ.
- `render_softproof()` sau đó đặt `accuracy="rip_softproof"`, `warning=None`
  (`softproof.py:187-203`).
- Endpoint cache mọi kết quả có nhãn `rip_softproof` (`preflight.py:1576-1594`).

Harness bằng đúng venv đã ép `ink_unsound=true` và nhận:

```text
accuracy = rip_softproof
warning = null
has_softproof = true
```

Hậu quả: trang thiếu object/transparency có thể được hiển thị và cache dưới badge `CMYK✓`.
Đây là lỗi hợp đồng, cần sửa trước mọi tối ưu lớn.

### `§RENDER.5` — `[CONFIRMED]` P1 — PPE bỏ dở vẫn chạy, prefetch không có priority

- Frontend chỉ abort active request hiện tại; prefetch map chỉ abort khi hook unmount
  (`useTileRenderer.ts:89-94, 179-236`).
- Backend dùng `asyncio.shield(task)` (`viewer_accurate_cache.py:184`), nên disconnect/cancel
  waiter không dừng renderer.
- Máy `≥16 GB` trả `None` cho render gate (`:47-55`): các key khác nhau có thể cùng chạy.
- Harness xác nhận waiter bị cancel nhưng task vẫn sống và cuối cùng ghi cache.

Giữ render sau mất kết nối có lợi cho cache, nhưng active/prefetch/obsolete hiện không được
phân biệt. Chuyển trang/zoom nhanh có thể để các PPE key cũ cạnh tranh CPU/RAM với trang mới.

### `§RENDER.6` — `[CONFIRMED]` P2 — Trang xoay mất đường nét viewport

`LivePageFrame.tsx:2882` chỉ bật tiling khi rotation modulo 360 bằng 0. Trang 90/180/270°
ở zoom cao chỉ còn full-page bitmap bị cap rồi phóng CSS. Không có test viewport-tile cho
bốn góc xoay; test rotation hiện chỉ bảo vệ crop/edit/hotkey.

### `§RENDER.7` — `[CONFIRMED]` P2 — Compositor viewport còn mang tính “một ảnh thay thế”

- Mỗi scroll event gọi `getBoundingClientRect()` rồi tạo state object mới ngay
  (`LivePageFrame.tsx:599-625`), chưa gom rAF/chưa so clip snapped trước setState.
- Chỉ một tile được giữ; key phụ thuộc toàn clip (`:671-684`). Qua biên snap, tile cũ unmount
  và nền mờ lộ ra tới khi tile mới về.
- Tile tối đa `4000×4000`; viewport lớn hơn chỉ nét vùng giữa (`:654-664`).

Đây chưa phải tile pyramid/atlas kiểu một compositor độc lập. Quick-win là rAF + giữ tile cũ;
đích dài hạn là nhiều tile nhỏ có overlap và lifetime riêng.

### `§RENDER.8` — `[CONFIRMED]` P2 — Cache frontend không có ownership theo tab/document

`usePdfLoader.ts:192-200` gọi `clearTileUrlCache()` khi bất kỳ Viewer nạp file. Cache là
singleton toàn app, trong khi App giữ mọi tab mounted. `clearPrefix()` đã tồn tại nhưng Viewer
không dùng. Vì vậy mở file B làm tab A mất khả năng restore Blob nhanh sau khi suspend 20 giây.

### `§RENDER.9` — `[CONFIRMED]` P2 — Page LRU không thân thiện máy yếu

`PAGE_LRU_CAP=24` áp cho mọi `DocHandle` (`src-tauri/lib.rs:439-443`). Comment hiện tại ước
tính khoảng 384 MB/doc với file ảnh nặng. Doc cache có gate 2/4/unbounded, nhưng page decode
cache bên trong mỗi doc không giảm theo `<8 GB`/`<16 GB` và không tính byte.

### `§RENDER.10` — `[CONFIRMED]` P2 — Tile disk cache thiếu atomic/validation

- Đọc cache chỉ kiểm `bytes` không rỗng rồi đẩy vào RAM (`lib.rs:1581-1598`).
- Ghi dùng `std::fs::write` trực tiếp vào path đích (`:1759-1763`).

Crash/đứt nguồn hoặc hai request cùng key có thể để file dở; lần sau file không rỗng vẫn được
coi là hit. Accurate cache đã dùng temp + `os.replace` và kiểm PNG signature, nên có pattern
đúng để áp lại.

### `§RENDER.11` — `[CONFIRMED]` P1 release — Bản khách chưa chứa source Viewer mới

- `Ban_Phat_Hanh/release-manifest.txt`: rc.4 build từ commit `5dd08dd`, runtime verified 06/08.
- Source hiện tại: `89a9048`, ngày 08/08; version Tauri vẫn `1.0.0-rc.4`.
- Diff renderer chính giữa artifact và HEAD: 8 file, `+836/-77` dòng.

Không được dùng test/build source hiện tại để kết luận khách đang có màu/cache/zoom mới. Bản
phát hành tiếp theo phải bump version để cache Nuitka/updater/artifact không nhập nhằng rc.4.

## 6. Nghi vấn đã bác bỏ / hành vi chủ đích

| Trạng thái | Nội dung | Lý do |
|---|---|---|
| `[DISPROVED]` | In PDF giữ khóa Viewer suốt job | Print dùng process self-spawn riêng. |
| `[DISPROVED]` | Chỉ cần tăng `RENDER_SEMAPHORE`/thread PDFium | `RENDER_LOCK` vẫn serialize; tăng thread chỉ tạo thêm waiter/RAM. |
| `[EXPECTED]` | Scheduler `maxConcurrent=1` và doc pool 1 | Đúng trong kiến trúc một process; bỏ lúc này có nguy cơ crash. |
| `[EXPECTED]` | PNG lớn hơn JPEG | Đổi lấy lossless; artifact còn encode nhanh hơn JPEG q90. |
| `[EXPECTED]` | Full-page debounce 250 ms | Tránh render trung gian; viewport tile 90 ms mới là đường nét cuối. |
| `[EXPECTED]` | Backend `shield()` hoàn tất single-flight | Có ích cho cache; bug là thiếu interest/priority, không phải bản thân shield. |
| `[DISPROVED]` | Phải viết lại toàn bộ engine PDF | Không cần; coordinator/process/compositor mang lại phần lớn lợi ích với PDFium/PPE hiện có. |

## 7. Kiến trúc đích đề xuất

```text
React Viewer Compositor
  └── PrynX Render Coordinator
      ├── request generation / owner / purpose / priority
      ├── document-scoped RAM + disk cache
      ├── stale-interest tracking / cancellation / crash recovery
      └── Worker Manager
          ├── Interactive Display Worker (PDFium, process riêng)
          ├── Background Display Worker(s) (thumbnail/prefetch)
          ├── Accurate Worker (PPE/FOGRA39, full-page + viewport)
          └── Print Worker hiện có
```

### Contract request tối thiểu

```text
request_id, owner_id, generation, purpose(interactive|background|accurate)
document_identity(path,size,mtime,ctime), page, rotation
scale/dpi, clip(x,y,w,h), color_pipeline, profile, intent
```

Response phải có `request_id`, bitmap size, pipeline identity, cache tier, timing và
`soundness`. Response generation cũ bị bỏ trước decode/composite.

### Process strategy theo phần cứng

| RAM | Chính sách |
|---|---|
| `<8 GB` | 1 interactive worker; background chỉ chạy khi idle; PPE 1; page LRU giảm mạnh. |
| `8–15 GB` | 1 interactive + tối đa 1 background đang chạy; PPE 2; page LRU giảm nhẹ. |
| `≥16 GB` | Giữ chất lượng đầy đủ; worker nền co giãn theo nhu cầu/CPU, không hard-cap chất lượng; luôn bảo lưu lane interactive. |

Worker display nên là mode tự-spawn của cùng `PrynX.exe`, tương tự print worker. Khi request
interactive bị supersede và PDFium không tự dừng, coordinator có thể terminate worker lease
cũ rồi chuyển request mới sang worker khác; process UI không còn phải chờ render cũ.

## 8. Roadmap sửa sau khi duyệt

Mỗi lô tối đa 5 file và verify xong mới sang lô kế.

### Lô 1 — Khóa correctness accurate (`§RENDER.4`) — ưu tiên cao nhất

Tối đa 5 file:

1. Giữ `ink_unsound/degraded` xuyên `SoftProofEngine`.
2. PPE unsound phải fail-closed theo chính sách PPE-only; không gọi engine ngoài.
3. Giữ ảnh display, trả warning, không gắn `CMYK✓`, không ghi
   vào accurate cache.
4. Thêm regression đúng harness audit.

> **Đính chính 2026-08-08:** đề xuất thử Ghostscript ở bản audit ban đầu mâu thuẫn
> với contract no-GS cố định đã được khóa trong source/release. Lô triển khai dùng
> PPE-only và hạ nhãn khi PPE không đủ tin.

### Lô 2 — First-page fast path (`§RENDER.1`)

Tách metadata hai pha:

- pha A: identity + numPages + trang 1 + warm document → mount Viewer ngay;
- pha B nền: allDims + `/UserUnit` parity + color-risk toàn tài liệu;
- update mixed-size pages không làm reset zoom/scroll; generation cũ không được ghi state.

Giữ test PB6 trang 2.001; thêm đo `open → first page request`.

### Lô 3a — Viewport policy thuần và rAF (`§RENDER.6/7`)

- Tách mapping clip 0/90/180/270 thành hàm thuần có test.
- Gom scroll/resize bằng một rAF và chỉ setState khi clip snapped thật sự đổi.
- Bật tile sắc cho trang xoay sau khi artifact crop parity bốn góc đạt.

### Lô 3b — Giữ tile cũ và cache ownership (`§RENDER.7/8`)

- Giữ tile viewport trước cho tới khi tile mới decode xong.
- Namespace/ref-count cache theo document + tab owner.
- Mở file B không xóa cache A; release owner chỉ xóa đúng namespace.

### Lô 4 — Cache native an toàn và RAM tier (`§RENDER.9/10`)

- Page LRU: `<8 GB` giảm mạnh, `8–15 GB` giảm nhẹ, `≥16 GB` giữ 24/full như hiện tại.
- Theo dõi available-memory pressure để đóng page inactive an toàn, không hạ máy mạnh khi
  còn dư RAM.
- Tile disk write temp + atomic replace; đọc kiểm PNG signature/dimensions trước RAM cache.

### Lô 5 — Render Coordinator contract, chưa đổi backend

- Gom request key/group/priority/generation/purpose vào module riêng có test.
- Giữ native in-process phía dưới để chứng minh parity; thêm timing
  `queue/wait/render/encode/decode/stale_ms`.
- Chốt baseline P50/P95 trước khi chuyển process.

### Lô 6a — Display worker self-spawn prototype (`§RENDER.2`)

- Thêm `--prynx-render-worker` vào `main.rs` theo pattern print worker.
- Worker dài hạn đọc protocol framed binary, giữ PDFium/doc/page cache trong process riêng.
- Parent crash-detect, timeout, restart; path validation và pipeline identity bắt buộc.
- Feature flag cho phép fallback về in-process renderer hiện tại.

### Lô 6b — Interactive lane và cancellation thật

- Dành riêng một worker/lease cho request priority 0.
- Supersede: bỏ queue cũ; nếu render cũ đã chạy, chuyển request mới sang worker khác hoặc
  terminate lease cũ theo policy RAM.
- Thumbnail/prefetch không được chiếm interactive lane.
- Máy mạnh dùng pool co giãn; máy yếu chỉ giảm background, không giảm chất lượng cuối.

### Lô 7a — PPE viewport core (`§RENDER.3/5`)

- Thêm region/clip vào `print_engine::render_page_managed`: buffer chỉ bằng viewport + pad,
  device matrix dịch đúng CropBox/rotation.
- Pixel oracle: `accurate_tile == crop(accurate_full_page)` ở overlap, sai số 0 cho PNG.
- Soundness và ICC/profile identity phải giống full-page.

### Lô 7b — Accurate scheduler/cache/compositor

- Cache accurate tile theo DPI bucket + clip snap + profile/intent/pipeline version.
- Foreground/prefetch interest-count; request obsolete chưa chạy phải bị loại.
- Full-page accurate nhẹ làm nền; tile accurate phủ đúng viewport, không seam/hue jump.

### Lô 8 — Release rollout

- Bump version khỏi rc.4; build từ git clean commit.
- Verify manifest commit/hash chứa đúng Render Engine.
- Installed smoke: PDFium worker, crash/restart, accurate PPE, multi-tab, rotate, minimize,
  print song song, clean-user và CSP/resource path.
- Rollout feature flag; log chỉ bật khi opt-in, có đường fallback engine cũ trong một release.

## 9. Ma trận nghiệm thu bắt buộc

### Corpus

1. RGB vector/text nhỏ.
2. Scan/photo nặng.
3. `CMNM2026 - Giay moi_BLUE - in.pdf`.
4. DeviceN/spot + transparency, có và không OutputIntent.
5. Trang 0/90/180/270°.
6. `/UserUnit=2`, CropBox lệch MediaBox.
7. PDF mixed-size và PDF >2.000 trang.
8. PDF lỗi/encrypted/cancel giữa chừng.

### Kịch bản đo

- cold/warm open; first pixel; first sharp;
- Ctrl+Wheel `100→800→100%`, nút +/- và nhập %;
- pan ngang/dọc liên tục; chuyển trang nhanh; quay lại cache;
- hai tab cùng zoom; tab nền suspend/resume;
- accurate on/off; PPE miss/hit; đổi DPI bucket;
- worker crash và request supersede;
- minimize/restore; print trong lúc Viewer tương tác;
- dev, release no-bundle và installer clean-user.

### Chỉ số/gate

- `open → first visible`, `zoom-stop → sharp`, `pan → sharp`: P50/P95, không chỉ cảm giác.
- Cache hit ratio và `stale_render_ms`.
- Peak RSS theo process và toàn app; không swap/OOM ở tier thấp.
- Máy `≥16 GB`: không chậm >10% trên cùng corpus so baseline và không hạ DPI/PNG/màu.
- Accurate artifact: MAE RGB không xấu hơn baseline `≤5`; tile/full-page pixel parity.
- Không output `ink_unsound` nào được gắn `CMYK✓` hoặc ghi accurate cache.
- Không white flash, không hue seam, trang xoay nét cùng mức trang 0°.
- Source test: typecheck + Viewer Vitest + backend cache/màu + Rust Tauri + print_engine.
- Artifact: manifest commit đúng, version mới, runtime installed đạt.

## 10. Chốt duyệt

Báo cáo này dừng ở chốt audit. Chưa sửa engine/render/build. Nếu được duyệt, thứ tự đề nghị là:

1. **Lô 1 correctness `ink_unsound`**.
2. **Lô 2 first-page fast path**.
3. **Lô 3–4 quick-win viewport/cache/RAM**.
4. **Lô 5–6 Render Coordinator + display worker self-spawn**.
5. **Lô 7 accurate viewport**.
6. **Lô 8 build/installed rollout**.

Không gộp tất cả vào một đại refactor. Mỗi lô phải có baseline, test hẹp, artifact nếu liên
quan màu/toạ độ và runtime app thật trước khi sang lô tiếp theo.
