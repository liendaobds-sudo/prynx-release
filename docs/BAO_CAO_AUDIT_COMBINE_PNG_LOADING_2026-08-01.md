# BÁO CÁO AUDIT LUỒNG COMBINE PNG → PDF

**Ngày:** 2026-08-01  
**Phạm vi:** nhập PDF/PNG/JPG trong `CombineTab` → ghép frontend hoặc backend manifest → mở `Combined.pdf` trong tab tài liệu → `usePdfLoader` / PDF.js → viewer.  
**Trạng thái:** Giai đoạn 3 — Lô 1–3 đã triển khai và verify tự động; chờ kiểm tay đúng bộ PNG gốc trên app Tauri.

## 1. Tóm tắt điều hành

Hiện tượng “Đang tải file PDF...” quay vô hạn trong ảnh người dùng gửi đã có một nguyên nhân chắc chắn ở state machine của viewer:

1. Kết quả PNG được Combine tạo thành một `File` PDF trong bộ nhớ, không có đường dẫn trên đĩa.
2. Tab tài liệu tạo `blob:` URL và giao file đó cho PDF.js.
3. Nếu PDF.js từ chối file, worker lỗi, blob lỗi hoặc bất kỳ bước đọc trang nào ném exception, `usePdfLoader` bắt lỗi bằng một `catch` rỗng.
4. `numPages` vẫn bằng `0`, còn `loadError` vẫn là `null`; đây chính xác là điều kiện để spinner tiếp tục hiện vĩnh viễn.

Vì vậy, **loading vô hạn là lỗi đã xác nhận**, không phải chỉ do máy chậm.

Nguyên nhân ban đầu khiến PDF.js thất bại với đúng bộ PNG của người dùng chưa thể khẳng định tuyệt đối khi chưa có các PNG gốc. Tuy nhiên audit đã tìm thấy hai nguồn rủi ro trực tiếp trong luồng ảnh:

- Mọi tác vụ có PNG/JPG đều bị loại khỏi cơ chế chuyển tác vụ lớn sang backend, bất kể tổng dung lượng hoặc số ảnh. Toàn bộ ảnh nguồn, PDF trung gian, PDF đích và bytes kết quả cùng sống trong WebView.
- Bộ đọc DPI của PNG đọc sai vị trí byte `unit` trong chunk `pHYs`, nên PNG 300 DPI bị xem như 72 DPI và tạo trang vật lý lớn hơn khoảng 4,17 lần mỗi chiều.

Phép thử tối thiểu với chính ảnh chụp màn hình được đính kèm, lặp lại thành ba trang, tạo PDF hợp lệ và cả `pdf-lib` lẫn PDF.js đều đọc đủ ba trang. Điều này loại trừ kết luận quá rộng rằng “Combine PNG luôn tạo PDF hỏng”; sự cố nhiều khả năng phụ thuộc đặc tính/kích thước/số lượng PNG cụ thể hoặc trạng thái worker, còn viewer hiện che mất lỗi thật.

## 2. Sơ đồ luồng đã truy vết

```text
PNG/JPG/PDF
    │
    ▼
CombineTab.handleCombine
    ├─ chỉ toàn PDF + đủ lớn ──► /pdf-tools/merge-manifest ──► file trên đĩa
    │
    └─ có bất kỳ ảnh nào ──────► imageBytesToPdfDoc (pdf-lib)
                                  │
                                  ├─ giữ từng PDF nguồn trong loadedDocs
                                  ├─ copy vào finalDoc
                                  └─ finalDoc.save() → File("Combined.pdf") trong RAM
                                                        │
                                                        ▼
App mở tab Imposition
    │
    ▼
ImpositionTab tạo blob: URL
    │
    ▼
usePdfLoader → pdfjs.getDocument(blobUrl)
    ├─ thành công: setNumPages(n) → hiện trang
    └─ lỗi: catch rỗng → numPages=0, loadError=null → spinner vô hạn
```

## 3. Bằng chứng và baseline

### 3.1 Điều kiện spinner khớp hoàn toàn với lỗi bị nuốt

