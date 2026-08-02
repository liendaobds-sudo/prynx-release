# BÁO CÁO AUDIT LUỒNG MỞ FILE, COMBINE VÀ CONVERT

**Ngày:** 2026-08-02  
**Phạm vi:** mọi cửa nhận file của ứng dụng desktop; PDF/ảnh/Office; file từ ổ cục bộ, USB, UNC/NAS, Recent/recovery, thư mục và link Google; đầu ra Combine/Convert mở lại trong viewer.  
**Trạng thái:** **Giai đoạn 2 — đã khảo sát và lập báo cáo; CHƯA sửa mã. Chờ chủ dự án duyệt trước khi triển khai.**  
**Mốc mã:** worktree hiện tại trên `HEAD 70ef2a6` (2026-07-30), đang có nhiều thay đổi chưa commit từ các đợt khác. Mọi số dòng trong báo cáo trỏ vào worktree tại thời điểm audit.  
**Đầu vào chẩn đoán:** ảnh người dùng cung cấp và `C:\Users\Khanh Pham\Desktop\PrynX_Performance.log`.

## 1. Kết luận điều hành

Lỗi trong ảnh **không còn nằm ở bước đọc metadata chính của `usePdfLoader`**. Ảnh khớp chính xác skeleton `Loading...` của `LivePageFrame`; log runtime lúc `2026-08-02 04:54:47` cho thấy tab đang xem đã có `loadStatus="ready"`, `numPages=2`, sau đó tile được xếp lịch và chạy nhưng nhận lỗi `Yêu cầu dựng hình đã bị hủy`. Một lượt sau mới có `tile-native-done` và `live-tile-load-ready`.

Do đó, ca hiện tại là lỗi ở tầng **dựng tile/scheduler sau khi tài liệu đã mở**, không phải chỉ là “file lớn nên tải chậm”. Tại tầng này có hai lỗi P1 trực tiếp:

1. Tile render hoặc decode ảnh lỗi bị nuốt; UI không có trạng thái lỗi, retry hay lần render mới, nên skeleton có thể tồn tại vĩnh viễn.
2. Scheduler tile toàn cục chỉ có một suất. Nếu một Promise native không settle, suất đó không bao giờ được trả và mọi file/tab mở sau cùng đứng ở `Loading...`.

Audit cũng tìm thấy hai chuỗi “đầu độc hàng đợi” tương tự ngoài viewer:

- File UNC/NAS/ổ liên kết có thể treo ở `std::fs::read()` trong lúc đang giữ khóa cache tài liệu toàn cục của Tauri; tài liệu khác bị chặn theo.
- Word/Excel COM không có deadline và chạy trong slot Office dùng chung duy nhất; một file có prompt ẩn, password, repair hoặc external link có thể làm mọi Office/Google job sau chờ vô hạn.

Ngoài nguyên nhân Loading, các cửa mở file hiện không có cùng hành vi. Native drag-drop làm mất vị trí thả; menu **Combine in PrynX** không mang intent Combine; Recent/recovery dùng API `stat` không được cấp quyền cho ổ D/USB/UNC; whitelist ảnh của global drop hẹp hơn các công cụ ảnh. Vì vậy có file hợp lệ nhưng bị mở sai tab, không tới đúng ô Compare/Combine/Office, hoặc bị báo “Missing”.

Tổng cộng báo cáo ghi nhận:

- **11 finding P1** ảnh hưởng trực tiếp tới mở file, liveness hoặc tính đúng của handoff.
- **8 finding P2** về batch, định dạng, trạng thái job và khoảng trống điều phối.
- **1 finding P3** về phần mở rộng PDF viết hoa.

Không có bằng chứng cho thấy mọi PDF/PNG đều hỏng. Các bản vá loader/Combine ngày 2026-08-01 trong worktree đã xử lý một lỗi cũ khác; không nên hoàn tác hoặc báo lại `catch` rỗng của loader hiện tại. Tuy nhiên, các bản vá đó chưa nằm trong `HEAD`, nên một build từ checkout sạch vẫn có thể mang lại lỗi spinner cũ.

## 2. Phạm vi đã truy vết

### 2.1 Cửa nhận file

