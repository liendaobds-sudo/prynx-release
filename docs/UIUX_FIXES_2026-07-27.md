# NHẬT KÝ SỬA UI/UX — bắt đầu 27/07/2026

Thực hiện theo `docs/BAO_CAO_AUDIT_UIUX_2026-07-27.md`, phạm vi đã duyệt: **làm toàn bộ danh sách, riêng M-2 giữ dialog bánh răng như hiện tại** (không gom lề giấy inline). Mỗi chỗ sửa có comment `// UIUX (audit 2026-07-27 §mã)` trong code để truy vết/revert lẻ.

Baseline trước khi sửa (đo trên máy này, 27/07): `npx tsc --noEmit` sạch; `npx vitest run` = **3 test đỏ SẴN CÓ** không liên quan UI (`goldenMaster`, `regression`, `foldPrintOutward` — đều thuộc auto_bottom/dieline, nằm trong WIP chưa commit của bạn). Các lô UI/UX không được làm tăng con số này.

---

## LÔ 1 — NỀN: design tokens, font self-host, theme 1 nguồn, giảm-động, helper lỗi

**Trạng thái:** ĐÃ SỬA, `tsc --noEmit` sạch + `vite build` sạch. CHỜ BẠN bấm thử.

### File & thay đổi

| File | Thay đổi | Mã audit |
|---|---|---|
| `src/index.css` | (1) Bỏ `@import` Google Fonts CDN → import `./assets/fonts/inter.css` self-host. (2) Thêm khối **design tokens cấp app**: `--app-chrome/bg-0..3/text-1..3/line/accent/success/warning/danger/radius-sm..xl/motion-*` cho cả `:root` (light) lẫn `.dark`, phơi thành utility Tailwind qua `@theme inline` (`bg-app-0..3`, `text-app-1..3`, `border-app-line`, `rounded-app-*`…). (3) Utility `num` = tabular-nums cho mọi số đo. (4) Gradient tím-hồng glassmorphism (`--gradient-primary`, upload-zone hover/has-file, shadow btn-primary) quy về accent indigo + success; bỏ 2 lớp radial-gradient tím trên `body` (vốn bị shell che kín). (5) Radius glassmorphism 14/16/20/24px → thang token 8/16px. (6) Cuối file: `@media (prefers-reduced-motion: reduce)` + class `html.perf-low` tắt animation/transition/backdrop-blur (dùng 0.01ms thay 0s để `transitionend` vẫn bắn). | A-05, A-03, A-07, A-14, A-02, A-15 |
| `src/assets/fonts/inter.css` + `inter-{vietnamese,latin,latin-ext}.woff2` (MỚI) | Inter self-host. Phát hiện khi kiểm build: Google phục vụ Inter dạng **variable font** — 6 file weight mỗi subset trùng md5 → chỉ nhúng 3 file (~140KB) khai báo `font-weight: 300 800`, thay vì 18 file trùng nội dung. | A-05 |
| `src/hooks/useTheme.ts` | `useState` cục bộ → **zustand store** (`useThemeStore`), API `useTheme()` giữ nguyên chữ ký nên mọi nơi gọi cũ không đổi. Hết cảnh TitleBar và menu View là 2 bản sao lệch nhau (check ✓ "Giao diện Tối" hiển thị sai). Vẫn đồng bộ `localStorage.theme`; bọc try/catch khi localStorage bị chặn. | A-01 |
| `src/lib/appearanceBootstrap.ts` (MỚI) | Chạy TRƯỚC React render: (1) gắn class `light|dark` lên `<html>` ngay frame đầu — hết nháy trắng khi mở app ở dark mode; (2) dò máy yếu (`hardwareConcurrency ≤ 4` hoặc `deviceMemory ≤ 4GB`) → gắn class `perf-low` để CSS tự giảm hiệu ứng, máy mạnh giữ nguyên. | A-09, A-15 |
| `src/main.tsx` | Gọi `bootstrapAppearance()` ngay sau import, trước `Sentry.init`. | A-01, A-09 |
| `src/components/SplashScreen.css` | Thêm bộ rule `.dark .prynx-intro…` (nền `#1a1a1a`, đảo màu nét vẽ logo/chữ/spinner — tên class bám đúng markup thật: `draw-path-gray/dark`, `fill-gray/dark`, `__letter`, `__slogan`, `__status`, `__spinner`). Splash không còn là mảng trắng chói trong phòng tối. | A-09 |
| `src/lib/errorMessages.ts` (MỚI) | Helper `describeError/formatError/isCanceled`: phân loại lỗi (network/canceled/permission/notfound/busy/server) → câu tiếng Việt + hướng khắc phục; cắt gọn HTML/traceback backend trước khi hiện. `Failed to fetch` → "không kết nối được với bộ xử lý của PrynX + cách xử lý". Lô sau sẽ nối vào các handler (D-13/D-15). | D-13, D-15 |
| `parsecheck.mjs` (MỚI, thư mục desktop/ — công cụ dev) | Script kiểm cú pháp nhanh từng file qua oxc của Vite, dùng trong các lô sau; không import vào app. Xóa được sau khi xong đợt sửa nếu bạn muốn. | — |

