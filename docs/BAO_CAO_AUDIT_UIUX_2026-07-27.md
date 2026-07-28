# BÁO CÁO AUDIT UI/UX — PrynX Desktop

**Ngày:** 27/07/2026
**Phạm vi:** `desktop/src` (Tauri v2 + React 19 + TS). Ưu tiên theo yêu cầu: bình sách/tạp chí, bình cắt xén, bình tem bế, giao diện view + thumbnail, chuyển trạng thái menu công cụ phải, VDP.
**Ràng buộc đã chốt:** chỉ đánh bóng bảo thủ (không đổi layout), chuẩn hóa token cho CẢ dark + light, không đổi logic nghiệp vụ/API/format xuất.
**Phương pháp:** 4 nhánh audit tĩnh song song (shell+style / form bình / viewer+thumbnail / VDP+feedback+lỗi), mọi phát hiện chốt danh sách đều có bằng chứng `file:dòng`; các claim chủ chốt đã được xác minh chéo trực tiếp lần 2 trong code (đánh dấu ✔). **Chưa có screenshot màn hình thật** — các nhận định thuần thị giác (cân đối, mật độ) sẽ hiệu chỉnh khi bạn gửi ảnh; phát hiện dạng cấu trúc (thiếu control, sai đơn vị, message lỗi…) không phụ thuộc ảnh.
**Không trùng lặp:** các mục perf-UI đã nằm trong `docs/BAO_CAO_AUDIT_HIEU_NANG_2026-07-26.md` §4.x chỉ được tham chiếu, không báo lại (đĩa đang ở bản gốc — đã xác minh 0 comment `PERF (audit 2026-07 …)` trong `desktop/src`).

> Ký hiệu: P0 = cản trở công việc/gây hiểu sai sản xuất · P1 = ma sát lớn hằng ngày · P2 = đánh bóng · P3 = nice-to-have · (S/M/L) = công sức · ✔ = đã xác minh chéo 2 lần.

---

## 1. TÓM TẮT ĐIỀU HÀNH

Nền UI khá tốt ở phần "cơ": zoom neo đúng con trỏ, Ctrl+0/1/2 trùng chuẩn Acrobat, minimap thumbnail kéo-pan (hiếm app có), state form không mất khi chuyển tool (snapshot/restore profile + persist), hủy job VDP/N-Up là hủy thật phía backend, chống flash trắng khi zoom. Vấn đề tập trung ở **5 cụm hệ thống**:

**① Không có design tokens cấp app.** Chỉ 7 biến CSS glassmorphism cũ + bộ `--dt-*` rất tốt nhưng bị nhốt trong dieline-tool. Kết quả: 385 mã hex trong .tsx, 85 `bg-[#`, nền dark mỗi vùng một tông (`#1a1a1a` / `#323639` / `#2d3236` / `#1e1e1e` / `#252525`), radius chạy 4→32px, 2 ngôn ngữ thiết kế (glassmorphism tím-hồng vs flat slate/indigo) sống chung. Đây là gốc của phần lớn lỗi nhất quán — sửa lẻ tẻ sẽ vô ích nếu không dựng token trước.

**② Form tham số chưa "thuận tay nghề".** Bộ khổ giấy–lề–bleed bị xé 3 nơi (form / dialog bánh răng / accordion đóng); đa số input số thiếu suffix mm, riêng "Hở tem" còn gắn **sai suffix** theo đơn vị app trong khi giá trị luôn là mm (nguy cơ hiểu sai 10×/25.4×); nhập âm/0/quá khổ được nhận im lặng; Enter không chạy lệnh Bình; dao cắt bị reset ngầm mỗi lần vào tool không một lời báo.

**③ Điều hướng tool phải có "cửa vào không cửa ra".** Chọn 1 trong 4 tool bình xong là không còn đường quay lại danh sách công cụ (nút Quay lại chỉ render cho bgremover/upscale ✔); ToolMenuList không đánh dấu tool active; không phím tắt chuyển tool; focus không được quản lý.

**④ Phản hồi tác vụ & lỗi không đồng đều.** Compare có % thật nhưng không hủy được; VDP hủy được nhưng chỉ có dòng text thay vì progress bar; Shuffle/Resize/Split/Merge là spinner tĩnh không % không hủy; xong việc không toast/không "Mở thư mục". Message lỗi: ~8 chuỗi tiếng Anh thô, 2 chuỗi **mojibake** (`Kh?ng th? h?y job VDP` ✔), 19 catch nuốt lỗi im lặng, backend chết thì user thấy `Failed to fetch`.

**⑤ Viewer thiếu lớp "đọc số" của phần mềm chế bản.** Không status bar; kích thước trang mm chỉ hiện khi hover đúng vùng vô hình ✔; thước không readout tọa độ mm, không nhãn đơn vị; Fit width/page chôn 2 cấp trong dropdown ✔; overlay bleed đỏ không chú giải; font Inter tải từ Google Fonts CDN — xưởng in offline là rớt font toàn app ✔.

