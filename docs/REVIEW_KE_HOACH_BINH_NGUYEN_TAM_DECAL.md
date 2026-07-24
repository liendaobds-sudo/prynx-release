# Review kế hoạch "Bình nguyên tấm decal"

**Phạm vi:** review kế hoạch, chưa triển khai code, chưa commit.
**Tài liệu gốc:** `docs/KE_HOACH_BINH_NGUYEN_TAM_DECAL.md`
**Phương pháp:** mọi kết luận dựa trên đọc code thật (frontend `desktop/`, backend `backend/app/workers/`, native `imposition_core/` + `native/`). Có file:line kèm theo.

---

## 1. Kết luận tổng thể

**Có thể triển khai sau khi sửa kế hoạch.**

Ý tưởng cốt lõi vững và code hiện có đã hỗ trợ phần khó nhất: Form XObject embed-once (`pdf_ops.py`) an toàn, `compute_mark_coords` (Rust) đã dedup gap-0 đúng, nhánh non-die không strip CutContour, guard mixed-size đã tồn tại. **Không cần raster hóa, không cần thuật toán dấu xén mới** — hai giả định nền tảng của kế hoạch đều đúng.

Nhưng kế hoạch có **một sai lầm kiến trúc trung tâm** lặp ở cả frontend lẫn backend: nó vừa định nghĩa biến `pageSheetMode` (gắn `activeTool=='sticker_imposer'`) vừa gửi/đọc **raw `impositionUnit` global**. Hai cái mâu thuẫn, và là gốc của phần lớn lỗi P0/P1. Sửa gọn: **payload chỉ gửi `page_sheet_mode` đã tính, backend không đọc raw `impositionUnit`.**

---

## 2. Tóm tắt cách hiểu của đội review

- **Sản phẩm:** tấm decal A5 hoàn chỉnh (nhiều sticker + kiss-cut + trang trí) bán nguyên tấm. Khi bình lên khổ lớn phải nhân/dàn **nguyên tấm**, không tách sticker.
- **Từng tem vs Nguyên tấm:** Từng tem lấy từng đường bế làm item để nesting polygon. Nguyên tấm coi cả trang là 1 rectangle (footprint = TrimBox), dùng layout guillotine, giữ mọi CutContour bên trong làm *nội dung* chứ không phải *item*.
- **Đơn vị bình vs Tác vụ:** hai trục trực giao. Đơn vị bình (tem/tấm) quyết định *cái gì là item*; Tác vụ (bình trang/dàn mẫu) quyết định *nhân bản một hay dàn nhiều*. Trực giao này đã verify đúng — `taskMode` không đụng khái niệm mới.
- **Luồng PDF:** trang nguồn → Form XObject (embed 1 lần) → mỗi bản gọi `Do` + ma trận vị trí → guillotine marks theo gap. Không sửa nguồn.

---

## 3. Các vấn đề chặn triển khai

### P0-1 — `isDieCutMode` bị đọc lại ở nhiều điểm; tính một biến `effective` là không đủ

- **Mức độ:** P0
- **File:** `backend/app/workers/nup_engine.py`
- **Hàm/khu vực:** `:330`, `:363`, `:477`, `:286` (các điểm đọc `settings.get('isDieCutMode')` độc lập)
- **Vấn đề:** `geom_rect` (footprint từ die path) tính ở `:330` **trước** mọi biến effective, đọc thẳng settings. Kế hoạch §9 chỉ tính `effective_is_die_cut` một lần rồi giả định layout đi đúng.
- **Tác động:** footprint vẫn = box đường bế lớn nhất; nghiêm trọng hơn — `strip_color_from_stream` (`nup_artwork.py:297`) **mutate PDF nguồn in-place**, chạy khi die-cut còn `True` ở bất kỳ gate nào → vừa sai footprint vừa xóa CutContour khỏi file nguồn (vi phạm "không sửa PDF nguồn").
- **Bằng chứng:** `nup_engine.py:330` `if settings.get('isDieCutMode', False):` → `:393` `trim_w = geom_rect[...]`; re-read `:363`, `:477`.
- **Đề xuất sửa kế hoạch:** khi `page_sheet_mode`, **ghi đè** settings ngay đầu hàm: `settings = {**settings, 'isDieCutMode': False}` (giống pattern duplex guard `:288`). Bỏ cách "đẻ biến `effective_is_die_cut` cục bộ" trong §9.