| Cửa vào | Đường mã chính | Kết quả audit |
|---|---|---|
| File → Open / Ctrl+O / picker Home | `App.tsx:871-922`, `HomeTab.tsx:306-330` | Có phân loại PDF, Office, PNG/JPG; chưa có integration test qua tab đích |
| Empty workspace picker/drop | `ImpositionTab.tsx:2432-2457` | Nhận PDF/PNG/JPG; ID input bị trùng giữa nhiều tab |
| Double-click / Open with | `SystemIntegrations.tsx:73-103` → `App.tsx:1006-1086` | Một file có đường đi; multi-select cold-start có thể bị chia lô |
| Explorer “Combine in PrynX” | `desktop/src-tauri/installer-hooks.nsh:31-51` | PDF bị mở thành từng tab; không có intent Combine |
| Explorer “Convert to PDF” | `installer-hooks.nsh:38-58` → `App.tsx:1051-1055` | Có intent cho PNG/JPG; không đăng ký WebP/BMP/TIFF |
| Native drag-drop Tauri | `SystemIntegrations.tsx:105-137` | Mất `position`/drop-target; event toàn cục hút drop của tool con |
| DOM drag-drop web/dev | `SystemIntegrations.tsx:139-179` | Dropzone con có thể tự xử lý; Home đang nuốt drop |
| Compare ô A/B | `CompareTab.tsx:277-295`, `PDFUploader.tsx:43-50` | DOM path đúng; native Tauri path không tới đúng ô |
| Combine add/drop/output | `CombineTab.tsx` → manifest/frontend assembly → viewer | Helper/route có test; chưa có test xuyên suốt click/drop → viewer |
| Office file/batch/folder | `OfficeConvertTool.tsx`, Rust batch commands, `/office-convert/file` | Có đường chức năng; thiếu timeout, E2E và capability theo định dạng |
| Google link | `OfficeConvertTool.tsx:263+`, `office_convert_engine.py:299-365` | Chỉ link Docs/Sheets/Slides/Drive file công khai; không nhận folder/private OAuth |
| Recent/recovery | `useRecentFiles.ts:134-146`, `App.tsx:590-614` | File ngoài scope plugin-fs bị báo thiếu oan |
| Kết quả Convert/Combine mở lại | `onFileFixed`/spawn tab → `usePdfLoader` → `LivePageFrame` | Metadata có thể ready nhưng tile vẫn Loading vô hạn |

### 2.2 Ma trận định dạng thực tế

| Nhóm | Viewer/mở trực tiếp | Combine | Convert/công cụ | Giới hạn hoặc bất nhất |
|---|---|---|---|---|
| PDF | Có, ưu tiên native path | Có | Compare, imposition, N-Up, công cụ PDF | Corrupt/0-byte có đường upload fail-open; `.PDF` bị từ chối ở một số route |
| PNG, JPG, JPEG | Có đường ảnh → PDF | Có, frontend hoặc manifest backend | Context Convert và công cụ ảnh | Native drop global có nhận |
| WebP | Không có trong picker/drop toàn cục | Không có trong manifest Combine | Có trong một số công cụ ảnh và `/api/upload` | Cửa vào không parity với tool đích |
| BMP, TIF, TIFF | Không có trong picker/drop toàn cục | Không có | Upscale/tách nền nhận qua picker/drop cục bộ | Native drop bị lọc trước khi routing |
| DOC, DOCX, ODT, RTF | Đi Office Convert | Không | Word COM hoặc LibreOffice | ODT qua Word chỉ khi Word nhận được; chưa có E2E |
| XLS, XLSX, CSV | Đi Office Convert | Không | Excel COM hoặc LibreOffice | Có nguy cơ prompt/external link treo COM |
| ODS | Đi Office Convert | Không | Thực tế cần LibreOffice | UI vẫn có thể báo Office “sẵn sàng” chỉ vì Word/Excel có mặt |
| PPT, PPTX, ODP | Đi Office Convert | Không | Thực tế chỉ LibreOffice trong code hiện tại | Không có PowerPoint COM path |
| Google Docs/Sheets/Slides | Không mở như file local | Không | Export link công khai sang PDF | Không OAuth; link private/login HTML bị từ chối |
| Google Drive file | Không mở như folder | Không | Chỉ URL file trả trực tiếp PDF | Không hỗ trợ Google Drive folder |
| AI, EPS, PSD, SVG, CDR, INDD | Không thấy ingestion backend | Không | Không có converter trong phạm vi audit | Đây là giới hạn hỗ trợ, không kết luận là bug |

Whitelist Office 11 định dạng hiện khớp giữa frontend, backend và Rust, nhưng đang lặp ở ba nơi và không có test parity dạng bảng: `desktop/src/lib/officeFileTypes.ts:5-8`, `backend/app/workers/office_convert_engine.py:27-30`, `desktop/src-tauri/src/lib.rs:972-983`.

## 3. Bằng chứng runtime cho màn Loading hiện tại

### 3.1 Ảnh khớp lớp dựng trang, không phải spinner metadata

- Skeleton trong ảnh có spinner nhỏ và chuỗi `Loading...`, đúng JSX tại `desktop/src/components/workspace/LivePageFrame.tsx:2767-2776`.
- Skeleton luôn nằm dưới tile. Nó chỉ bị che khi ảnh tile có URL và opacity được bật.
- Spinner metadata của `AcrobatViewer` có layout/chuỗi khác và chỉ dùng khi tài liệu chưa có số trang.

### 3.2 Chuỗi log xác nhận tài liệu đã ready trước khi tile lỗi

Rút gọn log, không ghi tên hoặc full path của người dùng:

```text
04:54:47.893 viewer-render-state  loadStatus=ready, numPages=2, isZoomReady=true
04:54:47.872 live-tile-load-start page=1
04:54:47.892 tile-scheduler-enqueue
04:54:47.896 tile-scheduler-run
04:54:47.896 live-tile-load-error "Yêu cầu dựng hình đã bị hủy"
04:54:47.935 tile-scheduler-enqueue
04:54:48.272 tile-native-done invokeMs=293, bytes=35073
04:54:48.273 live-tile-load-ready
```

Log chứng minh ba điểm:

1. Metadata và kích thước trang đã sẵn sàng.
2. Render đầu bị cancel/supersede.
3. Hệ thống không có trạng thái lỗi hiển thị tương ứng; chỉ may mắn hết Loading nếu một render sau tự được kích và thành công.

## 4. Bảng finding

| Mã | Mức | Tin cậy | Effort | Phát hiện |
|---|---:|---|---:|---|
| §OPEN.TILE.1 | **P1** | Runtime + code | M | Tile reject/decode-error bị nuốt, skeleton có thể tồn tại vĩnh viễn |
| §OPEN.TILE.2 | **P1** | Code chắc chắn | M-L | Một Promise native treo giữ scheduler tile toàn cục mãi |
| §OPEN.NAS.1 | **P1** | Code chắc chắn, runtime NAS chưa chạy | M-L | Đọc file mạng trong lúc giữ `DOC_CACHE` toàn cục có thể chặn mọi tài liệu |
| §OPEN.DROP.1 | **P1** | Code chắc chắn | M-L | Native drop mất drop-target của Compare/Combine/Office/công cụ ảnh |
| §OPEN.COMBINE.1 | **P1** | Code chắc chắn | M | Menu “Combine in PrynX” cho PDF mở từng PDF riêng |
| §OPEN.RECENT.1 | **P1** | Code chắc chắn | S-M | Recent/recovery báo Missing oan cho D:/USB/UNC/NAS |
| §OPEN.OFFICE.1 | **P1** | Code chắc chắn | L | Word/Excel COM treo giữ slot Office/Google duy nhất |
| §OPEN.LOOP.1 | **P1** | Code chắc chắn | M | Nhiều endpoint mở/preview PDF chặn event loop sidecar |
| §OPEN.RAM.1 | **P1** | Code chắc chắn | M | Office/Google/unlock buffer toàn payload, có thể OOM làm sidecar biến mất |
| §OPEN.UPLOAD.1 | **P1** | Code chắc chắn | M | Upload nhận PDF rỗng/hỏng rồi vẫn trả success; ảnh luôn được serve là PDF |
| §OPEN.RELEASE.1 | **P1** | Git chắc chắn | M | Bản vá loader/Combine đang ở dirty worktree, checkout sạch vẫn có spinner cũ |
| §OPEN.BATCH.1 | P2 | Code chắc chắn | M | Context-menu multi-select lúc cold-start có thể bị chia lô |
| §OPEN.DOM.1 | P2 | Code chắc chắn | S | Home DOM drop ngăn global fallback nhưng không nhận file |
| §OPEN.ROUTE.1 | P2 | Code chắc chắn | S | ID input cố định có thể nạp file vào workspace nền |
| §OPEN.FMT.1 | P2 | Code chắc chắn | S | Native drop lọc WebP/BMP/TIFF dù tool ảnh hỗ trợ |
| §OPEN.COMBINE.2 | P2 | Code chắc chắn | S | Thumbnail Combine lỗi retry 5 lần rồi vẫn hiện `Loading...` vĩnh viễn |
| §OPEN.COMBINE.3 | P2 | Code chắc chắn | M | Manifest expand không bị chặn theo tổng trang và không có progress/cancel |
| §OPEN.OFFICE.2 | P2 | Code chắc chắn | M | Capability Office báo theo máy, không theo từng định dạng |
| §OPEN.NUP.1 | P2 | Code chắc chắn | S | N-Up có khe trạng thái `running` mãi khi worker không tạo state file |
| §OPEN.EXT.1 | P3 | Code chắc chắn | S | Một số route từ chối `.PDF` viết hoa |

## 5. Chi tiết finding P1

### §OPEN.TILE.1 — Lỗi tile không có trạng thái kết thúc

**Bằng chứng**

- `LivePageFrame.tsx:376-380`: `preImg.onerror` chỉ xóa ref và `loadedParamsRef`; không set error, retry hay yêu cầu render lại.
- `LivePageFrame.tsx:384-387`: Promise render reject cũng chỉ reset ref; lỗi bị bỏ hoàn toàn.
- `LivePageFrame.tsx:2767-2776`: skeleton luôn render bên dưới tile.
- Log runtime đã có `live-tile-load-error` đúng lúc viewer `ready`.

**Tác động**

Render bị supersede/cancel, native invoke reject, blob JPEG hỏng hoặc WebView decode lỗi đều có thể để nguyên màn hình trong ảnh người dùng. UI không phân biệt “đang dựng”, “đã bị hủy” và “dựng thất bại”.

**Khuyến nghị**

