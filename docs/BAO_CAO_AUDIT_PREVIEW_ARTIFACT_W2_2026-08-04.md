# Báo cáo Deep Audit W2 — Preview so với PDF xuất

> Ngày audit: 2026-08-04 · Baseline code: `1bf8621` · Phạm vi: W2-U01/W2-U02 · Mục 8 ghi kết quả sau khi user duyệt sửa.

## 1. Tóm tắt điều hành

| Mã | Trạng thái | Mức | Finding | Effort |
|---|---|---:|---|---|
| `§W2.PA1` | `[CONFIRMED]` · đã sửa | P2 | Preview Booklet “In nhanh” bỏ qua `marginBottom`, PDF plan vẫn dùng tham số. | S |
| `§W2.PA2` | `[CONFIRMED]` · đã sửa | P1 | Preview có thể tái dùng trang đã xóa khi materialize working PDF thất bại. | M |

W2 chưa được nâng quá `AUTO`: finding PA1 đã tái hiện bằng helper production, nhưng chưa có corpus chung preview → serialized plan → PDF output → reopen/raster cho toàn N-Up/Booklet/Sticker/Mixed Guillotine.

## 2. `§W2.PA1` — Booklet preview thiếu lề dưới

**Trạng thái:** `[CONFIRMED]` · **P2** · Effort S.

Đường sống:

`ImposerDashboard` settings → `SheetViewerDialog` preview → `computeSpreadGrid`; nhánh export đi `InstructionSerializer` → phase-2 plan → writer.

Bằng chứng:

- Export truyền `marginBottom` trong settings tại `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1185-1205`.
- Serializer đọc tham số tại `desktop/src/lib/imposerEngine/InstructionSerializer.ts:468-475`.
- `computeSpreadGrid` coi lề dưới thực tế là `max(gripper, marginBottom)` tại `InstructionSerializer.ts:413-450`.
- Kế hoạch xuất truyền đủ `marginBottomPt` tại `InstructionSerializer.ts:544-548`.
- `SheetViewerDialogProps` không khai báo `marginBottom`; lời gọi preview tại `desktop/src/components/flipbook/SheetViewerDialog.tsx:361-367` dừng ở `gripperMargin`.
- Dashboard mở dialog tại `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1845` nhưng không truyền `s.marginBottom`.

Tái hiện độc lập trực tiếp bằng `computeSpreadGrid` production:

- Tờ `220×230`, spread `200×100`, lề trái/phải/trên `5/5/10`, lề dưới `25`, gripper `0`.
- Preview thiếu lề dưới: lưới `1×2`.
- Kế hoạch xuất có lề dưới: lưới `1×1`.

Kết quả đã được khóa bằng một test audit tạm thời chạy trực tiếp module production; test đạt rồi file tạm được xóa. Preview có thể báo sai số hàng, sức chứa và vị trí Y trong khi PDF xuất dùng cấu hình đúng.

## 3. `§W2.PA2` — Fallback Mixed Guillotine sau lỗi materialize

**Trạng thái sau fault-injection:** `[CONFIRMED]` · **P1** · đã sửa.

Đường trace:

- GridPreview ưu tiên materialize bytes đã áp state trang tại `desktop/src/components/imposition-tools/sections/GridPreview.tsx:975-989`.
- Khi materialize lỗi, code fallback về path PDF gốc tại `GridPreview.tsx:1018`.
- Request vẫn gửi `total_pages` theo viewer tại `GridPreview.tsx:1442-1443`.
- Backend Mixed Guillotine dựng sản phẩm bằng toàn bộ `doc.page_count` tại `backend/app/api/routes/imposition.py:1221-1240`.
- Failsafe frontend ở `GridPreview.tsx:1558-1565` chỉ gán lại `pageIdx`; nó không dựng lại zone, kích thước và cut tree.

Nếu file gốc còn các trang đã xóa trong viewer, fallback có thể tạo hình học theo trang không còn sống. Chưa có fault-injection bắt materialize thất bại cùng PDF nhiều khổ; vì vậy finding vẫn là nghi vấn. Hướng an toàn cần đánh giá là fail-closed khi bắt buộc bake nhưng bake thất bại.

## 4. Hành vi được xác định là chủ ý

- `[EXPECTED]` Cut-stack trong Sheet Viewer là mô phỏng tuần tự, không cam kết preview chính xác từng plate.
- `[EXPECTED]` GridPreview không chứng minh đầy đủ crop marks/report của artifact.
- `[EXPECTED]` Report PDF fail-soft là policy hiện tại; không tự nâng thành finding nếu output chính vẫn hợp lệ và warning rõ.

## 5. Corpus parity cần bổ sung

Chạy cùng một bộ PDF qua preview, serialized plan và artifact:

- một mặt/hai mặt; N-Up sequential/repeat/manual;
- Booklet digital step-repeat/cut-stack với `marginBottom` nhỏ hơn, bằng và lớn hơn gripper;
- mixed page sizes với TrimBox/CropBox logic;
- trang đã xóa/sắp lại và fault-injection materialize;
- bleed, marks, cut-border trim/bleed, report và duplex flip.

So sánh tối thiểu: page count, placement count, source page index, trim rectangle, sheet dimensions, rotation, marks/cut-border và plan hash nếu có.

## 6. Đề xuất lô sửa — chờ duyệt

1. **Lô PA1, tối đa 3 file:** thêm `marginBottom` vào `SheetViewerDialog`, truyền từ dashboard, thêm regression test tại ngưỡng đổi số hàng.
2. **PA2 chưa sửa:** thêm fault-injection cho materialize failure; xác định fail-closed hay materialize server-side trước khi đổi hành vi.
3. Sau mỗi lô, tạo một PDF thật, parse/raster/reopen; unit test DOM không đủ nâng trạng thái runtime.

## 7. Verify đã chạy

- Frontend toàn phần: `186` file test, `1.837` đạt, `2` skip; typecheck đạt.
- Backend toàn phần: `2.185` đạt, `4` skip.
- Tauri `cargo check --locked --offline` đạt trong target riêng.
- Dieline sidecar build và WebView check đạt.
- Reproducer PA1 dùng production `computeSpreadGrid`: `1` test đạt.
- Chưa tạo PDF artifact cùng corpus PA1 và chưa fault-inject PA2; chưa nâng mức runtime.

**Chốt baseline:** báo cáo đã được user duyệt; kết quả sửa nằm ở mục 8 và nhật ký fixes W2.

## 8. Kết quả sau khi duyệt sửa

- `PA1`: truyền `marginBottom` xuyên Dashboard → SheetViewerDialog → `computeSpreadGrid`; test khóa ngưỡng đổi số hàng.
- `PA2`: preview materialize strict và dừng nếu bake page edits thất bại; không fallback PDF gốc. Backend Mixed Guillotine cũng từ chối khi `total_pages` khác `doc.page_count`.
- Frontend: nhóm preview/working PDF đạt trong bộ `51` test liên quan; typecheck đạt; full Vitest `1.857` đạt, `2` skip; ngân sách lint đạt.
- Backend: `test_mixed_guillotine_preview.py` và ratchet liên quan đạt; full backend cuối đạt `2.238`, skip `4`.
- Chưa thao tác app desktop thật hoặc so toàn corpus marks/bleed/report/duplex; W2 giữ mức `AUTO`.
