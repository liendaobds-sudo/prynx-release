# NHẬT KÝ SỬA — THANH MENU NGANG (audit 2026-07-28)

Báo cáo gốc: `docs/BAO_CAO_AUDIT_MENUBAR_2026-07-28.md` (15 phát hiện §MB.1–§MB.15).
Tag truy vết trong code: `UIUX (audit menu 2026-07-28 §MB.x)`.
Trạng thái: **đã áp 15/15 phát hiện qua 6 lô, cộng §MB.2b (lô 7) và §MB.13b/§MB.14b/§RF.1/§WT.1 (lô 8).**

---

## Lô 1 — Chặn "bấm không có gì xảy ra" (§MB.1 phần gate, §MB.2, §MB.10, §MB.12)

**File:** `desktop/src/App.tsx`

| Thay đổi | Lý do | Kiểm tra |
|---|---|---|
| Thêm bảng năng lực tab cạnh `NATIVE_PRINT_TOOL_TYPES`: `VIEWER_COMMAND_TOOL_TYPES` (tab có AcrobatViewer nghe `prynx-menu-command`) và `SAVE_TOOL_TYPES` (tab nghe `app-trigger-save`) | Menu chỉ gate bằng `isToolActive = activeTabId !== 'home'` nên 17 mục sáng giả trên tab Khuôn bế / Ghép & Trộn / So sánh | typecheck |
| Menu Sửa + Xem dùng `canViewerCommand`; Lưu/Lưu thành… dùng `canSaveActiveTab` | Mục nào tab không xử lý được thì mờ hẳn | bấm thử 5 loại tab |
| Ctrl+S: kiểm `SAVE_TOOL_TYPES` trước khi phát sự kiện, không thì báo `shell:tab_nay_chua_ho_tro_luu_bang_ctrl_s` | Trước đây Ctrl+S ở tab Khuôn bế phát sự kiện vào hư không → user tưởng đã lưu | thử tay |
| Bỏ nhánh `else` của **In…** | Item đã `disabled` khi không in được → nhánh đó không bao giờ chạy | đọc lại code |
| Mọi nhãn phím tắt chuyển sang `getShortcutLabel()` (Ctrl+N/O/S/Shift+S/P/W, Alt+F4, Ctrl+Z/Y) | Trước hardcode → đổi bảng phím tắt là lệch nhãn | typecheck |

## Lô 2 — Mở gần đây + i18n (§MB.3, §MB.4)

**File:** `App.tsx`, `i18n/locales/vi.json`, `i18n/locales/en.json`

- `openRecentFile` giờ `stat()` trước khi mở: còn file thì lấy **dung lượng thật** (size trong store có thể cũ); mất file thì `toast.error` kèm đường dẫn và gỡ khỏi danh sách — đúng mẫu `RecentFilesGrid` (§D-13). Trước đây chỉ `console.error` → tab mở ra rỗng, im lặng.
- Thêm 8 key `shell:` còn thiếu: `menu_file/edit/view/tools/window/help`, `menu_in`, `tab_nay_chua_ho_tro_luu_bang_ctrl_s`. **Phát hiện thêm khi làm:** key `misc.recentFilesGrid:file_da_di_chuyen` (§D-13) cũng chưa bao giờ tồn tại trong locale — đã thêm cả vi/en, nên chỗ cũ ở HomeTab cũng hết chạy defaultValue.

## Lô 3 — Menu Xem/Sửa đầy đủ (§MB.5, §MB.6, §MB.15 phần dọn danh sách)

**File:** `stores/useActiveViewerStore.ts` (mới), `components/AcrobatViewer.tsx`, `App.tsx`, 2 file locale

