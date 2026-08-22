# BÁO CÁO AUDIT MENU CÔNG CỤ PHẢI — PRYNX

**Ngày:** 21/08/2026  
**Phạm vi:** menu công cụ phải ở Home và Workspace PDF; ba dạng đầy đủ / thu gọn có chữ / chỉ icon; trước khi mở file, sau khi mở file, đổi tab, mở công cụ từ toolbar/context menu/phím tắt và kéo thay đổi chiều rộng.  
**Phương pháp:** đối chiếu ba ảnh người dùng gửi, audit tĩnh có xác minh chéo component → store → persistence → layout viewer → test hiện có; đối chiếu báo cáo hiệu năng/UIUX cũ để phân biệt chủ đích và hồi quy.  
**Trạng thái:** chốt 1 — chỉ báo cáo, **chưa sửa code, chưa build, chưa phát hành**.

> Ký hiệu: P0 = sai/hỏng kết quả; P1 = ma sát lớn hoặc thao tác không đáng tin; P2 = lỗi UX/kiến trúc cần sửa; P3 = đánh bóng. Effort S/M/L là ước lượng tương đối.

---

## 1. Kết luận điều hành

Cảm giác “không mượt, không chuẩn chỉnh, lúc được lúc không” là có nguyên nhân xác định trong code. Ba ảnh **không đơn thuần là ba breakpoint của một component**. PrynX đang có:

- hai catalog renderer khác nhau cho Home và Workspace;
- hai width độc lập (`homeToolMenuWidth`, `toolMenuWidth`);
- hai nguồn `isSidebarOpen` khác nhau;
- một phần state global/persisted, một phần theo tab và một phần local component;
- các thao tác kéo có ý nghĩa khác nhau tùy việc đã chọn công cụ hay chưa.

Kết quả audit: **4 P1 + 6 P2**. Hai nguyên nhân tác động trực tiếp nhất là:

1. Mỗi pixel kéo menu hiện gọi persist xuống file JSON qua Tauri và làm nhiều cây React, kể cả tab nền, render lại. Đây là **hồi quy của lỗi hiệu năng đã được audit từ tháng 07**.
2. Viewer mở tool bằng một `setIsSidebarOpen` legacy, còn panel thật đọc một store khác. Vì vậy có đường đổi đúng tool nhưng panel vẫn đóng — biểu hiện chính xác là bấm lần đầu “không có gì”, bấm/chuyển trạng thái tiếp mới thấy.

Không thấy lý do phải đụng backend, Rust hay engine PDF để sửa cụm này. Đây là lỗi frontend/state/layout.

---

## 2. Bản đồ trạng thái thực tế

| Bối cảnh | Renderer/state | Điều kiện hiện tại | Hành vi |
|---|---|---|---|
| Home — đầy đủ | `HomeTab` + `ToolItem` riêng | `homeToolMenuWidth >= 280` | Card đầy đủ, tìm kiếm, yêu thích, trợ giúp, collapse section |
| Home — thu gọn có chữ | `HomeTab` nhánh compact | `200 <= width < 280` | List một dòng, mất nút yêu thích/trợ giúp; section không còn nút mở/đóng |
| Workspace — đầy đủ | `ImpositionTab` → `ImposerDashboard` → `ToolMenuList` | `isWorkspaceSidebarOpen=true`, tool=`none` | Catalog đầy đủ nhưng là component khác Home |
| Workspace — compact | mini toolbar | panel đóng và width `120..279`, hoặc `isMiniToolbarExpanded=true` | List có chữ, không có search/collapse/help như full |
| Workspace — icon | mini toolbar | width `<120`, hoặc `isMiniToolbarExpanded=false` | Chỉ icon + badge Pro + vạch category |
| Workspace — đang dùng tool | config panel + mini toolbar | tool khác `none` | Tổng width = config width + rail 48 hoặc 220 px |

Như vậy hệ hiện tại có nhiều hơn ba trạng thái, và cùng một thao tác kéo/click được diễn giải khác nhau theo `activeDashboardTool`.

---

## 3. Phát hiện có bằng chứng

### §RM.1 — P1/M: Resize tạo bão render + IPC + ghi đĩa ở từng `mousemove`

**Bằng chứng**

