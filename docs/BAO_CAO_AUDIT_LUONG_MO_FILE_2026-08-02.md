# BÁO CÁO AUDIT LUỒNG MỞ FILE VÀ LOADING VÔ HẠN

**Ngày:** 2026-08-02
**Phạm vi:** mở PDF, ảnh và Office bằng picker, Home, Recent, Open With/double-click, single-instance, kéo-thả native/DOM, chọn nhiều file, thư mục batch, Google link, Combine/Interleave, Convert và mở tab kết quả.
**Trạng thái:** Lô 1–7 đã triển khai theo các sub-lô tối đa năm file và có kiểm thử tự động theo phạm vi. Runtime HTTP trên sidecar nạp code mới đã đạt cho Merge/Interleave job; còn hai chốt nghiệm thu lớn là ma trận môi trường/UI Tauri thật và clean-checkout/release gate.
**Mức bằng chứng:** code + test tự động + log runtime của app thật cho PDF/Open With/Combine trước migration/Office, cùng runtime sidecar thật cho Merge/Interleave sau migration. Chưa chạy đủ UI Tauri cho job mới, Google, USB/UNC/NAS, folder thật và toàn bộ 19 đuôi hỗ trợ.

## 1. Kết luận điều hành

Ảnh người dùng gửi không khớp spinner metadata cũ trong `usePdfLoader`; nó khớp skeleton **“Loading...” của `LivePageFrame`**.

Log runtime ngày 2026-08-02 xác nhận:

1. File đã mở thành công: viewer ở `loadStatus=ready`, có `numPages=2`, có kích thước trang và có native path.
2. Tile trang 1 được đưa vào scheduler lúc 04:53:33–04:53:34.
3. Scheduler không chạy tile đó trong khoảng **75,6 giây**.
4. Khi scheduler hoạt động lại, lời gọi render native chỉ mất **254–293 ms** và ảnh trang hiện ngay.

Vì vậy nguyên nhân trực tiếp của ca đang gặp là **hàng đợi dựng hình bị đầu độc/kẹt**, không phải PDF mất 75 giây để đọc hoặc render.

Có ba tầng làm hiện tượng trở thành “loading vô hạn”:

- `TileRenderScheduler` chỉ hủy task đang chờ; một task đã chạy nhưng promise/callback không settle sẽ giữ `activeCount=1` và chặn toàn bộ render PDF native về sau.
- `LiveTile` nuốt lỗi lấy tile và lỗi decode ảnh, không có state `error`, watchdog, retry hay terminal UI; skeleton vì thế có thể tồn tại mãi.
- Rust `DOC_CACHE` hiện đã hồi quy so với tài liệu sửa hiệu năng ngày 2026-07-26: cache không còn LRU/close, mutex còn bị giữ trong lúc đọc và parse file, metadata lại load từng page. Một file NAS/OneDrive chậm có thể giữ khóa và làm các tab khác cùng chờ.

Ngoài nguyên nhân chính, audit tìm thấy các lỗi độc lập có thể tạo cùng triệu chứng từ Open With, NAS/Recent, Combine và Office/Google. Các lỗi này phải được sửa theo lô nhỏ và verify xuyên suốt; chỉ vá spinner sẽ che triệu chứng chứ không phục hồi được pipeline.

## 2. Bằng chứng runtime của ca Loading

Đường dẫn/tên file đầy đủ được lược khỏi báo cáo; các mốc dưới đây lấy từ `%APPDATA%/PrynX/logs/preview_perf.log`.

| Mốc | Bằng chứng | Ý nghĩa |
|---|---|---|
| 04:53:33.997 | `loadStatus=ready numPages=2 hasPageDim=True hasNativePath=True` | Metadata và routing đã hoàn tất |
| 04:53:33.985 | `tile-scheduler-enqueue page=1 priority=10` | Trang đầu đã xếp hàng |
| 04:53:34.104 | Enqueue lần kế tiếp cùng owner | Retry vẫn chỉ vào hàng đợi |
| 04:54:49.583 | `tile-scheduler-run` | Scheduler bắt đầu chạy sau khoảng 75,6 giây |
| 04:54:49.738 | `tile-native-done invokeMs=293 bytes=35073` | Render thật nhanh, output hợp lệ |
| 04:54:49.929 | `tile-native-done invokeMs=254 bytes=35073` | Lần render kế tiếp cũng nhanh |

Diễn giải chắc chắn:

- Không có bằng chứng file hỏng trong phiên này.
- Không có bằng chứng PDFium cần 75 giây để render trang 1.
- Khoảng chờ nằm trước `tile-scheduler-run`, tức ở scheduler hoặc một task cũ đang giữ slot.
- HMR/reload làm pipeline chạy lại; đây là dấu hiệu điển hình của scheduler/promise bị kẹt, không phải dữ liệu PDF tự hồi phục.

## 3. Sơ đồ luồng đã truy vết

```text
Picker / Home / Recent / Open With / Native drop / DOM drop
    │
    ▼
SystemIntegrations + App dispatcher
    ├─ PDF ───────────────────────────────► tab viewer
    ├─ PNG/JPG/JPEG ─────────────────────► chuyển ảnh thành PDF ► tab viewer
    ├─ Office ────────────────────────────► OfficeConvertTool ► backend ► tab viewer
    ├─ nhiều ảnh/hỗn hợp ─────────────────► CombineTab
    └─ --prynx-action=convert ────────────► CombineTab

Folder / Google link / Combine / Interleave / công cụ kết quả
    │
    ▼
File/Blob hoặc path-stub
    │
    ▼
usePdfLoader (metadata, số trang, kích thước)
    │
    ▼
LivePageFrame ► LiveTile ► TileRenderScheduler ► Tauri render_pdf_page ► PDFium
    │
    ├─ ready: gắn blob URL vào ảnh
    └─ lỗi hiện tại: catch rỗng ► skeleton Loading không có terminal state
```

## 4. Ma trận cửa mở file — trạng thái sau Lô 7

