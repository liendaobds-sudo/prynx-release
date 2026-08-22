# BÁO CÁO AUDIT UI/UX PRYNX — THUMBNAIL, VIEW CHÍNH, MENU CÔNG CỤ, TOOLBAR

**Ngày audit:** 22/08/2026  
**Phạm vi:** `desktop/src`, các endpoint/backend được truy tới khi cần xác minh consumer; tập trung Thumbnail, View chính, menu công cụ phải và toolbar.  
**Trạng thái:** **CHỐT 1 — chỉ khảo sát và lập findings; chưa sửa hành vi UI, chưa build, commit hoặc push.**

## 1. Bối cảnh và mức bằng chứng

Audit được thực hiện trên **worktree hiện tại**, không lấy `HEAD` làm trạng thái sản phẩm vì repo đang có nhiều thay đổi chưa commit đúng tại các file Viewer/menu. Không reset, checkout hoặc chỉnh sửa các thay đổi có sẵn.

Quy ước:

- `[CONFIRMED]`: đã trace entry → state/handler → consumer/render sink trên code sống; hành vi xác định được bằng code hoặc phép thử thuần.
- `[SUSPECTED]`: có dấu hiệu nhưng cần Tauri runtime/React Profiler để kết luận tác động thực tế.
- `[EXPECTED]`: hành vi hiện tại đúng với hợp đồng mong muốn.
- `[DISPROVED]`: giả thuyết đã bị code/test hiện tại bác bỏ.
- P0: crash/mất dữ liệu nghiêm trọng; P1: sai thao tác hoặc ma sát lớn trên luồng thường dùng; P2: lỗi phụ, multi-tab/ca biên hoặc độ mượt; P3: đánh bóng.
- S/M/L: công sức ước lượng, chưa phải cam kết thời gian.

Không dùng screenshot cũ làm bằng chứng chốt vì code menu/view đã thay đổi nhiều sau các ảnh đó. Những finding thị giác cần Tauri runtime được giữ đúng ở mức `[SUSPECTED]`.

## 2. Kết luận điều hành

| Vùng | P0 | P1 | P2 | Kết luận |
|---|---:|---:|---:|---|
| Thumbnail | 0 | 3 | 5 | Nhánh native thông thường khá ổn, nhưng PDF in-memory và DnD chéo file có lỗi hợp đồng thật |
| View chính | 0 | 4 | 5 | Sai lớn nhất là lẫn vị trí Viewer với số trang nguồn sau reorder/delete; mixed-size fit dùng khổ stale |
| Menu + Toolbar | 0 | 8 | 6 | Hai mode đã đơn giản hóa, nhưng các entry point cũ vẫn ép full; responsive, resize và keyboard contract còn vỡ |
| **Tổng** | **0** | **15** | **16** | Chưa nên đánh bóng thêm trước khi khóa ba hợp đồng nền bên dưới |

Ba root cause xuyên suốt:

1. **Trang nguồn và vị trí Viewer bị dùng lẫn.** `pageOrder` cho phép reorder/delete/duplicate, nhưng Text, OCG, Output Preview và một số focus event vẫn truyền `activePage` như số trang nguồn.
2. **Panel thiết lập và catalog vẫn dùng chung transition/width cũ.** Hợp đồng mới nói chúng độc lập, nhưng `openWorkspaceSidebar()` vẫn đồng nghĩa “ép catalog full”, và một biến width còn đại diện cho hai loại panel.
3. **Thumbnail có hai pipeline không cùng contract.** Native IPC render on-demand; PDF.js pre-generate vào `Map` với key khác consumer, không phát invalidation và dừng ở trang 30.

## 3. Đường chạy đã trace

### 3.1 Thumbnail

`File/Working File`  
→ `usePdfLoader` dựng `pageOrder`, `pageInstanceIds`, `allPageDims`, `generateThumb`  
→ `AcrobatViewer` pre-generate PDF.js hoặc `ThumbSidebar` gọi native scheduler  
→ `thumbCacheRef` / local `nativePreview`  
→ `MemoThumbItem`  
→ ảnh, selection, active state, edit-session overlay.

Bằng chứng chính: `desktop/src/hooks/viewer/usePdfLoader.ts:677-819`, `desktop/src/components/AcrobatViewer.tsx:977-996`, `desktop/src/components/acrobat/ThumbSidebar.tsx:120-243,632-676`, `desktop/src/components/acrobat/useThumbSidebar.ts:334-698`.

### 3.2 View chính

`Workspace store`  
→ `usePdfLoader` bootstrap + hydrate metadata  
→ `useViewerZoom` fit/zoom/anchor  
→ `AcrobatViewer` ánh xạ row/position  
→ `LivePageFrame` render trang + text/edit/crop/OCG overlays  
→ Output Preview/Layer Panel/Page Tools đọc lại trạng thái trang.

