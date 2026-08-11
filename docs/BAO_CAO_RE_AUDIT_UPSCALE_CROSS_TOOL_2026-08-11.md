# BÁO CÁO RE-AUDIT UPSCALE XUYÊN CÔNG CỤ

**Ngày re-audit:** 2026-08-11
**Repo:** `D:\pdfcompare`
**Revision:** `89a9048d1d5eb71e8c9195782da064d36a`
**Branch:** `codex/pre-release-audit-2026-08-04`
**Baseline đối chiếu:** `docs/BAO_CAO_AUDIT_UPSCALE_CROSS_TOOL_2026-08-10.md`, SHA-256 `DB40A8D94FB4211E2097BBDB1824B55AC5BB528F62D553535CFA7E9DF236C671`
**Chế độ audit:** chỉ audit lại bản người dùng tự sửa; không sửa mã nguồn, không reset/checkout/stage/commit
**Kết luận phát hành:** **NO-GO**

## 1. Tóm tắt điều hành

Bản tự sửa đã loại bỏ ba lỗi P1 cũ ở đường chính:

- batch promote không còn đồng nhất hai file chỉ vì trùng tên và dung lượng;
- `file_path` ngoài scope, symlink và UNC/device path không còn được đọc tự do;
- Gray/LAB ICC được chuyển sang sRGB trước khi gắn vào output RGB; companion PDF tạo được `/ICCBased /N 3` đúng contract.

Hai tối ưu quan trọng cũng đã có hiệu lực:

- warmup không còn giữ heavy-job slot;
- frozen runtime self-test đã kiểm tra sự tồn tại của `combine_image_manifest_native`.

Lỗi kích thước vật lý/PPE vẫn được đóng bằng artifact mới. File khách `2000×2000 px`, không DPI, SHA-256 `EA6B7C5865A48871C5A015481C975B930916BC4BE94E08EB44312B84F68640E6`, khi Balanced ×4 cho:

- PNG `8000×8000`, RGB, khoảng `288,0106×288,0106 DPI`;
- PDF companion một trang, `41.181.102 byte`, MediaBox/CropBox hiệu dụng `1999,9264×1999,9264 pt`;
- PPE 96 DPI `2667×2667`, `21.338.667` byte RGB, `2.349,7 ms`, `degraded=false`, `ink_unsound=false`, `pdf_recovered=false`.

Như vậy lỗi lịch sử `8000 px -> 8000 pt -> 10667×10667 @96 DPI` không tái xuất hiện.

Tuy nhiên bản hiện tại vẫn chưa đạt điều kiện phát hành vì còn sáu residual P2:

1. Undo riêng của Upscale vẫn có fallback nhận diện bằng tên output + dung lượng Blob.
2. `disposeUpscaleTab()` không có caller production; đóng tab vẫn để state/Blob/object URL sống.
3. Allowlist mới làm fast path `file_path` vô hiệu với file người dùng ở Desktop, ổ D, USB; ngay cả file hợp lệ trong `%TEMP%` cũng có thể bị 403 do short-path/long-path mismatch.
4. Frontend PDF fallback vẫn bỏ ICC và tạo `/DeviceRGB`, không parity màu với native `/ICCBased`.
5. Abort phía frontend không dừng inference backend; mỗi companion PDF tạo một `threading.Timer` ngủ hai giờ và có thể thành orphan sau restart.
6. Release smoke mới chỉ chứng minh symbol callable, chưa chạy merger thật trên PNG pHYs + alpha + ICC và chưa được chốt ở staged native gate.

Không còn P1 cũ ở nguyên trạng, nhưng các residual trên vi phạm trực tiếp các acceptance criterion bắt buộc về màu in, lifecycle, cancellation, hiệu năng và artifact release. Chuỗi Tauri UI/native drop/multi-tab/installed release cũng chưa được chạy lại end-to-end. Vì vậy kết luận vẫn là **NO-GO**, không phải `GO CÓ ĐIỀU KIỆN`.

## 2. Phạm vi và mức bằng chứng

Luồng đã trace lại:

`File ảnh -> batch Upscale -> FormData/file_path -> /api/pdf-tools/upscale -> AI inference -> PNG -> PDF companion -> response headers/CORS -> commitWorkingFile -> sourceImageFile -> Viewer/PPE -> Bù xén/Tạo đường cắt`

Các tầng trọng tâm đã đối chiếu:

- `desktop/src/components/preprocess-tools/UpscaleTool.tsx`
- `desktop/src/components/preprocess-tools/UpscaleTool.test.tsx`
- `desktop/src/components/preprocess-tools/imageBatch/helpers.ts`
- `desktop/src/components/preprocess-tools/imageBatch/store.ts`
- `desktop/src/components/imposition-tools/sections/PreprocessingRouter.tsx`
- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/App.tsx`
- `desktop/src/lib/imageNormalizer.ts`
- `backend/app/api/routes/pdf_tools.py`
- `backend/app/core/artifact_runtime_self_test.py`
- `backend/app/core/cleanup.py`
- `backend/app/core/heavy_job_scheduler.py`
- `backend/app/workers/realesrgan_engine.py`
- `backend/app/workers/pdf_manifest_engine.py`
- `backend/app/main.py`
- `build_production.ps1`
- `scripts/verify_installed_artifact.ps1`

Mức bằng chứng của vòng re-audit:

| Audit unit | Mức đạt |
|---|---|
| Route Upscale, PNG, PDF companion file khách | `ARTIFACT + RUNTIME` |
| PPE 96 DPI trên companion PDF mới | `ARTIFACT + RUNTIME` |
| Gray/LAB ICC -> PNG/PDF | `ARTIFACT` với ICC thật |
| Path scope, short/long alias, symlink/UNC | `RUNTIME/PROBE` |
| Warmup và heavy-slot admission | `RUNTIME` |
| Disconnect và orphan artifact | `RUNTIME` bằng raw socket |
| Promote/Undo/store lifecycle | `AUTO + TRACED`; chưa thao tác Tauri thật |
| Native/frontend PDF parity | `ARTIFACT + TRACED` |
| Release sidecar | `AUTO + TRACED`; chưa build/cài artifact mới |

## 3. Kết quả lifecycle của 9 finding cũ

| ID | Mức cũ | Trạng thái re-audit | Mức còn lại | Kết luận ngắn |
|---|---|---|---|---|
| §UP.X.01 | P1 | `[PARTIAL]` | P2 | Promote/dedup chính đã dùng path/reference identity; Undo vẫn fallback name + result size |
| §UP.X.02 | P2 | `[OPEN]` | P2 | Có API dispose nhưng không được nối vào lifecycle đóng tab production |
| §UP.X.03 | P2 | `[CLOSED]` | — | 400/403/404 path request được retry một lần bằng File bytes |
| §UP.X.04 | P1 | `[CLOSED-EXACT]` | — | Arbitrary out-of-scope path, symlink và UNC/device path cũ đã bị chặn; hồi quy contract mới theo §UP.R.01 |
| §UP.X.05 | P1 | `[CLOSED]` | — | Gray/LAB ICC thật được convert sRGB; PNG/PDF colorspace khớp RGB |
| §UP.X.06 | P2 | `[OPEN]` | P2 | pdf-lib fallback vẫn bỏ ICC |
| §UP.X.07 | P2 | `[OPEN]` | P2 | Client abort không cooperative-cancel backend; PDF lifecycle vẫn dựa Timer/TTL |
| §UP.X.08 | P2 | `[CLOSED]` | — | Warmup không còn lấy heavy slot; request thật được admit sau 9,8 ms |
| §UP.X.09 | P2 | `[PARTIAL]` | P2 | Frozen self-test kiểm symbol nhưng chưa kiểm hành vi merger/artifact thật |

Finding mới:

| ID | Mức | Lifecycle | Kết luận ngắn |
|---|---|---|---|
| §UP.R.01 | P2 | `[CONFIRMED]` | Path allowlist an toàn hơn nhưng làm mất fast path file người dùng và tự từ chối `%TEMP%` trên máy có alias 8.3 |

Nợ verify không xếp release finding riêng: ESLint rộng phát hiện `imageBatch/store.ts:175` khai báo `_` nhưng không dùng. Đây là P3/code-quality, không đổi hành vi runtime.

## 4. Các finding đã đóng

### 4.1 §UP.X.03 — Path stale đã có fallback sang upload

`UpscaleTool.tsx:128-166` gửi `file_path` trước, rồi với HTTP `400/403/404` và `item.fileObj.size > 0` dựng FormData mới chứa bytes, giữ nguyên engine, scale, `include_working_pdf` và AbortSignal.

Kết luận correctness của finding cũ được đóng. Chính probe 403 của §UP.R.01 cũng chứng minh nhánh retry sẽ là đường bắt buộc với file Desktop hiện tại. Khoảng trống còn lại là chưa có regression test khóa lần retry và payload parity; khoảng trống đó được tính vào §UP.R.01, không mở lại §UP.X.03.

### 4.2 §UP.X.04 — Arbitrary local image read và symlink bypass cũ đã đóng

`pdf_tools.py:219-290` hiện:

- chặn traversal, UNC/device path;
- kiểm symlink trước `realpath`;
- kiểm regular file và extension ảnh;
- canonicalize candidate rồi giới hạn vào uploads/results/temp.

Probe độc lập cho kết quả:

- file khách trên Desktop: HTTP 403 `Path is outside the allowed directories`;
- symlink: HTTP 403;
- UNC/device path: bị từ chối trước khi mở file;
- file ngoài scope không được đưa vào Pillow/AI.

Do đó P1 “renderer có thể đọc absolute image tùy ý/symlink bypass” đã đóng. Việc scope mới không gắn với picker grant, quá rộng ở `%TEMP%` nhưng lại quá hẹp với file người dùng là finding mới §UP.R.01.

### 4.3 §UP.X.05 — Gray/LAB ICC đã đúng contract

`pdf_tools.py:117-129,1850-1893` đọc ICC data colorspace ở header, rồi chuyển profile-to-profile sang sRGB nếu output AI sẽ là RGB.

Hai probe dùng profile thật:

| Nguồn | HTTP/warning | PNG | Companion PDF |
|---|---|---|---|
| Gray + `BlackWhite.icc` | 200, `icc-converted-to-srgb` | mode RGB, ICC signature `RGB `, DPI đúng | `/ICCBased`, `/N 3`, một trang |
| LAB + profile LittleCMS thật | 200, `icc-converted-to-srgb` | mode RGB, ICC signature `RGB `, DPI đúng | `/ICCBased`, `/N 3`, một trang |

Không còn tình trạng RGB pixels mang Gray/LAB profile, native merger không còn từ chối companion PDF. Test tự động hiện mới khóa helper/fake header và Gray; vẫn nên thêm LAB artifact test để chống hồi quy, nhưng artifact hiện tại đủ đóng finding correctness.

### 4.4 §UP.X.08 — Warmup không còn chặn heavy queue

`pdf_tools.py:1989-2015` chuyển warmup sang Starlette threadpool thường; `_probe_lock` và DirectML session lock bên trong engine vẫn giữ serialization đúng hợp đồng.

Runtime với ba warmup `quality` đồng thời và một request thật:

- `active_before_real={}`;
- `waiting_before_real={}`;
- request thật vào heavy scheduler sau `9,8 ms`;
- cả ba warmup trả `ok=true`.

Finding “ba warmup giữ hết ba heavy slots” được đóng. Duplicate waiter vẫn dùng AnyIO threadpool token, nhưng chưa có bằng chứng gây starvation hoặc vi phạm cap; không nâng thành finding mới trong vòng này.

## 5. Finding còn mở hoặc chỉ đóng một phần

### §UP.X.01 — Undo vẫn có identity fallback không bất biến

**Mức:** P2
**Confidence:** 99%
**Vị trí:** `UpscaleTool.tsx:48-88,392-418`; ingest identity tại `imageBatch/helpers.ts:72-85`

**Bằng chứng/tái hiện**

Promote chính đã sửa đúng:

- Tauri so `path:` identity;
- browser so chính object `File` bằng reference equality;
- không còn fallback source name + size ở `isSameBatchSource()`.

Nhưng `handleUndoSelected()` tại `UpscaleTool.tsx:403-408` vẫn coi kết quả đang làm việc là item hiện hành nếu:

`sourceImageFile.name === upscaleOutputName(item.fileName)` và `sourceImageFile.size === item.resultBlob.size`.

Hai output khác nội dung nhưng trùng tên và byte-size vẫn thỏa nhánh này. Comment nói Undo dùng id duy nhất nhưng id không được gắn vào `sourceImageFile` đã commit, nên code phải quay lại heuristic cũ. Suite không có test collision cùng tên + size khác bytes.

**Hậu quả người dùng**

Undo riêng của Upscale có thể khôi phục original của item đang chọn dù workspace thực tế đang chứa output của item khác. Viewer PDF và `sourceImageFile` có thể lệch nhau, sau đó Bù xén/Tạo đường cắt nhận ảnh sai.

**Nguyên nhân gốc**

Identity của batch dừng ở `BatchItem`; `commitWorkingFile()` tạo một `File` mới nhưng không mang `item.id/sourceIdentity/resultIdentity`. Undo vì vậy không có token bất biến để đối chiếu workspace với item.

**Sửa nhỏ nhất đề xuất**

Gắn một token output bất biến, ví dụ `__prynxUpscaleResultId`, lên File kết quả khi commit và so đúng token trong Undo. Xóa hoàn toàn fallback name + size. Không hash lại Blob lớn ở mỗi Undo.

**Test hồi quy cần bổ sung**

1. Hai item cùng output name + byte-size nhưng khác bytes: chỉ item sở hữu token được hoàn tác workspace.
2. Undo item không phải workspace hiện hành chỉ đổi thumbnail của item đó.
3. Lặp cho browser File và Tauri path-backed File.
4. Ctrl+Z document sau Undo riêng vẫn khôi phục đồng thời PDF và `sourceImageFile`.

**Blast radius hạ nguồn**

Upscale batch, `commitWorkingFile`, document history, `sourceImageFile`, Sticker/Bù xén/Tạo đường cắt.

### §UP.X.02 — Dispose tab là dead production code

**Mức:** P2
**Confidence:** 100%
**Vị trí:** `imageBatch/store.ts:161-177`; `UpscaleTool.tsx:257-268,289-298`; `App.tsx:637-655`

**Bằng chứng/tái hiện**

- Store đã có `destroyTab()` để revoke source/result URL và xóa hẳn key.
- `disposeUpscaleTab()` đã abort controller và gọi `destroyTab()`.
- `rg "disposeUpscaleTab|destroyTab" desktop/src --glob '!**/*.test.*'` chỉ thấy định nghĩa và lời gọi nội bộ, không có caller từ shell.
- Lifecycle đóng tab thật ở `App.tsx:637-655` chỉ `fileCtx.releaseTab(id)`, xóa recovery snapshot và lọc `tabs`; không gọi dispose Upscale.
- Unmount `UpscaleTool` chỉ `cancelBatch(tabId)`, không destroy Zustand record.
- `imageBatch/store.test.ts` chưa có test `destroyTab()`.

**Hậu quả người dùng**

Đóng nhiều tab ảnh lớn vẫn giữ `BatchItem`, source Blob, result Blob và object URL trong singleton store. Network request bị abort ở frontend nhưng state tab đóng vẫn sống và RAM WebView tăng theo lịch sử tab.

**Nguyên nhân gốc**

API cleanup đã được thêm ở component feature nhưng không được nối vào owner thật của lifecycle tab là `App.commitCloseTab()`.

**Sửa nhỏ nhất đề xuất**

Gọi `disposeUpscaleTab(id)` trong `commitCloseTab()` hoặc qua một registry disposer theo tab. Chỉ dispose khi tab thật sự đóng, không dispose khi người dùng chỉ chuyển công cụ nếu sản phẩm muốn giữ batch.

**Test hồi quy cần bổ sung**

1. Đóng tab qua nút X, Ctrl+W và “Đóng tất cả tab”: controller abort, URL revoke, key Zustand mất.
2. Chuyển Upscale -> Sticker trong cùng tab không vô tình xóa state nếu contract là giữ batch.
3. Tab A đóng không ảnh hưởng batch/controller của tab B.
4. Test store trực tiếp khóa `destroyTab()` revoke cả original/result URL.

**Blast radius hạ nguồn**

Shell tab lifecycle, Upscale store singleton, WebView RAM, object URL, request controller và multi-tab.

### §UP.R.01 — Path allowlist làm fast path vô hiệu và lỗi alias `%TEMP%`

**Mức:** P2
**Confidence:** 100%
**Vị trí:** `UpscaleTool.tsx:128-166`; `pdf_tools.py:226-290,1810-1814`

**Bằng chứng/tái hiện**

Probe API trên đúng file khách:

```text
POST /api/pdf-tools/upscale
file_path=C:\Users\Khanh Pham\Desktop\tải xuống.jpg
=> HTTP 403 {"detail":"Path is outside the allowed directories"}
```

Scope hiện chỉ có `UPLOAD_DIR`, `RESULTS_DIR`, `tempfile.gettempdir()`. Nó không có picker grant hoặc tab ownership cho Desktop, ổ D, USB/NAS. Vì vậy request path đầu tiên của mọi file người dùng thông thường thất bại rồi frontend upload toàn bộ bytes lần hai.

Probe direct validator trên một PNG thật trong PrynX temp:

```text
input       = C:\Users\KHANHP~1\AppData\Local\Temp\PrynX-dev\results\...\alpha.png
allowed     = C:\Users\KHANHP~1\AppData\Local\Temp
realpath    = C:\Users\Khanh Pham\AppData\Local\Temp\PrynX-dev\results\...\alpha.png
outcome     = 403 Path is outside the allowed directories
```

`os.path.realpath(candidate)` mở rộng alias 8.3 nhưng allowed roots chỉ dùng `abspath`, nên `normcase + startswith` vẫn so hai chuỗi không đồng nhất.

Về bảo mật, cho phép toàn bộ `%TEMP%` cũng chưa phải contract picker grant: renderer có thể tham chiếu mọi ảnh mà OS user đọc được trong thư mục temp, không chỉ file thuộc tab/app.

**Hậu quả người dùng**

- Mất tối ưu “backend đọc thẳng picker path”; file lớn bị giữ trong WebView, truyền localhost và ghi temp lại.
- Cold/warm timing trên file nhỏ có thể chưa lộ rõ, nhưng ảnh TIFF/PNG lớn hoặc ổ chậm chịu thêm copy/RAM/I/O.
- File temp hợp lệ cũng không dùng được fast path trên máy có short-name alias.
- Nếu chỉ nới allowlist sang Desktop/ổ đĩa để chữa hiệu năng sẽ tái mở P1 bảo mật cũ.

**Nguyên nhân gốc**

Security fix dùng allowlist thư mục tĩnh để thay cho capability/picker grant động; candidate và roots không qua cùng canonicalization pipeline.

**Sửa nhỏ nhất đề xuất**

1. Canonicalize cả allowed roots lẫn candidate bằng cùng một hàm Windows-aware trước khi `commonpath`/scope check; thêm test alias 8.3.
2. Với file người dùng ngoài app temp, dùng opaque one-time grant gắn `tabId + canonical path + expiry`, được tạo từ native picker/drop owner; backend chỉ nhận path kèm grant hợp lệ.
3. Giữ retry upload làm safety fallback cho stale/revoked grant; không mở rộng allowlist toàn ổ/whole Desktop.

**Test hồi quy cần bổ sung**

1. Picker Desktop, ổ D, USB: grant hợp lệ đi path fast path, không có request upload thứ hai.
2. Cùng file qua short/long path alias được nhận diện như nhau.
3. Path không grant, grant sai tab/hết hạn, symlink/junction ra ngoài scope, UNC/device: fail trước khi inference.
4. Path stale/revoked grant nhưng bytes còn: đúng một retry upload, payload option không đổi.
5. Browser không Tauri: chỉ upload, không gửi local path.

**Blast radius hạ nguồn**

Tauri picker/native drop/DOM drop, local file transport, sidecar trust boundary, upload temp, RAM/I/O và cold-start latency.

### §UP.X.06 — Frontend PDF fallback vẫn bỏ ICC

**Mức:** P2
**Confidence:** 100%
**Vị trí:** `imageNormalizer.ts:39-58,117-158`; caller `ImpositionTab.tsx:873-898`

**Bằng chứng/tái hiện**

`embedImagePreserveCompression()` vẫn chỉ gọi `pdf-lib.embedPng()`/`embedJpg()`. Helper chỉ đọc pHYs/JFIF để tính MediaBox; không đọc iCCP và không dựng `/ICCBased`.

Artifact cùng decoded pixels cho thấy:

| Thuộc tính | Native companion | Frontend fallback |
|---|---|---|
| MediaBox | tương đương trong sai số khoảng `1,2e-7 pt` | tương đương |
| Alpha | `/SMask` | `/SMask` |
| Màu | `/ICCBased` | `/DeviceRGB` |

Suite `imageNormalizer.test.ts` kiểm DPI, thứ tự và định dạng nhưng không có ICC/AdobeRGB/native-vs-fallback parity.

**Hậu quả người dùng**

Khi backend không trả companion path, browser không Tauri hoặc release thiếu native merger, cùng một PNG Upscale có thể được Viewer/PPE diễn giải màu khác đường native. Wide-gamut/custom ICC có nguy cơ đổi màu in mà không cảnh báo.

**Nguyên nhân gốc**

pdf-lib không tự chuyển iCCP thành PDF ICCBased; fallback hiện chỉ bảo toàn pixel/alpha/khổ trang, chưa có contract quản lý màu.

**Sửa nhỏ nhất đề xuất**

Ưu tiên bắt buộc backend/native tạo PDF cho workflow in. Nếu vẫn giữ frontend fallback, phải parse/nhúng ICCBased hoặc color-convert có quản lý sang sRGB trước `embedPng()` và phát warning rõ; không được im lặng bỏ profile.

**Test hồi quy cần bổ sung**

1. PNG AdobeRGB/custom RGB ICC với swatch biết trước.
2. Parse native/fallback: ICCBased hoặc pixel đã convert sRGB có chứng cứ.
3. PPE render hai artifact và khóa sai số màu/Delta E đã được product duyệt.
4. MediaBox, DPI và alpha vẫn parity.

**Blast radius hạ nguồn**

Upscale fallback, mở ảnh thành PDF, Combine ảnh, Viewer/PPE, Sticker và workflow in color-managed.

### §UP.X.07 — Abort client chưa hủy backend và PDF lifecycle vẫn không bền

**Mức:** P2
**Confidence:** 100%
**Vị trí:** `UpscaleTool.tsx:102-120,250-268,289-298`; `pdf_tools.py:1791-1798,1831-1965`; `cleanup.py` orphan sweep

**Bằng chứng/tái hiện**

- Route không nhận `Request`, không gọi `request.is_disconnected()`.
- `_process_upscale()` và Real-ESRGAN tile loop không nhận cancellation token.
- Frontend unmount đã abort fetch, nhưng chỉ đóng socket/client side.
- Raw-socket probe đóng client sau khi inference bắt đầu: backend vẫn chạy thêm `1.200,6 ms`; PNG được dọn nhưng companion PDF vẫn còn.
- Mỗi response có PDF tạo một `threading.Timer(7200)` tại `pdf_tools.py:1941-1953`.
- Nếu process restart trước hai giờ, Timer mất; orphan lại chờ sweep chung khoảng 26 giờ.

**Hậu quả người dùng**

Đóng tab/rời tool vẫn tiêu GPU, heavy slot, RAM và encode. Batch bị hủy có thể để nhiều PDF lớn trên đĩa; nhiều job thành công đồng thời tạo nhiều thread ngủ hai giờ.

**Nguyên nhân gốc**

Cancellation không xuyên từ HTTP lifecycle vào engine; companion artifact không có claim/lease owner bền, chỉ có Timer in-process sau response.

**Sửa nhỏ nhất đề xuất**

1. Nhận `Request`, kiểm disconnect trước admission, giữa tile, trước encode và trước tạo PDF.
2. Truyền cooperative cancellation check vào Real-ESRGAN loop; không cố interrupt giữa một DirectML `session.run`, chỉ dừng ở ranh giới an toàn.
3. Thay per-file Timer bằng registry/lease có expiry do cleanup scheduler quản lý; frontend claim khi commit workspace thành công.
4. Nối `disposeUpscaleTab()` để close-tab abort controller thật.

**Test hồi quy cần bổ sung**

1. Raw socket disconnect giữa các tile: không chạy tile kế tiếp, không có PNG/PDF mới.
2. Abort trước admission: không xuất hiện trong active/waiting heavy jobs.
3. Process restart trước TTL: orphan vẫn được cleanup theo lease persisted/sweep ngắn.
4. Success path: PDF tồn tại đủ lâu và chỉ bị xóa sau khi consumer hết quyền sở hữu.

**Blast radius hạ nguồn**

Upscale endpoint, Real-ESRGAN, heavy scheduler, results cleanup, tab close và các AI route dùng cùng pattern.

### §UP.X.09 — Release smoke mới kiểm symbol, chưa kiểm hành vi merger

**Mức:** P2
**Confidence:** 98%
**Vị trí:** `artifact_runtime_self_test.py:124-151`; `build_production.ps1:700-717`; `verify_installed_artifact.ps1:589-621`; `test_artifact_runtime_self_test.py`

**Bằng chứng/tái hiện**

Phần đã sửa đúng:

- frozen self-test import `pdfcompare_native` và bắt buộc callable `combine_image_manifest_native`;
- thiếu symbol làm self-test raise;
- installed verifier thực sự chạy sidecar với `--artifact-self-test`, nên binary thiếu symbol không còn qua được marker `status=ok`.

Phần còn thiếu:

- staged native gate trong `build_production.ps1` chưa đưa symbol này vào `required_symbols`;
- self-test không gọi merger, không tạo/parse PDF từ PNG có pHYs + alpha + ICC;
- verifier không khóa riêng `payload.native_merger`;
- không có negative test fake native thiếu/broken symbol;
- vòng re-audit chưa build/cài artifact từ worktree hiện tại.

**Hậu quả người dùng**

Một extension có attribute callable nhưng ABI/hành vi merger hỏng vẫn có thể qua self-test; lỗi chỉ xuất hiện khi Upscale/Combine tạo PDF thật. Staged build cũng fail muộn thay vì fail ngay tại native gate.

**Nguyên nhân gốc**

Release contract được mở rộng ở mức symbol existence, chưa mở rộng tới behavior/artifact contract của tính năng mới.

**Sửa nhỏ nhất đề xuất**

Thêm symbol vào staged required set. Trong frozen self-test, tạo PNG rất nhỏ có pHYs + alpha + RGB ICC, gọi merger thật, parse một trang và kiểm MediaBox, `/SMask`, `/ICCBased /N 3`; installed verifier assert `native_merger=true` và marker behavior tương ứng.

**Test hồi quy cần bổ sung**

1. Fake native thiếu symbol -> self-test/installed verifier fail.
2. Symbol callable nhưng ném lỗi hoặc tạo PDF sai -> fail.
3. Clean Nuitka artifact chạy smoke thật và ghi attestation riêng vào manifest.
4. Parser PowerShell và unit build-contract tiếp tục đạt.

**Blast radius hạ nguồn**

Nuitka staging, installed QA, frozen sidecar, Upscale companion PDF và Combine ảnh lossless.

## 6. Ma trận đầu vào -> artifact -> consumer của vòng re-audit

| Đầu vào | Factor | Pixel/DPI output | Kích thước vật lý/PDF | PPE 96 DPI | Nguồn Sticker/Bù xén |
|---|---:|---|---|---|---|
| JPEG khách 2000×2000, no DPI | ×4 Balanced thật | 8000×8000; ~288,0106 DPI | 1999,9264×1999,9264 pt; 1 trang | **2667×2667 thật, đạt** | Ảnh Upscale theo luồng đơn ở mức `AUTO/TRACED` |
| Gray + ICC thật | probe route | pixel đúng factor; output RGB + ICC `RGB `; DPI đúng | companion `/ICCBased /N 3` | khổ dự kiến đúng theo DPI | Ảnh Upscale |
| LAB + ICC thật | probe route | pixel đúng factor; output RGB + ICC `RGB `; DPI đúng | companion `/ICCBased /N 3` | khổ dự kiến đúng theo DPI | Ảnh Upscale |
| PNG RGB ICC/alpha qua native | fixture artifact | pixel/alpha giữ | `/ICCBased` + `/SMask`, MediaBox đúng | contract đạt | Ảnh Upscale |
| Cùng PNG qua frontend fallback | fixture artifact | pixel/alpha giữ | `/DeviceRGB` + `/SMask`, MediaBox đúng | **không parity màu — §UP.X.06** | Ảnh Upscale |
| Batch collision cùng tên + size | code/probe | output item riêng | promote chính đã đúng | n/a | Undo riêng còn rủi ro §UP.X.01 |

Corpus JPEG/PNG/TIFF/WebP/CMYK, 72/96/150/300 DPI, DPI X/Y lệch, EXIF 90°, ×2/×4 đã đạt ở baseline 2026-08-10. Vòng re-audit này không chạy lại toàn bộ 22 artifact đó; chỉ chạy lại các vùng code đã thay đổi và file khách. Vì vậy không dùng baseline cũ để nâng mức bằng chứng của các dòng chưa chạy lại.

## 7. Hiệu năng và tài nguyên

### 7.1 File khách Balanced ×4

Lượt instrumented của vòng re-audit:

- HTTP 200;
- tổng `11,073 s`;
- PNG `8000×8000`, PDF `41.181.102 byte`;
- kích thước vật lý không hồi quy.

Một lượt bổ sung để tạo fixture PPE hoàn tất HTTP 200 sau `16,8 s` wall, gồm cả nhận đủ response PNG `41.187.888 byte`; lượt này không có phase instrumentation nên không dùng để suy ra regression từng pha. Biến thiên giữa hai lượt cho thấy chưa đủ bằng chứng chốt SLA cold/warm mới.

### 7.2 Warmup

Warmup không còn giữ heavy slot. Ba warmup quality đồng thời không làm request thật chờ scheduler; admission `9,8 ms`. DirectML session serialization vẫn còn, đúng bất biến thread-safety/provider.

### 7.3 Fast path

Đây là hồi quy hiệu năng xác nhận: path request của file người dùng thông thường nhận 403 rồi upload lại. Số đo file khách chỉ `92.271 byte` không đại diện chi phí trên TIFF/PNG lớn. Không được dùng kết quả warmup tốt để che hồi quy I/O này.

### 7.4 Máy mạnh/máy yếu

Không phát hiện hard-cap Upscale mới trên máy audit `>=16 GiB`; policy tile/worker hiện vẫn gate theo RAM. Không sửa cap để chữa các finding trên.

## 8. Kiểm thử và probe đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `desktop\npm.cmd run typecheck` | Đạt |
| Vitest `UpscaleTool.test.tsx`, `imageBatch/store.test.ts`, `imageNormalizer.test.ts` | 3 file, 29 test đạt |
| ESLint tối thiểu hai file Upscale | Đạt |
| ESLint rộng các file liên quan | Không đạt: `_` unused tại `store.ts:175`; 4 `any` trong `helpers.ts` là nợ có sẵn |
| `pytest backend/tests/test_upscale.py -q` | 22 đạt, 2 warning thư viện |
| `pytest backend/tests/test_artifact_runtime_self_test.py -q` | 16 đạt, 1 warning thư viện |
| `py_compile pdf_tools.py artifact_runtime_self_test.py main.py` | Đạt |
| PowerShell parser `build_production.ps1` | Đạt |
| PowerShell parser `verify_installed_artifact.ps1` | Đạt |
| File khách Balanced ×4 + native companion | HTTP 200, artifact đúng |
| PPE 96 DPI trên companion mới | 2667×2667, 2.349,7 ms, không degraded/unsound/recovery |
| Gray/LAB ICC thật | HTTP 200, sRGB ICC, `/ICCBased /N 3` |
| Desktop path + temp alias + symlink/UNC | scope/symlink chặn; temp alias tái hiện 403 sai |
| 3 warmup quality + 1 real heavy request | warmup không giữ slot; request admit 9,8 ms |
| Raw socket disconnect | backend tiếp tục 1.200,6 ms; PDF còn lại |

Cảnh báo `[ICC] bỏ qua ... sRGB.icc vì danh tính không khớp` khi PPE chạy là guardrail đã biết: asset mang nhãn sRGB thực ra là Adobe RGB và resolver chủ động cách ly, sau đó dùng profile sRGB hợp lệ do LittleCMS materialize. PPE vẫn trả `degraded=false`; không mở finding Upscale mới cho warning này.

## 9. Khoảng trống runtime còn lại

Chưa được chứng minh trong vòng re-audit:

- thao tác Tauri end-to-end `mở ảnh -> Upscale -> Bù xén/Tạo đường cắt -> viewer accurate`;
- native drop/DOM drop, hai tab chạy đồng thời rồi đóng một tab thật;
- Ctrl+Z và Undo riêng nhiều cấp bằng thao tác UI;
- Poppler render của companion PDF mới;
- toàn bộ mode Nhanh/Cân bằng/Chất lượng ×2/×4 sau bản sửa;
- full-size pdf-lib fallback benchmark và color parity;
- clean `run_dev.bat` session không lẫn process cũ;
- clean build, cài và smoke installed release artifact.

Các gap này không được coi là “đạt ngầm” chỉ vì unit test xanh.

## 10. Lô sửa đề xuất sau khi được duyệt

Chưa sửa bất kỳ lô nào. Thứ tự đề xuất, mỗi lô tối đa 5 file:

1. **Lô A — identity + close-tab lifecycle:** §UP.X.01, §UP.X.02 và test collision/destroy/close-tab.
2. **Lô B — path capability:** §UP.R.01, canonicalization alias, picker/drop grant và security tests.
3. **Lô C — ICC fallback parity:** §UP.X.06, AdobeRGB artifact test và PPE comparison.
4. **Lô D — cooperative cancel + artifact lease:** §UP.X.07, raw-socket regression và restart cleanup.
5. **Lô E — functional release smoke:** §UP.X.09, staged gate, frozen merger artifact và negative tests.
6. Sau các lô: chạy lại toàn ma trận ×2/×4, Tauri UI sạch, Poppler/PPE và installed artifact trước khi đổi verdict.

## 11. Kết luận

**NO-GO.**

Bản tự sửa có tiến bộ rõ và đã đóng đúng ba P1 cũ ở đường chính. Đặc biệt, Gray/LAB ICC, path traversal/arbitrary read, warmup heavy-slot và kích thước PPE đều có bằng chứng artifact/runtime tốt.

Nhưng bản phát hành vẫn có thể:

- khôi phục sai ảnh khi Undo riêng gặp output collision;
- giữ Blob/object URL của tab đã đóng;
- bỏ ICC ở frontend fallback;
- tiếp tục chạy GPU và để PDF orphan sau client abort;
- mất fast path trên chính file người dùng;
- vượt release smoke dù native merger callable nhưng hành vi hỏng.

Đây đều là yêu cầu cốt lõi của đợt sửa Upscale, không chỉ là polish. Theo workflow hai chốt, re-audit dừng ở báo cáo này và chờ duyệt trước khi sửa code theo lô.
