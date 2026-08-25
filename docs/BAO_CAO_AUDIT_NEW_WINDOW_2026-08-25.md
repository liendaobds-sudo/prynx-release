# BÁO CÁO AUDIT NÂNG CẤP NEW WINDOW — 2026-08-25

## 1. Mục tiêu đã chốt

PrynX cần có **Cửa sổ mới** đúng nghĩa như Acrobat: từ tab PDF đang xem, tạo thêm một cửa sổ native độc lập của cùng tài liệu; cửa sổ mới mở tại cùng trang, mức thu phóng và bố cục, có thể kéo sang màn hình khác, thu nhỏ/phóng to/đóng riêng.

Không được nhầm tính năng này với **Chia khung xem**, **Tách file PDF** hoặc **Trim & Shift**.

Tài liệu Adobe xác nhận các bất biến nhìn thấy được:

- cửa sổ mới giữ kích thước, độ phóng đại, bố cục và trang của cửa sổ nguồn;
- cửa sổ gốc/các cửa sổ mới mang hậu tố `:1`, `:2`, `:3` và được đánh số lại khi đóng một cửa sổ;
- đóng một cửa sổ không đóng tài liệu nếu vẫn còn cửa sổ khác đang xem tài liệu đó.

Nguồn: <https://helpx.adobe.com/acrobat/using/adjusting-pdf-views.html>

## 2. Kết luận điều hành

PrynX hiện là ứng dụng **một cửa sổ native, nhiều tab React**. Thêm `new WebviewWindow()` trực tiếp vào menu sẽ tạo được khung cửa sổ nhưng không tạo được một bản nhân đúng và còn có nguy cơ làm mất state hoặc mở nhầm bản PDF gốc.

Để triển khai an toàn cần ba lô:

1. Native registry + bootstrap một lần cho cửa sổ tài liệu.
2. Menu/khởi tạo cửa sổ phụ từ **working revision hiện tại**, không từ launch payload cũ.
3. Cô lập lifecycle, cache owner và persisted state giữa các WebView.

Phiên bản đầu được khuyến nghị là **cửa sổ xem phụ của snapshot hiện tại**: điều hướng/zoom độc lập, Save ghi thành file mới; chưa giả vờ rằng hai editor độc lập đang chia sẻ cùng undo/edit session. Parity editable hoàn toàn như Acrobat cần document-session coordinator riêng ở giai đoạn sau.

## 3. Phát hiện có bằng chứng

### §NW.1 — P0 / M — Launch payload không phải tài liệu hiện tại

`AppTab.payload.file` chỉ là file tại lúc tạo tab (`desktop/src/App.tsx:98`, `desktop/src/App.tsx:1426`). Sau Trim & Shift, sửa đối tượng, xóa/xoay/sắp trang, working revision thật nằm trong store riêng của `ImpositionTab`; `getWorkingFile()` mới materialize đúng thứ tự/góc xoay hiện hành (`desktop/src/components/ImpositionTab.tsx:2927`, `desktop/src/hooks/useWorkingPdf.ts:41`).

Nếu nhân bản `tab.payload`, cửa sổ mới có thể mở lại file khách ban đầu và bỏ mất kết quả đang thấy trên màn hình.

### §NW.2 — P0 / M — Mỗi WebView tự tạo store tài liệu mới

Mỗi WebView mount một `<App />` riêng (`desktop/src/main.tsx:73`), mỗi `ImpositionTab` lại tạo `WorkspaceStore` và `ImposerSettingsStore` riêng (`desktop/src/components/ImpositionTab.tsx:302`). Không có document authority dùng chung giữa các cửa sổ.

Vì vậy hai cửa sổ editable độc lập không tự đồng bộ dirty state, undo/redo hoặc edit-session. Cho phép cả hai ghi đè cùng file mà không có version guard có thể làm mất thay đổi.

### §NW.3 — P0 / S — Capability hiện chặn cửa sổ động

`desktop/src-tauri/capabilities/default.json:5` chỉ cấp quyền cho label `main`; quyền hiện tại không có lệnh tạo Webview window. Một cửa sổ `document-*` tạo trực tiếp từ frontend sẽ thiếu IPC hoặc bị ACL từ chối.

Giải pháp ưu tiên: tạo cửa sổ qua command Rust đã validate, registry chỉ giữ bootstrap opaque một lần; capability của child chỉ nhận đúng các quyền cần dùng và không dùng wildcard `*`.

### §NW.4 — P0 / S — Cửa sổ phụ sẽ tranh hàng đợi file toàn cục

App luôn mount `SystemIntegrations` (`desktop/src/App.tsx:1298`). Mỗi instance cùng poll `get_pending_system_files` (`desktop/src/components/SystemIntegrations.tsx:74`), trong khi command Rust lấy rồi xóa cả queue (`desktop/src-tauri/src/lib.rs:4075`).

Nếu child chạy nguyên App, cửa sổ nào poll trước có thể hút file Open With/kéo thả lẽ ra dành cho cửa sổ chính. Chỉ primary window được sở hữu startup integration.

### §NW.5 — P0 / S — Recovery đang có thao tác xóa toàn cục

Mỗi App quét snapshot khi mount (`desktop/src/App.tsx:351`), và đường thoát có thể gọi `clearAllSnapshots()` (`desktop/src/App.tsx:622`, `desktop/src/App.tsx:729`). Đóng một cửa sổ phụ không được xóa recovery của các tab đang sống ở cửa sổ khác.

