# BÁO CÁO AUDIT ĐƯỜNG CẮT TỪ ẢNH TEM LỚN

**Ngày:** 2026-08-07  
**Phạm vi:** Bù xén → Bế tem nhãn → Bỏ nền trắng → tạo `CutContour` từ JPEG/PNG  
**Mẫu lỗi:** `1784100103383_5435225431418698358_5435225431418698358_959171371f8abf7a17fbc6fb745cb97a.jpg`  
**SHA-256:** `9846DE6C568E31EFA643BB5147A329C1A15E58AAFCF66E2DB54072183393DD26`  
**Baseline Git:** `a503c79`; worktree có sẵn thay đổi chưa commit trong `backend/app/workers/sticker_engine.py`, audit giữ nguyên thay đổi này và đo riêng trước/sau nó.

> **Cập nhật cùng ngày:** kết luận `ARTIFACT` ở mục 12 chỉ phủ bốn họ hình chuẩn và
> một hình sao. Ma trận topology mở rộng ở mục 13–16 đã bác bỏ kết luận “đảm bảo
> mọi hình học” và hạ trạng thái luồng về `PARTIAL`.

## 1. Kết luận điều hành

Đã **tái hiện đúng lỗi “sợi mì”** trên artifact PDF sinh từ chính ảnh khách cung cấp. Đây không chỉ là vấn đề thiếu làm mượt. Lỗi là chuỗi ba tầng:

1. ảnh JPEG không có DPI được mở đúng theo fallback hiện hành là 72 DPI, thành trang khoảng **804,69 × 802,57 mm**; mỗi pixel nguồn tương ứng khoảng **0,353 mm**;
2. nhiễu nén quanh biên sinh ra nhiều mảnh contour có diện tích lớn hơn ngưỡng cố định 1 mm², nên một con tem tròn bị hiểu thành `MultiPolygon` gồm **7–12 đường cắt**;
3. khi geometry là `MultiPolygon`, nhánh tự nhận/dựng lại hình tròn bị bỏ qua; chế độ giữ nguyên biên cũng thất bại guard rồi rơi về polyline dày đặc. Vì vậy writer xuất đúng cái biên raster ngoằn ngoèo mà người dùng đang thấy.

Thay đổi thử nghiệm đang có trong worktree — tăng cửa sổ trung bình trượt theo kích thước pixel ảnh nguồn — **có cải thiện rõ nhưng chưa đóng lỗi**: số đường cắt vẫn là 7, sai lệch cực đại vẫn hơn 2,25 mm và biên vẫn còn lượn sóng thấp tần.

**Trạng thái:** 5 finding đã xác nhận (`P1 × 3`, `P2 × 2`). Chưa sửa production trong pha audit này; chờ duyệt kế hoạch ở mục 8.

## 2. Luồng đã truy vết

| Tầng | Điểm vào/điểm quyết định | Hợp đồng quan trọng |
|---|---|---|
| Mở ảnh | `desktop/src/lib/imageNormalizer.ts` | JPEG không có DPI → 72 DPI; giữ nguyên DCT và kích thước pixel |
| UI Bù xén | `desktop/src/components/preprocess-tools/StickerTool.tsx` | gửi `corner_style`, `shape_mode`, `remove_white_bg`, `draw_cut_contour` |
| API | `backend/app/api/routes/pdf_tools.py:/pdf-tools/sticker-dieline` | chuẩn hóa policy và gọi `StickerEngine(dpi=300)` |
| Mask/contour | `backend/app/workers/sticker_engine.py` | nền trắng 248; soft band; marching squares; lọc contour theo 1 mm² |
| Dựng hình | `backend/app/workers/sticker_cut_reconstruct.py` | `auto_safe` nhận circle/ellipse/rect/triangle với guard residual/defect |
| Ghi artifact | `backend/app/workers/sticker_engine.py` → `build_contour_path_stream` | ghi spot color `/CutContour`; polyline hoặc cubic Bézier |

## 3. Cách tái hiện và artifact

### 3.1 Đầu vào

