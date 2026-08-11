# Nhật ký sửa Phục hồi & Vector hóa Logo — 2026-08-09

**Báo cáo được duyệt:** `BAO_CAO_AUDIT_LOGO_REBUILD_2026-08-09.md`<br>
**Quy trình:** sửa theo lô tối đa 5 file; hết mỗi lô phải verify và chờ xác nhận runtime trước khi sang lô kế.

## Lô A — §LR3.01 và §LR3.08: scheduler, RAM, cancel và lifecycle

**Phạm vi:** 4 file code/test; nhật ký này là file thứ 5.

| File | Thay đổi | Lý do |
|---|---|---|
| `backend/app/core/heavy_job_scheduler.py` | Admission bất đồng bộ lấy trần phụ + trần toàn cục trước khi vào Starlette threadpool; hỗ trợ callback hủy khi còn xếp hàng; giữ tương thích đường sync và wrapper semaphore cũ | Waiter không còn giữ cạn thread token và chặn endpoint DELETE/health |
| `backend/app/workers/logo_rebuild.py` | Reservation RAM nguyên tử xuyên suốt VTracer/QC; máy mạnh giữ nguyên kích thước khi một job đủ ngân sách, job cạnh tranh bị từ chối rõ thay vì overcommit; metadata native nằm trong `try/finally`; thêm release idempotent | Chặn hai job cùng cam kết một ảnh chụp RAM và dọn UUID trên mọi exit path |
| `backend/app/api/routes/logo_rebuild.py` | Truyền `token.is_cancelled` vào admission; queue-cancel trả 409; route luôn dọn reservation nếu worker chưa chạy | Hủy được cả queued/running và không rò job khi scheduler/ABI lỗi |
| `backend/tests/test_logo_rebuild.py` | Regression thread-token, queued cancel, RAM overcommit/release, metadata failure, route cleanup; cập nhật fake token đúng hợp đồng mới | Khóa nguyên nhân gốc thay vì chỉ kiểm happy path |

### Bất biến giữ nguyên

- Không thêm hard-cap worker hoặc kích thước vô điều kiện.
- Máy `>=16 GB` không bị hạ chất lượng khi job chạy một mình và RAM thực đủ.
- Trần phụ `nup/vdp/compare` và `office` vẫn giữ nguyên; thứ tự khóa vẫn là trần phụ → trần toàn cục.
- VTracer vẫn chạy ngoài GIL; cancel active vẫn dùng token native cũ.

### Verify

- `py_compile` 4 file code/test: đạt.
- Logo + feature gate + heavy scheduler: **50 passed**.
- Consumer scheduler Booklet/Office/Sticker Sheet + Logo: **110 passed**, 2 warning dependency có sẵn.
- Test tương thích Booklet sau sửa wrapper semaphore: **4 passed**.
- `git diff --check` phạm vi Lô A: đạt.

**Mức bằng chứng:** Mức 2 — tự động. Chưa xác nhận runtime Tauri với hai preview Logo đồng thời, hủy job đang chờ và theo dõi RSS thực. Chủ dự án đã yêu cầu tiến hành thẳng Lô B trong cùng phiên; phần runtime Lô A vẫn là cổng còn nợ.

## Lô B — §LR3.02, §LR3.03 và proof gap §LR2.03: integrity, mm và artifact QC

**Phạm vi code:** đúng 5 file; cập nhật nhật ký này được thực hiện sau khi lô code đã qua cổng tự động.

| File | Thay đổi | Lý do |
|---|---|---|
| `backend/app/schemas/logo_rebuild.py` | Thêm cặp `physical_width_mm`/`physical_height_mm`, bắt buộc xác nhận đồng thời; response preview trả lại kích thước đã xác nhận | Ghi quyết định kích thước in vào hợp đồng thay vì ngầm tin DPI |
| `backend/app/workers/logo_rebuild.py` | Giữ màu nhấn dưới 1% khi có vùng hue liên kết, sắc độ và độ đồng nhất đủ; loại chấm rời/nhiễu ngẫu nhiên; DPI chỉ sinh gợi ý; mm chỉ lấy từ settings; đưa kết quả mm vào preview | Giữ dấu/màu nhận diện nhỏ mà không mở cửa cho nhiễu JPEG, đồng thời loại sai số kích thước 4,17× do metadata |
| `backend/app/workers/logo_svg_cleanup.py` | QC chuỗi SVG cuối sau cleanup: kiểm `viewBox`, kiểm đúng cặp mm đã xác nhận; thiếu mm chuyển `review`, sai mm hoặc hệ tọa độ chuyển `rejected` | Không suy rằng metadata gắn trước cleanup chắc chắn còn đúng trong artifact xuất |
| `backend/app/api/routes/logo_rebuild.py` | Preflight cảnh báo DPI chỉ là gợi ý; preview trả cặp mm đã xác nhận và không lặp warning vật lý | Đưa hợp đồng mới ra đúng biên API |
| `backend/tests/test_logo_rebuild.py` | Regression màu đỏ liền khối 0,25%, chấm đỏ rời 0,25%, JPEG có nhiễu nén, nhiễu RGB ngẫu nhiên, DPI 72/300, cặp mm/tỷ lệ và artifact sai mm | Khóa cả ca dương lẫn phản ví dụ, tránh sửa kiểu hạ ngưỡng toàn cục |

