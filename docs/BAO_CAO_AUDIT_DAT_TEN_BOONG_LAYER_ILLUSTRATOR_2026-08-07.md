# Báo cáo audit đặt tên boong/ốc và layer khi mở bằng Illustrator

> Ngày audit: 2026-08-07  
> Phạm vi: thiết lập Boong (Marks) → payload → backend writer → PDF kết quả → nút **Bế** → PDF tạm mở bằng Illustrator/CorelDRAW  
> Mức bằng chứng: `ARTIFACT`; chưa smoke trực tiếp trên Illustrator/Graphtec Studio  
> Trạng thái: **đã sửa code + regression test ngày 2026-08-07**; chưa smoke Illustrator/Graphtec thật

## 1. Kết luận ngắn

Các tên trong thiết lập boong **không bị mất ở UI, payload hoặc backend writer**. File kết quả đầy đủ sau khi bình vẫn có:

- Graphtec Info Layer Name;
- `Layer Name`;
- `Group Name` nằm dưới layer;
- `Item Name` dưới dạng thuộc tính marked-content `/NM`.

Lỗi xảy ra sau đó, khi người dùng bấm **Bế** và giữ lựa chọn mặc định **Chỉ trang khuôn**. `OpenInDesignModal` tạo một PDF tạm bằng `PDFDocument.create()` + `copyPages()`. Cách này sao chép nội dung trang và resource cục bộ nhưng làm rơi `/OCProperties` ở catalog tài liệu. Vì cây layer PDF nằm trong Optional Content Groups (OCG) được đăng ký qua `/OCProperties`, Illustrator/Acrobat không còn catalog để dựng bảng layer.

Đây là lý do người dùng vẫn thấy nét khuôn/ốc nhưng không thấy các layer đã đặt tên.

**Cách tránh tạm thời:** trong hộp mở Illustrator, chọn **Cả khuôn + in**. Nhánh này mở thẳng file kết quả gốc trên đĩa, không trích trang bằng `copyPages()`, nên không làm mất catalog layer.

## 2. Luồng dữ liệu đã truy vết

| Tầng | Bằng chứng | Kết luận |
|---|---|---|
| Dialog | `desktop/src/components/imposition-tools/PontSettingsDialog.tsx:13-17, 218-235` | Bốn tên được lưu vào `pontConfig`: `layerInfoName`, `layerName`, `groupName`, `itemName`. |
| Payload | `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1313-1314`; `desktop/src/lib/processHandlers.ts:168-169` | `pontConfig` được gửi sang backend. |
| Validation | `backend/app/schemas/pont.py:87-95` | Layer/group/item bắt buộc có tên; Graphtec info bắt buộc khi bật Graphtec. |
| Sticker/Page Sheet writer | `backend/app/workers/nup_process_chunk.py:997-1035, 1425-1444` | Tạo OCG Graphtec, layer, group và cây `/Order`; truyền `itemName` khi vẽ ốc. |
| CNC writer | `backend/app/workers/cnc_render.py:48-68, 207-280` | Tạo cùng ba OCG và truyền `itemName` cho Front/Cut. |
| Item metadata | `backend/app/workers/pdf_ops.py:183-233` | `itemName` được ghi thành property `/NM`, bọc nội dung bằng marked-content `/Span ... BDC`. |
| Gộp kết quả | `desktop/src/lib/processHandlers.ts:419-433` | Đã dùng helper bảo toàn OCG; không làm mất layer. |
| Nút Bế | `desktop/src/components/ImpositionTab.tsx:2697-2704` | Mở `OpenInDesignModal`. |
| Mặc định hộp mở | `desktop/src/components/imposition-tools/OpenInDesignModal.tsx:107, 291-293` | Mặc định `cut_only`, nên người dùng bình thường đi vào nhánh có lỗi. |
| Trích trang khuôn | `desktop/src/components/imposition-tools/OpenInDesignModal.tsx:257-270` | Tạo tài liệu mới và gọi `copyPages()` nhưng không chuyển `/OCProperties`. |

## 3. Bằng chứng artifact

Artifact tạm được tạo trực tiếp từ engine hiện tại tại:

`%TEMP%\prynx_ocg_layer_audit_20260807`

### 3.1 File kết quả đầy đủ — PASS

File: `cnc_full_result.pdf`

- `/OCProperties`: có;
- `/OCGs`: `SA info AUDIT GRAPH`, `Marks_Model_AUDIT`, `MarkLine_AUDIT`;
- `/D/Order`: có đúng ba tên và `MarkLine_AUDIT` nằm trong nhánh con;
- `/NM`: có `MKLINE_AUDIT` trên nội dung ốc.

Kết quả này xác nhận các thiết lập tên đã đi hết từ cấu hình tới artifact backend.

### 3.2 File “Chỉ trang khuôn” theo đúng code hiện tại — FAIL

File: `cnc_cut_only_pdf_lib.pdf`

