# BÁO CÁO AUDIT HIỆU NĂNG — PrynX

**Ngày:** 26/07/2026
**Phạm vi:** Toàn bộ dự án — Backend Python (FastAPI/OpenCV/pypdfium2), Desktop (Tauri v2 + React 19), Rust native (`pdfcompare_native`, `imposition_core`, `print_engine`, host `src-tauri`), pipeline build production.
**Mục tiêu:** Tăng tốc độ xử lý + thân thiện phần cứng (giảm RAM/CPU nền để chạy tốt trên máy văn phòng yếu, đồng thời tận dụng đa nhân khi xử lý nặng).
**Phương pháp:** Phân tích tĩnh 170 file nguồn trọng yếu (~5,5MB code) qua 3 nhánh audit song song; mọi phát hiện mức HIGH đã được **xác minh trực tiếp lại trong code** (đối chiếu file:dòng, trích dẫn nguyên văn). Chưa đo runtime trên máy thật — mức tác động là ước lượng theo độ phức tạp thuật toán và kích thước dữ liệu; nên profiling xác nhận trước các thay đổi lớn (mục 7).

> Ký hiệu: **[HIGH/MED/LOW]** = mức tác động ước lượng · **(S/M/L)** = công sức sửa (Small < 1 buổi, Medium 1–3 ngày, Large > 3 ngày) · ✔ = đã xác minh trực tiếp trong code.

---

## 1. TÓM TẮT ĐIỀU HÀNH

Codebase có nền tảng tốt: nhiều phần nặng đã offload sang Rust, đã có cache nhiều tầng, StickerEngine đã có hardware profile theo RAM. Tuy nhiên có **5 nhóm vấn đề hệ thống** đang kéo cả tốc độ lẫn mức chiếm dụng phần cứng:

**① Event loop backend bị chặn (nghiêm trọng nhất về "cảm giác đứng hình").** 19 endpoint `async def` chạy công việc CPU/I-O nặng ngay trên event loop (render 300 DPI, OCR, Ghostscript, ProcessPool khởi tạo, pikepdf save). Khi 1 request nặng chạy, **toàn bộ backend tê liệt**: preview không trả, poll tiến độ treo, WebSocket im lặng → người dùng tưởng app crash. Đây là lỗi rẻ nhất để sửa (bọc `asyncio.to_thread`) với hiệu quả cảm nhận lớn nhất.

**② Chi phí spawn tiến trình trên Windows + Nuitka bị đánh giá thấp.** Mỗi process con = re-launch nguyên PrynX.exe (import lại numpy/cv2/pikepdf — nhiều giây + hàng trăm MB). Preflight tạo ProcessPool **mỗi request**; N-Up spawn 2 tầng process **mỗi job**; OCR spawn 1 tesseract.exe **mỗi trang**; sidecar đóng gói `--onefile` giải nén hàng trăm MB ra temp **mỗi lần mở app** (và app tự thoát nếu sidecar không lên trong 5 giây — máy yếu có nguy cơ không mở nổi).

**③ Rust build không có cấu hình release.** Cả 4 crate **không có `[profile.release]`** → không LTO, codegen-units=16, không strip, không target-cpu. Module native còn **re-init PDFium + parse lại toàn bộ PDF mỗi lần gọi** và **giữ GIL suốt lúc render** (làm backend Python đứng hình theo). `print_engine` (tách kẽm/TAC) hoàn toàn đơn luồng dù từng pixel độc lập.

**④ RAM không có trần ở nhiều điểm.** `DOC_CACHE` phía Tauri chỉ insert, không bao giờ evict (mỗi doc giữ nguyên file bytes + LRU 24 trang ≈ trần 384MB/doc); TileCache bound theo số lượng chứ không theo byte; multipage TIFF export gom mọi trang vào RAM; sidebar 1000 thumbnail không ảo hóa; mọi tab mở đều mounted vĩnh viễn.

**⑤ Re-render dây chuyền phía UI.** Mọi tab luôn mounted (chỉ che bằng `opacity-0`) + shell truyền lambda inline cho mọi tab + 6 vị trí subscribe cả store không selector + kéo resize panel ghi store global từng mousemove → một thay đổi nhỏ ở shell re-render đồng loạt các cây component 100–243KB.

**Ước lượng tổng thể nếu làm hết Đợt 1 + Đợt 2 (mục 6):** thời gian mở app giảm rõ rệt (bỏ giải nén onefile + bỏ splash 3s cưỡng bức), backend không còn "đứng hình" khi chạy job nặng, tách kẽm/TAC nhanh hơn nhiều lần trên máy đa nhân, RAM nền giảm đáng kể khi mở nhiều file, UI mượt hơn hẳn trên máy iGPU.

---

## 2. QUICK WINS — LÀM NGAY TUẦN ĐẦU (impact cao, effort nhỏ)