- JPEG: `2281 × 2275 px`, RGB, 531.497 byte.
- JFIF density unit bằng 0, không có DPI vật lý đáng tin cậy.
- Theo đúng `imageNormalizer`, PDF trung gian có trang `2281 × 2275 pt`, tương đương **804,69 × 802,57 mm**.
- Ảnh là logo gần tròn, nền trắng; đường cắt dự kiến là một vòng ngoài duy nhất.

### 3.2 Ma trận chạy thật

Chạy engine thật trên PDF trung gian, parse lại content stream `/CutContour`, đo mọi ring và render PDF bằng Poppler.

| Ca | Số path | Lệnh line `l` | Lệnh cubic `c` | Chu vi / bao lồi của path chính | RMS so ellipse | P95 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mặc định `preserve + contour + adaptive` | **12** | **7.937** | 0 | 1,2473 | 0,721 mm | 1,481 mm | **3,006 mm** |
| `round + auto_safe`, trước thay đổi thử nghiệm | **7** | 0 | **1.561** | 1,2459 | 0,664 mm | 1,383 mm | **2,554 mm** |
| `round + auto_safe`, sau thay đổi thử nghiệm | **7** | 0 | **666** | 1,0445 | 0,626 mm | 1,240 mm | **2,257 mm** |

`Chu vi / bao lồi = 1,0` là biên lồi mượt; 1,2459 cho thấy chiều dài đường cắt bị đội khoảng 24,6% do lượn sóng.

Các artifact khảo sát nằm ở `tmp/research/noodle_audit_2026-08-07/`:

- `source_72dpi.pdf`: PDF đầu vào theo đúng quy tắc mở ảnh của frontend;
- `preserve_adaptive.pdf`: hành vi mặc định;
- `round_auto_before_noodle.pdf`: baseline khi vô hiệu riêng thay đổi thử nghiệm;
- `round_auto_after_noodle.pdf`: worktree hiện tại;
- `matrix.json`, `path_metrics.json`: số đo parse từ PDF đã ghi và mở lại.

## 4. Finding có bằng chứng

### §NOODLE.1 — P1 — Bộ lọc contour vụn dùng ngưỡng tuyệt đối nên để lọt nhiễu JPEG trên tem lớn

**Trạng thái:** `CONFIRMED`

`_MIN_CONTOUR_AREA_MM2 = 1.0` chỉ bỏ mảnh nhỏ hơn 1 mm². Trên ảnh mẫu 805 mm, nhiễu nén kéo dài theo biên tạo các mảnh sống sót như:

- 1,754 mm², bbox 1,97 × 1,08 mm;
- 1,737 mm², bbox **0,28 × 8,62 mm**;
- 1,592 mm², bbox 0,90 × 2,37 mm;
- 1,413 mm², bbox 2,08 × 1,47 mm;
- 1,364 mm², bbox 1,30 × 1,46 mm.

Kết quả: một tem tròn có một silhouette chính bị biến thành 7 path ở nhánh `round`, hoặc 12 path ở nhánh `preserve`. Nếu đem đi bế, các path rác này cũng là lệnh cắt thật.

Ngưỡng không thể đơn giản tăng lên một giá trị tuyệt đối lớn hơn: test hiện có cố ý giữ lỗ treo khoảng 3,14 mm². Cần phân loại theo **tỷ lệ với thành phần chính + hình dạng/bbox + ngữ cảnh một ảnh phủ trang**, đồng thời giữ fail-safe cho artwork nhiều thành phần hợp lệ.

### §NOODLE.2 — P1 — Hợp đồng UI nói “mặc định auto” nhưng cấu hình mặc định thực tế cưỡng bức `contour`

**Trạng thái:** `CONFIRMED`

Trong `StickerTool.tsx`, comment và state `forceContour` nói mỗi file mặc định dùng `auto_safe`. Tuy nhiên:

- `cornerStyle` mặc định là `preserve`;
- payload đặt `shape_mode = contour` khi `cornerStyle === preserve`;
- backend lại cưỡng bức `shape_mode = contour` lần nữa cho mọi `preserve/original`.

Vì vậy đường mặc định của ảnh mẫu **không bao giờ thử nhận hình tròn**, không trả `cut_kind` hữu ích cho van an toàn UI, và rơi về artifact 7.937 đoạn thẳng. Đây là drift giữa ý đồ UI và payload/runtime.

