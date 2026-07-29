# BÁO CÁO AUDIT ĐIỀU HƯỚNG TAB & CÔNG CỤ — PRYNX

**Ngày:** 28/07/2026  
**Phạm vi:** toàn bộ luồng mở công cụ từ Home/menu, chuyển công cụ trong workspace, thu/mở panel, Quay lại, hoàn tất tác vụ, sinh tab kết quả, chuyển tab nền và khôi phục phiên.  
**Nguyên tắc:** audit tĩnh có xác minh chéo; chưa sửa hàng loạt trước chốt duyệt.

## 1. Tóm tắt điều hành

Hệ thống có **32 entry công cụ**, trong đó **25 focusFeature**, **4 lockedMode** và các app độc lập. Routing tĩnh giữa registry → workspace panel → preprocessing router hiện khớp đủ 25 focusFeature. Tuy nhiên, vòng đời tab của PrynX giữ **mọi tab mounted** rồi chỉ ẩn bằng CSS. Một số luồng vẫn dùng sự kiện/biến `window` không kèm `tabId` hoặc không kiểm tra `isActive`; đây là nguồn lỗi nghiêm trọng nhất.

Kết quả audit: **2 P0, 6 P1, 4 P2**. Hai P0 đều có khả năng tác động nhầm tài liệu ở tab nền:

1. Quản lý trang phát lệnh toàn cục, mọi AcrobatViewer đều thực thi.
2. Crop mở dialog ở mọi tab Crop; phím Enter có thể bị listener tab nền nhận trước.

Lỗi Upscale vừa gặp là một biểu hiện của nhóm thứ hai: hợp đồng “tab chuyên dụng / workspace PDF / tab kết quả” chưa được mô hình hóa thống nhất, còn rải trong nhiều điều kiện.

## 2. Bản đồ luồng đã kiểm tra

| Nhóm | Điểm vào | State chính | Kết quả mong đợi |
|---|---|---|---|
| App độc lập | Home/menu | `tab.type` | Chỉ tab đang active nhận phím/lệnh |
| Bình bài khóa chế độ | `lockedMode` | payload tab + imposer store | Giữ đúng profile Booklet/N-Up/Tem/CNC |
| Tiền xử lý PDF | `focusFeature` | payload + `activeDashboardTool` + `activeTool` | Giữ tool hoặc mở tab kết quả theo tùy chọn |
| VDP ngoài dashboard | `datamerge/numbering/...` | parent store + component riêng | Hoàn tất phải còn thông báo, không rơi menu bất ngờ |
| Ảnh/Office độc lập | `bgremover/upscale/office_convert` | store theo `tabId` | Không rơi workspace PDF trống |
| Khôi phục | recovery snapshot | path + thao tác + identity | Mở lại đúng công cụ đang làm lúc crash |

## 3. Phát hiện

### §NAV.1 — P0/M: Quản lý trang có thể sửa đồng thời nhiều PDF tab

**Bằng chứng:** `PageToolsPanel.tsx:46` phát `prynx-pagetools-action` không có `tabId`. `AcrobatViewer.tsx:629-642` cho mọi viewer mounted đăng ký listener và thực thi duplicate/move/delete/rotate/insert/extract, không kiểm tra `isActive` hay tài liệu đích. `App.tsx:1480-1484` xác nhận mọi tab luôn mounted, tab nền chỉ có `opacity-0` và `pointer-events-none`.

**Hậu quả:** bấm xóa/xoay/nhân bản trong một tab có thể thay đổi page order của các PDF tab khác; đây là nguy cơ sai tài liệu và mất dữ liệu chưa lưu.

**Khuyến nghị:** mọi command phải có `tabId`; listener từ chối nếu khác tab. Thêm test hai workspace mounted, một event chỉ đổi đúng store đích.

### §NAV.2 — P0/M: Crop broadcast sang mọi tab, Enter có thể áp dụng vào tab nền