### P0-2 — Payload gửi raw `impositionUnit` → rò sang CNC/N-Up

- **Mức độ:** P0
- **File:** `desktop/src/components/imposition-tools/store/workspaceSlice.ts:81-84`; `ImposerDashboard.tsx` (payload)
- **Hàm/khu vực:** `switchToolProfile` + `onStartNup` payload
- **Vấn đề:** `switchToolProfile` chỉ ghi đè key **có mặt** trong profile tool đích. `impositionUnit='page_sheet'` ở sticker sẽ **không** bị reset khi sang CNC (key vắng trong profile CNC). Backend §9 đọc raw global → job CNC nhận `page_sheet` → `effective_is_die_cut=False` → **tắt bế cho CNC**.
- **Tác động:** chuyển sticker(page_sheet)→CNC làm hỏng luồng CNC.
- **Bằng chứng:** `workspaceSlice.ts:81-84`; kế hoạch §8 dòng `impositionUnit: s.impositionUnit`, §9 dòng 301.
- **Đề xuất sửa kế hoạch:** payload **chỉ** gửi `page_sheet_mode = pageSheetMode` (đã gồm `activeTool==='sticker_imposer'`). Backend đọc field đó, **không** đọc raw `impositionUnit`. Tự loại CNC/N-Up.

### P0-3 — `markType` bị ép `'none'` khi export cho sticker_imposer

- **Mức độ:** P0
- **File:** `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1075`
- **Hàm/khu vực:** `onStartNup` payload
- **Vấn đề:** `getImposerCapability('diecut').supportsMarks === false` (`types.ts:456`) → `markType` luôn bị ép `'none'` khi export dưới sticker_imposer, dù UI cho chọn.
- **Tác động:** dấu xén nguyên tấm không bao giờ được sinh — mục tiêu chính của kế hoạch (§11) thất bại âm thầm.
- **Bằng chứng:** `ImposerDashboard.tsx:1075`; `types.ts:456`.
- **Đề xuất sửa kế hoạch:** khi `pageSheetMode`, dùng capability `'guillotine'`/`'offset'` (`supportsMarks=true`). Kế hoạch §11 phải bổ sung việc gỡ hàng rào capability này.

### P1-4 — Report "Bình tem bế" bị buộc trong khối `if is_die_cut`

- **Mức độ:** P1
- **File:** `backend/app/workers/nup_engine.py:553..2760` (populate), `:3350-3392` (fallback)
- **Vấn đề:** mọi `_reports_by_sheet` cho tem bế nằm trong khối `if is_die_cut`. Set `False` → mất, chỉ còn fallback gắn nhãn "Cắt xén" (`:3359` `_g_mode = 'Bế tem' if is_die_cut else 'Cắt xén'`).
- **Tác động:** mâu thuẫn với §9 "vẫn giữ báo cáo Bình tem bế". Report và `isDieCutMode` bị buộc chặt trong code, không tách.
- **Bằng chứng:** `nup_engine.py:1429,1462,1590,...2743` (đều trong gate); `:3359`.
- **Đề xuất sửa kế hoạch:** thêm mục — hoặc tách logic report khỏi gate `is_die_cut`, hoặc sửa fallback `:3350` nhận nhãn/route riêng cho page_sheet. Quyết định report page_sheet nên hiển thị gì (xem câu hỏi §10).

### P1-5 — Nhánh guillotine chính KHÔNG đọc TrimBox