Điểm phân biệt bắt buộc:

- `activePage`: vị trí một-based trong Viewer.
- `pageOrder[activePage - 1]`: số trang nguồn một-based.
- Working PDF từ `useWorkingPdf`: đã bake lại theo thứ tự Viewer, nên số trang của file mới lại là vị trí Viewer.
- `pageInstanceIds`: identity của đúng bản trang sau duplicate/reorder.

### 3.3 Menu công cụ và toolbar

`appSettingsStore`: preference global cho lần mở mới/Home  
→ `createWorkspaceStore`: mode/width/query/scroll riêng từng tab  
→ `ImpositionTab`: panel thiết lập + catalog full/icons  
→ `AcrobatToolbar`, context menu, F7/Crop/Edit và Tool Registry kích hoạt tool.

Hợp đồng mới đã có trong `desktop/src/lib/rightToolMenuLayout.ts:27-52,84-98`: toggle chỉ đổi catalog; X chỉ đóng panel thiết lập. Nhiều caller vẫn dùng semantics legacy “mở sidebar = full”.

## 4. Ma trận trạng thái UX

| Trạng thái | Kết quả audit |
|---|---|
| Home, full | Catalog dùng được; chưa có nút thu tương ứng; width dùng chung với config panel (`§UX.MT.02`, `§UX.MT.14`) |
| Home, icons | Có nút mở rộng; category từng collapse ở full có thể mất toàn bộ icon và không mở tại chỗ (`§UX.MT.10`) |
| Workspace chưa file, full, chưa tool | X hiện nhưng no-op; không có nút thu catalog (`§UX.MT.02`) |
| Workspace chưa file, icons, có tool | Dropzone vẫn tính `right: 0`, nằm dưới panel config + rail (`§UX.MT.08`) |
| Workspace có file, icons, có tool | Đây là state hợp lệ; nhưng chọn tool/Crop/Edit/F7 lại tự ép về full (`§UX.MT.01`) |
| Workspace có file, full, có tool | Config + catalog tồn tại song song đúng chủ đích; catalog không highlight tool active (`§UX.MT.13`) |
| Một trang, native | Pipeline render chính/thumbnail cơ bản đúng; chưa thấy P0 |
| Nhiều trang cùng khổ, native | Lazy thumbnail và virtual Viewer hoạt động; còn focus/selection/delete và multi-tab edge cases |
| Nhiều trang mixed-size, native | Frame dùng đúng `allPageDims`, nhưng Fit dùng khổ trang 1 stale (`§UX.VIEW.01`) |
| Reorder/delete/duplicate | Text, OCG, Output Preview và focus event còn lẫn source/position/instance (`§UX.VIEW.02–05`) |
| PDF in-memory/web | Thumbnail có thể spinner vĩnh viễn và trang 31+ không có producer (`§UX.TH.01–02`) |
| Nhiều tab | Native thumbnail có active guard; PDF.js pregen, object focus và Esc Output Preview còn tác động tab nền (`§UX.TH.05`, `§UX.VIEW.05,07`) |
| Modal đang mở | Viewer hotkey vẫn có thể đổi mode canvas phía sau (`§UX.MT.12`) |

## 5. Findings — Thumbnail

### §UX.TH.01 — `[CONFIRMED]` P1/M: PDF.js/in-memory không nhận thumbnail vừa sinh

**Đường live:** copy trang chéo file tạo `File.isInMemory` tại `desktop/src/components/AcrobatViewer.tsx:1323-1344`; loader đi nhánh PDF.js tại `desktop/src/hooks/viewer/usePdfLoader.ts:677-769`.

**Bằng chứng:**

- Producer dùng key theo `width * 1.3 / 595`: `usePdfLoader.ts:796-800`.
- Consumer dùng `localDim.w` px@96 và `devicePixelRatio * 1.15`: `ThumbSidebar.tsx:143-159`.
- Cache chỉ là `Map`, không có subscribe/invalidation: `desktop/src/components/workspace/thumbnailCache.ts:7-21`.
- Producer ghi xong không set React state; sink cache-miss tiếp tục là spinner: `ThumbSidebar.tsx:306-317`.
- Producer khai key oversample 1,3× nhưng canvas thật chỉ render `width`: `usePdfLoader.ts:805-817`; trên DPI cao còn mờ dù key được sửa.

Probe width mặc định 110 px: DPR 1 cho key consumer/producer `160/240`; DPR 1.25 `200/240`; DPR 2 `319/240`.

Đây là hồi quy của T4 từng ghi “đã fix” trong `docs/audit/THUMBNAIL_AUDIT_2026-07-18.md`.

### §UX.TH.02 — `[CONFIRMED]` P1/M: PDF.js chỉ sinh trang nguồn 1–30, không render on-demand

