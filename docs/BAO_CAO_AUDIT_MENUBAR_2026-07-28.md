# BÁO CÁO AUDIT — THANH MENU NGANG (Tệp / Sửa / Xem / Công cụ / Cửa sổ / Trợ giúp)

**Ngày:** 2026-07-28
**Phạm vi:** `desktop/src/components/MenuBar.tsx` (component hiển thị) + khối `menus` trong `desktop/src/App.tsx:1028–1128` + phía nhận lệnh (`AcrobatViewer.tsx`, `ImpositionTab.tsx`, các tab khác).
**Không thuộc phạm vi:** toolbar viewer, context menu chuột phải, panel phải, thanh tab.
**Tài liệu đã đọc trước khi kết luận:** `docs/BAO_CAO_AUDIT_UIUX_2026-07-27.md` (§A-12, §A-03, §A-14), `docs/UIUX_FIXES_2026-07-27.md`.

---

## 1. Tóm tắt điều hành

Thanh menu **đúng về hình thức nhưng rỗng về hành vi ở phần lớn tab**. Nguyên nhân gốc là một chỗ duy nhất:

> Điều kiện bật/tắt mọi mục menu là `isToolActive = activeTabId !== 'home'` (`App.tsx:993`) — chỉ hỏi "có phải tab Home không", **không hỏi "tab này có xử lý được lệnh không"**.

Trong khi đó phía nhận lệnh hẹp hơn nhiều:

| Kênh lệnh | Ai lắng nghe (toàn repo) |
|---|---|
| `prynx-menu-command` (toàn bộ menu **Sửa** + **Xem**) | **chỉ** `AcrobatViewer.tsx:538` |
| `app-trigger-save` (Lưu / Lưu thành…) | **chỉ** `ImpositionTab.tsx:2026` |
| `app-trigger-print` (In…) | `ImpositionTab`, `CombineTab`, `CompareTab`, `DielineTool` — **và có cổng gate riêng** `NATIVE_PRINT_TOOL_TYPES` |

`AcrobatViewer` chỉ được mount bên trong `ImpositionTab` (`ImpositionTab.tsx:2413`). Hệ quả: trên tab **Khuôn bế**, **Ghép & Trộn PDF**, **So sánh PDF**, **So sánh Văn bản**, 17 mục menu vẫn sáng như bình thường, bấm vào **không có gì xảy ra và không có thông báo nào**. Đây chính là cảm giác "hoạt động không đầy đủ".

Điểm sáng: mục **In…** đã làm đúng chuẩn — gate bằng danh sách tab thực sự có listener. Cách gate đó chính là khuôn mẫu để áp cho Lưu và cho nhóm lệnh viewer.

Tổng: **15 phát hiện** — 3 P1, 4 P2, 8 P3.

---

## 2. Bảng phát hiện

### Nhóm A — Mục menu bật nhưng không chạy (P1)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §MB.1 | **12 mục menu Sửa + Xem chết trên 4 họ tab.** Menu Sửa (Hoàn tác, Làm lại, Chỉnh sửa đối tượng, Cắt khổ, Xóa trang) và Xem (zoom, fit, 4 chế độ trang, thước đo) đều đi qua `viewerCmd()` → sự kiện `prynx-menu-command`. Listener duy nhất nằm trong `AcrobatViewer`, mà `AcrobatViewer` chỉ có trong `ImpositionTab`. Tab Khuôn bế / Ghép & Trộn / So sánh PDF / So sánh Văn bản: item sáng, bấm im lặng. Riêng Khuôn bế **có zoom/pan riêng** nhưng không nối vào menu | `App.tsx:991–993, 1062–1087` · `AcrobatViewer.tsx:538` (listener duy nhất) · `ImpositionTab.tsx:2413` · zoom riêng: `dieline-tool/DielineCanvas2D.tsx:233`, `NestingCanvas.tsx:270` | **P1** | M |
| §MB.2 | **Lưu / Lưu thành… chết trên các tab đó.** Chỉ `ImpositionTab` lắng nghe `app-trigger-save`; menu chỉ gate bằng `!isToolActive`. Đang mở tab Khuôn bế → Tệp > Lưu = không phản hồi (Ctrl+S cũng vậy). Nghịch lý: cùng file, mục **In…** lại gate đúng bằng `NATIVE_PRINT_TOOL_TYPES` | `App.tsx:1037–1041` vs `App.tsx:995–1000, 1043–1054` · `ImpositionTab.tsx:2026` | **P1** | S |
| §MB.3 | **Mở gần đây: file đã xóa/di chuyển → mở tab rỗng, im lặng.** `openRecentFile` không `stat()` trước, `catch` chỉ `console.error`, và dùng `rf.size` đã lưu thay vì kích thước thật. Cùng dự án, `RecentFilesGrid` đã làm đúng: `stat()` rồi báo lỗi tiếng Việt (§D-13) | `App.tsx:1001–1013` vs `components/RecentFiles/RecentFilesGrid.tsx:66–81` · `ThumbnailView.tsx:46–50` | **P1** | S |