**Bằng chứng:** `LivePageFrame.tsx:1676-1678,1817-1824` phát `prynx-crop-open` không có `tabId`. Mỗi `CropDialog` nhận event tại `CropDialog.tsx:226-305` và mở state của chính nó mà không lọc tab. Khi dialog mở, mỗi instance gắn listener Enter capture tại `CropDialog.tsx:308-327` và gọi `handleApplyRef.current()`, đồng thời `stopImmediatePropagation()`. Nhiều tab Crop được phép vì entry workspace không có `maxInstances`.

**Hậu quả:** dialog của tab nền cũng mở. Listener đăng ký trước có thể nuốt Enter và chạy apply bằng `ensureFileId`/`onApplied` của file nền.

**Khuyến nghị:** scope toàn bộ chuỗi `crop-open`, `crop-selection-change`, `crop-preview-change` bằng `tabId`; chỉ tab active được gắn hotkey apply/dismiss.

### §NAV.3 — P1/M: Mở file bị chuyển nhầm vào Tách nền ở tab nền hoặc nhiều tab

**Bằng chứng:** `BgRemoverTool.tsx:113-140` đặt cờ global `__isBgRemoverActive` khi component mounted và mọi instance cùng nghe `prynx-bgremover-add-files`. `App.tsx:1057-1065` thấy cờ này thì không mở tab file mới mà broadcast file. Do tab nền vẫn mounted, “active” ở đây không đồng nghĩa tab đang xem; event cũng không có `tabId`.

**Hậu quả:** mở/kéo file khi có tab Tách nền nằm nền có thể làm file biến mất khỏi luồng Open thông thường và được thêm vào một hoặc tất cả batch Tách nền. Đóng một trong nhiều instance còn có thể đặt cờ false dù instance khác vẫn tồn tại.

**Khuyến nghị:** bỏ cờ global; App định tuyến theo `activeTabId` và payload tab. Event phải gửi đúng `tabId` hoặc gọi thẳng action của store đích.

### §NAV.4 — P1/S: Tab Upscale/Tách nền nền chặn phím Space toàn ứng dụng

**Bằng chứng:** `ImageBatchPreview.tsx:63-70` gắn `window.keydown` và luôn `preventDefault()` khi Space, không kiểm tra target nhập liệu hoặc `isActive`. Preview của tab nền vẫn mounted.

**Hậu quả:** chỉ cần một tab Upscale/Tách nền còn mở, Space ở ô tìm kiếm, metadata, VDP hoặc màn hình khác có thể không nhập được; nhiều preview cùng giữ listener.

**Khuyến nghị:** truyền `isActive`, bỏ qua input/textarea/contenteditable và chỉ chặn Space khi preview đang focus/hover.

### §NAV.5 — P1/S: Ba luồng VDP tự unmount trước khi hiện thông báo hoàn tất

**Bằng chứng:** DataMerge/Numbering/CoverNumbering đặt status hoàn tất sau `onApplyResult` tại `DataMergeTool.tsx:1308-1312`, `NumberingTool.tsx:338-340`, `CoverNumberingTool.tsx:211-212`. Nhưng parent tại `ImpositionTab.tsx:2619-2680` gọi `commitWorkingFile`, xóa field và ngay lập tức `setActiveDashboardTool('none')`, khiến component bị unmount và status không còn hiển thị. Header & Footer lại giữ tool sau commit (`ImpositionTab.tsx:2691-2697`), nên bốn tool VDP không nhất quán.

**Hậu quả:** người dùng thấy tool biến mất về menu chung, không biết tác vụ thành công hay thất bại — cùng lớp lỗi đã gặp ở Outline/Upscale.

**Khuyến nghị:** chuẩn hóa completion contract: commit xong vẫn giữ tool và success state, hoặc toast + màn hình kết quả rõ ràng; chỉ rời tool khi người dùng chủ động.