### §NOODLE.3 — P1 — Một mảnh nhiễu làm “đầu độc” toàn geometry và vô hiệu hóa dựng hình an toàn

**Trạng thái:** `CONFIRMED`

Sau `unary_union(exteriors)`, engine chỉ gọi `reconstruct_cut_coords(...)` nếu toàn geometry có `geom_type == Polygon`. Chỉ cần một mảnh nhiễu sống sót là geometry thành `MultiPolygon`; nhánh dựng hình bị bỏ qua cho toàn trang.

Đối chứng mạnh:

- artifact `round + auto_safe` hoàn chỉnh: 7 path, `reconstructed = false`, biên “sợi mì”;
- lấy **riêng path lớn nhất** của chính artifact đó và đưa vào cùng `reconstruct_cut_coords`: nhận đúng `kind = circle`, `reason = auto_safe_accept`, dựng lại thành **96 điểm**.

Nhánh `preserve + adaptive` cũng xử lý/guard geometry theo toàn bộ tập thành phần. Với ảnh mẫu, candidate không đạt guard và cả trang fallback về polyline bảo thủ. Guard fail-safe đang làm đúng chức năng; lỗi nằm ở việc không cô lập thành phần nhiễu hoặc xử lý từng thành phần độc lập trước guard.

### §NOODLE.4 — P2 — Thay đổi tăng cửa sổ làm mượt hiện tại chỉ che triệu chứng

**Trạng thái:** `CONFIRMED`

Thay đổi chưa commit đo kích thước pixel ảnh nguồn và tăng moving-average window từ 1 mm lên khoảng 4,2 mm cho ca 805 mm. Nó làm chu vi/bao lồi giảm từ 1,2459 xuống 1,0445 và cubic từ 1.561 xuống 666 — đây là tín hiệu tốt.

Nhưng thay đổi chưa đủ để duyệt production:

- vẫn xuất 7 path, gồm các lệnh cắt rác;
- path chính vẫn có sai lệch max 2,257 mm và còn sóng thấp tần khi render;
- không có guard Hausdorff/topology riêng cho moving average;
- làm mượt mọi contour thay vì sửa quyết định “đâu là tem thật”; hình hẹp/hình có chi tiết chủ ý có nguy cơ bị bo khác thiết kế.

Nên giữ phép đo `source_pixel_mm` làm tín hiệu đầu vào, nhưng không dùng nó như bản sửa duy nhất.

### §NOODLE.5 — P2 — Test hiện có xanh nhưng oracle không phủ artifact thật và số thành phần

**Trạng thái:** `CONFIRMED`

Đã chạy nhóm test liên quan trên worktree hiện tại:

```text
123 passed, 1 warning in 28.48s
py_compile sticker_engine.py: pass
```

Khoảng trống:

- `test_sticker_contour_area_filter.py` chỉ dùng vòng tròn JPEG tổng hợp ở 20/50/200 mm; nhiễu của fixture đều rơi dưới 1 mm²;
- `test_sticker_band_soft.py` có 800 mm nhưng chỉ đo profile bán kính của **contour dài nhất**, không kiểm số contour sống sót và không đọc PDF writer;
- chưa có regression dùng JPEG thật/đại diện tương đương qua toàn luồng image → PDF → engine → reopen `/CutContour`;
- chưa có oracle `path_count`, `line/cubic count`, `cut_kind`, thành phần rác, Hausdorff và render artifact cho ca này.

Do đó test xanh không phủ nhận lỗi người dùng; nó chỉ xác nhận các helper riêng lẻ vẫn đúng với fixture tổng hợp hiện tại.

## 5. Giả thuyết đã loại trừ