### Nhóm B — Thiếu thông tin / thiếu chức năng người dùng chờ đợi (P2)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §MB.4 | **6 nhãn menu gốc chưa có key i18n** → bản English hiện nguyên tiếng Việt. `t('shell:menu_file', 'Tệp')` chỉ chạy defaultValue vì `shell:menu_file/edit/view/tools/window/help` **không tồn tại trong cả `vi.json` lẫn `en.json`** (đã dò script). Nhãn `In…` cũng không có trong locale nên `tv()` trả nguyên chuỗi. `UIUX_FIXES_2026-07-27.md` ghi §A-12 "song ngữ đủ" — thực tế mới bọc `t()`, chưa thêm key | `App.tsx:1031, 1061, 1072, 1090, 1106, 1116` · `App.tsx:1044` · `i18n/locales/vi.json`, `en.json` (thiếu key) | P2 | S |
| §MB.5 | **Menu Xem không cho biết đang ở chế độ nào.** 4 chế độ hiển thị trang (một trang / cuộn dọc / hai trang / cuộn hai trang) và fit mode không dùng `checked` — chỉ Thước đo và Giao diện Tối có. `MenuItem.checked` đã hỗ trợ sẵn, `MenuBar` đã chừa ô ✓ | `App.tsx:1080–1083` · `MenuBar.tsx:16, 105, 122–126` | P2 | S |
| §MB.6 | **Viewer đã có lệnh nhưng menu không phơi ra.** `AcrobatViewer` xử lý `first-page/last-page/prev-page/next-page` mà không mục menu nào phát. Cũng thiếu hẳn các thao tác đã chạy được bằng phím: xoay trang (R / Shift+R), chọn tất cả trang (Ctrl+A), trích xuất trang (E), Con trỏ/Tay (V/H), đo kích thước DIM (D). Menu Sửa chỉ có 5 mục | `AcrobatViewer.tsx:521–524` (đã có handler) · `lib/keyboardShortcuts.ts:139–170` · `App.tsx:1062–1067` | P2 | S |
| §MB.7 | **Không dùng được bằng bàn phím, không có vai trò ARIA.** `MenuBar` không có `role="menubar"/"menuitem"`, không `aria-haspopup`/`aria-expanded`; `outline-none` xóa vòng focus; không điều hướng mũi tên/Home-End; **submenu chỉ mở bằng hover** → "Mở gần đây" và **toàn bộ menu Công cụ** không thể tới bằng bàn phím | `MenuBar.tsx:71–99` (nút menu gốc), `148–160` (submenu hover-only) | P2 | M |

### Nhóm C — Đánh bóng & nợ kỹ thuật (P3)

