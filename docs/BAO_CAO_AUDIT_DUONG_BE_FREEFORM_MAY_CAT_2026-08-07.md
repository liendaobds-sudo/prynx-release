# BÁO CÁO AUDIT ĐƯỜNG BẾ FREEFORM AN TOÀN CHO MÁY CẮT

**Ngày:** 2026-08-07  
**Audit unit:** `W2-U05`  
**Phạm vi:** Bù xén → Bế tem nhãn → contour từ ảnh raster → `/CutContour` trong PDF → đường chạy máy bế  
**Baseline:** `a503c79` + worktree hiện tại (các thay đổi §NOODLE.1–15 chưa commit)  
**Trạng thái:** `TRACED`; đã có artifact baseline nhưng chưa có test tự động cho bất biến chuyển động và chưa chạy máy bế thật

## 1. Tóm tắt điều hành

Các lô §NOODLE.12–15 đã giải quyết đúng hai lỗi trước đó: bùng nổ hàng nghìn node raster và mất topology/lỗ. Tuy nhiên bằng chứng 111/111 artifact cũ chỉ khóa số ring, Hausdorff, diện tích, chu vi và tổng lệnh; nó chưa chứng minh đường chạy an toàn cho máy bế.

Audit mới xác nhận ba lỗi chất lượng chuyển động còn sống trên nhánh freeform:

1. một đường cong trơn có thể bị bộ phát hiện góc chia thành nhiều span với tiếp tuyến độc lập, tạo điểm gãy lớn dù toàn bộ path dùng lệnh cubic;
2. fallback vẫn có thể ghi một cụm đoạn thẳng cực ngắn; tổng node thấp nhưng bộ điều khiển dao vẫn phải đổi hướng/dừng liên tục;
3. guard hiện tại chấp nhận các artifact đó vì không đo góc nối, độ dài lệnh hay độ liên tục độ cong.

Hai artifact rõ nhất:

- Hoa 12 cánh sinh từ hàm cực liên tục `r = 720 + 190 cos(12θ)`, cỡ 1.600 mm: **136 cubic**, nhưng có **16 điểm nối gãy trên 10°**, lớn nhất **53,57°**. Artifact vẫn pass vì Hausdorff **2,231 mm** nằm trong oracle **2,280 mm**.
- Đồng hồ cát 1.600 mm: **25 lệnh `l`**; tính cả đoạn đóng path có **16/26 đoạn ngắn dưới 0,25 mm**, ngắn nhất **0,036 mm**. Artifact vẫn pass vì test chỉ yêu cầu tổng lệnh không quá 512.

Kết luận: nhận xét của người dùng là đúng. Mục tiêu “giảm node” đang che mất bất biến quan trọng hơn là đường chạy liên tục và có khả năng sản xuất.

## 2. Phạm vi và điều không kết luận

Audit này chỉ xét đường cắt sinh từ raster ở chế độ giữ contour/freeform. Không thay đổi hoặc đánh giá lại:

- PDF nguồn đã có `CutContour`;
- hình chuẩn được reconstruction thành circle/ellipse/rect/rounded-rect/triangle;
- màu bù xén, bình tem, nesting hoặc worker pool;
- chất lượng cắt vật lý của một model máy cụ thể — chưa có pilot máy nên chưa được nâng lên `RUNTIME`.

## 3. Đường chạy đã trace

