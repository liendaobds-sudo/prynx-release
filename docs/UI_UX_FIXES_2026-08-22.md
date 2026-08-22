# NHẬT KÝ SỬA UI/UX PRYNX — 22/08/2026

Báo cáo nguồn: `docs/BAO_CAO_AUDIT_UI_UX_2026-08-22.md`.

## Lô A — Thumbnail correctness và DnD

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri runtime smoke**.

- `§UX.TH.01`: gom công thức DPR, oversample, pixel width và cache key vào `createThumbnailRenderRequest`; cache phát invalidation đúng tile qua `useSyncExternalStore`.
- `§UX.TH.02`: đăng ký PDF.js document theo revision và render on-demand đúng `originalPageNum`; warmup 30 trang không còn là đường correctness duy nhất.
- `§UX.TH.03`: drop sang sidebar file khác cleanup trạng thái kéo rồi dừng, không chạy tiếp reorder file nguồn.
- `§UX.TH.07`: React key của thumbnail dùng `pageInstanceId`, tránh remount cả đoạn khi reorder.

File source:

- `desktop/src/components/workspace/thumbnailCache.ts`
- `desktop/src/hooks/viewer/usePdfLoader.ts`
- `desktop/src/components/acrobat/ThumbSidebar.tsx`
- `desktop/src/components/acrobat/useThumbSidebar.ts`

Regression test:

- `desktop/src/components/acrobat/thumbnailPipeline.test.tsx`
- DPR 1 / 1,25 / 1,5 / 2.
- Render trực tiếp trang 31 và 55.
- Cache reactive và dedupe request.
- Phân loại drop nội bộ / chéo file.

Verify:

- `npm run typecheck`: PASS.
- 5 file test thumbnail/hotkey: 46/46 PASS.
- `git diff --check` đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: PDF in-memory 55 trang, kéo source page 50 lên đầu, copy chéo hai tab và Windows scale 100–200%.

## Lô B — Canonical page identity cho View

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri runtime smoke**.

- `§UX.VIEW.01`: Fit Page/Fit Width lấy đúng kích thước active page hoặc tổng width + max height của spread mixed-size, kể cả rotation từng instance.
- `§UX.VIEW.03`: Text API và PDF.js dùng trang nguồn; cache khóa theo document revision + source page và tự bỏ dữ liệu revision cũ.
- `§UX.VIEW.04`: LayerPanel gửi source page cho backend; overlay OCG gắn vào đúng vị trí Viewer đang active.
- Thêm contract `ViewerPageIdentity` phân biệt rõ viewer position, source page, instance ID và materialized page.

File source:

- `desktop/src/lib/viewerPageIdentity.ts`
- `desktop/src/components/AcrobatViewer.tsx`
- `desktop/src/hooks/viewer/useViewerZoom.ts`
- `desktop/src/components/acrobat/LayerPanel.tsx`

Regression test:

- `desktop/src/lib/viewerPageIdentity.test.ts`
- Reorder `[2,1]`, trang trắng/out-of-range, mixed-size hai trang và rotation instance.

Verify:

- `npm run typecheck`: PASS.
- 4 file test Viewer/loader: 30/30 PASS.
- `git diff --check` đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: Fit trên PDF native hai khổ, copy text và OCG sau reorder/delete/duplicate.

## Lô C — Output Preview sau materialize

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri runtime smoke**.

- `§UX.VIEW.02`: mọi request PageBox/separation/soft-proof/action dùng `pageNum` của Working PDF đã bake, không map lại `viewerPageOrder`.
- Identity lấy mẫu được tách riêng: con trỏ vẫn đối chiếu source page của frame Viewer, còn dữ liệu backend dùng materialized page.
- `§UX.VIEW.07`: Escape chỉ đóng Output Preview trong tab active.
- `§UX.VIEW.08`: panel được clamp bốn cạnh, re-clamp khi workspace/panel đổi kích thước và co chiều rộng ở workspace hẹp.