### §NAV.6 — P1/M: Tab kết quả kế thừa `lockedMode` của tab cha vô điều kiện

**Bằng chứng:** wrapper `onSpawnTab` tại `App.tsx:1514` luôn ghép `lockedMode: tab.payload?.lockedMode`. Các process handler và trích trang thường gọi `onSpawnTab(newFile)` không truyền intent mới.

**Ca lỗi xác minh từ code:** mở tab Bình Tem Bế → chuyển sang Tách file/Quản lý trang → sinh tab kết quả. Tab con vẫn nhận `lockedMode='sticker_imposer'` và mở panel Bình Tem Bế, dù tác vụ vừa chạy là Split/Extract. Crop còn có thể nhận đồng thời `focusFeature='crop'` và lockedMode của cha.

**Khuyến nghị:** không kế thừa identity ngầm. Mỗi callsite phải khai báo `resultIntent`: viewer chung, giữ tool hiện tại, hoặc locked mode cụ thể.

### §NAV.7 — P1/M: Khôi phục phiên lưu công cụ lúc mở tab, không lưu công cụ đang làm

**Bằng chứng:** snapshot tại `ImpositionTab.tsx:637-648` ghi `feature: initialFeature` và prop `lockedMode`, không ghi `activeDashboardTool`. Với tab mở PDF chung rồi chuyển sang VDP/Preflight/Crop, snapshot vẫn không biết công cụ hiện tại.

**Hậu quả:** sau crash, file và VDP fields có thể được khôi phục nhưng panel quay về menu chung hoặc công cụ ban đầu khác; người dùng tưởng mất bước đang làm.

**Khuyến nghị:** snapshot `activeTool`, panel/open state tối thiểu và version migration; restore sau khi store tab mới đã khởi tạo.

### §NAV.8 — P1/S: Mở preset bằng broadcast làm mọi tab bình bài mở modal nền

**Bằng chứng:** `ImpositionTab.tsx:2566` dispatch `open-preset-modal` không có tabId; mọi `ImposerDashboard` nghe tại `ImposerDashboard.tsx:993-998` không kiểm tra active tab.

**Hậu quả:** mở preset ở một tab làm modal state của các tab khác cùng bật; khi chuyển tab, modal xuất hiện bất ngờ và có thể áp preset nhầm nếu người dùng tiếp tục.

**Khuyến nghị:** gọi action store của tab hiện tại trực tiếp; nếu giữ event thì bắt buộc kèm tabId.

### §NAV.9 — P2/S: “Bỏ qua tải file” tạo workspace trống không nhất quán

**Bằng chứng:** màn upload cho mọi tool đều có nút bỏ qua tại `ImpositionTab.tsx:2245-2249`. Empty overlay tại `ImpositionTab.tsx:2411-2413` lại loại riêng `encrypt` và `metadata`, dù hai component chỉ disable nút khi `!pdfFile` và không có picker riêng (`EncryptTool.tsx:36,94,244,273`; `MetadataTool.tsx:37,88,151,181`).

**Hậu quả:** Encrypt/Metadata sau khi bỏ qua tải file có panel bị vô hiệu và vùng giữa trống, không có đường vào file rõ ràng.

**Khuyến nghị:** capability `requiresPdf/acceptsImage/ownsFilePicker/canEnterEmpty`; render phase và empty state từ capability thay vì danh sách hardcode.

### §NAV.10 — P2/M: Identity/routing có nhiều nguồn chân lý và đã drift

**Bằng chứng:** active tool tồn tại đồng thời ở parent store (`ImpositionTab.tsx:203-214`) và local state (`ImposerDashboard.tsx:151-210`), đồng bộ hai chiều bằng effect. Danh sách `allowedFeatures` tại `ImposerDashboard.tsx:159` lặp lại registry/router nhưng thiếu `cover_numbering`, `stick_text_number` và chứa `merge` không phải focusFeature registry. Guard chuyên dụng, empty overlay, title map và panel routing tiếp tục dùng các danh sách riêng.