Tổng: **58 phát hiện** (0 × P0, 17 × P1, 27 × P2, 14 × P3). Không có P0 — không gì làm sai file sản xuất; nhưng cụm P1 chạm đúng các thao tác lặp lại nhiều giờ mỗi ngày.

---

## 2. GIAI ĐOẠN 1 — BẢN ĐỒ UI (tóm tắt)

### 2.1 Shell & hệ tab
- MDI kiểu Acrobat: `App.tsx` (1440 dòng) → TitleBar tự vẽ (frameless) → MenuBar (tắt/bật được) → thanh tab (min 34px) → viewport. Tab types: `home` + 11 `AppToolId`; ~30 entry TOOL_REGISTRY đa số dồn vào tab `imposition` phân biệt bằng `focusFeature`/`lockedMode`.
- Cửa sổ: 1400×900, min 900×600, không max; `decorations:false, transparent:true` → mọi hành vi titlebar là tự chế.
- `ImpositionTab.tsx` (2922 dòng) là host của: 4 tool bình + toàn bộ preprocess/VDP + viewer + panel phải 2 cột (Config kéo được + mini toolbar 48px).
- Viewer: `AcrobatViewer` (1565 dòng) → AcrobatToolbar / ThumbSidebar / Virtuoso→LivePageFrame (3767 dòng) / Ruler+Guide+Dimension / ContextMenu.

### 2.2 Hệ style
- **Tailwind v4** (config-in-CSS, KHÔNG có block `@theme` token riêng) + `index.css` (471 dòng, 7 biến glassmorphism cũ + thang z-index ngữ nghĩa gần như không ai dùng) + `dieline-tool.css` (bộ token `--dt-*` đầy đủ, có `.dark` override — **hình mẫu nên nhân rộng**) + `App.css` là rác template Vite không được import ✔.
- Theme: class-based `dark`, light là base thật (dùng được, không phải nút chết); NHƯNG `useTheme` là `useState` cục bộ → 2 instance (TitleBar vs menu View) lệch nhau ✔.
- Font: Inter qua Google Fonts CDN ✔, splash lại là Segoe UI; không quy ước mono/tabular-nums thống nhất cho số liệu.
- i18n: song ngữ vi/en, vi là source-of-truth; còn nhiều chuỗi hardcode ngoài `t()` (menu bar 'File/Edit/View…', progress trong api.ts, placeholder…).

### 2.3 User flow (đếm từ code)

**Bình sách/tạp chí:** ~5–7 click, **0 trường bắt buộc** (mọi settings persist; bleed còn auto-điền từ TrimBox). Điểm nghẽn duy nhất: Bleed/Creep nằm trong accordion "Thiết lập mở rộng" đóng mặc định.

**Bình tem bế:** ~5–8 click + gõ SL từng loại (đúng chủ đích — SL theo đơn hàng, không persist). Điểm nghẽn: dao cắt reset ngầm mỗi lần vào tool; khổ giấy tiêm vào giữa form.

**VDP merge:** ~8–9 click + 1 drag cho 1 field; mỗi field thêm ~3 thao tác. Điểm nghẽn: không nhập được X/Y bằng số, không snap, đổi nguồn dữ liệu mất mapping im lặng; batch n file = n hộp `window.confirm` chặn màn.

---

## 3. BẢNG PHÁT HIỆN THEO 10 NHÓM

Mã giữ nguyên theo nhánh audit (A=shell/style, B=bình bài, C=viewer/thumbnail, D=VDP/feedback/lỗi) để truy vết. Bằng chứng nguyên văn nằm ở mô tả từng dòng.