### MD5

```
af1c47dd12e1ea64e832ce45e48f343e  src/index.css
be756f0da9dc9d716fced323ee2db380  src/components/SplashScreen.css
ae18735208b6872cb9398a8e88b60396  src/hooks/useTheme.ts
79d647b3193e51f9eabcfce4ecd451d0  src/main.tsx
02ebc76e20aefb7d72bb204012fb7577  src/lib/appearanceBootstrap.ts
f3d261953149145ce1c424cd967d4151  src/lib/errorMessages.ts
584f4f0612881035088df4a24d69f08f  src/assets/fonts/inter.css
9df17551da76cba6ee2d5d35fc762ed9  src/assets/fonts/inter-vietnamese.woff2
260c81a4759baf163c025001c4f27872  src/assets/fonts/inter-latin.woff2
1ad231aac0a8a891b8374aa5526a5813  src/assets/fonts/inter-latin-ext.woff2
```

### Checklist bấm thử trên app (Lô 1)

1. **Ngắt mạng (rút cáp/tắt Wi-Fi) rồi mở app** → chữ vẫn là Inter (so chiều rộng menu với lúc có mạng — không được xê dịch).
2. Đang **dark mode, đóng app mở lại** → splash phải nền TỐI ngay từ frame đầu, không còn chớp trắng.
3. Bấm nút mặt trăng/mặt trời trên **titlebar**, rồi mở menu **View** → dấu ✓ ở "Giao diện Tối" phải khớp trạng thái thật; bấm mục menu đó đổi theme đúng 1 nấc.
4. Màn Home + hộp upload: hover vùng kéo-thả phải ánh **xanh indigo** (không còn tím-hồng); thả file vào → viền chuyển xanh lá.
5. Windows Settings → Accessibility → bật "Animation effects" OFF (`prefers-reduced-motion`) → mở app: mọi animation/transition phải gần như tắt.
6. Nhìn tổng thể light + dark xem có vùng nào vỡ màu/nền lạ so với trước (đặc biệt SettingsModal, ProgressTracker — 2 màn còn dùng glassmorphism).

---

## LÔ 2 — TOÀN BỘ PHẦN CÒN LẠI (quy trình mới: làm hết một mạch, M-2 giữ dialog bánh răng)

**Trạng thái:** ĐÃ SỬA + ĐÃ QUA VÒNG XÁC MINH ĐỐI KHÁNG + ĐÃ SỬA HẾT LỖI VÒNG XÁC MINH. `tsc --noEmit` sạch, `vite build` sạch, `vitest` = đúng 3 test đỏ baseline (dieline auto_bottom, có sẵn trước đợt này — không regression). **49 file** thay đổi (5 file mới). CHỜ BẠN bấm thử theo checklist cuối.