1. UI tạo multipart form và gửi `shape_mode` tại `desktop/src/components/preprocess-tools/StickerTool.tsx:414`, gọi endpoint tại dòng 436 và đọc cảnh báo tại dòng 459.
2. Route sống được đăng ký tại `backend/app/main.py:249`; endpoint thật là `backend/app/api/routes/pdf_tools.py:1258`.
3. Route parse `shape_mode` tại `pdf_tools.py:1345`, chọn policy tại dòng 1432 và gọi `StickerEngine` tại dòng 1478.
4. Policy freeform/adaptive nằm tại `backend/app/core/sticker_cutline_policy.py:4`.
5. Engine lấy contour subpixel bằng `measure.find_contours` tại `backend/app/workers/sticker_engine.py:4945`.
6. Nếu reconstruction hình chuẩn không thắng, nhánh giữ contour gọi `_fit_preserved_contour_paths()` tại `sticker_engine.py:5321`.
7. Fitter freeform nằm tại `sticker_engine.py:1597`; nó simplify trước tại dòng 1672 rồi gọi fitter khóa góc thích ứng.
8. Candidate được nhận theo topology/Hausdorff/số đoạn tại `sticker_engine.py:1738–1748`.
9. Khi fit thất bại, fallback tại `sticker_engine.py:1523` được gọi từ dòng 5333.
10. Cubic đã fit được ghi qua `build_bezier_segments_path_stream()` tại `sticker_engine.py:6059`; fallback polygon đi qua `build_contour_path_stream()` tại dòng 6085.
11. Writer cubic nằm tại `backend/app/workers/cutline_geometry.py:749`; `preserve` không có fitted path sẽ đi polyline tại dòng 800.
12. File kết quả đưa ra ngoài qua route; consumer cuối là RIP/controller máy bế, không nằm trong repository.

## 4. Baseline file khách

File:

`C:\Users\Khanh Pham\Desktop\1784100103383_5435225431418698358_5435225431418698358_959171371f8abf7a17fbc6fb745cb97a.jpg`

Thông tin nguồn:

- 2.281 × 2.275 pixel;
- 531.497 byte;
- JPEG 24-bit RGB;
- metadata 96 DPI;
- artwork là logo gần tròn trên nền trắng.

Harness đặt ảnh thành trang khoảng 805 mm/72 DPI và chạy đúng `StickerEngine`, sau đó mở lại PDF, parse `/CutContour` và đo từng lệnh.

| Chế độ | Kết quả | Lệnh | Gãy nối lớn nhất | Đổi dấu độ cong |
|---|---|---:|---:|---:|
| `auto_safe + preserve` | nhận dạng `cut_kind=circle` | 96 cubic | 0,00033° | 0 |
| ép `shape_mode=contour + preserve` | freeform fitter | 31 cubic | 5,45° | 6 |

Điều này bác bỏ giả thuyết “96 node luôn làm máy lỗi”. Nhánh circle có nhiều lệnh hơn nhánh force-contour nhưng hình học nối trơn gần như tuyệt đối. Root cause là tính liên tục và chất lượng lệnh, không phải riêng số node.

## 5. Ma trận artifact freeform hiện tại

Các ca dưới đây được chạy lại trên chính worktree hiện tại. Reference hình được tạo trước JPEG; output được mở lại từ content stream PDF.

| Hình/cỡ | Lệnh PDF | Hausdorff | Gãy nối >10° | Đoạn <1 mm | Kết luận |
|---|---:|---:|---:|---:|---|
| Tim 20 mm | 12 cubic | 0,233 mm | 2 | 0 | hai cusp/đỉnh thật; cần phân loại anchor |
| Tim 1.600 mm | 35 cubic | 1,993 mm | 2 | 0 | topology đạt, dung sai phình theo pixel nguồn |
| Hoa trơn 20 mm | 50 cubic | 0,191 mm | **24** | **22** | biến cực trị cong thành góc giả |
| Hoa trơn 1.600 mm | 136 cubic | 2,231 mm | **16** | 0 | điểm gãy tới 53,57° vẫn pass |
| Bánh răng 20 mm | 82 cubic | 0,218 mm | 55 | 42 | phần lớn góc thật, nhưng cubic không phải đại diện máy tối ưu |
| Bánh răng 1.600 mm | 90 cubic | 2,136 mm | 82 | 0 | cần phân biệt cạnh/góc thật với span cong |
| Đồng hồ cát 20 mm | 10 cubic | 0,092 mm | 6 | 0 | góc chủ ý được fit bằng cubic |
| Đồng hồ cát 1.600 mm | 25 line | 1,142 mm | 18 | **16** | fallback có min segment 0,036 mm |

Ảnh audit:

- `tmp/research/noodle_audit_2026-08-07/machine_join_customer_force_contour.png` — điểm đỏ là join >1°;
- `tmp/research/noodle_audit_2026-08-07/machine_join_flower_1600mm.png` — điểm đỏ xuất hiện ở các hõm/đỉnh vốn trơn;
- `tmp/research/noodle_audit_2026-08-07/machine_short_hourglass_1600mm.png` — điểm đỏ là các lệnh dưới 0,25 mm.

Số đo đầy đủ nằm trong `tmp/research/noodle_audit_2026-08-07/machine_path_metrics.json`.

## 6. Findings đã xác nhận

### §MOTION.1 — P1 — Guard artifact không kiểm khả năng chạy máy

**Trạng thái:** `[CONFIRMED]` — effort M

`_fit_preserved_contour_paths()` chỉ kiểm empty/valid, topology, tỉ lệ giảm đoạn và Hausdorff tại `sticker_engine.py:1738–1748`. Không có guard cho:

- góc gãy tiếp tuyến tại join;
- bước nhảy độ cong;
- lệnh cực ngắn;
- curvature sign flip mới;
- bán kính cong hoặc mật độ đổi hướng.

Bằng chứng thực thi: hoa 1.600 mm và đồng hồ cát 1.600 mm đều pass oracle hiện tại dù vi phạm các bất biến chuyển động nêu trên.

### §MOTION.2 — P1 — High curvature trơn bị nhận nhầm thành góc thật

**Trạng thái:** `[CONFIRMED]` — effort L

`_closed_ring_corner_indices()` tại `cutline_geometry.py:463` xác định corner theo góc quay tích lũy trên cửa sổ vật lý và persistence đa thang. Persistence phân biệt được bậc pixel với đặc trưng lớn, nhưng chưa phân biệt:

- discontinuity tiếp tuyến thật;
- cực trị độ cong lớn nhưng vẫn trơn.

Sau khi một điểm được gọi là corner, `fit_closed_cubic_beziers_adaptive()` tại dòng 564 chia ring thành span và dùng tiếp tuyến riêng hai phía. Hoa audit được sinh từ một hàm liên tục, không có cusp, nhưng output có 16–24 join gãy lớn. Đây là bằng chứng trực tiếp corner classifier đã khóa sai loại đặc trưng.

### §MOTION.3 — P1 — Fallback ít node vẫn chứa cụm đoạn không sản xuất được

**Trạng thái:** `[CONFIRMED]` — effort M

Fallback tại `sticker_engine.py:1523` dùng simplify theo pixel và giữ topology/Hausdorff, nhưng không gộp các đoạn gần trùng hoặc kiểm độ dài lệnh trước writer. Với `corner_style=preserve`, writer tại `cutline_geometry.py:800` xuất mỗi cạnh polygon thành `l`.

Đồng hồ cát 1.600 mm chỉ còn 25 lệnh `l`, vì vậy vượt qua mục tiêu giảm node. Tuy nhiên 16 đoạn nhỏ hơn 0,25 mm và đoạn ngắn nhất 0,036 mm tạo cụm đổi hướng dày quanh các anchor. Tổng node thấp không làm artifact này an toàn hơn cho controller.

### §MOTION.4 — P1 — Simplify diễn ra trước khi khóa đặc trưng và node reduction là điều kiện nhận

**Trạng thái:** `[CONFIRMED]` — effort L

Tại `sticker_engine.py:1672–1680`, `ideal_cut_geometry` bị simplify theo các fraction 0,90/0,75/0,60/0,45 của budget trước khi gọi corner detector. Như vậy corner/notch/điểm uốn được tìm trên geometry đã thay đổi, không phải reference bất biến.

Tại dòng 1743, candidate còn bị loại nếu số cubic không giảm ít nhất khoảng 15% so với fallback. Điều kiện này biến “ít node” thành mục tiêu correctness, dù không chứng minh được chuyển động tốt hơn.

Đây đúng với quan sát người dùng: giảm node có thể làm thay đổi quỹ đạo gốc, còn giữ fallback lại có thể sinh đường gãy.

### §MOTION.5 — P2 — Ngân sách sai lệch tự phình theo pixel nhưng không có trạng thái độ tin cậy