| Giả thuyết | Kết luận | Bằng chứng |
|---|---|---|
| Chỉ cần tăng DPI render hoặc bỏ cap 6.000 px | `DISPROVED` là cách chữa gốc | ảnh nguồn chỉ có 2.281 px trên 805 mm; nội suy lên nhiều pixel hơn không khôi phục biên đã nén, mỗi pixel nguồn vẫn biểu diễn 0,353 mm |
| Soft band 0,5 mm đã đủ cho mọi tem lớn | `DISPROVED` | giảm răng marching-square nhưng không loại các island >1 mm² và sóng JPEG vài pixel nguồn |
| Chỉ tăng moving-average window | `PARTIAL` | chu vi cải thiện mạnh nhưng path rác, sai lệch >2 mm và sóng thấp tần vẫn còn |
| Bộ nhận dạng hình tròn không nhận được logo này | `DISPROVED` | path chính đứng riêng được nhận là circle và dựng lại 96 điểm |

## 6. Ảnh hưởng người dùng

- Máy bế có thể nhận nhiều đường cắt rác ngoài đường tròn chính.
- Đường dao chính dài hơn cần thiết, rung hướng liên tục và có sai lệch tới vài mm; đây là lỗi artifact sản xuất, không chỉ lỗi preview.
- Chế độ mặc định `preserve` là ca xấu nhất: hàng nghìn đoạn thẳng, trong khi UI ngụ ý hệ thống đang tự nhận hình.
- Tem càng lớn từ ảnh raster không DPI thì mỗi pixel nguồn càng lớn theo mm, nên lỗi trở nên dễ thấy dù số pixel ảnh không đổi.

## 7. Bất biến phải giữ khi sửa

1. Không xóa nhầm artwork nhiều thành phần hợp lệ hoặc lỗ treo thật.
2. `preserve` không được âm thầm biến hình custom thành circle/ellipse nếu classifier không đủ chắc chắn.
3. `auto_safe` phải xử lý từng thành phần độc lập hoặc cô lập nhiễu trước khi nhận dạng; một component xấu không được vô hiệu hóa component tốt.
4. Dung sai phải theo mm và độ phân giải ảnh nguồn; không hard-cap worker/RAM/chất lượng trái quy tắc phần cứng của dự án.
5. PDF sau ghi phải mở lại được, đúng spot `/CutContour`, đúng page boxes/crop, không chỉ “preview trông đẹp”.

## 8. Kế hoạch sửa đề xuất — chờ duyệt

### Lô A — Chặn nguyên nhân gốc, tối đa 4 file

1. Thêm bộ phân loại component theo dominance/ngữ cảnh ảnh phủ trang, thay vì chỉ ngưỡng 1 mm² tuyệt đối. Giữ các component hợp lệ ở ca nhiều tem và lỗ treo.
2. Tách dựng hình theo từng exterior/component; không yêu cầu cả trang phải là một `Polygon` mới được `auto_safe`.
3. Đồng bộ hợp đồng UI: mặc định phải thật sự là `auto_safe`; `forceContour` mới là thao tác chủ ý quay về giữ biên ảnh. Không đổi nghĩa của alpha.
4. Tích hợp `source_pixel_mm` vào ngưỡng nhận dạng/làm mượt có guard; không chấp nhận moving average không kiểm chứng làm lời giải cuối.

### Lô B — Regression và artifact, tối đa 3 file

1. Thêm fixture JPEG nén đại diện đúng lỗi: silhouette tròn lớn + mảnh nhiễu dài có diện tích >1 mm²; thêm đối chứng nhiều component và lỗ treo thật.
2. Test E2E image/PDF → engine → reopen content stream, kiểm `path_count`, `cut_kind`, `l/c`, bbox, topology và Hausdorff.
3. Render artifact trước/sau ở ít nhất 50/200/805 mm và soi overlay; chỉ cập nhật golden nếu thay đổi hình học đã được duyệt.

### Tiêu chí nhận bản sửa trên đúng file khách

- `round + auto_safe`: đúng **1** CutContour exterior, `cut_kind = circle`, không có path rác, `l = 0`, tối đa 96 cubic;
- sai lệch của hình dựng lại không vượt ngân sách theo pixel nguồn và không tạo dao động “sợi mì” khi render;
- `preserve`: không còn path rác; nếu fitter không thể làm mượt trong guard thì UI/runtime phải báo đúng là contour, không giả vờ auto;
- fixture nhiều thành phần/lỗ treo vẫn giữ đủ topology;
- test mục tiêu, typecheck liên quan và artifact reopen đều xanh.