Định nghĩa state terminal cho tile (`idle | queued | rendering | ready | error | cancelled | slow`), chỉ xem supersede là im lặng khi chắc chắn có request thay thế. Mọi lỗi cuối chuỗi phải hiện thông báo tiếng Việt và nút Thử lại. Thêm retry có giới hạn/backoff cho decode-error; không retry vô hạn.

### §OPEN.TILE.2 — Scheduler tile toàn cục không có liveness production

**Bằng chứng**

- `tileRenderScheduler.ts:37-46,186`: scheduler singleton, `maxConcurrent=1`.
- `:155-181`: `activeCount` chỉ giảm trong `.finally()` sau khi `task.run()` settle.
- `:90-109,188-195`: code tự ghi nhận IPC có thể mất callback và giữ `activeCount=1`, nhưng reset chỉ nối vào HMR/dev.

**Tác động**

Một invoke không settle làm mọi tile của mọi tab nằm trong queue mãi. Đây là cơ chế phù hợp nhất với triệu chứng “một file lỗi rồi file nào mở sau cũng Loading”.

**Khuyến nghị**

Thêm watchdog/circuit-breaker quan sát được ở production, generation-fence kết quả muộn và log độ dài queue/tuổi task. Không được đơn giản tăng concurrency hoặc thả suất rồi bắn vô hạn: PDFium vẫn phải được serialize bằng khóa native. Khi task quá hạn, UI phải có đường phục hồi hữu hạn; test phải chứng minh một task không settle không khóa vĩnh viễn mọi owner.

### §OPEN.NAS.1 — Khóa cache toàn cục bao quanh I/O mạng

**Bằng chứng**

- `desktop/src-tauri/src/lib.rs:400-427` khóa `DOC_CACHE` tại `:401`.
- Trong lúc còn giữ khóa, code gọi `std::fs::read(&file_path)` tại `:407-408`, tải cả file vào RAM, rồi mở PDFium tại `:409-411`.
- Khóa chỉ được thả tại `:427`.
- `usePdfLoader` có thể hủy generation/UI nhưng không hủy vật lý Rust invoke đang chạy.

**Tác động**

UNC/NAS/ổ USB/OneDrive placeholder mất kết nối có thể chờ rất lâu trong Windows I/O. Vì khóa cache toàn cục đang bị giữ, metadata/render của file cục bộ khác cũng bị chặn.

**Khuyến nghị**

Không giữ `DOC_CACHE` trong khi đọc file hoặc load PDFium. Dùng single-flight/per-key initialization: đọc/stage file ngoài global map lock, sau đó khóa ngắn để publish handle. File mạng lớn nên được stream/stage có progress và cancel; không buffer toàn file trong vùng khóa.

### §OPEN.DROP.1 — Native drop làm mất ý định vị trí

**Bằng chứng**

- Native drag-drop được bật trong `desktop/src-tauri/tauri.conf.json:25`.
- Payload Tauri có `paths` và `position`, nhưng `SystemIntegrations.tsx:109-136` chỉ lấy `paths`, rồi phát event toàn cục tại `:68-70`.
- `App.tsx:1031-1048` luôn tách PDF và mở từng PDF vào tab Imposition trước mọi nhánh khác.
- Compare dựa vào hai `PDFUploader` riêng tại `CompareTab.tsx:277-295`; uploader đọc `dataTransfer.files` tại `PDFUploader.tsx:43-50`.

**Tác động**

- Thả PDF vào ô A/B Compare không đi vào ô đó.
- Thả PDF vào Combine không ghép mà mở thành nhiều tab.
- Thả vào Office hoặc tool ảnh đang mở có thể tạo tab/route toàn cục khác với mục tiêu người dùng nhìn thấy.

**Khuyến nghị**

Giữ `position`, hit-test target đang active hoặc đăng ký receiver theo tab/tool. Ưu tiên dropzone cụ thể trước dispatcher toàn cục. Event phải mang `source`, `intent`, `targetTabId`, `position`, danh sách file đã phân loại.

### §OPEN.COMBINE.1 — Context menu Combine không có intent Combine

**Bằng chứng**

- Installer đăng verb Combine cho PDF/JPG/JPEG/PNG nhưng command chỉ là `pdf-inspector.exe "%1"`: `installer-hooks.nsh:31-51`.
- Chỉ verb Convert truyền `--prynx-action=convert`: `:38-58`.
- Dispatcher luôn mở từng PDF riêng tại `App.tsx:1031-1037`.

**Tác động**

Chọn nhiều PDF trong Explorer rồi bấm **Combine in PrynX** không thực hiện đúng tên lệnh. Một ảnh duy nhất với verb Combine cũng đi theo luồng mở mặc định thay vì Combine.

**Khuyến nghị**

Thêm intent riêng `--prynx-action=combine` và test single/multi/mixed. Không suy intent chỉ từ số file vì Open With nhiều file và Combine là hai hành động khác nhau.

### §OPEN.RECENT.1 — Recent/recovery dùng API ngoài scope

**Bằng chứng**

