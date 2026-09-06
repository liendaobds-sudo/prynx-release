# Hồi quy khung bù xén và zoom sau xuất PDF

## Ca người dùng và bằng chứng

Chuỗi thao tác: Bù xén - Tạo đường cắt → tạo PDF → mép bù xén bị cắt ở khung trang;
Ctrl+lăn chuột không zoom, nút kính lúp −/+ có lúc đổi nhưng hình không thay đổi.

Đã đọc output thật `tem_cutcontour_ec084b86.pdf`, tạo lúc 14:14:39, trong session dev
`52be419b2b59439bb86d937d2217cd38`; manifest xác nhận nguồn `test bu xen.pdf`.
Source và output đều có MediaBox `[0, 0, 141.732283, 142.513785]` pt, không CropBox/BleedBox:
khổ vẫn **50 × 50,2757 mm**. Render lại PDF bằng PDFium tái hiện mép bị cắt giống ảnh người dùng.
Do đó đây là lỗi artifact PDF, không chỉ là vùng hiển thị Viewer.

| Mã | Mức | Nguyên nhân đã xác nhận | Baseline |
|---|---|---|---|
| VIEW.1 | P1 | Nhánh giữ artwork PDF gốc/selection không nới MediaBox/CropBox dù đã sinh bleed ngoài trang | Tem sát mép 1 pt, offset 1 mm + bleed 2 mm vẫn bị khóa trong khổ 100 × 100 pt; 2 ca đầu đỏ |
| ZOOM.1 | P2 | Effect đổi file xóa `internalScrollRef` dù DOM scroller Virtuoso còn mounted | Sau path rebase, Ctrl+wheel bị preventDefault nhưng zoom đứng 1 |
| ZOOM.2 | P2 | Row Virtuoso dùng renderer có identity cố định, presentation context thiếu zoom | 200%→250% vẫn rộng 1200 px thay vì 1500; 300%→375% vẫn 1800 thay vì 2250 |

Người dùng đang báo hồi quy của chiến dịch đã duyệt; sửa theo lô backend/Viewer riêng, không đổi
detector, màu, chất lượng, worker cap, dữ liệu nguồn hoặc nội dung ngoài phạm vi.

## Bản sửa

- PDF: union khung nguồn với extent CUT (kể cả nửa độ rộng nét) và SMask/bleed thật; cập nhật
  MediaBox/CropBox/BleedBox, không scale/di chuyển artwork. Giữ TrimBox thành phẩm.
- Trước khi thêm bleed, clip riêng stream artwork gốc theo khung hiển thị cũ để nới CropBox không
  làm lộ lại những phần nguồn vốn đã bị xén. Có test CropBox khác MediaBox, Rotate và UserUnit.
- Viewer: để callback ref quản lý vòng đời scroller, không xóa ref theo vòng đời File.
- Thêm `effectiveZoom` vào presentation revision để row cập nhật kích thước ở mọi mức zoom và
  mọi bố cục; không đổi giới hạn zoom, quality hoặc chính sách tài nguyên.

## Hậu kiểm ảnh của người dùng

Session 14:14 được ứng dụng dọn sau khi đã lấy metadata/render. Dùng bản sao của session 14:02
`e8447e2459b04a6ea860c3d274576760`, cùng source hash và mask simple-bg 591 × 594, không chạy AI.
Hậu kiểm dùng thông số đại diện offset 0 mm, bleed 2 mm, denoise 50; không khẳng định đó là toàn
bộ thiết lập của lần xuất 14:14. File chẩn đoán và harness nằm trong `tmp/pdfs/sticker_bleed_view_20260906`.

Output mới có MediaBox/CropBox `[-6.36, -3.72, 147.96, 148.92]` pt, khoảng **54,44 × 53,85 mm**.
Đã render lại và xem trực tiếp ảnh: thấy đầy đủ vành bù xén. Nguồn `test/test bu xen.pdf` giữ hash
`C601B12447EF362A7F9EAE77AD18630A360E8150B8E85A5174C1A1CFBD10B08B`.

Đã tạo thêm cặp `before_matched.pdf`/`after.pdf` từ cùng mask/thông số, chỉ khác chính sách mở khung
trong process chẩn đoán. Đối chiếu: CUT stream giữ nguyên từng byte (SHA-256
`9e649df500b645c95d9a2e3da5f4ddb132f628ab115373c213ded19fdd7a3b97`), 3 payload image/SMask giữ
nguyên, ma trận ảnh/CUT không đổi, stream artwork nguồn còn nguyên. Không dịch hoặc scale nội dung
để làm cho ảnh “lọt khung”.

## Kiểm chứng và giới hạn

Frontend cuối: 426 tests / 36 file đạt; typecheck và ESLint 2 file Viewer đạt. Backend 422 ca thuộc
10 file đạt qua 421 ca của lượt tổng và 1 ca ProcessPool chạy lại ngoài sandbox sau `WinError 5`;
36 test tập trung và 9 regression mới đều đạt. Không bỏ qua ca lỗi, không cập nhật golden cho xanh.

Các test Viewer dùng AcrobatViewer/Toolbar/Virtuoso thật, mock PDF/tile I/O và frame trong jsdom;
không được tính là thao tác native Tauri. Không build installer,
không push/phát hành và không sửa PDF nguồn/phiên làm việc của người dùng. PDF đã xuất lỗi trước
đó không tự đổi khổ; cần tạo lại từ nguồn sau khi nạp bản sửa.