## 9. Chốt audit

Audit dừng tại đây theo quy trình hai chốt của dự án. Sau khi được duyệt, triển khai **Lô A trước**, verify hẹp và gửi artifact trước/sau để duyệt tiếp rồi mới sang Lô B hoặc điều chỉnh UI.

## 10. Bổ sung audit đa hình học sau Lô B

Sau khi Lô B đạt 25/25 kích thước trên đúng JPEG hình tròn của khách, đã chạy
thêm ma trận độc lập gồm 5 silhouette JPEG q82 × 6 kích thước
`20/100/400/805/1200/1600 mm` qua đúng luồng mặc định
`preserve + auto_safe + remove_white_bg`.

Tiêu chí: PDF mở lại được, đúng một `CutContour`, đúng `cut_kind` với hình chuẩn;
riêng sao custom phải giữ `cut_kind=null`, một path và độ lõm.

| Hình | Đạt | Cỡ chưa đạt (mm) | Hiện tượng chính |
|---|---:|---|---|
| Elip | 4/6 | 805, 1600 | còn 2–3 path nên metadata không còn là ellipse |
| Chữ nhật góc vuông | 2/6 | 400, 805, 1200, 1600 | 400–1200 bị nhận nhầm thành `rounded_rect`; 1600 giữ một path nhưng không nhận dạng |
| Chữ nhật bo góc | 2/6 | 400, 805, 1200, 1600 | trượt nhận dạng từ 400; 1200–1600 có 4–6 path |
| Tam giác | 2/6 | 400, 805, 1200, 1600 | trượt nhận dạng từ 400; 1200–1600 có 9–12 path |
| Sao custom | 4/6 | 1200, 1600 | vẫn giữ lõm nhưng có 11/30 path do island JPEG |

Artifact số đo:
`tmp/research/noodle_audit_2026-08-07/shape_sizes/shape_size_matrix.json`.

### §NOODLE.8 — P1 — Nhận dạng hình chuẩn còn phụ thuộc khe scale

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

Elip, bo góc và tam giác đều đạt ở 20/100 mm nhưng không duy trì kết quả khi mỗi
pixel nguồn đại diện nhiều mm hơn. Lỗi không chỉ là metadata: khi classifier trượt,
engine quay về fitter contour và ở cỡ lớn có thể xuất hàng trăm tới hàng nghìn đoạn.

### §NOODLE.9 — P1 — Hình custom cực lớn vẫn giữ island JPEG

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

Lượt lọc rộng §NOODLE.6 cố ý yêu cầu thành phần chính đã nhận là hình chuẩn để
không xóa nhầm chi tiết custom. Guard này an toàn nhưng khiến sao/logo tự do ở
1200–1600 mm chỉ dùng lượt lọc bảo thủ; kết quả còn 11–30 path. Không được chữa
bằng cách bỏ guard hoặc nới ngưỡng toàn cục.

### §NOODLE.10 — P1 — Góc vuông có thể bị nhận nhầm thành bo góc

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

JPEG chữ nhật góc vuông ở 400/805/1200 mm được nhận thành `rounded_rect`. Đây là
sai hình học sản xuất dù artifact chỉ có một path. Guard mới cần kiểm bằng chứng
góc và Hausdorff so với contour trước probe, tương tự nguyên tắc §NOODLE.7.

### §NOODLE.11 — P2 — Regression cần ma trận hình × scale

**Trạng thái:** `FIXED / TESTED` — effort S

Ma trận hình tròn 25 cỡ không đại diện cho hình có đoạn thẳng, góc lồi/lõm hoặc
bán kính bo. Cần chuyển bộ 30 ca đại diện thành regression gọn, chọn các điểm biên
20/400/805/1600 mm và kiểm số path, loại hình, góc/độ lõm, không chỉ success.

## 11. Lô tiếp theo đề xuất — chờ duyệt

### Lô C — Nhận dạng và lọc đa hình học, tối đa 3 file

1. Tách island JPEG bằng quan hệ diện tích/khoảng cách/hình thái theo pixel nguồn,
   nhưng giữ fail-safe cho component có ý nghĩa; không phụ thuộc việc hình chính
   phải là circle/rect.