- **Mức độ:** P1
- **File:** `backend/app/workers/nup_engine.py:399-401`, `:2085-2087`, `:2426`
- **Vấn đề:** guillotine thường dùng `rect.width - 2*bleed` (MediaBox), **không** đọc TrimBox. Chỉ nhánh die-cut (`:649-663`) và cluster_tile (`:2151`) mới ưu tiên TrimBox.
- **Tác động:** kế hoạch §5 "ưu tiên TrimBox" không thành hiện thực khi page_sheet chảy qua guillotine. File A5 có TrimBox ≠ MediaBox → footprint sai.
- **Bằng chứng:** `nup_engine.py:2085-2087` vs `:649-663`.
- **Đề xuất sửa kế hoạch:** thêm bước ưu tiên TrimBox vào chính nhánh `:2085` (copy logic `:649-663`), hoặc route page_sheet qua trim-resolver riêng. **Không thể** "tái dùng nguyên logic Bình cắt xén" mà vẫn được TrimBox.

### P1-6 — Dấu xén + Alignment bị `!stickerLike` chặn cứng trong UI

- **Mức độ:** P1
- **File:** `desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx:1024` (marks), `:981` (alignment); `GridSettingsSection.tsx:515` (bleed)
- **Vấn đề:** các control này gate `!stickerLike`/`activeTool !== 'sticker_imposer'`. page_sheet vẫn có `activeTool='sticker_imposer'` → mặc định ẩn, dù kế hoạch §4.3 cần hiện.
- **Tác động:** >10 điểm chạm dùng `stickerLike`/`isDieCut` phải rẽ nhánh; kế hoạch §4 đánh giá thấp phạm vi (chỉ 2 test §14).
- **Bằng chứng:** `AdvancedSettingsSection.tsx:1024,981`; `GridSettingsSection.tsx:515,326`; `ImposerDashboard.tsx:1426` (isDieCut prop).
- **Đề xuất sửa kế hoạch:** liệt kê **đầy đủ** danh sách gate cần đổi từ `stickerLike` → `stickerGeometryMode`; giữ `stickerLike` cho CNC + sticker-Từng-tem. Mở rộng test UI tương ứng.

---

## 4. Các rủi ro không chặn

### P2 — placement guillotine phải điền `cell.blockId` + `original_cell_y`
- **File:** `native/src/imposition/assembler.rs:123,133`; `nup_process_chunk.py:856`
- **Vấn đề:** marks Rust gộp block theo `blockId`; thiếu → default 0, có thể gộp sai.
- **Cách kiểm chứng:** test parity marks trên layout nhiều hàng/cột page_sheet.
- **Đề xuất:** đảm bảo guillotine solver điền đủ field khi nối page_sheet.

### P2 — splitGap preview/export không cộng mark clearance cho page_sheet
- **File:** preview `ImposerDashboard.tsx:1396` vs export `:1030`
- **Vấn đề:** splitGap cho stickerLike = `max(gapX,gapY)`, không cộng mark clearance. page_sheet có dấu xén cần rẽ nhánh guillotine (`2*markClearance`) để 2 tấm chừa chỗ dấu.
- **Cách kiểm chứng:** test parity preview/export với `markType=guillotine`, đo gap thực.
- **Đề xuất:** page_sheet dùng công thức splitGap guillotine; thêm test frontend (§14 hiện thiếu).

### P2 — guard mixed-size so MediaBox, không so TrimBox
- **File:** `backend/app/workers/nup_engine.py:2091-2106`
- **Vấn đề:** guard so `MediaBox-2bleed`, không so TrimBox. Hai file cùng MediaBox khác TrimBox lọt guard — ngược ý §12.2 "cùng TrimBox".
- **Cách kiểm chứng:** test 2 trang cùng MediaBox khác TrimBox.
- **Đề xuất:** tự đúng nếu P1-5 fix (đọc TrimBox); nếu không, đổi nguồn so sánh sang TrimBox.