### Nhóm 1 — Nhất quán thị giác

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| A-03 | Không token màu cấp app: 385 hex trong .tsx, 85 `bg-[#`; nền dark 5 tông khác nhau tùy vùng; accent lệch (indigo vs cobalt `#0f52ba` vs blue-500 vs amber) | App.tsx:59,1095 · AcrobatViewer.tsx:1354 · MenuBar.tsx:93 · ViewerContextMenu.tsx:151 · SaveModal.tsx:34,47 | **P1** | L (nền tảng) |
| A-02 | 2 ngôn ngữ thiết kế sống chung: glassmorphism tím-hồng (`--gradient-primary` #a855f7→#ec4899, `.glass-card` blur 24px) vẫn dùng thật ở SettingsModal/ProgressTracker/PDFUploader/Button primary, vs flat slate/indigo ở shell/viewer | index.css:28,144,162 · Button.tsx:10 · SettingsModal.tsx:47 · PDFUploader.tsx:145 | P2 | M |
| A-04 | Icon trộn 3 hệ: emoji màu (TOOL_REGISTRY) + lucide + SVG vẽ tay; 1 icon lucide lọt giữa dàn emoji; emoji render lệch theo bản Windows/DPI | toolRegistry.ts:90,107,124 · App.tsx:31,91 · ThemeToggle.tsx:15 | P2 | M |
| A-07 | Border-radius vô tổ chức 4→32px cùng cấp component (modal 4px cạnh modal 12–20px, dropzone 32px) | HomeTab.tsx:315 · index.css:137,144,164,207 · SaveModal.tsx:31 | P2 | M |
| A-01 ✔ | Theme desync: `useTheme` là useState cục bộ, TitleBar và menu View là 2 instance — check ✓ "Giao diện Tối" hiển thị sai sau khi toggle ở titlebar | useTheme.ts:6 · App.tsx:235,1046 · ThemeToggle.tsx:6 | **P1** | S |
| A-05 ✔ | Font Inter tải Google Fonts CDN — máy xưởng in offline rơi về Segoe UI, layout xê dịch, 2 máy cùng xưởng nhìn khác nhau; splash lại chỉ định thẳng Segoe UI | index.css:1 · SplashScreen.css:14 | **P1** | S |
| A-14 | Không quy ước font số liệu: `tabular-nums` và `font-mono` (Consolas) dùng lẫn ở 24 file — số đo mm nhảy độ rộng giữa các vùng | MenuBar.tsx:137 vs AboutModal/AcrobatToolbar/ThumbSidebar | P3 | S |
| A-08 | Thang z-index ngữ nghĩa đã có (index.css:21–25) nhưng gần như không dùng — z số tay 60/100/200/9999 rải rác, nguy cơ đè nhau | App.tsx:59,1316 · AboutModal.tsx:127 · AcrobatModals.tsx:38 · MenuBar.tsx:93 | P2 | S |
| A-09 | Splash nền sáng cứng `#f5f5f7` không có `.dark` — user dark mode bị nháy trắng 3s mỗi lần mở (phòng chế bản ánh sáng yếu) | SplashScreen.css:13 | P2 | S |
| A-13 | App.css rác template Vite không được import; file `*_old.tsx` trong repo gây nhiễu audit style | src/App.css · temp_old.tsx… | P3 | S |
| B-16 | Cùng loại control ≥3 kiểu UI: RichSelect custom vs `<select>` native vs PaperSizeSelect listbox; checkbox 4 kiểu (custom, native rounded, accent-indigo, accent-emerald) | BookletSettingsSection.tsx:50,94 · GridSettingsSection.tsx:251 · PaperSettingsUI.tsx:164 · AdvancedSettingsSection.tsx:709 | P2 | M |
| B-08 | Thuật ngữ không nhất quán + chuỗi ngoài i18n: `BLEED` vs "Lề xén (Bleed)"; "Xếp chồng" và "Cắt đôi ráp xấp" cùng value `cut_stacks` 2 tên; label/placeholder hardcode | GridSettingsSection.tsx:588,697 · AdvancedSettingsSection.tsx:14,279,314,1189 · ImposerDashboard.tsx:77 | P2 | S |
| A-12 | Menu bar 'File/Edit/View/Tools/Window/Help' tiếng Anh cứng giữa UI Việt, không qua t() | App.tsx:990,1020,1031,1050,1066,1076 | P3 | S |

### Nhóm 2 — Layout & phân cấp thông tin

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| A-06 | Thanh tab giấu scrollbar nhưng không có cơ chế cuộn thay thế cho chuột (không onWheel ngang, không nút ◀▶) — mở nhiều file là mất tab khuất | App.tsx:1109 | **P1** | S |
| C-05 ✔ | Không status bar viewer; kích thước trang (mm) chỉ hiện khi hover vùng vô hình 160×96px góc dưới-trái | AcrobatViewer.tsx:1470–1471 | **P1** | M |
| A-11 | Tay nắm resize panel Home chỉ 4px (hover 6px) — khó trúng trên 4K | HomeTab.tsx:362 | P2 | S |
| B-25 | Resizer panel bình 6px, cùng bệnh (khía cạnh perf drag: perf §4.3) | ImpositionTab.tsx:2448 | P2 | S |
| A-10 | Nút maximize không đổi icon theo trạng thái restore; double-click titlebar phóng to nghi không hoạt động (vùng drag native bị tắt qua additionalBrowserArgs) — *cần xác nhận trên app* | App.tsx:121,62–66 · tauri.conf.json | P2 | S |

### Nhóm 3 — Form tham số

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| B-01 | Bộ khổ giấy–lề–bleed xé 3 nơi: khổ giấy tiêm giữa form N-Up, lề trong dialog bánh răng, bleed booklet trong accordion đóng mặc định — thợ phải nhảy 3 chỗ | GridSettingsSection.tsx:670 · ImposerDashboard.tsx:1249 · AdvancedSettingsSection.tsx:144,1176 | **P1** | M |
| B-02 | Đa số input số thiếu suffix mm (Bleed cả 2 nơi, 4 ô lề, W/H khổ giấy, gapX/Y booklet, lề gáy) — có nơi làm đúng (Hở tem, KC cụm phụ) chứng tỏ chuẩn có nhưng áp không đều | GridSettingsSection.tsx:591 · AdvancedSettingsSection.tsx:1202 · PaperSettingsUI.tsx:202 · BookletSettingsSection.tsx:232 | **P1** | S |
| B-03 ✔ | Suffix "Hở tem" hiển thị theo `measurementUnit` app (mm/cm/inch) nhưng giá trị luôn là mm — đặt app = cm/inch là nhãn sai 10×/25.4× | GridSettingsSection.tsx:49,580 | **P1** | S |
| B-04 | Nhập âm/0/quá khổ nhận im lặng: bleed/gap không min, khổ giấy 0×0 + lề âm Apply thẳng — trong khi SL và Số cọc có clamp chuẩn | GridSettingsSection.tsx:568,592 · PaperSettingsUI.tsx:206–300 | P2 | S |
| B-07 | Một ô "Hở tem" ghi đè ngầm cả gapX lẫn gapY (N-Up) trong khi booklet có 2 ô riêng — tem chữ nhật dài không đặt được hở ngang≠dọc | GridSettingsSection.tsx:571–574 vs BookletSettingsSection.tsx:231–237 | **P1** | S |
| B-09 | Enter không chạy lệnh Bình — nhập SL bằng phím xong phải với chuột | ImposerDashboard.tsx:1604 | P2 | S |
| B-06 | Tay sách chỉ snap bội số 4 khi blur, Enter không kích hoạt, sửa ngầm không báo | BookletSettingsSection.tsx:65–72 | P2 | S |
| B-15 | Dao cắt (`cutType/dieSizeMode/dieOffsetMm`) reset ngầm mỗi lần vào tem bế/CNC (chủ đích an toàn) nhưng KHÔNG có chỉ báo — user tưởng app quên cài đặt | ImposerDashboard.tsx:200–209 | P2 | S |
| B-10 | "SL trống = tự lấp đầy 1 tờ" chỉ nói trong placeholder dài, dễ tưởng bắt buộc | GridSettingsSection.tsx:688–701 | P3 | S |
| B-05 | Lỗi quá khổ chỉ báo gián tiếp qua preview, message chung chung/lẫn Anh, không trỏ field, không gợi ý sửa | GridPreview.tsx:1526,1535 | P2 | S |
| D-01 | VDP: không nhập được X/Y bằng số cho mọi field; field text không có cả W/H — chỉ kéo chuột, không đặt vị trí chính xác mm | DataMergeTool.tsx:1609 | **P1** | M |
| D-03 | VDP: 2 hệ đơn vị song song "CSS-mm" (×96/72) vs mm thật (×0.75 tại UI) — nguồn bug lệch kích thước tiềm tàng giữa tool | AcrobatViewer.tsx:314 · DataMergeTool.tsx:1611,1615 | P2 | L (chỉ ghi nhận — đụng logic, ngoài phạm vi đợt này) |
| D-19 | NewDocumentModal: Enter global — đang gõ tên tài liệu nhấn Enter là tạo luôn; nhãn hardcode lẫn i18n | NewDocumentModal.tsx:43,105,124 | P3 | S |
| D-20 | NumberingTool: effect tự đổi tên field SlotN ghi đè tên user đặt tay khó đoán | NumberingTool.tsx:115–127 | P3 | S |

### Nhóm 4 — Phản hồi tác vụ dài

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| D-08 | Compare: có % thật nhưng KHÔNG có nút Hủy, không endpoint cancel — timeout 10 phút chỉ clear timer client, backend vẫn chạy | CompareTab.tsx:165–178,391–415 | **P1** | M (nút + endpoint là việc backend — đợt này chỉ làm phần UI nếu backend có sẵn; nếu không: ghi nhận) |
| D-09 | Shuffle/Resize/TrimShift/Split/Merge: spinner text tĩnh, không %, không bước, không hủy — Resize file lớn chạy Ghostscript là treo vô định | processHandlers.ts:463,534 | **P1** | L (phần % cần backend; đợt này nâng UI: busy-state rõ, tên bước, chặn double-run) |
| D-07 | VDP: backend trả processed/total nhưng UI chỉ text nhỏ — không progress bar ở cả 3 tool VDP | api.ts:507 · DataMergeTool.tsx:2293 | P2 | S |
| D-11 | Xong việc autoSave chỉ đổi text nhỏ — không toast, không nút "Mở thư mục" | processHandlers.ts:218 | P2 | S–M |
| D-12 | ProgressTracker: "Trang x/y" hardcode VN giữa file đã i18n; emoji ✅/❌ thay icon | ProgressTracker.tsx:62 | P3 | S |

### Nhóm 5 — Thông báo lỗi

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| D-10 ✔ | Mojibake tiếng Việt: `'Kh?ng th? h?y job VDP'`, `'Kh?ng th? h?y job N-Up'` hiện nguyên `?` cho user | api.ts:490,553 | **P1** | S |
| D-13 | ~8 message lỗi tiếng Anh thô + leak raw body backend ra UI ("Min Error:", "Backend merge failed: " + res.text()) | App.tsx:102,115,636 · RecentFilesGrid.tsx:79 · api.ts:595–700 · CombineTab.tsx:1119,1186 | **P1** | M |
| D-15 | Backend/sidecar chết → user thấy `Failed to fetch` thô; không phân biệt lỗi thao tác vs lỗi hệ thống; chỉ 1 chỗ có fallback tử tế | processHandlers.ts:457 · OutputPreviewTab.tsx:317 | **P1** | M (đợt này: helper dịch lỗi mạng → message Việt + hướng khắc phục, áp vào các handler chính) |
| D-14 | 19 catch rỗng + nhiều catch chỉ console.error; nghiêm trọng nhất: StickTextNumberTool load font fail → âm thầm thay font rồi vẫn xuất file | StickTextNumberTool.tsx:104 · usePdfLoader.ts:316,408,425 | P2 | M (chỉ vá các catch chạm mặt user; catch nội bộ giữ nguyên) |
| B-23 | Lỗi backend hiển thị thô trong flow bình (`globalError` nguyên văn, `String(e)`) — đối chứng tốt đã có: lỗi 2-mặt-lẻ-trang có inline đỏ tại field + cách sửa → lấy làm chuẩn | ImposerDashboard.tsx:1613 · CutExportModal.tsx:124 · GridSettingsSection.tsx:654 | P2 | S |
| D-04 | VDP: đổi nguồn dữ liệu mất mapping im lặng — select cột về rỗng không cảnh báo | DataMergeTool.tsx:567–581,1580 | **P1** | S |
| D-06 | VDP dùng `window.confirm` native (không theme, batch n file = n popup chặn) thay confirmDialog dùng chung | DataMergeTool.tsx:911,1146 | P2 | S |
| D-16 | Chuỗi tiến trình hardcode VN trong api.ts bỏ qua i18n | api.ts:507–517 | P3 | S |
| B-22 | Vào workspace không file: nút "Bình" bấm được và chết im lặng (`if (!file) return`) — trong khi "Xem thành phẩm" có disabled đúng chuẩn | ImpositionTab.tsx:2205,1266 · ImposerDashboard.tsx:1598–1604 | P2 | S |

### Nhóm 6 — Viewer / preview 2D-3D

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| C-02 ✔ | Fit width / Fit page / 100% không có nút 1-click — chôn 2 cấp trong dropdown "Hiển thị"; đây là 2 lệnh dùng nhiều nhất của chế bản | AcrobatToolbar.tsx:247–263 | **P1** | S |
| C-03 | Thước không hiện tọa độ chuột dạng số mm, không nhãn đơn vị trên thước — chỉ vạch đỏ bám chuột | Ruler.tsx:240–257 | **P1** | M |
| C-01 | Không pan bằng chuột giữa (chuẩn PitStop/AI/CAD) — mọi handler `button !== 0` return | AcrobatViewer.tsx:1449 | P2 | S |
| C-04 | Đổi đơn vị thước phải vào Settings toàn cục — không right-click trên thước | Ruler.tsx:272 · SettingsModal.tsx:240 | P2 | S |
| C-06 | Overlay bleed viền đỏ 40% không chú giải/giá trị mm — user mới tưởng lỗi hiển thị; viewer chính không có nét CUT/CREASE (chỉ dieline-tool có, ngoài phạm vi ưu tiên đợt này) | LivePageFrame.tsx:2742–2752 | P2 | S |
| C-17 | Ô zoom lọc mất dấu thập phân ("12.5"→"125"), nhập ngoài 1–6400 bị nuốt im lặng | AcrobatToolbar.tsx:186,190 | P3 | S |
| C-18 | Nhãn DIM click là xóa luôn không xác nhận, title hardcode | DimensionLayer.tsx:35 | P3 | S |
| D-02 | VDP: kéo field không snap guide/field/tâm trang, không nudge mũi tên — dù app có hệ guide + thước | LivePageFrame.tsx:691–752 · useVdpTool.ts:42–53 | **P1** | L (snap đầy đủ = L; đợt này làm nudge mũi tên = S, snap để đợt sau) |
| D-05 | VDP preview record phải bấm "Xem" thủ công; chuỗi hardcode ngoài i18n | DataMergeTool.tsx:2144,2187,2204 | P2 | S |

### Nhóm 7 — Điều hướng & phím tắt

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| B-11 ✔ | Không có đường quay lại danh sách công cụ sau khi chọn tool bình — nút Quay lại chỉ render cho `bgremover\|upscale` | ImpositionTab.tsx:2471–2479 | **P1** | S |
| B-12 | ToolMenuList không đánh dấu tool đang active (prop `active` có sẵn trong ToolItem nhưng không truyền) | ToolMenuList.tsx:77–89,109–121 · SharedUI.tsx:119,134 | P2 | S |
| B-13 | Không phím tắt chuyển tool; sau chuyển tool focus không vào panel — thợ nhập nhanh phải cầm chuột | ImpositionTab.tsx (0 kết quả ctrlKey) | P2 | M |
| B-14 | Click icon tool đang active làm sập panel (1 nút 2 nghĩa, không tooltip báo) | ImpositionTab.tsx:2747–2748 | P3 | S |
| B-19 | RichSelect không keyboard: không Esc, không mũi tên; PaperSizeSelect có Esc nhưng không mũi tên — 2 dropdown custom 2 mức hỗ trợ | SharedUI.tsx:13–21 · PaperSizeSelect.tsx:82 | P2 | S |
| B-20 | Esc trong dialog xác nhận phụ thuộc focus mong manh (onKeyDown trên div); không Enter=OK; mẫu tốt đã có ở PresetSelector/ô chất liệu | ImpositionTab.tsx:2225,2853,2891 · AdvancedSettingsSection.tsx:511 | P2 | S |
| B-21 | Không autoFocus input đầu khi mở tool/panel | ImposerDashboard (0 autoFocus) | P3 | M |
| C-07 | Phím R xoay trang chết im lặng khi chưa chọn thumbnail — user tưởng phím hỏng | useViewerHotkeys.ts:155 | **P1** | S |
| C-08 | Nhiều thao tác ẩn không có trong màn phím tắt (Space-tap, Ctrl+wheel, Alt+kéo nhân bản, double-click thumb, marquee) | keyboardShortcuts.ts:27–172 · SettingsModal.tsx:299 | P2 | S |
| C-09 | 130 chỗ `outline-none` toàn repo, nhiều nút không có focus style thay thế; context menu không role=menu/arrow-key | AcrobatToolbar.tsx:211 · ViewerContextMenu.tsx | P2 | M |

### Nhóm 8 — Trạng thái rỗng / lần đầu dùng

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| D-17 | Home dropzone: bản web onDrop bị nuốt im lặng; không highlight khi kéo file vào (PDFUploader có `isDragging`, Home không) | HomeTab.tsx:273 | P2 | S |
| D-18 | CombineTab vùng trống: không click-to-browse, không onDrop, empty state chỉ nói "Bấm Add Files" | CombineTab.tsx:1094,1192–1202 | P2 | S |
| B-22 | (đã nêu nhóm 5) workspace trống mà panel bình đầy đủ, không hướng dẫn "hãy mở file" | ImpositionTab.tsx:2205 | P2 | S |
| C-16 | Thumbnail gate 700ms đầu: dải skeleton trắng không phân biệt "đang ưu tiên trang chính" | ThumbSidebar.tsx:244–261 | P3 | S |

### Nhóm 9 — Hiệu năng cảm nhận (phần chưa có trong báo cáo perf)

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| C-13 | Không có chỉ báo "Trang N/M" khi kéo scrollbar nhanh (Acrobat có bubble) — Virtuoso chưa cấu hình scrollSeek | AcrobatViewer.tsx:1500–1518 | P2 | M |
| C-14 | Skeleton trang hiện chữ "RENDERING" tiếng Anh hardcode (cơ chế chống flash trắng thì đã tốt) | LivePageFrame.tsx:2601 | P3 | S |
| A-15 | Không có lớp `prefers-reduced-motion` toàn app (chỉ 3 chỗ: 3D scene, splash, hero) — trái nguyên tắc dự án "máy yếu tự giảm hiệu ứng" | grep toàn src: 3 file | P2 | S |
| — | Các mục giật form/danh sách dài/tab nền: xem perf §4.1–§4.16 (không lặp) | — | — | — |

### Nhóm 10 — Khả năng tiếp cận

| Mã | Phát hiện | Bằng chứng | Ưu tiên | Effort |
|---|---|---|---|---|
| C-10 | Nút caret mở menu zoom rộng 16px, không title (chỉ aria-label → không tooltip hover); +2 nút LayerPanel cùng bệnh | AcrobatToolbar.tsx:210–216 · LayerPanel.tsx:56,116 | P2 | S |
| B-24 | Loạt nút chỉ-icon 20–28px (<32px): sao yêu thích còn opacity-0 tới khi hover, mắt bleed, mọi ⓘ, bánh răng dấu xén ~20px | SharedUI.tsx:146,156 · GridSettingsSection.tsx:599 · AdvancedSettingsSection.tsx:1092 | P2 | S |
| B-17 | Nút ⓘ nơi là `<button aria-label>`, nơi là `<div onClick>` không tab tới được | GridSettingsSection.tsx:264,333,425 · AdvancedSettingsSection.tsx:408,776 | P3 | S |
| C-11 | Copy-vs-move khi kéo thumbnail phân biệt chủ yếu bằng màu viền (xanh lá/xanh dương) — badge "＋Sao chép" nằm ở nguồn, không ở điểm thả | ThumbSidebar.tsx:148,452 | P2 | S |
| C-12 | Không hint chọn-nhiều thumbnail; nút xoay/xóa disable chỉ bằng màu xám, không giải thích | ThumbSidebar.tsx:394 | P2 | S |

---

## 4. TOP 10 QUICK-WIN (đề xuất Lô 1–2, toàn bộ S, không đổi layout)

| # | Mã | Việc | Vì sao đáng làm ngay |
|---|---|---|---|
| 1 | D-10 | Sửa 2 chuỗi mojibake `Kh?ng th? h?y job` | Lỗi chính tả lộ liễu, 2 dòng |
| 2 | B-03 | Suffix "Hở tem" luôn hiển thị "mm" (giá trị vốn là mm) | Đang là nhãn SAI — nguy cơ hiểu sai 10×/25.4× |
| 3 | B-02 | Thêm suffix "mm" cho toàn bộ input số đo (bleed, lề, W/H, gap, creep) theo đúng pattern đã có ở "Hở tem" | Chuẩn hóa 1 lần, thợ hết đoán đơn vị |
| 4 | A-01 | Theme chuyển vào appSettingsStore (đã có sẵn store) — 1 nguồn chân lý | Sửa bug check ✓ menu View + nền tảng cho token dark/light |
| 5 | C-02 | Thêm 3 nút Fit width / Fit page / 100% lên toolbar viewer | 2 lệnh dùng nhiều nhất, đang mất 2 click |
| 6 | B-11 | Nút "‹ Công cụ" quay về ToolMenuList cho MỌI tool (mở rộng điều kiện render sẵn có) | Hết "cửa vào không cửa ra" |
| 7 | C-07 | R khi chưa chọn trang → toast "Chọn trang ở thanh thumbnail trước, hoặc Ctrl+A chọn tất cả" | Phím "hỏng" thành phím có phản hồi |
| 8 | A-06 | Thanh tab: onWheel dọc→cuộn ngang | Với chuột thường hiện không cuộn tab được |
| 9 | B-15 | Dòng chú thích nhỏ cạnh dao cắt: "Về mặc định mỗi phiên để an toàn" | Giữ chủ đích reset, hết cảm giác "app quên" |
| 10 | A-05 | Self-host font Inter (woff2 subset latin+vietnamese trong bundle, bỏ @import CDN) | App desktop offline-safe; cần tôi tải file font → sẽ đưa bạn kiểm trước khi nhúng |

---

## 5. ĐỀ XUẤT BỘ DESIGN TOKENS (nền cho chuẩn hóa dark + light)

Hiện trạng: chưa có token cấp app; `--dt-*` (dieline-tool.css:7–47) là hình mẫu tốt. Đề xuất block `@theme`/`:root` trong `index.css`, mô phỏng `--dt-*` nhưng cấp app, cả 2 theme:

```
/* Nền 4 cấp (light / dark) */
--app-bg-0:  #e6e8eb / #1a1a1a   (nền shell — lấy từ giá trị App.tsx đang dùng)
--app-bg-1:  #f3f4f6 / #242628   (nền vùng làm việc/viewer — hợp nhất #323639, #2d3236)
--app-bg-2:  #ffffff / #2d3033   (bề mặt nổi: panel, menu, modal — hợp nhất #1e1e1e, #252525, #2d3236)
--app-bg-3:  #eef1f4 / #35393d   (hover/row xen kẽ)
/* Chữ 3 cấp */
--app-text-1: #1e293b / #e4e4e7   --app-text-2: #475569 / #a1a1aa   --app-text-3: #94a3b8 / #71717a
/* Accent duy nhất + ngữ nghĩa */
--app-accent: indigo-600/500 (chuẩn hóa cobalt #0f52ba và blue-500 về accent này)
--app-success / --app-warning / --app-danger: emerald / amber / red (600 light, 500 dark)
/* Radius 3 nấc */ --app-radius-sm: 4px  --app-radius-md: 8px  --app-radius-lg: 12px
/* Font */ Inter self-host; utility `.num` = font-variant-numeric: tabular-nums cho MỌI số đo
/* Motion */ --app-transition: 150ms ease; toàn bộ bọc @media (prefers-reduced-motion: reduce) → 0ms
/* z-index */ dùng thang sẵn có index.css:21–25, thay dần z số tay
```

Cách áp **bảo thủ, không nổ diff**: đợt này chỉ (1) khai báo token + (2) thay thế Ở CÁC FILE ĐÃ ĐỤNG vì lý do khác + hotspot tệ nhất (SaveModal, App shell, MenuBar, ViewerContextMenu — ~5 file/lô). Không càn quét 385 hex một lần. Màu vật liệu 3D trong dieline-tool giữ nguyên (là màu nội dung, không phải màu UI).

---

## 6. MÔ TẢ MOCKUP CHỮ — các thay đổi lớn hơn (CHỜ DUYỆT RIÊNG, chưa nằm trong "đánh bóng bảo thủ")

**M-1 · Status bar viewer (giải C-03, C-05, C-04, một phần C-13):** dải 24px đáy viewer:
`[Trang 3/48] · [210 × 297 mm] · [Zoom 125%] · [X: 105.2  Y: 48.7 mm] · [mm ▾]`
Click vùng đơn vị đổi mm/cm/inch tại chỗ. Tọa độ cập nhật theo chuột (throttle rAF). Đây là thay đổi cộng-thêm (không dời layout hiện có) nhưng chiếm 24px chiều cao → cần bạn duyệt.

**M-2 · Hợp nhất "Giấy & Lề" (giải B-01):** trong panel bình, nhóm cố định theo thứ tự nghề: *Khổ giấy → Lề giấy (4 ô, hiện inline thay vì dialog bánh răng) → Bleed → Khoảng cách (gutter X/Y tách 2 ô, giải luôn B-07)*. Không dời section khác — chỉ gom 3 chỗ hiện hành về 1 khối. Ảnh hưởng bố cục panel phải → cần duyệt + screenshot trước/sau.

**M-3 · Chuẩn hóa hệ progress (giải D-07, D-09, D-11):** 1 component ProgressBar dùng chung: % thật khi backend có processed/total, indeterminate khi không; tên bước; nút Hủy (chỉ hiện khi có endpoint cancel thật); xong việc → toast + nút "Mở thư mục" (Tauri opener có sẵn). Phần backend thiếu (% cho shuffle/resize, cancel compare) chỉ ghi nhận, KHÔNG tự thêm API.

**M-4 · Panel nhập X/Y/W/H cho field VDP (giải D-01):** khi chọn field, panel phải thêm 4 ô số (mm thật, quy đổi qua hệ số hiện có ×0.75 — không đổi model dữ liệu) + nudge mũi tên 0.5mm / Shift 5mm (giải phần S của D-02). Cần duyệt vì thêm khối UI mới vào panel VDP.

---

## 7. LỘ TRÌNH SỬA ĐỀ XUẤT (chờ bạn duyệt danh sách + thứ tự)

- **Lô 1 (5 file, toàn S):** D-10, B-03, A-01, C-07, A-06 → `api.ts, GridSettingsSection.tsx, useTheme.ts, App.tsx (x2 mục), useViewerHotkeys.ts`
- **Lô 2 (≤5 file):** C-02 (AcrobatToolbar), B-11 + B-12 (ImpositionTab, ToolMenuList), B-15 (AdvancedSettingsSection/ImposerDashboard), B-22 (disabled + tooltip nút Bình)
- **Lô 3 (token nền):** khai báo token + A-05 font self-host (tôi chuẩn bị file font, bạn duyệt) + A-09 splash dark + A-15 reduced-motion + A-08 z-index (chỉ khai báo & áp file đụng tới)
- **Lô 4:** B-02 suffix mm hàng loạt + B-04 min/clamp + B-09 Enter=Bình + B-06 báo snap tay sách
- **Lô 5:** nhóm lỗi/i18n: D-13, D-15 (helper "dịch" lỗi mạng), D-16, D-12, C-14, B-05, B-23, D-04, D-06
- **Lô 6+:** nhóm P2 còn lại theo bạn chọn; M-1→M-4 nếu được duyệt riêng.

Mỗi lô: dừng chờ bạn chạy `npx tsc --noEmit` + `npx vitest run` + bấm thử; log vào `docs/UIUX_FIXES_<ngày>.md`; mỗi chỗ sửa có comment `// UIUX (audit 2026-07-27 §mã)`; kèm bảng md5 + checklist bấm thử.

**Chưa làm đợt này (ghi rõ để khỏi trôi):** D-03 (hệ đơn vị CSS-mm — đụng logic), D-08/D-09 phần backend cancel/%, snap VDP đầy đủ (D-02 phần L), B-01 nếu bạn không duyệt M-2, C-13 scrollSeek (đụng cấu hình Virtuoso — test kỹ), B-16/A-02/A-04/A-07 chuẩn hóa control/icon/radius diện rộng (M, làm dần theo file bị đụng).