2. Thêm guard theo từng họ hình: độ thẳng cạnh + độ bền góc cho rect/triangle,
   bán kính và tiếp tuyến cho rounded-rect, residual theo hai trục cho ellipse.
3. Mọi hình dựng lại từ probe phải qua Hausdorff/topology so với contour trước probe.

### Lô D — Regression đa hình, tối đa 2 file

1. Đưa các ca biên đại diện vào pytest; giữ sao/notch/lỗ/component thật làm đối chứng âm.
2. Chạy lại 30 artifact, backend full và kiểm tay trong WebView/Tauri trước khi
   nâng trạng thái master matrix từ `PARTIAL` lên `ARTIFACT`.

Audit bổ sung dừng tại chốt duyệt; chưa sửa engine cho §NOODLE.8–11.

## 12. Kết quả sau khi duyệt Lô C–D

Lô C–D đã được triển khai và đóng §NOODLE.8–11:

- đúng JPEG khách: **25/25** cỡ 5–1.600 mm;
- đa hình JPEG q82: **30/30** ca ellipse/rect/rounded-rect/triangle/star-custom;
- mọi artifact đúng một `CutContour`; hình chuẩn đúng `cut_kind`;
- sao custom giữ độ lõm, 10–16 cubic ở toàn dải thay vì tối đa 12.758 line/30 path;
- regression liên quan **166 passed**; backend full **2.412 passed, 21 skipped**.

Trạng thái tại chốt Lô D: `ARTIFACT` trong phạm vi 4 họ hình chuẩn + sao custom.
Ma trận topology mở rộng bên dưới thay thế kết luận này cho phạm vi toàn bộ hình học.

## 13. Audit mở rộng hình tự do, nhiều thành phần và nhiều lỗ

Đã chạy **56 artifact PDF thật**: 14 silhouette JPEG q82 × 4 kích thước
`20/400/805/1600 mm`, qua đúng luồng mặc định
`preserve + auto_safe + remove_white_bg`. Mỗi PDF được mở lại, parse content stream
`/CutContour`, so topology, số đoạn, diện tích, chu vi và Hausdorff với mask lý tưởng
trước nén JPEG. Các ca đại diện gồm:

- lõm/cong: tim, lưỡi liềm, mây, móng ngựa, lỗ khóa;
- nhiều đặc trưng: hoa 12 cánh, bánh răng 20 răng;
- góc/khe khó: chữ nhật khuyết, đồng hồ cát cổ hẹp, tia sét góc nhọn;
- nhiều component: huy hiệu + chấm rời, hai vật thể độc lập;
- lỗ: vòng tròn một lỗ, chữ B hai lỗ.

Oracle không ép mọi hình về “một path”: hai vật thể phải có 2 path, hình vòng phải
có 2 ring và chữ B phải có 3 ring. Dung sai biên là
`max(0,30 mm, 3,25 pixel nguồn)`; diện tích tối đa 4%, chu vi tối đa 8%; độ phức tạp
không được tăng quá 4× theo scale hoặc vượt 512 đoạn. Hệ số 4× chừa khác biệt có
chủ ý giữa ngưỡng sản xuất 0,20 mm ở tem 20 mm và ngân sách theo pixel ở tem lớn.

**Kết quả: 13/56 đạt, 43/56 chưa đạt.** Hai hình nhiều component giữ đúng topology
ở cả bốn cỡ, nhưng ba nhóm lỗi mới đã được xác nhận:

| Nhóm | 20 mm | 400 mm | 805 mm | 1.600 mm | Kết luận |
|---|---:|---:|---:|---:|---|
| Tim — số cubic | 11 | 131 | 157 | 334 | tăng 30,4×; sai lệch max tới 10,58 mm |
| Hoa 12 cánh — số đoạn | 52 | 255 | **3.973 line** | **10.981 line** | fallback thành răng cưa raster |
| Bánh răng 20 răng — số đoạn | 82 | 114 | 116 | **10.853 line** | bùng nổ tại cỡ 1.600 mm |
| Đồng hồ cát — số đoạn | 10 | 315 | **1.763 line** | **4.804 line** | cổ hẹp làm fitter rơi về polyline |
| Vòng một lỗ — ring thực tế/kỳ vọng | 1/2 | 1/2 | 1/2 | 1/2 | mất biên lỗ ở mọi cỡ |
| Chữ B hai lỗ — ring thực tế/kỳ vọng | 1/3 | 1/3 | 1/3 | 1/3 | mất cả hai biên lỗ ở mọi cỡ |

