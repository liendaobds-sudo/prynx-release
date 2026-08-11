# Báo cáo audit — Phục hồi & Vector hóa Logo, re-audit 2026-08-09

**Revision đối chiếu:** `89a9048`<br>
**Trạng thái worktree:** bẩn do nhiều thay đổi song song ngoài phạm vi; audit không sửa mã sản phẩm.<br>
**Phạm vi:** Home/registry → tab và định tuyến file → workspace → preflight/preview/cancel → scheduler/RAM → worker/PyO3/VTracer → QC → SVG hiển thị/lưu. Bao gồm entitlement, multi-tab, dirty-session, i18n, accessibility và dev/release gate.<br>
**Ngoài phạm vi:** AI dựng phần logo bị che/mất nét, ảnh vải nhăn có ground truth, fuzz dài cho Pillow/OpenCV/VTracer, installer production và nghiệm thu với Illustrator/CorelDRAW/RIP.

## Tóm tắt điều hành

Đường chạy lõi hiện đã reachable và tạo được SVG thật: ảnh phẳng vòng khuyên 128×128 qua đúng worker + native VTracer + mask nền, render lại bằng Chromium cho thấy vùng ngoài và counter trong suốt, vành đỏ giữ nguyên. Các cổng tự động hiện xanh: backend Logo/feature gate **38 passed**, frontend Logo/routing **60 passed**, production routing **21 passed**, desktop typecheck đạt, Rust Logo **8 passed** sau khi chạy với Python venv đúng.

Tuy vậy, tính năng vẫn **NO-GO production và chỉ nên dev-only**. Có 7 finding P1 đã xác minh trên đường live, chủ yếu là an toàn tài nguyên, mất trạng thái/ngữ cảnh và rủi ro người dùng xuất kết quả không đạt; 7 finding P2 và 1 P3. Ba lỗi từ vòng trước đã được xác nhận đóng: compound counter khi loại nền, ảnh alpha hoàn toàn trong suốt và output-QC rỗng/quá phức tạp. Chất lượng JPEG thật vẫn là **proof gap**, chưa được nâng thành “đạt” chỉ từ artifact cũ.

**Mức bằng chứng chung:** `ARTIFACT` cho corpus synthetic đã kiểm (chưa phải `RUNTIME` vì chưa chạy lại chuỗi đầy đủ trên app Tauri/release). Không có finding bảo mật mới đủ bằng chứng về bypass Free→Pro; release gate của Logo vẫn là vấn đề kiểm soát phát hành, không phải kết luận bypass entitlement.

## Kiến trúc / đường chạy đã trace

