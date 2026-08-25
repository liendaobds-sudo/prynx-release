# TIẾN ĐỘ SỬA HỢP ĐỒNG REVISION XUYÊN CÔNG CỤ — 2026-08-25

Tài liệu này ghi tiến độ triển khai từ
`BAO_CAO_AUDIT_HOP_DONG_REVISION_CONG_CU_2026-08-25.md`.
Mỗi lô tối đa 5 file production/test và chỉ chuyển lô sau khi verify phạm vi hẹp.

## Lô A — Revision authority và commit fence

Trạng thái: **AUTO-PARTIAL — code/typecheck/test đạt; chưa xác nhận Tauri runtime.**

### File đã sửa

1. `desktop/src/stores/useWorkspaceStore.ts`
   - Thêm `WorkspaceDocumentRevisionToken` gồm File reference, page order,
     page instance IDs, rotations và `editGeneration`.
   - Snapshot clone/freeze mảng; `undefined` không bị gộp với `[]`.
   - Thêm `advanceEditGeneration()` theo từng workspace/tab.

2. `desktop/src/hooks/useWorkingPdf.ts`
   - Resolver đọc store tại thời điểm gọi, không giữ closure file/order/rotation cũ.
   - Tách `capture/materialize/isCurrent`; materializer chỉ đọc snapshot bất biến.

3. `desktop/src/hooks/useEditSession.ts`
   - Phát `onEditRevisionStart` trước mỗi request op/undo/redo để vô hiệu job cũ
     ngay khi người dùng bắt đầu sửa.

4. `desktop/src/components/ImpositionTab.tsx`
   - `commitWorkingFile` kiểm expected revision trước mọi I/O và ngay sát publish.
   - ProcessContext materialize đúng snapshot lúc bấm chạy.
   - Gateway tool trực tiếp và ba luồng VDP giữ token của lượt bắt đầu.
   - Recipe playback dùng con trỏ CAS riêng, không khóa một token cho cả chuỗi.
   - Commit/reset thêm `viewerPageInstanceIds`.

5. `desktop/src/hooks/useWorkingPdf.test.tsx`
   - Khóa hồi quy closure cũ, snapshot bất biến, File reference, instance,
     rotation, edit generation và khác biệt `undefined`/`[]`.

### Verify đã chạy

- `npm run typecheck`: đạt.
- 5 test file revision/edit/process/Recipe: **75/75 đạt**.
- 4 integration gate Recipe ticket/commit persistence/Output Preview/tool panel:
  **43/43 đạt**.
- `git diff --check` đúng 5 file Lô A: đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF.

### Runtime còn phải xác nhận

1. Bắt đầu một job xử lý chậm rồi xoay/xóa/reorder trong lúc job chạy.
2. Kết quả cũ phải bị bỏ qua, không thay Working File đang hiển thị.
3. Chạy Recipe nhiều bước không đổi trang giữa chừng: bước N+1 vẫn nhận output bước N.
4. Đổi trang khi Recipe đang chạy: lượt phát phải dừng, không publish đè revision mới.

## Lô B1 — Commit/publication barrier của Edit PDF

Trạng thái: **AUTO-PARTIAL — code/typecheck/test đạt; chưa xác nhận Tauri runtime.**

### File đã sửa

1. `desktop/src/hooks/useEditSession.ts`
   - Commit/Flatten dùng chung một publication promise; mọi caller cùng await.
   - Commit chờ op/undo/redo đang bay rồi mới quyết định dirty và gọi backend.
   - Chỉ xóa dirty sau khi consumer publish Working File thành công.
   - HTTP 410/publish lỗi fail-closed; không mở barrier trên backing PDF cũ.

2. `desktop/src/hooks/useEditSession.test.ts`
   - Khóa race op đang bay → commit, hai caller commit, Flatten đang publish,
     publish retry và HTTP 410.

3. `desktop/src/hooks/useWorkingPdf.ts`
   - `prepare()` chờ barrier Edit trước khi chụp revision.
   - Rebase prop File cũ sang File vừa được barrier publish.
   - Thêm `resolveUnprepared()` dành riêng cho preview không được tự commit Edit.

4. `desktop/src/hooks/useWorkingPdf.test.tsx`
   - Khóa rebase sau barrier, barrier reject và preview unprepared.

5. `desktop/src/stores/useWorkspaceStore.ts`
   - Barrier chuẩn bị tài liệu được scope theo từng workspace/tab.

## Lô B2 — Điều phối Edit → công cụ và Sticker