- **Store mới `useActiveViewerStore`**: bản sao toàn cục của `pageDisplayMode` / `fitMode` / `numPages` từ viewer đang active. Cần vì state thật nằm trong `useWorkspaceStore` tạo **mỗi tab một instance**, `App.tsx` ở ngoài Provider không đọc được. **Cố tình không đưa `activePage`/`selectedIndices` vào store** — chúng đổi liên tục khi cuộn, shell sẽ render lại theo từng trang (đúng loại hồi quy hiệu năng audit trước đã dặn tránh). App đọc bằng **selector từng trường** nên publish lại cùng giá trị không gây render.
- Menu Xem: tick ✓ cho 4 chế độ hiển thị trang + 2 chế độ fit; thêm nhóm **Trang đầu / Trang trước / Trang sau / Trang cuối** (4 lệnh này AcrobatViewer đã xử lý từ trước, chỉ chưa có mục menu nào phát).
- Menu Sửa: thêm **Chọn tất cả trang / Bỏ chọn trang / Xoay phải 90° / Xoay trái 90° / Trích xuất trang…**. AcrobatViewer nhận thêm 4 cmd (`select-all-pages`, `clear-page-selection`, `rotate-right`, `rotate-left`, `extract-pages`) qua **listener riêng đặt sau các handler thao tác trang** — gộp vào effect menu ở trên sẽ chạm TDZ của `handleQuickRotate` khi đánh giá mảng deps lúc render.
- Menu Tệp > Mở gần đây: thêm **Xóa danh sách gần đây** (`clearUnstarred`, giữ file gắn sao).

## Lô 4 — MenuBar bàn phím & ARIA (§MB.7, §MB.9, §MB.15 phần tooltip)

**File:** `components/MenuBar.tsx`, `components/MenuBar.test.tsx` (mới), `App.tsx`

- ARIA: `role="menubar"` / `menu` / `menuitem`, `aria-haspopup`, `aria-expanded`, `role="menuitemcheckbox"` + `aria-checked` cho mục bật/tắt, `role="separator"`.
- Bàn phím: ←→ đổi menu (giữ trạng thái mở), ↑↓ chạy trong menu (bỏ qua separator và item disabled), Home/End, → mở submenu và focus mục đầu, ← / Esc quay ra, Tab đóng menu. Trước đây submenu **chỉ mở bằng hover** nên "Mở gần đây" và toàn bộ menu Công cụ không thể tới bằng bàn phím.
- `outline-none` → `focus-visible:ring-2 ring-app-accent` (vòng focus nhìn thấy được).
- §MB.9: bỏ khe `ml-0.5` giữa hàng cha và submenu + hoãn đóng 200ms → con trỏ đi đường chéo không làm submenu đóng giữa đường.
- Thêm `MenuItem.title` (tooltip riêng): item "Mở gần đây" hiện **tên file**, tooltip là **đường dẫn đầy đủ** → hai file trùng tên khác thư mục phân biệt được.
- Test mới: 10 case (ARIA + điều hướng bàn phím + khe submenu bằng fake timers).

## Lô 5 — Nối menu Xem vào tab Khuôn bế (§MB.1 phần còn lại)

**File:** `dieline-tool/DielineCanvas2D.tsx`, `dieline-tool/NestingCanvas.tsx`, `dieline-tool/DielineTool.tsx`, `App.tsx`

- Tách `fitToView(mode)` / `fitSheetToView(mode)` khỏi effect auto-fit để menu gọi lại được; thêm `zoomAroundCenter` (khác wheel: zoom quanh tâm khung, không quanh con trỏ).
- Hai canvas nhận `prynx-menu-command` cho `zoom-in / zoom-out / zoom-100 / fit-page / fit-width`. `zoom-100` = scale 1, khớp với chỉ số % trên thanh canvas.
- Thêm prop `isActive` (truyền từ `DielineTool`) — mọi tab đều mounted nên không có cờ này thì zoom ở tab khác cũng làm canvas khuôn bế ở nền nhảy theo.
- `App.tsx`: tách `ZOOM_COMMAND_TOOL_TYPES` (họ bình bài + `dieline`) khỏi `VIEWER_COMMAND_TOOL_TYPES`. Nhóm zoom/fit bật trên tab Khuôn bế; nhóm trang (điều hướng, chế độ một/hai trang, hoàn tác trang, xoay/trích xuất) vẫn mờ vì khuôn bế không có khái niệm trang. Dấu ✓ fit/chế độ trang chỉ hiện khi đang ở viewer PDF.