### Bất biến và hành vi mới

- Không đổi mục tiêu upscale/RAM theo tier; máy mạnh không bị hạ chất lượng.
- Hai ảnh cùng pixel nhưng khác DPI nay tạo cùng `viewBox` và cùng kích thước pixel nếu chưa xác nhận mm.
- Không có cặp mm xác nhận: SVG tạm dùng đơn vị pixel và trạng thái chuyển `review`.
- Có cặp mm đúng tỷ lệ: SVG gắn đúng `width`/`height` mm và QC đối chiếu lại artifact cuối.
- Cặp mm làm méo tỷ lệ bị từ chối với hướng dẫn khóa tỷ lệ rộng/cao.
- Màu nhỏ chỉ được giữ khi là vùng liên kết, có sắc độ rõ và màu nội vùng đủ đồng nhất; nhiễu rời/ngẫu nhiên không được nâng thành màu logo.

### Verify

- Năm regression gốc đỏ trước sửa, sau sửa đạt; phản ví dụ nhiễu ngẫu nhiên từng bắt được một false-positive và đã được khóa lại.
- Logo + feature gate + entitlement + heavy scheduler + Booklet scheduler: **66 passed**.
- `py_compile` toàn bộ 5 file Lô B: đạt.
- `git diff --check` phạm vi 5 file Lô B: đạt.
- Hai warning còn lại là deprecation có sẵn từ Starlette/httpx và Pydantic.

**Mức bằng chứng:** Mức 2 — tự động. Holdout JPEG hiện là fixture sinh xác định có nhiễu nén; chưa có logo khách kèm vector ground truth. Frontend hiện chưa có ô nhập/khóa tỷ lệ mm nên runtime sẽ đi nhánh `review` cho tới khi UI hợp đồng vật lý được nối ở lô sau. Chưa xác nhận Tauri, lưu SVG và mở 1:1 trong Illustrator/CorelDRAW.

## Lô C1 — §LR3.05: định tuyến picker, DOM drop và Tauri native drop theo tab

**Phạm vi code/test:** đúng 5 file; dispatcher chung không cần đổi vì đã hội tụ mọi cửa vào và đọc resolver runtime.

| File | Thay đổi | Lý do |
|---|---|---|
| `desktop/src/lib/tabNavigation.ts` | Thêm receiver `logo_rebuild` → `prynx-logo-rebuild-add-files` vào bảng event ảnh dùng chung | Dispatcher có thể chọn Logo từ `activeDashboardTool` thực của đúng `activeTabId` |
| `desktop/src/components/ImpositionTab.tsx` | Truyền `tabId` thật vào workspace Logo | Listener có định danh để từ chối event của tab khác |
| `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx` | Nhận native event có `tabId`; chỉ đăng ký khi active; dọn listener khi background/unmount; thêm DOM drag-over/drop và chặn nổi bọt; giữ nguyên đối tượng `File` path-backed | Picker, WebView drop và Tauri drop cùng đi qua một hàm chọn file; tab nền/đã đóng không hút file |
| `desktop/src/lib/tabNavigation.test.ts` | Regression fallback intent Logo, runtime registry và hai workspace Logo cùng mounted | Khóa nguồn sự thật runtime và chỉ chọn tab active |
| `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx` | Regression DOM drop, dispatcher native với `File.path`, tab nền, sai `tabId` và unmount | DOM test không được dùng thay cho mô phỏng đường native; kiểm cả ca dương và âm |

### Verify

- Baseline ba file test routing/workspace trước sửa: **39 passed**.
- Năm regression C1 đỏ đúng baseline trước sửa; sau sửa, routing + dispatcher + workspace: **44 passed**.
- `npm run typecheck` toàn desktop: đạt.
- ESLint bốn file routing/workspace: đạt. `ImpositionTab.tsx` toàn file còn **139 lỗi/warning có sẵn** ngoài dòng prop của C1; typecheck đã xác nhận hợp đồng prop mới.
- `git diff --check` phạm vi 5 file C1: đạt.