### P2 — gap < 2×bleed chưa có bằng chứng hành vi clip
- **File:** `nup_artwork.py:347-360` (`cell_out_clip`)
- **Vấn đề:** chưa có bằng chứng hành vi khi khe nhỏ hơn tổng bleed hai phía.
- **Cách kiểm chứng:** test gap 0 + bleed>0 và gap 5mm + bleed 3mm.
- **Đề xuất:** test riêng, xác minh clip không cho bleed chồng sang thành phẩm hàng xóm.

### P2 — batch-capacity là đường payload thứ ba dễ quên
- **File:** `ImposerDashboard.tsx:807-859`
- **Vấn đề:** đường payload batch cap gửi `is_die_cut`/`shape_type` — dễ quên đồng bộ page_sheet. §18 không liệt kê.
- **Cách kiểm chứng:** kiểm 3 đường (batch/preview/export) cùng phát page_sheet nhất quán.
- **Đề xuất:** thêm batch-capacity vào danh sách file thay đổi.

### P2 — OCG membership trong Form XObject (cần test, chưa xác nhận)
- **File:** `pdf_ops.py`
- **Vấn đề:** OCG (`/OC`) tham chiếu `/OCProperties` document-level; `copy_foreign` Form có thể không tự merge vào `/OCProperties/D/Order` output.
- **Cách kiểm chứng:** test fixture có OCG, render kiểm layer còn bật/tắt được.
- **Đề xuất:** giữ test §15 OCG, coi là điểm phải verify chứ chưa phải đã an toàn.

### P3 — không cần bump persist version
- **File:** `persist.ts:205-218`
- **Vấn đề:** zustand merge tự lấy default cho key thiếu; bước migrate §17-GĐ1.4 thừa.
- **Đề xuất:** bỏ bước migrate khỏi kế hoạch, chỉ cần default trong slice.

---

## 5. Audit theo từng lớp

- **Store/data model:** `impositionUnit` trực giao `taskMode` — đúng. Phải khai báo ở `NupSlice` interface + setter + `NUP_PERSIST_KEYS` + `ALGO_PROFILE_KEYS`. Rò sang CNC là P0-2 (cơ chế `switchToolProfile` không reset key vắng mặt).
- **UI:** dropdown đặt trên "Tác vụ" ở `GridSettingsSection.tsx:177` — khả thi. Nhưng >10 gate `stickerLike`/`isDieCut` phải rẽ nhánh (P1-6). markType ép 'none' (P0-3).
- **Preview:** `resolvePreviewItemDimension` (`shapeDetectionPolicy.ts:21`) chỉ cần thêm tham số — đúng §7.1. Prop `isDieCut={stickerLike}` (`ImposerDashboard.tsx:1426`) là công tắc phải đổi thành `stickerGeometryMode` — kế hoạch §7 không chỉ ra.
- **Payload/API:** phải gửi `page_sheet_mode` thay raw impositionUnit (P0-2). Ba đường payload (batch/preview/export) phải đồng bộ.
- **Layout backend:** ghi đè `isDieCutMode=False` toàn cục (P0-1). Guillotine không đọc TrimBox (P1-5).
- **Render PDF:** Form XObject embed-once + cache an toàn (`pdf_ops.py:293-327`, BBox ép MediaBox `:308`) — **điểm mạnh nhất, đúng §10**. Nhánh non-die không strip CutContour (`nup_artwork.py:484`) — đúng, với điều kiện P0-1 triệt để.
- **Bleed/page boxes:** `show_pdf_page` có `out_clip`, `cell_out_clip` chặn bleed chồng — đúng §6.3. TrimBox priority thiếu ở guillotine (P1-5).
- **Dấu xén:** `compute_mark_coords` (`assembler.rs:147-266`) dedup BTreeSet key `(coord*100).round()` (`:174`), `GAP_EPS=0.5` (`:204`), corners vs guillotine (`:238`) — **tất cả đúng §2.2/§11, không cần thuật toán mới**.
- **Report:** buộc trong `if is_die_cut` (P1-4).
- **Test:** matrix kế hoạch tốt nhưng thiếu: parity marks preview/export, gap<2×bleed, OCG-in-Form, rò state CNC.