Trạng thái: **AUTO-PARTIAL — code/typecheck/test đạt; chưa xác nhận Tauri runtime.**

### File đã sửa

1. `desktop/src/components/ImpositionTab.tsx`
   - Đăng ký barrier theo workspace; transition chỉ chạy khi công cụ thật sự đổi.
   - Dùng layout effect để khóa panel trước paint và luôn drain session, kể cả
     op cuối chưa kịp đặt dirty.
   - ProcessContext chụp snapshot sau barrier; publish lỗi giữ Edit để retry.
   - Snapshot Undo của Edit chỉ được thêm sát `setFile`, sau khi I/O thành công.

2. `desktop/src/components/AcrobatViewer.tsx`
   - Không còn đóng session trong `finally`; commit/publish lỗi giữ session.
   - Gọi commit cả khi dirty=false để drain op đang bay trước khi close.

3. `desktop/src/components/preprocess-tools/StickerTool.tsx`
   - Preview dùng `resolveUnprepared()` nên không tự commit Edit.
   - Lượt chạy chờ prepare thành công trước khi ghi Recipe.

4. `desktop/src/components/preprocess-tools/StickerTool.ui.test.tsx`
   - Mock đúng resolver mới và kiểm prepare xảy ra trước `noteOperation`.

### Verify đã chạy

- `npm run typecheck`: đạt.
- 6 test file hook/cache/Sticker/preview/Viewer: **60/60 đạt**.

## Lô B3a — Cache upload PDF theo revision

Trạng thái: **AUTO — helper và test đạt; integration Crop đang triển khai.**

1. `desktop/src/lib/revisionScopedPdfUpload.ts`
   - Cache `file_id` kèm immutable snapshot; dedupe đúng cùng revision.
   - Generation + AbortController; kiểm current sau materialize, upload và sát publish.

2. `desktop/src/lib/revisionScopedPdfUpload.test.ts`
   - Khóa dedupe, đổi order/rotation/edit generation, invalidate và stale response
     kể cả uploader cố tình bỏ qua AbortSignal.

### Runtime còn phải xác nhận trong Lô H

1. Edit object rồi bấm ngay công cụ khác khi request op cuối còn chạy.
2. Ép lỗi publish: panel công cụ phải bị chặn và phiên Edit còn retry được.
3. Mở preview Sticker trong lúc Edit: không được tự commit; bấm Thực thi mới commit.

## Lô B3b — Crop bám Working PDF và từ chối kết quả stale

Trạng thái: **AUTO-PARTIAL — test/typecheck đạt; chưa xác nhận Tauri runtime.**

1. `desktop/src/components/workspace/CropDialog.tsx`
   - Mỗi lượt mở, đọc PageBox, nhận diện mép và Apply đều giữ revision token riêng.
   - Reorder/xoay/edit làm hủy request cũ và nạp lại Working PDF/PageBox mới.
   - Theo dõi trang bằng `viewerPageInstanceIds`; nếu owner bị xóa thì reset panel,
     không âm thầm rơi sang trang bên cạnh.
   - Fence stale đặt trước publication; không kiểm lại token cũ sau khi chính
     `onApplied` đã publish revision mới.

2. `desktop/src/components/workspace/CropDialog.interaction.test.tsx`
   - Khóa các ca reorder/xoay, xóa trang owner, detect trả muộn và Apply trả muộn.

3. `desktop/src/lib/revisionScopedPdfUpload.ts` và test
   - Crop dùng cache upload theo immutable revision, có dedupe, abort và generation.

### Verify đã chạy

- Crop/Working PDF/revision cache: **31/31 đạt**.
- `npm run typecheck`: đạt.
- `git diff --check` phạm vi Crop/cache: đạt; chỉ có cảnh báo LF/CRLF.

## Lô F1 — Resize fail-closed khi Working PDF không materialize được

Trạng thái: **AUTO-PARTIAL — regression đạt; chưa xác nhận Tauri runtime.**

1. `desktop/src/lib/processHandlers.ts`
   - Resize không còn bắt lỗi `getWorkingBytes()` rồi lặng lẽ chạy tiếp bằng
     backing `File` cũ. Materialize lỗi sẽ dừng tác vụ và không gọi backend.

2. `desktop/src/lib/processHandlers.test.ts`
   - Khóa ca Working PDF lỗi: không gửi file gốc và không báo xử lý thành công.

### Verify đã chạy

- Toàn bộ `processHandlers.test.ts`: **52/52 đạt**.
- Typecheck toàn desktop đã đạt sau thay đổi.