| Cửa vào | Hành vi hiện tại | Mức bằng chứng |
|---|---|---|
| Ctrl+O / menu File > Mở | Picker dùng nguồn chân lý chung: PDF, 7 ảnh và 11 Office; mọi file đi qua dispatcher chung | Test tự động; chưa smoke đủ 19 đuôi |
| Home picker | Dùng cùng filter và cùng `system-files-received`, không đi tắt router | Test tự động; chưa smoke picker thủ công đủ ma trận |
| `PDFUploader` picker/drop | Nhận nhiều PDF; native path dùng contract stat/read chung | Test hẹp; chưa UNC/NAS thật |
| Open With / double-click / single-instance | Probe metadata song song trong deadline UX rồi dispatch file dù stat timeout/inaccessible | Test tự động; runtime ổ D đạt |
| Tauri native drag-drop | Path được đổi thành path-backed `File` và đi qua dispatcher chung | Test tự động; chưa smoke toàn ma trận |
| Home DOM drag-drop | Home là consumer thật, phát đúng một batch cho dispatcher; không còn `preventDefault` no-op | Test component; chưa smoke DOM thật |
| Recent Files | Dùng native stat contract, chỉ đánh dấu mất khi nhận `missing`; Office single/batch được ghi Recent | Test tự động; chưa USB/UNC thật |
| Nhiều PDF | Mỗi PDF mở một tab theo intent mặc định; intent Combine gom vào một tab | Test dispatcher và runtime Combine trước migration |
| Nhiều Office | Vào batch Office, có cancel file hiện tại và generation fence | Test tự động; runtime DOCX/XLSX/PPTX |
| Nhiều ảnh / hỗn hợp | Đi vào Combine hoặc tool ảnh đang active; một ảnh đi viewer và được chuẩn hóa thành PDF | Test tự động; WebP/BMP/TIFF chưa runtime thật |
| Chọn thư mục batch | Rust lọc top-level PDF + 11 Office, không phân biệt hoa/thường, bỏ file khóa `~$`; không recursive | Rust 3/3; chưa folder/UNC thật |
| Google link | Nhận public Docs/Sheets/Slides, Drive `/file/d/` và `open?id=`; từ chối folder/private/OAuth rõ ràng | Parser/UI test; chưa gọi Google thật |
| Combine manifest / merge_files / interleave | Job chung có progress, cancel, queue gate, mixed native/upload zero-copy và native result path trong Tauri | Backend/API/UI đã migrate; runtime HTTP đạt Merge/Interleave/mixed/cancel, UI Tauri chưa smoke |
| Tab kết quả convert/combine | Giữ native result path khi có; Blob chỉ dùng cho web/in-memory | Office runtime đạt; output Interleave mới mở được bằng PDFium, chưa thao tác viewer Tauri |

## 5. Ma trận định dạng sau khi hợp nhất contract

“Hỗ trợ toàn cục” là qua dispatcher của app desktop; không có nghĩa mọi cửa phụ như folder batch hoặc backend manifest đều nhận mọi định dạng.

| Nhóm | Định dạng | Mở toàn cục | Engine / giới hạn |
|---|---|---:|---|
| Tài liệu | PDF | Có | Native PDFium cho path; PDF.js cho Blob/web |
| Ảnh trực tiếp | PNG, JPG, JPEG | Có | Nhúng vào PDF một trang, giữ nén/DPI khi đọc được |
| Ảnh cần normalize | WebP, BMP, TIF, TIFF | Có trong app Tauri | Rust decode → RGB PNG → PDF một trang; browser fallback không phải bằng chứng runtime |
| Word | DOC, DOCX, RTF, ODT | Có qua Convert khi capability báo engine | Word COM hoặc LibreOffice/engine tương ứng |
| Bảng tính | XLS, XLSX, ODS, CSV | Có qua Convert khi capability báo engine | Excel COM hoặc LibreOffice/engine tương ứng |
| Trình chiếu | PPT, PPTX, ODP | Có qua Convert khi capability báo engine | PowerPoint COM hoặc LibreOffice/engine tương ứng |
| Google | Docs, Sheets, Slides, Drive file public | Có qua link | Stream export/download thành PDF |
| Google | Drive folder, file private/OAuth | Không | Contract hiện tại từ chối rõ ràng |
| Thiết kế gốc | AI, EPS, PSD, SVG, CDR, INDD | Không | Chưa có ingestion/converter chính thức |

Nguồn chân lý hiện có **19 đuôi**: PDF + 7 ảnh + 11 Office. Folder batch chỉ quét PDF + 11 Office. Backend Combine nhận PDF/PNG/JPG/JPEG; WebP/BMP/TIFF được giữ ở frontend thay vì quảng bá sai capability backend. Parity đuôi viết hoa, tên Unicode và chuỗi UNC đã có test mô phỏng, chưa phải runtime share thật.
## 6. Bảng phát hiện — trạng thái closeout code/test

| Mã | Trạng thái | Bằng chứng và giới hạn |
|---|---|---|
| §LOAD.1 | **Đã đóng** | Scheduler có terminal lifecycle; test tự động và runtime file gốc/first tile đạt |
| §LOAD.2 | **Đã đóng về implementation** | LiveTile/loader không nuốt lỗi và có retry/cancel; chưa có runtime ép lỗi decode/callback treo |
| §LOAD.3 | **Đã đóng** | DOC_CACHE RAM-gated, load ngoài mutex, `page_size`, LRU/close; Rust/test/runtime đạt |
| §REL.1 | **Còn mở** | Relevant code/test/docs chưa nằm trong HEAD; chưa clean checkout/clean clone/release build |
| §OPEN.1 | **Đã đóng** | Stat bất đồng bộ, probe song song có deadline và poll tuần tự; runtime Open With ổ D đạt |
| §OPEN.2 | **Đã đóng về code/test** | Recent phân biệt `missing/inaccessible/timeout`; chưa USB/UNC thật |
| §OPEN.3 | **Đã đóng về code/test** | Home DOM drop có consumer và test; chưa smoke DOM thật |
| §COMB.1 | **Đã đóng** | Không gửi path-stub 0 byte; transport/order đúng; runtime Combine trước migration đạt |
| §COMB.2 | **Đã đóng về implementation + backend runtime** | Manifest, `merge_files` và `interleave` dùng chung job progress/cancel/mixed zero-copy/admission; runtime HTTP 5.000 trang và cancel đạt, UI Tauri còn nằm trong gate `§TEST.1` |
| §OFFICE.1 | **Đã đóng** | Process isolation, lease, timeout/cancel và thu hồi đúng PID; runtime đạt |
| §OFFICE.2 | **Đã đóng** | UI AbortSignal/job ID/generation fence cho single/Google/batch/resize; runtime cancel đạt |
| §FORMAT.1 | **Đã đóng về capability contract** | UI hỏi capability theo extension; oracle 19 đuôi có test; runtime mới phủ DOCX/XLSX/PPTX và ảnh cơ bản |
| §BE.1 | **Đã đóng cho các đường đã audit** | Upload/document/detect-shape được offload; Interleave 5.000 trang trên sidecar 8321 vẫn trả health trung vị 5,82 ms, tối đa 15,99 ms |
| §BE.2 | **Đã đóng cho các đường đã audit** | Office/Google/unlock streaming, Office/Combine trả native path trong Tauri; chưa được hiểu là toàn backend bounded-memory |
| §BE.3 | **Đã đóng về code/test** | Upload kiểm signature, strict parse, encryption, zero-page, metadata và rollback trước 200 |
| §JOB.1 | **Đã đóng về code/test** | N-Up exit 0 nhưng thiếu state chuyển `failed` terminal |
| §TEST.1 | **Còn mở một phần** | Coverage đã tăng mạnh nhưng ma trận runtime operation → first tile/error, môi trường thật và clean checkout chưa đủ |
| §CASE.1 | **Đã đóng về code/test** | `/execute-plan` chấp nhận `FILE.PDF` |
## 7. Chi tiết phát hiện

> Phần này giữ bằng chứng và nguyên nhân tại thời điểm audit ban đầu. Trạng thái closeout có hiệu lực nằm ở §6 và các mục 18–20.

### §LOAD.1 — Scheduler bị đầu độc bởi task không settle

**Bằng chứng code:**