- `AcrobatViewer` hard-limit `Math.min(numPages, 30)` và luôn `pageNum = i + 1`: `desktop/src/components/AcrobatViewer.tsx:977-996`.
- Thumbnail yêu cầu mọi `originalPageNum` trong `pageOrder`: `ThumbSidebar.tsx:632-660`.
- On-demand chỉ có ở nhánh native Tauri + `file.path`: `ThumbSidebar.tsx:164-165,186-243`.

Repro xác định: PDF in-memory 55 trang, cuộn tới trang 31; hoặc reorder để source page 50 đứng đầu. Không producer nào tạo thumbnail đó.

### §UX.TH.03 — `[CONFIRMED]` P1/S: kéo trang sang file khác còn reorder file nguồn

- Source phát `prynx-cross-file-drop`: `desktop/src/components/acrobat/useThumbSidebar.ts:586-608`.
- Handler không `return`, tiếp tục chạy reorder/copy cục bộ: `useThumbSidebar.ts:612-692`.
- Target thực sự copy qua listener: `desktop/src/components/AcrobatViewer.tsx:1425-1454`.
- Drag không truyền `mode`, nên target mặc định copy, trong khi source lại bị đổi thứ tự và sync về workspace.

Ví dụ source `[1,2,3]`, kéo index 0 sang sau index 1 của target có thể làm source thành `[2,1,3]`. Source bị dirty và có thể được lưu với thứ tự không chủ đích.

### Các finding Thumbnail P2

| Mã | Finding | Bằng chứng | Effort |
|---|---|---|---|
| §UX.TH.04 | `[CONFIRMED]` Xóa trang reset selection về index 0 nhưng giữ `activePage`; view và thumbnail chọn hai trang khác nhau, thao tác sau có thể nhắm sai | `AcrobatViewer.tsx:1017-1026,1185-1205,811`; `ThumbSidebar.tsx:634-635` | S |
| §UX.TH.05 | `[CONFIRMED]` Tab nền vẫn pre-generate tối đa 30 thumbnail PDF.js vì effect thiếu `isActive`; native đã gate đúng | `App.tsx:1401-1407`; `AcrobatViewer.tsx:977-996`; `ThumbSidebar.tsx:164` | S |
| §UX.TH.06 | `[CONFIRMED]` Ghost kéo dùng `document.querySelector` toàn app, có thể lấy artwork tab khác cùng index | `useThumbSidebar.ts:401-424`; `App.tsx:1401-1407` | S |
| §UX.TH.07 | `[CONFIRMED]` React key dùng `index + originalPageNum` thay vì `pageInstanceId`; reorder remount và gọi render native lại cả đoạn | `ThumbSidebar.tsx:643`; `useThumbSidebar.ts:671-686`; `ThumbSidebar.tsx:186-243` | S-M |
| §UX.TH.08 | `[CONFIRMED]` Cap 1000 thumbnail vẫn mở; Ctrl+A vẫn chọn cả phần không thể nhìn | `ThumbSidebar.tsx:632,679-683`; `useThumbSidebar.ts:198-209` | L |

## 6. Findings — View chính

### §UX.VIEW.01 — `[CONFIRMED]` P1/M: Fit Page/Fit Width dùng sai khổ PDF mixed-size

- Native bootstrap đặt `pageDim/pageWidthPt` bằng khổ trang 1: `desktop/src/hooks/viewer/usePdfLoader.ts:572-581`.
- Metadata nền có đủ `allPageDims`, nhưng chỉ cập nhật map, không cập nhật khổ active: `usePdfLoader.ts:625-650`.
- Helper đổi active page chỉ chạy khi có `pdfRef`; nhánh native không có `pdfRef`: `usePdfLoader.ts:775-787`.
- Fit dùng duy nhất `actualWidth100/pageDim`; two-page còn giả định `2 × cùng width`: `desktop/src/hooks/viewer/useViewerZoom.ts:111-138`.
- Frame thật lại dùng đúng `allPageDims[originalPageNum]`: `desktop/src/components/AcrobatViewer.tsx:1852-1883`.

Repro: trang 1 `595×842 pt`, trang 2 `1200×600 pt`; xem trang 2 rồi Fit Page. Frame đúng khổ 2 nhưng zoom vẫn theo trang 1. Two-page mixed-size cũng không dùng tổng width + max height của cặp.

### §UX.VIEW.02 — `[CONFIRMED]` P1/M: Output Preview double-map và có thể đọc/sửa nhầm trang sau reorder

- `useWorkingPdf` đã bake `viewerPageOrder` thành file mới: `desktop/src/hooks/useWorkingPdf.ts:91-125`.
- `OutputPreviewHost` upload file đã bake và bind identity mới: `desktop/src/components/OutputPreviewHost.tsx:48-76`.
- `OutputPreviewTab` vẫn map `pageNum` qua `viewerPageOrder` cũ: `desktop/src/components/OutputPreviewTab.tsx:338-341`.
- `sourcePageNum` này đi vào PageBox, separations và action sửa: `OutputPreviewTab.tsx:516,644,1293,1355,1653`.