- `/OCProperties`: **không có**;
- `/OCGs`: rỗng;
- `/D/Order`: không có;
- content stream vẫn còn các lệnh `/OC /MC1 BDC` và `/Span /NM_MKLINE_AUDIT BDC`;
- resource trang vẫn còn `/NM=MKLINE_AUDIT`.

Nghĩa là nét và metadata cục bộ vẫn còn, nhưng danh mục OCG ở cấp tài liệu đã mất. Đây chính là trạng thái “có hình nhưng không có layer” mà người dùng quan sát trong Illustrator.

### 3.3 Đối chứng helper và bằng chứng bổ sung khi triển khai

Repo đã có `desktop/src/lib/pdfOptionalContent.ts` để xử lý lỗi đặc trưng của `copyPages()`:

- `beginOptionalContentTransfer()` đóng dấu các OCG nguồn trước khi copy;
- `finishOptionalContentTransfer()` dựng lại `/OCProperties`, `/OCGs`, `/Order`, trạng thái ON/OFF và xóa dấu tạm;
- `savePrintFiles.ts:71-78` và `previewSourcePolicy.ts:106-126` đã dùng helper này;
- riêng `OpenInDesignModal.tsx` chưa dùng.

Khi viết regression theo đúng artifact CNC, phát hiện thêm: Graphtec info và layer cha là OCG rỗng, không được resource trang tham chiếu. Helper mặc định chỉ mang được `MarkLine` đang chứa nét; nếu chỉ gọi helper như đề xuất ban đầu thì hai OCG rỗng vẫn mất.

Bản sửa đã bổ sung tùy chọn explicit `preserveUnreferencedOcgs`. Tùy chọn này lấy OCG đang được trang sử dụng làm mốc, giữ các OCG rỗng trong đúng nhánh `/Order` liên quan và không kéo nhánh của tờ khác vào file tạm. Hành vi mặc định của các caller cũ không đổi.

## 4. Findings

### §PONTLAYER.1 — P1 — “Chỉ trang khuôn” làm mất toàn bộ catalog layer PDF

**Trạng thái:** `[CONFIRMED → FIXED 2026-08-07]` · Likelihood `H` · Impact `H`

Điều kiện:

1. Bình file có boong/ốc và các tên layer tùy chỉnh.
2. Bấm **Bế**.
3. Giữ lựa chọn mặc định **Chỉ trang khuôn**.
4. Mở bằng Illustrator/CorelDRAW.

Kỳ vọng: PDF tạm giữ nguyên cây OCG của trang được trích.

Thực tế: `copyPages()` giữ trang nhưng bỏ `/OCProperties`; bảng layer downstream không có dữ liệu để hiển thị.

Ảnh hưởng:

- Graphtec info layer, layer ốc và group ốc biến mất khỏi cây layer;
- plugin/macro dựa trên tên layer có thể không tìm được đối tượng;
- người dùng tưởng thiết lập đặt tên không hoạt động dù backend đã ghi đúng;
- lỗi xảy ra trên đường mặc định nên khả năng gặp cao.

Nguyên nhân trực tiếp: `OpenInDesignModal.tsx:267-270` sao chép trang mà không gọi helper bảo toàn optional content đã có sẵn trong dự án.

### §PONTLAYER.2 — P2 — Test hộp mở Illustrator không kiểm hợp đồng layer

**Trạng thái:** `[CONFIRMED → FIXED 2026-08-07]` · Likelihood `H` · Impact `M`

`OpenInDesignModal.test.tsx:133-137` chỉ mở PDF tạm và kiểm:

- số trang bằng 1;
- kích thước trang đúng.

Test không kiểm `/OCProperties`, `/OCGs`, `/D/Order`, quan hệ OCG của content hoặc `/NM`. Vì vậy test vẫn xanh dù layer bị mất hoàn toàn.

Các test baseline trong lượt audit ban đầu:

- Frontend `OpenInDesignModal.test.tsx` + validation dialog: **15/15**;
- Backend naming/page-sheet: **34/34**;
- Helper `pdfOptionalContent.test.ts`: **18/18**.

Kết quả xanh hiện tại không bác bỏ bug; nó chứng minh khoảng trống assertion ở đúng đường mở Illustrator.

Sau sửa, regression mới kiểm đủ `/OCProperties`, ba tên OCG, cây `/Order`, ref group chứa nét, `/NM` và ca nhiều tờ không lẫn nhánh.

### §PONTLAYER.3 — P2 — Nhãn UI đang hứa nhiều hơn hợp đồng PDF đã được kiểm chứng

**Trạng thái:** `[CONFIRMED contract gap / RUNTIME UNVERIFIED]` · Likelihood `M` · Impact `M`

Code hiện có các hợp đồng sau:

- `Layer Name` → PDF OCG;
- `Group Name` → một PDF OCG khác, được xếp lồng trong `/D/Order`;
- `Item Name` → marked-content property `/NM`.

