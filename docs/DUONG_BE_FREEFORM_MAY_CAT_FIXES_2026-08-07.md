# SỬA ĐƯỜNG BẾ FREEFORM AN TOÀN CHO MÁY CẮT — 2026-08-07

Theo báo cáo `BAO_CAO_AUDIT_DUONG_BE_FREEFORM_MAY_CAT_2026-08-07.md`.

## Lô A — Metric/oracle machine-path

**Trạng thái:** hoàn tất ở mức tự động; chưa thay đổi output của `StickerEngine`.

### File

- `backend/app/workers/cutline_machine_path.py` — module mới đo actual line/cubic;
- `backend/tests/test_cutline_machine_path.py` — regression cho continuity, curvature, short command và parity với writer;
- `docs/PRYNX_MASTER_AUDIT_MATRIX.md` — cập nhật `W2-U05`;
- tài liệu này.

### Thay đổi

1. Chuẩn hóa lệnh đường bế thành `MachinePathSegment` line/cubic bốn điểm.
2. Đo theo mm:
   - tổng/loại lệnh;
   - chiều dài tổng, min/P10/median;
   - số và tỉ lệ lệnh ngắn;
   - endpoint gap;
   - góc gãy tangent tại join;
   - bước nhảy curvature;
   - số lần đổi dấu curvature.
3. Ngưỡng tangent và short-command bắt buộc do tầng gọi truyền vào. Module không hardcode profile máy và không cap số node.
4. Module chỉ dùng stdlib, không kéo SciPy/OpenCV/PDFium và chưa nằm trên đường chạy production.

### Regression

- circle 4 cubic: nhiều lệnh nhưng join/curvature liên tục;
- cubic có handle sai hướng: phát hiện join gãy dù tổng node thấp;
- ring có đoạn 0,036 mm: phát hiện short-command;
- bất biến mm ↔ PDF point;
- endpoint hở và segment suy biến;
- path S đổi dấu curvature;
- tuple fitter hiện tại và số lệnh `c` của writer PDF khớp metric;
- profile âm/không hợp lệ fail-fast.

### Verify

- `py_compile`: đạt;
- `pytest tests/test_cutline_machine_path.py tests/test_cutline_contour.py -q`: **23 passed**;
- warning duy nhất: Pydantic class-based config đã có sẵn, ngoài phạm vi;
- microbenchmark 12.000 line segment: **0,0827 giây**, đủ 12.000 join, không dùng cap.

### Phạm vi chưa đạt

- `StickerEngine` chưa gọi metric mới;
- chưa có machine-safety policy/fail-safe;
- artifact cũ chưa đổi;
- `W2-U05` giữ `TRACED`, chưa nâng `AUTO/ARTIFACT`.

## Lô kế tiếp sau khi xác nhận

Lô B sẽ giữ reference contour bất biến, phân biệt góc thật với high-curvature trơn và xây constrained fitter. Điều kiện đầu ra: hoa trơn không có join gãy >1°, còn tim/gear/hourglass giữ đúng góc thật và topology.

## Lô B — Reference-aware constrained fitter

**Trạng thái:** hoàn tất ở mức tự động + artifact; chờ xác nhận trước Lô C.

### File

- `backend/app/workers/cutline_geometry.py` — dò gián đoạn tiếp tuyến trên reference và fit G1;
- `backend/app/workers/sticker_engine.py` — truyền ring gốc/pixel nguồn, giữ guard topology/Hausdorff;
- `backend/tests/test_cutline_contour.py` — regression tim/hoa/gear/hourglass ở hai tỷ lệ;
- `backend/tests/test_sticker_engine_e2e.py` — regression hoa phóng lớn sau nội suy render;
- tài liệu này.

### Thay đổi

1. Reference contour không còn bị simplify trước khi phân loại feature. Anchor đã simplify chỉ dùng để fit; geometry gốc vẫn là chuẩn cuối cho topology và Hausdorff.
2. Góc thật được xác nhận bằng hai tiếp tuyến một phía ngoại suy bậc hai, qua ba thang đo theo độ dài cung. Cửa sổ tối thiểu theo sáu pixel ảnh nguồn để không khóa ringing/JPEG của ảnh phóng lớn thành góc giả.
3. Cực trị cong mượt không tách span. Hai điểm chia kỹ thuật của ring dùng chung tiếp tuyến; split đệ quy cũng giữ hướng tiếp tuyến chung.
4. Guard đơn điệu co độ dài tay nắm Bézier thay vì đổi hướng tay nắm sang chord — cách cũ tạo khớp gãy ở chính các split nội bộ.
5. Tim/gear/hourglass vẫn giữ tiếp tuyến độc lập tại góc đã xác nhận. Nhánh cusp riêng giữ notch/tip bị nội suy làm yếu ở thang đo nhỏ.
6. Bỏ điều kiện `segment_count >= fallback_nodes * 0.85` khỏi tiêu chí đúng/sai. Số node không còn được dùng thay cho topology, Hausdorff hay chất lượng chuyển động.
7. Polygon/ring của MultiPolygon được ghép lại với reference gần nhất cùng số lỗ trước khi fit; không dựa mù vào thứ tự Shapely.