Repro `[1,2] → [2,1]`: Working PDF mới đã là `[source2, source1]`. Xem vị trí 1 nhưng code gọi trang 2 của file mới, tức source1.

### §UX.VIEW.03 — `[CONFIRMED]` P1/M: Text layer vừa map sai source page, vừa không invalidate theo revision

- Request `/pdf-text` gửi `activePage` là vị trí Viewer: `desktop/src/components/AcrobatViewer.tsx:687-704`.
- Endpoint đọc trang nguồn một-based: `backend/app/api/routes/document_tools.py:210-233`.
- Frame tiêu thụ cache bằng `originalPageNum`: `AcrobatViewer.tsx:1901`.
- Cache chỉ là state theo số trang và không reset theo `pdfUrl`/document identity: `AcrobatViewer.tsx:416,704,708`.
- `SelectableTextLayer` tiếp tục dựng dữ liệu cũ: `desktop/src/components/workspace/LivePageFrame.tsx:4885-4893`.

Sau reorder/delete, text có thể thiếu hoặc thuộc trang khác. Sau sửa/xóa chữ hay thay Working File, lớp span trong suốt còn có thể copy nội dung/toạ độ revision cũ.

### §UX.VIEW.04 — `[CONFIRMED]` P1/S: OCG/Layer preview nhắm sai trang sau reorder

- Layer panel phát page theo `viewerActivePage`: `desktop/src/components/acrobat/LayerPanel.tsx:317-326`.
- Viewer gắn overlay bằng điều kiện `originalPageNum === activePage`: `desktop/src/components/AcrobatViewer.tsx:1863-1865,1925`.

Với `pageOrder=[2,1]`, active vị trí 1: backend dựng source page 1; single-page đang hiện source page 2 nên preview không hiện, hoặc ở two-page hiện trên trang bên cạnh.

### Các finding View P2

| Mã | Finding | Bằng chứng | Effort |
|---|---|---|---|
| §UX.VIEW.05 | `[CONFIRMED]` Focus object là event global chỉ có `objectId + pageIndex`; thiếu tab/instance/active guard | `workspace/verticalScroll.ts:3-24`; `SelectionLayersPanel.tsx:84-89,166-171`; `LivePageFrame.tsx:3538-3553` | S-M |
| §UX.VIEW.06 | `[CONFIRMED]` Click issue Preflight trong `two_scroll` dùng page index thay vì row index | `AcrobatViewer.tsx:958-975,1803-1810`; đường đúng tại `:739-742` | S |
| §UX.VIEW.07 | `[CONFIRMED]` Esc đóng Output Preview của cả tab nền | `ImpositionTab.tsx:262-284,3490`; `App.tsx:1401-1407`; `OutputPreviewTab.tsx:609-614` | S |
| §UX.VIEW.08 | `[CONFIRMED]` Panel Output Preview chỉ clamp `y >= 0`, có thể bị kéo mất sang trái/phải/dưới | `OutputPreviewTab.tsx:585-605,1115-1126`; `outputPreviewPanelLayout.ts:8-20` | S |
| §UX.VIEW.09 | `[CONFIRMED]` PDF.js >100 trang gán toàn bộ khổ trang 1; main view và thumbnail mixed-size đều sai | `usePdfLoader.ts:731-740`; `AcrobatViewer.tsx:1852-1883` | M-L |

## 7. Findings — Menu công cụ và Toolbar

### §UX.MT.01 — `[CONFIRMED]` P1/M: mở/chuyển tool vẫn ép catalog icons → full

Hợp đồng mới cho phép `icons + active tool`, nhưng các entry point còn gọi `openWorkspaceSidebar()`, thực chất đặt mode `full`:

- Helper local: `desktop/src/components/ImpositionTab.tsx:404-407`.
- Icon rail: `ImpositionTab.tsx:3967-3971,4008-4012`.
- Mở tool từ Home khởi tạo thẳng full: `ImpositionTab.tsx:263-267`.
- Toolbar Edit/Crop: `desktop/src/components/acrobat/AcrobatToolbar.tsx:38-41,155-175`.
- F7: `desktop/src/hooks/viewer/useViewerHotkeys.ts:280-290`.
- Output Preview/Sticker còn dùng cùng semantics: `OutputPreviewTab.tsx:343-351`, `StickerTool.tsx:284-299`.

Consumer tính tổng width tại `ImpositionTab.tsx:3263-3270`. Mặc định `icons + active = 390+48=438`; caller ép full làm nhảy thành `390+280=670`.