| # | Việc | Vị trí | Tác động | Effort |
|---|------|--------|----------|--------|
| 1 | Thêm `[profile.release]`: `lto = "thin"` (thử `"fat"`), `codegen-units = 1`, `strip = "symbols"`, giữ `panic = "unwind"` | `desktop/src-tauri/Cargo.toml`, `native/Cargo.toml` | +5–20% mọi đường CPU-bound Rust | S |
| 2 | Set `RUSTFLAGS="-C target-cpu=x86-64-v2"` trong build production | `build_production.ps1` | Bật SSE4/AVX baseline cho vòng per-pixel | S |
| 3 | native: PDFium `OnceLock` (bỏ re-init mỗi call) + `py.detach` cho 6 hàm PDFium (kèm mutex riêng) | `native/src/*.rs` | Bỏ N lần LoadLibrary+parse; backend hết đứng hình khi render | S–M |
| 4 | Bọc `asyncio.to_thread` cho 19 endpoint blocking (danh sách mục 3.1) | `backend/app/api/routes/*` | Backend luôn phản hồi khi có job nặng | S/endpoint |
| 5 | `list_objects_from_session` dùng `session.live_bytes` thay vì save lại cả PDF | `core/edit_session.py:247` | Mở panel/đổi trang editor nhanh hơn nhiều lần với file lớn | S |
| 6 | Tab ẩn: `display:none` (hoặc `content-visibility:hidden`) thay `opacity-0` | `desktop/src/App.tsx:1193` | Giảm RAM + bỏ re-render/decode tab nền | S |
| 7 | App.tsx subscribe store bằng selector; sửa 6 vị trí subscribe cả store | `App.tsx:150,234`, `ImposerDashboard.tsx:120`, … | Cắt re-render dây chuyền | S |
| 8 | Kéo resize panel: width local/ref, chỉ commit store lúc mouseup | `HomeTab.tsx:214`, `ImpositionTab.tsx:1118` | Hết giật khi kéo panel | S |
| 9 | Bỏ 3 giây splash cưỡng bức (`SPLASH_MIN_MS=3000` → kết thúc khi sẵn sàng) | `App.tsx:147` | Mở app nhanh hơn ~2s trên mọi máy | S |
| 10 | `get_pdf_metadata` (Tauri) dùng `pages().page_size(i)` thay vì load từng trang | `src-tauri/src/lib.rs:459` | Mở file nghìn trang từ nhiều giây → tức thì | S |
| 11 | Gỡ `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` | `tauri.conf.json:26` | App minimize không còn ăn CPU full-speed | S (test M) |
| 12 | `pdf_processor.render_page`: dùng `bitmap.to_numpy()` zero-copy, bỏ PIL convert | `core/pdf_processor.py:354` | Bỏ 2/3 bản copy ~26MB mỗi trang trong pipeline compare | S |

---

## 3. PHẦN A — BACKEND PYTHON (FastAPI sidecar)

### 3.1 ✔ [HIGH] 19 endpoint `async def` chạy blocking inline — chặn event loop

Đã xác minh từng endpoint: `upload_pdf` (quét metadata + màu 50 trang inline — `upload.py:124`), `unlock_pdf` (flatten mọi trang + save — `imposition.py:146`), `quick_color_space` (pikepdf quét 50 trang, **thiếu `pdf.close()` ở nhánh return sớm** — `imposition.py:343`), `get_pdf_layers`, `preview_pdf_layers`, `get_pdf_text`, `get_pdf_meta`, `inspect_pdf`/`inspect_uploaded_pdf` (`preflight.py:258`), `get_page_svg` ×2, `get_page_objects`, `flatten_layers` (GS subprocess tới 120s — `preflight.py:883`), `qc/extract-text` (OCR từng trang 300 DPI — `qc.py:92`), `export/images` (`export.py:155`), `vdp/preview` (`vdp.py:934`), `sticker-dieline` (**job nặng nhất app chạy thẳng trong handler**, kèm semaphore blocking — `pdf_tools.py:1182+`), `edit/objects` (`edit.py:938`), `edit/text-props`.

**Hệ quả:** 1 job nặng → mọi request khác (poll status, preview, health) treo → UI "đứng hình" toàn app.
**Sửa:** Bọc `await asyncio.to_thread(...)` (pattern đã có sẵn trong codebase — pdf_tools merge/split/ocr, edit ops, softproof đã làm đúng). Với `sticker-dieline`, đưa cả `_sticker_job_slot` acquire vào trong thread. **(S mỗi endpoint — làm cuốn chiếu theo danh sách trên)**

### 3.2 ✔ [HIGH] Preflight tạo `ProcessPoolExecutor` mỗi request — `core/preflight_engine.py:215`

`with ProcessPoolExecutor(max_workers=...)` trong `engine.run()` → mỗi lần inspect = spawn `min(cpu-1, chunks, 8)` tiến trình Nuitka mới (re-launch exe, import numpy/cv2 — nhiều giây khởi động trước khi làm việc).
**Sửa:** Pool module-level lazy, tái dùng giữa các request, đóng theo idle-TTL. **(M)**