**Quy trình thực tế:** 9 agent sửa song song theo cụm file rời nhau → 7 agent reviewer đối kháng đọc diff từng cụm (tìm kịch bản fail cụ thể) → phát hiện **17 lỗi thật (7 MAJOR)** → 4 agent sửa + tay. Tổng ~2,3M token subagent.

### Các mục đã áp (theo mã audit)

**Nhóm 1-2 (thị giác/layout):** A-02 (gradient tím-hồng → accent indigo, glassmorphism giữ nhưng quy màu), A-03 (token hóa hotspot: SaveModal 25 hex→0, MenuBar, ViewerContextMenu, AboutModal, shell App), A-04 (CropIcon lucide → ✂️ đồng bộ dàn emoji), A-06 (lăn chuột cuộn ngang thanh tab), A-07 (radius về thang 4/8/12/16), A-08 (z-index ngữ nghĩa: modal/confirm; **TitleBar hạ 9999→900** để modal phủ được titlebar — hành vi modal đúng chuẩn), A-10 (icon maximize đổi theo trạng thái + guard e.detail>1 cho startDragging; **onDoubleClick tự chế đã GỠ** — vùng drag có `data-tauri-drag-region` nên Tauri v2 tự toggle, handler trùng gây double-toggle), A-11/B-25 (resizer hit-area 10px, vạch nhìn 1px), A-12 (menu Tệp/Sửa/Xem/Công cụ/Cửa sổ/Trợ giúp — song ngữ đủ), A-13 (xóa App.css rác), A-14 (class `num` tabular cho số).

**Nhóm 3 (form bình):** B-02 (suffix mm toàn bộ input số đo), B-03 (suffix "Hở tem" cố định mm — hết nhãn sai 10×/25.4×), B-04 (min/clamp + lỗi inline PaperSettingsUI: khổ <10mm chặn Áp dụng), B-06 (Enter snap tay sách + toast báo làm tròn), B-07 (**tách Hở ngang/Hở dọc** — 2 ô độc lập), B-08 (BLEED→"Tràn lề (Bleed)", decode escape, i18n), B-09 (Enter trong ô SL chạy Bình — có guard isProcessing/!pdfFile ở handleExecute), B-10 (label "(0 = tự lấp đầy tờ)"), B-15 (chú thích dao cắt reset mỗi phiên), B-17 (ⓘ div→button), B-24 (nút mắt/bánh răng nới cỡ).

**Nhóm 6-7 (viewer/điều hướng):** M-1 (**StatusBar đáy viewer**: Trang n/tổng · W×H theo đơn vị + đúng pageOrder/rotation · Zoom% · X/Y chuột theo mm — clear khi rời trang · click đổi đơn vị), C-01 (pan chuột giữa + cleanup blur/unmount + **guard e.button cho mọi handler LivePageFrame** — không còn marquee/đặt-object nhầm bằng chuột giữa), C-02 (3 nút Fit ngang/Fit trang/1:1 trên toolbar, active accent), C-04 (chuột phải thước đổi đơn vị + nhãn đơn vị ô góc), C-06 (nhãn "Bleed X mm" trên overlay), C-07 (R không chọn trang → toast hướng dẫn, throttle 3s), C-08 (7 thao tác ẩn vào màn phím tắt — key slug đủ vi/en), C-09 (focus-ring toàn cục `:focus-visible`, loại trừ tabindex=-1), C-10 (caret zoom 16→24px + title; LayerPanel thêm tooltip), C-11 (badge "+Sao chép" tại điểm thả), C-12 (hint chọn nhiều — giữ chiều cao cố định không nhảy layout), C-14 ("RENDERING"→"ĐANG DỰNG HÌNH"), C-16 (dòng "Đang ưu tiên trang chính..."), C-17 (zoom nhận thập phân + clamp 1–6400), C-18 (title i18n + toast khi xóa DIM), C-19 (nút −/+ cỡ thumbnail), B-11 (**nút ‹ Quay lại cho MỌI tool**), B-13/B-21 (focus vào panel khi đổi tool), B-14 (tooltip nút toggle panel), B-19 (RichSelect: mũi tên/Enter/Esc — Esc không rò lên dialog cha), B-20 (DialogKeys: Esc/Enter chuẩn cho 3 dialog + stack chỉ-dialog-trên-cùng).