- `desktop/src/hooks/viewer/tileRenderScheduler.ts:40` giữ `activeCount`.
- `:82-88` chỉ reject task đang queued khi cancel owner/group.
- `:163-172` tăng slot trước `task.run` và chỉ giảm trong `finally`; promise không settle thì slot không bao giờ được nhả.
- `:186` scheduler native có concurrency 1 vì PDFium không thread-safe.
- `:90-104` có `resetForHotReload()`, nhưng đây là bản vá dev/HMR trong dirty tree; production không có cơ chế recovery tương đương.

**Tác động:** một IPC render mất callback, WebView/HMR thay module, native invoke bị treo hoặc promise lifecycle lỗi có thể chặn mọi PDF ở mọi tab. Cancel tab không giải phóng task đang chạy.

**Khuyến nghị:** thêm lease/generation + terminal lifecycle cho task đang chạy. Watchdog không được mở render PDFium song song; nó chỉ được đánh dấu scheduler lỗi, reject UI và phục hồi sau khi xác nhận lệnh cũ đã kết thúc hoặc tái tạo worker/process an toàn. Không thêm hard-cap worker vô điều kiện.

### §LOAD.2 — LiveTile biến lỗi thành Loading vô hạn

**Bằng chứng code:**

- `desktop/src/components/workspace/LivePageFrame.tsx:332-387` gọi `getTileUrl`, preload/decode ảnh rồi:
  - `:376-380` lỗi decode chỉ xóa ref/reset params;
  - `:384-387` lỗi lấy tile bị catch rỗng, không lưu lỗi và không retry có kiểm soát.
- `:2767-2776` skeleton Loading luôn nằm dưới tile; không có nhánh error hay nút thử lại.

**Tác động:** lỗi PDFium, scheduler cancel, blob decode lỗi, thiếu RAM hoặc sidecar mất đều trông giống “đang tải bình thường”. Người dùng không có thông báo, retry, hủy hay mã lỗi.

**Khuyến nghị:** state rõ `idle | loading | slow | ready | error | cancelled` ở cấp first tile; log stage + elapsed; UI tiếng Việt có Thử lại/Hủy. Watchdog “slow” chỉ đổi thông tin UI, không giết job hợp lệ trên máy mạnh.

### §LOAD.3 — Hồi quy DOC_CACHE/PDFium ở Rust

**Bằng chứng đối chiếu:**

- `docs/PERF_FIXES_2026-07-26.md:39-42` ghi đã có LRU cap 4, `close_pdf_document`, `page_size(i)` và double-checked insert không giữ cache lock lúc I/O/parse.
- Code hiện tại:
  - `desktop/src-tauri/src/lib.rs:181`: `HashMap`, không LRU;
  - `:400-412` và `:578-599`: giữ mutex cache trong lúc đọc/parse;
  - `:459-461`: metadata dùng `pages.get(i)`, tức load page;
  - không còn command `close_pdf_document`.

**Tác động:** file nghìn trang mở chậm; file trên NAS/OneDrive chậm có thể giữ mutex toàn cache và khiến các tab khác chờ. Document handle không có vòng đời đóng rõ làm RAM/handle tăng theo phiên.

**Khuyến nghị:** khôi phục thiết kế đã được audit trong tài liệu, thêm test khóa không giữ qua I/O và test lifecycle LRU/close. Không đặt cap tài nguyên mới ngoài nguyên tắc RAM-gating; cap 4 cũ chỉ được khôi phục sau khi xác nhận lại mục tiêu và hành vi máy ≥16 GB.

### §REL.1 — Bản vá đang xanh chưa nằm trong HEAD

`HEAD=70ef2a6` ngày 2026-07-30. Trong HEAD sạch:

- nhánh PDF blob của `usePdfLoader` còn catch rỗng;
- nhánh native chỉ log exception và chấp nhận metadata 0 trang;
- nhánh ảnh không có `onerror`.

Dirty working tree hiện đã sửa các điểm này và có test mới, nhưng file code/test/tài liệu vẫn chưa commit. Một build/release từ checkout sạch sẽ không chứa bản vá.

**Khuyến nghị:** sau từng lô được duyệt, verify và commit atomically code + test + tài liệu; trước release phải kiểm tra clean-clone build, không suy ra chất lượng release từ dirty worktree.

### §OPEN.1 — Open With/startup có thể đứng trước cả dispatcher

`SystemIntegrations.tsx:35-60` lặp tuần tự qua path và await `get_file_size` cho từng file. Rust `get_file_size` tại `desktop/src-tauri/src/lib.rs:1143` là command filesystem đồng bộ, không deadline. Với nhiều file NAS/OneDrive placeholder, event `system-files-received` bị trì hoãn trước khi App tạo tab.

Poll tại `SystemIntegrations.tsx:91-100` gọi `processPaths(args)` nhưng không return/await promise đó; lời khẳng định “không chồng poll” chỉ đúng cho `get_pending_system_files`, không đúng cho toàn chuỗi xử lý path.

**Khuyến nghị:** dispatch file sớm với size chưa biết, lấy stat song song có giới hạn theo hồ sơ RAM/CPU hoặc lazy; thêm timeout UX ở filesystem metadata nhưng không từ chối mở file chỉ vì không đọc được size.

### §OPEN.2 — Recent Files sai với file ngoài scope plugin-fs

`desktop/src/lib/useRecentFiles.ts:134-145` dùng `@tauri-apps/plugin-fs stat`; mọi exception đều bị hiểu là file mất. Cùng dự án đã ghi nhận plugin này bị giới hạn scope và `PDFUploader`/`SystemIntegrations` đã có fallback native cho ổ D, USB và UNC.

**Khuyến nghị:** Recent dùng cùng native stat contract với SystemIntegrations, phân biệt `missing | inaccessible | timeout`; không xóa/đánh dấu mất chỉ vì capability scope từ chối.

### §OPEN.3 — Home DOM drop là no-op

`HomeTab.tsx:300-304` prevent default và chỉ tắt highlight. `SystemIntegrations.tsx:158-169` bỏ qua event nếu `defaultPrevented`. Vì vậy DOM drop trên Home trong browser/dev không có consumer nào xử lý file. Tauri native drop là event khác nên không chứng minh nhánh này đúng.

### §COMB.1 — Merge/Interleave backend có thể nhận file 0 byte

`SystemIntegrations` và nhiều luồng native tạo `new File([], name)` rồi gắn property `path`. Hàm chuẩn `prepareFileForUpload` đã biết cách đọc path-stub, nhưng `backendMergePdfs` tại `desktop/src/lib/api.ts:647-659` append trực tiếp `File` vào FormData.

Consumer:

- `CombineTab.tsx:492-496` cho Interleave backend;
- `processHandlers.ts:831-845` cho Merge/Interleave lớn.

**Tác động:** job chỉ PDF native đủ lớn để delegate có thể upload payload 0 byte, backend lỗi hoặc tạo output hỏng; tab kết quả sau đó rơi vào loader/error.

**Khuyến nghị:** hợp nhất về manifest path contract hoặc bắt buộc `prepareFileForUpload`; test path-stub có `size` spoof nhưng blob thật rỗng.

### §COMB.2 — Job dài thiếu lifecycle và thumbnail leak