- Home gọi `setHomeToolMenuWidth(newWidth)` trực tiếp trong `mousemove`: `desktop/src/components/HomeTab.tsx:235-242`.
- Workspace gọi `setToolMenuWidth` và thường gọi thêm `setWorkspaceSidebarOpen` trong cùng một `mousemove`: `desktop/src/components/ImpositionTab.tsx:1741-1771`.
- App settings dùng Zustand `persist`: `desktop/src/stores/appSettingsStore.ts:137-186`. Mỗi lần persist gọi `ensureSettingsDir()` rồi IPC `write_file_atomic`: `appSettingsStore.ts:27-40,76-84`.
- `App`, `ImpositionTab`, `AcrobatViewer`, toolbar và status bar còn subscribe nguyên app-settings store thay vì selector hẹp: `desktop/src/App.tsx:315`, `desktop/src/components/ImpositionTab.tsx:373`, `desktop/src/components/AcrobatViewer.tsx:262`.
- Mọi tab vẫn mounted dù đang ẩn: `desktop/src/App.tsx:1401-1408`.

**Tác động**

Một pixel kéo có thể phát 1–2 lần ghi JSON nguyên tử, notify store nhiều lần và đánh thức App cùng các Workspace/Viewer đang ẩn. Càng mở nhiều file, cảm giác kéo càng nặng. Middleware persist không xếp hàng theo revision; các ghi async độc lập còn tạo rủi ro snapshot width/open trung gian được hoàn tất sau snapshot mới.

Đây là hồi quy đã biết: `docs/BAO_CAO_AUDIT_HIEU_NANG_2026-07-26.md:144-147` yêu cầu width tạm trong lúc kéo và chỉ commit store ở mouseup; `docs/PERF_FIXES_2026-07-26.md:23-24` từng ghi mục này đã sửa, nhưng code hiện tại đã quay lại đường ghi store từng mousemove.

**Hướng sửa:** width transient bằng ref/local state hoặc CSS variable cập nhật qua `requestAnimationFrame`; persist đúng một lần ở `pointerup`; bỏ các subscription toàn store và tránh `set` khi giá trị không đổi.

### §RM.2 — P1/M: Hai nguồn `isSidebarOpen` làm thao tác đổi đúng tool nhưng không mở panel thật

**Bằng chứng**

- Panel thật trong `ImpositionTab` đọc `appSettingsStore.isWorkspaceSidebarOpen`: `desktop/src/components/ImpositionTab.tsx:373-379`; chỉ render config khi biến này true: `ImpositionTab.tsx:3583`.
- `AcrobatViewer` lại lấy `setIsSidebarOpen` từ `useWorkspaceStore`: `desktop/src/components/AcrobatViewer.tsx:175-218`.
- Store legacy này vẫn có bộ state riêng `isSidebarOpen/sidebarWidth`: `desktop/src/stores/useWorkspaceStore.ts:155-158,394-396,537-539`.
- Toolbar Viewer và context menu gọi setter legacy khi mở Quản lý trang: `AcrobatViewer.tsx:2081-2084`, `desktop/src/components/acrobat/ViewerContextMenu.tsx:199-203`.

**Tác động**

Nếu panel thật đang đóng, bấm Quản lý trang/Xoay có thể đổi `activeDashboardTool='pages'` nhưng chỉ mở boolean không được render sử dụng. Mini rail đổi highlight, còn config panel vẫn không xuất hiện. Đây là lỗi deterministic nhưng nhìn từ người dùng giống “lúc bấm được, lúc không”.

**Hướng sửa:** một command duy nhất kiểu `openRightTool(tool, options)` cập nhật atomically active tool + canonical open state + minimum width; xóa state layout legacy khỏi `useWorkspaceStore` sau khi chuyển hết consumer.

### §RM.3 — P1/M: “Ba chế độ” là tổ hợp state lai, tạo snap/jump và nút đổi nghĩa

**Bằng chứng**