### Số đo artifact

Artifact: `tmp/research/noodle_audit_2026-08-07/batch_b_shape_size_metrics.json` và `customer_force_contour_batch_b.json`.

- Hoa 12 cánh 1600 mm: **170 → 104 cubic**; góc join lớn nhất **51,58° → 0,00064°**; join >1° **129 → 0**; đoạn ngắn nhất **10,93 mm**; Hausdorff **2,231 mm ≤ 2,280 mm**.
- Tim 1600 mm: **35 cubic**, đúng **2 join có chủ đích** tại notch/tip; không có đoạn dưới 1 mm; Hausdorff **1,993 mm ≤ 2,280 mm**.
- Gear 20 răng 1600 mm: **95 cubic**, đủ **80 join góc có chủ đích**; không có đoạn dưới 1 mm; Hausdorff **2,136 mm ≤ 2,280 mm**.
- Ảnh khách hàng, ép contour 1600 mm: **18 cubic**, join lớn nhất **0,000074°**, không có đoạn dưới 1 mm; curvature sign flip **4** (baseline cùng ca: 31 cubic, 5,45°, 6 flip).
- Cả 8 ca tim/hoa/gear/hourglass tại 20 và 1600 mm giữ nguyên số ring và qua guard hình học của engine, ngoại trừ fixture hoa 20 mm còn sai số diện tích 4,166% so với ngưỡng ma trận 4% đã có; topology/Hausdorff vẫn đạt. Đây không phải hồi quy join của tem lớn.

### Verify

- `py_compile` bốn file Python: đạt;
- `pytest tests/test_cutline_machine_path.py tests/test_cutline_contour.py tests/test_sticker_engine_e2e.py -q`: **145 passed**;
- cảnh báo duy nhất: Pydantic class-based config đã có sẵn, ngoài phạm vi;
- ma trận artifact 8 ca: xuất PDF thật rồi đọc lại lệnh `l/c`; các ca cubic không có đoạn ngắn ngoài những góc có chủ đích.

### Còn lại cho Lô C

- Hourglass 1600 mm vẫn rơi về fallback polyline: 26 lệnh kể cả close, 16 đoạn dưới 0,25 mm, ngắn nhất 0,036 mm.
- Hoa 20 mm vẫn có 12 join tại cực trị do contour chỉ còn độ phân giải render 300 DPI; không phải hiện tượng tăng node theo kích thước, nhưng cần machine-safety policy chọn candidate theo actual motion thay vì chỉ hình học.
- Lô C sẽ đưa metric Lô A vào bước chọn candidate/fail-safe, xử lý polyline fallback và đoạn ngắn. Không hard-cap số node.

## Lô C — Chọn quỹ đạo theo chuyển động thực

**Trạng thái:** hoàn tất ở mức tự động + artifact; chưa pilot trên máy bế vật lý.

### File

- `backend/app/workers/sticker_engine.py` — sinh ba ứng viên và chọn theo metric chuyển động;
- `backend/app/workers/cutline_machine_path.py` — cho phép tầng policy truyền sàn nhiễu curvature theo `1/mm`;
- `backend/tests/test_cutline_machine_path.py` — regression nhiễu lượng tử gần thẳng;
- `backend/tests/test_sticker_engine_e2e.py` — đọc lại chính lệnh PDF và khóa tim/hoa/gear/hourglass tại 20/1600 mm;
- tài liệu này.

### Thay đổi