- Route manifest chặn số nguồn/JSON, nhưng một item không có `page_index` có thể expand toàn bộ PDF vượt giới hạn item logic.
- HTTP request đồng bộ dài không có job ID/progress/cancel; retry UI không dừng worker cũ.
- `CombineTab.tsx:121-136,220-228,263-273` tạo object URL nhưng không cleanup toàn bộ URL sống khi tab unmount.
- Delegation ảnh lớn hiện chỉ bảo vệ một số thao tác; Interleave/In/Ghép nhóm vẫn có đường chạy frontend.

### §OFFICE.1 — COM hang đầu độc hàng Office/Google

`backend/app/workers/office_convert_engine.py:174-256` gọi Word/Excel COM Open/Save/Export/Close/Quit trực tiếp, không deadline và không process isolation có thể kill. `pdf_tools.py:1290-1298,1341-1348` chờ lời gọi này. Office và Google dùng chung slot `office` đơn trong `heavy_job_scheduler.py:71-74,121-124`.

Một file password/protected view, external link, repair prompt hoặc COM lỗi có thể giữ slot vĩnh viễn; mọi yêu cầu Office/Google sau đó chỉ chờ.

**Khuyến nghị:** chạy mỗi conversion trong process riêng có deadline, kill process tree và cleanup temp; slot phải được nhả trong mọi terminal path. Timeout nên theo loại job/kích thước và có “tiếp tục chờ” cho máy/tệp chậm, không hard-cap hiệu năng máy mạnh.

### §OFFICE.2 — Hủy trên UI không hủy request

`OfficeConvertTool.tsx:120-123,144-147,276-279,484-507` gọi fetch không có signal. `batchCancelRef` tại `:450-463,540-542` chỉ được kiểm trước file kế tiếp. Bấm dừng trong lúc COM đang treo không abort request và không nhả slot backend.

### §FORMAT.1 — Khả năng convert không được báo theo định dạng

Backend quảng bá đủ 11 Office extension, nhưng COM dispatcher chỉ có Word và Excel. ODS, PPT, PPTX, ODP cần LibreOffice. Trạng thái “có Office” hiện có thể true khi máy chỉ có Word hoặc Excel, làm UI cho chọn định dạng mà runtime không xử lý được.

Google link chỉ nhận Docs/Sheets/Slides hoặc Drive file; Drive folder/private file không thuộc contract hiện tại và cần báo rõ trước khi gửi request.

### §BE.1 — Endpoint mở/preview chặn uvicorn event loop

Các đường đáng chú ý:

- `upload.py:97-118` gọi metadata đồng bộ;
- `pdf_processor.py:131-143,181-218` quét trang/content stream;
- `imposition.py:271-540,744-776` chạy quick-color/layer/text/meta/vector trực tiếp trong `async def`;
- layer preview còn chờ `pdfium_guard` ngay trên event loop.

Khi một route chậm hoặc chờ khóa PDFium, health và các request mở file khác có thể cùng đứng. Mẫu đúng đã có ở `preflight.py:740-741,755-770`.

### §BE.2 — Buffer toàn bộ payload có thể làm sidecar OOM

- Office multipart dùng `await file.read()`;
- Google download dùng `response.content`;
- unlock giữ cả input và output trong RAM;
- một số output lại được copy thêm sang Blob/ArrayBuffer ở frontend.

Không khôi phục hard-cap 500 MB vô điều kiện. Cần stream qua temp file, admission theo RAM/đĩa khả dụng và giữ máy ≥16 GB chạy đủ công suất.

### §BE.3 — Upload fail-open

`upload.py:47-70,103-122` chỉ kiểm đuôi, nuốt lỗi metadata nhưng vẫn ghi DB/trả success. File 0 byte, PDF hỏng hoặc ảnh đổi đuôi có thể nhận HTTP 200 rồi chỉ thất bại ở viewer/downstream. Route serve còn trả `application/pdf` cho loại input không phải PDF.

**Khuyến nghị:** validate signature + parse tối thiểu trước success; trả lỗi tiếng Việt có mã stage. Ảnh phải được normalize thành PDF hoặc contract downstream phải giữ đúng MIME.

### §TEST.1 — Test xanh nhưng chưa phủ chuỗi người dùng

Coverage hiện tại tốt ở helper/route Combine, nhưng thiếu:

- picker/drop/startup/Open With → App dispatcher → đúng tab;
- file native/path-stub/UNC → metadata → first tile;
- Combine/Interleave/Office/Google → tab kết quả → first tile hoặc error terminal;
- native metadata/render reject, zero-page, callback trả muộn;
- LiveTile slow/error/decode/retry;
- Office COM/LibreOffice thật, timeout/cancel/password/Unicode/UNC;
- Google private/login HTML/slow/large/folder;
- parity đủ 11 Office extension và các định dạng ảnh.

## 8. Baseline khảo sát ban đầu

| Kiểm tra | Kết quả |
|---|---:|
| TypeScript `npm run typecheck` | Pass |
| Vitest hẹp, lượt 1 | 8 file, 51/51 pass |
| Vitest hẹp, lượt đối chiếu | 10 file, 56/56 pass |
| Pytest hẹp, lượt 1 | 33/33 pass |
| Pytest hẹp, lượt đối chiếu | 28/28 pass |
| Rust batch-folder helper | 3/3 pass |
| Golden snapshot | Không cập nhật |

Các lượt có phần giao nhau, không cộng tổng số test. Mức bằng chứng tự động hiện chỉ chứng minh helper/route; chưa chứng minh app Tauri thật từ thao tác người dùng tới first tile.

## 9. Thứ tự sửa đã duyệt — bản ghi lịch sử, mỗi lô tối đa 5 file

### Lô 1 — Chấm dứt Loading vô hạn ở first tile

Mục tiêu: scheduler và LiveTile luôn kết thúc ở ready/error/cancelled; có retry an toàn.

File dự kiến, tối đa 5:

1. `desktop/src/hooks/viewer/tileRenderScheduler.ts`
2. `desktop/src/hooks/viewer/tileRenderScheduler.test.ts`
3. `desktop/src/components/workspace/LivePageFrame.tsx`
4. test mới cho `LivePageFrame/LiveTile`
5. một file i18n hoặc helper trạng thái nếu cần

Verify: task reject, task không settle mô phỏng, cancel owner khi running, decode lỗi, đổi file, retry; runtime mở lại đúng file gây lỗi và xác nhận first tile không đứng vô hạn.

### Lô 2 — Khôi phục bất biến DOC_CACHE/PDFium

Mục tiêu: không giữ cache mutex qua I/O/parse, metadata không load page, có LRU/lifecycle đóng document.

File dự kiến:

1. `desktop/src-tauri/src/lib.rs`
2. `desktop/src/components/ImpositionTab.tsx`
3. test Rust cùng module hoặc file test liên quan
4. test lifecycle frontend nếu command close được gọi từ tab

Verify: file nhiều trang, mở/đóng nhiều tab, hai file song song, file NAS chậm giả lập; không mở PDFium song song trái bất biến.

### Lô 3 — Hợp nhất mọi cửa vào và sửa NAS/Recent/DOM drop

File dự kiến:

1. `desktop/src/components/SystemIntegrations.tsx`
2. `desktop/src/components/SystemIntegrations.test.tsx`
3. `desktop/src/lib/useRecentFiles.ts`
4. `desktop/src/components/HomeTab.tsx`
5. test Home/Recent