## Lô C2/C3 — Upload lease và publication outcome

Trạng thái: **AUTO-PARTIAL — test/typecheck đạt; chưa xác nhận Tauri runtime.**

- Preflight, PDF/X, Hairlines và Trapping dùng `ensureLease()` theo immutable
  revision; request cũ bị abort và không được cập nhật UI/download/publish.
- `prepare()` hoàn tất trước khi ghi Recipe.
- Cả bốn tool truyền nguyên outcome từ `onFileFixed`; outcome `false` không được
  báo xanh hoặc giữ warning/result cũ.

### Verify đã chạy

- C2: **33/33 test đạt**, typecheck đạt.
- C3: **34/34 test đạt**, typecheck đạt.
- `git diff --check` từng lô đạt; chỉ có cảnh báo LF/CRLF.

## Lô C4 — `selectionFileId` bám page revision

Trạng thái: **AUTO-PARTIAL — test/typecheck đạt; chưa xác nhận Tauri runtime.**

- Thay order, instance ID hoặc rotation làm vô hiệu ngay ID Edit/Layer cũ.
- Đồng bộ lại mảng cùng nội dung không làm mất ID hợp lệ.
- Upload nền materialize đúng snapshot và có CAS trước khi bind file ID; response
  cũ không thể tự gắn vào revision mới.

### Verify đã chạy

- Store/Working PDF/Output Preview: **19/19 đạt**.
- Typecheck đạt.

## Lô D1a — AI-sheet dùng Working PDF theo vị trí

Trạng thái: **AUTO-PARTIAL — test/typecheck đạt; chưa xác nhận Tauri runtime.**

- Detect/Detect All/Export chỉ materialize sau thao tác người dùng, dùng working
  positions `[1..N]`; duplicate một source page trở thành hai trang độc lập.
- Session workspace bind source revision và fail-closed khi revision đổi.
- Nguồn người dùng chọn riêng giữ ownership độc lập, không bị Viewer ghi đè.

### Verify đã chạy

- StickerCutline/store: **39/39 đạt**.
- Typecheck và diff check đạt.

## Lô D2a1 — Owner của ảnh nguồn

Trạng thái: **AUTO-PARTIAL — helper/test đạt; Cleanup batch reconciliation đang triển khai.**

- Ảnh shadow chỉ được truyền tiếp khi Viewer vẫn là PDF một trang đã chuẩn hóa,
  chưa duplicate/xóa/xoay/edit và đúng File/generation owner.
- Owner stale thì Router nhận `sourceImageFile=null` và buộc công cụ dùng Working PDF.
- Undo history kiểu cũ tạm fail-closed owner thay vì đoán; E1b sẽ khôi phục owner typed.

### Verify đã chạy

- Owner + Cleanup/Upscale hiện hữu: **38/38 đạt**.
- Typecheck đạt.

## Lô E1a — Page-only Undo giữ instance identity

Trạng thái: **AUTO-PARTIAL — test/typecheck/lint đạt; chưa xác nhận Tauri runtime.**

- Snapshot Undo/Redo giữ order + instance IDs + rotations.
- Restore đi qua một transaction `applyPageRevision`, không còn order/ID lệch nhau.

### Verify đã chạy

- Hotkey + Viewer contract: **18/18 đạt**.
- Typecheck, ESLint và diff check đạt.

## Lô E1b — Generic Undo giữ nguyên revision

Trạng thái: **AUTO-PARTIAL — test/typecheck/lint đạt; chưa xác nhận Tauri runtime.**

- History không còn là `File[]`; mỗi entry chụp bất biến File, order, instance ID,
  rotation theo vị trí, owner ảnh/AI-sheet và mốc Recipe.
- Undo vô hiệu generation/cache Edit cũ, đổi File trước rồi chỉ hydrate page revision
  sau khi loader của đúng File báo ready.
- Cờ dirty của revision được phục hồi không bị effect stack rỗng ghi đè.

### Verify đã chạy

- History/Viewer/hotkey/source owner: **30/30 đạt**.
- Typecheck toàn desktop và ESLint phạm vi đạt.

## Lô D1b — Overlay và thumbnail AI-sheet theo Working position

Trạng thái: **AUTO-PARTIAL — test/typecheck/lint đạt; chưa xác nhận Tauri runtime.**

- Trạng thái thumbnail và page overlay dùng vị trí một-based trong Working PDF,
  không tra lại `originalPageNum`.
- Hai bản duplicate cùng source page có status/mask độc lập; reorder không kéo
  preview sang nhầm instance.