1. Mỗi mức simplify thử ba ứng viên trên cùng tập neo: adaptive 38°, adaptive 18° và Catmull–Rom G1 tension 0,10. Reference contour gốc vẫn bất biến.
2. Mọi ứng viên phải qua validity, topology và Hausdorff hiện có trước khi được xếp hạng. Không candidate nào được nhận chỉ vì ít node.
3. Thứ tự chọn: không có lệnh dưới 0,25 mm → bảo vệ cusp thưa → ít đổi dấu curvature có nghĩa → ít join giả → ít segment. Ngưỡng 0,25 mm chỉ là tín hiệu xếp hạng của audit, không phải hard reject/profile chung cho mọi máy.
4. Một hoặc hai join cùng vượt 110° trên nhánh adaptive được giữ như cusp thật. Điều này ngăn Catmull xóa notch/tip của tim chỉ vì nó có ít curvature flip hơn.
5. Sàn nhiễu curvature là `0,10 / đường chéo hình (mm)`, nên cùng một quỹ đạo co/phóng giữ cùng kết luận. Nó bỏ đảo dấu do content stream làm tròn 4 chữ số nhưng không che path S/hoa thật.
6. Không đặt trần node. Số segment chỉ phá hòa sau fidelity và chất lượng chuyển động.

### Số đo artifact PDF cuối

Artifact: `tmp/research/noodle_audit_2026-08-07/batch_b_shape_size_metrics.json`, đọc lại lệnh `/CutContour` sau khi ghi PDF.

- Tim 20 mm: **11 cubic**, đúng **2 cusp**, đoạn ngắn nhất **1,320 mm**, Hausdorff **0,233 mm**, 8 curvature flip có nghĩa.
- Hoa 12 cánh 20 mm: **53 cubic**, join lớn nhất **0,056°**, **0 join >1°**, đoạn ngắn nhất **0,343 mm**, Hausdorff **0,105 mm**.
- Gear 20 răng 20 mm: **79 cubic**, 76 join >10° còn sống sau raster 300 DPI, đoạn ngắn nhất **0,277 mm**, Hausdorff **0,217 mm**, 8 curvature flip sau lọc nhiễu theo tỷ lệ.
- Tim 1600 mm: **35 cubic**, đúng **2 cusp**, đoạn ngắn nhất **22,219 mm**, Hausdorff **1,993 mm**.
- Hoa 12 cánh 1600 mm: **104 cubic**, **0 join >1°**, đoạn ngắn nhất **10,935 mm**, Hausdorff **2,231 mm**.
- Gear 20 răng 1600 mm: **95 cubic**, 82 join >10°, đoạn ngắn nhất **1,932 mm**, Hausdorff **2,136 mm**, 22 curvature flip sau lọc nhiễu theo tỷ lệ.
- Hourglass 1600 mm: **26 line → 10 cubic**; đoạn dưới 0,25 mm **16 → 0**; đoạn ngắn nhất **0,036 → 158,500 mm**; đủ 10 góc chủ đích; curvature flip **0**; Hausdorff **1,142 mm**.
- Cả **8/8** ca tim/hoa/gear/hourglass tại 20 và 1600 mm giữ đúng số ring, đạt topology/Hausdorff và không có lệnh dưới 0,25 mm.

Ảnh khách hàng gốc
`C:\Users\Khanh Pham\Desktop\1784100103383_5435225431418698358_5435225431418698358_959171371f8abf7a17fbc6fb745cb97a.jpg`, ép contour 1600 mm:

- **70 cubic**, không line;
- join lớn nhất **0,000527°**, **0 join >1°**;
- đoạn ngắn nhất **31,534 mm**;
- curvature flip **0**;
- ellipse residual RMS **0,386 mm**, max **0,972 mm**.

Số cubic tăng từ 18 ở Lô B lên 70 vì Lô C ưu tiên quỹ đạo trơn không đổi dấu hơn số node. Đây là thay đổi có chủ đích: 70 lệnh đều dài và nối G1, không phải bùng node raster.

### Verify

- `py_compile` bốn file Python: đạt;
- `pytest tests/test_cutline_machine_path.py tests/test_cutline_contour.py tests/test_sticker_engine_e2e.py -q`: **150 passed** trong 95,32 giây;
- cảnh báo duy nhất: Pydantic class-based config đã có sẵn, ngoài phạm vi;
- ma trận artifact PDF 8 ca: **8/8 đạt**;
- file khách hàng gốc, ép contour 1600 mm: xuất/đọc lại PDF thành công, số đo như trên.

### Phạm vi còn lại

- Chưa chạy trên controller/máy bế thật, nên chưa tuyên bố mức `RUNTIME` hoặc dùng 0,25 mm làm chuẩn máy chung.
- Khi có profile máy cụ thể, ngưỡng lệnh ngắn và dung sai sản xuất cần đi từ profile đó; policy hiện tại chỉ dùng chúng để so sánh các ứng viên cùng đạt fidelity.