Đây là cấu trúc layer/metadata của **PDF**, chưa phải bằng chứng rằng Illustrator sẽ luôn nhập thành native Illustrator `Layer → Group → Item` với tên tương ứng. Adobe xác nhận PDF layer là OCG; tài liệu Illustrator cũng mô tả việc xuất top-level Illustrator layer thành Acrobat layer, nhưng chiều nhập ngược và cách ánh xạ group/item phụ thuộc Illustrator/runtime.

Vì chưa smoke trực tiếp Illustrator/Graphtec Studio, audit không tuyên bố `itemName=/NM` chắc chắn xuất hiện thành tên object native trong Illustrator. Sau khi khôi phục OCG, cần một lượt downstream smoke để chốt hoặc điều chỉnh wording UI/hợp đồng xuất.

Tham chiếu Adobe:

- [Acrobat SDK — PDF layers dùng Optional Content Group](https://opensource.adobe.com/dc-acrobat-sdk-docs/library/overview/Overview_Metadata.html)
- [Illustrator — Create Acrobat Layers From Top-level Layers](https://helpx.adobe.com/illustrator/using/pdf-options.html)
- [Acrobat — quản lý PDF layers và nhóm lồng nhau](https://helpx.adobe.com/acrobat/desktop/edit-documents/pdf-layers/manage-layers.html)

## 5. Phạm vi sibling đã rà

Các đường `copyPages()` liên quan trực tiếp đến bình và xuất trang đã được đối chiếu:

- `processHandlers.ts`: đã bảo toàn OCG khi gộp kết quả;
- `savePrintFiles.ts`: đã bảo toàn OCG đang được content tham chiếu khi tách file; chưa bật hợp đồng giữ OCG metadata rỗng;
- `previewSourcePolicy.ts`: đã bảo toàn OCG đang được content tham chiếu khi bake thứ tự/xoay trang xem trước;
- `OpenInDesignModal.tsx`: là đường người dùng báo lỗi và đã được sửa để giữ cả context OCG rỗng liên quan.

Không đề xuất sửa hàng loạt mọi `copyPages()` trong repo ở audit này vì nhiều call site không thuộc artifact có layer hoặc thuộc tính năng khác; sửa lan rộng sẽ vượt phạm vi bằng chứng.

## 6. Lô sửa đã thực hiện sau khi duyệt

### Lô 1 — Khôi phục layer trên đường “Chỉ trang khuôn” (4 file code/test)

1. `desktop/src/components/imposition-tools/OpenInDesignModal.tsx`
   - dùng `beginOptionalContentTransfer([srcDoc])` trước `copyPages()`;
   - gọi `finishOptionalContentTransfer(transfer, out)` trong `finally` trước `save()`;
   - giữ nguyên lựa chọn trang, thứ tự tờ và tên file tạm.
2. `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx`
   - dựng nguồn có Graphtec/layer/group, `/Order` lồng nhau và `/NM`;
   - sau khi bấm mở Illustrator, parse bytes đã ghi bởi `write_file_atomic`;
   - assert `/OCProperties`, tên OCG, `/Order`, OCG membership và `/NM` còn nguyên.

3. `desktop/src/lib/pdfOptionalContent.ts`
   - thêm tùy chọn giữ OCG rỗng trong đúng context `/Order` của trang được trích;
   - dùng ref content đã copy cho OCG đang được vẽ, chỉ copy riêng OCG rỗng còn thiếu;
   - giữ nguyên hành vi mặc định của mọi caller cũ.
4. `desktop/src/lib/pdfOptionalContent.test.ts`
   - khóa ca Graphtec info/layer cha rỗng;
   - khóa ca nhiều tờ chỉ giữ nhánh của trang được trích.

Verify sau lô:

- Hai file test đích: **23/23 passed**;
- frontend typecheck: **PASS**;
- frontend full: **203 file passed; 1.952 passed, 2 skipped**;
- ESLint bốn file: **0 error**, còn 1 warning hook có sẵn ngoài vùng sửa.

### Lô 2 — Chốt hợp đồng Illustrator/Graphtec sau smoke runtime

1. Mở artifact đã sửa bằng Illustrator thật.
2. Kiểm cây layer, group và object name thực tế.
3. Mở bằng Graphtec Studio/plugin đang dùng trong xưởng.
4. Nếu Illustrator không ánh xạ `/NM` thành native item name, chọn một trong hai hướng:
   - đổi nhãn UI để mô tả đúng metadata PDF; hoặc
   - thiết kế định dạng/sidecar riêng đáp ứng native Illustrator/plugin contract.

Lô 2 không nên triển khai theo suy đoán trước khi có bằng chứng runtime.

## 7. Chốt audit

Nguyên nhân người dùng không thấy layer đã được xác nhận ở mức artifact: **PDF gốc có layer đúng, PDF tạm “Chỉ trang khuôn” làm mất `/OCProperties` ngay trước khi mở Illustrator**.

Lô code/test đã hoàn thành ở mức bằng chứng tự động. §PONTLAYER.3 vẫn giữ `RUNTIME UNVERIFIED` cho đến khi mở lại bằng Illustrator/Graphtec thật.
