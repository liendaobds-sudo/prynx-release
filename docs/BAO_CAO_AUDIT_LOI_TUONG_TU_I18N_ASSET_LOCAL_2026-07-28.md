# BÁO CÁO AUDIT LỖI TƯƠNG TỰ: I18N, FILE CỤC BỘ VÀ 403

**Ngày:** 2026-07-28  
**Phạm vi:** toàn bộ frontend `desktop/src`, cấu hình Tauri, transport upload/đọc file và hai locale VI/EN.  
**Mục tiêu:** tìm các lỗi cùng họ với log người dùng cung cấp: raw entity/key trên UI, `asset.localhost 403`, `/upload/local 403`, cảnh báo React và công cụ tiếp tục chạy sai sau fallback.

## 1. Kết luận điều hành

Chưa nên coi nhóm lỗi này đã được xử lý hết. Bản hiện tại đã giải quyết đúng các biểu hiện trực tiếp vừa gặp:

- `/api/upload/local` đã cho phép backend dev desktop đăng ký đường dẫn cục bộ.
- `run_dev.bat` đã đưa `UPLOAD_DIR` và `RESULTS_DIR` vào `%TEMP%\PrynX-dev`, nằm trong scope asset của Tauri.
- `&amp;` ở hướng dẫn Chuyển màu đã được đổi thành ký tự `&` thật.
- fallback snapshot của Upscale đã ổn định; cảnh báo React `getSnapshot should be cached` trong audit Tách nền trước đó không còn ở code hiện tại.

Tuy nhiên, audit toàn kho phát hiện **4 lỗi P1** và **3 lỗi P2** còn mở. Lỗi nghiêm trọng nhất là transport file chưa có một nguồn chân lý chung: cùng một `File.path`, chỗ dùng asset protocol, chỗ dùng plugin-fs, chỗ dùng lệnh Rust. Với file ở ổ khác, UNC/NAS, hoặc file backend tạo ngoài scope, một số công cụ có thể hiện 403, đọc nhầm nội dung response 403, hoặc gửi tiếp file 0 byte.

| Mức | Số lượng | Ý nghĩa |
|---|---:|---|
| P0 | 0 | Chưa thấy mất dữ liệu hoặc lỗ hổng bảo mật trực tiếp trong phạm vi này |
| P1 | 4 | Có thể làm công cụ lỗi, đọc sai hoặc UI lộ key/mất bản dịch |
| P2 | 3 | Gây console đỏ, trải nghiệm sai và thiếu lưới chống hồi quy |

## 2. Bằng chứng tái hiện từ log thực tế

Log người dùng khớp trực tiếp với hai nhánh code:

1. `utils.ts:17` gọi `fetch(convertFileSrc(path))` và nhận 403 với file trong `D:\pdfcompare\backend\uploads`; sau đó mới fallback sang Rust.
2. `utils.ts:83` cũng gọi asset protocol cho cùng loại path, nhưng nhánh này không kiểm tra `resp.ok` và không có fallback Rust.

Do đó các dòng 403 không phải chỉ là DevTools “ồn”: một dòng có fallback đúng nhưng gây lỗi mạng nhìn thấy được; dòng còn lại có thể làm kết quả dò hệ màu sai.

## 3. Phát hiện chi tiết

### §FL.01 — P1: `prepareFileForUpload` có thể gửi file 0 byte sau khi cả hai kênh đọc bị từ chối

**Bằng chứng:** `desktop/src/lib/api.ts:212-252` thử asset protocol, sau đó `@tauri-apps/plugin-fs/readFile`; nếu cả hai thất bại thì log lỗi và `return file`. Với fake `File` do Tauri tạo, blob thực là rỗng dù `.size` có thể được gắn bằng kích thước file trên đĩa.