**Hậu quả:** thêm/sửa tool dễ tái tạo lỗi “tab đúng tên nhưng panel sai/mất”, flicker lúc mount hoặc fallback qua effect thay vì khởi tạo đúng ngay lần đầu.

**Khuyến nghị:** tạo `ToolNavigationSpec` duy nhất theo key, gồm panel kind, file capability, dedicated/pinned, back target, result policy, recovery policy. Loại state local hoặc dùng store làm nguồn duy nhất.

### §NAV.11 — P2/S: Một số event không gây sửa nhầm nhưng fan-out toàn tab

**Bằng chứng:** `refresh-ocg-layers` được mọi ImpositionTab nghe tại `ImpositionTab.tsx:909-916`, còn edit session phát không có tab/session scope tại `useEditSession.ts:270-274`. Preflight còn ghi blob/name vào singleton `window.__preflightFixed*` tại `PreprocessingRouter.tsx:211-214`.

**Hậu quả:** thao tác layer ở một tab kích hoạt fetch/update ở nhiều tab; singleton có nguy cơ bị tab khác ghi đè. Đây chủ yếu là rủi ro hiệu năng và stale state.

**Khuyến nghị:** scope event theo tab/session; bỏ singleton blob hoặc chuyển sang store theo tabId.

### §NAV.12 — P2/M: Test hiện tại xanh nhưng không có ma trận đa tab

**Bằng chứng:** các test routing hiện kiểm tra registry/component map và tương tác đơn instance. Không có test mount hai workspace rồi phát PageTools/Crop/BgRemover/Preset; không có test resultIntent, recovery current tool hoặc VDP completion persistence.

**Baseline đã chạy:** 5 file test, **44/44 đạt**; `npm run typecheck` đạt. Điều này xác nhận lỗi nằm ngoài phạm vi test hiện tại, không phải source đang đỏ.

## 4. Thứ tự sửa đề xuất

### Lô A — Chặn sửa nhầm tab (P0, tối đa 5 file)

1. Scope PageTools bằng tabId + isActive.
2. Scope Crop open/selection/preview bằng tabId; hotkey chỉ active tab.
3. Thêm test hai tab cho PageTools và Crop.

### Lô B — Dọn global routing (P1, tối đa 5 file)

1. Bỏ `__isBgRemoverActive`; định tuyến theo active tab.
2. Scope add-files/preset theo tabId.
3. Chặn Space listener của preview nền.

### Lô C — Chuẩn hóa hoàn tất và tab kết quả (P1, tối đa 5 file)

1. Giữ success state cho 4 tool VDP.
2. Thêm result intent tường minh; bỏ kế thừa lockedMode vô điều kiện.
3. Test spawn từ locked tab sau khi chuyển feature.

### Lô D — Nguồn chân lý navigation (P2, thực hiện sau khi A–C ổn định)

1. `ToolNavigationSpec` sinh routing/capability/back/recovery.
2. Lưu current tool vào recovery.
3. Xóa allowlist và điều kiện hardcode trùng lặp.

## 5. Tiêu chí nghiệm thu

- Lệnh ở tab A không thay đổi store/file/panel của tab B.
- Mọi global event liên quan tài liệu có `tabId` hoặc session id và listener từ chối sai đích.
- Tab nền không chặn phím, không mở modal, không nuốt file.
- Hoàn tất in-place luôn còn thông báo thành công/thất bại nhìn thấy được.
- Tab kết quả có intent tường minh, không kế thừa tool cha ngoài chủ đích.
- Crash recovery mở lại đúng tool đang làm.
- Test ít nhất hai tab cho PageTools, Crop, batch ảnh, preset và recovery.

## 6. Chốt duyệt

Theo quy trình audit hai chốt, báo cáo này dừng ở phát hiện và kế hoạch. Chưa triển khai các lô A–D cho tới khi được duyệt.