- `useRecentFiles.ts:134-146` gọi plugin-fs `stat()` và coi mọi exception là file mất.
- Capability `fs:allow-stat` chỉ cho Documents/Downloads/Desktop/AppData/Temp: `desktop/src-tauri/capabilities/default.json:20-26`.
- `App.tsx:594-609` recovery cũng chỉ `stat()` rồi báo không khôi phục được.
- Trong khi đó `SystemIntegrations.tsx:46-60` đã có Rust `get_file_size` vì plugin-fs không dùng được cho NAS.

**Tác động**

File hợp lệ ở `D:\`, USB hoặc `\\server\share` bị đánh dấu Missing; recovery có thể xóa snapshot cũ sau khi báo không khôi phục được.

**Khuyến nghị**

Dùng cùng Rust stat/fallback đã có, phân biệt `not_found`, `permission_denied`, `offline`, `timeout`. Chỉ đánh dấu Missing khi hệ điều hành xác nhận `not_found`.

### §OPEN.OFFICE.1 — COM không có deadline, đầu độc slot Office

**Bằng chứng**

- `office_convert_engine.py:174-209,212-256` gọi `Documents.Open`, `SaveAs`, `Workbooks.Open`, `ExportAsFixedFormat`, `Close`, `Quit` trong process/thread hiện tại, không deadline và không có process riêng để kill.
- `/office-convert/file` và `/office-convert/google` chờ trực tiếp scheduler tại `pdf_tools.py:1290-1298,1341-1348`.
- Mọi Office/Google dùng slot đơn `_SERIAL_SLOTS`: `heavy_job_scheduler.py:71-74,121-124`.

**Tác động**

DOCX/XLSX có password, protected view, repair, external link hoặc prompt ẩn có thể treo vĩnh viễn. Google export hợp lệ gửi sau cũng chờ slot, dù không dùng COM.

**Khuyến nghị**

Chạy mỗi COM conversion trong worker process được giám sát, có deadline theo trạng thái tiến triển, đóng/kill cả cây process khi hủy hoặc quá hạn, rồi chắc chắn trả slot. Google download không nên dùng chung poison domain với COM.

### §OPEN.LOOP.1 — Endpoint async làm việc đồng bộ trên event loop

**Bằng chứng**

- `upload.py:97-118` gọi metadata đồng bộ; `pdf_processor.py:131-143,181-218` có thể quét toàn bộ trang và nhiều content stream.
- `imposition.py:271-540,744-776` có nhiều `async def` nhưng chạy pikepdf/pdfplumber/parser trực tiếp.
- `/pdf-layers/preview` còn chờ khóa PDFium tại `layer_engine.py:966-986` ngay trên event loop.
- Mẫu offload đúng đã tồn tại ở `preflight.py:740-741,755-770`.

**Tác động**

Một file nặng làm `/health`, upload, preview và các request UI khác không phản hồi; frontend nhìn giống sidecar chết hoặc loading vô hạn.

**Khuyến nghị**

Offload công việc sync ngắn sang threadpool; công việc PDF nặng sang process pool/scheduler. Mọi lời gọi PDFium trong thread phải dùng `pdfium_guard()` và giữ vùng khóa ngắn.

### §OPEN.RAM.1 — Buffer toàn payload

**Bằng chứng**

- Office multipart: `pdf_tools.py:1267-1275` dùng `content = await file.read()`.
- Google: `office_convert_engine.py:352-358` dùng `r.content`.
- Unlock: `imposition.py:145-168` giữ input và output trong RAM.
- Giới hạn 500 MB đã được gỡ khỏi `file_handler.py`, nhưng `config.py:93` còn cấu hình không còn tác dụng.

**Tác động**

File lớn có thể tạo nhiều bản bytes đồng thời, OOM WebView/sidecar. Khi sidecar biến mất giữa request, UI thiếu terminal state nên người dùng chỉ thấy Loading.

**Khuyến nghị**

Stream upload/download vào file tạm, kiểm tra đĩa và ngân sách RAM theo hồ sơ phần cứng. Không khôi phục hard-cap vô điều kiện; máy ≥16 GB phải giữ full năng lực theo quy tắc hiệu năng dự án.

### §OPEN.UPLOAD.1 — Upload fail-open với file không dùng được

**Bằng chứng**

- `/upload/local` chỉ kiểm đuôi `.pdf`, rồi nuốt lỗi metadata và vẫn ghi DB/trả success: `upload.py:47-70`.
- Multipart chấp nhận theo đuôi PDF/PNG/JPG/WebP và cũng nuốt lỗi metadata: `upload.py:103-122`.
- `/files/{id}/serve` luôn trả `media_type="application/pdf"`: `results.py:128-137`.

**Tác động**

File 0-byte, PDF corrupt hoặc ảnh đổi đuôi có thể được báo upload thành công rồi đẩy lỗi sang Compare/viewer. Ảnh hợp lệ cũng bị serve với hợp đồng MIME PDF.

**Khuyến nghị**

Validate magic + parser/page contract trước success; trả trạng thái riêng cho PDF encrypted thay vì coi corrupt. Tách route/model cho ảnh hoặc serve đúng MIME và chỉ chuyển sang consumer có hỗ trợ ảnh.

### §OPEN.RELEASE.1 — Bản vá hiện tại chưa nằm trong HEAD

**Bằng chứng**

- `HEAD` vẫn có loader cũ: ảnh không có `onerror`, native exception chỉ ghi console, PDF.js blob có `catch` rỗng.
- Worktree hiện sửa `usePdfLoader.ts`, `AcrobatViewer.tsx`, `CombineTab.tsx`, `SystemIntegrations.tsx`, `App.tsx`, backend manifest và các test liên quan.
- Các tài liệu/bài test loader ngày 2026-08-01 vẫn untracked.

**Tác động**

Build từ thư mục hiện tại có thể chứa hardening mới, nhưng checkout sạch/CI/release từ `HEAD` sẽ mất chúng và tái phát spinner metadata cũ.

**Khuyến nghị**

Sau khi các đợt đang làm được chủ dự án nghiệm thu, cần tách/commit theo phạm vi rõ ràng. Audit này không tự stage/commit vì worktree chứa nhiều thay đổi của người dùng và đợt khác.

## 6. Chi tiết finding P2/P3

### §OPEN.BATCH.1 — Multi-select cold-start bị chia lô

Installer dùng `MultiSelectModel=Player`, Windows gọi một process cho mỗi file. File đầu được xử lý ngay từ startup args (`SystemIntegrations.tsx:73-80`), file sau chỉ tới qua poll 1 giây (`:83-103`), trong khi App debounce 50 ms (`App.tsx:1006-1082`). Khi app đang đóng, file đầu có thể mở riêng trước phần còn lại.

### §OPEN.DOM.1 — Home web/dev drop là no-op

`HomeTab.tsx:300-304` gọi `preventDefault()` nhưng không đọc file. Global fallback thấy `defaultPrevented` thì return tại `SystemIntegrations.tsx:158-169`. Nhánh native Tauri khác không chứng minh DOM fallback đúng.

### §OPEN.ROUTE.1 — Input ID trùng giữa nhiều workspace

App giữ các tab mounted; mọi `ImpositionTab` dùng `id="workspace-empty-upload"` và `document.getElementById()` tại `ImpositionTab.tsx:2438-2456`. Click ở tab active có thể kích input đứng trước trong DOM.

### §OPEN.FMT.1 — Whitelist drop không parity với tool ảnh

`isPdfOrImagePath()` chỉ nhận PDF/PNG/JPG tại `officeFileTypes.ts:32-40`, trong khi batch ảnh nhận WebP/BMP/TIF/TIFF tại `imageBatch/helpers.ts:13-20,29-34,85-105`. Picker cục bộ chạy được nhưng native drop bị loại trước khi tới tool.

### §OPEN.COMBINE.2 — Preview Combine lỗi vẫn ghi Loading

`PdfErrorBoundary` tại `CombineTab.tsx:75-89` retry năm lần rồi tiếp tục render permanent `Loading...`; không có lỗi terminal hoặc retry thủ công.

### §OPEN.COMBINE.3 — Job Combine không có vòng đời hữu hạn

Route giới hạn 256 nguồn và 4 MB manifest (`pdf_tools.py:399-403`); engine giới hạn số item (`pdf_manifest_engine.py:189-192`). Tuy nhiên một item thiếu `page_index` bung toàn bộ PDF (`:239-255`), nên tổng trang output có thể vượt xa số item. Route chờ một HTTP request duy nhất tại `pdf_tools.py:432`, không job ID/progress/cancel; retry HTTP không hủy worker cũ.

### §OPEN.OFFICE.2 — Capability không theo định dạng

`probe_converters()` đặt `can_convert_office=true` nếu có Word, Excel hoặc LibreOffice (`office_convert_engine.py:52-63`). Nhưng COM chỉ xử lý Word/Excel (`:138-148`); ODS/PPT/PPTX/ODP cần LibreOffice. UI có thể quảng bá một định dạng mà máy hiện tại không chuyển được.

### §OPEN.NUP.1 — N-Up có thể giữ `running` sau khi process chết

Parent `proc.join()` không deadline tại `imposition.py:1140`; chỉ tạo failure state nếu exit code khác 0 tại `:1151-1158`. Poll chỉ chuyển terminal nếu state file tồn tại tại `:1329-1342`. Nếu child exit 0 nhưng không ghi state file, job tiếp tục báo `running`.

### §OPEN.EXT.1 — `.PDF` viết hoa không thống nhất

Một số nhánh unlock/execute-plan tại `imposition.py:138,189` kiểm `.pdf` phân biệt hoa/thường, trong khi các route khác dùng `.lower()`.

## 7. Khoảng trống test giải thích vì sao lỗi lọt qua

### 7.1 Test đã chạy trong audit

Không sửa snapshot và không tạo thay đổi code mới ngoài báo cáo này.

| Bộ test hẹp | Kết quả |
|---|---:|
| Vitest frontend | **10 file, 56/56 pass** |
| Pytest backend | **28/28 pass**, 3 cảnh báo deprecation |
| Rust `batch_folder_tests --lib` | **3/3 pass**, 37 filtered |

Một baseline nhỏ hơn tập trung loader/scheduler/routing cũng xanh **6 file, 48/48 test**. Test xanh không phủ chuỗi runtime trong ảnh.

### 7.2 Những đường chưa được che

- Không có test `LiveTile` cho render reject, supersede không có replacement, decode-error, retry hoặc permanent error UI.
- Không có test scheduler production với `task.run()` không settle.
- `usePdfLoader.test.tsx` hiện chỉ che PDF blob; chưa che native path, HTTP fallback, ảnh `onerror`, kết quả native muộn sau cancel hoặc UI thật của viewer.
- Không có integration test từ startup/native drop/picker/context-menu qua `App` đến đúng tab.
- Không có test native drop theo vị trí vào Compare A/B, Combine, Office và công cụ ảnh.
- Không có test cold-start multi-select hoặc intent Combine/Convert.
- Không có test Recent/recovery cho ổ D, USB, UNC/NAS và OneDrive placeholder.
- Không có test xuyên suốt PNG/PDF → Combine/Interleave/In/Ghép nhóm → viewer.
- Office chỉ có parser/probe; chưa có COM/LibreOffice thật, timeout/cancel, password, protected view, Unicode/UNC, Google private/slow/large.
- Không có test parity đủ 11 extension Office qua picker, drop, folder và backend.
- Không có test sidecar responsiveness: chạy metadata/layer preview nặng đồng thời gọi `/health`.
- Không có test upload 0-byte/corrupt/encrypted/signature/MIME ảnh.

## 8. Điểm đã kiểm chéo và loại khỏi finding

- Tên event raw `tauri://drag-enter/over/drop/leave` và payload `{ paths, position }` đúng với Tauri đang cài; lỗi là bỏ `position`, không phải dùng sai tên event.
- `usePdfLoader` trong worktree hiện tại đã đưa PDF.js reject, native error và zero-page sang state lỗi; finding `catch` rỗng thuộc `HEAD`/bản cũ, không phải nguyên nhân trực tiếp của skeleton trong ảnh mới.
- Các action Combine chính có `try/finally`; spinner Combine chỉ vô hạn nếu Promise bên dưới không settle hoặc preview error boundary che lỗi.
- `getFileArrayBuffer`/local-file transport hiện hỗ trợ native path ngoài asset scope; lỗi File giả 0-byte cũ đã được harden.
- Backend manifest hiện có validation PDF/PNG/JPEG, DPI, decompression bomb và cleanup; `return_path` không bị xóa quá sớm vì sweep là 26 giờ.
- Khóa PDFium trong LayerEngine có tồn tại. Finding backend là gọi công việc có khóa ngay trên event loop, không phải thiếu khóa tại vị trí đó.