---

## 6. Kiểm tra các giả định quan trọng

| Giả định | Trả lời |
|---|---|
| `compute_mark_coords` dedup cạnh trùng? | **CÓ** — BTreeSet + làm tròn 0.01pt + GAP_EPS 0.5pt (`assembler.rs:174,204`). |
| Nhánh guillotine giữ CutContour trong nguồn? | **CÓ** — non-die không strip (`nup_artwork.py:484`), **với điều kiện** `isDieCutMode=False` tới mọi gate (P0-1). |
| `show_pdf_page` bảo toàn spot color/resource? | **CHƯA ĐỦ BẰNG CHỨNG** (khả năng cao CÓ) — `as_form_xobject` giữ content+resource; rủi ro OCG document-level phải test. |
| Preview dùng page dimension thay detected die? | **CÓ** — `shapeDetectionPolicy.ts:21` chỉ cần thêm tham số + đổi prop `isDieCut`. |
| `effective_is_die_cut = False` an toàn? | **KHÔNG** như kế hoạch mô tả — phải ghi đè settings toàn cục, không tính biến cục bộ (P0-1). |
| Dàn nhiều mẫu cùng TrimBox dùng luồng hiện tại? | **CÓ** guard hủy an toàn (`nup_engine.py:2091`), nhưng guard so MediaBox không so TrimBox (P2). |
| Bleed đúng semantics kế hoạch mô tả? | **KHÔNG hoàn toàn** — guillotine dùng MediaBox-2bleed, bỏ TrimBox (P1-5). |

---

## 7. Test matrix đề xuất cuối cùng

| Nhóm | Test | Input | Kết quả mong đợi | Mức độ |
|---|---|---|---|---|
| Routing | page_sheet không strip nguồn | A5 + 2 CutContour | file nguồn hash không đổi, CutContour còn | P0 |
| Routing | CNC không nhận page_sheet | sticker(page_sheet)→CNC | job CNC vẫn effective_is_die_cut=True | P0 |
| Marks | export sinh dấu | page_sheet + markType=guillotine | markType KHÔNG bị ép 'none' | P0 |
| Marks | gap 0 → 1 đường | 2 tấm gap 0 | 1 tọa độ xén chung | P0 |
| Marks | gap>0 → 2 đường | gap 5mm | 2 tọa độ xén | P1 |
| Marks | parity preview/export | guillotine marks | splitGap khớp, dấu không đè thành phẩm | P2 |
| Footprint | TrimBox ưu tiên | A5 TrimBox≠MediaBox | footprint = TrimBox | P1 |
| Footprint | không dùng die box | tấm nhiều sticker | footprint = trang, không = sticker lớn nhất | P0 |
| Render | Form XObject embed-once | nhân 2×2 | 1 XObject, 4 Do, file không phình tuyến tính | P1 |
| Render | CMYK/spot/soft mask giữ | fixture đủ loại | màu/mask không đổi | P1 |
| Render | OCG-in-Form | fixture OCG | layer còn bật/tắt được | P2 |
| Bleed | bleed 0 giữ A5 | MediaBox=A5, no bleed | kích thước đúng, không co | P1 |
| Bleed | gap<2×bleed | gap 0 + bleed 3mm | clip không chồng thành phẩm hàng xóm | P2 |
| Dàn mẫu | mixed TrimBox hủy | A5+A6 khác TrimBox | hủy an toàn, thông báo rõ | P1 |
| State | Từng tem không đổi hành vi | mọi thao tác cũ | kết quả byte-identical | P0 |
| Preview | dùng page dim | page_sheet | rectangle theo TrimBox, không crop die | P1 |

---

## 8. Danh sách thay đổi cần đưa lại vào kế hoạch