Artifact số đo:
`tmp/research/noodle_audit_2026-08-07/custom_shapes/custom_topology_matrix.json`.
Các bản render toàn hình và zoom biên nằm cùng thư mục với tiền tố `preview_` và
`zoom_`. Soi Poppler ở 150 DPI xác nhận đường hồng của hoa/bánh răng đi theo từng
bậc raster, không phải lỗi của bộ parser số đo.

## 14. Findings mới

### §NOODLE.12 — P1 — Fallback dùng 0,20 mm cố định làm bùng nổ polyline theo scale

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

`_fit_preserved_contour_paths()` có guard topology/Hausdorff và hoạt động tốt khi
candidate cubic được nhận. Nhưng khi candidate bị từ chối, nhánh
`sticker_engine.py:5193–5201` quay về `simplify(0.20 mm)` rồi bo nhẹ. Ở tem 1.600 mm,
một pixel nguồn đã bằng khoảng 0,701 mm; 0,20 mm nhỏ hơn một phần ba pixel nên gần
như toàn bộ bậc raster còn nguyên và được writer xuất thành hàng nghìn lệnh `l`.

Đây là nhánh chung của hoa, bánh răng và đồng hồ cát; không thể sửa bằng cách thêm
từng classifier hình mới. Fallback phải dùng ngân sách theo pixel nguồn, giữ topology,
góc chủ ý và có guard độ phức tạp trước khi ghi PDF.

### §NOODLE.13 — P1 — Guard hiện tại không khóa sai lệch end-to-end so với mask nguồn

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

Hình tim giữ đúng một component và diện tích chỉ lệch dưới 0,5% ở các cỡ lớn, nhưng
Hausdorff so với mask nguồn tăng gần tuyến tính: `2,58 / 5,32 / 10,58 mm` tại
`400 / 805 / 1600 mm`, tương đương khoảng 15 pixel nguồn. Số cubic đồng thời tăng
từ 11 lên 334.

Guard fitter hiện so candidate với `ideal_cut_geometry` **sau** các bước dựng mask và
dải biên. Vì vậy nó không phát hiện được sai lệch đã phát sinh trước điểm guard.
Regression cần oracle end-to-end mask nguồn → PDF mở lại, nhất là cusp, hõm sâu và
cổ hẹp; chỉ đo candidate so với geometry trung gian là chưa đủ.

### §NOODLE.14 — P1 — `fill_holes=false` không giữ được lỗ trắng trong ảnh nền trắng

**Trạng thái:** `FIXED / ARTIFACT VERIFIED` — effort M

Ở `sticker_engine.py:4691–4705`, nhánh bỏ nền trắng chỉ loại vùng trắng nối với mép
ảnh và cố ý giữ mọi vùng trắng nằm trong artwork để không xóa nhầm mực trắng. Do đó
mask đưa vào `find_contours` đã coi các lỗ trắng là foreground; đoạn
`sticker_engine.py:5013–5015` không còn hole nào để trừ dù tham số `fill_holes=false`.

Kết quả: donut luôn chỉ có exterior; chữ B luôn chỉ có exterior. Bản sửa phải phân
biệt rõ “mực trắng nội bộ” và “lỗ theo màu nền”. Khi người dùng chủ ý tắt lấp lỗ,
các vùng kín cùng màu nền cần trở thành hole; ca giữ mực trắng phải có đối chứng để
không hồi quy âm thầm.

### §NOODLE.15 — P2 — Ma trận 30 ca cũ chưa đại diện cho hình tự do/topology

**Trạng thái:** `FIXED / TESTED` — effort S

