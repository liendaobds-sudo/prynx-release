# NHẬT KÝ SỬA HIỆU NĂNG — 26/07/2026

Thực hiện theo `docs/BAO_CAO_AUDIT_HIEU_NANG_2026-07-26.md`. **42 file đã sửa** (mỗi chỗ sửa có comment `PERF (audit 2026-07 §x.y)` ngay trong code để truy ngược). Python đã qua `py_compile`, TS/TSX đã qua parse-check (0 lỗi cú pháp), TOML/JSON đã validate. **Rust chưa compile được trong môi trường sửa** (registry bị chặn) — xem mục "Việc bạn cần làm" bên dưới.

---

## A. ĐÃ SỬA — BACKEND PYTHON (18 file)

**Hết chặn event loop (§3.1–3.5, 3.8, 3.10):** 19 endpoint blocking đã bọc `run_in_threadpool` / `run_scheduled_in_threadpool` (dùng đúng heavy_job_scheduler có sẵn): `upload` (metadata), `unlock-pdf`, `quick-color-space` (+ sửa RÒ `pdf.close()` ở nhánh return sớm), `pdf-layers`, `pdf-layers/preview`, `pdf-text`, `pdf-meta`, `preflight/inspect` ×2, `page-svg` ×2 (gộp thành 1 helper chung), `preflight/objects`, `flatten-layers`, `qc/extract-text`, `export/images`, `vdp/preview`, `sticker-dieline` (cả acquire slot), `edit/objects`, `edit/text-props`. → Backend luôn phản hồi khi có job nặng.

**Giảm chi phí process/pool (§3.2, 3.14):** Preflight dùng **ProcessPool chia sẻ tái sử dụng** (không còn tạo/hủy mỗi request; tự reset khi pool hỏng); N-Up/VDP/Preflight worker **cap theo hardware profile RAM+CPU** của StickerEngine (máy 8GB không còn spawn cpu−1 process Nuitka; env `PRYNX_NUP_WORKERS` vẫn ghi đè được).

**Cache mới (§3.5, 3.11):** VDP `RecordTable` cache theo hash nội dung csv/xlsx (bấm Next không parse lại 100k dòng; gsheet không cache — dữ liệu mạng); Separations cache **kết quả tách kẽm** theo (path, mtime, trang, dpi, profile, engine-flags) trần 6 entry + cache spot-scan trần 16 → lật qua lại 2 trang không chạy lại GS/PPE.

**Giảm copy/RAM (§3.4, 3.9, 3.12, 3.13, 3.19):** `render_page` dùng `bitmap.to_numpy()` — 3 bản copy/trang → 1; TIFF nhiều trang ghi từng trang qua `AppendingTiffWriter` (100 trang: ~2,6GB RAM → ~1 trang); `list_objects_from_session` tái dùng `live_bytes` (không save cả PDF mỗi lần mở panel); `phaseCorrelate` dò trên bản ≤1024px rồi scale shift; `PdfDocument.close()` trong finally ở `convert_to_images`/`convert_to_cmyk_images`; qc extract mở pdfplumber **1 lần** cho mọi trang (`extract_text_blocks_all`); WS poll query off-loop + chỉ send khi data đổi; compare commit SQLite theo batch 5 trang; nup-status chỉ đọc file temp khi mtime đổi.

**An toàn luồng PDFium (đi kèm §5.3):** thêm `PDFIUM_PY_LOCK` trong `rust_bridge.py` — serialize mọi thao tác PDFium giữa native module (nay đã nhả GIL) và pypdfium2 (`pdf_processor`, export, page-svg đều dùng chung khóa). PDFium không thread-safe; trước đây GIL vô tình làm khóa.

## B. ĐÃ SỬA — DESKTOP (12 file)