**Trạng thái:** `[CONFIRMED]` — effort M

Các hằng tại `sticker_engine.py:717–722` cho phép fitter dùng 2 pixel nguồn và fallback dùng tới 3 pixel. Với artwork 2.281 px kéo lên 1.600 mm, một pixel xấp xỉ 0,701 mm. Oracle artifact hiện tại cho phép 3,25 pixel, tức khoảng 2,280 mm.

Ngân sách theo pixel là hợp lý để mô tả giới hạn dữ liệu nguồn, nhưng không được coi là dung sai sản xuất. Hiện API/UI không phân biệt “đường nằm trong độ bất định của ảnh” với “đường đạt dung sai máy bế”. Vì vậy artifact có thể pass trong khi lệch vài mm.

### §MOTION.6 — P2 — Test hiện tại khóa số lượng lệnh, chưa khóa chất lượng lệnh

**Trạng thái:** `[CONFIRMED]` — effort M

Regression freeform tại `backend/tests/test_sticker_engine_e2e.py:1262` chỉ yêu cầu:

```python
1 <= line_count + cubic_count <= 512
```

Không có oracle tangent, curvature hoặc minimum command length. Chạy lại bộ test mục tiêu cho kết quả **22 passed, 108 deselected**, trong khi chính artifact của các test đó có lỗi chuyển động đã đo. Test xanh hiện tại vì thế không phủ hợp đồng mới, không phải bằng chứng phủ định lỗi.

## 7. Các giả thuyết đã bác bỏ hoặc chưa chứng minh

### `[DISPROVED]` Nhiều node tự nó gây răng cưa

Circle file khách có 96 cubic, không có join >1°, curvature ổn định và chu vi/bao lồi bằng 1. Số lệnh chỉ là một phần; loại lệnh và continuity mới quyết định chuyển động.

### `[DISPROVED]` Chỉ cần thêm classifier cho từng hình

Hoa trơn, đồng hồ cát, tim và gear đi qua cùng nhánh freeform. Thêm classifier cho từng hình không đóng được lớp lỗi high-curvature/corner/fallback chung.

### `[SUSPECTED]` Thay trực tiếp bằng `scipy.interpolate.splprep` là đủ

Prototype tạm trên hoa 20 mm đạt seam `C2` và Hausdorff lấy mẫu 0,240 mm nhưng cần 76 span, nhiều hơn 50 cubic hiện tại. Profile 1.600 mm chưa được chứng minh đạt ngân sách trong bake-off này. Vì vậy không phê duyệt giải pháp “đổi một hàm sang splprep”; cần adaptive knot, feature split và guard riêng.

## 8. Hợp đồng sản xuất đề xuất

### 8.1 Reference

- Giữ contour subpixel từ mask làm `reference_contour` bất biến.
- Không simplify reference trước khi phát hiện/đánh giá đặc trưng.
- Mọi candidate cuối phải đo lại so với reference và artifact PDF.

### 8.2 Phân loại đặc trưng

- Corner thật phải có discontinuity tiếp tuyến một phía bền qua nhiều scale.
- High curvature trơn được phép thêm knot nhưng không được tách continuity.
- Notch/cusp/cổ hẹp được khóa theo vị trí và topology.
- Đoạn thẳng thật được phép xuất `l`; organic smooth không được rơi về chuỗi `l`.

### 8.3 Fitter

- Vòng không góc: periodic cubic spline `C2`.
- Vòng có corner thật: chia tại protected anchor; mỗi span trơn `C2`, tại anchor giữ tangent một phía.
- Thêm knot tại nơi sai lệch pháp tuyến lớn nhất; sau khi đạt thì thử xóa knot thừa.
- Số lệnh là thành phần của hàm mục tiêu, không phải hard-cap correctness.
- Chuyển spline chính xác thành cubic Bézier và dùng writer hiện có.

### 8.4 Guard máy bế

