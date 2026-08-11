# BÁO CÁO AUDIT UPSCALE XUYÊN CÔNG CỤ

**Ngày audit:** 2026-08-10\
**Repo:** `D:\pdfcompare`\
**Revision:** `89a9048d1d5eb71d64171e8c9195782da064d36a`\
**Branch:** `codex/pre-release-audit-2026-08-04` (ahead 4 tại thời điểm chốt baseline)\
**Chế độ:** audit độc lập, chỉ đọc/chạy probe và ghi báo cáo; chưa sửa code, chưa reset/checkout/stage/commit\
**Kết luận phát hành:** **NO-GO**

## 1. Tóm tắt điều hành

Bản sửa đã giải quyết đúng phần cốt lõi của lỗi kích thước vật lý:

- ảnh khách `2000 x 2000 px`, không DPI, khi Upscale x4 ra đúng `8000 x 8000 px`;
- PNG đầu ra khai khoảng `288 DPI`;
- PDF companion có `MediaBox 1999,9264 x 1999,9264 pt`, không còn `8000 x 8000 pt`;
- PPE render ở 96 DPI ra đúng `2667 x 2667 px`, hoàn thành trong `2,149 s`, `degraded=false`, `ink_unsound=false`;
- cold/warm thực đo trên máy này lần lượt `10,762 s` và `9,232 s`; PDF native chỉ chiếm `0,378 s`/`0,336 s`;
- 22 ca DPI/định dạng cơ sở đều giữ đúng pixel, DPI, kích thước vật lý, alpha và page box trong phạm vi đã thử.

Tuy nhiên chưa thể phát hành vì có ba lỗi P1 đã tái hiện:

1. Batch có hai file khác nội dung nhưng trùng tên và dung lượng có thể coi cả hai là cùng ảnh nguồn, làm kết quả sau ghi đè workspace bằng ảnh sai.
2. Endpoint nhận `file_path` có thể đọc ảnh ở absolute path tùy ý; kiểm tra symlink hiện tại vô hiệu sau `realpath`. Đây là đường đọc file cục bộ qua biên WebView -> sidecar trái threat model.
3. Ảnh Gray/LAB có ICC bị engine chuyển pixel sang RGB nhưng vẫn gắn profile Gray/LAB. Native từ chối tạo companion PDF, frontend rơi fallback và mất ICC mà không có warning.

Ngoài ra có sáu lỗi/coverage gap P2 về vòng đời tab, path stale, parity màu fallback, cancellation, tranh slot warmup và release smoke.

| Mức | Số finding | Trạng thái |
|---|---:|---|
| P0 | 0 | Không phát hiện trong phạm vi |
| P1 | 3 | Đều `[CONFIRMED]` |
| P2 | 6 | Đều `[CONFIRMED]`; §UP.X.09 xác nhận thiếu release gate, không suy diễn installer hiện tại đang thiếu symbol |
| P3 | 0 | Không đưa smell không ảnh hưởng vào bảng chính |

Điều kiện tối thiểu để chuyển khỏi **NO-GO**:

- đóng cả ba P1;
- đóng §UP.X.02 và §UP.X.07 để tab đóng không tiếp tục giữ RAM/GPU/artifact;
- thêm smoke release cho native image merger;
- chạy lại chuỗi Tauri UI hoàn chỉnh trên một phiên dev sạch và Poppler thật.

## 2. Phạm vi, nguồn sự thật và giới hạn

### 2.1 Phạm vi đã audit

Luồng dọc:

`File ảnh -> batch Upscale -> frontend FormData -> /pdf-tools/upscale -> Real-ESRGAN -> PNG -> PDF companion -> response headers/CORS -> commitWorkingFile -> sourceImageFile -> Viewer/PPE -> Bù xén/Tạo đường cắt`

Các tầng đã đọc/trace:

- `desktop/src/components/preprocess-tools/UpscaleTool.tsx`
- `desktop/src/components/preprocess-tools/imageBatch/store.ts`
- `desktop/src/components/preprocess-tools/useUpscaleStore.ts`
- `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx`
- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/lib/imageNormalizer.ts`
- `backend/app/api/routes/pdf_tools.py`
- `backend/app/workers/realesrgan_engine.py`
- `backend/app/workers/pdf_manifest_engine.py`
- `backend/app/core/heavy_job_scheduler.py`
- `backend/app/core/cleanup.py`
- `backend/app/core/license_guard.py`
- `backend/app/main.py`
- `desktop/src-tauri/src/security.rs`
- `build_production.ps1` và verifier artifact cài đặt.

### 2.2 Baseline môi trường

- RAM vật lý: `31,77 GiB`; khả dụng lúc baseline: `17,03 GiB`.
- CPU: `16` logical processors.
- ONNX Runtime: `DmlExecutionProvider` + `CPUExecutionProvider`.
- Cả model general và quality có mặt.
- `_default_tile_size()` trên máy mạnh đi lane `512`; native image Combine ghi log `workers=15`.
- `pdfcompare_native.combine_image_manifest_native` tồn tại trong venv hiện tại.
- Worktree rất bẩn và trộn nhiều phiên. Báo cáo không coi mọi diff là của phiên Upscale và không sửa bất kỳ thay đổi có sẵn nào.

File tái hiện chính:

- Path: `C:\Users\Khanh Pham\Desktop\tải xuống.jpg`
- SHA-256: `ea6b7c5865a48871c5a015481c975b930916bc4be94e08eb44312b84f68640e6`
- JPEG RGB, `2000 x 2000 px`, `92.271 byte`, không DPI, không ICC, không EXIF orientation.

### 2.3 Giới hạn bằng chứng

- `run_dev.bat` đã được chạy. Log native mới ghi `setup complete - app ready` và `frontend: Home interactive`.
- Phiên máy đã có nhiều dev process/cửa sổ cũ. Cửa sổ Tauri mới không điều khiển được từ phiên audit. Vite web mở được Home nhưng bị lớp đăng nhập và không có bridge Tauri; vì vậy chuỗi click `Home -> Upscale -> Bù xén/Tạo đường cắt -> Viewer` **chưa đạt mức RUNTIME**.
- Poppler chưa chạy: launcher `pdftoppm.cmd` của runtime trỏ tới executable không tồn tại và repo hiện không có `D:\pdfcompare\poppler`. Không tự cài dependency trong vòng audit.
- Không build installer/release mới và không chạy installed-artifact smoke; release finding dựa trên pipeline tĩnh + venv dev hiện tại.
- Không tái đo pdf-lib fallback ở kích thước 8000 x 8000 vì browser upload không hoàn tất; parity cấu trúc được kiểm bằng artifact đại diện nhỏ tạo bởi chính `imageNormalizer.ts`.

Do đó mức bằng chứng tổng thể là:

| Audit unit | Mức đạt |
|---|---|
| Route Upscale, PNG, DPI, PDF companion | `ARTIFACT` |
| PPE 96 DPI trên PDF của file khách | `ARTIFACT + runtime engine` |
| Chuyển workspace, Undo, multi-tab | `AUTO + TRACED`, chưa Tauri UI end-to-end |
| Browser fallback PDF | `ARTIFACT` trên fixture đại diện |
| Native drop / cửa sổ Tauri | `TRACED`, startup runtime đạt; thao tác người dùng còn thiếu |
| Release sidecar | `TRACED`, chưa installed artifact |

## 3. Trace xuyên tầng

| Mắt xích | Bằng chứng chính | Kết quả |
|---|---|---|
| Home/native file -> tab | `SystemIntegrations.tsx:15-57`, `useIncomingFileDispatcher.ts:31-76` | File ảnh đơn mở tab Imposition; batch receiver theo tab khi công cụ ảnh đang active |
| Router -> Upscale | `PreprocessingRouter.tsx:288-295` | Truyền đủ `tabId`, `pdfFile`, `sourceImageFile`, `onFileFixed` |
| Batch state | `useUpscaleStore.ts:15-20`, `imageBatch/store.ts:83-159` | State scope theo `tabId`; lifecycle close-tab còn lỗi §UP.X.02 |
| Request | `UpscaleTool.tsx:85-130` | Một request/item; chọn path hoặc upload; `include_working_pdf` theo policy promote |
| Backend route | `pdf_tools.py:1707-1875` | Validate, inference, PNG lossless, optional native PDF, headers |
| AI engine | `realesrgan_engine.py:476-516` | Model luôn chạy x4; x2 downsample hậu xử lý; DirectML Run được serialize theo session |
| PNG -> PDF | `pdf_tools.py:1821-1838`, `pdf_manifest_engine.py` | Native giữ stream ảnh, pHYs/DPI -> MediaBox; fallback qua `imageNormalizer.ts:39-144` |
| CORS | `main.py:218-241` | Origin Tauri/Vite và ba header Upscale được expose |
| Commit workspace | `ImpositionTab.tsx:861-969` | Giữ ảnh kết quả thành `sourceImageFile`; viewer dùng companion PDF nếu có |
| Undo | `ImpositionTab.tsx:901-916,1315-1337` | History giữ cả PDF trước và `__prynxSourceImageFile`; Ctrl+Z phục hồi đồng thời |
| Sticker consumer | `PreprocessingRouter.tsx:263-272` | Sticker nhận `sourceImageFile` hiện hành, không tự quay về ảnh gốc |
| Viewer/PPE | `print_engine/facade.py:1108-1216` | PDF companion của file khách render PPE 96 DPI thành công 2667 x 2667 |

## 4. Các phần đã chứng minh đúng hoặc đã bác bỏ

### 4.1 Kích thước vật lý và PPE

- `_upscale_output_dpi()` mặc định nguồn không DPI là 72 và nhân theo factor: `pdf_tools.py:92-116`.
- EXIF transpose chạy trước khi chốt trục output; ca orientation 6 đổi đúng DPI X/Y: `pdf_tools.py:1767-1773`.
- PNG x4 file khách: `8000 x 8000`, `288,0106 x 288,0106 DPI`.
- PDF native: một trang, MediaBox/CropBox `1999,9264 x 1999,9264 pt`.
- PPE 96 DPI: `2667 x 2667`, `21.338.667` RGB bytes, `degraded=false`, `ink_unsound=false`, `pdf_recovered=false`.
- Render PPE được soi trực quan: hình đầy đủ, đúng hướng, không crop, không trang trắng/đen.

Kết luận: lỗi lịch sử `8000 px -> 8000 pt -> 10667 x 10667 @96 DPI` đã được sửa ở artifact hiện tại đối với nguồn RGB bình thường.

### 4.2 PNG vẫn lossless

Probe dùng RGBA ngẫu nhiên, chặn ngay trước `Image.save()` và hash lại pixel sau khi đọc response:

- `compress_level=3`;
- before SHA-256 pixel: `ddf79e4c74f4fd0c675e3a1a0f4c741a0406815c9a39c2b6a9abe41601559687`;
- after SHA-256 pixel: cùng giá trị;
- mode/size trước và sau đều `RGBA`, `52 x 68`;
- format trả về là PNG.

Nén level 3 chỉ đổi representation nén, không đổi pixel/alpha trong ca kiểm.

### 4.3 CORS và headers

`backend/app/main.py:224-240` cho phép đúng các origin hiện hành:

- `http://tauri.localhost`
- `https://tauri.localhost`
- `http://localhost:5173`
- `http://localhost`

Và expose đủ:

- `X-Upscale-Output-Size`
- `X-Upscale-Warnings`
- `X-Upscale-Working-Pdf-Path`

### 4.4 Chuyển công cụ, Undo và tab ownership

Các điểm đã đạt ở mức code + test tự động:

- ảnh đơn sau Upscale gọi `onFileFixed()` và trở thành `sourceImageFile` của đúng tab;
- Sticker nhận `sourceImageFile` qua router;
- commit PDF từ công cụ khác đặt nguồn ảnh kế tiếp về `null`;
- Ctrl+Z document khôi phục đồng thời PDF và ảnh nguồn;
- hai tab có record store riêng theo `tabId`;
- tab nền còn mounted nhưng callback và event routing mang `tabId`;
- component đã unmount không gọi `onFileFixed` muộn nhờ `mountedRef`;
- `include_working_pdf` chỉ bật cho item được policy chọn để promote, không bật mặc định cho mọi item;
- `window.__isUpscalerActive` hiện không có consumer nào trong repo, vì vậy là code moot chứ chưa phải bug runtime.

Các kết luận này không phủ định finding va chạm danh tính và lifecycle bên dưới.

## 5. Bảng finding

| ID | Mức | Lifecycle | Finding | Effort |
|---|---|---|---|---|
| §UP.X.01 | P1 | `[CONFIRMED]` | File khác nội dung nhưng trùng tên + size được coi là cùng nguồn; có thể promote sai item | M |
| §UP.X.02 | P2 | `[CONFIRMED]` | Đóng tab không dispose store/Blob/object URL và không hủy controller | M |
| §UP.X.03 | P2 | `[CONFIRMED]` | Path stale được ưu tiên tuyệt đối, không retry upload dù bytes còn sẵn | S |
| §UP.X.04 | P1 | `[CONFIRMED]` | `file_path` đọc absolute image path tùy ý; symlink check bị vô hiệu sau `realpath` | M |
| §UP.X.05 | P1 | `[CONFIRMED]` | Gray/LAB ICC bị gắn lên RGB output; native PDF fail và fallback mất profile im lặng | M |
| §UP.X.06 | P2 | `[CONFIRMED]` | Native và frontend fallback không parity màu: fallback bỏ ICC | M |
| §UP.X.07 | P2 | `[CONFIRMED]` | Client disconnect/tab đóng không dừng inference; companion PDF không consumer sống tới TTL | M/L |
| §UP.X.08 | P2 | `[CONFIRMED]` | Warmup trùng giữ hết heavy slots trong khi chờ cùng probe/session lock | S/M |
| §UP.X.09 | P2 | `[CONFIRMED]` | Release gate không smoke `combine_image_manifest_native` | S |

## 6. Chi tiết finding

### §UP.X.01 - Batch identity collision có thể đưa ảnh sai vào workspace

**Mức:** P1\
**Confidence:** 99%\
**Vị trí:** `desktop/src/components/preprocess-tools/UpscaleTool.tsx:48-71,123-124,165-173,337-346`

**Bằng chứng/tái hiện**

`isSameBatchSource()` ưu tiên path nếu có, nhưng nếu path không khớp hoặc là browser file thì fallback chỉ so:

`item.fileName === file.name && item.fileObj.size === file.size`.

Probe gọi trực tiếp helper đang export bằng hai `File`:

- nội dung `AAAA` và `BBBB` khác nhau;
- cùng tên `same.png`;
- cùng size 4 byte;
- `shouldPromoteUpscaleResult(items, A, sourceA) == true`;
- `shouldPromoteUpscaleResult(items, B, sourceA) == true`;
- `isUpscaleInputAlreadyTracked([A], B) == true`.

Khi batch đã chứa cả hai, policy bật companion PDF và callback promote cho cả hai. Item sau có thể ghi đè workspace dù không phải nguồn. Ở đường auto-add/remount, ảnh B còn có thể bị coi là đã track và không được thêm.

**Hậu quả người dùng**

- Bù xén/Tạo đường cắt nhận ảnh khác với ảnh đang xem/chọn ban đầu.
- Kết quả cuối phụ thuộc thứ tự batch.
- Có thể tạo thừa companion PDF cho item không nên promote.
- Undo riêng của Upscale cũng dùng name + result size để nhận diện kết quả hiện hành, nên cùng nhóm collision có thể khôi phục sai file gốc.

**Nguyên nhân gốc**

Tên file + dung lượng không phải danh tính nội dung. Browser cho phép nhiều file ở thư mục khác nhau trùng cả hai thuộc tính; batch không giữ một source identity bất biến nối tới `sourceImageFile`.

**Sửa nhỏ nhất đề xuất**

- Thêm `sourceIdentity` khi ingest item.
- Tauri: identity dựa trên canonical picker path/grant.
- Browser: identity dựa trên chính object/ingest token; nếu cần sống qua remount thì dùng hash nội dung có cache, không dùng name + size.
- Policy promote và dedup phải dùng cùng identity; một batch chỉ được có tối đa một item thỏa nguồn workspace.

**Test hồi quy cần thêm**

1. Hai File cùng tên + size nhưng khác bytes: chỉ source thật được promote và chỉ một request có `include_working_pdf=true`.
2. Auto-add không bỏ qua File thứ hai chỉ vì name + size.
3. Undo riêng khôi phục đúng original của item được chọn.
4. Lặp cho DOM drop và browser picker.

**Blast radius hạ nguồn**

Upscale batch, remount/dedup thumbnail, companion PDF, `commitWorkingFile`, `sourceImageFile`, Sticker/Bù xén, Undo riêng. Không sửa generic batch helper theo regex nếu chưa xác minh Tách nền dùng cùng hợp đồng.

### §UP.X.02 - Đóng tab vẫn giữ Blob và object URL trong store

**Mức:** P2\
**Confidence:** 99%\
**Vị trí:** `imageBatch/store.ts:83-159`, `useUpscaleStore.ts:20`, `UpscaleTool.tsx:25,93-95,206-214,235-239`

**Bằng chứng/tái hiện**