**Nhóm 4-5 (phản hồi/lỗi):** M-3 (ProgressBar dùng chung % thật + Hủy-thật; miễn trừ reduced-motion để không "trông như treo"), D-07 (3 tool VDP có progress bar %), D-10 (mojibake `Kh?ng th?...` — sạch), D-11 (toast "Đã lưu N file in" + nút **Mở thư mục**), D-12 (ProgressTracker i18n + icon lucide), D-13 (toàn bộ message Anh → Việt qua i18n, đủ bản EN), D-15 (formatError: backend chết → câu Việt + hướng khắc phục; **heuristic đã siết sau verify** — mã HTTP chỉ khớp khi có ngữ cảnh, không nuốt detail: nối dòng "Chi tiết: <raw>"), D-16 (chuỗi tiến trình api.ts qua i18n), B-05 (GridPreview lỗi quá khổ + gợi ý sửa), B-22 (nút Bình disabled khi chưa có file + tooltip), B-23 (lỗi bình qua formatError, bỏ double-format), D-04 (đổi nguồn VDP mất mapping → toast liệt kê cột thiếu), D-06 (window.confirm → confirmDialog; batch gom 1 hộp thoại; **chặn phím rò sau lưng dialog** ở capture-phase), D-14 (font fail → toast báo dùng font thay thế; Pont catch ghi chú nuốt-chủ-đích).

**Nhóm 3/6 VDP:** M-4/D-01 (ô X/Y/W/H mm cho MỌI field kể cả text — đúng hệ ×0.75), D-02 (nudge mũi tên 0.5mm/Shift 5mm + **kẹp biên trang**), D-05 (i18n), D-20 (giữ tên field user đặt, nhưng **ép unique** — tên trùng/auto Truong_N → SlotN, vì tên là key của data matrix), D-17 (highlight kéo-thả Home qua **sự kiện native Tauri onDragDropEvent** — DOM drag bị Tauri nuốt trong app đóng gói), D-18 (CombineTab click-to-browse + hint kéo-thả), D-19 (Enter modal New Document không bắn từ SELECT/BUTTON).

**i18n:** 103 key mới thêm vào `vi.json` + `en.json` (đủ bản dịch EN, format CRLF/indent giữ nguyên — kiểm diff chỉ thêm dòng). Không còn key thiếu (scan tự động = 0).

### 17 lỗi vòng xác minh đối kháng (đã sửa hết)

MAJOR: (1) NumberingTool mất unique tên field → 2 ô in cùng số; (2) errorMessages heuristic khớp nhầm "550mm"/"500 tờ" thành mã lỗi + nuốt detail + double-format; (3) DialogKeys nhiều tab mounted → Enter bắn 2 dialog; (4) Enter ô SL bypass disabled → double-run job; (5) middle-pan kích hoạt marquee/đặt-object của LivePageFrame; (6) AboutModal z thua TitleBar → bấm xuyên modal; (7) HomeTab drag highlight chết trong app Tauri thật + onDoubleClick trùng built-in. MINOR: pan kẹt khi Alt+Tab, right-click thước tạo guide ma, StatusBar sai dims khi đảo trang/xoay, X/Y đông cứng, hint thumbnail nhảy layout 24px phá double-click, RichSelect Enter cướp option đang focus, hover xanh dương sót SaveModal, "Không đóng được tab"→"ứng dụng", focus-ring bao nguyên panel, ProgressBar tĩnh như treo trên máy yếu, Enter nút Hủy vẫn tạo tài liệu, thiếu key i18n (103 key), B-12 rút lại (dead code — menu/tool loại trừ nhau, mini-toolbar đã có highlight).