Verify: Ctrl+O, Home picker, native/DOM drop, Open With khi app đang mở, nhiều file hỗn hợp, D:/USB/UNC và stat timeout.

### Lô 4 — Sửa transport Combine/Interleave và vòng đời output

File dự kiến:

1. `desktop/src/lib/api.ts`
2. `desktop/src/components/CombineTab.tsx`
3. `desktop/src/lib/processHandlers.ts`
4. test API/path-stub
5. test Combine/process handler

Verify: path-stub 0 byte, PDF/PNG/JPEG, Merge/Interleave/Ghép nhóm, backend path output, thumbnail cleanup, kết quả mở tới first tile.

### Lô 5A — Cô lập Office COM và bảo vệ slot backend

File dự kiến:

1. `backend/app/workers/office_convert_engine.py`
2. worker process mới hoặc helper isolation
3. `backend/app/api/routes/pdf_tools.py`
4. `backend/app/core/heavy_job_scheduler.py`
5. test timeout/slot release

Verify: converter hang, password/prompt giả lập, process crash, request thứ hai, cleanup temp và Google chạy sau Office lỗi.

### Lô 5B — Cancel/progress Office, Google và batch

File dự kiến:

1. `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`
2. `desktop/src/lib/api.ts` nếu cần contract signal/job
3. test component Office
4. test route/job lifecycle
5. i18n

Verify: hủy single, Google, resize và file hiện tại trong batch; không chỉ dừng trước file tiếp theo.

### Lô 6 — Backend fail-fast, responsive và bounded-memory

Lô này phải chia tiếp nếu implementation chạm quá 5 file. Ưu tiên đầu:

1. `backend/app/api/routes/upload.py`
2. `backend/app/core/pdf_processor.py`
3. `backend/app/api/routes/imposition.py`
4. test upload corrupt/zero-byte
5. test responsiveness song song với health

Sau khi verify mới chuyển sang lô streaming Office/Google/unlock riêng, có RAM-gating và kiểm đĩa.

### Lô 7 — Integration matrix và clean-build gate

Thêm test table-driven cho định dạng/cửa vào và một smoke harness Tauri:

- PDF, PNG, JPG/JPEG;
- đủ 11 Office extension;
- path local, Unicode tiếng Việt, D:/USB/UNC giả lập;
- startup/Open With/native drop/DOM drop/Recent;
- Combine/Office/Google result → first tile;
- clean checkout chứa đủ code + test + tài liệu đã duyệt.

## 10. Tiêu chí nghiệm thu cuối

- Không trạng thái nào giữ Loading sau khi operation đã reject/cancel hoặc scheduler mất terminal callback.
- First tile chậm phải chuyển sang “đang mất nhiều thời gian” và cho Thử lại/Hủy; không tự hard-timeout job hợp lệ trên máy mạnh.
- Một tab/file lỗi không chặn render PDF của mọi tab còn lại.
- Open With, native drop, DOM drop, Recent, picker và chọn nhiều file dùng cùng routing/transport contract.
- File ở D:/USB/UNC không bị coi là mất chỉ vì `plugin-fs` scope.
- Merge/Interleave backend không bao giờ gửi path-stub 0 byte.
- Office/Google hang có thể hủy; process/slot/temp đều được thu hồi.
- Backend vẫn trả health khi job metadata/preview nặng đang chạy.
- PDF/ảnh/Office hỏng trả lỗi terminal trước khi tạo tab kết quả; không HTTP 200 fail-open.
- Ma trận định dạng trong UI phản ánh engine thật đang có trên máy.
- Typecheck, test frontend/backend/Rust xanh; không cập nhật golden ngoài thay đổi hình học chủ đích.
- Kiểm tay trên app Tauri với đúng file người dùng, một file nhiều trang, nhiều tab, Office/Google và UNC/NAS.

## 11. Chốt duyệt ban đầu — bản ghi lịch sử

Đề nghị duyệt **Lô 1 trước** vì nó trực tiếp chấm dứt Loading vô hạn và tạo tín hiệu lỗi thật cho các lô sau. Sau Lô 1 phải verify hẹp + runtime và báo kết quả; chỉ khi đạt mới sang Lô 2. Không triển khai đồng loạt và không chạm quá 5 file trong một lô.

## 12. Kết quả triển khai Lô 1 — 2026-08-02

**Mức xác nhận:** code/typecheck/test tự động đạt; ngày 2026-08-02 người dùng xác nhận file gốc đã mở thành công trên app Tauri.

Năm file code của lô:

1. `desktop/src/hooks/viewer/tileRenderScheduler.ts`
2. `desktop/src/hooks/viewer/tileRenderScheduler.test.ts`
3. `desktop/src/components/workspace/LivePageFrame.tsx`
4. `desktop/src/i18n/locales/vi.json`
5. `desktop/src/i18n/locales/en.json`

Đã thực hiện:

- Bỏ cơ chế HMR đặt `activeCount=0` khi task cũ còn chạy; đây là hành vi có thể mở hai lời gọi PDFium song song.
- Giữ một scheduler xuyên Fast Refresh bằng `import.meta.hot.data`.
- Khi HMR gặp task đang chạy, scheduler vào quarantine: caller cũ và request mới nhận lỗi terminal; slot vật lý chỉ được mở lại trong `finally` của task thật.
- `cancelOwner`/`cancelGroup` kết thúc cả caller của task running nhưng không nhả slot native sớm.
- First tile có state `idle | loading | slow | ready | error | cancelled`; callback của attempt cũ không ghi đè retry mới.
- Sau 8 giây chỉ đổi UI sang cảnh báo chậm, không timeout invoke, không giảm chất lượng và không mở thêm worker/render.
- Lỗi lấy tile và decode ảnh không còn bị nuốt; UI có Thử lại/Hủy và log stage không chứa full path.

Verify:

| Kiểm tra | Kết quả |
|---|---:|
| Viewer matrix: scheduler + render zoom + PDF loader | 3 file, 22/22 pass |
| Scheduler ESLint hẹp | Pass |
| TypeScript `npm run typecheck` | Pass |
| Parity 6 khóa first-tile Việt/Anh | Pass |
| `git diff --check` cho 5 file | Pass |
| Toàn bộ Vitest | 165/167 file pass; 1622 test pass, 2 skip |

Ba lỗi trong full Vitest đã có ngoài phạm vi Lô 1 và không được sửa ké:

- thiếu khóa `lib.combineAssembly:chi_nhan_file_pdf_png_jpg` trong dirty Combine/i18n;
- hai snapshot Imposer lệch do các field `mixedExcessPercent`, `resizeSettings.autoTrimBefore/bgFillColor/bgFillMode` đã có trong worktree;
- không chạy `-u`, không cập nhật golden.

`lint:budget` vẫn thất bại do toàn dirty worktree có 45 finding `react-refresh/only-export-components` so với budget 32. Scheduler và test của Lô 1 sạch ESLint; vùng LiveTile mới không tăng finding, còn hai finding tại đó là `any` và effect cache có sẵn từ trước.

Chốt tiếp theo: Lô 2 DOC_CACHE/PDFium đã đạt runtime. Tiếp tục Lô 3 theo danh sách đã được duyệt.

## 13. Tinh gọn trạng thái mở file ảnh — 2026-08-02