### Verify đã chạy

- Selector/thumbnail/overlay: **24/24 đạt**.
- Typecheck toàn desktop và ESLint phạm vi đạt.

## Lô D2a2/D2b — Batch owner Cleanup/Upscale và raster revision cuối

Trạng thái: **AUTO-PARTIAL — test/typecheck/lint đạt; chưa xác nhận Tauri runtime.**

- Cleanup/Upscale phân biệt item tự đồng bộ từ workspace với file người dùng thêm;
  revision đổi chỉ thay item workspace stale, giữ mọi item explicit.
- Không materialize/raster/warm model khi mở panel. Chỉ nút Chạy mới chờ Edit
  barrier, materialize active Working page và gọi inference.
- Upscale dùng ảnh nguồn cũ chỉ làm tham chiếu mật độ, không gửi ảnh đó làm input:
  scan 300 DPI raster ở `300/72`, ảnh không có DPI giữ quy ước `1 px = 1 pt`.
  PDF thuần không bị tự mở thêm thành input Upscale ngoài hành vi cũ.

### Verify đã chạy

- Cleanup batch: **29/29 đạt**.
- Upscale/DPI/wiring execution: **18/18 đạt**.
- Typecheck toàn desktop và ESLint phạm vi đạt.

## Lô D3a/D3b — Extract theo Working position và xóa sau thành công

Trạng thái: **AUTO-PARTIAL — artifact helper/test đạt; chưa xác nhận Tauri runtime.**

- Viewer truyền vị trí/instance, không ánh xạ ngược source page.
- Parent chờ Edit barrier, materialize Working PDF, kiểm instance selection và CAS
  trước khi mở tab kết quả.
- `deleteAfter` chỉ thay page state sau khi Extract trả thành công; lỗi/stale không
  mở tab và không xóa trang.

### Verify đã chạy

- Extract artifact/helper: **3/3 đạt**.
- Viewer deletion contract: **12/12 đạt**.
- Typecheck toàn desktop và ESLint phạm vi đạt.

## Lô F2/F3 — Recipe, Cover Numbering và Resize inspect

Trạng thái: **AUTO-PARTIAL — test/typecheck đạt; chưa xác nhận Tauri runtime.**

- Recipe fail-closed khi materialize lỗi; không còn đọc backing File.
- Cover Numbering lấy page count từ Working revision.
- Resize transparency inspect materialize cùng Working PDF và latest-only theo
  order/rotation; execution vẫn giữ fail-closed của F1.

### Verify đã chạy

- Recipe: **31/31 đạt**.
- Cover Numbering: **19/19 đạt**.
- Resize UI + execution: **73/73 đạt**.
- Typecheck từng lô đạt.

## Lô G1 — Nền lease artifact bền

Trạng thái: **AUTO-PARTIAL — backend test đạt; producer/frontend chưa nối đủ.**

- Marker lease v1 atomic, path tương đối allowlist, token bí mật, initial grace,
  rolling multi-owner heartbeat và đọc lại được sau restart.
- API batch claim/renew/release có license guard; không nhận path từ client.
- DB expiry, orphan sweep và storage-pressure đều recheck lease sát lúc unlink.

### Verify đã chạy

- Lease + cleanup: **19/19 đạt**.
- API contract liên quan: **59/59 đạt**.
- `py_compile` và diff check đạt.

## Lô E2 — Recovery đúng revision và fail-closed edit pending

Trạng thái: **AUTO-PARTIAL — test/typecheck/lint đạt; chưa crash/restart Tauri thật.**

- Snapshot v2 giữ `size + mtime`, order, instance ID, rotation và VDP state.
- App kiểm fingerprint trước mở tab; Imposition kiểm lại trước hydrate.
- Page revision chỉ hydrate sau loader `ready`; cờ dirty phục hồi chỉ mất sau Save.
- Edit-object còn trong RAM không được autosave giả: snapshot cũ bị xóa và phiên
  vẫn báo dirty để người dùng không hiểu nhầm là có thể recovery nội dung edit.
- Snapshot v1 được migrate bảo thủ; ca không chứng minh được state bền bị bỏ.

Verify: Recovery/App/history **12/12**, typecheck và ESLint phạm vi đạt.

## Lô G2/G3/G3d — Producer, Edit publication và lease backend

Trạng thái: **AUTO-PARTIAL — backend regression đạt; chưa chạy sidecar/Tauri dài hạn.**

- N-up, Bình tem bế và VDP chỉ công bố `completed + path + artifact_lease`
  cùng một chốt. Tạo lease lỗi chuyển job sang failed và dọn output.