- Store chỉ có `reset(tabId)`, không có `destroyTab(tabId)` xóa key.
- Không có production caller nào gọi `reset()`; grep chỉ thấy unit test.
- Cleanup unmount ở `UpscaleTool` chỉ đặt `mountedRef.current=false`; không abort controller, không revoke URL, không xóa tab state.
- Probe nạp chính module store qua Vite runtime, tạo tab với source Blob 1 MiB và result Blob 2 MiB, sau đó mô phỏng không còn consumer. Kết quả:
  - `hasDestroy=false`;
  - `tabStillRegistered=true`;
  - source/result bytes vẫn là `1.048.576`/`2.097.152`;
  - `blob:source` và `blob:result` vẫn còn trong record.
- Test hiện tại `UpscaleTool.test.tsx:158-177` chỉ khóa việc không callback sau unmount; chính test đợi state tab cũ chuyển `isProcessing=false`, tức state vẫn sống.

**Hậu quả người dùng**

Đóng nhiều tab ảnh lớn làm RAM WebView tăng theo source + output x2/x4 và giữ object URL. Tab đã đóng vẫn nhận kết quả vào Zustand dù callback workspace bị chặn.

**Nguyên nhân gốc**

Lifecycle store theo tab được tạo nhưng không nối với lifecycle đóng tab. Unmount công cụ không đồng nghĩa đóng tab, nên component không đủ thông tin để dispose đúng lúc.

**Sửa nhỏ nhất đề xuất**

- Thêm `destroyTab(tabId)` để revoke toàn bộ original/result URL rồi xóa hẳn `tabs[tabId]`.
- Thêm `disposeUpscaleTab(tabId)` để abort controller và destroy state.
- Gọi dispose từ lifecycle đóng tab thực của shell/ImpositionTab, không reset vô điều kiện khi chỉ chuyển công cụ nếu sản phẩm muốn giữ batch khi quay lại.

**Test hồi quy cần thêm**

- Đóng tab: controller abort, hai URL bị revoke, key tab biến mất, Blob không còn reachable.
- Chuyển công cụ rồi quay lại: khóa hành vi sản phẩm đã chọn (giữ hoặc hủy) một cách rõ ràng.
- Tab nền không bị dispose khi đóng tab khác.

**Blast radius hạ nguồn**

RAM WebView, object URL, controller map, save batch và mọi image batch store dùng chung factory nếu API `destroyTab` được đưa vào generic store.

### §UP.X.03 - Path stale không fallback sang File bytes

**Mức:** P2\
**Confidence:** 99%\
**Vị trí:** `UpscaleTool.tsx:111-120,126-143`; test hiện tại `UpscaleTool.test.tsx:103-117`

**Bằng chứng/tái hiện**

Frontend gửi `file_path` trước; nhánh upload là `else if`. Probe dùng item có:

- path `D:\moved\stale.png`;
- `fileObj` vẫn còn 21 byte;
- backend giả lập trả 400 `File not found`.

Kết quả chỉ có một request, `file_path` có giá trị, `file` vắng mặt, item thành `error`; không có retry bằng bytes.

**Hậu quả người dùng**

File bị đổi tên, di chuyển, ngắt ổ mạng hoặc mất quyền tạm thời làm Upscale thất bại dù WebView vẫn giữ được bytes hợp lệ.

**Nguyên nhân gốc**

Tối ưu path-by-reference được triển khai như lựa chọn tuyệt đối thay vì fast path có fallback.

**Sửa nhỏ nhất đề xuất**

Nếu backend từ chối path trước khi inference bằng 400/404/path permission và `fileObj.size>0`, retry đúng một lần bằng upload. Không retry lỗi 422 model/RAM và không retry sau khi job đã bắt đầu.

**Test hồi quy cần thêm**

- stale/missing/permission path + File bytes còn: request thứ hai upload và thành công;
- path hợp lệ: vẫn chỉ một request path;
- lỗi inference: không chạy lặp AI.

**Blast radius hạ nguồn**

Latency localhost, uploads temp, error UX; không đổi backend result contract.

### §UP.X.04 - Arbitrary local image read và symlink bypass

**Mức:** P1\
**Confidence:** 95% theo threat model WebView không tin cậy\
**Vị trí:** `pdf_tools.py:1723-1738`; `license_guard.py:247-257`; `desktop/src-tauri/src/security.rs:934-951`; threat model `docs/audit/PRYNX_THREAT_MODEL.md:32-45`

**Trust boundary:** WebView -> localhost sidecar -> filesystem.

**Bằng chứng/tái hiện an toàn**

Trong temp audit tạo một PNG ngoài mọi picker/allowlist của PrynX rồi POST `file_path` absolute:

- response `200`;
- output size đúng `10x6`.

Tạo symlink `symlink.png -> arbitrary-outside-picker.png`:

- `os.path.islink(input) == true`;
- `real = os.path.realpath(input)`;
- `os.path.islink(real) == false`;
- endpoint response `200`.

Code hiện tại kiểm `os.path.islink(real)`, tức kiểm target đã resolve, không kiểm path do client đưa vào.

Đường sidecar này cũng không áp `is_sensitive_path()`/deny-list mà protocol
`localfile` của Tauri đang dùng (`desktop/src-tauri/src/lib.rs:2969-3037,5053-5065`),
và không có picker grant để ràng buộc path với thao tác người dùng. Vì vậy đây
không chỉ là quyền đọc file desktop đã được scope: endpoint mới đi vòng lớp scope/deny
hiện có đối với mọi ảnh mang đuôi được chấp nhận.

HMAC production không bind body: payload chỉ gồm timestamp, nonce, method, URL path, license, HWID, token hash. Quan trọng hơn, renderer có quyền gọi đường ký request; vì vậy chữ ký không biến một absolute path do renderer chọn thành picker-authorized path.

**Hậu quả người dùng/bảo mật**