### §UX.MT.02 — `[CONFIRMED]` P1/S-M: full/no-tool không có nút thu; X hiện nhưng no-op

- Main panel render khi `full + activeTool=none`: `ImpositionTab.tsx:3662-3665`.
- X luôn render: `ImpositionTab.tsx:3721-3728`.
- Resolver X với tool `none` trả `none` và giữ mode: `desktop/src/lib/rightToolMenuLayout.ts:27-39`.
- Nút thu catalog chỉ tồn tại ở nhánh `full + active tool`: `ImpositionTab.tsx:3894-3907`.
- Home cũng chỉ có nút mở rộng khi icons, không có nút thu khi full: `desktop/src/components/HomeTab.tsx:435-449`.

Kết quả: bấm X trong catalog full/no-tool không thay đổi gì; muốn thu buộc phải biết kéo mép.

### §UX.MT.03 — `[CONFIRMED]` P1/M: resize có vùng chết và nhảy ngược trong gesture

Comment helper nói chỉ chốt mode cuối gesture: `rightToolMenuLayout.ts:112-115`. Workspace lại resolve mode ở từng `pointermove` và render ngay tổng canonical: `ImpositionTab.tsx:1822-1847`.

- Active tool, preferred 390: kéo từ 438 → 559 px không di chuyển; tới 560 nhảy thẳng 122 px.
- Active tool, preferred 800: kéo mở từ 848, tới threshold có thể nhảy ngược về 560.

Test hiện chỉ kiểm kết quả cuối của resolver, chưa kiểm quỹ đạo handle.

### §UX.MT.04 — `[CONFIRMED]` P1/M: viewport clamp không chạy ở hydrate/startup/window resize

- Config cho phép 800 px, active/full cộng catalog 280: `rightToolMenuLayout.ts:3-8,84-108`.
- Cửa sổ min 900 px: `desktop/src-tauri/tauri.conf.json:17-20`.
- Workspace chỉ clamp tuyệt đối 280–800: `desktop/src/stores/useWorkspaceStore.ts:399-400`.
- `maxFullToolMenuWidth()` chỉ gọi khi kéo: `ImpositionTab.tsx:1822-1837`.
- Home không kéo thì render raw persisted width: `HomeTab.tsx:226-232,315-317`.

Width 800 + active/full tạo panel 1080 px ngay trong cửa sổ 900 px. Ngay icons vẫn là config 800 + rail 48, chỉ còn 52 px cho Viewer. Budget 320 hiện cũng chưa trừ thumbnail/toolbar.

### §UX.MT.05 — `[CONFIRMED]` P1/M: Toolbar không có layout hẹp thực sự

- ResizeObserver chỉ ẩn `.tb-label` dưới 860 px: `desktop/src/components/acrobat/AcrobatToolbar.tsx:67-85`.
- Cụm lõi vẫn `min-w-max`, không wrap hoặc overflow menu: `AcrobatToolbar.tsx:92`.
- Viewer root `overflow-hidden`: `desktop/src/components/AcrobatViewer.tsx:1982-1984`.

Cụm trang + Pointer/Hand/DIM/Edit/Crop + zoom + fit + display + delete rộng hơn nhiều mức Viewer tối thiểu 320 px. Khi thumbnail và panel phải cùng mở, các nút cuối bị clip/chồng theo CSS contract hiện tại.

### §UX.MT.06 — `[CONFIRMED]` P1/S: Crop và Edit có thể cùng bật

- Store không tự loại trừ: `desktop/src/stores/useWorkspaceStore.ts:677-686`.
- Edit toolbar/menu chỉ toggle Edit, không tắt Crop: `AcrobatToolbar.tsx:151-159`, `AcrobatViewer.tsx:882-887`.
- F7 lại chủ động chặn khi Crop: `useViewerHotkeys.ts:277-278`.
- Bật Crop theo chiều ngược có tắt Edit: `AcrobatToolbar.tsx:170-176`, `AcrobatViewer.tsx:889-895`.
- Canvas ưu tiên nhánh Crop khi cả hai true: `desktop/src/components/workspace/LivePageFrame.tsx:4252-4306`.

Repro: bật Crop rồi click Edit. Toolbar báo Edit active, panel là Edit, catalog còn Crop, nhưng kéo trên canvas vẫn tạo vùng Crop.

### §UX.MT.07 — `[CONFIRMED]` P1/S: keyboard trên Yêu thích/Trợ giúp mở luôn tool

Workspace `ToolItem` dùng `div role="button"` có Enter/Space, bên trong chứa hai `<button>` thật: `desktop/src/components/imposition-tools/SharedUI.tsx:167-201`.

`keydown` từ nút con bubble lên outer trước; outer gọi `onClick()` mở tool và `preventDefault()` click nút con. `stopPropagation()` hiện chỉ ở `onClick`. Home đã dùng cấu trúc nút tách đúng tại `HomeTab.tsx:83-112`.