Ma trận 30/30 chỉ có ellipse, rect, rounded-rect, triangle và một sao 5 cánh. Nó
không phủ fitter-reject, nhiều lõm liên tiếp, cổ hẹp, nhiều component hay interior
ring. Vì vậy việc nâng toàn luồng lên `ARTIFACT` từ ma trận này là quá rộng so với
bằng chứng. Ma trận 56 ca phải trở thành regression rút gọn theo các ranh giới làm
fitter đổi nhánh, không cần giữ toàn bộ artifact trong test suite.

## 15. Lô sửa đã duyệt

### Lô E — Fallback custom và topology lỗ, tối đa 3 file

1. Thay fallback `0,20 mm` bằng simplify thích ứng theo pixel nguồn, sau đó fit lại
   với guard Hausdorff/topology/góc; không xuất trực tiếp hàng nghìn node raster.
2. Thêm van chất lượng trước writer: candidate/fallback phải giữ số component/ring,
   không tăng độ phức tạp bất thường theo scale và không vượt ngân sách end-to-end.
3. Khi `fill_holes=false`, dựng hole từ vùng kín cùng nền với đối chứng mực trắng;
   không thay đổi hành vi mặc định `fill_holes=true`.

### Lô F — Regression topology mở rộng, tối đa 2 file

1. Đưa hoa, bánh răng, tim, đồng hồ cát, hai component, donut và chữ B vào E2E ở
   các điểm scale làm đổi nhánh; parse lại `/CutContour` để kiểm ring và `l/c`.
2. Chạy lại 56 artifact + 25 cỡ JPEG khách + 30 ca hình chuẩn/sao + backend full;
   chỉ nâng lại `ARTIFACT` khi không còn ca bùng nổ/mất topology.

## 16. Kết quả sau Lô E–F

Lô E–F đã được triển khai và đóng §NOODLE.12–15:

- fallback `preserve` dùng simplify `max(0,20 mm, 1,5 pixel nguồn)`; geometry có
  interior ring dùng sàn 0,10 mm và không bo hai phía của lỗ;
- profile contour mực đậm lấy ngưỡng theo chính độ đậm artwork, nối nền ngoài/hole
  trước khi marching-squares; không còn kernel rất rộng chỉ để đuổi ringing;
- `fill_holes=false` coi vùng kín cùng màu nền là hole; mặc định
  `fill_holes=true` vẫn lấp lỗ và donut được nhận đúng là circle;
- regression E2E khóa tim/hoa/bánh răng/đồng hồ cát/donut/chữ B ở 1.600 mm,
  kiểm số ring và tổng node không vượt 512.

### Artifact sau sửa

| Nhóm | Trước | Sau | Kết quả |
|---|---:|---:|---|
| Hoa 12 cánh, 1.600 mm | 10.981 line | 136 cubic | không còn polyline raster |
| Bánh răng 20 răng, 1.600 mm | 10.853 line | 90 cubic | giữ đủ 20 răng |
| Đồng hồ cát, 1.600 mm | 4.804 line | 25 line | giữ góc/cổ hẹp chủ ý |
| Tim, 1.600 mm | 334 cubic; Hausdorff 10,58 mm | 35 cubic; 1,99 mm | trong 3,25 pixel nguồn |
| Donut | 1/2 ring | 2/2 ring | giữ lỗ |
| Chữ B | 1/3 ring | 3/3 ring | giữ hai lỗ |

Ba ma trận artifact đều xanh:

- topology mở rộng: **56/56**;
- đúng JPEG khách, 5–1.600 mm: **25/25**;
- hình chuẩn + sao custom: **30/30**;
- tổng: **111/111 artifact**.

Verify tự động: nhóm liên quan **154 passed**; backend full
**2.420 passed, 21 skipped**, 3 warning có sẵn; `py_compile` đạt. Render Poppler
toàn hình và zoom 150 DPI xác nhận đường spot hồng liên tục, hoa không còn bậc
răng cưa và donut/chữ B có đủ đường cắt interior.

Trạng thái hiện tại: `ARTIFACT`. Chưa thao tác tay trong WebView/Tauri hoặc cắt
thử trên máy bế; đó là bước `RUNTIME`, không còn là khoảng trống test hình học.