- `desktop/src/components/CombineTab.tsx:808-811` tạo `Combined.pdf` trong bộ nhớ rồi chuyển sang tab mới.
- `desktop/src/components/ImpositionTab.tsx:415-427` nhận file không có `.path`, tạo `blob:` URL và vào workspace.
- `desktop/src/hooks/viewer/usePdfLoader.ts:325-333` dùng PDF.js cho file/blob trong bộ nhớ.
- `desktop/src/hooks/viewer/usePdfLoader.ts:408` bắt toàn bộ lỗi bằng `catch (e) { }`, không ghi log và không gọi `setLoadError`.
- `desktop/src/components/AcrobatViewer.tsx:1712-1716` hiện spinner khi `pdfUrl && numPages === 0 && !loadError`.

Đây là chuỗi trạng thái tất định dẫn tới đúng màn hình người dùng gửi.

### 3.2 Phép thử PNG tối thiểu

Dùng ảnh chụp màn hình đính kèm làm nguồn, nhúng thành PDF một trang rồi copy ba lần như đường Combine:

| Kiểm tra | Kết quả |
|---|---:|
| Kích thước PDF | 10.864 bytes |
| Header | `%PDF-` |
| Số trang theo `pdf-lib` | 3 |
| Số trang theo PDF.js | 3 |

Kết luận: đường assembly cơ bản tạo PDF hợp lệ; chưa tái hiện được tác nhân gốc nếu không có đúng bộ PNG đã gây lỗi.

### 3.3 Phép thử PNG 300 DPI

Tạo trong bộ nhớ một PNG 2480×3508 px có metadata 300 DPI:

| Giá trị | Kết quả |
|---|---:|
| Độ dài chunk `pHYs` | 9 bytes |
| Byte đơn vị đúng, `data + 8` | `1` (pixel/mét) |
| Byte mã hiện tại đọc, `data + 12` | `118` |
| DPI đúng | 300,0 |
| Chiều rộng trang đúng | 595,2 pt |
| Chiều rộng do fallback 72 DPI | 2480 pt |

`desktop/src/lib/imageNormalizer.ts:89-98` kiểm chunk đúng tên nhưng đọc `unit` tại `data + 12`; theo chính cấu trúc 9-byte mà code kiểm ở dòng 90, byte này phải là `data + 8`.

### 3.4 Baseline test hiện có

- Frontend: `combineAssembly`, `combineDelegation`, `api.mergeManifest`, `localFileTransport` — **17 passed**.
- Backend: `test_pdf_manifest_engine.py`, `test_pdf_manifest_route.py` — **9 passed**.
- Không có test nào render `CombineTab` với PNG rồi mở kết quả qua `usePdfLoader`.

## 4. Bảng phát hiện

| Mã | Trạng thái | Mức | Effort | Phát hiện |
|---|---|---:|---:|---|
| §A.1 | **VERIFIED** | **P1** | S | Lỗi PDF.js của file Combine trong bộ nhớ bị nuốt, khiến spinner vô hạn |
| §A.2 | **VERIFIED** | P2 | S | Loader không reset `loadError`, không bảo vệ `numPages=0`, và nhánh native cũng chỉ ghi console khi thất bại |
| §B.1 | **IMPLEMENTED — chờ runtime** | **P1** | L | Job ảnh lớn tự đi backend; worker chuyển tuần tự, đọc DPI parity và không giữ cả bộ bitmap trong WebView |
| §B.2 | **VERIFIED** | P2 | S | Đọc sai byte đơn vị `pHYs`, làm PNG có DPI bị tạo sai khổ vật lý |
| §C.1 | **VERIFIED** | P2 | M | Không có regression xuyên suốt PNG → Combine → blob → viewer/error state |
| §C.2 | **VERIFIED** | P3 | S | Tạo trùng object URL cho thumbnail và thiếu revoke khi unmount, gây rò bộ nhớ theo phiên |

## 5. Chi tiết phát hiện

### §A.1 — Viewer biến mọi lỗi đọc blob thành loading vô hạn