- `activeDashboardTool` theo tab; `toolMenuWidth` + `isWorkspaceSidebarOpen` global/persisted; `isMiniToolbarExpanded` local theo component tại `desktop/src/components/ImpositionTab.tsx:373-379,477`.
- Khi đã chọn tool và config đang mở, kéo qua 280 px làm config biến mất; tổng width nhảy từ `config + 48/220` xuống thẳng `48/220`: `ImpositionTab.tsx:1745-1758,3553-3558`.
- Khi config đã đóng, cùng gesture resizer chỉ toggle rail 48↔220 ở ngưỡng 120 và không mở config: `ImpositionTab.tsx:1756-1758`.
- Khi chưa chọn tool, gesture lại resize liên tục 48..800 và tự đổi full/compact/icon: `ImpositionTab.tsx:1759-1771`.
- Nút tròn khi tool=`none` luôn mở thẳng full panel; khi đã chọn tool lại chỉ đổi rail 48/220. Tooltip/icon chỉ dựa vào `isMiniToolbarExpanded`: `ImpositionTab.tsx:3828-3850`. Có trạng thái nút ghi “Thu gọn” nhưng click thực tế mở full.
- Chọn tool từ compact có thể giữ `isMiniToolbarExpanded=true`, đồng thời ép config về 390; tổng menu nhảy lên `390+220=610px`: `ImpositionTab.tsx:3907-3911,3961-3965` kết hợp công thức `3553-3558`.

**Tác động**

Handle có thể nhảy khỏi con trỏ ngay giữa gesture, panel biến mất đột ngột quanh breakpoint, và cùng nút không có một nghĩa ổn định. Đây là nguyên nhân trực tiếp của cảm giác “khó canh chính xác”.

**Hướng sửa:** reducer/state machine tường minh, ví dụ `catalogMode: full|compact|icons`, `configOpen`, `configWidth`, với bảng transition duy nhất; thêm hysteresis hoặc snap chỉ ở cuối gesture, không đổi cây giữa khi đang kéo.

### §RM.4 — P1/S-M: Nút X, Edit, Crop, F7 và locked tool không cùng hợp đồng mở/rộng panel

**Bằng chứng**

- Khi tool=`none`, outer width luôn bằng `sidebarWidth` bất kể open/closed: `desktop/src/components/ImpositionTab.tsx:3553-3558`. Nút X chỉ `setIsSidebarOpen(false)`: `ImpositionTab.tsx:3653-3659`. Vì vậy đóng full catalog ở 390 px chỉ đổi sang mini list rộng 390 px, không trả lại không gian cho Viewer.
- Khi đã chọn tool, cùng nút X lại thu thật về rail 48/220 px theo công thức trên. Một nút có hai kết quả hình học khác nhau.
- Nút Edit toolbar chỉ toggle `isObjectEditMode`: `desktop/src/components/acrobat/AcrobatToolbar.tsx:145-154`; menu command cũng chỉ toggle: `desktop/src/components/AcrobatViewer.tsx:866-872`.
- F7 có mở canonical boolean nhưng không đảm bảo width tối thiểu: `desktop/src/hooks/viewer/useViewerHotkeys.ts:269-295`.
- Crop effect mở panel nhưng không nâng width từ 48 lên >=280: `desktop/src/components/ImpositionTab.tsx:493-520`. Với tool Crop active, công thức tổng width có thể chỉ là `48+48=96px`.
- `lockedMode` (Booklet/N-Up/Tem/CNC) chỉ đổi tool: `ImpositionTab.tsx:827-833`; nhánh `initialFeature` mới có logic normalize 390 + open: `ImpositionTab.tsx:835-854`.

**Tác động**

Panel Edit/Crop có thể không hiện hoặc hiện trong cột quá hẹp; mở một tool từ Home có thể phụ thuộc trạng thái panel của tab trước. Cùng hành động đóng/mở cho kết quả khác nhau theo tool.

**Hướng sửa:** mọi entry point đi qua helper canonical; helper bảo đảm `configOpen=true` và `configWidth>=MIN_CONFIG_WIDTH` khi tool cần config. Nút X chuyển về một mode cụ thể, không chỉ lật boolean.

### §RM.5 — P2/M: Chưa mở file và đã mở file dùng hai implementation, hai width và hai ngôn ngữ tương tác

**Bằng chứng**

- Home dùng `homeToolMenuWidth`, min 200, full/compact tại 280 và cố ý cấm icon-only: `desktop/src/components/HomeTab.tsx:181-182,235-240,264-268`.
- Workspace dùng `toolMenuWidth`, open global và mini-expanded local: `desktop/src/components/ImpositionTab.tsx:373-379,477`.
- Default khác nhau: Home 320, Workspace 390: `desktop/src/stores/appSettingsStore.ts:169-172`.
- Home dùng `ToolItem` riêng; Workspace full dùng `ToolMenuList`/`SharedUI.ToolItem`; Workspace compact/icon dựng list thứ ba ngay trong `ImpositionTab`.

**Tác động**

