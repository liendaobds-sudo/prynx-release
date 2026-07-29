# BÁO CÁO AUDIT — ĐỘ NÉT HIỂN THỊ TRANG & TỐC ĐỘ LÀM NÉT KHI ZOOM

**Ngày:** 2026-07-28
**Triệu chứng user báo:** "zoom lên làm nét khá chậm, độ nét không được như Acrobat".
**Phạm vi:** đường hiển thị trang PDF của viewer — `desktop/src/components/workspace/LivePageFrame.tsx`, `desktop/src/hooks/viewer/useTileRenderer.ts`, `desktop/src/hooks/viewer/useViewerZoom.ts`, `desktop/src/components/acrobat/ThumbSidebar.tsx`, `desktop/src-tauri/src/lib.rs` (`render_tile_jpeg` + protocol `tile`).
**Ngoài phạm vi:** in, xuất ảnh, canvas khuôn bế, so sánh PDF.
**Tài liệu đã đọc trước khi kết luận:** `docs/BAO_CAO_AUDIT_HIEU_NANG_2026-07-26.md`, `docs/PERF_FIXES_2026-07-26.md`, `.agents/skills/prynx-performance/SKILL.md`, và toàn bộ comment tag `audit render 2026-07-06` / `audit tốc độ 2026-07-06` trong các file trên.

---

## 1. Tóm tắt điều hành

Kiến trúc hiện tại **đã đúng ý tưởng**: nền một tile phủ cả trang (không bao giờ trắng) + một tile sắc phủ đúng vùng đang nhìn ở `zoom × dpr` (map 1:1 pixel, nét như Acrobat). Vấn đề nằm ở ba chỗ cụ thể, không phải ở ý tưởng.

**Vì sao CHẬM.** Khi zoom, không chỉ một tile được xin. Virtuoso giữ ~9 trang mounted, và `LiveTile` nền **gọi `_loadTile()` đồng bộ ngay trong effect, cố tình bỏ qua IntersectionObserver** (`LivePageFrame.tsx:299-306`) — nên **cả 9 trang đều xin render nền ở `renderZoom` hiện tại**, dù người dùng chỉ nhìn 1 trang. Ở zoom cao mỗi bản nền đó có cạnh dài tới **6000px**. Toàn bộ PDFium trong app render **tuần tự sau một `Mutex` toàn cục** (`lib.rs:298` `RENDER_LOCK`, `get_doc_pool_size() → 1`). Kết quả: cái tile sắc mà mắt đang soi phải xếp hàng sau tới 8 bản render vô ích. `needsTiling` đã được gate `isActiveFrame` để chống đúng vấn đề này (`:2604-2606`), nhưng **tile nền thì chưa được gate**.

**Vì sao KHÔNG NÉT.** Nền full-page **không map 1:1 pixel**: Rust tạo bitmap rộng `(width_pt × render_scale) as i32` — cắt phần thập phân (`lib.rs:684`), còn CSS đặt `cssW = Math.ceil(displayWidth)` (`:2616`) và thẻ `<img>` dùng `objectFit:'fill'; width:100%; height:100%` (`:330-333`). Lệch ≤1px là đủ để browser resample bilinear **toàn bộ trang** → chữ mềm ở **mọi mức zoom**, không riêng zoom cao. Tile sắc thì làm đúng (`cssW = clipW / dpr`, `:409-425`) — đó là lý do "khi nó nét thì nét, mà phải chờ".

**Một nghi vấn ngược chiều trực giác.** `use_lcd_text_rendering(true)` được bật cho **cả hai** nhánh render (`lib.rs:655-659, 686-689`) với chú thích "chữ sắc nét kiểu Acrobat". Nhưng LCD subpixel AA chỉ đúng khi bitmap map **1:1 lên panel RGB-stripe**. Bitmap này bị (a) nén JPEG q90, (b) browser resample (xem trên). Qua hai bước đó, viền màu subpixel thành nhiễu màu quanh chữ — mắt đọc ra "rỗ/mờ", không phải "nét hơn". Cần A/B đo bằng ảnh chụp trước khi kết luận, nên tôi để nó ở mức cần-xác-minh chứ không khẳng định.