1. **Entry và gate UI:** card registry chỉ được tạo khi `LOGO_REBUILD_ENABLED` đúng ([toolRegistry.ts:703-720](../desktop/src/lib/toolRegistry.ts#L703)); cờ hiện lấy trực tiếp từ `import.meta.env.DEV` ([preprocessRouterTools.ts:19-25](../desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts#L19)). `ImpositionTab` nhận `focusFeature`, đặt `activeDashboardTool` ([ImpositionTab.tsx:576-600](../desktop/src/components/ImpositionTab.tsx#L576)) và mount workspace khi Logo active ([ImpositionTab.tsx:2664-2667](../desktop/src/components/ImpositionTab.tsx#L2664)).
2. **Workspace:** component giữ file/editor/history/preview/job cục bộ ([LogoRebuildWorkspace.tsx:90-115](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L90)); chọn file → preflight ([LogoRebuildWorkspace.tsx:366-391](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L366)); tạo preview và lọc response stale ([LogoRebuildWorkspace.tsx:393-468](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L393)); hủy ([LogoRebuildWorkspace.tsx:470-503](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L470)); lưu Blob SVG ([LogoRebuildWorkspace.tsx:505-526](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L505)).
3. **Định tuyến file:** `ImpositionTab` đăng ký feature runtime theo từng tab ([ImpositionTab.tsx:264-269](../desktop/src/components/ImpositionTab.tsx#L264)), nhưng registry event ảnh chỉ có `bgremover` và `upscale` ([tabNavigation.ts:22-28](../desktop/src/lib/tabNavigation.ts#L22)); dispatcher fallback ảnh vào tab imposition thường/Combine ([useIncomingFileDispatcher.ts:67-76](../desktop/src/hooks/useIncomingFileDispatcher.ts#L67)).
4. **API:** desktop gọi capabilities/preflight/preview/delete qua `logoRebuildApi.ts` ([logoRebuildApi.ts:91-142](../desktop/src/lib/logoRebuildApi.ts#L91)). Backend đăng ký router thật ([main.py:267-271](../backend/app/main.py#L267)), áp entitlement ở router ([logo_rebuild.py:40](../backend/app/api/routes/logo_rebuild.py#L40)), tiền kiểm ([logo_rebuild.py:172-197](../backend/app/api/routes/logo_rebuild.py#L172)) và preview/cancel ([logo_rebuild.py:200-257](../backend/app/api/routes/logo_rebuild.py#L200)).
5. **Engine và artifact:** preview reserve job rồi đẩy worker vào heavy scheduler ([logo_rebuild.py:209-220](../backend/app/api/routes/logo_rebuild.py#L209)); worker giải mã/ICC/crop/perspective/upscale/RAM ([logo_rebuild.py:491-559](../backend/app/workers/logo_rebuild.py#L491)), gọi PyO3 VTracer ([logo_rebuild.py:677-717](../backend/app/workers/logo_rebuild.py#L677)) và QC SVG ([logo_rebuild.py:728-778](../backend/app/workers/logo_rebuild.py#L728)). Native nhận RGBA, palette đã xác nhận và token hủy ([logo_vectorizer.rs:160-196](../native/src/logo_vectorizer.rs#L160)). Consumer cuối là `<img>` preview và `saveBlob` ghi SVG ([LogoRebuildWorkspace.tsx:831-870](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L831)).

## Hợp đồng đã kiểm

| Biên | Hợp đồng hiện tại | Kết quả audit |
|---|---|---|
| Mode | Chỉ `monochrome` hoặc `fixed_palette`; auto-color tắt | Đúng; test và capabilities đều khóa |
| Palette | 1–12 mã `#RRGGBB`; background phải khác palette | Đúng ở schema, nhưng CTA frontend có thể tự tạo xung đột (§LR3.11) |
| Crop/quad | Chuẩn hóa 0..1; không dùng đồng thời; quad phải lồi, không suy biến | Backend enforcement đúng; client validate muộn (§LR2.14 còn mở) |
| Alpha | Ảnh không có pixel nhìn thấy bị từ chối trước native | Đã đóng và có test native/backend |
| Preview result | `ready | review | rejected`, complexity và reason/action | Đã đóng ở code/test; chưa nghiệm thu UI Tauri |
| RAM | Máy <16 GB mới giảm kích thước; máy ≥16 GB giữ nguyên nếu đủ RAM | Giữ nguyên nguyên tắc tier, nhưng không reserve theo concurrency (§LR3.01) |
| Kích thước vật lý | DPI nguồn được chuyển thẳng thành `width/height` mm | Tính được nhưng không phải kích thước in đã xác nhận (§LR3.03) |
| Quyền | Backend `util.logo_rebuild` là Pro; frontend card dev-only | Entitlement đúng, release flag chưa chung (§LR3.10) |

## Phát hiện đã xác minh

### §LR3.01 — P1/M — `[CONFIRMED]` Admission RAM không chia theo slot; hàng đợi có thể làm kẹt đường hủy

**Đường chạy:** `POST /logo-rebuild/preview` → `reserve_logo_job` → `run_scheduled_in_threadpool` ([logo_rebuild.py:209-220](../backend/app/api/routes/logo_rebuild.py#L209)) → `_run_heavy` chờ semaphore trong Starlette threadpool ([heavy_job_scheduler.py:158-172](../backend/app/core/heavy_job_scheduler.py#L158)).

**Bằng chứng:** `_plan_work_size` tự tính một job từ `available_mb` và không đọc `max_active_heavy_jobs()` ([logo_rebuild.py:156-185](../backend/app/workers/logo_rebuild.py#L156)). Harness venv với hồ sơ 32 GB/12 GB available và 8000×8000 cho phép đủ kích thước: **6.835,9 MB/job**, usable **7.321,6 MB**, trong khi 2 job cùng được admission cần **13.671,9 MB**. Đây là vi phạm ngân sách theo concurrency, không phải suy đoán từ một hằng số.

Harness AnyIO đặt heavy slot = 1 và limiter = 2: job thứ nhất chạy, job thứ hai giữ token thứ hai để chờ semaphore; một tác vụ sync thứ ba (mô phỏng DELETE endpoint) không lấy được token trong 250 ms (`borrowed_tokens=2`, `sync_cancel_probe_blocked=true`).

**Consumer live:** native VTracer và các buffer RGBA/geometry trong `process_logo_preview` đọc toàn bộ kích thước đã plan ([logo_rebuild.py:690-716](../backend/app/workers/logo_rebuild.py#L690)).

**Tác động:** tải cục bộ hoặc hai ảnh lớn có thể OOM/swap; khi queue đầy người dùng không hủy được nhanh và health/API khác bị ảnh hưởng. Không thêm hard-cap vô điều kiện; hướng sửa phải reserve byte budget nguyên tử theo slot, admission async trước thread token và hỗ trợ cancel cả queued/running, vẫn giữ máy ≥16 GB chạy full khi ngân sách thực đủ.

### §LR3.02 — P1/M — `[CONFIRMED]` Màu nhấn dưới 1% bị bỏ im lặng khỏi palette gợi ý

**Đường chạy:** preflight → `suggest_logo_palette` ([logo_rebuild.py:172-197](../backend/app/api/routes/logo_rebuild.py#L172)) → filter coverage → CTA “Áp dụng gợi ý” ([LogoRebuildWorkspace.tsx:632-667](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L632)).

**Bằng chứng:** `_MIN_PALETTE_COVERAGE = 0.01` ([logo_rebuild.py:61-66](../backend/app/workers/logo_rebuild.py#L61)) và cụm nhỏ hơn bị `continue` ([logo_rebuild.py:454-475](../backend/app/workers/logo_rebuild.py#L454)). Ảnh 200×200 gồm nền trắng 74,75%, xanh 25% và dấu đỏ 0,25% trả đúng hai màu trắng/xanh, `warnings=[]`, `red_present=false`.

**Consumer live:** workspace sao chép toàn bộ `paletteSuggestions` vào editor và đánh dấu đã xác nhận ([LogoRebuildWorkspace.tsx:653-660](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L653)); sau đó `buildSettings` gửi palette này vào tracer ([LogoRebuildWorkspace.tsx:305-316](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L305)).

**Tác động:** dấu/chấm/màu nhận diện thương hiệu nhỏ có thể bị quy về màu gần nhất mà người dùng không biết. Không thể hạ ngưỡng toàn cục về 0 vì sẽ giữ nhiễu JPEG; cần cảnh báo/giữ candidate có chroma và vùng liên kết, hoặc cho eyedropper/nhãn “màu nhỏ cần kiểm tra”.

### §LR3.03 — P1/M — `[CONFIRMED]` DPI metadata quyết định kích thước mm mà không có bước xác nhận kích thước in

**Đường chạy:** worker đọc DPI → tính physical mm → ghi trực tiếp vào SVG ([logo_rebuild.py:493-501](../backend/app/workers/logo_rebuild.py#L493), [logo_rebuild.py:578-593](../backend/app/workers/logo_rebuild.py#L578)).

**Bằng chứng:** hai ảnh có cùng pixel 100×100, chỉ khác metadata DPI, qua worker hiện tại trả: 72 DPI → `35.2734mm`; 300 DPI → `8.4667mm`; cả hai đều `ready`. Đây là cùng artwork nhưng chênh **4,17×** chỉ do metadata thường bị web/JPEG đặt mặc định.

**Consumer live:** SVG được mở/lưu với `width`/`height` mm bởi preview và `saveBlob`; workspace không hiển thị mm hay cho nhập kích thước in xác nhận ([LogoRebuildWorkspace.tsx:839-870](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L839)).

**Tác động:** người dùng có thể đưa logo vào chế bản với kích thước vật lý sai mà preview pixel vẫn trông đúng. DPI chỉ nên là gợi ý; cần hộp xác nhận rộng/cao mm, khóa tỷ lệ và ghi quyết định vào history/artifact.

### §LR3.04 — P1/M — `[CONFIRMED]` Editor/preview Logo không tham gia dirty-session của tab

**Đường chạy:** App truyền `onDirtyChange` cho `ImpositionTab` ([App.tsx:1421-1429](../desktop/src/App.tsx#L1421)), nhưng `LogoRebuildWorkspaceProps` chỉ có `isActive` và toàn bộ state nằm local ([LogoRebuildWorkspace.tsx:21-23](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L21), [LogoRebuildWorkspace.tsx:90-115](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L90)).

**Bằng chứng:** `ImpositionTab.isDirty` chỉ xét history PDF/viewer/VDP/edit session, không xét `activeDashboardTool === 'logo_rebuild'` hay trạng thái workspace ([ImpositionTab.tsx:733-751](../desktop/src/components/ImpositionTab.tsx#L733)). Workspace chỉ đổi status sau lưu; không có callback dirty/save/recovery.

**Consumer live:** App đóng tab/cửa sổ dựa trên `tab.isDirty` ([App.tsx:664-690](../desktop/src/App.tsx#L664)); vì Logo không đẩy cờ lên, đổi palette/crop/preview rồi đóng có thể mất im lặng.

**Tác động:** mất editor/history/SVG chưa xuất, không có crash recovery. Cần hợp đồng dirty riêng cho Logo, clear chỉ sau save thành công và test close-tab/close-window/save-cancel/save-fail.

### §LR3.05 — P1/M — `[CONFIRMED]` Kéo/thả ảnh vào Logo không được định tuyến theo tab

**Đường chạy:** Tauri/DOM file event → `dispatchIncomingFileBatch` ([useIncomingFileDispatcher.ts:31-76](../desktop/src/hooks/useIncomingFileDispatcher.ts#L31)) → `resolveActiveImageBatchReceiver` ([tabNavigation.ts:43-79](../desktop/src/lib/tabNavigation.ts#L43)).

**Bằng chứng:** `IMAGE_BATCH_DROP_EVENTS` chỉ khai báo `bgremover` và `upscale` ([tabNavigation.ts:22-28](../desktop/src/lib/tabNavigation.ts#L22)); Logo workspace chỉ có `<input type=file>` và `onChange`, không có `onDrop`/receiver event ([LogoRebuildWorkspace.tsx:579-588](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L579)). Khi resolver trả null, một ảnh đi `onOpenApp('imposition')`, nhiều ảnh đi `combine_pdf` ([useIncomingFileDispatcher.ts:67-76](../desktop/src/hooks/useIncomingFileDispatcher.ts#L67)).

**Consumer live:** không có listener Logo nào nhận event fallback. Test hiện có chứng minh picker và routing batch khác, không chứng minh native drop Logo.

**Tác động:** thao tác đúng trên card nhưng file rơi vào tab PDF/Combine khác; trong multi-tab còn có nguy cơ tab Logo nền bị hút intent cũ. Cần receiver theo `activeTabId`, listener từ chối tab nền/đã đóng và test picker + DOM drop + Tauri native drop + hai tab.

### §LR3.06 — P1/S — `[CONFIRMED]` UI không hiển thị limitations và vẫn mời ảnh chụp/vải ngoài phạm vi đã duyệt

**Đường chạy:** capabilities trả limitations ([logo_rebuild.py:157-169](../backend/app/api/routes/logo_rebuild.py#L157)) → API client khai báo field ([logoRebuildApi.ts:26-34](../desktop/src/lib/logoRebuildApi.ts#L26)) → workspace render.

**Bằng chứng:** backend nêu rõ “chưa tự phục hồi phần logo bị che hoặc mất nét” và chỉ palette xác nhận ([logo_rebuild.py:44-57](../backend/app/api/routes/logo_rebuild.py#L44)); workspace chỉ hiển thị engine/version khi capabilities có ([LogoRebuildWorkspace.tsx:568-573](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L568)), không đọc/render `limitations`. Ngược lại, checkbox hiện câu “Cân bằng ánh sáng trên vải/ảnh chụp” ([LogoRebuildWorkspace.tsx:801-808](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L801)).

**Consumer live:** người dùng quyết định có upload/áp dụng preset dựa trên copy UI; không có warning phạm vi đi cùng artifact.

**Tác động:** tên “Phục hồi” và trạng thái `ready` dễ bị hiểu là engine đã dựng lại phần bị mất. Cần hiển thị giới hạn trước upload và đổi copy về artwork phẳng cho tới khi có classifier/corpus riêng.

### §LR3.07 — P1/M — `[CONFIRMED]` Không có công cụ QA trực quan tương ứng với cổng “kiểm tra trước khi in”

**Bằng chứng:** hai preview chỉ là `<img>` `object-contain` ([LogoRebuildWorkspace.tsx:831-850](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L831)); crop/quad chỉ nhập số phần trăm ([LogoRebuildWorkspace.tsx:749-790](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L749)). Không có zoom 100–800%, pan, A/B/overlay, ruler, tay nắm crop/quad hoặc click-to-inspect node.

**Tác động:** người dùng không thể kiểm thực tế counter, dấu nhỏ, path rác hay vùng crop dù UI yêu cầu phải kiểm tra trước khi in. Đây là thiếu năng lực nghiệm thu, không chỉ đánh bóng; cần làm sau khi các blocker integrity/resource đã đóng.

### §LR3.08 — P2/S — `[CONFIRMED]` Lỗi metadata native trước `try/finally` làm rò `_ACTIVE_JOBS`

**Đường chạy:** route reserve token ([logo_rebuild.py:209-214](../backend/app/api/routes/logo_rebuild.py#L209)) → `process_logo_preview` gọi `_load_native_module()` và `logo_vectorizer_info()` trước `try` ([logo_rebuild.py:677-687](../backend/app/workers/logo_rebuild.py#L677)) → cleanup chỉ nằm ở `finally` cuối hàm ([logo_rebuild.py:779-780](../backend/app/workers/logo_rebuild.py#L779)).

**Bằng chứng:** harness fake ABI làm `logo_vectorizer_info()` ném `RuntimeError`; sau exception UUID vẫn còn trong `_ACTIVE_JOBS`. Retry cùng UUID bị conflict cho tới restart process.

**Consumer live:** `reserve_logo_job` và `cancel_logo_job` đọc chính registry ([logo_rebuild.py:100-130](../backend/app/workers/logo_rebuild.py#L100)); capabilities có thể che một số ca nhưng không bảo vệ binary lệch ABI/metadata hỏng.

**Tác động:** retry của một job lỗi bị chặn và registry giữ token. Đưa load/info vào cùng `try/finally`, đồng thời dọn reservation nếu scheduler không gọi được worker.

### §LR3.09 — P2/S — `[CONFIRMED]` Capabilities lỗi không có trạng thái terminal/retry

**Đường chạy:** effect capabilities ([LogoRebuildWorkspace.tsx:225-231](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L225)) → render header và khóa nút preview ([LogoRebuildWorkspace.tsx:568-573](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L568), [LogoRebuildWorkspace.tsx:811-820](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L811)).

**Bằng chứng:** `.catch` chỉ `setError`, không set trạng thái `unavailable/error`; `capabilities` vẫn `null`, nên UI tiếp tục hiển thị “Đang kiểm tra engine…” và không có nút Thử lại. Đây là đường chạy deterministic khi GET capabilities lỗi.

**Tác động:** sidecar/native tạm thời lỗi khiến workspace kẹt cho tới remount/tab mới. Cần state machine loading/ready/unavailable/error và retry tách lỗi engine khỏi lỗi file/job.

### §LR3.10 — P2/M — `[CONFIRMED]` HOLD/release gate chỉ ở frontend, chưa fail-closed ở backend

**Đường chạy:** frontend gate DEV ([preprocessRouterTools.ts:19-25](../desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts#L19)) → backend route luôn include ([main.py:267-271](../backend/app/main.py#L267)) → router chỉ kiểm `util.logo_rebuild` ([logo_rebuild.py:40](../backend/app/api/routes/logo_rebuild.py#L40)).

**Bằng chứng:** production routing test **21/21** chứng minh card/đường mở frontend bị khóa; nhưng backend capabilities/preview vẫn reachable trên sidecar Pro vì không đọc cùng `LOGO_REBUILD_ENABLED`/release flag. `FEATURE_MIN_PLAN` vẫn khai Logo là Pro ([feature_entitlements.py:23-34](../backend/app/core/feature_entitlements.py#L23)).

**Tác động:** client Pro đã bị sửa hoặc caller nội bộ vẫn có thể gọi tính năng đang HOLD; frontend không phải enforcement boundary. Nếu chưa mở production, cần route/native bị loại hoặc một flag backend fail-closed chung. Không gọi đây là Free→Pro bypass.

### §LR3.11 — P2/S — `[CONFIRMED]` CTA áp dụng palette có thể xung đột với “Loại màu nền”

**Đường chạy:** preflight suggestion → “Áp dụng gợi ý” sao chép mọi màu ([LogoRebuildWorkspace.tsx:632-667](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L632)) → build background ([LogoRebuildWorkspace.tsx:305-316](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L305)) → client/schema reject nếu trùng ([LogoRebuildWorkspace.tsx:414-422](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L414), [logo_rebuild.py:100-110](../backend/app/schemas/logo_rebuild.py#L100)).

**Bằng chứng:** ảnh nền trắng bình thường trả trắng trong `palette_suggestions`; bấm áp dụng rồi bật “Loại màu nền” với `#ffffff` sẽ luôn đi vào nhánh lỗi “Màu nền cần bỏ phải khác bảng màu logo”. Backend validation đúng; lỗi là CTA frontend không hoàn tất workflow.

**Tác động:** hai CTA đều có vẻ hợp lệ nhưng người dùng bị chặn cho tới khi tự tìm và xóa màu nền. Cần background candidate riêng hoặc thao tác “Đặt làm nền” tự loại màu khỏi palette và ghi vào history.

### §LR3.12 — P2/S — `[CONFIRMED]` English workspace còn rơi tiếng Việt do `tv()` thiếu catalog

**Bằng chứng:** quét tĩnh hiện tại bằng reverse-map thực tế của `tv()` và hai JSON locale: **75** chuỗi `tv()` tĩnh duy nhất, **32** map được, **43** không có trong catalog VI nên English fallback nguyên tiếng Việt. Các nhóm thiếu gồm chọn ảnh, mode, crop/quad, preview, lưu, lỗi và alt text. Test catalog hiện không quét các call-site `tv()` của workspace.

**Tác động:** đổi English không tạo workspace English hoàn chỉnh; đặc biệt error/status và thao tác chính bị trộn ngôn ngữ. Bổ sung cặp key VI/EN và test manifest `tv()` trước runtime English.

### §LR3.13 — P2/S — `[CONFIRMED]` Picker và trạng thái async chưa đạt accessibility

**Bằng chứng:** picker là `label` chứa `<input className="hidden">` ([LogoRebuildWorkspace.tsx:579-588](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L579)); status/hủy chỉ là `<p>` thường, không có `role="status"`/`aria-live` ([LogoRebuildWorkspace.tsx:827-829](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L827)).

**Tác động:** input `display:none` không vào tab order đáng tin cậy; người dùng keyboard/screen reader không nhận được tiến độ, hoàn tất hoặc hủy. Dùng button + ref cho picker, live region cho async và focus management khi lỗi/hoàn tất.

### §LR3.14 — P3/L — `[CONFIRMED]` SVG chưa round-trip vào project PrynX

**Bằng chứng:** workflow cuối chỉ có preview `<img>` và `saveBlob` ([LogoRebuildWorkspace.tsx:505-526](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L505), [LogoRebuildWorkspace.tsx:831-850](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L831)); scan `desktop/src` không có consumer Logo SVG đưa vào project/imposition/editor. Artifact vẫn xuất được nên đây là roadmap P3, chỉ nâng thành điều kiện GO nếu sản phẩm quảng bá “dùng ngay trong PrynX”.

## Finding cũ đã đóng hoặc chưa đủ bằng chứng

| Mã cũ | Trạng thái trên cây hiện tại | Bằng chứng |
|---|---|---|
| §LR2.01 compound counter khi loại nền | `[CLOSED — VERIFIED M2/ARTIFACT synthetic]` | Test compound path; artifact vòng khuyên thật render bằng Chromium: ngoài/counter alpha 0, vành đỏ alpha 255 |
| §LR2.02 alpha hoàn toàn trong suốt/panic | `[CLOSED — VERIFIED M2]` | Backend trả lỗi nghiệp vụ; native guard; Rust 8 test; backend test all-transparent |
| §LR2.04 SVG rỗng/quá phức tạp báo ready | `[CLOSED — VERIFIED M2]` | `analyze_logo_svg`, status `ready/review/rejected`, frontend khóa export `review/rejected`; test backend/frontend xanh |
| §LR2.03 JPEG preset | `[OPEN PROOF GAP]` | Code Cutout/preset đã có, nhưng chưa chạy lại ảnh khách với vector ground truth + chưa runtime Tauri; artifact cũ không tự nâng trạng thái hiện tại |
| §LR2.06, §LR2.07–§LR2.18 | `[OPEN/RECONFIRMED]` | Các finding tương ứng vẫn hiện trên đường live và được gộp/định danh lại ở §LR3.01–§LR3.14 |

### Các hit scanner bị loại khỏi finding chính

`audit_contracts.ps1` self-test đạt **17/17**, scan 1.222 file trả 901 hit `[SUSPECTED]`. Các hit `SWALLOWED_ERROR` ở capabilities (`return None` có chủ đích để báo engine unavailable), các `.catch(() => undefined)` khi gửi cancel best-effort và `RELEASE_ONLY_BRANCH` đã được kiểm tra ngữ cảnh; chúng không được tự nâng severity nếu không có consumer/hành vi lỗi tương ứng.

## Cổng verify đã chạy

| Cổng | Kết quả |
|---|---:|
| `backend\venv\Scripts\python.exe -m pytest tests\test_logo_rebuild.py tests\test_logo_rebuild_feature_gate.py -q` | **38 passed, 2 warning dependency** |
| Vitest Logo workspace + routing/drop + tool panel | **60 passed** |
| Vitest production routing/tool panel `--mode production` | **21 passed** |
| `npm.cmd run typecheck` | đạt |
| `cargo test logo_vectorizer --lib --offline` với `PYO3_PYTHON=backend\venv\Scripts\python.exe` | **8 passed**; cần escalation để mở test binary vì sandbox trả `0xc0000022` |
| `audit_contracts.ps1 -SelfTest` | **17/17** |
| Artifact synthetic ring 128×128 → worker/native → SVG → Chromium PNG | ngoài/counter alpha 0; vành đỏ alpha 255; `ready`, 3 path/674 node |
| Harness palette/RAM/job/DPI | các số tái hiện được ghi tại §LR3.01–§LR3.03 và §LR3.08 |

**Chưa chạy:** run_dev Tauri đầy đủ với picker/native drop → preflight → preview → cancel → save → mở SVG; dirty close app; English runtime; screen reader; bản cài release; holdout ≥3 logo khách có vector gốc; mở 1:1 trong phần mềm chế bản.

## Đề xuất sửa theo lô, chờ duyệt

Không tự áp dụng lô nào trước khi chủ dự án duyệt.

1. **Lô A — resource/cancel/lifecycle (4 file):** `backend/app/core/heavy_job_scheduler.py`, `backend/app/workers/logo_rebuild.py`, `backend/app/api/routes/logo_rebuild.py`, `backend/tests/test_logo_rebuild.py`. Admission async + byte reservation theo slot; cancel queued/running; cleanup mọi exit path; test limiter bão hòa, retry sau metadata lỗi và các tier RAM `<8`, `8–16`, `≥16 GB`.
2. **Lô B — integrity/physical contract (5 file):** `backend/app/schemas/logo_rebuild.py`, `backend/app/workers/logo_rebuild.py`, `backend/app/workers/logo_svg_cleanup.py`, `backend/app/api/routes/logo_rebuild.py`, `backend/tests/test_logo_rebuild.py`. Palette candidate nhỏ có warning/giữ có điều kiện; mm người dùng xác nhận thay DPI ngầm; thêm holdout JPEG và output artifact QC. Không thay hard-cap chất lượng chung cho máy mạnh.
3. **Lô C1 — file routing (4–5 file):** `desktop/src/lib/tabNavigation.ts`, `desktop/src/hooks/useIncomingFileDispatcher.ts`, `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`, test routing tương ứng. Thêm receiver Logo theo `activeTabId`, kiểm DOM/native drop, tab nền/đã đóng và file path-backed.
4. **Lô C2 — dirty session (3–5 file):** workspace Logo, `ImpositionTab.tsx`, App/recovery contract và test close/save. Đẩy dirty state lên tab; chỉ clear sau save thành công; thêm recovery nếu sản phẩm cần giữ phiên.
5. **Lô D — gate/scope/i18n/a11y (≤5 file mỗi nhánh):** shared release flag backend/frontend; hiển thị limitations; hoàn chỉnh VI/EN; button picker/live region. Tách nhánh nếu vượt 5 file.
6. **Lô E — QA trực quan và kích thước 1:1:** zoom/pan/A-B/overlay, crop/quad handles, complexity panel và nghiệm thu ít nhất hai phần mềm chế bản. Round-trip PrynX (§LR3.14) để sau khi export-SVG đạt GO.

## Kết luận / chốt duyệt

- **Production:** `NO-GO` cho tới khi ít nhất §LR3.01–§LR3.07, §LR3.10–§LR3.13 và proof gap JPEG/1:1/runtime đạt cổng.
- **Dev:** có thể tiếp tục nghiệm thu nội bộ, nhưng phải ghi rõ “artwork phẳng, palette do người dùng xác nhận; chưa dựng lại phần bị che/mất”.
- **Bằng chứng hiện tại:** `ARTIFACT` synthetic; chưa `RUNTIME` Tauri/release.
- **Yêu cầu chốt:** xin duyệt danh sách lô ở trên. Sau khi duyệt, sửa tối đa 5 file/lô, verify từng lô và cập nhật `LOGO_REBUILD_FIXES_2026-08-09.md`; chưa sửa mã trước chốt duyệt.