`desktop/src/components/SystemIntegrations.tsx:31-57` chủ động hỗ trợ file ở ổ mạng/NAS và ghi rõ plugin-fs không đọc được ngoài scope; chính luồng này tạo `new File([])` rồi gắn `.path` và `.size`. Vì vậy fallback cuối của `prepareFileForUpload` có thể gửi một multipart 0 byte thay vì dừng an toàn.

Hàm này hiện có **15 call site** thực tế, gồm VDP, merge/split/resize, AI QC, recipe, mã hóa, metadata, OCR, Optimize và Office Convert.

**Tác động:** công cụ có thể trả lỗi PDF hỏng, lỗi “không tìm thấy trailer”, hoặc thất bại khó hiểu khi file mở từ ổ D/E, USB, UNC/NAS hay đường dẫn backend ngoài scope.

**Yêu cầu sửa:** tuyệt đối không trả lại fake file rỗng. Đưa việc đọc file vào một helper trung tâm có kênh Rust an toàn; mở rộng allowlist có chủ đích cho Office/data; nếu mọi kênh thất bại phải ném lỗi Việt ngữ rõ ràng trước khi gửi request.

### §FL.02 — P1: dò hệ màu đọc body của response 403 như thể đó là byte PDF

**Bằng chứng:** `desktop/src/lib/utils.ts:80-86` gọi asset URL theo Range nhưng không kiểm tra `resp.ok`. Response 403 vẫn được `arrayBuffer()`, rồi `TextDecoder` và bộ đếm `/DeviceCMYK`, `/DeviceRGB`, `/Separation` xử lý như PDF.

Nhánh backend chính xác ở `utils.ts:58-77` có thể thất bại hoặc chưa trả màu; khi đó heuristic sai này được dùng. Log người dùng chỉ đúng `utils.ts:83` cho file backend trong `D:\pdfcompare\backend\uploads`.

**Tác động:** tiêu đề file có thể mất nhãn RGB/CMYK/Spot hoặc báo sai; các quyết định UI dựa trên nhận diện nhanh có thể không đáng tin.

**Yêu cầu sửa:** kiểm tra status, dùng cùng helper đọc Range/fallback Rust, và thêm test response 403 không được coi là dữ liệu PDF.

### §FL.03 — P1: preview trực tiếp qua `convertFileSrc` vẫn phụ thuộc scope cố định

**Bằng chứng:** `desktop/src-tauri/tauri.conf.json:31-48` chỉ cho asset protocol đọc Documents, Downloads, Desktop, Temp, AppData và Font. Trong khi đó có các đường mở file từ startup, kéo-thả, recent, ổ khác và UNC/NAS.

Các call site trực tiếp đáng chú ý:

- `CombineTab.tsx:84,108`: thumbnail PDF/ảnh.
- `ImpositionTab.tsx:415,1008,1097,1201`: file mở, kết quả edit, undo và chọn file.
- `RecentFiles/ThumbnailView.tsx:62`: thumbnail ảnh gần đây.
- `LivePageFrame.tsx:2653` và `FontSelector.tsx:52,90`: font tùy chỉnh.

Các chỗ này không có cùng fallback như `getFileArrayBuffer`. Tauri dialog có thể cấp quyền runtime cho file vừa chọn, nhưng startup, recent, backend output và một số drag/drop không có bảo đảm đó; log thực tế đã chứng minh backend output ở ổ D bị chặn.

**Tác động:** thumbnail trắng, font preview không tải, hoặc viewer quay vô hạn tùy nguồn file.

**Yêu cầu sửa:** thiết kế một policy URL/byte thống nhất. PDF preview nên ưu tiên renderer native/tile; ảnh/font ngoài scope cần được cấp quyền runtime có kiểm soát hoặc đọc qua protocol Rust có allowlist, không phát sinh blob lớn vô điều kiện.

### §FL.04 — P2: `getFileArrayBuffer` hoạt động được nhưng luôn tạo 403 nhìn thấy trước khi fallback