Tổng: **11 phát hiện** — 3 P1, 5 P2, 3 P3. Không có phát hiện nào trùng với 2 đợt audit trước.

---

## 2. Bảng phát hiện

### Nhóm A — Tốc độ làm nét (P1)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §R.1 | **~9 trang mounted đều render nền ở zoom cao, xếp hàng trước tile sắc.** `(el as any)._loadTile?.()` gọi thẳng trong effect, bỏ qua IntersectionObserver (chủ đích, để chống màn trắng khi WebView2 bị occluded). Tile nền **không** gate `isActiveFrame`, `zoom={S}` với `S = renderZoom` bám theo zoom tới trần 6000px cạnh dài. Mọi render serialize sau `RENDER_LOCK` | `LivePageFrame.tsx:299-306` (gọi đồng bộ) · `:2616-2618` (nền không gate) vs `:2604-2606` (`needsTiling` CÓ gate `isActiveFrame`) · `:1046-1053` (renderZoom bám zoom, debounce 250ms) · `:53` (cap 6000) · `lib.rs:298, 694-697` (RENDER_LOCK) · `lib.rs:664-690` (max_dim 8000) | **P1** | M |
| §R.2 | **Toàn app render PDFium tuần tự, và lý do ghi trong code đã lạc hậu.** `get_doc_pool_size() → 1` với chú thích "*tile rendering is fast enough (10ms)*"; nhưng chính comment ở LivePageFrame đo được **~160ms/render** và encode ~59ms. Thumbnail sidebar + nền + tile sắc + đường in tranh nhau một khoá | `lib.rs:24-28` (pool 1 + lý do) · `lib.rs:298` · `LivePageFrame.tsx:356-359` ("278 render/phiên, mỗi cái ~160ms tuần tự") · `lib.rs:712-716` (encode ~59ms) · `RENDER_SEMAPHORE`/`TILE_SEMAPHORE` = 4 chỉ chặn thread, không tạo song song thật (`lib.rs:767-769`, `:2054-2056`) | **P1** | L |
| §R.3 | **Không có cơ chế huỷ tile lỗi thời.** `processTileQueue` — có sẵn hàng đợi ưu tiên theo khoảng cách tới trang active, huỷ item khi `|item.zoom − currentZoom| > 0.05`, concurrency 4 — **không được đường tile native dùng**: `getTileUrl` gọi `invoke('render_pdf_page')` trực tiếp. Nên tile của zoom cũ vẫn giữ lượt `RENDER_LOCK` | `useTileRenderer.ts:24-61` (hàng đợi, không ai gọi) vs `:63-99` (đường thật, invoke trực tiếp) | **P1** | S |