Người dùng xác nhận lỗi mở file đã hết nhưng màn chờ chuyển ảnh sang PDF quá nổi bật. Giữ nguyên bước chuyển đổi để bảo toàn contract PDF của workspace; chỉ thu giao diện về spinner nhỏ và dòng “Đang mở file…”, bỏ mô tả dài và tên file. Typecheck và `git diff --check` đạt; ESLint toàn `ImpositionTab.tsx` còn các khoản nợ có sẵn, không có finding tại vùng vừa sửa.

## 14. Kết quả triển khai Lô 2 — 2026-08-02

Lô 2 đã khôi phục DOC_CACHE RAM-gated, double-checked load ngoài mutex cache, metadata `page_size()` không load trang và lifecycle `close_pdf_document`. Chi tiết code/test nằm trong `docs/LUONG_MO_FILE_FIXES_2026-08-02.md`.

Bằng chứng đạt: `cargo check`; Rust cache 3/3; viewer matrix 23/23; typecheck; runtime Open With → first tile 8 ms; fixture 400×200/rotation 90° hiển thị 200×400; đóng tab ghi `DOC_CACHE_CLOSE removed=1`; tab còn lại tiếp tục render, app không crash.

Giới hạn đã ghi nhận: `cargo fmt --check` toàn crate còn nợ baseline ngoài phạm vi; test PDFium rotation có sẵn bị treo trong runner nhưng ca tương đương đã đạt trên app Tauri thật.

## 15. Kết quả triển khai Lô 3 — 2026-08-02

Lô 3 được tách thành 3A/3B để vẫn giữ tối đa năm file mỗi lô và bổ sung contract native thay vì đoán loại lỗi từ chuỗi std::io::Error.

Kết quả chính:

- stat_system_file chạy filesystem metadata trong blocking pool và trả trạng thái có cấu trúc.
- Open With/startup xử lý nhiều path song song trong một deadline UX; poll không chồng lượt.
- Home picker, DOM drop và input web đi qua cùng system-files-received.
- Recent không còn phụ thuộc scope tạm của plugin-fs; timeout, access denied, USB/UNC offline không bị coi là file mất.
- Test tự động 11/11 frontend, 2/2 Rust, typecheck, lint hẹp và cargo check đều đạt.
- Binary Tauri build sạch; Open With PDF ở ổ D qua single-instance tới first tile với IPC render 1 ms.

Chi tiết file, contract và giới hạn còn lại nằm trong `docs/LUONG_MO_FILE_FIXES_2026-08-02.md`. Lô 5 Office/Google đã đạt; Lô 6–7 được triển khai tiếp và ghi tại phần closeout bên dưới.
## 16. Kết quả triển khai Lô 4 — 2026-08-02

Lô 4 được tách thành 4A/4B để giữ tối đa năm file mỗi lô. Lô 4A sửa tính đúng của transport Merge/Interleave và vòng đời thumbnail; Lô 4B khôi phục intent riêng của menu Explorer “Combine in PrynX” mà không làm đổi hành vi Open With kiểu Acrobat.

Kết quả chính:

- `backendMergePdfs` không còn gửi path-stub 0 byte; file native được materialize trước multipart và lỗi đọc path dừng trước khi gọi backend.
- Interleave chọn đúng `oddFile`/`evenFile`, không đọc nhầm working file, ước lượng đúng input và không gửi ảnh vào endpoint PDF-only.
- Thumbnail ảnh tự thu hồi object URL; preview PDF lỗi kết thúc bằng cảnh báo có “Thử lại”, không giữ `Loading...` vô hạn.
- Menu Explorer truyền `--prynx-action=combine`; App ưu tiên intent Combine trước quy tắc mở nhiều PDF thành nhiều tab.
- Test hẹp Lô 4A đạt 7/7; ma trận Combine/API/process handler đạt 45/45; Lô 4B đạt 25/25; TypeScript typecheck đạt.
- Runtime app Tauri: hai process Explorer riêng hợp nhất vào một tab “Ghép & Trộn PDF” có hai thumbnail. Bấm “Ghép file” mở tài liệu kết quả hai trang tới first tile; log ghi IPC trang 1 là 9 ms và trang 2 là 10 ms, không có lỗi/timeout/loading treo.

Tại thời điểm kết thúc Lô 4, `§COMB.2` còn progress/cancel backend, admission sau manifest expansion và zero-copy cho đường legacy. Các phần này được triển khai ở Lô 6; backend runtime sau migration đã đạt tại §18, còn UI Tauri nằm trong gate `§TEST.1`. Chi tiết file và cách verify nằm trong `docs/LUONG_MO_FILE_FIXES_2026-08-02.md`.
## 17. Kết quả triển khai Lô 5 — 2026-08-02

Lô 5 được chia thành các sub-lô backend/UI không quá năm file. Router Office được tách khỏi `pdf_tools.py`; conversion chạy trong process top-level tương thích Windows/Nuitka, ghi `.partial.pdf`, validate rồi `os.replace`, có lease gia hạn và trạng thái terminal.

Kết quả chính:

- Word, Excel và PowerPoint có engine COM riêng; `.odt`, `.ods`, `.odp` dùng đúng engine Office tương ứng khi có. Capability runtime trả đủ engine theo 11 extension thay vì một boolean tổng quát.
- Office giữ serial gate một suất; Google dùng scheduler kind riêng nên tải Google không bị một job Office chậm giữ hàng.
- UI truyền `AbortSignal` cho single, Google, batch và resize; nút Dừng hủy file hiện tại, unmount hủy backend job và generation fence chặn callback cũ mở file.
- Google Drive dạng `open?id=...` được nhận; Drive folder bị từ chối với thông báo rõ. LibreOffice không còn âm thầm bỏ qua lựa chọn phân trang Excel.
- Runtime phát hiện thêm race PowerPoint: `DispatchEx` có thể khởi động `/AUTOMATION -Embedding` trước khi worker kịp công bố HWND/PID. Runner nay chờ ngắn tối đa 3 giây chỉ trên đường cleanup Office, gọi được HWND dạng property hoặc callable, rồi quét PID lần hai sau khi dừng worker. Không kill theo tên tiến trình và không đụng PID Office có sẵn của người dùng.

Verify cuối:

| Kiểm tra | Kết quả |
|---|---:|
| Engine + runner + route lifecycle + resize + API contract | 113/113 pass |
| UI `OfficeConvertTool` | 7/7 pass |
| TypeScript `npm run typecheck` | Pass |
| Capability runtime máy thật | Word/Excel/PowerPoint true, LibreOffice false, 11/11 extension có engine |
| DOCX → PDF → first tile | Pass; IPC 23 ms |
| XLSX → PDF → first tile | Pass; IPC 20 ms |
| PPTX → PDF → first tile | Pass; IPC 22 ms |
| Hủy PPTX 500 slide đang `converting` | HTTP 409, phase `cancelled`, terminal true |
| Thu hồi tiến trình sau hủy | 3.277 giây; không còn PID Office mới |

Fixture và response runtime nằm tại `C:\tmp\prynx_office_runtime_20260802_125752`; log first-tile tại `C:\Users\Khanh Pham\Desktop\PrynX_RenderPerf.log`. PID Excel 52308 đã tồn tại trước test và vẫn được giữ nguyên.