- TTL job tính từ trạng thái terminal; purge record không xóa file có owner lease.
- Edit chỉ trả `fid + path + artifact_lease` sau khi file, DB và marker cùng thành công.
  Register/lease lỗi rollback DB, file và state Edit; commit/flatten được tuần tự hóa
  bằng `RLock` xuyên materialize → publication → rollback.
- Heartbeat Edit kéo `UploadedFile.expires_at` theo cửa sổ rolling và đối chiếu
  đúng cặp `fid ↔ artifact path`. SQLite lỗi tạm thời không làm frontend bỏ owner.
- Owner TTL là 15 phút, vẫn rolling và không hard-cap tổng tuổi tab. Owner cũ có
  thể reclaim marker sau sleep; owner lạ không được chiếm/thu hồi marker. Cleanup
  chờ 120 giây sau resume hoặc sidecar restart để tab renew trước khi sweep.

Verify cuối liên quan lease/Edit/publication: backend **84/84**; `py_compile` đạt.

## Lô G4/G4e — Lease xuyên frontend, tab, history và Recipe

Trạng thái: **AUTO-PARTIAL — typecheck/test/lint đạt; chưa chạy Tauri nhiều tab/sleep.**

- Token sống qua Blob → File, native-path stub, `stripBytesIfOnDisk`, current File,
  generic history và object-edit Undo/Redo.
- Mỗi tab có `ArtifactLeaseOwner` riêng: claim token mới trước release token cũ,
  heartbeat, retry lỗi mạng, renew ngay khi focus/visibility trở lại và release khi unmount.
- N-up/Bình tem, Data Merge, Numbering, Cover Numbering và Edit đều gắn token
  trước khi commit vào tab hiện tại hoặc mở tab con; tab nguồn không claim nhầm.
- Recipe giữ token qua `WorkingArtifact`, path/bytes, bước trung gian và revision cuối;
  token không được serialize vào JSON Recipe.
- Lease thật sự mất được báo rõ trên tab thay vì chỉ lộ muộn ở lần Save/tool kế tiếp.

Verify hợp nhất: frontend lease/Edit/N-up/VDP/Recipe **107/107**; typecheck và
ESLint phạm vi đạt.

## Lô H — §REV.13 nguồn direct-path trong hàng đợi

Trạng thái: **AUTO-PARTIAL — fault injection đạt; chưa chạy queue Tauri với file khách.**

- Helper fingerprint nhẹ giữ normalized path, size, `mtime_ns`, device và inode.
- N-up/Bình tem chụp trước queue, kiểm sau admission, sát first-open trong child
  và ngay trước lease/publish. Nguồn stale làm job failed và output bị dọn.
- StickerTool direct-path kiểm trước heavy gate, sau admission và trước FileResponse;
  nguồn stale trả HTTP 409, không công bố output.
- VDP và AI sticker-sheet giữ cơ chế snapshot/copy job-owned đã có, không thêm I/O.

Verify: fault injection §REV.13 **7/7**; regression backend mở rộng nằm trong lượt
**84/84** ở trên; pickle fingerprint qua multiprocessing Windows đạt.

## Verify cuối của audit unit

- `npm run typecheck`: đạt.
- Frontend lease/producer/consumer/Edit/Recipe: **9 file test, 107/107 đạt**.
- Frontend Recovery/Undo/Crop/AI-sheet/Cleanup/Upscale/Resize: **14 file test,
  123/123 đạt**.
- Backend lease/publication/cleanup/N-up/VDP/Edit/source fence: **84/84 đạt**.
- ESLint phạm vi frontend và `py_compile` phạm vi backend: đạt.
- Không build, commit hoặc push trong đợt chốt này.

## Khoảng trống còn lại

1. Chưa chạy đúng chuỗi người dùng trên Tauri thật: Edit → tool khác, Crop →
   rotate/delete/reorder, Extract fail, Undo, crash/restart, nhiều tab và sleep/resume.
2. Recovery v2 dùng size/mtime, chưa hash nội dung. Fingerprint §REV.13 không phát
   hiện ca ngoại trình thay bytes nhưng giữ nguyên size/inode và khôi phục đúng mtime;
   loại bỏ tuyệt đối cần snapshot/hash/handle, đổi trade-off I/O.
3. Chưa có artifact chain giữ tab thật qua TTL giả lập hoặc sidecar restart dài hạn;
   vì vậy bằng chứng vẫn là `AUTO-PARTIAL`, không ghi `RUNTIME`.