### Nhóm B — Độ nét (P1/P2)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §R.4 | **Nền full-page không map 1:1 pixel → resample bilinear cả trang ở MỌI zoom.** Bitmap: `(width_pt * render_scale).max(1.0) as i32` (cắt thập phân) + `set_target_width(safe_w)`. CSS: `cssW={Math.ceil(displayWidth)}`, `cssH={Math.ceil(...)}`, `<img style="width:100%;height:100%;objectFit:'fill'">`. Lệch ≤1px mỗi chiều → tỉ lệ scale ≠ 1 → chữ mềm. So sánh: tile sắc làm ĐÚNG `cssW = clipW / dpr` với `clipW` chính là số px `set_fixed_size` | `lib.rs:681-690` · `LivePageFrame.tsx:2616` · `:330-333` · đối chiếu `:409-425` | **P1** | S |
| §R.5 | **LCD subpixel AA bật trên bitmap sẽ bị nén JPEG và bị resample.** LCD AA chỉ đúng khi 1:1 trên panel RGB-stripe; qua JPEG q90 + resample của browser thì thành nhiễu màu quanh chữ. Cần A/B ảnh chụp: giữ LCD cho tile sắc (1:1) vs tắt LCD (grayscale AA) cho nền bị scale | `lib.rs:655-659` (nhánh clip) · `lib.rs:686-689` (nhánh full-page) · `lib.rs:700` (`to_rgba8`) · `lib.rs:717-721` (JPEG q90) | **P2**<br>(cần đo) | S |
| §R.6 | **Tile sắc — nơi mắt soi chữ — cũng chỉ được JPEG q90.** Cùng tham số với nền. Tile sắc mỗi nấc zoom chỉ có 1 bản, kích thước chặn ≤4000px, nên nâng q hoặc dùng PNG cho riêng nó rất rẻ. Acrobat không nén mất dữ liệu chút nào | `lib.rs:717-721` (một encoder duy nhất cho cả 2 nhánh) · `lib.rs:648-662` (nhánh clip ≤4000px) | P2 | S |
| §R.7 | **Thumbnail sidebar không nhân `devicePixelRatio`** → trên màn Windows scale 125/150%, thumbnail render 1× rồi bị phóng → mờ rõ. Đường render trang chính thì có dpr | `ThumbSidebar.tsx:72` (`optimalZoom = max(0.1, min(1.5, thumbBaseWidth*1.3/baseW))`) · `:106-110` (invoke không có dpr) · đối chiếu `LivePageFrame.tsx:48-50` | P2 | S |
| §R.8 | **Trong lúc zoom, tile sắc bị ẩn HOÀN TOÀN** (`if (zoomSettling \|\| !visRect) return null`) nên người dùng nhìn đúng bản mờ suốt thời gian chuyển. Chủ đích (chống chớp trắng/lệch khung) nhưng là nguyên nhân trực tiếp của cảm giác "mờ rồi mới nét" | `LivePageFrame.tsx:398-406` | P2 | M |

### Nhóm C — Cài đặt chết & nợ kỹ thuật (P2/P3)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §R.9 | **`previewQuality` ('high' \| 'fast') là cài đặt CHẾT.** Có UI radio trong Cài đặt, có mô tả "*Giảm chất lượng render để xem trước PDF hàng ngàn trang siêu mượt*", nhưng **không nơi nào trong đường render đọc nó**. User đổi và không có gì xảy ra | `appSettingsStore.ts:110, 145, 166` (khai báo/default/setter) · `SettingsModal.tsx:31, 258-278` (chỉ UI) · grep toàn `desktop/src`: không có consumer khác | P2 | S |
| §R.10 | **Nhánh coarse→sharp trong `LiveTile` không bao giờ chạy** — `coarseZoom` không được truyền ở bất kỳ call-site nào (`:2618` nền, `:411-424` tile sắc). Mất sẵn cơ chế "hiện ảnh thô ngay rồi nét sau" đã viết xong | `LivePageFrame.tsx:290-296` (nhánh) · `:2618`, `:411-424` (call-site không truyền) | P3 | S |
| §R.11 | **`computeRenderZoomPure` export "cho PREFETCH" nhưng không có prefetch nào gọi** (grep toàn `desktop/src`: chỉ dùng trong chính file đó). Kéo theo việc làm tròn `zoom` 3 chữ số trong cache key Rust — thêm vào để prefetch và view chính trùng key — đang bảo vệ một tình huống không tồn tại | `LivePageFrame.tsx:44-47, 1046` · `lib.rs:527-533` | P3 | S |
| §R.12 | Sàn `Math.max(dpr, …)` áp **sau** `Math.min` nên khi `capByBudget < dpr` (khổ rất lớn, vd 1000×1400mm trên màn 150%), `renderZoom = dpr` **phá trần ngân sách 6000px** — bitmap cạnh dài ~7900px, chỉ còn `max_dim=8000` của Rust chặn | `LivePageFrame.tsx:48-55` · `lib.rs:664-668` | P3 | S |

---

## 3. Đã kiểm tra chéo — KHÔNG phải lỗi

Ghi lại để lần sau không "sửa" oan:

- **`capByBudget` tính đúng cho cả trang dọc và ngang.** Tôi nghi `ratio = Math.max(1, h/w)` làm trang ngang được cấp bitmap quá lớn, nhưng tính lại thì cả hai hướng đều cho **cạnh dài đúng 6000px**: dọc `w100·ratio·cap = 6000`; ngang `ratio = 1` nên `w100·cap = 6000`. Không sửa.
- **`Semaphore(4)` không phải nút thắt.** Nút thắt là `RENDER_LOCK` (§R.2); nâng semaphore lên chỉ làm nhiều thread cùng chờ một khoá.
- **Dùng 1 tile phủ viewport thay vì lưới N ô là chủ đích và đúng** — PDFium duyệt display-list cả trang cho mỗi lần render, lưới N ô = chậm tuyến tính theo N (`LivePageFrame.tsx:342-348`).
- **KHÔNG clamp cận trên `render_scale` là chủ đích và đúng** — `clip_x/y` do FE tính ở scale thật, clamp sẽ làm `translate` trỏ sai vùng (`lib.rs:637-643`).
- **Bỏ CSS transform preview khi zoom là chủ đích** — từng gây scrollbar nhấp nháy và giật lúc commit (`useViewerZoom.ts:294-298`).
- **Hạ JPEG q98 → q90 là chủ đích** (encode nhanh ~40%). Tôi không đề xuất quay lại q98 cho nền; chỉ đề xuất tách tham số riêng cho tile sắc (§R.6).
- **Không revoke blob URL khi unmount là chủ đích** (re-mount tức thì, `:307-316`); RAM đã chặn bằng `TILE_CACHE_MAX = 200` + dọn theo file khi đóng tab.

---

## 4. Cần ĐO trước khi sửa

Skill `prynx-performance` bắt buộc có số trước/sau. App đã có sẵn đường log, chỉ cần bật:

1. Chạy `run_dev.bat` (debug build → `perf_enabled()` tự bật, `lib.rs:326-333`). Bản release thì đặt `PRYNX_PERF=1`.
2. Mở một PDF nhiều chữ (bìa sách/catalog), zoom **100% → 400% → 800%** bằng Ctrl+lăn, mỗi mức chờ nét hẳn.
3. Gửi tôi file **`PrynX_RenderPerf.log`** trên Desktop (`lib.rs:1710-1711`). Mỗi dòng có `kind=tile|page zoom= wh= lock_wait_ms= render_ms= encode_ms= total_ms=` — chính `lock_wait_ms` sẽ chứng minh hay bác bỏ §R.1/§R.2, và số dòng `kind=page` sẽ cho biết bao nhiêu bản nền vô ích được render mỗi lần zoom.
4. Thêm ảnh chụp màn hình vùng chữ ở 400%: một của PrynX, một của Acrobat cùng file cùng zoom — để đối chiếu §R.4/§R.5 bằng mắt trên cùng điều kiện.

Nếu bạn muốn bỏ qua bước đo và sửa luôn theo suy luận, tôi làm được — nhưng §R.5 (LCD text) thì tôi **không** sửa mà không có ảnh A/B, vì nó có thể làm chữ tệ hơn.

---

## 5. Đề xuất thứ tự sửa theo lô (≤5 file/lô)

**Lô 1 — bỏ công render vô ích (§R.1, §R.3).** `LivePageFrame.tsx`, `useTileRenderer.ts`.
Trang **không** active: đóng băng nền ở mức thấp (vd `min(renderZoom, 2 × dpr)`) thay vì bám zoom — nó chỉ là ảnh chờ khi cuộn tới. Trang active khi `needsTiling` đã bật: nền cũng không cần bám zoom vì tile sắc đã phủ vùng nhìn. Nối `getTileUrl` vào `processTileQueue` sẵn có để lấy cơ chế huỷ theo zoom.
Kỳ vọng: số render mỗi lần zoom giảm từ ~9 xuống 1-2; `lock_wait_ms` của tile sắc giảm mạnh. **Đây là quick-win lớn nhất.**