Lô 5 đóng `§OFFICE.1`, `§OFFICE.2` và `§FORMAT.1`. Streaming upload/download và zero-copy output vẫn thuộc `§BE.2` của Lô 6, không bị đánh dấu đóng nhầm ở đây.

## 18. Kết quả triển khai Lô 6 — backend responsive, bounded-memory và Combine job

Lô 6 được chia thành các sub-lô tối đa năm file. Mức xác nhận hiện tại là code + kiểm thử tự động theo phạm vi; không suy ra runtime sidecar/Tauri cho các đường chưa smoke.

### Lô 6A — Upload fail-fast (`§BE.1`, `§BE.3`)

Ba file:

1. `backend/app/api/routes/upload.py`
2. `backend/app/utils/file_handler.py`
3. `backend/tests/test_upload_fail_fast.py`

Upload chỉ trả thành công sau khi kiểm đuôi không phân biệt hoa/thường, signature, strict PDF parse, encryption/password, số trang và metadata. Lỗi lưu/parse/DB rollback dọn bản backend sở hữu; file nguồn local không bị xóa. Metadata nặng chạy ngoài event loop và có test health song song.

### Lô 6B — Document routes và unlock streaming (`§BE.1`, `§BE.2`)

Năm file:

1. `backend/app/api/routes/document_tools.py`
2. `backend/app/api/routes/pdf_tools.py`
3. `backend/app/main.py`
4. `backend/tests/test_document_tools_routes.py`
5. `backend/tests/test_api_contract.py`

Quick color/layers/layer preview/text/meta và unlock được tách khỏi god-file, đăng ký router thật và chạy sync work trong threadpool. Unlock ghi input/output theo path, giữ `pdfium_guard()` ngắn quanh PDFium và trả `FileResponse`, không giữ hai bản bytes toàn file trong RAM.

### Lô 6C — Detect-shape không chặn event loop (`§BE.1`)

Bốn file:

1. `backend/app/api/routes/imposition.py`
2. `backend/app/core/detect_shape_service.py`
3. `backend/tests/test_detect_shape_coalescing.py`
4. `backend/tests/test_god_file_ratchet.py`

Canonicalization và CPU phase được offload; request trùng khóa dùng chung inflight task, client hủy không hủy công việc dùng chung. Test khóa event-loop responsiveness và cache key. `imposition.py` được kéo về đúng ratchet hiện tại; `nup_engine.py` vẫn là nợ god-file baseline riêng.

### Lô 6D1 — Streaming Office/Google (`§BE.2`)

Bốn file:

1. `backend/app/api/routes/office_convert.py`
2. `backend/app/workers/office_convert_engine.py`
3. `backend/tests/test_office_convert_routes.py`
4. `backend/tests/test_office_convert_engine.py`

Multipart Office được copy theo chunk trong worker thread; Google dùng streaming response theo chunk, kiểm `%PDF`/HTML private và dung lượng đĩa khi có `Content-Length`. Không còn `await file.read()` hoặc `response.content` toàn file ở các đường này.

### Lô 6D2 — Office Tauri path → path (`§BE.2`)

Bốn file:

1. `desktop/src/components/preprocess-tools/OfficeConvertTool.tsx`
2. `desktop/src/components/preprocess-tools/OfficeConvertTool.test.tsx`
3. `desktop/src/lib/api.ts`
4. `desktop/src-tauri/src/lib.rs`

Tauri gửi native source path, nhận native result path và giữ path xuyên viewer; resize dùng `consume_source=true`; batch dùng `copy_batch_pdf`. Web fallback vẫn nhận Blob. Verify đã biết: UI Office 9/9, backend Office 97/97, typecheck/py_compile/diff-check đạt. Runtime path đã đo: DOCX convert 6.158 ms, 116.393 byte; resize 42 ms; native first-page render 614 ms, JPEG 31.571 byte; intermediate được xóa đúng.

### Lô 6E — Admission sau manifest expansion (`§COMB.2`)

Hai file:

1. `backend/app/workers/pdf_manifest_engine.py`
2. `backend/tests/test_pdf_manifest_engine.py`

Engine đếm trang thật sau whole-file expansion, số lần lặp và ảnh trước append. Máy dưới 8 GB/16 GB có page cap riêng; máy từ 16 GB không có page cap mặc định, nhưng mọi máy vẫn admission theo RAM/đĩa khả dụng chia theo số slot. Có override vận hành, progress và cooperative cancel.

### Lô 6F1 — Backend Combine job chung (`§COMB.2`)

Năm file:

1. `backend/app/api/routes/pdf_tools.py`
2. `backend/app/api/routes/combine_jobs.py`
3. `backend/app/core/combine_jobs.py`
4. `backend/app/workers/pdf_manifest_engine.py`
5. `backend/tests/test_pdf_manifest_jobs.py`

Job có start/status/cancel/result, progress, queue gate theo tài nguyên, cancel hợp tác, `.partial.pdf` + atomic publish, cleanup/TTL và giữ kết quả path đủ lâu cho workspace. `source_paths` là mảng path hoặc `null`, giữ đúng thứ tự native/upload và chỉ upload các mục `null`. Ba mode `manifest`, `merge_files`, `interleave` dùng cùng lifecycle; legacy PDF-only từ chối ảnh trước enqueue.

### Lô 6F2 — API Combine job

Hai file:

1. `desktop/src/lib/api.ts`
2. `desktop/src/lib/api.mergeManifest.test.ts`

API start/poll/result dùng mixed zero-copy, trả native path trong Tauri, gửi đúng một cancel và reject `AbortError`. Wrapper `backendMergePdfsJob` đưa `merge_files/interleave` qua cùng endpoint thay vì multipart/Blob sync.

### Lô 6F3 — CombineTab progress/cancel/result

Bốn file:

1. `desktop/src/components/CombineTab.tsx`
2. `desktop/src/lib/combineTransport.integration.test.tsx`
3. `desktop/src/i18n/locales/vi.json`
4. `desktop/src/i18n/locales/en.json`

Cả manifest merge và delegated Interleave dùng AbortController, progress, nút Dừng, generation fence và abort khi unmount. Callback cũ không được mở tab; native result path được giữ tới viewer.

### Lô 6F4 — Merge/Interleave từ process handler

Hai file:

1. `desktop/src/lib/processHandlers.ts`
2. `desktop/src/lib/processHandlers.test.ts`

Delegated `merge_files/interleave` dùng `backendMergePdfsJob`, nối cancel handler/progress và giữ result path khi mở tab hoặc commit working file. Như vậy `§COMB.2` đã đóng về code/test cho cả manifest lẫn các consumer legacy đã audit.

### Runtime closeout Combine job — sidecar nạp code mới

Lượt đầu dùng sidecar tạm `127.0.0.1:8322` để không gián đoạn app. Sau full regression, sidecar 8321 cũ được thay bằng tiến trình khởi động từ working tree hiện tại; health đạt và OpenAPI có đủ bốn route job. Các số dưới đây là runtime HTTP/backend thật, không được dùng thay cho thao tác UI Tauri:

- Merge hai PDF bằng native path đi qua `queued/starting → completed`, trả native result path và PDF kết quả có đúng tổng hai trang nguồn.
- Interleave hai nguồn 2.500 trang hoàn tất 5.000 trang trong 7.015 ms. Poll ghi 104 thay đổi trạng thái, phủ `inspecting → merging 0–100% → saving → watermarking → completed`.
- Lặp lại 5.000 trang trên chính cổng 8321 sau restart cũng completed; 187 health probe trong lúc job chạy có trung vị 5,82 ms và tối đa 15,99 ms.
- PDF kết quả 1.168.133 byte có thứ tự chiều rộng sáu trang đầu `200, 400, 200, 400, 200, 400`; PDFium mở và render trang đầu trong 3 ms.
- Hủy giữa lúc `merging` ở 2% (100/5.000 trang) chuyển `cancel_requested → cancelled`; cả output và `.partial.pdf` đều đã được dọn.
- Mixed `[native path, upload]` hoàn tất, chỉ upload mục in-memory, trả native result path và có đúng 2/2 trang mong đợi.
- Verify closeout không cộng trùng: backend engine/job + ma trận giao nhau 204 test duy nhất đạt; frontend consumer/API 19/19 và typecheck đạt; UTF-8/diff-check đạt.
- Full Vitest cuối: 170/171 file đạt, 1.689 test pass, 2 skip; hai lỗi còn lại là snapshot baseline `mixedExcessPercent`/`resizeSettings`, không cập nhật golden.
- Full pytest cuối: 2.028 pass, 5 skip, 3 fail baseline — ratchet `nup_engine.py` 4.033/3.716 dòng và hai ca `sticker_homogeneous_integration` thuộc thay đổi khác trong dirty tree.
- Rust full đã biết: 44/44 đạt khi loại đúng ca PDFium rotation treo baseline; folder oracle riêng 3/3 đạt.

Sau bằng chứng này, `§COMB.2` đóng ở tầng implementation/backend runtime. Việc bấm progress/Dừng và mở native result path tới first tile trong chính app Tauri vẫn thuộc gate `§TEST.1`.

## 19. Kết quả triển khai Lô 7 — dispatcher và ma trận định dạng

### Lô 7A — Dispatcher chung và cold-start intent

Năm file:

1. `desktop/src/App.tsx`
2. `desktop/src/hooks/useIncomingFileDispatcher.ts`
3. `desktop/src/hooks/useIncomingFileDispatcher.test.tsx`
4. `desktop/src/components/SystemIntegrations.tsx`
5. `desktop/src/components/SystemIntegrations.test.tsx`

Picker/Recent/startup/Open With/native drop/DOM drop hội tụ tại một dispatcher. Intent Combine/Convert chờ poll đầu đóng batch, có fallback hữu hạn và không tách file từ nhiều process thành tab sai. Oracle định tuyến đủ PDF, 7 ảnh và 11 Office, kể cả đuôi viết hoa.

### Lô 7B — Ảnh → PDF và terminal UI

Năm file:

1. `desktop/src/lib/imageNormalizer.ts`
2. `desktop/src/lib/imageNormalizer.test.ts`
3. `desktop/src/components/ImpositionTab.tsx`
4. `desktop/src/i18n/locales/vi.json`
5. `desktop/src/i18n/locales/en.json`

PNG/JPG/JPEG/WebP/BMP/TIF/TIFF được chuẩn hóa thành PDF một trang. Sau 8 giây chỉ đổi sang cảnh báo chậm, không hard-timeout; có Thử lại/Hủy và generation fence. Ảnh hỏng đi tới error terminal. Lượt test liên quan đã báo 35/35; chưa có runtime WebP/BMP/TIFF thật hoặc component test trực tiếp cho mọi nhánh UI terminal.

### Lô 7C1 — Nguồn chân lý định dạng

Năm file:

1. `desktop/src/lib/imageFileTypes.ts`
2. `desktop/src/lib/imageNormalizer.ts`
3. `desktop/src/lib/officeFileTypes.ts`
4. `desktop/src/lib/nativeFileAccess.ts`
5. `desktop/src/components/CombineTab.tsx`

Nguồn chân lý là PDF + 7 ảnh + 11 Office. Home/Ctrl+O/Combine/native path dùng cùng danh sách; Google Docs/Sheets/Slides, Drive `/file/d/`, `open?id=` được nhận và folder bị từ chối. Parity ảnh/Combine/dispatcher đã báo 46/46; Home/System/dispatcher/Office đã báo 29/29.

### Lô 7C2 — Recent Office

Năm file:

1. `desktop/src/App.tsx`
2. `desktop/src/lib/useRecentFiles.ts`
3. `desktop/src/components/RecentFiles/RecentFilesGrid.tsx`
4. `desktop/src/components/RecentFiles/ThumbnailView.tsx`
5. `desktop/src/lib/useRecentFiles.office.test.ts`

Office single/batch được ghi Recent, khử trùng path và dùng MIME/placeholder terminal theo tên thay vì thử đọc như ảnh. Test Recent Office đã báo 2/2; UI Office 9/9.

### Lô 7D — N-Up terminal, PDF uppercase và folder oracle

Bốn file:

1. `backend/app/api/routes/imposition.py`
2. `backend/tests/test_nup_job_lifecycle.py`
3. `backend/tests/test_imposition_file_case.py`
4. `desktop/src-tauri/src/lib.rs`

Child N-Up thoát mã 0 nhưng thiếu state chuyển `failed` terminal; `/execute-plan` nhận `FILE.PDF`. Rust folder scan dùng oracle độc lập PDF + 11 Office, đuôi hoa và bỏ `~$`. Backend Office/N-Up/uppercase đã báo 27/27; Rust folder 3/3.

## 20. Closeout và các chốt chưa nghiệm thu

Về code/test theo phạm vi và backend runtime Combine, các finding đã đóng trừ:

- `§REL.1`: relevant code/test/docs vẫn ở working tree; `HEAD` chưa chứa bản vá.
- `§TEST.1`: tự động hóa đã tăng nhưng chưa chứng minh toàn ma trận người dùng/môi trường.

`§COMB.2` đã đóng về implementation/backend runtime sau khi cả manifest, `merge_files` và `interleave` dùng job chung. Các chốt sau vẫn bắt buộc trước khi ghi “hoàn tất toàn bộ”:

1. Backend cổng 8321 đã nạp code hiện tại, health và route job đạt. Còn smoke trực tiếp trên Tauri: progress, nút Dừng, result native path và first tile.
2. Smoke local/D:/Unicode, Home picker, native/DOM drop, Recent, folder, WebP/BMP/TIFF, Office và Google.
3. Chạy UNC/NAS/USB thật khi có đường/môi trường; test chuỗi UNC không thay thế runtime share.
4. Chạy full regression frontend/backend/Rust và ghi riêng các baseline failure; không cộng các lượt test giao nhau.
5. Commit atomically code + test + hai tài liệu, rồi verify clean checkout/clean clone/release build. “Rebuild sau `cargo clean`” trong dirty working tree không phải clean-checkout gate.

Nợ baseline ngoài phạm vi closeout: `lint:budget` toàn repo, lint cũ trong `ImpositionTab.tsx` và god-file ratchet của `nup_engine.py`. Không nâng budget hoặc sửa ké trong audit này.