- **§4.1** Tab ẩn thêm `[content-visibility:hidden]` (bỏ render + decode subtree, giữ `opacity-0` để guard cũ vẫn chạy) — *cần test nhanh: chuyển tab qua lại, cuộn thumbnail sau khi quay lại tab*.
- **§4.2** Toàn bộ khối render tab tách thành `TabPane` **React.memo** + handler ổn định; `handleOpenApp` đọc tabs qua ref → deps `[]` (hết churn effect theo mảng tabs — cũng fix §4.16-keydown). 1 setState ở shell không còn re-render mọi tab.
- **§4.3** HomeTab kéo resize: width cục bộ khi kéo, commit store 1 lần lúc mouseup.
- **§4.4** Selector `useShallow` cho 5 vị trí subscribe cả store: `App.tsx` (authStore + appSettings), `AcrobatViewer`, `ImpositionTab`, `GridSettingsSection`.
- **§4.5** CombineTab: đếm trang qua IPC `get_pdf_metadata` (hết đọc cả file vào RAM + parse pdf-lib main thread); revoke objectURL ở ImageThumbnail.
- **§4.6** `usePdfLoader`: `doc.destroy()` khi đổi file/unmount + nhánh cancelled.
- **§4.7** TAC heatmap debounce 150ms theo slider.
- **§4.8** Gỡ 3 flag tắt throttling nền WebView2 (giữ `CalculateNativeWinOcclusion` disable) — *cần test: minimize/restore, cửa sổ bị che*.
- **§4.9** Splash 3000ms → 800ms.
- **§4.16** Poll job backoff 500ms→1500ms sau 10 nhịp (api.ts + processHandlers); `nativeTextBlocks` LRU 30 trang (thứ tự giữ trong ref — key số của object JS không giữ thứ tự chèn); blueprint SheetViewer scale theo ô (~0.2-0.5 thay 1.0); CSS `transition: all` → danh sách property cụ thể; backdrop blur 20-24px → 10px.
- **§5.5 (FE)** ImpositionTab gọi `close_pdf_document` khi đóng tab (giải phóng doc pdfium phía Rust).

## C. ĐÃ SỬA — RUST + BUILD (12 file)

- **§5.1** `[profile.release]` cho `native` + `src-tauri`: `lto="thin"`, `codegen-units=1`, `strip="symbols"` (GIỮ panic=unwind — PyO3/catch_unwind cần).
- **§5.2** native: PDFium bind **một lần** (`OnceLock` + pattern `SyncPdfium` sao chép từ chính src-tauri lib.rs đang compile) — hết LoadLibrary + FPDF_InitLibrary + parse-lại mỗi call, giữ được font cache.
- **§5.3** 6 hàm PDFium native **nhả GIL** (`py.detach`) + serialize bằng `PDFIUM_LOCK`; dữ liệu gom thành struct thuần Rust rồi mới dựng PyDict dưới GIL; bật feature `thread_safe` cho pdfium-render (khớp desktop).
- **§5.4** Nuitka thêm `--onefile-tempdir-spec="{CACHE_DIR}\PrynX\sidecar-{VERSION}"` — giải nén 1 lần/version thay vì mỗi lần mở app; trần chờ sidecar 5s → **20s** (máy yếu không còn bị exit(1) oan).
- **§5.5** `DOC_CACHE`: LRU cap 4 doc + lệnh `close_pdf_document` (đăng ký handler + FE gọi khi đóng tab).
- **§5.7** `RUSTFLAGS="-C target-cpu=x86-64-v2"` cho cả bước maturin và tauri build (set/restore đúng chuẩn script).
- **§5.11** `get_pdf_metadata` dùng `pages().page_size(i)` (FPDF_GetPageSizeByIndex — không load trang; đã bao gồm rotation, xác nhận bởi test `pdfium_page_size_already_includes_intrinsic_rotation` trong print.rs). File nghìn trang: mở từ nhiều giây → tức thì.
- **§5.12** Double-checked insert cho DOC_CACHE (không giữ khóa khi đọc file + parse) ở cả metadata lẫn render_tile.
- **§5.14** `get_ocg_layers` placeholder trả rỗng NGAY (bỏ init + parse vô ích); `render_svg` dùng crate `base64` + `write!` thay tự chế nối chuỗi.
- **§4.8** tauri.conf.json gỡ flags throttling (ở trên).

---

## D. CHƯA SỬA — LÝ DO CỤ THỂ