- **§9 (sửa):** thay "tính `effective_is_die_cut` cục bộ" → "ghi đè `settings = {**settings, 'isDieCutMode': False}` ngay đầu `run_nup_engine` khi page_sheet_mode". Nêu rõ lý do: `isDieCutMode` bị đọc lại ở `:330`/`:363`/`:477`/`:286`.
- **§8 (sửa):** bỏ dòng gửi raw `impositionUnit: s.impositionUnit`. Chỉ gửi `page_sheet_mode = pageSheetMode`. Backend §9 đọc field này.
- **§11 (thêm):** phải gỡ hàng rào `getImposerCapability('diecut').supportsMarks===false` (`ImposerDashboard.tsx:1075`) — page_sheet dùng capability guillotine/offset.
- **§9 (thêm mục Report):** quyết định + cơ chế giữ/đổi report cho page_sheet (tách khỏi gate `is_die_cut` hoặc sửa fallback `:3359`).
- **§5 (sửa):** ghi rõ guillotine hiện KHÔNG đọc TrimBox; phải thêm ưu tiên TrimBox vào nhánh `:2085` hoặc trim-resolver riêng. Không thể "tái dùng nguyên trạng" mà có TrimBox.
- **§4 (mở rộng):** liệt kê **đầy đủ** >10 gate `stickerLike`/`isDieCut` cần đổi (marks `:1024`, alignment `:981`, bleed `:515`, isDieCut prop `:1426`, shape `:326`, separateCutPage `:1175`...).
- **§18 (thêm file):** `store/workspaceSlice.ts`, `store/persist.ts`, khối batch-capacity trong `ImposerDashboard.tsx`, `nup_artwork.py` (xác nhận không strip), `assembler.rs`/native (field placement).
- **§17-GĐ1.4 (xóa):** bỏ bước "migration/fallback preset cũ" — zustand merge tự lấy default, không cần bump version.
- **§14 (làm rõ):** thêm test rò state CNC, parity marks, và mở rộng test ẩn/hiện cho đủ >10 gate.

---

## 9. Thứ tự triển khai đề xuất

1. **Characterization trước:** chụp hành vi Từng tem + CNC + Bình cắt xén hiện tại (byte-level output + payload snapshot) để bắt hồi quy.
2. **State + payload (P0-2):** thêm `impositionUnit` + `pageSheetMode`; payload gửi `page_sheet_mode`, KHÔNG raw. Test rò state CNC/N-Up.
3. **Backend routing (P0-1):** ghi đè `isDieCutMode=False` toàn cục khi page_sheet; test file nguồn không bị strip.
4. **TrimBox resolver (P1-5)** + report (P1-4) trong nhánh guillotine.
5. **Preview parity (P0-3, P1-6):** đổi capability marks, gate UI, prop isDieCut, splitGap; test preview/export khớp.
6. **Render QA cuối:** fixture đủ CMYK/spot/OCG/soft mask/transparency; render PDFium kiểm mắt + hash nguồn.

---

## 10. Câu hỏi cần người dùng quyết định

1. **Report cho Nguyên tấm decal nên hiển thị gì?** Report tem bế hiện gắn chặt `is_die_cut` và phân theo từng khuôn/zone — vô nghĩa khi cả tấm là 1 item. Chọn: (a) report kiểu guillotine (số tấm, số hàng/cột, khổ), (b) vẫn nhãn "Bế tem" nhưng đếm theo tấm, hay (c) tắt report cho page_sheet? Đây là quyết định sản phẩm, không suy ra được từ code.

2. **Khi file A5 có TrimBox = MediaBox (không có bleed riêng) nhưng người dùng nhập bleed > 0:** footprint nên co lại `MediaBox − 2×bleed` (kế hoạch §5 mục 3), hay giữ nguyên MediaBox và chỉ cảnh báo? Hai cách cho kích thước thành phẩm khác nhau — cần chốt ngữ nghĩa "bleed" cho nguyên tấm.