**Mức bằng chứng:** Mức 2 — tự động. Test đã mô phỏng event native mang `tabId` và giữ thuộc tính `File.path`, nhưng chưa kéo file thật từ Windows Explorer trong Tauri. Cổng runtime còn nợ: Home → Logo, đổi từ tab PDF → Logo, DOM drop, native drop, hai tab Logo và chuyển khỏi Logo rồi thả file.

## Lô C2 — §LR3.04: dirty session, giữ phiên và Save khi đóng ứng dụng

**Phạm vi code/test:** đúng 5 file; cập nhật nhật ký thực hiện sau cổng code.

| File | Thay đổi | Lý do |
|---|---|---|
| `desktop/src/lib/dirtySession.ts` | Thêm `isDirtySession`/`hasDirtySessions` làm nguồn chung | Close-tab, browser unload, Tauri close, titlebar quit và Close All không được lệch cách hiểu dirty |
| `desktop/src/App.tsx` | Dùng helper chung ở mọi cổng đóng/hàng đợi dirty | Logo nhận cùng cơ chế cảnh báo/lưu tuần tự đã có của tab tài liệu |
| `desktop/src/components/ImpositionTab.tsx` | Tách `documentIsDirty` và `logoSessionDirty`; gộp lên `onDirtyChange`; giữ workspace Logo mounted sau lần mở; nhường `app-trigger-save` cho SVG khi cần; recovery chỉ snapshot phần tài liệu có thể phục hồi | Đổi công cụ không mất editor/history/SVG; không ghi snapshot Logo giả; không để handler PDF trả kết quả save sai |
| `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx` | Phát dirty khi chọn file/sửa/undo/redo/tạo preview; chỉ clear sau `saveBlob.kind === 'saved'`; nhận Save/Ctrl+S/hàng đợi thoát theo `tabId`; cancel/fail giữ dirty | Đóng tab/app không mất phiên im lặng và Save thực sự ghi SVG Logo |
| `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx` | Regression giữ phiên khi ẩn, close-queue save, save cancel/fail, close contract và tab đồng thời dirty PDF + Logo | Khóa cả đường thành công, terminal không thành công và phiên dirty tổng hợp |

### Hành vi tổng hợp

- Chọn ảnh hoặc sửa cấu hình Logo làm tab hiện dấu chưa lưu.
- Chuyển sang công cụ khác trong cùng tab chỉ ẩn workspace, không unmount state Logo.
- Lưu SVG thành công mới clear phần dirty của Logo; hủy dialog hoặc ghi lỗi vẫn giữ dirty.
- Nút X/Alt+F4/titlebar/Close All/đóng tab đều đọc cùng cờ dirty từ App.
- Nếu PDF và Logo cùng dirty: lần Lưu đầu ghi SVG nhưng giữ hàng đợi; lần Lưu kế tiếp nhường cho handler PDF, tránh đóng tab sau khi mới lưu một nửa.
- Crash recovery hiện chỉ snapshot phần tài liệu mà schema recovery có thể dựng lại; không ghi snapshot giả cho File/blob/editor Logo chưa có hợp đồng durable.

### Verify

- Workspace dirty/save: **20 passed**.
- Logo routing + dispatcher + App recovery/motion + tool routing: **57 passed** trên 6 file test.
- `npm run typecheck` toàn desktop: đạt.
- ESLint `dirtySession` + workspace + regression: đạt. Hai file lớn `App.tsx`/`ImpositionTab.tsx` vẫn có backlog lint cũ; typecheck xác nhận thay đổi C2.
- `git diff --check` phạm vi 5 file C2: đạt.

**Mức bằng chứng:** Mức 2 — tự động. Chưa thao tác thật Close tab, nút X/Alt+F4 và Save dialog Tauri. Chưa có crash recovery durable cho bytes ảnh/editor Logo; cổng hiện tại bảo vệ đóng chủ động và giữ state khi đổi công cụ trong lúc tab còn mounted.

## Lô D — §LR3.06, §LR3.09–§LR3.13: release gate, phạm vi, palette, a11y và i18n

Lô D được tách thành bốn nhánh nhỏ, mỗi nhánh không vượt 5 file và đều verify xong trước khi sang nhánh kế.

### D1a — fail-closed ở API và frontend