### 3.3 ✔ [HIGH] QC extract-text: mở lại PDF mỗi trang + OCR tuần tự 1 tesseract.exe/trang — `qc.py:92-110`, `ocr_engine.py:203`

`extract_text_blocks(file_path, p)` mở lại pdfplumber **mỗi trang**; OCR fallback render 300 DPI + spawn tesseract **từng trang, tuần tự, trên 1 nhân**. PDF scan 50 trang = treo nhiều phút.
**Sửa:** Mở pdfplumber/PdfDocument 1 lần ngoài vòng lặp; chia trang cho ProcessPool có sẵn (theo hardware profile); cân nhắc 1 lần tesseract với multi-page TIFF. **(M)**

### 3.4 ✔ [HIGH] Export ảnh: render tuần tự trong event loop; multipage TIFF gom mọi trang vào RAM — `export.py:93-155`

DPI cho phép tới 1200; 100 trang A4@300DPI ≈ 2,6GB RAM khi xuất TIFF nhiều trang (`frames.append(img)` giữ hết).
**Sửa:** to_thread + ghi từng trang (tifffile append qua đĩa); render song song 2–3 trang; cân nhắc hạ trần DPI export theo RAM máy. **(M)**

### 3.5 ✔ [HIGH] VDP preview: parse lại cả nguồn dữ liệu (xlsx/csv tới 100k dòng) + canonicalize template mỗi lần bấm Next — `vdp.py:934,973`

**Sửa:** Cache `RecordTable` theo hash nguồn + template đã canonicalize theo (path, mtime); offload render. **(M)**

### 3.6 ✔ [HIGH] So sánh bình bài: `cv2.matchTemplate` ở full 300 DPI × 4 góc xoay (miss thì ×12 scale) — `image_comparator.py:749-791`

Pipeline đã định vị tờ ở 48 DPI trước đó nhưng bước full-DPI **tìm lại từ đầu**. Mảng kết quả matchTemplate float32 gần bằng cỡ tờ mỗi lượt.
**Sửa:** Dò vị trí ở ≤100 DPI rồi scale tọa độ, chỉ pixel-diff từng instance ở DPI thật. **(M–L)**

### 3.7 ✔ [HIGH] Compare thường: vòng "hunt" render trang B full-DPI lặp — `comparison_engine.py:354-356`

Xấu nhất O(n²) lần render 300 DPI (~26MB/lần).
**Sửa:** Hunt bằng fingerprint/thumbnail 36–48 DPI (hạ tầng đã có ở nhánh căn trang), chỉ render full-DPI trang khớp. **(M)**

### 3.8 ✔ [HIGH] Toggle layer: save **cả tài liệu** mỗi lần preview + trả JPEG base64 trong JSON — `layer_engine.py:948`, caller `imposition.py:462`

Đã tối ưu qua BytesIO (tránh đĩa) nhưng vẫn serialize toàn bộ PDF (file 200MB → 200MB+ mỗi toggle).
**Sửa:** Dựng PDF tạm chỉ chứa trang cần render (pikepdf copy 1 trang + OCProperties); trả bytes JPEG trực tiếp (`Response`) thay base64; to_thread. **(M)**

### 3.9 ✔ [MED] Editor: undo/redo replay save cả file mỗi op — `edit_session.py:1727-1730`; panel object save cả file dù đã có `live_bytes` — `edit_session.py:247`

Undo sau 20 op trên file 100MB ≈ 2GB serialize. `list_objects_from_session` bỏ qua `session.live_bytes` có sẵn (chỗ khác đã dùng đúng).
**Sửa:** Ring-buffer `post_bytes` K op gần nhất (undo O(1)); dùng `live_bytes` (1 dòng). **(S+M)**

### 3.10 [MED] `/edit/objects` mở cùng file pikepdf 3 lần/request — `edit.py:938,952,970` **(S)**

### 3.11 [MED] Separations: không cache kết quả GS tiffsep; quét spot ink O(N trang) mỗi lần xem 1 trang — `separations.py:392-399,540`

Trái ngược `viewer_preview` đã có cache đĩa chuẩn. Lật qua lại 2 trang = chạy lại Ghostscript từ đầu.
**Sửa:** Cache spot-scan theo (path,mtime); cache plates trên đĩa theo (path,mtime,page,dpi,profile), giới hạn dung lượng như viewer cache. **(M)**

### 3.12 ✔ [MED] `render_page` copy 3 lần mỗi trang (bitmap→PIL→convert→np.array) — `pdf_processor.py:354-356`; `render_page_cmyk` render trang lần 2 + convert CMYK naive — `:366`, caller `comparison_engine.py:341`

@300DPI ≈ 26MB ×3 transient/trang, nhân đôi ở mode CMYK.
**Sửa:** `bitmap.to_numpy()` zero-copy (+stride); suy CMYK patch từ ảnh RGB tại vùng diff thay vì render riêng. **(S+M)**

### 3.13 [MED] Phase correlation trên float32 full-resolution — `image_comparator.py:573` → downscale ≤1024px rồi scale shift. **(S)**