### Chưa làm (ghi để khỏi trôi)
D-03 (hệ đơn vị CSS-mm — logic), D-08/D-09 phần cancel/% backend, snap-to-guide VDP đầy đủ (mới có nudge), C-13 scrollSeek Virtuoso, C-15 cap 1000 thumbnail (chờ virtualization perf §4.11), M-2 gom lề inline (bạn chọn giữ bánh răng), B-16/A-04 chuẩn hóa control/icon diện rộng (làm dần), badge hover mm cũ vẫn dùng key trang gốc (StatusBar đã đúng).

### MD5 (49 file, tính từ `desktop/src/`)

```
945ef520921507fc1fd8d866ab4db937  App.tsx
581703892762c4a3642cf1d7d972e400  components/AboutModal.tsx
e6160a2e0e3a950ce4517f5dd392c0d0  components/AcrobatViewer.tsx
f3f89f53a6cd742afc33de6b9ae7c950  components/CombineTab.tsx
f615c81a994ebb98b9db1205da109e65  components/CompareTab.tsx
cb05525f7995a004b547151d4bbcc66d  components/HomeTab.tsx
fe4f94c79816a002abcec1aae96833f0  components/ImpositionTab.tsx
282feaa73cf1950957d19de87eee73f3  components/MenuBar.tsx
bd64a08416efda1652d22f8464ee54b4  components/NewDocumentModal.tsx
6dd959456fde97c7d591736ee4206665  components/ProgressTracker.tsx
ef47a1db1cad8209a76588fbbb943c05  components/RecentFiles/RecentFilesGrid.tsx
7f27818a3f8e91c42a87e6331be01b54  components/acrobat/AcrobatToolbar.tsx
467330e62a12d5768cda53e2b8c8e8fb  components/acrobat/DimensionLayer.tsx
d3ef37fc48b3770dfea71f4a28ebd19c  components/acrobat/LayerPanel.tsx
c4f8d203473cc4667107b09f57375fbe  components/acrobat/Ruler.tsx
8d6a24fdf05c07ef0f926f76f293cbd0  components/acrobat/StatusBar.tsx (MỚI)
b2833d2562323042127ea8ef7ed9949b  components/acrobat/ThumbSidebar.tsx
85b8492dd1c1511e110dd7c1bfb557a8  components/acrobat/ViewerContextMenu.tsx
2eff6e4a0f2e91874d677f45eaa7835c  components/imposition-tools/ImposerDashboard.tsx
6eb1d5b626e1e2ab4b3e6530b877944b  components/imposition-tools/PaperSettingsUI.tsx
1a4657f1e6d7a3d2f63fc4475e7a13d3  components/imposition-tools/PontSettingsDialog.tsx
7b528a7b24515ba887c3504411a1bb94  components/imposition-tools/SharedUI.tsx
fb053cb502155a29cd1a7a5a3385fcaf  components/imposition-tools/ToolMenuList.tsx
67ccc180b83e664cd3031e3eb8db1da4  components/imposition-tools/cut-export/CutExportModal.tsx
a12191d6673039e2a8dd80f0c444f4ca  components/imposition-tools/sections/AdvancedSettingsSection.tsx
53435b9f59b7117dfa36bb6703848c53  components/imposition-tools/sections/BookletSettingsSection.tsx
7902411f05aa19876b8fe68b20c0383d  components/imposition-tools/sections/GridPreview.tsx
38a4c8ec9149bf5c0715cd3d6223b58f  components/imposition-tools/sections/GridSettingsSection.tsx
b108e0f03bdb42f5fe6f51c94e49be75  components/preprocess-tools/CoverNumberingTool.tsx
489d0fbc67947bd50fa12e0855e7856c  components/preprocess-tools/DataMergeTool.tsx
b0a48125ee2cb713a39c32a88f3af873  components/preprocess-tools/NumberingTool.tsx
d206e592b8a12e71461cad392e76f891  components/preprocess-tools/StickTextNumberTool.tsx
7523374126c0e8a0ae42235d46782262  components/ui/DialogKeys.tsx (MỚI)
bd84c5be6dd6d29806c94dd3f89b2e3f  components/ui/ProgressBar.tsx (MỚI)
bb9f592b648339f5678e5b1d885d53b5  components/ui/Toast.tsx
5201d8f1f08674fee8c42d269eeb1b17  components/ui/confirmDialog.tsx
8196f3bf436c8b1724fc0dab1ad0cd06  components/workspace/LivePageFrame.tsx
15e2103d38dd7faf1c55662b5e7338c1  components/workspace/SaveModal.tsx
a6e755e0ada9330fdf4faac3b11eb0d6  hooks/useVdpTool.ts
9fded0e4f6709939df5d096658273091  hooks/viewer/useViewerHotkeys.ts
68a646c871d4d2adc258ba7554696e6e  i18n/locales/en.json
2b7d9358e512a74f5441b06c0c2fd7b3  i18n/locales/vi.json
39db57d5d40fd9cbe4f6080730c909c2  index.css
9f74f3d958d179839d466ebed76a8c11  lib/api.ts
8135477f944de250e012e29bc0957923  lib/combineAssembly.ts
fab4f1609651fa8e68db69c0f2bd29ec  lib/errorMessages.ts (MỚI ở Lô 1, sửa tiếp)
bda821c9191c0f6e6c3685e1eb13a52c  lib/keyboardShortcuts.ts
d135456c416425ca98a86e12858e5b4d  lib/processHandlers.ts
56e9436b42940a096674c067bbe9a9c3  lib/toolRegistry.ts
```
(+ Lô 1: main.tsx, useTheme.ts, appearanceBootstrap.ts, SplashScreen.css, assets/fonts/* — md5 ở phần Lô 1; App.css đã XÓA; `desktop/parsecheck.mjs` là tool dev, xóa được.)

### Chỉnh theo feedback sau khi bạn xem app

- Header panel phải: **bỏ nhãn "🛠️ THÔNG SỐ"** (feedback: rối) — giữ nút ‹ Quay lại + chip dung lượng file. `ImpositionTab.tsx` md5 mới: `406065962a32647d3bdcc0f5a5c368a9`. tsc sạch.
- **Cụm 3 nút Fit trên toolbar "sao sao"** (feedback kèm ảnh): (1) màu active dùng accent tím giữa toolbar toàn tông xanh dương → đổi về `text-blue-600 bg-blue-50` như Pointer/Hand; (2) icon agent vẽ quá rối ở 18px → vẽ lại tối giản (fit-ngang = trang + mũi tên 2 đầu; fit-trang = trang trong 4 ngoặc góc; 1:1 = chữ thường như nút DIM); (3) thêm vạch ngăn cách với cụm zoom. `AcrobatToolbar.tsx` md5 `50dc9fe1534237bb10539ec439036566`.
- **Gỡ mục "Thu phóng (vừa màn hình)" khỏi dropdown Hiển thị** (feedback user): 2 lựa chọn fit trong menu là bản sao của 2 nút 1-click ngay cạnh — dropdown giờ thuần "Bố cục trang", phân vai sạch (nút rời = fit, dropdown = bố cục; Ctrl+0/2 giữ nguyên). `AcrobatToolbar.tsx` md5 `482a5572bc0e1e2519745b04cc4f01d2`.
- **User báo "bấm Vừa trọn trang → trang bị thước + cột thumbnail che mất bên trái"**: 2 lỗi cấu trúc ở khâu căn-giữa-sau-fit, bị nút fit 1-click mới kích hoạt (lệnh fit trước đây chôn trong menu nên ít lộ): (a) căn giữa theo TỔNG scrollWidth/Height — ở chế độ xem-một-trang, các trang đã ghé thăm vẫn mounted (ẩn, absolute) phình scrollWidth → trang active bị đẩy lệch trái; (b) ở chế độ cuộn dọc, `scrollTop = max/2` nhảy tới GIỮA tài liệu. Fix: (1) căn giữa theo ANCHOR trang đang xem (`#pdf-page-container-N`), thiếu anchor thì chỉ căn ngang, không đụng scrollTop; (2) hàng ẩn kẹp 0×0 + overflow hidden (vẫn mounted giữ ảnh decode, hết phình khung cuộn). Md5: `useViewerZoom.ts` `4334dbc5c5525cc86f8267c6c43bdf4c`, `AcrobatViewer.tsx` `1da3a74562638ef7869cfb39e27854cf`. 30 test viewer pass. **Cách thử:** mở file, lật qua 3-4 trang (tạo trang ghé thăm), zoom to, bấm Vừa trọn trang → trang phải nằm CHÍNH GIỮA khung, không chui dưới thước; lặp lại ở chế độ Cuộn trang dọc → không được nhảy trang.
- **User báo "bấm Vừa ngang / Vừa trọn trang không có gì thay đổi"**: dò hết đường dây (nút → applyFit* → setZoom → LivePageFrame displayWidth) — wiring ĐÚNG. Nguyên nhân: với tờ bình KHỔ NGANG, zoom vừa-ngang == vừa-trọn-trang (chiều ngang chạm giới hạn trước) và app đã auto-fit sẵn khi mở file (fitMode 'smart') → bấm là "đúng nhưng vô hình". Fix: khi zoom đích trùng zoom hiện tại (chênh <0.5%) → toast nhẹ "Trang đã vừa khít chiều ngang/trọn màn hình ở mức thu phóng hiện tại" (throttle 1.5s, áp cả dropdown Hiển thị + Ctrl+0/2 vì sửa tại `useViewerZoom.applyFit*`). 2 key i18n mới đủ vi+en. Md5: `useViewerZoom.ts` `e4e17a37feb110b7c1cd0397adc12dd0`, `vi.json` `1d7a4387396de7e48003b5a4a67d2ed0`, `en.json` `cf9c9225e80e4945490b2fdc5aa54196`. 30 test viewer pass. **Cách thử:** mở tờ bình khổ ngang → bấm 2 nút fit → thấy toast xác nhận; mở file A4 DỌC → bấm qua lại 2 nút phải thấy trang ĐỔI CỠ thật (fit-ngang to hơn fit-trang).
- **Bug user báo: D lần 2 không tắt DIM** — root cause là bộ gõ Telex (UniKey/EVKey) chạy toàn hệ thống: "dd" bị biến thành "đ", sự kiện D thứ hai tới browser dưới dạng phím tổng hợp `key='đ'` (code rỗng) nên binding `KeyD` không khớp; gõ thêm lần nữa Telex đã reset nên mới tắt được. Codebase vốn đã biết bệnh này (đã chống Backspace-giả của Telex cho xóa trang) nhưng chưa nhận 'đ' cho chính phím D. Fix vòng 1: thêm binding `{ key: 'đ', ignoreShift: true }` cho `viewer.dimension` (`keyboardShortcuts.ts` md5 `d9f895ced2f5bd45858315c822f60717`) — đủ cho UniKey (SendInput → có keydown 'đ').
- **Vòng 2 (user test: Vietkey vẫn phải ấn 3 lần):** Vietkey bắn 'đ' bằng WM_CHAR — KHÔNG có keydown nào để bắt. Fix bằng cơ chế **keyup bù** trong `useViewerHotkeys.ts` (md5 `88ddbbc6480de2b9cd6f23b40429f50c`): keydown KeyD thật đánh dấu cờ `dimPhysDownRef` → keyup tương ứng bỏ qua; keyup KeyD "mồ côi" (không có keydown vì bị bộ gõ nuốt) → toggle bù; toggle từ 'đ' (UniKey) trong 250ms trước đó cũng chặn keyup toggle đôi; blur cửa sổ reset cờ (Alt+Tab giữa lúc giữ phím). 14 test hotkeys pass, tsc sạch. **Cách thử:** bật Vietkey/UniKey Telex → D bật, D lần 2 phải tắt NGAY (thử cả gõ nhanh lẫn giữ phím lâu rồi nhả; và tắt bộ gõ thử lại — không được toggle đôi).

### CHECKLIST BẤM THỬ (ưu tiên theo rủi ro)

**Bình bài (quan trọng nhất):**
1. Bình tem: gõ SL rồi **Enter** → chạy Bình; Enter liên tục khi đang chạy → KHÔNG double-run. Chưa mở file → nút Bình mờ + tooltip.
2. Hàng "Hở ngang / Hở dọc" 2 ô độc lập — đặt lệch nhau (vd 3/5) → **preview và file xuất phải khớp nhau** (điểm cần soi kỹ nhất của B-07).
3. Mở tool bất kỳ → nút **‹ Quay lại** về danh sách công cụ; mở từ Home kiểu tem bế → KHÔNG bị bật về menu.
4. Dialog "Xác nhận Bình Sách": Enter=chạy, Esc=hủy, Tab tới nút Hủy rồi Enter=hủy. Mở 2 tab bình cùng lúc có dialog → phím chỉ ăn dialog trên cùng.
5. Khổ giấy tùy chỉnh nhập 5mm → Áp dụng bị chặn + dòng đỏ; sửa ≥10 → hết lỗi.

**Viewer:**
6. StatusBar đáy: Trang/kích thước/Zoom/X-Y; đảo thứ tự trang + xoay 90° → kích thước vẫn ĐÚNG; rời chuột khỏi trang → X/Y ẩn; click "mm" đổi cm/inch; chuột phải lên thước cũng đổi.
7. Chuột giữa kéo = pan (cả khi đang bật Edit object — KHÔNG được quét chọn/đặt object); Alt+Tab giữa lúc kéo → quay lại không bị kẹt pan.
8. 3 nút Fit mới trên toolbar; gõ zoom "62.5" Enter → 62.5%; "9999" → 6400%.
9. Nhấn R chưa chọn trang → toast hướng dẫn; thumbnail: nút −/+, hint chọn-nhiều không làm dải thumbnail nhảy khi click.

**VDP:**
10. Chọn field text → 4 ô X/Y/W/H mm; gõ X=10 → field đúng 10mm; mũi tên 0.5mm, Shift 5mm, không đẩy ra ngoài trang.
11. Chạy job → ProgressBar % thật + Hủy; đổi nguồn CSV thiếu cột → toast liệt kê.
12. NumberingTool: 2 slot, xóa 1, kéo thêm 1 → chạy nhảy số → 2 ô phải ra 2 số KHÁC nhau (bug MAJOR đã vá).

**Hệ thống:**
13. Tắt backend (kill PrynX sidecar trong Task Manager) → mọi thao tác báo câu Việt + hướng khắc phục, có dòng "Chi tiết:" khi lỗi backend thật; message chứa "550mm"/"500 tờ" KHÔNG bị đổi thành lỗi generic.
14. Help > Giới thiệu → modal phủ CẢ titlebar (không bấm xuyên được nút setting).
15. Double-click titlebar phóng to/thu về — chỉ toggle 1 lần, không nháy.
16. Đổi ngôn ngữ sang English → menu File/Edit…, toast lỗi, StatusBar đều tiếng Anh (103 key mới có đủ EN).
17. Kéo file từ Explorer lên dropzone Home (bản đóng gói) → viền accent sáng khi lơ lửng.
18. AutoSave file in xong → toast + nút "Mở thư mục" mở đúng thư mục.