## Lô 6 — Cửa sổ, Trợ giúp, badge PRO, memo (§MB.8, §MB.11, §MB.13, §MB.14)


**File:** `App.tsx`, `lib/keyboardShortcuts.ts`, 2 file locale

- §MB.13: thêm `global.next_tab` (Ctrl+Tab) và `global.prev_tab` (Ctrl+Shift+Tab) vào bảng phím tắt trung tâm + handler trong App; menu Cửa sổ thêm **Tab kế tiếp / Tab trước / Đóng tất cả tab**. `stepActiveTab` dùng chung cho menu và phím (một chỗ tính, không lệch hành vi).
  - **Đóng tất cả tab CỐ TÌNH chỉ đóng tab đã lưu**: luồng hỏi-lưu hiện tại giữ MỘT tab chờ xác nhận (`tabToConfirmClose`), gọi lặp sẽ ghi đè nhau và tab dirty lặng lẽ ở lại. Nên đóng phần sạch rồi báo rõ còn mấy tab chưa lưu + nhảy tới tab đó, thay vì để user tưởng đã đóng hết.
- §MB.14: thêm `global.help` (F1 → mở bảng Phím tắt), mục **Hướng dẫn sử dụng** (mở `SUPPORT.product`), nhãn phím F1 cho mục Phím tắt.
- §MB.8: mục tool trong menu Công cụ khóa Pro giờ hiện `🔒 PRO` + tooltip "Cần key PrynX Pro", giống HomeTab. Trước đây menu không hé dấu hiệu nào, bấm mới nhận toast từ chối.
- §MB.11: nhóm "Công cụ" (~30 entry × lọc × tạo icon JSX) tách ra `useMemo` theo `[hiddenTools, licensePlan, licenseFeatures, handleOpenApp, t]`. **Không memo cả mảng `menus`** — nó phụ thuộc ~15 giá trị, memo sai một dep là menu hiển thị trạng thái cũ, rủi ro lớn hơn lợi ích. Không cần thêm `i18n.language` vào deps: `react-i18next@17` sinh `t` mới mỗi lần đổi ngôn ngữ (`useTranslation` → `getSnapshot` tạo snapshot mới), đã kiểm trong `node_modules`.

## Lô 7 — Lưu vẫn im lặng ở 2 trạng thái (§MB.2b — phát hiện thêm khi user hỏi lại)

**File:** `components/ImpositionTab.tsx`, `App.tsx`, 2 file locale

Lô 1 chỉ chặn theo LOẠI tab. Rà lại đường Lưu trên đúng tab có Lưu thật thì còn 2 chỗ
bấm-không-thấy-gì, cùng đúng loại lỗi mà đợt audit này nhắm tới:

| Trạng thái | Trước | Sau |
|---|---|---|
| Tab bình bài **chưa nạp file** | Lưu / Lưu thành… vẫn sáng. `handleSaveFile` dừng ở `if (!targetBlob) return false` — im lặng. "Lưu thành…" còn mở cả hộp thoại rồi bấm nút nào cũng không đi đâu (`SaveModal` không kiểm `file`) | Hai mục **mờ** khi `activeViewerNumPages === 0`; `handleTriggerSave` bắt sớm và báo "Chưa có file nào để lưu — mở hoặc kéo file PDF vào đã." |
| File đã nạp, **chưa sửa gì** | `if (!(isDirty \|\| viewerDirty)) { reply('saved'); return; }` — thoát êm, không một chữ | Toast "File chưa có thay đổi nào cần lưu." Luồng **thoát app** (có `requestId`) vẫn im lặng vì nó chỉ cần kết quả `saved`, không nên spam toast khi đóng nhiều tab |