| Mục | Lý do để lại |
|---|---|
| §3.6 matchTemplate DPI thấp, §3.7 hunt fingerprint, §3.17 cluster_regions, §3.9 undo ring-buffer | Đổi THUẬT TOÁN so sánh/undo — ảnh hưởng tính đúng kết quả QA; cần chạy bộ test PBT/E2E + benchmark corpus trước (Đợt 3 của báo cáo). |
| §3.16 copy overlay ×2 | **False positive sau xác minh sâu**: bản copy thứ nhất cần vì `imposed` còn dùng để diff; bản thứ hai cần vì spotlight GIF dùng overlay CHƯA vẽ rect. Không sửa. |
| §3.8 render 1 trang khi toggle layer; trả JPEG thay base64 | Đổi contract API + copy trang cross-document bằng pikepdf dễ vỡ OCG refs — cần test layer thật. Đã giảm đau bằng heavy-scheduler off-loop. |
| §5.6 rayon cho print_engine | `ColorManager` giữ LUT cache bằng `RefCell` (không Sync — chính comment trong print_engine_py.rs xác nhận) — phải refactor color state trước khi song song hóa, và cần chạy bộ render tests. |
| §5.13 PPE cache Document, batch CMM | Cần sửa sâu print_engine — cùng đợt với rayon. |
| §4.10 memo LivePageFrame | Component `(props: any)` — cần định kiểu props trước khi viết comparator, không thì memo sai còn nguy hiểm hơn. |
| §4.11 ThumbSidebar VirtuosoGrid | Đổi layout lưới thumbnail — cần test giao diện thật. |
| §4.4 ImposerDashboard | Đọc **154 field** từ store — selector liệt kê đủ 154 field không giảm gì; cần tách section (Đợt 2). |
| §4.13 Web Worker cho solver | Cần tách entry + test luồng dữ liệu; pattern plateInfoWorker có sẵn để làm theo. |
| §5.10 IPC nhận Vec<u8> | Đổi chữ ký lệnh Tauri + chỗ gọi FE — làm riêng để dễ revert. |
| §5.12 TileCache theo byte, §5.21 print worker sống lâu | Cần đo thực tế trước khi đổi cấu trúc cache/worker. |

## E. VIỆC BẠN CẦN LÀM TRƯỚC KHI DÙNG BẢN NÀY

1. **Compile Rust** (môi trường sửa không truy cập được crates.io nên chưa build được — code Rust viết theo đúng pattern/API đang dùng trong repo nhưng PHẢI xác nhận):
   ```powershell
   cd native;  cargo check          # nếu lỗi ở OnceLock/SyncPdfium → báo mình sửa tiếp
   cd ..\desktop\src-tauri;  cargo check
   ```
2. **Build lại native cho backend dev**: `maturin develop --release` (venv backend) — vì đã đổi 6 hàm + feature thread_safe.
3. **Chạy test backend**: `pytest backend/tests` (đặc biệt: test_compare_engine, test_edit_session, test_ppe_*, test_pdf_tools).
4. **Test tay 10 phút** (các thay đổi hành vi có chủ đích):
   - Chuyển tab qua lại 4-5 tab file lớn (content-visibility) — cuộn viewer/thumbnail sau khi quay lại tab.
   - Minimize app khi đang chạy job → mở lại (gỡ throttling flags) — job vẫn chạy, UI cập nhật đúng.
   - Mở app lần đầu sau build (onefile tempdir): lần 1 chậm như cũ, lần 2 phải nhanh hơn rõ.
   - Toggle layer, xem tách kẽm 2 trang qua lại (cache mới), VDP bấm Next liên tục.
   - Đóng tab file lớn → RAM (Task Manager) phải giảm sau vài giây.
5. **Đo baseline** theo mục 7 của báo cáo audit (perf_sampler + corpus) để so trước/sau.

*Mọi thay đổi đều là commit-độc-lập được về mặt logic — nếu 1 mục gây vấn đề, tìm comment `PERF (audit 2026-07 §x.y)` tương ứng và revert riêng phần đó.*
