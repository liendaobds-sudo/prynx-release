# Báo cáo rà soát — Độ chính xác kích thước trên giao diện và report

Ngày rà soát: 2026-08-04

## Phạm vi và tiêu chí

Rà toàn bộ `desktop/src` và các formatter report liên quan trong backend để tìm cùng họ lỗi với badge Viewer từng hiển thị `147 × 51 mm` trong khi CropBox/TrimBox thật là `147,1215 × 51,3327 mm`.

Một vị trí được tính là lỗi khi:

- dữ liệu hình học có phần thập phân nhưng UI/report/tên file trình bày như một kích thước chính xác đã bị làm tròn nguyên;
- hai nơi cùng mô tả một kích thước nhưng dùng độ chính xác khác nhau;
- hoặc số đã làm tròn được đưa ngược vào quyết định hình học/nghiệp vụ.

Không tính là lỗi: làm tròn pixel raster, phần trăm, số trang, cache key có dung sai rõ ràng hoặc quy tắc gom nhóm đã được xác định là gần đúng.

## Tóm tắt điều hành

- Badge Viewer gốc đã được sửa riêng: hiện dùng kích thước trang vật lý đang active và giữ `0,1 mm`.
- Đã xác nhận **11 phát hiện**: `2 P1`, `5 P2`, `4 P3`.
- Nghiêm trọng nhất là report sản xuất làm `147,1 × 51,3` thành `147 × 51 mm`, và preset Letter của Đổi kích thước trang làm sai kích thước PDF thật.
- Ngoài preset Letter, các phát hiện còn lại chủ yếu làm sai nhãn/report/tên file; hình học PDF vẫn giữ số thực.
- Người dùng đã duyệt triển khai toàn bộ; trạng thái và bằng chứng sửa nằm trong `docs/DO_CHINH_XAC_KICH_THUOC_FIXES_2026-08-04.md`.

## Phát hiện

| Mã | Mức | Effort | Phát hiện và tác động | Bằng chứng |
|---|---:|---:|---|---|
| §DIM.1 | **P1** | M | Report N-Up/Bình trang/tem bế/CNC làm tròn kích thước thành phẩm về mm nguyên ở cả preview và backend xuất PDF. Với ca thật, `147,1215 × 51,3327` trở thành `147 × 51 mm`. Python `round()` và JavaScript `Math.round()` còn có thể lệch nhau tại giá trị `.5`. | `desktop/src/lib/reportPreview.ts:56`; `backend/app/workers/nup_report.py:140`; chạy trực tiếp `compute_report_data(...)` trả `147 x 51 mm` |
| §DIM.2 | **P1** | S | Preset **Letter** của Đổi kích thước trang dùng `216 × 279 mm` rồi truyền thẳng vào engine, thay vì `215,9 × 279,4 mm`. Đây không chỉ là nhãn: PDF xuất thật bị rộng thêm `0,1 mm` và thấp đi `0,4 mm`. Office Convert trong cùng dự án đang dùng đúng số chuẩn. | `desktop/src/components/preprocess-tools/PageResizerTool.tsx:33,122-123`; đối chiếu `OfficeConvertTool.tsx:509,819,1069,1220` |
| §DIM.3 | **P2** | S | Tạo tài liệu mới cho nhập khổ thập phân và tạo PDF đúng, nhưng dòng tóm tắt cùng tên mặc định làm tròn nguyên. Tài liệu `147,1 × 51,3` có thể mang tên `Untitled_147x51mm.pdf`. | `desktop/src/components/NewDocumentModal.tsx:146`; `desktop/src/lib/createBlankPdf.ts:18-29` |
| §DIM.4 | **P2** | S | Chip khổ giấy trên preview In dùng `toFixed(0)`, trong khi hộp Page Setup ngay cùng dialog dùng `toFixed(1)`. Khổ Letter có thể hiện `216 × 279` ở trên và `215,9 × 279,4` bên dưới. Hình học in vẫn dùng số thật. | `desktop/src/components/shared/PrintDialog.tsx:805,936` |
| §DIM.5 | **P2** | M | Report sách và preview report bình làm tròn khổ tờ tùy chỉnh về số nguyên. UI cho phép bước `0,5 mm`, nên `320,5` có thể bị ghi thành `321 mm`. Kích thước thành phẩm của report sách đã dùng đúng `0,1 mm`; lỗi nằm ở khổ tờ/report. | `BookReportSettings.tsx:60`; `ImposerDashboard.tsx:1156`; `AdvancedSettingsSection.tsx:681`; đối chiếu `desktop/src/lib/bookReport.ts:47-50` |
| §DIM.6 | **P2** | S | Tooltip thumbnail giữ đúng `0,1 mm` nhưng không hoán rộng/cao sau khi xoay trang 90°/270°. Thanh trạng thái đã hoán đúng, vì vậy hai nơi lại có thể báo ngược nhau. | `desktop/src/components/acrobat/ThumbSidebar.tsx:60-68,107-109`; `AcrobatViewer.tsx:1239-1249` |
| §DIM.7 | **P2** | M | Combine cố ý gom kích thước theo bước `0,5 mm`, nhưng lại dùng khóa gần đúng đó làm banner và tên file như kích thước thật. Trang `147,121 × 51,333 mm` có thể mang nhãn nhóm `147x51.5mm`. Không đổi dung sai gom nhóm; chỉ cần trình bày rõ là xấp xỉ hoặc giữ kích thước đại diện chính xác. | `desktop/src/lib/combineGroupBySize.ts:9-11,31-50`; `CombineTab.tsx:1138-1143,1226-1236`; test chủ đích `combineGroupBySize.test.ts:10-13` |
| §DIM.8 | **P3** | S | Luồng `imposePdf` cũ dùng mm nguyên làm khóa phát hiện trang khác khổ. Hai trang lệch dưới khoảng `1 mm` có thể bị coi là cùng khổ và mất cảnh báo. Luồng đã được đánh dấu deprecated nên hiện là nợ tiềm ẩn. | `desktop/src/lib/pdfImposer.ts:40-49,119-129` |
| §DIM.9 | **P3** | S | Cảnh báo Booklet tính fit bằng số thật nhưng làm tròn nguyên khi viết thông báo; có thể tạo câu khó hiểu kiểu “420 × 297 không vừa 420 × 297”. Không ảnh hưởng file xuất. | `desktop/src/lib/pdfImposer.ts:672-697` |
| §DIM.10 | **P3** | S | Panel Đề xuất theo sản phẩm làm tròn khổ thành phẩm trước khi đưa vào advisor; khi bật lại, phương án fit sát mép có thể sai. Tính năng hiện bị ẩn bởi `HIDE_PRODUCT_FIRST=true`, nên chưa tác động người dùng hiện tại. | `ImposerDashboard.tsx:1571-1572`; `desktop/src/lib/featureFocus.ts:13`; `ProductAdvisor.ts:149-162` |
| §DIM.11 | **P3** | M | Nhãn mức tiết kiệm của lồng khuôn bế làm tròn nguyên; giá trị `0,1–0,4 mm` có thể hiện thành `−0 mm`, kể cả khi nhãn được đưa vào PDF nesting. Hình học khuôn vẫn chính xác. | `desktop/src/lib/dieline/nestingEngine.ts:605,612,691,803,810,956,1065,1073,1162,1170,1226,1234`; `exportNestingPDF.ts:142` |