## 9. Ma trận tái hiện bắt buộc trước khi đóng audit

### 9.1 Nguồn lưu trữ

- NTFS cục bộ: Desktop, Documents và ổ `D:\` ngoài plugin scope.
- USB/rút nóng giữa lúc đọc.
- UNC/NAS hoạt động, chậm và mất kết nối giữa chừng.
- OneDrive file local và placeholder chưa hydrate.
- Tên tiếng Việt, dấu, ký tự dài, path dài và `.PDF` viết hoa.

### 9.2 Loại file

- PDF 1 trang, nhiều trang, 0 byte, corrupt, encrypted/password, rất lớn.
- PNG/JPEG hợp lệ, corrupt, alpha, DPI, ảnh rất nhiều pixel.
- WebP/BMP/TIFF qua đúng tool ảnh.
- Đủ 11 extension Office; thêm file có password, protected view, external link và repair prompt.
- Google public, private/login, link file trực tiếp và link folder.

### 9.3 Cửa thao tác

- Ctrl+O, picker Home, picker empty workspace.
- Native drop vào Home, viewer, Compare A, Compare B, Combine, Office, upscale và tách nền.
- Double-click khi app đóng/mở; Open With nhiều file.
- Explorer Combine và Convert với 1 file, nhiều file, PDF + ảnh trộn.
- Recent, recovery, local folder batch và Google link.
- Bốn output Combine: Ghép, Trộn đan xen, In, Ghép theo nhóm; kết quả Office/Google mở lại viewer.

### 9.4 Tiêu chí nghiệm thu liveness

- Mọi request phải kết thúc ở `ready`, `error` hoặc `cancelled`; không còn trạng thái Loading vô hạn không có hành động.
- Slow state được phép tồn tại khi công việc thật đang tiến triển, nhưng phải có stage, thời gian, Thử lại/Hủy và log correlation ID.
- Một file lỗi/treo không chặn file hợp lệ mở sau trong viewer, Recent hoặc Office/Google.
- Cancel không để kết quả muộn ghi đè tab mới; retry không nhân worker ẩn vô hạn.
- Không tăng concurrency PDFium tùy tiện; mọi render vẫn được serialize đúng bất biến dự án.

## 10. Kế hoạch sửa đề xuất theo lô

Mỗi lô tối đa 5 file và phải verify hẹp trước khi sang lô tiếp theo.

### Lô 1 — Chấm dứt skeleton tile vô hạn

**Mục tiêu:** §OPEN.TILE.1 + phần frontend của §OPEN.TILE.2.

- Bổ sung state terminal/error/retry trong `LivePageFrame`/`LiveTile`.
- Phân biệt superseded có replacement với cancel cuối chuỗi.
- Scheduler có watchdog/circuit-breaker và telemetry queue; không mở concurrency PDFium vô điều kiện.
- Test reject, decode-error, supersede, non-settling task và phục hồi owner khác.

File dự kiến: `LivePageFrame.tsx`, `tileRenderScheduler.ts`, `tileRenderScheduler.test.ts`, một test component mới; tối đa 4 file.

### Lô 2 — Cô lập file mạng và sửa Recent/recovery

**Mục tiêu:** §OPEN.NAS.1 + §OPEN.RECENT.1.

- Chuyển read/load ra ngoài khóa `DOC_CACHE`, dùng per-key single-flight.
- Dùng Rust stat/fallback cho Recent và recovery; phân loại lỗi.
- Regression cho D:/UNC và một file treo không chặn file khác.

File dự kiến: `desktop/src-tauri/src/lib.rs`, `desktop/src/lib/useRecentFiles.ts`, `desktop/src/App.tsx`, tối đa hai file test.

### Lô 3A — Giữ intent và vị trí native drop

**Mục tiêu:** §OPEN.DROP.1 + §OPEN.DOM.1 + §OPEN.ROUTE.1.

- Chuẩn hóa event envelope có `intent`, `position`, `targetTabId`, `source`.
- Ưu tiên receiver active/dropzone cụ thể; Home DOM drop phải nhận file thật.
- ID input theo tab/ref thay vì `document.getElementById` toàn cục.

Tối đa 5 file; verify Compare/Combine/Office/Home trước khi sang lô 3B.

### Lô 3B — Sửa context menu và cold-start batching

**Mục tiêu:** §OPEN.COMBINE.1 + §OPEN.BATCH.1 + §OPEN.FMT.1.

- Thêm `--prynx-action=combine` vào installer và dispatcher.
- Có batch envelope/debounce đủ cho first-instance + pending files, không dựa 50 ms.
- Mở rộng native drop routing theo capability của tool, không mở rộng Combine ngoài định dạng backend hỗ trợ.
- Test 1/N file, app đóng/mở, PDF/ảnh/mixed và Convert.

### Lô 4 — Cô lập Office/Google

**Mục tiêu:** §OPEN.OFFICE.1 + §OPEN.OFFICE.2.

- COM trong supervised process; deadline/cancel/kill tree và cleanup.
- Google có slot/lifecycle độc lập với COM, download streaming.
- Capability trả theo extension/backend thật.
- Test password/prompt giả lập, timeout, slot release và Google private/slow.

### Lô 5 — Hợp đồng upload và event-loop responsiveness

**Mục tiêu:** §OPEN.LOOP.1 + §OPEN.RAM.1 + §OPEN.UPLOAD.1.

- Stream payload; validate magic/parser/page contract.
- Offload sync parser khỏi event loop; process pool cho việc PDF nặng.
- MIME/consumer contract riêng cho ảnh.
- Test `/health` song song, 0-byte/corrupt/encrypted và ngân sách RAM theo máy.

Do phạm vi route lớn, lô này phải chia tiếp theo từng cụm tối đa 5 file nếu triển khai thực tế.

### Lô 6 — Job lifecycle Combine/N-Up và parity test

**Mục tiêu:** §OPEN.COMBINE.2/3 + §OPEN.NUP.1 + §OPEN.EXT.1.

- Error UI cho thumbnail; job ID/progress/cancel cho Combine nặng.
- Admission dựa tổng trang/pixel/RAM, không hard-cap máy mạnh vô điều kiện.
- Watchdog terminal cho N-Up và normalize extension case.
- Thêm parity/integration matrix các cửa mở file.

## 11. Chốt duyệt

Theo quy trình audit hai chốt của dự án, báo cáo dừng tại đây. Chưa triển khai các lô sửa, chưa stage, chưa commit và chưa cập nhật snapshot.

Thứ tự đề nghị duyệt trước là **Lô 1 → Lô 2 → Lô 3A/3B → Lô 4 → Lô 5 → Lô 6**. Lô 1 xử lý đúng màn hình người dùng gửi; Lô 2 ngăn một file mạng làm kẹt toàn bộ viewer; các lô sau sửa tính đúng của mọi cửa mở/Combine/Convert và backend.