**Bằng chứng:**

- File kết quả không có `.path`, nên chắc chắn vào nhánh PDF.js tại `usePdfLoader.ts:325`.
- `pdfjs.getDocument(pdfUrl).promise` nằm trong `try` tại `:328-329`.
- `catch` ngoài cùng tại `:408` hoàn toàn rỗng.
- Trước khi tải, hook đã đặt `numPages=0` tại `:117-120`; trong nhánh lỗi không có lệnh thay đổi giá trị này.
- Trong toàn hook, `setLoadError` chỉ xuất hiện ở lỗi HTTP của nhánh file native (`:229`), không nằm trên đường blob.

**Tác động:** bất kỳ lỗi parse, lỗi worker, blob URL không đọc được, OOM hoặc exception khi dựng metadata đều bị hiển thị như đang tải bình thường. Người dùng không biết file hỏng, worker hỏng hay thiếu RAM; không có nút thử lại/hủy và không có log để chẩn đoán.

**Khuyến nghị:** ở đầu mỗi lượt tải phải reset lỗi; giữ `loadingTask`; mọi đường reject/exception phải ghi log có cấu trúc và đặt `loadError`. Với tác vụ chậm, dùng watchdog chỉ đổi UI sang “đang mất nhiều thời gian” kèm Thử lại/Hủy, không hard-cap hiệu năng máy mạnh. Nếu `doc.numPages <= 0`, coi là lỗi hợp đồng thay vì tiếp tục spinner.

### §A.2 — State lỗi không có vòng đời đầy đủ

**Bằng chứng:**

- `loadError` khởi tạo tại `usePdfLoader.ts:83` nhưng không có `setLoadError(null)` khi `pdfUrl/file` đổi tại `:117-120`.
- Nhánh native bắt lỗi ngoài cùng tại `:320-322` chỉ `console.error`, không đưa lỗi vào UI.
- Metadata native có thể trả `numPagesFromEngine=0`; code vẫn `setNumPages(0)` tại `:239`, tương đương spinner vô hạn.

**Tác động:** ngoài ca Combine, tài liệu khác cũng có thể loading mãi; ngược lại một lỗi HTTP cũ có thể bám sang lượt tải file mới.

**Khuyến nghị:** định nghĩa state rõ `idle | loading | slow | ready | error | cancelled` hoặc ít nhất đảm bảo mỗi lần tải luôn kết thúc ở `ready/error`, đồng thời bỏ lỗi cũ khi URL mới bắt đầu.

### §B.1 — PNG/JPG không bao giờ được chuyển khỏi WebView

**Bằng chứng:**

- `combineDelegation.ts:26-40` chỉ cho node có tên kết thúc bằng `.pdf`; một ảnh duy nhất làm cả job không đủ điều kiện.
- Ngưỡng 64 MB/800 trang tại `combineDelegation.ts:1-2,43-51` vì vậy không có tác dụng với job ảnh.
- `CombineTab.tsx:568-580` đọc toàn bộ bytes, tạo `PDFDocument` trung gian cho từng ảnh và giữ trong `loadedDocs`.
- `CombineTab.tsx:593-626` đồng thời giữ `finalDoc`, các page copy và `finalBytes`; `:809-810` tiếp tục tạo Blob rồi File từ kết quả.
- Backend manifest hiện chủ động chỉ nhận PDF: `pdf_tools.py:386-392`; worker `pdf_manifest_engine.py:53` chỉ mở nguồn bằng pikepdf.

**Tác động:** peak RAM không tỉ lệ đơn giản với dung lượng PNG nén. Một số ảnh độ phân giải cao có thể buộc WebView giải nén/nhúng nhiều bề mặt ảnh, block main thread hoặc làm PDF.js worker thất bại sau khi tạo kết quả. Liên hệ với đúng ca người dùng là **SUSPECTED** cho tới khi chạy lại bộ PNG gốc và thu log mới.