| Mã | Phát hiện | Bằng chứng | Mức | Effort |
|---|---|---|---|---|
| §MB.8 | Menu Công cụ không hiện khóa Pro: HomeTab có badge khóa theo license, menu chỉ lọc `hiddenTools` → bấm mục Pro mới nhận toast từ chối | `App.tsx:1092–1104` vs `HomeTab.tsx:57–59` · `App.tsx:490–499` | P3 | S |
| §MB.9 | Khe hở 2px `ml-0.5` giữa hàng cha và submenu: con trỏ đi qua khe làm `onMouseLeave` chạy → submenu đóng giữa đường; không có delay đóng | `MenuBar.tsx:143–160` | P3 | S |
| §MB.10 | Nhánh `else` của **In…** không bao giờ chạy vì item đã `disabled: !canNativePrint` → toast hướng dẫn "Ctrl+P chỉ hỗ trợ trình xem PDF" là code chết trong menu | `App.tsx:1045, 1050–1052` | P3 | S |
| §MB.11 | `menus` dựng lại mỗi lần render `AppInner` (không `useMemo`): `TOOL_CATEGORIES.flatMap` + filter ~30 tool + tạo JSX icon lucide mỗi render, kể cả khi menu đang tắt | `App.tsx:1028` · `App.tsx:1142` (`showMenuBar` mới render) | P3 | S |
| §MB.12 | Nhãn phím tắt Hoàn tác/Làm lại hardcode `'Ctrl+Z'`/`'Ctrl+Y'` trong khi các mục khác dùng `getShortcutLabel()` → đổi bảng phím tắt là lệch nhãn | `App.tsx:1062–1063` vs `1065–1067` · `keyboardShortcuts.ts:101–108` | P3 | S |
| §MB.13 | Menu Cửa sổ chỉ có danh sách tab: thiếu Đóng tất cả tab, Tab kế/trước (toàn app **không có Ctrl+Tab**), không có mục cửa sổ (thu nhỏ/phóng to/toàn màn hình) dù cửa sổ là frameless tự chế | `App.tsx:1106–1114` · `App.tsx:855–900` (không có nhánh Ctrl+Tab) | P3 | S |
| §MB.14 | Trợ giúp: "Cài đặt & Cấu hình" đặt trong Trợ giúp (chuẩn Windows/Acrobat để ở Sửa hoặc Tệp > Tùy chọn); thiếu F1 và thiếu mục tài liệu hướng dẫn dù repo đã có `docs/training/` | `App.tsx:1116–1128` | P3 | S |
| §MB.15 | Menu Tệp thiếu "Xóa danh sách gần đây" (store đã có `clearUnstarred`/`removeFile`) và item gần đây chỉ có `title` = tên file, không hiện đường dẫn đầy đủ nên hai file trùng tên không phân biệt được | `App.tsx:1034–1035` · `lib/useRecentFiles.ts:66–79` · `MenuBar.tsx:170` | P3 | S |

---

## 3. Đã kiểm tra chéo — KHÔNG phải lỗi

Ghi lại để lần sau không "sửa" oan:

- **Ctrl+R (Thước đo) vẫn chạy.** `App.tsx:857–860` chặn F5/Ctrl+R nhưng chỉ `preventDefault()` + `return` trong handler của chính nó, **không** `stopPropagation()` — listener `viewer.toggle_rulers` của `useViewerHotkeys` (cũng trên `window`) vẫn nhận được sự kiện.
- **Dropdown không bị đè.** Thanh menu là `z-[100] relative` (stacking context), con dùng `z-context-menu` (1000) → vẫn vẽ trên vùng nội dung; modal `z-modal` (1100) là sibling nên đè lên dropdown — đúng ý.
- **Gate của In… là chính xác.** `NATIVE_PRINT_TOOL_TYPES` khớp đúng tập tab có listener `app-trigger-print`; `compare_text` bị loại là đúng (không có listener).
- **Menu Công cụ có lọc `hiddenTools`** và chặn license ở `handleOpenApp` — không phải lỗ hổng, chỉ thiếu tín hiệu thị giác (§MB.8).

---

## 4. Quick-win (sửa ít, người dùng thấy ngay)