Ghi chú kỹ thuật: mục menu gate bằng `activeViewerNumPages` (đã publish sẵn ở lô 3) thay vì
thêm cờ `hasFile` mới — với công cụ PDF thì "chưa có trang nào" và "chưa có file" trùng nhau
trên thực tế (mọi tool sinh kết quả đều nạp kết quả vào viewer). Đánh đổi: file PDF hỏng
không parse được sẽ mờ mục Lưu — chấp nhận được vì lưu lại file hỏng không giải quyết gì.

## Lô 8 — Các mục còn treo, user duyệt làm luôn (§MB.13b, §MB.14b, §RF.1, §WT.1)

### §MB.13b — "Đóng tất cả tab" hỏi-lưu từng file thật

**File:** `App.tsx`, 2 file locale

Tách hàng đợi hỏi-lưu ra khỏi việc `destroy()` cửa sổ — trước đây dính chặt nên lô 6 phải
làm bản rút gọn (chỉ đóng tab sạch).

| Trước | Sau |
|---|---|
| `quitDirtyQueue` + `beginQuitWithDirtyPrompt` / `finishAppQuit` / `advanceQuitQueue` / `cancelQuitFlow` / `quitSaveCurrent` — mọi đường kết thúc đều `destroy()` cửa sổ | `dirtyQueue` + `dirtyQueueMode: 'quit' \| 'close-all'`; `destroyAppWindow()` tách riêng, chỉ gọi khi mode `'quit'`. Đặt tên lại theo việc: `beginDirtyQueue` / `finishDirtyQueue` / `advanceDirtyQueue` / `cancelDirtyQueue` / `resolveQueueTab` / `saveCurrentQueueTab` |
| Đóng tất cả tab: đóng tab sạch, toast "còn N tab chưa lưu" | Tab sạch đóng ngay; mỗi tab chưa lưu hiện **một** hộp Lưu / Không lưu / Huỷ, quyết định xong đóng luôn tab đó (`resolveQueueTab`). Huỷ = dừng, giữ phần còn lại. Đúng cách Acrobat đóng nhiều tài liệu |
| Tiêu đề hộp thoại luôn là "Lưu thay đổi trước khi thoát?" | Mode `'close-all'` dùng `shell:luu_thay_doi_truoc_khi_dong_tab` |

**Lỗi phát hiện thêm và sửa cùng:** nút "Lưu" trong hộp thoại hàng đợi trước đây gate bằng
`['imposition','nup','diecut','cnc']` hardcode — **thiếu `'preflight'`** dù tab đó có
listener save thật, nên tab Preflight chưa lưu chỉ được chọn "Không lưu". Nay dùng chung
`SAVE_TOOL_TYPES` với menu, không bao giờ lệch nữa.

Key `shell:con_tab_chua_luu` (thêm ở lô 6) giờ không còn dùng → đã bỏ khỏi cả vi/en.

### §MB.14b — "Cài đặt & Cấu hình" chuyển sang menu Sửa

**File:** `App.tsx`, 2 file locale

Xuống cuối menu **Sửa** sau một separator (đúng chỗ Preferences của Acrobat, cũng là chuẩn
Windows). Nhãn giữ nguyên chữ cũ để khách không phải học lại, phím tắt vẫn Ctrl+K lấy từ
`getShortcutLabel('global.settings')`. Mục **Phím tắt** GIỮ ở Trợ giúp — đó là nội dung tra
cứu, không phải thiết lập.

### §RF.1 — Cờ "file đã mất" về một chỗ trong store

**File:** `lib/useRecentFiles.ts`, `App.tsx`, `RecentFiles/RecentFilesGrid.tsx`, `RecentFiles/ThumbnailView.tsx`