**Khuyến nghị:** thêm đường backend cho job ảnh lớn/many-image, dựa trên tổng pixel và RAM profile chứ không chỉ dung lượng nén. Backend chuyển từng ảnh thành trang PDF theo kiểu streaming/bounded memory rồi pikepdf ghép; không đặt hard-cap vô điều kiện trên máy ≥16 GB. Frontend chỉ giữ manifest, tiến độ và quyền hủy.

### §B.2 — PNG có metadata DPI bị tạo sai khổ

**Bằng chứng:** `imageNormalizer.ts:90` xác nhận data của `pHYs` dài 9 bytes, nhưng `:93` đọc byte thứ 13 (`data + 12`) thay vì byte thứ 9 (`data + 8`). Phép thử §3.3 cho thấy PNG A4 300 DPI bị fallback thành trang rộng 2480 pt thay vì 595,2 pt.

**Tác động:** sai kích thước vật lý khi Combine, nhóm theo khổ, resize và bình bản. Với A4 300 DPI, mỗi chiều logic lớn hơn 4,17 lần và diện tích trang logic lớn hơn khoảng 17,4 lần; đây là yếu tố khuếch đại tải/render nhưng chưa được coi là nguyên nhân duy nhất của spinner.

**Khuyến nghị:** sửa offset, đọc số nguyên unsigned, kiểm `len === 9`, thêm test PNG có/không có `pHYs` và JPEG JFIF theo inch/cm.

### §C.1 — Test xanh nhưng bỏ trống chuỗi gây lỗi

**Bằng chứng:** chỉ có test helper/manifest ở `desktop/src/lib/combineAssembly.test.ts`, `combineDelegation.test.ts`, `api.mergeManifest.test.ts`. Không có test cho `CombineTab`, `imageBytesToPdfDoc` với `pHYs`, hoặc `usePdfLoader` khi PDF.js reject/hang.

**Tác động:** lỗi state machine và DPI cùng tồn tại dù 26 test hẹp frontend/backend đều xanh.

**Khuyến nghị bắt buộc:** thêm test tích hợp cho PNG hợp lệ, PNG lỗi, nhiều PNG, lỗi PDF.js và đổi file sau lỗi; assert không trạng thái nào giữ `numPages=0 && loadError=null` sau khi promise đã kết thúc.

### §C.2 — Object URL thumbnail bị rò

**Bằng chứng:**

- Node đã có `previewUrl` được tạo tại `CombineTab.tsx:203-213` và `:267-273`.
- `ImageThumbnail` không dùng URL đó mà tạo thêm URL mới tại `:105-119`; cleanup chỉ đổi `isActive=false`, không revoke.
- Effect cleanup node tại `:247-257` chỉ revoke URL của node đã bị loại, không revoke toàn bộ URL còn sống khi tab unmount.

**Tác động:** thêm/xóa ảnh hoặc mở/đóng Combine nhiều lần giữ blob ảnh lâu hơn cần thiết, làm xấu thêm peak RAM của job ảnh.

**Khuyến nghị:** dùng duy nhất một nguồn URL và revoke đúng owner khi file đổi/unmount.

## 6. Điểm đã kiểm chéo, không coi là bug

- `getFileArrayBuffer` tại `desktop/src/lib/utils.ts:13-20` đọc đúng file có `.path` qua transport cục bộ và file trong bộ nhớ qua `arrayBuffer()`; không thấy lỗi “File giả rỗng bytes” ở đường này.
- `handleCombine` có `try/finally`, nên lỗi ngay trong bước ghép sẽ tắt trạng thái xử lý và hiện toast; spinner người dùng chụp thuộc viewer sau khi tab kết quả đã mở.
- Backend manifest kiểm số file, JSON, phần mở rộng và `%PDF-`, có cleanup output và test route/engine đang xanh.
- Lỗi cũ “node PDF chưa expand chỉ ghép trang đầu” đã có xử lý tại `pdf_manifest_engine.py:84-99` và test; không đưa lại thành finding hiện tại.

## 7. Thứ tự sửa đề xuất

### Lô 1 — Chấm dứt loading vô hạn và bổ sung log, tối đa 4 file