**Lô 2 — nét 1:1 (§R.4, §R.12).** `LivePageFrame.tsx`, `lib.rs`.
Cho nhánh full-page dùng đúng số pixel FE yêu cầu (như nhánh clip đang làm) và FE đặt CSS width/height theo đúng bitmap px / dpr. Chuyển sàn `dpr` vào trong `Math.min` để không phá trần ngân sách.
Kỳ vọng: chữ nét lên ngay ở 100% và mọi mức zoom, **không tốn thêm thời gian render**.

**Lô 3 — chất lượng tile sắc (§R.6) + A/B LCD (§R.5).** `lib.rs`.
Tách tham số encode: nền q90 giữ nguyên, tile sắc q96-98 (hoặc PNG). Đổi `RENDER_VER` để vô hiệu cache cũ. §R.5 chỉ làm sau khi có ảnh A/B.

**Lô 4 — thumbnail HiDPI (§R.7) + dọn cài đặt chết (§R.9).** `ThumbSidebar.tsx`, `appSettingsStore.ts`, `SettingsModal.tsx`, 2 file locale.
Nhân dpr cho `optimalZoom` (giữ trần theo px thật, không theo hệ số). `previewQuality`: **nối thật** vào `computeRenderZoomPure` ('fast' hạ trần ngân sách 6000 → 3000) hoặc **bỏ khỏi UI** — bạn chọn; tôi nghiêng về nối thật vì máy yếu thực sự cần.

**Lô 5 — giảm cảm giác chờ (§R.8, §R.10).** `LivePageFrame.tsx`.
Bật lại nhánh coarse→sharp (truyền `coarseZoom` = mức nền hiện có) để có ảnh thô ngay; xem lại việc ẩn hoàn toàn tile sắc lúc zoom — có thể giữ tile cũ và chỉ dịch/scale bằng `transform` cho đúng vị trí thay vì `return null`.

**Lô 6 — song song hoá render (§R.2).** `lib.rs`. Việc lớn, làm riêng.
PDFium global state không thread-safe → không thể chỉ bỏ `RENDER_LOCK`. Hướng khả thi: tách render sang **tiến trình con** (mỗi process một PDFium riêng), hoặc dùng bản PDFium build kèm khoá per-document. Cần đo mới biết có đáng: nếu Lô 1 đã cắt 8/9 render vô ích thì hàng đợi tuần tự có thể đủ nhanh và **không nên** làm Lô 6.

---

## 6. Phát hiện thêm (ngoài phạm vi, chỉ ghi nhận)

- `useTileRenderer.ts:100-126` — fallback pdf.js canvas cho file không có `path` encode JPEG q0.9 cứng, không theo cấu hình nào.
- Chú thích `LivePageFrame.tsx:662` khẳng định "*pdfium + prefetch trang lân cận + page LRU đã đủ nhanh*", nhưng "prefetch" ở đây thực chất là hệ quả phụ của việc Virtuoso mount sẵn ~9 trang — tức chính cơ chế gây §R.1. Sửa §R.1 thì nên cập nhật lại chú thích này cho khỏi gây hiểu sai về sau.
- Protocol `tile` (`lib.rs:2048`) vẫn đăng ký và chạy song song với đường IPC, nhưng `useTileRenderer.ts:70-73` ghi rõ ở release protocol này **không hiển thị được** nên đã chuyển hết sang `invoke`. Nếu xác nhận không còn ai dùng thì gỡ được cả một đường code + một semaphore.

---

**Trạng thái: ĐÃ DUYỆT — Lô 1 (§R.1) và Lô 2 (§R.4) đã áp** (không đo trước, theo yêu cầu). Chi tiết
thay đổi, hai mục lệch khỏi kế hoạch (§R.12 và §R.3 — cố tình KHÔNG làm, có lý do) và checklist kiểm
tay: `docs/RENDER_FIXES_2026-07-28.md`. Các lô 3-6 vẫn chờ.