- topology/component/ring/winding giữ nguyên;
- max normal error và Hausdorff hai chiều trong budget;
- ánh xạ tiến dọc contour hoặc discrete Fréchet;
- join vùng trơn mục tiêu ≤1° và ưu tiên continuity theo construction;
- không tạo curvature sign flip mới ngoài reference;
- không có lệnh ngắn dưới ngưỡng profile máy, trừ khi được hợp nhất vào corner thật;
- không tự cắt/loop;
- kiểm actual `/CutContour` sau khi ghi PDF.

### 8.5 Fail-safe

Nếu không đồng thời đạt fidelity và machine-safety:

- không fallback polyline dày;
- trả trạng thái có cấu trúc như `unsafe_low_resolution` hoặc `unsafe_geometry`;
- UI hiển thị nguyên nhân và độ bất định nguồn;
- đề xuất mặc định: không xuất `CutContour` không an toàn nếu người dùng chưa xác nhận.

Ngưỡng minimum command length và dung sai sản xuất phải được chốt bằng pilot máy; audit tạm dùng 0,25 mm chỉ để phát hiện cụm lệnh bất thường, không đề xuất hardcode cho mọi máy.

## 9. Lô sửa đề xuất sau khi duyệt

### Lô A — Metric/oracle máy bế, tối đa 4 file

1. Thêm module `backend/app/workers/cutline_machine_path.py` cho metric segment/join/curvature, không làm nặng `cutline_geometry.py` thuần stdlib.
2. Thêm unit test cho tangent, curvature, short segment và chuyển cubic → PDF.
3. Chuyển các số đo audit thành regression production.

Điều kiện qua: test phải đỏ trên artifact cũ và xanh với fixture chuẩn; chưa đổi output engine.

### Lô B — Reference + feature-aware constrained fitter, tối đa 5 file

1. Giữ reference trước simplify.
2. Thay corner-by-turn bằng classifier tangent-discontinuity + curvature persistence.
3. Fit periodic/split spline với adaptive knot và fairness penalty.
4. Bỏ điều kiện `segment_count < 0,85 × fallback_nodes` khỏi correctness.

Điều kiện qua: hoa trơn không có join >1°; tim/gear/hourglass vẫn giữ corner thật và topology.

### Lô C — Tích hợp engine và fail-safe, tối đa 4 file

1. Freeform dùng machine-safe fitted path.
2. Cấm polyline fallback dày/cụm đoạn ngắn.
3. Trả quality metadata theo trang.
4. Giữ nguyên existing CutContour và reconstruction hình chuẩn.

Điều kiện qua: PDF mở lại đạt mọi guard; không hồi quy §NOODLE.1–15.

### Lô D — API/UI cảnh báo, tối đa 5 file

1. Route truyền trạng thái machine safety và source uncertainty.
2. UI hiển thị “đạt”, “nguồn độ phân giải thấp” hoặc “geometry chưa an toàn”.
3. Bổ sung i18n Việt/Anh và route/UI test.

Điều kiện qua: không có silent fallback; client cũ vẫn nhận lỗi/warning có nghĩa.

### Lô E — Artifact + runtime pilot, tối đa 3 file tài liệu/test

1. Chạy lại 56 topology + 25 JPEG khách + 30 hình chuẩn/sao.
2. Thêm ma trận motion quality cho organic/polygon/hole/multi-component.
3. Backend full, frontend typecheck/test, Poppler zoom, Nuitka smoke.
4. Xuất tờ pilot và chạy máy bế thật.

Điều kiện qua: chỉ nâng `W2-U05` lên `ARTIFACT` sau test tự động + PDF thực; chỉ lên `RUNTIME` sau pilot máy.

## 10. Quyết định cần duyệt

Đề nghị duyệt các finding §MOTION.1–6 và thứ tự Lô A→E. Trước khi Lô D/E cần chốt thêm hai giá trị theo máy thực:

1. dung sai bám quỹ đạo sản xuất theo mm;
2. độ dài lệnh tối thiểu máy chạy ổn định.

Cho tới khi có hai số đó, phần core vẫn có thể triển khai theo profile cấu hình và dùng ngưỡng regression bảo thủ; không hardcode một giới hạn chung cho mọi máy.