Độ rộng/mode vừa chỉnh ở Home không được mang sang PDF. Search, collapse, nút yêu thích, trợ giúp, vị trí cuộn và mật độ item thay đổi ngay khi mở file. Người dùng cảm nhận đây là cùng một menu, nhưng code coi là các menu khác nhau.

**Hướng sửa:** dùng chung catalog model/component và một preference mode; layout Home/Workspace có thể khác vỏ, nhưng item, search, collapse, focus và quy tắc breakpoint phải cùng hợp đồng.

### §RM.6 — P2/S: Compact có thể khóa mất section; chuyển mode làm mất query/scroll

**Bằng chứng**

- Ở Home compact, section header là `<div>` không có `onToggle`: `desktop/src/components/HomeTab.tsx:153-170`.
- Nội dung vẫn bị ẩn theo `collapsedSections` persisted: `HomeTab.tsx:407-455`. Section đã đóng ở full có thể không mở lại ở compact nếu không kéo rộng hoặc search.
- Workspace full tôn trọng `collapsedSections`: `desktop/src/components/imposition-tools/ToolMenuList.tsx:75-132`; mini toolbar lại luôn render mọi category: `desktop/src/components/ImpositionTab.tsx:3931-3984`.
- Query là local state trong `ToolMenuList`: `ToolMenuList.tsx:26-37`. Full và mini là hai nhánh mount loại trừ tại `ImpositionTab.tsx:3583,3825-3827`, nên đổi mode làm mất query và scroll container.
- Home compact bỏ hẳn favorite/help controls có ở full: `HomeTab.tsx:68-78` so với `98-112`.

**Tác động:** công cụ có thể “biến mất rồi xuất hiện lại”, search bị xóa, danh sách nhảy về đầu và khả năng thao tác thay đổi theo width.

### §RM.7 — P2/M: Quyền sở hữu state lai làm tab này tác động hình học tab khác

**Bằng chứng**

- `toolMenuWidth` và `isWorkspaceSidebarOpen` global/persisted; active tool và `isMiniToolbarExpanded` theo từng tab/component.
- App giữ tất cả tab mounted: `desktop/src/App.tsx:1401-1408`.

**Tác động**

Đóng/rộng panel ở tab A đổi ngay global width/open của tab B; nhưng tab B diễn giải chúng bằng active tool và mini-expanded riêng. Chuyển tab có thể thấy panel tự đổi full/compact/icon hoặc bị bóp dù tab đó không được thao tác.

**Hướng sửa:** chốt ownership rõ ràng. Có thể giữ `preferredWidth` global, nhưng `mode/configOpen/activeTool` phải theo tab; hoặc toàn bộ mode global. Không giữ mô hình lai hiện tại.

### §RM.8 — P2/S: Gesture resize có thể kẹt khi nhả chuột ngoài WebView/Alt-Tab

**Bằng chứng**

- Home chỉ nghe `mousemove`/`mouseup` trên `window`: `desktop/src/components/HomeTab.tsx:228-253`; khi kéo còn đặt pane `pointer-events-none`: `HomeTab.tsx:381-384`.
- Workspace chỉ nghe `mousemove`/`mouseup` trên `document`, đồng thời khóa `body.cursor` và `userSelect`: `desktop/src/components/ImpositionTab.tsx:1737-1789`.
- Không có Pointer Events, `setPointerCapture`, `pointercancel` hoặc cleanup khi `window.blur`.

**Tác động:** thả chuột ngoài cửa sổ hoặc Alt-Tab giữa lúc kéo có thể để UI ở trạng thái đang resize, mất select/cursor hoặc pointer-events cho tới một thao tác khác.

### §RM.9 — P2/S: Không clamp theo viewport; hydration async có thể làm menu nhảy sau startup

**Bằng chứng**

- Workspace cho config tới 800 px rồi có thể cộng rail 220 px: `desktop/src/components/ImpositionTab.tsx:1749-1761,3553-3558`.
- Cửa sổ cho phép nhỏ tới 900 px: `desktop/src-tauri/tauri.conf.json:17-19`.
- Home/Workspace không normalize width khi window/monitor/DPI thay đổi.
- Store khởi tạo default 320/390 rồi rehydrate từ Tauri storage async; callback hiện chỉ đồng bộ ngôn ngữ: `desktop/src/stores/appSettingsStore.ts:169-193`.