1. Hoàn chỉnh state tải trong `usePdfLoader`: reset lỗi, báo lỗi ở cả blob/native, kiểm số trang, quản lý/cancel loading task.
2. Thêm log theo các stage `open_blob`, `pdfjs_loaded`, `read_dimensions`, `ready/error`, gồm tên file, dung lượng, thời gian và loại URL; không ghi full path nhạy cảm.
3. UI slow/error có “Thử lại” và “Hủy”; watchdog chỉ cảnh báo, không dừng cứng máy mạnh.
4. Regression cho reject, zero-page, đổi file sau lỗi và tác vụ chậm.

File dự kiến: `desktop/src/hooks/viewer/usePdfLoader.ts`, `desktop/src/components/AcrobatViewer.tsx`, một file test hook/viewer, có thể thêm một helper trạng thái nhỏ.

### Lô 2 — Sửa chuẩn hóa ảnh và hợp đồng bytes, tối đa 5 file

1. Sửa parser `pHYs` và test DPI PNG/JPEG.
2. Dùng `Uint8Array` đúng byte-window khi tạo Blob/File thay vì dựa trực tiếp vào `.buffer`.
3. Thêm kiểm tra kết quả tối thiểu trước khi mở tab: header, byte length và page count đã biết.

File dự kiến: `desktop/src/lib/imageNormalizer.ts`, test mới cho normalizer, `desktop/src/components/CombineTab.tsx`.

### Lô 3A — Backend nhận nguồn ảnh theo bộ nhớ hữu hạn, tối đa 4 file

1. Mở rộng hợp đồng manifest cho PNG/JPG được validate chặt.
2. Worker chuyển từng ảnh thành một trang đúng DPI và ghép tuần tự.
3. Test route/worker cho ảnh hợp lệ, ảnh hỏng, DPI và cleanup.

File dự kiến: `backend/app/api/routes/pdf_tools.py`, `backend/app/workers/pdf_manifest_engine.py` hoặc worker ảnh riêng, hai file test.

### Lô 3B — Frontend tự động chọn đường phù hợp, tối đa 4 file

1. Ước lượng theo tổng pixel + file size + hồ sơ RAM; máy mạnh vẫn dùng hết năng lực.
2. Gửi job ảnh lớn qua backend, giữ job nhỏ ở frontend để phản hồi nhanh.
3. Tiến độ/cancel dùng chung và test quyết định delegation.

File dự kiến: `combineDelegation.ts`, `CombineTab.tsx`, `api.ts`, các test tương ứng.

### Lô 4 — Dọn vòng đời thumbnail, tối đa 2 file

1. Bỏ object URL trùng.
2. Revoke URL khi file đổi, node bị xóa và tab unmount.

## 8. Tiêu chí nghiệm thu

- PDF.js reject, worker lỗi hoặc file kết quả không đọc được phải hiện lỗi tiếng Việt và nút thử lại; không còn spinner vô hạn.
- File chậm hiển thị stage/thời gian và cho hủy, nhưng không bị hard-timeout trên máy mạnh.
- Bộ PNG gốc của người dùng ghép đủ số trang và mở được trong viewer.
- PNG A4 300 DPI tạo trang khoảng 595×842 pt; PNG không DPI giữ fallback đã định nghĩa.
- Job nhiều ảnh lớn không giữ vô hạn toàn bộ PDF nguồn + đích + bytes trong WebView; log cho thấy đường backend được chọn tự động.
- Không tăng object URL sống sau chu kỳ thêm/xóa ảnh hoặc đóng tab.
- Typecheck xanh; test hook/viewer, normalizer, delegation và backend ảnh xanh; kiểm tay trên bản Tauri thật.

## 9. Chốt duyệt

Chủ dự án đã duyệt triển khai ngày 2026-08-01. Lô 1–3 đã hoàn tất ở mức code/typecheck/test và được ghi trong docs/COMBINE_PNG_LOADING_FIXES_2026-08-01.md. Kết luận runtime vẫn để mở cho tới khi ghép lại đúng bộ PNG gốc trên ứng dụng Tauri.