### 3.14 [MED] Pool N-Up/VDP/Preflight tính theo CPU, không biết RAM — `nup_engine.py:3158`, `vdp_engine.py:1101`, `preflight_engine.py:212`

Máy 8 nhân/8GB → 7 process Nuitka con → swap đúng trên máy yếu. StickerEngine **đã có** `_auto_sticker_hw_profile` (RAM<8GB→ít worker + chia `threads_per_worker` chống oversubscription BLAS/cv2).
**Sửa:** Dùng chung hardware profile đó cho N-Up/VDP/Preflight. **(S–M)**

### 3.15 [MED] N-Up: 2 tầng spawn process mỗi job (`multiprocessing.Process` → `ProcessPoolExecutor` tạo mới) — `imposition.py:1153`, `nup_engine.py:3274`

Job nhỏ trả phí khởi động nhiều giây. **Sửa:** Warm pool tái dùng (idle-TTL); job nhỏ chạy in-thread. **(M–L, đánh đổi isolation)**

### 3.16 [MED] Ảnh highlight bình bài copy 2 lần cỡ nguyên tờ (~200MB+ @B2 300DPI) — `image_comparator.py:822,969` **(S)**

### 3.17 [MED] `_cluster_regions` gộp vùng O(n²)–O(n³) khi trang nhiễu — `image_comparator.py:1003` → dilate + connectedComponents. **(M)**

### 3.18 [MED] OCR make_searchable: spawn/trang + chèn text từng từ — `ocr_engine.py:203,239` **(M)**

### 3.19 [LOW] Nhóm phát hiện nhỏ

`_fingerprints` mở lại document mỗi trang + `PdfDocument` không `close()` (`comparison_engine.py:254`, `pdf_processor.py:44`); WS poll query SQLite sync trên event loop mỗi 1.5s + send cả khi data không đổi (`ws.py:88` ✔); commit SQLite mỗi trang trong compare — 50 fsync/50 trang (`comparison_engine.py:417,510` → batch + WAL); `get_pdf_text` trả 1 dict/ký tự trong JSON (`imposition.py:509`); poll N-Up đọc 2 file temp mỗi nhịp (`imposition.py:1363` → check mtime); RustBridge fallback ghi cả tài liệu ra temp file (`rust_bridge.py:317` → BytesIO); `np.unique(axis=0)` trên pixel nguyên trang trong channel_remover — chỉ tối ưu nếu profiling xác nhận (`channel_remover.py:1239`).

---

## 4. PHẦN B — DESKTOP (React 19 + Tauri v2)

### 4.1 ✔ [HIGH] Mọi tab luôn mounted, tab ẩn chỉ che `opacity-0` — `App.tsx:1189-1193`

Mỗi tab = cả cây viewer + tile img + thumbnail + dashboard sống mãi; `opacity-0` vẫn giữ layout/decode, effect + listener vẫn chạy (code phải tự vá bằng `closest('.opacity-0')` trong `useViewerZoom.ts:225`). 4–5 file lớn mở cùng lúc → RAM WebView phình hàng trăm MB, mọi re-render nhân theo số tab.
**Sửa:** `display:none`/`content-visibility:hidden` ngay (S); về sau: "ngủ đông" — tab nền quá N phút thì unmount viewer, giữ state trong store per-tab (đã có sẵn) để dựng lại. **(S → M)**

### 4.2 ✔ [HIGH] Shell truyền lambda inline cho mọi ToolComponent → 1 setState re-render TẤT CẢ tab — `App.tsx:1209-1224`

`onTitleChange={(title) => updateTabTitle(tab.id, title)}` tạo mới mỗi render, tool không memo.
**Sửa:** Bọc nội dung tab trong `React.memo` + handler ổn định theo `tabId` (map `useCallback`); tách tab-bar khỏi vùng viewport. **(M)**

### 4.3 ✔ [HIGH] Kéo resize panel ghi store global mỗi mousemove — `HomeTab.tsx:214`, `ImpositionTab.tsx:1118` + `App.tsx:234` subscribe cả store

Mỗi pixel kéo → appSettingsStore đổi → App re-render → (4.2) mọi tab re-render.
**Sửa:** Width local/ref khi kéo, commit store lúc mouseup (pattern đã có ở `useThumbSidebar.ts:311`); App.tsx dùng selector. **(S)**

### 4.4 ✔ [HIGH] `ImposerDashboard` (101KB) subscribe toàn bộ imposer settings store — `ImposerDashboard.tsx:120` (`const s = useImposerSettingsStore();`)

Bug class này đã được chính codebase ghi nhận và fix cho `ImpositionTab` (comment tại `ImpositionTab.tsx:196` mô tả "đơ ~3-4s lúc mở") nhưng **bỏ sót ImposerDashboard**: mỗi ký tự gõ vào settings → cả dashboard (chứa GridPreview + Section 118KB) re-render.
**Sửa:** Selector `useShallow` theo nhóm field (mẫu đã có ở `AdvancedSettingsSection.tsx:67`). Cùng lỗi còn 4 chỗ: `App.tsx:150` (authStore), `App.tsx:234`, `AcrobatViewer.tsx:146`, `ImpositionTab.tsx:218`, `GridSettingsSection.tsx:49`. **(S–M)**