**Tác động:** một trạng thái hợp lệ có right rail 1020 px, ép Viewer gần 0; khởi động/đổi màn hình có thể tạo cú nhảy width rõ rệt. Tác vụ rất sớm trong lúc hydrate còn có nguy cơ cạnh tranh với state vừa đọc từ đĩa.

### §RM.10 — P2/M: Thiếu regression test đúng lớp lỗi người dùng gặp

**Bằng chứng**

- `ToolMenuList.entitlement.test.tsx` chỉ kiểm quyền/activation cơ bản.
- `toolPanel.test.ts` chỉ kiểm pure routing nội dung panel.
- `OutputPreviewLayout.test.tsx` có một ca ép open + width 390.
- Không có test drag, threshold 120/280, nút X/mũi tên, compact collapse, no-file→file-open, toolbar/F7/Crop/Pages, multi-tab, hydration, pointer cancel hoặc số lần persist.

**Hướng sửa:** tách reducer thuần để test ma trận state; component test cho entry point; một test integration hai tab; lấy `DielineTool.sidebar.test.tsx` làm mẫu cho pointer drag và giữ state khi đổi layout.

---

## 4. Thứ tự sửa đề xuất

### Lô A — Sửa tính đúng khi mở/đóng panel (tối đa 5 file)

1. Tạo helper/reducer canonical cho open tool + mode + minimum width.
2. Chuyển Toolbar, context menu, Crop, Edit, F7 và locked tool sang helper này.
3. Xóa/không dùng state sidebar legacy trong `useWorkspaceStore`.
4. Test: panel đang đóng/icon → từng entry point phải mở đúng config ở width dùng được.

### Lô B — Sửa độ mượt và persistence (tối đa 5 file)

1. Width tạm trong lúc drag, cập nhật tối đa một lần mỗi frame.
2. Persist đúng một lần ở cuối gesture; gộp width+mode/open thành một transition atomically.
3. Selector hẹp cho `App`, `ImpositionTab`, `AcrobatViewer`, toolbar/status bar.
4. Pointer capture + `pointercancel` + `blur`; clamp theo viewport.
5. Đo số render/số lần `write_file_atomic` trước/sau.

### Lô C — Hợp nhất ba presentation mode (tối đa 5 file)

1. Một catalog renderer dùng chung Home/Workspace.
2. Giữ query, scroll, collapse và focus khi đổi full/compact/icon.
3. Nút X/mũi tên/Settings có đúng một nghĩa và nhãn tương ứng.
4. Tách `preferredWidth` global khỏi `configOpen/mode` theo tab.

### Lô D — Regression/visual QA

1. Ma trận pure state: tool `none/selected` × open/closed × width `48/119/120/279/280/800`.
2. Một gesture chỉ persist một lần; pointer cancel/blur luôn cleanup.
3. Hai tab không làm đổi mode/scroll/query của nhau.
4. Home→mở PDF không nhảy mode ngoài chủ đích.
5. Test tay ở 900×600, 1400×900, màn 125%/150% DPI, có 1 và 5 tab PDF.

---

## 5. Tiêu chí nghiệm thu

- Kéo rail bám con trỏ, không snap giữa gesture và không ghi file cài đặt theo từng pixel.
- Full/compact/icon là ba trạng thái xác định; mọi nút có một hành vi duy nhất và tooltip đúng hành vi.
- Mọi lối mở tool cần config đều mở panel thật ở width tối thiểu dùng được ngay lần đầu.
- Nút đóng luôn trả lại không gian Viewer theo cùng một quy tắc.
- Search, scroll, collapse, focus và active tool không mất khi đổi mode.
- Home và Workspace nhìn/hoạt động như cùng một catalog.
- Tab A không làm panel tab B thay đổi ngoài preference width đã chốt rõ.
- Không kẹt cursor/user-select/pointer-events khi thả chuột ngoài cửa sổ.
- Không có right rail vượt quá không gian hợp lý của viewport.
- Test ma trận state + integration hai tab đều xanh; test tay ba kích thước/DPI đạt.

---

## 6. Chốt duyệt

Báo cáo dừng tại chốt 1 theo quy trình audit. Đề xuất ưu tiên **Lô A → Lô B** trước vì hai lô này giải quyết trực tiếp “bấm lúc được lúc không” và “kéo không mượt”; Lô C mới chuẩn hóa hình thức. Chưa thay đổi hành vi UI cho tới khi chủ dự án duyệt danh sách và thứ tự sửa.