Child phải bỏ global recovery scan/clear; cleanup phải theo window/session owner.

### §NW.6 — P1 / S — GC persisted store không an toàn xuyên WebView

`desktop/src/components/imposition-tools/store/persist.ts:98-106` dùng cờ `sessionStorage` rồi xóa mọi scoped key trong `localStorage`. `sessionStorage` riêng theo top-level WebView, còn `localStorage` dùng chung origin; child đầu tiên có thể coi state của main là rác và xóa nó.

GC phải chạy một lần ở primary owner hoặc scope theo window session.

### §NW.7 — P1 / S — Native PDF lease owner có thể trùng giữa cửa sổ

`desktop/src/hooks/viewer/usePdfLoader.ts:291-293` tạo owner dạng `pdf-loader:1` bằng counter cấp module. Mỗi WebView có module realm riêng nên cùng bắt đầu từ 1. Với cùng path, hai cửa sổ có thể đăng ký cùng owner; đóng một cửa sổ có nguy cơ nhả lease của cửa sổ còn lại.

Owner cần thêm window/session id không trùng, hoặc mỗi view phải dùng snapshot path riêng và vẫn nên harden owner để đúng hợp đồng multi-window.

### §NW.8 — P1 / M — Cần quản lý snapshot và vòng đời file tạm

`File`/Blob URL không thể đưa thẳng qua URL hay event JSON. Working revision trong RAM phải được materialize thành PDF tạm có tên/owner an toàn; child tiêu thụ bootstrap một lần; file tạm được xóa khi cửa sổ cuối cùng không còn dùng.

Không đưa raw path hoặc byte PDF vào query string/localStorage vì dễ rò đường dẫn, nhân đôi RAM và lọt vào telemetry.

### §NW.9 — P2 / L — Parity editable hoàn toàn cần document-session coordinator

Acrobat tạo nhiều view của **cùng document model**: viewport độc lập nhưng thay đổi tài liệu thuộc cùng một tài liệu. PrynX chưa có registry revision/undo/edit-session xuyên WebView.

V1 an toàn không được quảng cáo là đồng bộ chỉnh sửa hai chiều. Giai đoạn parity đầy đủ cần:

- document session id + revision authority dùng chung;
- journal/event có version và chống ghi đè;
- dirty/save/close reference-count theo tài liệu;
- viewport state riêng theo cửa sổ;
- renumber `:1…:N` và danh sách Window toàn ứng dụng.

## 4. Phạm vi triển khai đề xuất

### Lô A — Native bootstrap an toàn (tối đa 3 file)

- Rust `DocumentWindowRegistry`: token/label one-shot, validate payload và tạo native window.
- Capability giới hạn cho `document-*`.
- Unit test native cho token một lần, label/path và cleanup.

### Lô B — Menu + working revision (tối đa 3 file)

- Thêm `Cửa sổ mới` ở đầu menu Cửa sổ; disabled tại Home/tab không có PDF.
- Active `ImpositionTab` commit edit-session cần thiết, lấy working revision hiện tại, materialize và gửi bootstrap.
- Child mở cùng trang/zoom/layout, bỏ splash và không chiếm startup queue/recovery toàn cục.

### Lô C — Cô lập multi-window (tối đa 4 file)

- Owner PDF/cache có window id duy nhất.
- GC persisted state chỉ do primary owner thực hiện.
- Cleanup snapshot file theo reference/lifecycle.
- Test đóng/minimize từng cửa sổ và Open With khi main/child cùng tồn tại.

### Giai đoạn D — Parity editable (đề án riêng)

Chỉ làm sau khi V1 runtime ổn định và user xác nhận cần hai cửa sổ cùng chỉnh một document session. Đây không phải phần mở rộng nhỏ của Lô A–C.

## 5. Tiêu chí nghiệm thu V1

1. Mở PDF → chỉnh bằng Trim & Shift/xoay/sắp trang chưa lưu → `Cửa sổ > Cửa sổ mới`.
2. Xuất hiện cửa sổ native thứ hai trên taskbar, kéo được sang màn hình khác.
3. Child hiển thị đúng working revision đang thấy, cùng trang/zoom/layout ban đầu.
4. Sau khi mở, hai viewport cuộn/zoom độc lập.
5. Main và child thu nhỏ/phóng to/đóng độc lập; đóng child không đóng main.
6. Child không hút Open With, không quét/xóa recovery và không xóa persisted state của main.
7. Tạo tiếp cửa sổ thứ ba có label/số thứ tự riêng, không trùng cache owner.
8. Save ở view snapshot không âm thầm ghi đè file khách; phải Save As hoặc đi qua document authority được duyệt sau này.

## 6. Chốt cần duyệt

Khuyến nghị duyệt **Lô A–C cho V1 an toàn: native window + snapshot đúng working revision + viewport độc lập + Save As**, sau đó đánh giá nhu cầu Giai đoạn D.

Nếu yêu cầu ngay từ đầu phải giống Acrobat cả việc **chỉnh ở cửa sổ nào cũng cập nhật tức thì sang mọi cửa sổ và dùng chung undo/save**, cần duyệt Giai đoạn D thay cho V1; phạm vi và rủi ro lớn hơn đáng kể.