### 4.5 ✔ [HIGH] CombineTab: mỗi thẻ trang 1 `<Document>` pdf.js riêng — N lần parse cùng 1 file — `CombineTab.tsx:95-97`

Xổ file 100 trang = 100 `getDocument` + 100 `PDFDocumentProxy` trong RAM, không `destroy()`, lưới thẻ không ảo hóa. Đếm số trang bằng cách đọc **cả file** vào ArrayBuffer + parse pdf-lib main thread (`CombineTab.tsx:221` — file 300MB = 300MB RAM + đơ vài giây) trong khi đã có `invoke('get_pdf_metadata')` Rust.
**Sửa:** 1 Document/file dùng chung (cache theo path) hoặc thumbnail qua IPC như `ThumbSidebar`; virtualization khi >100 thẻ; đếm trang bằng IPC metadata. **(M)**

### 4.6 ✔ [HIGH] pdf.js document không bao giờ `destroy()` ở đường in-memory/web — `usePdfLoader.ts:329-331`

Đổi file/unmount chỉ set `cancelled=true` — doc cũ (worker memory + ArrayBuffer) giữ RAM chờ GC; load xong sau khi cancelled thì lơ lửng vĩnh viễn.
**Sửa:** Giữ doc trong ref, `void doc.destroy()` trong cleanup và nhánh cancelled. **(S)**

### 4.7 ✔ [HIGH] OutputPreviewTab: inflate + vòng per-pixel + toDataURL trên main thread; TAC heatmap tính lại mỗi tick slider — `OutputPreviewTab.tsx:53-73,115-149,527`

Trang A3@150dpi × 6 kẽm ≈ 40–50 triệu phép tính + PNG encode mỗi lần kéo slider → đơ hàng trăm ms.
**Sửa:** Debounce slider ~150ms; chuyển reconstruct + TAC sang Web Worker (transfer `Uint8ClampedArray`); trả `ImageBitmap`/blob URL thay dataURL base64. **(M)**

### 4.8 ✔ [MED] Tắt toàn bộ throttling nền WebView2 — `tauri.conf.json:26`

`--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` → app minimize vẫn chạy timer/poll/animation full-speed. Bug trắng-màn-occluded đã được vá riêng (`LivePageFrame.tsx:300`) nên có cơ sở gỡ dần.
**Sửa:** Gỡ flags (giữ lại tối đa `CalculateNativeWinOcclusion` nếu cần), test lại case minimize/occluded. **(S, test M)**

### 4.9 ✔ [MED] Splash bắt buộc tối thiểu 3 giây — `App.tsx:147` → kết thúc khi `!isChecking` + warmup xong (hoặc hạ 800–1200ms). **(S)**

### 4.10 [MED] LivePageFrame (243KB, ~40 hook) không memo; nhận prop mảng/object mới mỗi render — `LivePageFrame.tsx:596`, `AcrobatViewer.tsx:1307` (`highlightBoxes?.filter(...)`), `editSession` object literal mới mỗi render (comment thừa nhận tại `AcrobatViewer.tsx:264`)

**Sửa:** `React.memo` comparator theo primitive; `editSession` qua ref/context ổn định; memo map highlight theo trang. **(M)**

### 4.11 [MED] ThumbSidebar: tới 1000 thumbnail DOM không virtualization, blob giữ vĩnh viễn khi đã hiện — `ThumbSidebar.tsx:446,352` → VirtuosoGrid (dep đã có) hoặc unload-khi-xa. **(M)**

### 4.12 [MED] Mỗi tab gắn `wheel` listener `window` với `passive:false, capture:true` — `useViewerZoom.ts:320` → 1 listener toàn cục dispatch theo tab active. **(S)**

### 4.13 [MED] Solver hình học chạy main thread — `NupGridSolver.ts:1018` (fallback impose local), `nestingEngine.ts:1141` (dieline nesting) → bọc Web Worker (pure function, pattern worker đã có ở `plateInfoWorker`). **(M)**

### 4.14 [MED] Backdrop blur 20–24px phủ nhiều bề mặt — `index.css:86,134` + ~60 chỗ `backdrop-blur` — rất đắt trên iGPU → giảm 8–10px, bỏ blur ở modal fullscreen, hoặc setting "hiệu ứng thấp". **(S)**

### 4.15 [MED] TileLayer: mỗi trang ở zoom cao đọc `getBoundingClientRect` + setState theo từng scroll event — `LivePageFrame.tsx:379-395` → gom bằng rAF hoặc 1 scroll observer cấp viewer. **(S)**

### 4.16 [LOW] Nhóm phát hiện nhỏ