### §UX.MT.08 — `[CONFIRMED]` P1/S: empty-state bỏ qua panel config khi catalog ở icons

- Config vẫn render nếu active tool dù catalog icons: `ImpositionTab.tsx:3662`.
- Tổng width icons + active vẫn gồm config + rail: `rightToolMenuLayout.ts:91-94`.
- Empty overlay chỉ chừa bên phải khi `isSidebarOpen` (tức mode full), còn icons dùng `right: 0`: `ImpositionTab.tsx:3539-3542`.

Kết quả: chưa có PDF, active tool + icons làm dropzone căn giữa phía sau panel 390+48 px, bị che/cắt và nhìn như layout lệch.

### Các finding Menu/Toolbar P2

| Mã | Finding | Bằng chứng | Effort |
|---|---|---|---|
| §UX.MT.09 | `[CONFIRMED]` Bốn panel VDP/đóng dấu vẫn còn nút “Quay lại” dù outer header đã bỏ | `ImpositionTab.tsx:3751,3790,3829,3861`; `DataMergeTool.tsx:1333-1340`; `NumberingTool.tsx:397-404`; `CoverNumberingTool.tsx:238-241`; `StickTextNumberTool.tsx:256-263` | S |
| §UX.MT.10 | `[CONFIRMED]` Home icons vẫn áp `collapsedSections` nhưng separator không click được; cả category biến mất | `HomeTab.tsx:142-155,478-488,506-516` | S |
| §UX.MT.11 | `[CONFIRMED]` Hủy modal Insert/Extract làm context menu cũ hiện lại | `ViewerContextMenu.tsx:158-173,190-203`; `AcrobatViewer.tsx:2277-2279` | S |
| §UX.MT.12 | `[CONFIRMED]` Viewer hotkeys xuyên qua modal; modal trang thiếu dialog/focus/Escape contract | `useViewerHotkeys.ts:115-124,272-290,345-420`; `AcrobatModals.tsx:5-8,85-91`; `AcrobatModals2.tsx:110-121` | M |
| §UX.MT.13 | `[CONFIRMED]` Full catalog cạnh config không highlight tool active, trong khi icon rail có highlight | `ToolMenuList.tsx:14-18,103-146`; `ImpositionTab.tsx:3919-3922,3962-3976` | S |
| §UX.MT.14 | `[CONFIRMED]` Một `toolMenuWidth` vừa là width catalog Home/no-tool, vừa là width config active; resize một loại làm lần mở sau của loại kia đổi theo | `rightToolMenuLayout.ts:84-98`; `HomeTab.tsx:165-167`; `ImpositionTab.tsx:264-266,397-403` | M |

## 8. Những giả thuyết chưa nâng thành finding chính

| Mã | Trạng thái | Dấu hiệu | Cần xác minh |
|---|---|---|---|
| §UX.S.01 | `[SUSPECTED]` P2/S | Native thumbnail nuốt lỗi và không retry: `ThumbSidebar.tsx:225-227`; deps không đổi thì effect không tự chạy lại | Mock reject→recover và Tauri runtime |
| §UX.S.02 | `[SUSPECTED]` P2/S | Tooltip khổ trang có hitbox vô hình 160×96 z-50 dù StatusBar đã hiển thị cùng dữ liệu: `AcrobatViewer.tsx:2203-2212,2260-2271` | Click/crop/edit ở góc dưới trái trên runtime |
| §UX.S.03 | `[SUSPECTED]` perf | Toolbar subscribe nguyên Workspace/Imposer store: `AcrobatToolbar.tsx:23-35` | React Profiler/render counter |
| §UX.S.04 | `[SUSPECTED]` perf | `ToolMenuList` ghi Zustand mỗi scroll rồi effect gọi `scrollTo` lại: `ToolMenuList.tsx:34-47,72-75` | Event/render profile |
| §UX.S.05 | `[SUSPECTED]` P2 | Panel transition 300 ms nhưng Viewer ResizeObserver debounce 150 ms sau event cuối, có thể tạo cú fit muộn | `ImpositionTab.tsx:3637-3639`; `useViewerZoom.ts:254-281`; Tauri visual smoke |

## 9. Những phần đã đúng hoặc finding cũ đã được đóng