- Backend thêm dependency runtime trước entitlement: dev thông dịch vẫn mở; production mặc định trả `404` trước khi dò native, kể cả license Pro.
- Chỉ cờ `PRYNX_LOGO_REBUILD_ENABLED=true` có chủ ý mới mở backend production; entitlement Pro vẫn được kiểm tra sau release gate.
- Frontend dùng cặp `DEV || VITE_LOGO_REBUILD_ENABLED`; mặc định production tiếp tục HOLD.
- Toàn bộ test hợp đồng API Logo chạy trong chế độ dev tường minh, không dựa vào trạng thái môi trường ngẫu nhiên.

Verify: **49 backend passed**, **21 frontend routing passed**, desktop typecheck và `git diff --check` đạt.

### D1b — nung cờ vào pipeline và Tauri host

- `build_production.ps1` đặt đồng thời `VITE_LOGO_REBUILD_ENABLED=false` và `PRYNX_LOGO_REBUILD_ENABLED=false`, kiểm lại trước bundle và trước manifest; manifest ghi `LOGO_REBUILD = hold`.
- `build.rs` theo dõi cờ backend; Tauri host dùng `option_env!` và ghi đè env kế thừa khi spawn sidecar. Vì vậy người chạy binary không thể vô tình mở API bằng env của shell.
- Bổ sung self-test pipeline và tài liệu `CAU_HINH_ENV.md`; mọi biến pipeline sở hữu đều được snapshot/khôi phục sau build.

Verify: **15 self-test pipeline passed**, `cargo fmt --check`, `cargo check` và `git diff --check` đạt. `cargo check` chỉ còn 8 warning dead-code có sẵn.

### D2 — limitations và state machine capabilities

- Render `capabilities.limitations` trước vùng chọn ảnh, ghi rõ phạm vi hiện tại là artwork/logo phẳng; bỏ copy mời ảnh chụp/vải ngoài phạm vi đã duyệt.
- Capabilities có ba trạng thái terminal `loading/ready/error`; lỗi không còn kẹt “Đang kiểm tra engine…”, có nút **Thử lại** và chặn preview cho tới khi engine sẵn sàng.

Verify: **22 workspace tests passed**, desktop typecheck và `git diff --check` đạt.

### D3 — palette/background và accessibility

- Thêm thao tác **Đặt làm nền** cho từng màu gợi ý: đặt background, bật loại nền và loại chính màu đó khỏi palette trong cùng một history step.
- Bật loại nền sau khi áp palette cũng tự loại màu nền; không cho tạo palette rỗng.
- Picker là button có focus bàn phím và gọi input bằng ref; trạng thái async dùng live region; lỗi dùng `role=alert` và nhận focus.

Verify: **24 workspace tests passed**, desktop typecheck và `git diff --check` đạt.

### D4 — catalog VI/EN riêng cho Logo

- Thêm namespace `preprocess.logoRebuild` với đủ **84/84** chuỗi tĩnh của workspace ở cả tiếng Việt và tiếng Anh.
- Workspace ép `tv()` qua đúng namespace, tránh reverse-map trúng bản dịch khác hoặc fallback tiếng Việt.
- Test AST chốt mọi chuỗi `tv()` phải có VI + EN không rỗng; test runtime xác nhận đổi sang English cho tiêu đề, picker và lỗi engine.

Verify D4: **29 tests passed** (workspace + catalog), desktop typecheck và `git diff --check` đạt.

### Cổng hồi quy cuối Lô D

- Backend Logo + feature gate + artifact/build self-test: **64 passed**, 2 warning dependency có sẵn.
- Frontend workspace + routing + i18n: **50 passed**.
- Frontend routing ở `--mode production`: **21 passed**; Logo vẫn bị khóa khi hai cờ release là `false`.
- Desktop typecheck: đạt.
- Rust `cargo fmt --check` + `cargo check`: đạt.

**Mức bằng chứng:** Mức 2 — tự động. §LR3.06 và §LR3.09–§LR3.13 đã được khóa bằng code/test. Production vẫn **HOLD/NO-GO** đúng chủ đích; chưa build installer mới, chưa nghiệm thu English/screen reader trên Tauri thật và chưa chạy holdout logo khách + kiểm tra SVG 1:1 trong Illustrator/CorelDRAW.

## Lô E — §LR3.07 và phần frontend của §LR3.03: QA trực quan và kích thước in 1:1

Lô E được tách thành ba nhánh, mỗi nhánh không vượt 5 file code/test/catalog. Mỗi nhánh được verify hẹp trước khi chuyển tiếp.

### E1 — viewport so sánh và điều hướng ảnh