Heartbeat license set state → App (subscribe cả authStore) re-render toàn cây, amplifier khi bị khóa license 30s/lần (`useAuthStore.ts:535` + `App.tsx:150`); poll job 500ms cố định không backoff, chạy cả khi cửa sổ ẩn (`api.ts:495`, `processHandlers.ts:233`); edit-session giữ chồng overlay base64 PNG tới khi commit (`useEditSession.ts:44` → giới hạn lớp + blob URL); undo history giữ nguyên bytes cho file không path — 12 bản × file lớn (`ImpositionTab.tsx:676` → budget theo byte); `nativeTextBlocks` tích lũy không giới hạn theo trang đã xem (`AcrobatViewer.tsx:348` → LRU ~30 trang); objectURL không revoke ở `ImageThumbnail` web branch (`CombineTab.tsx:111`); `transition: all` đại trà trong CSS (`index.css:99,...` → liệt kê property cụ thể); SheetViewerDialog render ô blueprint scale 1.0 cho ô ~120px — decode lớn gấp ~6 lần cần (`SheetViewerDialog.tsx:183` → scale theo width ô); keydown listener shell re-subscribe mỗi khi mảng tabs đổi (`App.tsx:453,863` → đọc qua `tabsRef`); modal quit dựng bằng IIFE mỗi render (`App.tsx:1279`).

---

## 5. PHẦN C — RUST NATIVE + BUILD PIPELINE

### 5.1 ✔ [HIGH] Cả 4 crate không có `[profile.release]` — `desktop/src-tauri/Cargo.toml`, `native/Cargo.toml` (2 crate lá quyết định profile)

Ship với mặc định: `lto=false, codegen-units=16, strip=none`. Code per-pixel print_engine, wrapper pdfium-render, codec image mất inlining chéo crate.
**Sửa (2 crate lá):**
```toml
[profile.release]
lto = "thin"          # thử "fat" nếu build time chấp nhận được
codegen-units = 1
strip = "symbols"
# GIỮ panic = "unwind": app dựa vào catch_unwind/spawn_blocking; PyO3 cần unwind
```
Kỳ vọng 5–20% phần CPU-bound. **(S)**

### 5.2 ✔ [HIGH] native re-init PDFium + parse lại toàn bộ PDF mỗi call — `render.rs:9,111`, `objects.rs:8`, `layers.rs:9,24`, `redact.rs:8`

Mỗi hàm: LoadLibrary("pdfium.dll") + `FPDF_InitLibrary` + parse cả document → drop → `FPDF_DestroyLibrary` (mất luôn font/glyph cache). Duyệt N trang từ Python = N lần init + N lần parse.
**Sửa:** `static PDFIUM: OnceLock<Pdfium>` (mẫu có sẵn: `src-tauri/lib.rs:213 ensure_pdfium`) + cache document theo (path, mtime) hoặc API batch nhiều trang. **(S–M)**

### 5.3 ✔ [HIGH] 6 hàm PDFium của native giữ GIL suốt lúc render — thiếu `py.detach` ở `render_page_image`, `render_page_svg`, `enumerate_page_objects`, `delete_page_objects`, `get_ocg_layers`, `set_ocg_visibility` (đối chiếu: PPE/dieline/image_compare đã detach đúng)

Backend gọi qua executor thread nhưng thread giữ GIL hàng trăm ms → **event loop Python đứng hình theo**.
**Sửa:** Bọc phần PDFium trong `py.detach`; vì GIL không còn là khóa, PHẢI thêm mutex riêng hoặc bật feature `thread_safe` của pdfium-render trong `native/Cargo.toml` (hiện KHÔNG bật — khác desktop). Làm cùng lúc với 5.2. **(S–M)**

### 5.4 ✔ [HIGH] Nuitka `--onefile`: giải nén hàng trăm MB ra temp mỗi lần mở app — `build_production.ps1:426`

Payload cv2/numpy/scipy/skimage/onnxruntime/PIL/shapely giải nén mỗi launch (CPU + I/O, tệ trên HDD/antivirus). Nguy hiểm kép: app chỉ chờ health **5 giây** rồi `exit(1)` (`src-tauri/lib.rs:102`) → máy yếu có nguy cơ **không mở nổi app**.
**Sửa:** Bỏ `--onefile`, ship thư mục `--standalone` qua Tauri resources; hoặc tối thiểu `--onefile-tempdir-spec="{CACHE_DIR}\prynx\{VERSION}"` để cache giải nén; đồng thời nâng trần chờ health (10–20s hoặc retry có thông báo). **(M)**

### 5.5 ✔ [HIGH] `DOC_CACHE` (Tauri) không bao giờ evict — `lib.rs:181`, insert tại `:420,:582`, **0 chỗ remove** (đã xác minh)

Mỗi doc giữ nguyên file bytes + LRU 24 trang decode (~384MB trần/doc theo chính comment `:150`). Mở nhiều file trong phiên → RAM tăng vô hạn → swap trên máy 8GB.
**Sửa:** Lệnh `close_pdf_document` gọi khi FE đóng tab + LRU cap 2–3 doc + cân nhắc `load_pdf_from_file` (PDFium đọc từ đĩa thay vì giữ cả file trong RAM). **(S–M)**