## Các vị trí đã đúng hoặc làm tròn có chủ đích

- Viewer badge mới, StatusBar, thumbnail chưa xoay, GridPreview và DielineCanvas2D đều giữ ít nhất `0,1 mm`.
- Backend metadata giữ `0,01 pt`; không làm mất phần thập phân có ý nghĩa sản xuất.
- Xuất ảnh, bitmap thumbnail, mask và canvas phải dùng pixel nguyên — không phải lỗi mm.
- Cache preview làm tròn `0,01 mm` để ổn định khóa; không dùng làm nhãn kích thước.
- Combine gom theo `0,5 mm` là quyết định có test; vấn đề chỉ là dùng khóa gần đúng như nhãn chính xác.
- Các khổ ISO A/B đang khai báo bằng số nguyên đúng tiêu chuẩn; không cần ép `.0` nếu chỉ là tên preset.

## Đề xuất thứ tự sửa

1. **Lô 1 — report thành phẩm (§DIM.1):** đồng bộ formatter `0,1 mm` ở frontend/backend và thêm test ca `147,1215 × 51,3327` cùng ca `.5`.
2. **Lô 2 — kích thước thật và tài liệu mới (§DIM.2–§DIM.3):** sửa Letter, tóm tắt và tên file; test PDF tạo ra giữ đúng box.
3. **Lô 3 — nhãn sản xuất (§DIM.4–§DIM.6):** Print, report khổ tờ và tooltip xoay; dùng chung formatter nơi hợp lý.
4. **Lô 4 — nhãn gần đúng/nợ tiềm ẩn (§DIM.7–§DIM.11):** giữ nguyên hình học và dung sai nghiệp vụ, chỉ sửa nơi dữ liệu gần đúng đang được trình bày như số chính xác.

Người dùng đã duyệt danh sách và toàn bộ bốn lô trên đã được triển khai, kiểm thử ngày 2026-08-04.