- Thêm viewport **Gốc / Vector / Chia đôi / Chồng lớp** thay cho preview tĩnh.
- Zoom trong khoảng 100–800%; pan bằng kéo chuột, cuộn và bàn phím.
- Chế độ chồng lớp có điều chỉnh opacity để soi lệch biên và sai khác giữa ảnh nguồn với SVG.
- Điều khiển có nhãn bàn phím/screen reader và catalog VI/EN tương ứng.

Verify E1: **30 test đạt**, ESLint hẹp, desktop typecheck và `git diff --check` đạt.

### E2 — crop và nắn phối cảnh trực quan

- Crop có khung kéo, kéo cả vùng và bốn tay nắm góc; perspective có bốn điểm điều khiển trực tiếp trên ảnh.
- Artboard giữ đúng tỷ lệ nguồn qua `ResizeObserver`, không ép ảnh vào khung vuông.
- Client chặn crop vượt biên và tứ giác lõm, tự cắt hoặc suy biến trước preflight/preview.
- Đổi crop/quad xóa cặp kích thước mm đã xác nhận vì hình học output đã thay đổi.

Verify E2: **32 test đạt**, ESLint hẹp, desktop typecheck và `git diff --check` đạt.

### E3 — xác nhận kích thước mm theo đúng output

**Phạm vi:** 5 file của nhánh E3: API client, workspace, regression và hai catalog VI/EN. `LogoCompareViewport.tsx` thuộc E1/E2 và đã qua cổng riêng trước đó.

- API client gửi `physical_width_mm`/`physical_height_mm` đúng schema backend của Lô B.
- UI cho nhập rộng hoặc cao mm và luôn suy ra chiều còn lại theo tỷ lệ output hiện tại; tỷ lệ được tính riêng cho full image, crop và perspective.
- DPI chỉ là nút gợi ý tường minh, chỉ hiện ở chế độ full; không tự quyết định kích thước in.
- Preview hiển thị lại cặp mm do backend trả về, giúp đối chiếu hợp đồng request/response.
- Regression khóa ca ảnh 600×300 px @300 DPI thành gợi ý 50,8×25,4 mm và xác nhận request gửi đúng cặp này.
- Hai `waitFor` của ca Save cũ dùng timeout 3 giây để tránh flake khi chạy chung dưới tải; chạy cô lập và toàn workspace đều đạt.

Verify E3:

- Workspace + catalog: **33 passed**.
- Ba regression backend về DPI/mm, khóa tỷ lệ và QC artifact sai kích thước: **3 passed**, 2 warning dependency có sẵn.
- Harness đi qua worker với ảnh 600×300 và cặp xác nhận 50,8×25,4 mm trả `ready`; SVG cuối có `width="50.8mm"`, `height="25.4mm"`, `viewBox="0 0 600 300"`.
- ESLint API/viewport/workspace/regression: đạt.
- Desktop typecheck: đạt.
- `git diff --check` toàn phạm vi E1–E3: đạt; chỉ có cảnh báo line-ending LF→CRLF của Git, không có whitespace error.

### Cổng hồi quy cuối Lô E

- Logo workspace + i18n + routing + tool panel: **69 passed**.
- Routing/tool panel ở `--mode production`: **36 passed**; Logo vẫn HOLD khi cờ release tắt.
- Desktop typecheck và ESLint hẹp: đạt.

**Mức bằng chứng:** Mức 2 — tự động. §LR3.07 và nguyên nhân DPI ngầm của §LR3.03 đã được đóng ở mức code/test; artifact worker đã được parse và đối chiếu thuộc tính mm/viewBox. Trình duyệt web thuần chỉ xác nhận được Home/card Logo; workspace đầy đủ cần cầu Tauri `window.__TAURI_INTERNALS__.invoke`, nên chưa nâng lên runtime. Trình duyệt kiểm thử cũng chặn mở trực tiếp SVG dạng data URL theo chính sách an toàn; không dùng đường vòng để thay cho phép đo chế bản. Đã khởi chạy `tauri dev` với backend/Vite đang nghe cổng, nhưng tại thời điểm chốt lượt binary Rust vẫn biên dịch và chưa có cửa sổ ứng dụng; không ghi nhận runtime đạt. Vẫn còn phải nghiệm thu trong app Tauri thật: zoom/pan/overlay, kéo crop/quad, Save dialog, rồi mở SVG ở kích thước 1:1 trong ít nhất hai phần mềm chế bản. Production tiếp tục **HOLD/NO-GO** cho tới khi các cổng artifact/runtime và holdout logo khách có vector gốc được hoàn tất.