File source:

- `desktop/src/components/OutputPreviewTab.tsx`
- `desktop/src/lib/outputPreviewPanelLayout.ts`

Regression test:

- `desktop/src/components/OutputPreviewLayout.test.tsx`
- `desktop/src/lib/outputPreviewPanelLayout.test.ts`
- Reorder `[2,1]` trên Working PDF, sampling đúng source frame, Esc hai tab và clamp bốn cạnh.

Verify:

- `npm run typecheck`: PASS.
- 3 file test Output Preview: 18/18 PASS.
- `git diff --check` đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: reorder rồi mở Output Preview, kéo panel sát bốn cạnh và thu/phóng cửa sổ khi panel đang mở.

## Lô D1 — Layout/resize/viewport menu full-icons-config

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri visual smoke**.

- `§UX.MT.02`: full/no-tool luôn hiển thị catalog và có nút thu; X chỉ render khi có panel thiết lập.
- `§UX.MT.03`: resize hiển thị raw width bám con trỏ; mode chỉ resolve ở pointerup, không dead-zone/jump.
- `§UX.MT.04`: effective layout clamp theo viewport/container, không ghi đè width preference; Home và Workspace dùng cùng helper.
- `§UX.MT.08`: empty-state chừa effective menu width cả khi catalog icons + config đang mở.
- `§UX.MT.09`: Home icon mode không còn bị collapsedSections làm mất category.

File source:

- `desktop/src/lib/rightToolMenuLayout.ts`
- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/components/HomeTab.tsx`

Verify:

- `npm run typecheck`: PASS.
- Menu/store regression: 36/36 PASS.
- `git diff --check` đúng phạm vi: PASS.

## Lô D2 — Activation caller giữ nguyên catalog mode

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri visual smoke**.

- Kích hoạt tool từ icon rail, launch feature, locked mode, Sticker và Output Preview không còn tự đặt catalog về full.
- Chỉ nút catalog toggle mới đổi full/icons; panel thiết lập vẫn giữ độc lập.

File source:

- `desktop/src/components/ImpositionTab.tsx`
- `desktop/src/components/OutputPreviewTab.tsx`
- `desktop/src/components/preprocess-tools/StickerTool.tsx`
- `desktop/src/components/OutputPreviewLayout.test.tsx`

Verify:

- Caller/menu regression: 36/36 PASS.
- `npm run typecheck`: PASS.
- `git diff --check` đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: ma trận full/icons × active/no-tool trên Home và Workspace, đặc biệt cửa sổ 900 px + thumbnail mở.
Tiêu chí runtime còn phải kiểm: ma trận full/icons × active/no-tool trên Home và Workspace, đặc biệt cửa sổ 900 px + thumbnail mở.

## Lô E1 — Toolbar, Crop/Edit invariant và ToolItem keyboard

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri visual smoke**.

- `§UX.MT.05`: cụm toolbar có vùng cuộn ngang khi viewport hẹp, không clip mất control; nhãn vẫn tự ẩn theo ResizeObserver.
- `§UX.MT.06`: setter store loại trừ Crop/Edit hai chiều; bật một mode tự dọn state mode kia.
- `§UX.MT.07`: keyboard event trên nút Favorite/Help không bubble lên primary tool action.
- Toolbar Crop/Edit không còn tự ép catalog về full.

File source:

- `desktop/src/stores/useWorkspaceStore.ts`
- `desktop/src/components/acrobat/AcrobatToolbar.tsx`
- `desktop/src/components/imposition-tools/SharedUI.tsx`
- `desktop/src/stores/useWorkspaceStore.menu.test.ts`
- `desktop/src/components/imposition-tools/SharedUI.help.test.tsx`

Verify:

- `npm run typecheck`: PASS.
- E1 regression: 20/20 PASS.
- `git diff --check` đúng phạm vi: PASS.

## Lô E2 — Modal, context menu và hotkey boundary

Trạng thái: đã sửa và verify tự động; còn thiếu Tauri runtime smoke.

- §UX.MD.01: dialog của từng viewer có role="dialog", aria-modal và tiêu đề liên kết; focus vào control đầu tiên, Tab được giữ trong hộp thoại, Escape đóng hộp thoại và trả focus về trigger còn tồn tại.
- Hotkey capture của tab hiện tại bị chặn khi dialog cùng tab đang hiển thị; tab nền có dialog riêng không chặn tab active. F7 không còn tự ép catalog menu sang full.
- Context menu có role menu/menuitem, đóng trước Insert/Extract/Duplicate/Transfer; Copy/Move mở được bằng focus/click/ArrowRight và quay lại bằng ArrowLeft.
- Modal copy/move chéo file dùng cùng contract, không còn listener Escape toàn document làm xuyên hotkey.

File source:

- desktop/src/hooks/viewer/useViewerHotkeys.ts
- desktop/src/components/acrobat/ViewerContextMenu.tsx
- desktop/src/components/acrobat/AcrobatModals.tsx
- desktop/src/components/acrobat/AcrobatModals2.tsx
- desktop/src/components/acrobat/CrossFileInsertModal.tsx

Regression test:

- desktop/src/components/acrobat/viewerModalContract.test.tsx
- Dialog chặn C/D/F7/Delete/Ctrl+Z.
- ARIA, focus ban đầu và Escape.
- Insert đóng context menu trước khi mở modal.

Verify:

- npm run typecheck: PASS.
- E2 + thumbnail/hotkey regression: 25/25 PASS.
- git diff --check đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: mở Insert/Extract/Copy-Move trên PDF hai tab, nhấn C/D/F7/Ctrl+Z/Delete khi focus ở modal, Escape và chuyển tab nền.

## Lô E3 — Loại bỏ control Quay lại trùng semantics

Trạng thái: đã sửa và verify tự động; còn thiếu Tauri runtime smoke.

- Bỏ prop và nút Quay lại dư khỏi Data Merge, Numbering, Cover Numbering và Stick Text Number.
- Căn giữa lại header sau khi bỏ nút; việc đóng panel vẫn do X/catalog của shell quản lý, không còn hai semantics điều hướng cạnh tranh.
- Call-site trong ImpositionTab không truyền callback chết.

File source:

- desktop/src/components/ImpositionTab.tsx
- desktop/src/components/preprocess-tools/DataMergeTool.tsx
- desktop/src/components/preprocess-tools/NumberingTool.tsx
- desktop/src/components/preprocess-tools/CoverNumberingTool.tsx
- desktop/src/components/preprocess-tools/StickTextNumberTool.tsx

Verify:

- npm run typecheck: PASS.
- CoverNumbering native-path + E2 contract: 6/6 PASS.
- rg onBack/quay_lai trong năm file: không còn kết quả.

## Lô F1 — Thumbnail tài liệu dài và prefetch tab nền

Trạng thái: đã sửa và verify tự động; còn thiếu Tauri runtime/profile tài liệu rất dài.

- §UX.TH.05: pre-generation PDF.js chỉ chạy ở tab đang xem; tab nền vẫn giữ thumbnail on-demand khi user chuyển sang.
- §UX.TH.08: bỏ cap 1000 trang khỏi danh sách hiển thị. IntersectionObserver/isLoadable vẫn chặn dựng ảnh ngoài viewport, nhưng mọi trang còn trong danh sách để Ctrl+A, điều hướng và selection không lệch với phần nhìn thấy.

File source:

- desktop/src/components/AcrobatViewer.tsx
- desktop/src/components/acrobat/ThumbSidebar.tsx

Verify:

- npm run typecheck: PASS.
- Thumbnail/Viewer regression: 21/21 PASS.
- git diff --check đúng phạm vi: PASS.

Tiêu chí runtime còn phải kiểm: PDF 1.000+ trang, Ctrl+A và cuộn sâu; mở hai tab rồi xác nhận tab nền không phát hàng loạt request PDF.js.

## Lô F2 — Mixed-size PDF.js dài và điều hướng Preflight

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri runtime/profile tài liệu rất dài**.

- §UX.VIEW.06: click issue Preflight quy đổi vị trí trang sang row Virtuoso; chế độ 'two_scroll' không còn cuộn lệch một hàng.
- §UX.VIEW.09: PDF.js không còn nhân bản khổ trang 1 cho tài liệu trên 100 trang. Trang 1 mở nhanh; các trang còn lại hydrate theo cụm ở nền, từng khổ được lưu theo số trang nguồn.
- Hydrate tài liệu dài đi qua cổng first-render, nên tab nền không tự tranh tài nguyên trước khi được xem.

File source:

- desktop/src/lib/viewerPageIdentity.ts
- desktop/src/components/AcrobatViewer.tsx
- desktop/src/hooks/viewer/usePdfLoader.ts

Regression test:

- desktop/src/lib/viewerPageIdentity.test.ts: 5/5 PASS.
- desktop/src/hooks/viewer/usePdfLoader.test.tsx: 15/15 PASS, gồm PDF.js 101 trang có trang cuối khác khổ.
- npm run typecheck: PASS.

## Lô F3 — Tách width Home và workspace

Trạng thái: **đã sửa và verify tự động; còn thiếu Tauri visual smoke**.

- §UX.MT.14: Home dùng homeToolMenuWidth; workspace dùng toolMenuWidth. Kéo catalog ở Home không còn làm panel thiết lập lần mở PDF sau đổi độ rộng.
- Dữ liệu cũ chỉ có toolMenuWidth được dùng làm seed một lần cho Home; dữ liệu mới giữ hai preference độc lập.
- §UX.MT.10 được đóng theo lô D1: chế độ icons không áp collapsedSections, mọi category vẫn hiện icon.

File source:

- desktop/src/components/HomeTab.tsx
- desktop/src/stores/appSettingsStore.ts
- desktop/src/stores/appSettingsStore.test.ts

Verify:

- Menu/layout + store: 29/29 PASS.
- npm run typecheck: PASS.

## Lô F4 — Giảm render/ghi state thừa ở toolbar và catalog

Trạng thái: **đã sửa và verify typecheck; còn thiếu profiler/runtime smoke**.

- §UX.S.03: AcrobatToolbar chỉ subscribe các field nó dùng, không còn subscribe toàn Workspace/Imposer store.
- §UX.S.04: vị trí cuộn ToolMenuList được công bố tối đa một lần mỗi frame; effect chỉ gọi scrollTo khi vị trí thực sự khác.

File source:

- desktop/src/components/acrobat/AcrobatToolbar.tsx
- desktop/src/components/imposition-tools/ToolMenuList.tsx

Verify:

- npm run typecheck: PASS.
- git diff --check: không có lỗi nội dung; còn cảnh báo LF→CRLF và dòng trống EOF có sẵn ở ToolMenuList.tsx.

## Lô F5 — Native thumbnail có đường thử lại

Trạng thái: **đã sửa và verify typecheck/regression; còn thiếu Tauri runtime gây lỗi render thật**.

- §UX.S.01: khi lệnh render thumbnail native lỗi, ô thumbnail chuyển sang trạng thái lỗi có nút thử lại; không còn spinner vô hạn hoặc buộc khởi động lại ứng dụng.
- Retry là thao tác tường minh của người dùng, không tự tạo vòng retry nền vô hạn.

File source:

- desktop/src/components/acrobat/ThumbSidebar.tsx

Verify:

- Thumbnail/view regression: 33/33 PASS.
- npm run typecheck: PASS.