**Bằng chứng:** `desktop/src/lib/utils.ts:12-27` luôn thử asset protocol trước, sau status lỗi mới gọi `read_system_file`. Với path chắc chắn ngoài scope, browser vẫn ghi một request 403 đỏ dù kết quả cuối đúng.

Hàm này có ít nhất **19 call site** trong Combine, Bình bài, Watermark, Print, Grid Preview, PDF Imposer và các công cụ chỉnh trang.

**Tác động:** console bị nhiễu, người dùng hiểu nhầm công cụ hỏng; mỗi lần còn tốn một round-trip thất bại. Không được “sửa” bằng cách luôn IPC toàn bộ file lớn vì sẽ hồi quy hiệu năng.

**Yêu cầu sửa:** helper phải biết trước kênh phù hợp theo loại nguồn/path, hoặc dùng custom protocol có Range; không dùng request 403 làm phép thử capability.

### §I18N.01 — P1: locale VI và EN cân bằng nhau nhưng thiếu 93 key mà code đang gọi

Kiểm tra JSON cho kết quả đẹp bề ngoài: VI = 4.750 giá trị, EN = 4.750, không thiếu chéo, không chuỗi EN rỗng và không duplicate JSON key. Nhưng scan 3.683 lời gọi `t(...)` tĩnh phát hiện **95 key không có trong locale**, trong đó 2 là ví dụ nằm trong comment; còn **93 reference thực thi**.

Phần lớn call site truyền default tiếng Việt nên không lộ key ở chế độ VI, nhưng chế độ EN vẫn xen tiếng Việt. Ít nhất ba chỗ không có default và có thể hiện raw key:

- `desktop/src/components/workspace/SavePrintFilesModal.tsx:57,60`: `misc.savePrintFiles:trang_n`, `misc.savePrintFiles:trang_1`.
- `desktop/src/components/CompareTab.tsx:121`: `tabs.compare:can_file_de_in`. Biểu thức `t(...) || 'Cần file PDF để in'` không fallback được vì i18next trả chính chuỗi key, vốn là truthy.

Nhóm còn thiếu trải rộng qua menu bình bài, grid preview, cut export, Data Merge, Numbering, error formatter, viewer status và thumbnail.

**Tác động:** UI tiếng Anh bị trộn Việt; một số trạng thái hiếm lộ raw key. Kiểm tra “VI/EN cùng số key” hiện tạo xanh giả vì không đối chiếu với call site.

**Yêu cầu sửa:** bổ sung đủ 93 key cho cả VI/EN; thay fallback `t(...) || ...` bằng `defaultValue`; thêm script/test kiểm static key coverage vào lint budget.

### §I18N.02 — P2: entity xuống dòng `&#10;` còn nằm trong tooltip

Chỉ còn một nội dung semantic nhưng xuất hiện ở cả hai locale:

- `desktop/src/i18n/locales/vi.json:1263`
- `desktop/src/i18n/locales/en.json:1263`

Key `imposition.outputSettings:khoang_cach_giua_cum_chinh_va_cum_phu` dùng `&#10;` bốn lần. Nó được truyền thẳng vào thuộc tính React `title` tại `OutputSettingsSection.tsx:64,69` và nội dung tương tự ở `AdvancedSettingsSection.tsx:329`; chuỗi runtime không được browser giải mã như HTML markup nên có thể hiện literal `&#10;` thay vì xuống dòng.

**Yêu cầu sửa:** dùng `\n` thật trong JSON và thêm kiểm tra cấm HTML entity trong locale, trừ trường hợp có renderer HTML được khai báo rõ.

### §TEST.01 — P2: test hiện tại không che các biên path/scope và key coverage

`desktop/src/lib/api.upload.test.ts` chỉ kiểm `/upload/local` fallback với một `File` có bytes thật. Không có test cho:

- fake `File` rỗng + `.path` ngoài asset/plugin-fs scope;
- `prepareFileForUpload` không được phép trả 0 byte;
- `getFileArrayBuffer` chọn kênh mà không tạo 403 probe;
- `detectColorSpace` gặp response 403/404 hoặc Range không được hỗ trợ;
- static `t(...)` key phải tồn tại trong cả hai locale;
- locale không chứa entity HTML ngoài whitelist.

**Tác động:** các phép kiểm hiện có vẫn xanh trong khi lỗi người dùng vừa gặp tồn tại.

## 4. Những dòng console không phải lỗi phát hành

- `Download the React DevTools...`: thông báo dev-only.
- `[Intervention] Images loaded lazily...`: thông báo tối ưu lazy loading của WebView2.
- `[TilePerf] ...`: log đo hiệu năng, không phải lỗi.
- Các `fetch(...)` thẳng tới backend được global interceptor trong `desktop/src/lib/api.ts:153-208` ký request; audit không thấy bằng chứng 403 do thiếu chữ ký ở nhóm này.
- `getSnapshot should be cached`: đã truy nguồn và sửa ở fallback store Upscale; không còn là phát hiện mở trong tree hiện tại.

## 5. Kế hoạch sửa đề xuất

Mỗi lô không quá 5 file và phải verify xong mới sang lô sau.

### Lô A — chặn file 0 byte và dò màu sai

1. `desktop/src/lib/api.ts`: fail-safe cho `prepareFileForUpload`, dùng helper native chung.
2. `desktop/src/lib/utils.ts`: status check + fallback đúng cho Range/detectColorSpace.
3. `desktop/src-tauri/src/lib.rs`: hoàn thiện lệnh đọc có allowlist/Range cho các loại file hợp lệ.
4. Test mới cho local file transport.

**Điều kiện qua:** file từ `D:\`, USB và UNC không gửi 0 byte; 403 body không bao giờ được phân tích như PDF; lỗi đọc dừng trước request và có câu Việt rõ ràng.

### Lô B — thống nhất preview URL/path

1. `CombineTab.tsx`.
2. `ImpositionTab.tsx`.
3. `RecentFiles/ThumbnailView.tsx`.
4. `FontSelector.tsx`.
5. `LivePageFrame.tsx`.

**Điều kiện qua:** PDF/ảnh/font từ ngoài thư mục home vẫn preview được; không có `asset.localhost 403`; không nạp toàn bộ PDF lớn qua IPC chỉ để vẽ thumbnail.

### Lô C — đóng nợ i18n cùng họ

1. `vi.json`.
2. `en.json`.
3. `SavePrintFilesModal.tsx`.
4. `CompareTab.tsx`.
5. Script/test static-key + entity coverage.

**Điều kiện qua:** 0 static key thiếu; 0 raw key; 0 HTML entity ngoài whitelist; chuyển VI/EN không còn chuỗi Việt do default ở 93 call site này.

## 6. Verify đã chạy trong lượt audit

- `npm.cmd run typecheck`: **PASS**.
- Vitest `api.upload.test.ts` + `imageBatch/store.test.ts`: **5/5 PASS**.
- Pytest `backend/tests/test_api.py`: **7/7 PASS**.
- Locale parse/parity: **4.750/4.750**, không missing chéo, không empty EN, không duplicate key.
- `i18n_inventory.py --full`: còn 1.566 chuỗi frontend tiếng Việt được inventory nhận diện; đây là inventory rộng, không đồng nghĩa tất cả đều là bug hiển thị. Phát hiện có bằng chứng trong báo cáo này chỉ lấy từ static key coverage và call site cụ thể.

## 7. Quyết định đề xuất

**Duyệt sửa theo thứ tự Lô A → Lô B → Lô C.** Lô A là chặn lỗi chức năng; Lô B loại bỏ 403 cùng họ trên toàn bộ luồng preview; Lô C đóng raw key/entity và bổ sung hàng rào chống tái phát.

Theo workflow audit của dự án, báo cáo này là chốt thứ nhất. Chưa triển khai ba lô sửa cho đến khi được duyệt.