- `[EXPECTED]` Hai mode canonical chỉ còn `full | icons`: `rightToolMenuLayout.ts:1,54-56`.
- `[EXPECTED]` Toggle catalog khi active tool giữ config; X khi **có active tool** đóng config và giữ mode.
- `[EXPECTED]` mode/width/query/scroll Workspace thuộc store riêng từng tab; global chỉ là preference cho lần mở mới.
- `[EXPECTED]` Resize pointer đã có capture/cancel/blur cleanup và persistence dùng latest-only write queue.
- `[EXPECTED]` Fit căn theo anchor trang active; hàng fit ẩn được kẹp 0×0: `useViewerZoom.ts:188-215`; `AcrobatViewer.tsx:2223-2228`.
- `[EXPECTED]` Two-page custom zoom đã căn giữa phần overflow khi mode/viewport đổi: `useViewerZoom.ts:217-235`.
- `[EXPECTED]` Crop scope theo `tabId + pageInstanceId`, không phủ nhầm duplicate/tab nền.
- `[EXPECTED]` Edit-session preview được gom theo trang và dán ngay lên thumbnail; helper test đạt.
- `[DISPROVED]` Giả thuyết Virtuoso component identity hiện còn gây vòng render React #185: Scroller/List đã ổn định tại `AcrobatViewer.tsx:1766-1786`. Chưa có bằng chứng tĩnh tái hiện lỗi này trên worktree hiện tại.
- `[DISPROVED]` Minimap thumbnail làm tab nền cuộn: handler đã guard tab ẩn tại `useViewerZoom.ts:637-640`.

Đối chiếu `docs/BAO_CAO_AUDIT_MENU_CONG_CU_PHAI_2026-08-21.md`:

- `§RM.1`, `§RM.2`, `§RM.7`, `§RM.8`: đã đóng trên worktree.
- `§RM.3`, `§RM.4`: sửa một phần; residual là `§UX.MT.01–03,06,08`.
- `§RM.5–06`: cải thiện nhưng Home/Workspace vẫn có renderer khác nhau; residual `§UX.MT.07,10,13–14`.
- `§RM.9`: còn mở qua `§UX.MT.04`.
- `§RM.10`: test pure/store tăng rõ, nhưng chưa có integration state matrix.

## 10. Verify đã chạy

### Kết quả tự động

- `cd desktop && npm run typecheck`: **PASS**.
- Bộ verify chính 9 file UI: **55/55 PASS**.
  - `rightToolMenuLayout.test.ts`
  - `appSettingsStore.test.ts`
  - `useWorkspaceStore.menu.test.ts`
  - `SharedUI.help.test.tsx`
  - `ToolMenuList.entitlement.test.tsx`
  - `pageViewport.test.ts`
  - `AcrobatViewer.pageOverlay.test.ts`
  - `ThumbSidebar.aiStatus.test.tsx`
  - `thumbnailEditPreview.test.tsx`
- Nhánh thumbnail bổ sung gồm `usePdfLoader` và hotkey: **38/38 PASS**.
- Nhánh Viewer bổ sung 7 file loader/overlay/Output Preview/vertical scroll: **39/39 PASS**.
- Nhánh menu/toolbar bổ sung 6 file: **46/46 PASS**.

Các con số không cộng thành một tổng duy nhất vì các nhóm có file trùng nhau.

### Khoảng trống test quan trọng

Test xanh hiện tại **không phủ**:

- producer↔consumer thumbnail PDF.js, cache invalidation, trang >30;
- DnD thumbnail chéo file và source bất biến;
- delete → active/selection/focus;
- active/spread mixed-size Fit;
- reorder → Text/OCG/Output Preview đúng trang;
- full/icons × active/no-tool × no-file/file-open;
- quỹ đạo kéo resize qua threshold;
- Toolbar ở width 320/480/800;
- keyboard trên favorite/help;
- modal chặn hotkey;
- hai tab Output Preview cùng mở.

Chưa chạy `run_dev.bat`/Tauri visual smoke. Mức bằng chứng cao nhất hiện tại là **TRACED + AUTO hẹp**, chưa phải RUNTIME.

## 11. Lô sửa đề xuất — mỗi lô tối đa 5 file

### Lô A — Thumbnail correctness và DnD (ưu tiên 1)

1. Một hàm canonical tạo cache key/scale dùng chung producer và consumer.
2. Cache reactive hoặc trả kết quả trực tiếp cho đúng tile; render on-demand theo `originalPageNum`.
3. Bỏ hard-limit 30 khỏi correctness path; prefetch chỉ là tối ưu, không phải producer duy nhất.
4. `return` ngay sau cross-file drop thành công; dùng `pageInstanceId` làm React key.
5. Test: in-memory 55 trang, source page 50 sau reorder, DPR 1/1.25/1.5/2, cross-file source bất biến.

Dự kiến: `usePdfLoader.ts`, `thumbnailCache.ts`, `ThumbSidebar.tsx`, `useThumbSidebar.ts`, một file test pipeline.

### Lô B — Canonical page identity cho View (ưu tiên 2)