Nếu WebView bị XSS/compromise hoặc code renderer không tin cậy chạy được, nó có thể yêu cầu sidecar đọc và trả nội dung bất kỳ file ảnh có extension cho phép mà tài khoản người dùng đọc được: thiết kế khách hàng, ảnh chụp, proof, tài liệu scan. Symlink/reparse point còn mở rộng đường bypass.

**Nguyên nhân gốc**

Backend chỉ validate loại file và sự tồn tại, không validate quyền sở hữu/grant từ picker. Canonicalization được dùng nhưng không có scope để so; symlink được kiểm sau khi mất dấu link.

**Sửa nhỏ nhất đề xuất**

- Tauri cấp một opaque file grant cho canonical path từ picker/native drop; backend chỉ nhận grant hoặc path đã đăng ký theo session/tab.
- Chặn symlink/reparse/junction/UNC/device path trước và sau canonicalization theo Windows semantics.
- Body hash hoặc grant id phải được bind vào request signature; nhưng body binding một mình không thay cho picker authorization.
- Pattern sweep `remove-background` vì `pdf_tools.py:1551-1563` có cấu trúc tương tự.

**Test hồi quy cần thêm**

- path chưa grant -> 403;
- path picker-granted -> 200;
- symlink, junction, UNC, `\\?\`, device path -> từ chối;
- grant tab A không dùng được ở tab/session B;
- upload browser không-Tauri vẫn hoạt động mà không cần path grant.

**Blast radius hạ nguồn**

Upscale, Tách nền và mọi endpoint path-by-reference; Tauri IPC/capability, authenticated fetch và release sidecar.

### §UP.X.05 - Gray/LAB ICC bị gắn sai lên RGB output

**Mức:** P1\
**Confidence:** 99%\
**Vị trí:** `pdf_tools.py:1767-1811,1821-1838`; `realesrgan_engine.py:500-516`

**Bằng chứng/tái hiện**

Engine luôn trả RGB/RGBA. Route chỉ có nhánh quản lý màu đặc biệt khi `source_mode == "CMYK"`; các mode khác giữ nguyên `source_icc` và gắn lại vào output RGB.

Hai fixture profile thật:

| Input | Response | Output PNG | Warning | Companion PDF |
|---|---:|---|---|---|
| Gray PNG + `BlackWhite.icc` | 200 | RGB nhưng ICC header `GRAY` | rỗng | header path rỗng; native từ chối `Số kênh ICC không khớp dữ liệu ảnh` |
| LAB TIFF + LCMS LAB profile | 200 | RGB nhưng ICC header `Lab ` | rỗng | header path rỗng; native từ chối cùng quality guard |

Frontend sau đó fallback qua pdf-lib, bỏ profile và biến file thành DeviceRGB không quản lý màu.

**Hậu quả người dùng**

- PNG có metadata màu tự mâu thuẫn; phần mềm downstream có thể diễn giải sai hoặc từ chối.
- PDF native nhanh không được tạo nhưng UI không biết lý do.
- Fallback có thể đổi màu in mà không warning.

**Nguyên nhân gốc**

Route suy contract ICC chỉ từ mode CMYK. Nó không đảm bảo invariant: `pixel colorspace output == data colorspace của ICC output` sau khi model ép RGB.

**Sửa nhỏ nhất đề xuất**

- Với mọi nguồn không phải RGB/RGBA có ICC, chuyển profile-to-profile sang sRGB trước inference, giữ alpha riêng và gắn ICC sRGB ở output.
- Xác thực signature/colorspace của ICC thay vì chỉ nhìn `source_mode`.
- Nếu không chuyển được, fail-loud 422 hoặc bỏ ICC kèm warning rõ; không phát PNG tag sai.

**Test hồi quy cần thêm**

- Gray ICC và LAB ICC cho x2/x4;
- output RGB chỉ mang ICC RGB/sRGB;
- companion PDF không rỗng và `/ICCBased /N 3` khớp image stream;
- PPE render artifact không degraded;
- warning/fail behavior được khóa khi profile hỏng.

**Blast radius hạ nguồn**

PNG output, native merger, pdf-lib fallback, Viewer/PPE, Sticker và color-managed print workflow.

### §UP.X.06 - Frontend fallback bỏ ICC dù native giữ đúng

**Mức:** P2\
**Confidence:** 99%\
**Vị trí:** `imageNormalizer.ts:39-58,117-144`; fallback caller `ImpositionTab.tsx:883-897`

**Bằng chứng artifact**

Cùng một PNG RGBA `40 x 24`, cùng MediaBox và cùng decoded pixels:

| Thuộc tính | Native PDF | Frontend fallback PDF |
|---|---|---|
| MediaBox | `7,4990625 x 2,879762 pt` | `7,499062617 x 2,879761940 pt` |
| Pixel RGB SHA-256 | `02de15ce...8567bce8` | cùng hash |
| Alpha | `/SMask` | `/SMask` |
| ColorSpace | `/ICCBased` | `/DeviceRGB` |
| File size fixture | 1.798 byte | 1.234 byte |

Sai số MediaBox tối đa chỉ khoảng `1,2e-7 pt`; vấn đề là profile màu, không phải hình học/pixel.

**Hậu quả người dùng**

Nguồn sRGB thường có thể nhìn gần giống, nhưng ảnh AdobeRGB/wide-gamut hoặc profile tùy chỉnh sẽ được diễn giải như DeviceRGB. Browser fallback và release thiếu native merger không tương đương màu với đường native.

**Nguyên nhân gốc**

pdf-lib `embedPng()` không dựng ICCBased từ iCCP. Helper hiện chỉ đọc DPI/pHYs và nhúng pixel/alpha.

**Sửa nhỏ nhất đề xuất**

Ưu tiên một trong hai hướng đã được duyệt:

1. dùng backend/native để tạo PDF cả khi commit fallback; hoặc
2. chuyển pixel về sRGB có quản lý màu trước khi pdf-lib nhúng và cảnh báo profile đã quy đổi; nếu không chuyển được thì fail-loud cho workflow in.

Không được chỉ xóa ICC rồi gọi là parity.

**Test hồi quy cần thêm**

- AdobeRGB/wide-gamut PNG với swatch có giá trị biết trước;
- parse PDF xác nhận ICCBased hoặc xác nhận pixel đã được convert sang sRGB;
- render native/fallback qua PPE rồi đo Delta E/tolerance đã chốt;
- alpha và MediaBox vẫn giữ.

**Blast radius hạ nguồn**

Mọi đường `imageFileToPdfIfNeeded`, Combine ảnh và browser fallback; cần tránh sửa làm phình JPEG/PNG ngoài Upscale.

### §UP.X.07 - Disconnect không hủy inference và để lại PDF không consumer

**Mức:** P2\
**Confidence:** 99%\
**Vị trí:** `UpscaleTool.tsx:25,93-95,206-214,235-239`; `pdf_tools.py:1752-1756,1821-1854,1872-1875`; `cleanup.py:24,146-190`

**Bằng chứng/tái hiện**

Probe chạy uvicorn thật, gửi multipart đầy đủ qua raw socket, đợi inference bắt đầu rồi đóng client:

- client đóng khi inference đang chạy;
- inference vẫn hoàn thành sau thêm `2000,5 ms`;
- output PNG được BackgroundTask dọn;
- một `upscaled_*.pdf` mới vẫn còn trong `results` (fixture 830 byte);
- generic orphan sweep chỉ dọn sau `FS_CLEANUP_MAX_AGE_HOURS = 26`.

Đóng/unmount Upscale cũng không gọi `AbortController.abort()`; `mountedRef` chỉ chặn callback UI.

**Hậu quả người dùng**

Đóng tab hoặc rời tool vẫn tiêu tốn GPU, heavy slot, RAM và encode. Companion PDF không có consumer giữ đĩa tới 26 giờ; lặp nhiều ảnh lớn có thể gây áp lực storage.

**Nguyên nhân gốc**

Cancellation chỉ tồn tại ở client button và không cooperative trong engine tile loop. Backend không kiểm disconnect và companion PDF không có claim/lease từ consumer.

**Sửa nhỏ nhất đề xuất**

- Abort controller khi tab thật đóng.
- Truyền cancellation token/check vào tile loop; kiểm disconnect giữa các tile và trước encode/PDF.
- Không tạo PDF nếu client đã disconnect.
- Companion PDF cần claim/lease: consumer commit thành công thì giữ theo document lifecycle; không claim thì TTL ngắn hơn 26 giờ.

**Test hồi quy cần thêm**

- raw-socket disconnect khi đang inference: dừng trước tile kế tiếp, không có PNG/PDF mới;
- client abort trước admission: không chiếm heavy slot;
- tab close: controller bị abort, store disposed;
- thành công bình thường: PDF vẫn tồn tại đủ lâu để viewer nhận.

**Blast radius hạ nguồn**

Real-ESRGAN tile loop, heavy scheduler, backend results cleanup, tab close lifecycle và các AI route có pattern tương tự.

### §UP.X.08 - Warmup trùng chiếm heavy slots trong khi bị serialize

**Mức:** P2\
**Confidence:** 99%\
**Vị trí:** `pdf_tools.py:1878-1901`; `heavy_job_scheduler.py:87-88,233-245`; `realesrgan_engine.py:61-66,138-167`

**Bằng chứng runtime thật**

Máy này có 3 heavy slots. Ba tab gọi cold warmup cùng variant; cả ba vào scheduler rồi hai lượt chờ `_probe_lock`/session lock trong khi vẫn giữ slot.

| Variant | 3 warmup hoàn tất | Request thật bắt đầu | Scheduler wait của request | Request thật hoàn tất |
|---|---:|---:|---:|---:|
| general | ~932 ms | 100 ms | 765 ms | 1.139 ms |
| quality | ~2.347 ms | 99 ms | 2.219 ms | 2.922 ms |

DirectML serialization là đúng và không được bỏ. Lỗi là identical warmup waiters giữ global admission slots.

**Hậu quả người dùng**

Mở nhiều tab/chuyển model gần nhau làm request thật và các PDF tool khác chờ warmup thấp ưu tiên, ngay cả trên máy 32 GiB.

**Nguyên nhân gốc**

Single-flight nằm bên trong `probe_tile_seconds`, sau khi mỗi request đã chiếm heavy slot. Scheduler không coalesce warmup theo variant và không ưu tiên request thật.

**Sửa nhỏ nhất đề xuất**

- Coalesce warmup theo variant trước khi lấy heavy slot; chỉ một leader chạy, followers await cùng future mà không giữ slot.
- Hoặc dùng queue low-priority/dedicated warmup; request thật được ưu tiên.
- Giữ nguyên `_session_run_locks` để không chạy DirectML session đồng thời.

**Test hồi quy cần thêm**

- 3 warmup cùng variant + 1 request thật: tối đa một warmup chiếm slot;
- general và quality vẫn có thể warm song song khi tài nguyên cho phép;
- DirectML `session.run` cùng session không overlap;
- máy <8/<16/>=16 GiB giữ đúng RAM policy.

**Blast radius hạ nguồn**

Toàn bộ `pdf-tools` dùng shared scheduler trong thời gian cold start; không đổi cap máy mạnh để che vấn đề.

### §UP.X.09 - Release smoke chưa chứng minh native image merger

**Mức:** P2\
**Confidence:** 95%\
**Vị trí:** `build_production.ps1:700-735,1018-1027`; `scripts/verify_installed_artifact.ps1:590-645`; `backend/tests/test_artifact_runtime_self_test.py:169-189`

**Bằng chứng**

- Nuitka có `--include-package=pdfcompare_native`.
- Staged native gate chỉ yêu cầu các symbol/capability PPE; không có `combine_image_manifest_native`.
- Frozen sidecar self-test chứng minh ONNX providers, ISNet, Real-ESRGAN general/quality; không tạo PDF từ PNG bằng native merger.
- Dev venv hiện có function, nhưng điều đó không chứng minh frozen installed sidecar có function và dependency đúng.

**Proof gap:** chưa build/cài artifact từ worktree hiện tại, nên finding này chỉ
khẳng định release gate đang thiếu phép kiểm; không khẳng định binary cài đặt đang
thiếu `combine_image_manifest_native`.

**Hậu quả người dùng**

Artifact release có thể thiếu/stale native merger mà vẫn qua QA, rồi âm thầm rơi sang pdf-lib chậm và mất ICC. Đây là đúng chức năng tối ưu mới của phiên sửa.

**Nguyên nhân gốc**

Release contract tập trung PPE và model AI, chưa được mở rộng khi Upscale bắt đầu phụ thuộc symbol native mới.

**Sửa nhỏ nhất đề xuất**

- Thêm `combine_image_manifest_native` vào staged/frozen required symbols.
- Trong `--artifact-self-test`, tạo PNG nhỏ có pHYs + alpha + ICC, gọi merger, parse một trang và kiểm MediaBox, `/SMask`, `/ICCBased`.
- Fail release, không fallback, nếu smoke native này thiếu.

**Test hồi quy cần thêm**

- unit khóa build script có symbol mới;
- installed-artifact smoke chạy từ cache Nuitka sạch;
- negative fixture mô phỏng native thiếu symbol phải fail QA.

**Blast radius hạ nguồn**

Build/release QA, frozen sidecar, Upscale/Combine ảnh; không ảnh hưởng vòng dev nếu chỉ thêm smoke nhỏ.

## 7. Ma trận đầu vào -> artifact -> consumer

Các dòng dưới dùng inference mock chỉ để cô lập writer/metadata, ngoại trừ dòng file khách dùng AI thật. Mọi ca đều chạy qua route thật và native PDF writer.

| Đầu vào | Factor | Pixel đầu ra | DPI đầu ra | Kích thước vật lý/PageBox | Raster PPE 96 dự kiến/thật | Nguồn Sticker |
|---|---:|---|---|---|---|---|
| File khách JPEG 2000x2000, no DPI | x4 | 8000x8000 | 288,0106 x 288,0106 | MediaBox 1999,9264 x 1999,9264 pt | **2667x2667 thật, đạt** | Ảnh Upscale ở luồng đơn (`AUTO/TRACED`) |
| JPEG 11x7, no DPI | x2 / x4 | 22x14 / 44x28 | 143,9926 / 288,0106 | ~11x7 pt, không đổi | 15x10 | Ảnh Upscale |
| JPEG 11x7 @72 | x2 / x4 | 22x14 / 44x28 | 143,9926 / 288,0106 | ~11x7 pt | 15x10 | Ảnh Upscale |
| JPEG 11x7 @96 | x2 / x4 | 22x14 / 44x28 | 191,9986 / 383,9972 | 8,25006 x 5,25004 pt | 12x8 | Ảnh Upscale |
| JPEG 11x7 @150 | x2 / x4 | 22x14 / 44x28 | 299,9994 / 599,9988 | 5,28001 x 3,36001 pt | 8x5 | Ảnh Upscale |
| JPEG 11x7 @300 | x2 / x4 | 22x14 / 44x28 | 599,9988 / 1199,9976 | 2,64001 x 1,68000 pt | 4x3 | Ảnh Upscale |
| JPEG 12x8 @150x300 | x2 / x4 | 24x16 / 48x32 | 299,9994x599,9988 / 599,9988x1199,9976 | 5,76001 x 1,92000 pt | 8x3 | Ảnh Upscale |
| JPEG 12x8 @150x300, EXIF 90 | x2 / x4 | 16x24 / 32x48 | trục đổi đúng: 599,9988x299,9994 / 1199,9976x599,9988 | 1,92000 x 5,76001 pt | 3x8 | Ảnh Upscale |
| PNG RGBA + RGB ICC @96x150 | x2 / x4 | 20x12 / 40x24 | 192,024x300,0248 / 384,048x600,0496 | 7,49906 x 2,87976 pt; ICCBased + SMask | 10x4 | Ảnh Upscale |
| TIFF RGBA + RGB ICC @150x300 | x2 / x4 | 20x12 / 40x24 | 299,9994x599,9988 / 599,9988x1199,9976 | 4,80001 x 1,44000 pt; ICCBased + SMask | 7x2 | Ảnh Upscale |
| WebP RGB + ICC, no DPI | x2 / x4 | 20x12 / 40x24 | 143,9926 / 288,0106 | ~10x6 pt; ICCBased | 14x9 / 14x8 do rounding | Ảnh Upscale |
| CMYK JPEG 10x6 @300, no ICC | x2 / x4 | 20x12 / 40x24 RGB | 599,9988 / 1199,9976 | 2,40000 x 1,44000 pt | 4x2 | Ảnh Upscale; có warning convert sRGB |
| Gray/LAB + ICC | x2 | Pixel đúng nhưng RGB gắn ICC sai | DPI đúng | native companion không tạo | fallback không parity màu | **Không đạt - §UP.X.05** |

Tổng 22 ca cơ sở:

- 22/22 HTTP 200;
- pixel đúng x2/x4;
- DPI đúng factor;
- EXIF 90 đổi đúng trục;
- MediaBox/CropBox khớp kích thước tính từ PNG, sai số lớn nhất `6,93e-7 pt`;
- alpha tạo `/SMask`;
- RGB ICC tạo `/ICCBased` ở native;
- CMYK không ICC được chuyển RGB và có warning.

## 8. Số đo hiệu năng

### 8.1 File khách 2000 x 2000, Balanced x4, path-by-reference, có PDF companion

| Thành phần | Cold | Warm |
|---|---:|---:|
| Tổng request tới khi nhận đủ PNG | 10.762,2 ms | 9.232,1 ms |
| Probe/guard | 732,3 ms | 0,1 ms |
| AI inference + tile/post detail | 7.379,9 ms | 6.742,6 ms |
| Encode PNG level 3 | 1.905,2 ms | 1.935,8 ms |
| Native PNG -> PDF | 377,8 ms | 336,0 ms |
| Phần còn lại (decode, scheduler, metadata, response copy) | ~367,0 ms | ~217,6 ms |
| PNG response | 41.187.888 byte | 41.187.888 byte |
| PDF companion | 41.181.102 byte | 41.181.102 byte |

Không tách riêng được localhost transport và `commitWorkingFile` trong vòng này vì Tauri UI end-to-end chưa điều khiển được. Không dùng số cũ để lấp khoảng trống.

### 8.2 Corpus thật crop giữa 512 x 512, model đã warm

| Mode/factor | Tổng | Inference | Encode PNG | Native PDF | Output |
|---|---:|---:|---:|---:|---|
| Nhanh x2 | 305,6 ms | 180,4 ms | 51,3 ms | 7,1 ms | 1024x1024 @143,99 DPI |
| Nhanh x4 | 424,2 ms | 164,8 ms | 205,8 ms | 14,8 ms | 2048x2048 @288,01 DPI |
| Cân bằng x2 | 443,5 ms | 324,5 ms | 56,8 ms | 4,3 ms | 1024x1024 @143,99 DPI |
| Cân bằng x4 | 563,9 ms | 318,1 ms | 197,5 ms | 14,3 ms | 2048x2048 @288,01 DPI |
| Chất lượng x2 | 1.859,9 ms | 1.746,2 ms | 50,1 ms | 4,8 ms | 1024x1024 @143,99 DPI |
| Chất lượng x4 | 1.902,4 ms | 1.603,4 ms | 251,0 ms | 13,9 ms | 2048x2048 @288,01 DPI |

Cold warmup riêng:

- general: `827,1 ms` tổng, probe `725,1 ms`, tile đo `0,0223 s`;
- quality: `1.642,5 ms` tổng, probe `1.639,9 ms`, tile đo `0,3222 s`.

Model luôn suy luận x4, nên x2 chủ yếu khác ở resize hậu xử lý và encode output nhỏ hơn. Không có bằng chứng hard-cap máy mạnh trong đường Upscale hiện tại; vấn đề hiệu năng xác nhận là tranh slot warmup §UP.X.08, không phải tile/RAM cap.

## 9. Kiểm thử đã chạy

Các lệnh tối thiểu bắt buộc:

| Lệnh | Kết quả |
|---|---|
| `desktop\npm.cmd run typecheck` | Đạt |
| Vitest `UpscaleTool.test.tsx` + `imageBatch/store.test.ts` | 2 file, 8 test đạt |
| ESLint hai file Upscale | Đạt, 0 warning |
| `pytest backend/tests/test_upscale.py -q` | 20 đạt, 2 warning thư viện |
| `py_compile pdf_tools.py main.py` | Đạt |

Probe bổ sung:

- 22 ca DPI/format x2/x4 qua route thật;
- parse native/fallback PDF bằng pypdf/pikepdf;
- pixel hash PNG trước/sau encode;
- Gray/LAB ICC thật;
- arbitrary absolute path và symlink temp;
- store Blob/URL sau khi mất consumer;
- path stale + bytes còn;
- raw socket disconnect khi inference đang chạy;
- concurrent cold warmup general/quality;
- AI thật main image cold/warm;
- PPE thật 96 DPI và kiểm ảnh raster trực quan;
- `run_dev.bat`, health/backend và startup log native.

Chưa chạy/không đạt điều kiện:

- Poppler render;
- Tauri UI click end-to-end và native drop trong một phiên sạch;
- installed release artifact smoke;
- full-size pdf-lib fallback benchmark;
- kiểm tay nhiều tab trong cửa sổ Tauri.

## 10. Thứ tự lô sửa đề xuất sau khi được duyệt

Chưa áp dụng bất kỳ lô nào. Đề xuất để user duyệt:

1. **Lô A - P1 identity/workspace** (tối đa 4 file): §UP.X.01 + test collision.
2. **Lô B - P1 path security** (tối đa 5 file): §UP.X.04, grant contract Tauri/backend và test symlink/path scope.
3. **Lô C - P1 color** (tối đa 5 file): §UP.X.05 + §UP.X.06, Gray/LAB/AdobeRGB artifact tests.
4. **Lô D - lifecycle** (tối đa 5 file): §UP.X.02 + §UP.X.07, close-tab dispose/cancel/claim TTL.
5. **Lô E - perf/release** (tối đa 5 file): §UP.X.08 + §UP.X.09.
6. Chạy lại toàn bộ ma trận + Tauri UI sạch + Poppler/PPE trước khi đổi kết luận.

Mỗi lô phải verify hẹp rồi dừng theo workflow hai chốt. Không cập nhật snapshot/golden chỉ để làm test xanh.

## 11. Kết luận

**NO-GO.**

Bản sửa kích thước vật lý và tốc độ PDF native có bằng chứng tốt: lỗi PPE `10667 x 10667 @96 DPI` đã được loại bỏ ở file khách, AI/PDF/PPE đều chạy thành công và máy mạnh không bị cap Upscale vô điều kiện.

Nhưng phiên hiện tại vẫn có đường đưa nhầm ảnh vào workspace, đường đọc absolute local path trái threat model và lỗi ICC non-RGB làm sai contract màu. Ba lỗi P1 này đủ chặn phát hành dù các test hiện tại xanh.

Theo quy trình hai chốt, audit dừng tại đây và chờ duyệt báo cáo trước khi sửa code.