- Store thêm `missingPaths` + `markMissing` / `clearMissing`, và helper dùng chung
  `statRecentFile(path)`: stat một lần, tự ghi/xoá cờ, trả **kích thước thật** hoặc `null`.
- Ba nơi trước đây tự `import('@tauri-apps/plugin-fs')` rồi `stat()` riêng lẻ
  (`RecentFilesGrid`, `ThumbnailView`, và menu Mở gần đây ở lô 2) nay gọi cùng helper →
  hết cảnh chỗ này báo "Missing" mà chỗ kia vẫn hiện bình thường.
- `missingPaths` **không persist** (`partialize` chỉ lưu `files`): file có thể được đưa về
  đúng chỗ giữa hai phiên, lưu cờ lại thì lần sau mở app vẫn báo mất oan.
- Menu Mở gần đây hiện `⚠` trước tên file đã xác nhận mất, tooltip nói rõ lý do.
- Dùng `'__TAURI_INTERNALS__' in window` thay `(window as any)` để không thêm `any` mới vào
  đống nợ lint đang được dọn.

### §WT.1 — Tab trùng tên

**File:** `App.tsx`

- Mở tool **không kèm file** → tiêu đề tab lấy tên CHÍNH tool đó ("Cắt khổ (Crop)", "Bình
  tem bế", "Trộn dữ liệu VDP") thay vì tiêu đề chung "Bình bài (Chưa có file)". Mở 5 tool
  khác nhau giờ ra 5 tên khác nhau ở cả thanh tab lẫn menu Cửa sổ. Mở **kèm file** giữ
  nguyên đường cũ (tool tự đổi tiêu đề thành tên file qua `onTitleChange`).
- Menu Cửa sổ: nếu vẫn còn trùng tên (mở cùng tool hai lần, cùng một file), đánh số
  `(1)(2)` cho nhóm trùng; tab chưa lưu có dấu `*` như thanh tab — để trước khi bấm "Đóng
  tất cả tab" đã biết cái nào sẽ bị hỏi.

---

## Kết quả verify

| Hạng mục | Lệnh | Kết quả |
|---|---|---|
| TS types | `npm run typecheck` | **PASS** (chạy lại sau từng lô) |
| Test mới MenuBar | `npx vitest run src/components/MenuBar.test.tsx` | **PASS** 10/10 |
| Viewer + acrobat | `npx vitest run src/hooks/viewer src/components/acrobat` | **PASS** 36/36 |
| Toàn bộ component + hook (sau lô 7) | `npx vitest run src/components src/hooks` | **PASS** 239/239 |
| component + hook + lib (sau lô 8) | `npx vitest run src/components src/hooks src/lib` | **PASS** 128 file, 1143 test, 2 skip |
| Khuôn bế (gồm golden master) | `npx vitest run src/components/dieline-tool src/lib/dieline` | **PASS** 514/514, 2 skip — **không `-u` snapshot nào** |
| Toàn bộ | `npm run test` | 1159 pass / **1 fail**: `src/lib/dieline/geometry.test.ts > structural panels do not overlap (tray)` |
| Lint phạm vi sửa | `npx eslint <các file đã sửa>` | Không thêm lỗi/cảnh báo mới; `MenuBar.tsx`, `MenuBar.test.tsx`, `useActiveViewerStore.ts`, `keyboardShortcuts.ts` **sạch hoàn toàn** |

**Về 1 test fail — KHÔNG do đợt này:**
- Chạy riêng: `npx vitest run src/lib/dieline/geometry.test.ts` → **39/39 PASS trong 2.84s**.
- Chạy full suite (nhiều worker song song) → test property-based này timeout ở mốc 5000ms.
- Chạy full suite **loại trừ** file test mới (`--exclude src/components/MenuBar.test.tsx`) → **vẫn fail y như vậy** ⇒ không phải do thêm test mới, mà là giới hạn timeout 5s quá sát khi máy bị tranh CPU.
- Đợt này không chạm file nào trong `src/lib/dieline/`.
- Đề xuất riêng (ngoài phạm vi): nới `testTimeout` cho nhóm property-based trong `geometry.test.ts`.

**Chưa chạy:** pytest/cargo (đợt này không chạm backend Python và Rust). Chưa thao tác thật qua `run_dev.bat` — cần chạy trên máy để duyệt checklist dưới.

---

## Checklist kiểm tay (đề nghị chạy `run_dev.bat` rồi soi)

1. Tab **Home**: chỉ "Giao diện Tối", Tài liệu mới, Mở file…, Cài đặt, Trợ giúp sáng; nhóm trang/zoom mờ.
2b. **Lưu / Lưu thành…** (§MB.2b): tab bình bài vừa mở, chưa nạp file → hai mục **mờ**. Nạp file, chưa sửa gì → bấm Lưu ra toast "chưa có thay đổi nào cần lưu". Sửa gì đó (xoay/xóa trang) → Lưu ghi file thật, Lưu thành… mở hộp chọn kiểu lưu.
2. Tab **Bình bài** có file: menu Xem tick đúng chế độ đang xem; Trang đầu/cuối nhảy đúng; Xoay phải/trái áp cho trang đang chọn (chưa chọn → toast nhắc Ctrl+A); Trích xuất trang mở modal với dải trang đang chọn.
3. Tab **Khuôn bế**: Phóng to / Thu nhỏ / Về 100% / Vừa khung **chạy thật** trên canvas 2D và trên xếp khuôn; nhóm trang + Lưu vẫn mờ. Mở song song một tab bình bài, zoom ở tab đó → canvas khuôn bế **không** nhảy theo.
4. Tab **Ghép & Trộn / So sánh**: menu Sửa + Xem mờ; In… vẫn sáng (đúng, có listener print).
5. **Bàn phím**: Alt-free — click "Tệp" rồi dùng ←→ ↑↓ → Enter; → mở "Mở gần đây"; Esc trả focus về nút menu.
6. **Mở gần đây**: đổi tên một file đã mở rồi bấm lại → toast tiếng Việt kèm đường dẫn, mục đó biến khỏi danh sách.
7. **Ctrl+Tab / Ctrl+Shift+Tab** đảo tab. **Đóng tất cả tab** khi có 2-3 tab chưa lưu → tab sạch đóng ngay, rồi lần lượt một hộp thoại cho mỗi tab chưa lưu: thử cả ba nút (Lưu → ghi file rồi đóng tab đó; Không lưu → đóng luôn; Huỷ → dừng, các tab chưa xử lý còn nguyên). Kiểm cả trường hợp tab **Preflight** chưa lưu — nút "Lưu" phải hiện (trước đây bị thiếu).
7b. **Thoát app** (nút X / Alt+F4) khi có tab chưa lưu: hàng đợi vẫn hỏi từng file rồi đóng ứng dụng — đây là đường đã refactor, cần chắc không hồi quy.
7c. **Tab trùng tên**: mở "Cắt khổ (Crop)" + "Xáo trộn trang" + "Bình tem bế" → thanh tab hiện 3 tên khác nhau. Mở "Cắt khổ (Crop)" hai lần → menu Cửa sổ hiện "(1)" và "(2)".
7d. **File gần đây đã mất**: đổi tên một file đã mở → lưới Home hiện "Missing", menu Mở gần đây hiện `⚠` trước tên. Đưa file về đúng chỗ → dấu ⚠ mất sau khi mở lại thành công.
7e. **Cài đặt & Cấu hình** giờ ở cuối menu **Sửa** (không còn trong Trợ giúp); Ctrl+K vẫn mở được.
8. **F1** mở bảng Phím tắt (có thêm 3 dòng Ctrl+Tab / Ctrl+Shift+Tab / F1).
9. Đổi ngôn ngữ sang **English**: 6 nhãn menu gốc và "Print…" phải sang tiếng Anh (trước đợt này vẫn là tiếng Việt).