1. Helper duy nhất trả `{viewerPosition, sourcePage, instanceId, materializedPage}`.
2. Native active-page dim lấy từ `allPageDims[sourcePage]`; Fit spread dùng tổng width + max height thật.
3. Text request/cache theo document identity + source page; clear theo revision.
4. OCG và object-focus dùng source/instance/tab đúng contract.
5. Test mixed-size + reorder/delete/duplicate.

Dự kiến: `usePdfLoader.ts`, `useViewerZoom.ts`, `AcrobatViewer.tsx`, `LayerPanel.tsx`, một file test contract.

### Lô C — Output Preview sau materialize (ưu tiên 3)

1. Sau `useWorkingPdf`, request dùng page của file đã bake, không map lại source cũ.
2. Khóa identity trang xuyên PageBox/separation/action sửa.
3. Esc chỉ tác động tab active.
4. Clamp panel theo cả bốn cạnh và re-clamp khi workspace resize.
5. Test reorder + materialize + request/action page.

Dự kiến: `useWorkingPdf.ts`, `OutputPreviewHost.tsx`, `OutputPreviewTab.tsx`, `outputPreviewPanelLayout.ts`, một file test.

### Lô D — Menu contract full/icons/config (ưu tiên 4)

1. Tách command `activateTool` khỏi `setCatalogMode`; activation mặc định giữ mode.
2. Full/no-tool có nút thu riêng; X chỉ render khi có panel thiết lập thực.
3. Trong drag render raw draft width, chốt mode ở pointerup.
4. Clamp theo container ở hydrate/window resize; tính cả thumbnail và viewer minimum.
5. Empty-state chừa đúng `effectiveRightToolMenuWidth` ở cả full/icons.

Dự kiến: `rightToolMenuLayout.ts`, `ImpositionTab.tsx`, `HomeTab.tsx`, `useWorkspaceStore.ts`, một integration test state matrix.

### Lô E — Toolbar, keyboard và modal (ưu tiên 5)

1. Toolbar responsive theo nhóm ưu tiên + overflow menu; không chỉ ẩn một label.
2. Transition canonical bảo đảm Crop/Edit loại trừ hai chiều.
3. `ToolItem` dùng primary `<button>` tách sibling favorite/help như Home.
4. Modal có role/focus/Escape và viewer hotkey guard modal.
5. Xóa bốn nút Quay lại còn sót; đóng context menu trước khi mở modal.

Dự kiến: `AcrobatToolbar.tsx`, `SharedUI.tsx`, `useViewerHotkeys.ts`, các modal/context menu, một file test keyboard.

### Lô F — P2 hiệu năng và tài liệu dài

- Virtualize toàn bộ thumbnail thay vì cap 1000.
- Gate PDF.js prefetch theo active tab và profile RAM; máy ≥16 GB không hard-cap công suất.
- Scope object-focus theo tab/instance.
- Đo render count Toolbar/ToolMenuList trước khi tối ưu selector/scroll persistence.

Lô này chỉ bắt đầu sau khi các P1 correctness xanh.

## 12. Tiêu chí nghiệm thu runtime

### Thumbnail

- PDF in-memory 55 trang: trang 1, 30, 31, 55 đều có thumbnail; reorder source 50 lên đầu hiện ngay.
- DPR 100/125/150/200% không mờ, không spinner vô hạn.
- Kéo copy sang tab B không đổi order/dirty của tab A.
- Xóa/range-delete giữ active page, selection và thumbnail highlight cùng một identity.

### View chính

- PDF 2 trang khác khổ: Fit Page/Width đúng từng trang; two-page fit đủ cả cặp.
- Reorder `[2,1]`: text copy, OCG, Output Preview, PageBox và action sửa đều nhắm artwork đang nhìn.
- Duplicate cùng source: focus đúng instance, tab nền không cuộn.
- `single_fit`, `two_fit`, `single_scroll`, `two_scroll` đều giữ anchor khi mở/đóng panel.

### Menu/Toolbar

- Ma trận `full/icons × active/none × no-file/file-open`: mọi nút có đúng một nghĩa.
- Kích hoạt tool ở icons giữ icons; chỉ nút catalog mới đổi full/icons.
- Full/no-tool có nút thu; X không xuất hiện khi không có config.
- Drag bám con trỏ không dead-zone/jump; persisted width 800 mở ở cửa sổ 900 vẫn giữ Viewer dùng được.
- Toolbar thao tác được ở canvas width 320/480/800; control dư vào overflow menu.
- Crop/Edit không bao giờ cùng true.
- Tab tới favorite/help rồi Enter chỉ thực hiện đúng hành động con.
- Modal mở thì C/F7/D không đổi canvas phía sau.

## 13. Chốt duyệt

Báo cáo dừng tại **chốt 1** theo workflow audit. Đề xuất duyệt thứ tự **Lô A → B → C → D → E**, mỗi lô verify hẹp rồi mới sang lô kế. Chưa có thay đổi hành vi sản phẩm trong lượt audit này.