### 5.6 ✔ [HIGH] `print_engine` hoàn toàn đơn luồng — không có rayon trong Cargo.toml; vòng full-frame `for i in 0..self.alpha.len()` tại `ink.rs:1240,1309` (+ `composite_region:692`, `finalize_rgb:610`, `tac_percent:1392`, `plate_u8:1412`)

Trần 80MP × (4+spot) kênh chạy 1 nhân — tách kẽm/TAC giây-cấp trong khi máy đa nhân ngồi không.
**Sửa:** rayon `par_chunks_mut` theo hàng (pixel độc lập), song song theo kênh cho plate/TAC; cấu hình num_threads theo hardware profile để thân thiện máy yếu. **(M — lợi ~n_cores)**

### 5.7 ✔ [MED] Không set `target-cpu` — `build_production.ps1` (0 chỗ RUSTFLAGS, đã xác minh)

Baseline x86-64 SSE2 — vòng f32 per-pixel không được SSE4/AVX.
**Sửa:** `RUSTFLAGS="-C target-cpu=x86-64-v2"` (an toàn máy ~2010+); cân nhắc v3 + fallback hoặc `multiversion` cho kernel nóng ink.rs. **(S)**

### 5.8 [MED] Lệnh Tauri sync chạy trên main thread → freeze UI — `diecut.rs:7` (`strip_diecut_lines` parse + save cả PDF), `lib.rs:1087` (`read_system_file` đọc cả file trăm MB), `write_batch_pdf`, `copy_batch_pdf`, `write_file_atomic`, `read_dir_json`, `detect_design_apps` → chuyển `async fn` + `spawn_blocking` (mẫu có sẵn `render_pdf_page`). **(S)**

### 5.9 [MED] `detect_design_apps` spawn PowerShell tuần tự ~4 lần (0.5–2s/lần, lại là lệnh sync) — `external_app.rs:34` → đọc registry trực tiếp (crate `windows`). **(S)**

### 5.10 [MED] 3 lệnh Tauri NHẬN `Vec<u8>` lớn qua JSON IPC — `write_batch_pdf` (`lib.rs:1049`), `write_file_atomic` (`:1135`), `normalize_image_bytes` (`:1310`) — bytes bị serialize thành mảng số JSON (chiều trả về thì đã đúng qua `ipc::Response`); chính comment tại `copy_file_atomic` thừa nhận đường cũ nổ "RangeError" với file lớn → nhận `tauri::ipc::Request` raw body hoặc handoff qua file tạm. **(M)**

### 5.11 ✔ [MED] `get_pdf_metadata` load từng page object (`FPDF_LoadPage`) tới 2000 trang chỉ để đọc kích thước — `lib.rs:459` — trong khi `pages().page_size(i)` (không load trang) đã được dùng ở `print.rs:1635`; lại chạy dưới `handle.lock` → đổi 1 dòng. **(S)**

### 5.12 [MED] Nhóm phát hiện Tauri render/cache

Giữ mutex `DOC_CACHE` trong lúc đọc file + parse (chặn mọi tile khác — `lib.rs:400,565` → double-checked insert); TileCache bound theo số (500 entry × tile tới vài MB = trần vài trăm MB) + `queue.retain` O(n) mỗi get + clone cả JPEG mỗi hit (`lib.rs:541,271-281` → bound theo byte 64–128MB, `Arc<Vec<u8>>`); `render_tile_jpeg` 2–3 bản copy full-frame mỗi tile, một phần dưới khóa, `fs::write` disk cache nằm trong mutex (`lib.rs:709,736` → `into_rgba8()`, dời write ra ngoài lock); print job fallback giữ `RENDER_LOCK` suốt mọi tờ — viewer không render nổi tile khi đang in (`print.rs:724` → nhả theo tờ); poster in `FPDF_LoadPage` lại từng tile — 6×6 = 36 lần (`print.rs:951` → hoist); mỗi thao tác probe máy in spawn nguyên PrynX.exe mới (`print_worker.rs:279` → worker sống lâu qua pipe, giữ isolation cho lệnh in thật).

### 5.13 [MED] PPE mở + parse lại PDF mỗi trang (`print_engine_py.rs:134` — quét TAC N trang = N lần lopdf parse cả file → cache Document theo (path,mtime) hoặc API batch); `finalize_rgb` gọi CMM từng pixel thay vì batch (`ink.rs:615` — chiều ngược đã batch tại `:1442`); dispatch per-pixel nặng trong `composite_rgb_region` (`ink.rs:770` → hoist + slice theo hàng cho autovectorize); transparency group cấp phát + copy buffer full-page mỗi group (`ink.rs:1075` → buffer theo bbox — L); `nfp.rs` đã bỏ rayon khi port + alloc polygon mỗi bước binary-search (`nfp.rs:2,42` → par_iter theo dy + translate-in-place). **(S–L tùy mục)**