1. §MB.2 — đưa Lưu/Lưu thành… về cùng cơ chế gate như In… (một `Set` tab hỗ trợ save).
2. §MB.4 — thêm 7 key i18n (6 nhãn menu + `In…`).
3. §MB.5 — thêm `checked` cho 4 chế độ hiển thị trang + fit mode.
4. §MB.3 — thêm `stat()` + thông báo tiếng Việt, copy đúng mẫu `RecentFilesGrid`.
5. §MB.10, §MB.12 — dọn code chết và nhãn phím tắt hardcode.

---

## 5. Đề xuất thứ tự sửa theo lô (≤5 file/lô, verify xong mới sang lô kế)

**Lô 1 — chặn "bấm không có gì xảy ra" (P1)**
`App.tsx` — thay `isToolActive` bằng khả năng thật của tab: một bảng năng lực (`TAB_CAPABILITIES`: viewer-cmd / save / print) đặt cạnh `NATIVE_PRINT_TOOL_TYPES`; item nào tab không hỗ trợ thì `disabled` thật. Xử lý §MB.1 (phần disable), §MB.2, §MB.10, §MB.12.
Verify: `npm run typecheck` + `npx vitest run src/hooks/viewer` + bấm thử từng menu trên 5 loại tab.

**Lô 2 — Mở gần đây + i18n (P1/P2)**
`App.tsx` (openRecentFile), `i18n/locales/vi.json`, `i18n/locales/en.json`. Xử lý §MB.3, §MB.4.
Verify: typecheck + đổi ngôn ngữ sang English soi lại thanh menu + thử mở một file đã đổi tên.

**Lô 3 — menu Xem/Sửa đầy đủ (P2)**
`App.tsx`, `AcrobatViewer.tsx` (nếu cần cmd mới), `i18n` 2 file. Xử lý §MB.5, §MB.6, §MB.15.
Verify: typecheck + `npx vitest run src/components/acrobat` + thử tay từng mục trên tab Bình bài.

**Lô 4 — MenuBar bàn phím & a11y (P2/P3)**
`MenuBar.tsx` (+ test mới). Xử lý §MB.7, §MB.9.
Verify: typecheck + test điều hướng bàn phím + Tab/mũi tên/Esc thủ công.

**Lô 5 — nối menu Xem vào tab Khuôn bế (P1 phần còn lại, tùy chọn)**
`dieline-tool/DielineTool.tsx` + `DielineCanvas2D.tsx`/`NestingCanvas.tsx` nhận `prynx-menu-command` cho zoom/fit. Đây là **thêm hành vi mới**, tách riêng khỏi các lô sửa lỗi.
Verify: `npx vitest run src/components/dieline-tool`.

**Lô 6 — đánh bóng còn lại (P3)**
`App.tsx` (useMemo `menus`, menu Cửa sổ, Trợ giúp), `HomeTab`-parity badge khóa. Xử lý §MB.8, §MB.11, §MB.13, §MB.14.

---

## 6. Phát hiện thêm (ngoài phạm vi — chỉ ghi nhận, không sửa trong đợt này)

- Toàn app không có **Ctrl+Tab / Ctrl+Shift+Tab** để chuyển tab — thiếu ở cả bảng phím tắt (`keyboardShortcuts.ts`) lẫn handler.
- `useRecentFiles` không có cờ "file đã mất"; mỗi UI tự `stat()` lại (RecentFilesGrid, ThumbnailView) → nên đưa về store một lần.
- Menu Cửa sổ hiển thị `tab.title` thô, tab bình bài đều mang tiêu đề "Bình bài (Chưa có file)" nên nhiều tab trùng tên khó phân biệt.

---

**Trạng thái: ĐÃ DUYỆT VÀ ÁP XONG 15/15 phát hiện (6 lô).** Chi tiết từng thay đổi, kết quả verify và checklist kiểm tay: `docs/MENUBAR_FIXES_2026-07-28.md`.