### 5.14 [LOW] `get_ocg_layers` native là placeholder trả rỗng nhưng vẫn init PDFium + parse cả file (`layers.rs:8-13` → return sớm, 1 dòng); `render_svg` tự chế base64 nối chuỗi từng ký tự dù crate `base64` đã có trong deps (`render.rs:145` → `STANDARD.encode` + `write!`); `max_tac_percent` cấp phát Vec cả trang chỉ để lấy max (`ink.rs:1403` → fold trực tiếp); Nuitka ép `/O1` cho toàn bộ C sinh ra kể cả module nóng (`build_production.ps1:421` — workaround có chủ đích cho lỗi heap MSVC; khi có thời gian: chỉ hạ /O1 cho module từng fail). **(S)**

---

## 6. NHỮNG GÌ ĐÃ TỐT — GIỮ NGUYÊN, ĐỪNG PHÁ

Backend: viewer preview có cache đĩa theo (path,size,mtime) + thumbnail batch 8 trang/1 GS + prune 512MB/7 ngày + below-normal priority; detect cache + dedup in-flight + budget GS fallback; StickerEngine có hardware profile RAM+CPU (1–6 worker, chia threads_per_worker chống oversubscription) — **đây là hình mẫu nên nhân rộng**; SSIM/GIF cap 1200px, compare guard 50 trang/40MP; TTL purge jobs + cleanup loop; lazy import cv2.

Desktop: Virtuoso cho viewer chính; IntersectionObserver cho thumbnail; tile LRU coarse→sharp + debounce zoom 180ms; revoke blob + dọn tile cache khi đóng tab; undo history strip bytes khi file có path; upload theo path tránh materialize; manualChunks (vendor-react/pdf/three) + budget entry 1.5MB + warmup pdf.js sau splash; three.js chỉ nạp trong dieline (lazy); GridPreview debounce 250ms + AbortController + stale-while-revalidate; texture 3D có dispose; frameloop demand.

Rust/Tauri: trả binary qua `tauri::ipc::Response` (không base64); `spawn_blocking` + semaphore 4 cho render tile; Page-LRU tái dùng trang decode (đo 600→120ms); print worker out-of-process chống crash driver; `py.detach` ở PPE/dieline/image_compare; image_compare dùng rayon + numpy zero-copy; print_engine có memory budget chia sẻ + trần raster 80MP + f32 planar + Region-based skip.

---

## 7. LỘ TRÌNH ĐỀ XUẤT

**Đợt 1 — Quick wins (≈1 tuần):** 12 mục ở bảng mục 2. Không đổi kiến trúc, rủi ro thấp, cảm nhận rõ: app mở nhanh hơn, backend hết đứng hình, editor/panel nhanh hơn với file lớn, UI hết giật khi kéo panel, RAM tab nền giảm.

**Đợt 2 — Cấu trúc nhỏ (≈2–3 tuần):** hợp nhất hardware profile cho mọi pool (3.14); warm ProcessPool preflight/N-Up (3.2, 3.15); cache separations + VDP (3.11, 3.5); DOC_CACHE eviction + TileCache theo byte (5.5, 5.12); rayon cho print_engine (5.6); Web Worker cho OutputPreviewTab + solver (4.7, 4.13); CombineTab 1 Document/file + virtualization (4.5); bỏ --onefile (5.4); memo LivePageFrame + tab React.memo (4.2, 4.10).

**Đợt 3 — Thuật toán (chọn lọc theo profiling):** compare hunt bằng fingerprint (3.7); matchTemplate ở DPI thấp (3.6); toggle layer render 1 trang (3.8); undo ring-buffer (3.9); transparency group theo bbox (5.13); tab ngủ đông (4.1).

**Đo lường trước/sau:** dự án đã có `core/perf_sampler.py` và `utils/preview_perf_log.py` — tận dụng làm baseline. Đề xuất bộ benchmark cố định từ `private_test_corpus/`: (a) mở app → sẵn sàng, (b) mở file 500 trang → thấy trang 1, (c) compare 2 file 50 trang @300DPI, (d) N-Up 32 tờ, (e) tách kẽm 1 trang ink-accurate, (f) RAM sau khi mở/đóng 5 file lớn. Chạy trên 2 máy: 1 máy dev mạnh + 1 máy văn phòng 8GB — đúng với mục tiêu "thân thiện phần cứng".

**Gợi ý thứ tự an toàn:** mỗi thay đổi Đợt 1 là 1 commit riêng, chạy lại test suite có sẵn (backend `tests/` khá dày — test PBT/E2E cho impose/edit/sticker) trước khi gộp.

---

*Báo cáo được tạo bởi audit tĩnh 3 nhánh song song + vòng xác minh chéo trực tiếp trong mã nguồn. Các con số % là ước lượng — nên xác nhận bằng benchmark ở mục 7 trước và sau mỗi đợt.*
