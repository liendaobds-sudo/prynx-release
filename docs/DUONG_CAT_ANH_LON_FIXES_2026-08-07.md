# SỬA ĐƯỜNG CẮT ẢNH TEM LỚN — 2026-08-07

**Nguồn:** `BAO_CAO_AUDIT_DUONG_CAT_ANH_LON_2026-08-07.md`  
**Phạm vi duyệt:** Lô A + Lô B, mỗi lô tối đa 5 file  
**Mẫu xác nhận:** JPEG logo 2281 × 2275 px, không có DPI, mở thành khoảng 805 mm

## Lô A — Đóng §NOODLE.1–3

### 1. Phân loại halo JPEG theo ngữ cảnh, không tăng ngưỡng diện tích chung

**File:** `backend/app/workers/sticker_engine.py`

- Giữ `_MIN_CONTOUR_AREA_MM2 = 1.0` để không làm mất lỗ treo/tem nhỏ.
- Chỉ bật lọc mới khi đã chứng minh trang là **một ảnh phủ kín** và contour đến từ nhánh bỏ nền trắng.
- Mảnh chỉ bị bỏ khi đồng thời: rất nhỏ so với thành phần chính, mảnh theo pixel ảnh nguồn và nằm sát silhouette chính.
- Component ở xa, đủ dày, PDF vector/nhiều object hoặc không suy ra được pixel nguồn đều fail-safe giữ nguyên.

### 2. Dựng hình theo từng component và dùng probe theo pixel nguồn

**File:** `backend/app/workers/sticker_engine.py`

- `auto_safe` chạy theo từng Polygon; một component custom/xấu không còn khóa component tròn tốt cùng trang.
- Polygon có lỗ không bị dựng lại từ riêng exterior, tránh mất lỗ.
- Ảnh phóng lớn được làm mượt trên **probe nhận dạng** theo kích thước pixel nguồn. Geometry khách chỉ đổi khi probe qua guard và nhận được hình chuẩn; reject vẫn giữ contour gốc.
- Hình đã nhận dạng đầy đủ được xuất trực tiếp, không quay lại fitter `preserve` rồi fallback thành hàng nghìn polyline.

### 3. Đồng bộ hợp đồng “Giữ góc” và “Tự nhận hình”

**Files:**

- `desktop/src/components/preprocess-tools/StickerTool.tsx`
- `backend/app/core/sticker_cutline_policy.py`

`corner_style=preserve` chỉ quyết định cách giữ góc của hình custom. Nó không còn âm thầm cưỡng bức `shape_mode=contour`. Chỉ Alpha hoặc nút **Hình cắt sai? Giữ mép ảnh** mới ép contour; `auto_safe + preserve` có adaptive fitter làm fallback.

### 4. Regression

**File:** `backend/tests/test_sticker_engine_e2e.py`

Đã thêm/đổi oracle cho:

- halo mảnh sát tem bị bỏ nhưng component ở xa/đủ dày được giữ;
- thiếu bằng chứng ảnh phủ trang thì không lọc;
- component custom không khóa việc dựng component tròn;
- probe theo pixel nguồn nhận được tem tròn lớn có sóng raster;
- `preserve + auto_safe` thực sự nhận hình chuẩn;
- force contour, force shape và object selection vẫn giữ policy tương thích.

## Artifact trên đúng file khách

| Chỉ số | Trước sửa, mặc định preserve | Sau Lô A |
|---|---:|---:|
| Số CutContour path | 12 | **1** |
| Lệnh thẳng `l` | 7.937 | **0** |
| Lệnh cubic `c` | 0 | **96** |
| Nhận dạng | không | **circle** |
| Chu vi / bao lồi | 1,2473 | **1,0000** |
| RMS so ellipse | 0,721 mm | **0,0014 mm** |
| Sai lệch max | 3,006 mm | **0,0022 mm** |

PDF đã được mở lại, parse content stream `/CutContour` và render bằng Poppler. Ảnh render cho thấy đường spot hồng là một vòng tròn liên tục, không còn vòng rác hoặc biên “sợi mì”.

## Verify

- `py_compile sticker_engine.py sticker_cutline_policy.py`: pass.
- StickerEngine E2E: **104 passed**.
- Nhóm contour/mask/band liên quan: **129 passed** sau khi cập nhật oracle chủ đích.
- Backend full: **2.420 passed, 4 skipped**, 3 warning có sẵn.
- Frontend typecheck: pass.
- Frontend full: **1.943 passed, 2 skipped**.
- ESLint toàn repo chưa xanh: 1.446 error/104 warning ngoài phạm vi; file
  `StickerTool.tsx` có 7 lỗi tồn tại ở các dòng không thuộc diff, không có finding
  tại payload `shape_mode` vừa sửa. `lint:budget` đang 33/32 cảnh báo
  `react-refresh/only-export-components`; Lô A không thêm export/component mới.
- Không cập nhật snapshot/golden.

## Chưa thực hiện

Chưa chạy thao tác tay trong WebView/Tauri bằng `run_dev.bat`. Bằng chứng hiện tại đạt mức engine/artifact thật và full-suite; cần người dùng mở công cụ Bù xén trên app để xác nhận lần cuối luồng UI thực tế.

## Lô B — Đóng khe scale 100 mm và 900–1.600 mm

### 1. Lọc halo lượt hai có guard nhận dạng

**File:** `backend/app/workers/sticker_engine.py`

- Lượt lọc đầu của Lô A giữ nguyên ngưỡng bảo thủ.
- Lượt hai chỉ chạy khi trang là một ảnh phủ kín, nền trắng và thành phần lớn nhất
  đã qua `auto_safe` với một hình chuẩn.
- Khi đó khoảng cách được xét tới 12 pixel nguồn và bề dày tới 8 pixel nguồn,
  nhưng diện tích mảnh phải nhỏ hơn `1e-5` diện tích hình chính. Hình custom,
  component đủ lớn/đủ dày và trường hợp thiếu bằng chứng đều không đi qua nhánh này.

### 2. Nhận dạng an toàn tại scale trung gian

**File:** `backend/app/workers/sticker_engine.py`

Ở khoảng 100 mm, alias của đúng ảnh mẫu rơi vào khe khiến contour chỉ còn một vòng
nhưng chưa được nhận là hình tròn. Probe mới simplify 0,25 mm rồi vẫn phải qua cả:

- classifier `auto_safe` hiện có;
- guard Hausdorff tối đa 0,35 mm so với contour trước probe.

Nhờ guard thứ hai, notch/chi tiết custom vượt dung sai không thể bị probe biến thành
hình chuẩn chỉ vì bước simplify.

### 3. Regression và ma trận ảnh thật

**File:** `backend/tests/test_sticker_engine_e2e.py`

- Có đối chứng mảnh xa hơn bị loại ở lượt hai nhưng chi tiết đủ diện tích vẫn sống.
- Metadata xác nhận chỉ thành phần lớn nhất đã nhận dạng mới mở khóa lượt hai.
- Có ca alias 100 mm xác nhận probe simplify nhận circle và sai số Hausdorff không
  vượt 0,35 mm.

Đã chạy đúng JPEG khách ở 25 kích thước:

`5, 10, 20, 50, 80, 100, 120, 150, 200, 250, 300, 400, 500, 600, 700, 750, 800, 805, 825, 850, 900, 1000, 1100, 1200, 1600 mm`.

Kết quả toàn bộ 25/25:

- `success=true`, `cut_kind=circle`, `boxes=1`, `path_count=1`;
- không có lệnh thẳng `l`; đường tròn xuất bằng 32/64/96 cubic tùy kích thước;
- `perimeter_hull_ratio` bằng 1 trong sai số số thực;
- sai lệch ellipse lớn nhất toàn ma trận là 0,00676 mm (cỡ 10 mm); tại 1.600 mm
  là 0,00440 mm.

Artifact đo máy: `tmp/research/noodle_audit_2026-08-07/sizes/size_matrix.json`.

### Verify Lô B

- `py_compile`: pass.
- Nhóm test `noodle`: **5 passed**.
- Sticker E2E + reconstruct + contour/mask/band/background liên quan:
  **159 passed**.
- Backend full sau Lô B: **2.405 passed, 21 skipped**, 3 warning có sẵn.
- Không cập nhật snapshot/golden; không thêm cap tài nguyên.

## Lô C — Nhận dạng và lọc đa hình học

### 1. Đồng bộ guard theo kích thước cho mọi họ hình

**File:** `backend/app/workers/sticker_cut_reconstruct.py`

- `eff_defect` theo tỷ lệ kích thước nay được truyền đủ cho rect, rounded-rect và
  triangle; trước đây chỉ ellipse sử dụng nên hình càng lớn càng bị từ chối oan.
- Bán kính bo tối thiểu lấy `max(1 mm, 8 pixel ảnh nguồn)`: ringing JPEG ở góc
  vuông không còn biến rect thành rounded-rect, trong khi bo thật của fixture cách
  ngưỡng hàng trăm pixel.
- Triangle dùng ngân sách residual 1,25× sau khi đo biên thẳng; notch/custom vẫn
  phải qua defect/topology guard.

### 2. Dọn island rời và ringing dính biên bằng bằng chứng ảnh

**File:** `backend/app/workers/sticker_engine.py`

- Island chỉ bị bỏ khi đồng thời rất nhỏ theo tỷ lệ hình chính, nằm trong 8 pixel
  nguồn, gần biên và có mực rất yếu (`255 - min(RGB) <= 24`). Chấm/tem phụ đậm
  được giữ; khi không có ảnh để đo, helper quay về guard hình học bảo thủ.
- Dải contour mở tới bán kính 12 pixel nguồn nhưng chỉ thay bằng độ đậm ảnh thật;
  nhờ đó ringing JPEG dính với silhouette bị loại, còn ruột artwork cách biên xa
  hơn vẫn giữ nguyên mask 255 và nguồn màu bù xén không bị ghi đè.
- Fitter custom dùng ngân sách Hausdorff 2 pixel ảnh nguồn thay vì khóa tuyệt đối
  dưới kích thước một pixel. Bo góc fallback bị từ chối nếu đổi số mảnh/số lỗ.

### 3. Artifact Lô C

Ma trận JPEG q82 gồm ellipse/rect/rounded-rect/triangle/star-custom ×
`20/100/400/805/1200/1600 mm` đạt **30/30**:

- mọi ca đúng một `CutContour` và một `box`;
- ellipse/rect/rounded-rect/triangle đúng `cut_kind` ở cả 6 cỡ;
- sao custom giữ `cut_kind=null`, một path, tỷ lệ chu vi/bao lồi
  `1,1733–1,1792`; số cubic chỉ `10–16` thay vì tối đa 1.429;
- không có lệnh thẳng răng cưa trên sao custom.

Artifact: `tmp/research/noodle_audit_2026-08-07/shape_sizes/shape_size_matrix.json`.

### Verify Lô C

- `py_compile`: pass.
- Nhóm nhận dạng/noodle hiện có: **22 passed** trước khi đổi ngân sách fitter.
- Nhóm soft-band: **5 passed**.
- Một oracle cũ còn khóa Hausdorff tuyệt đối 0,45 mm; Lô D sẽ đổi sang ngân sách
  `max(0,45 mm, 2 pixel nguồn)` và thêm đối chứng âm trước khi chạy full-suite.

## Lô D — Regression đa hình và đóng audit

**Files:**

- `backend/tests/test_sticker_engine_e2e.py`
- `backend/tests/test_sticker_cut_reconstruct.py`

Đã khóa các hợp đồng sau:

- JPEG 1.600 mm cho ellipse/rect/rounded-rect/triangle/star-custom phải đúng một
  `CutContour`, đúng `cut_kind`; sao custom chỉ được 1–24 cubic và không có line răng cưa;
- island mực yếu bị bỏ nhưng chấm mực thật cùng kích thước/vị trí được giữ;
- bán kính bo dưới 8 pixel nguồn phải là alias góc và trả về rect;
- fitter sao giữ đủ đỉnh lồi/lõm trong ngân sách
  `max(0,45 mm, 2 pixel nguồn)`.

### Verify cuối Lô D

- Regression trọng điểm mới/cũ: **13 passed**.
- Nhóm Sticker E2E + reconstruct + contour/mask/band/background: **166 passed**.
- Ma trận đa hình JPEG: **30/30 passed**.
- Ma trận đúng JPEG khách: **25/25 passed**, 5–1.600 mm.
- Backend full: **2.412 passed, 21 skipped**, 3 warning có sẵn.
- `py_compile` và `git diff --check`: pass; không cập nhật snapshot/golden.
- Chưa thao tác tay trong WebView/Tauri; mức bằng chứng hiện tại là engine + artifact
  PDF thật + full-suite backend.

## Lô E — Fallback custom và topology lỗ

**File:** `backend/app/workers/sticker_engine.py`

### 1. Chặn fallback “mì tôm” theo pixel nguồn

- Fitter reject không còn quay về `simplify(0,20 mm)` cố định.
- Fallback dùng `max(0,20 mm, 1,5 pixel nguồn)`, giữ nguyên chữ ký số
  component/interior ring và chỉ nhận candidate trong ngân sách Hausdorff tối đa
  `max(0,45 mm, 3 pixel nguồn)`.
- Hình có lỗ dùng sàn 0,10 mm và không bo hai phía interior ring; nhờ đó lỗ tem
  nhỏ không bị đổi diện tích vì bán kính 0,40 mm.
- Đây là ngân sách hình học theo độ phân giải dữ liệu, không phải hard-cap tài
  nguyên; máy mạnh không bị giảm worker/DPI.

### 2. Dò biên mực đậm theo chính ảnh nguồn

- Profile contour của artwork mực đậm lấy dải theo phân vị mực thực thay cho mức
  cố định `dist≈24`, vốn giữ ringing JPEG tới 15 pixel ở hõm hình tim.
- Nền ngoài và các seed hole được nối theo profile mực trước khi dựng dải xám
  marching-squares. Chỉ dải ngắn 4 pixel nguồn cần morphology; ruột/màu bleed
  không bị ghi đè.
- Tim 1.600 mm giảm từ 334 xuống 35 cubic; Hausdorff mask nguồn giảm
  10,58 xuống 1,99 mm.

### 3. Giữ hole khi người dùng tắt lấp lỗ

- Với nền trắng, `fill_holes=false` loại cả các component trắng kín; mặc định
  `fill_holes=true` vẫn chỉ loại nền nối mép và giữ hành vi cũ.
- Nền phẳng màu khác dùng cùng semantics qua màu nền/tolerance đã dò.
- Donut đạt 2/2 ring, chữ B đạt 3/3 ring ở 20/400/805/1.600 mm.

### Verify Lô E

- `py_compile`: pass.
- Regression hẹp cũ: **14 passed**.
- Artifact lỗi trọng điểm: hoa 10.981 → 136 cubic; bánh răng 10.853 → 90 cubic;
  đồng hồ cát 4.804 → 25 line.

## Lô F — Regression topology mở rộng và đóng audit

**Files:**

- `backend/tests/test_sticker_engine_e2e.py`
- `backend/tests/test_sticker_band_soft.py`

Đã thêm fixture E2E 1.600 mm cho tim, hoa 12 cánh, bánh răng 20 răng, đồng hồ
cát cổ hẹp, donut và chữ B. Oracle kiểm `cut_kind`, số path/ring, kiểu line ở hình
góc chủ ý và tổng node tối đa 512. Test mask riêng khóa hõm tim JPEG trong
3,25 pixel nguồn.

### Verify cuối Lô F

- Regression mới: **8 passed**.
- Nhóm Sticker E2E + reconstruct + contour/mask/band/background: **154 passed**.
- Ma trận topology 14 hình × 4 cỡ: **56/56 passed**.
- Ma trận đúng JPEG khách: **25/25 passed**.
- Ma trận hình chuẩn/sao: **30/30 passed**.
- Backend full: **2.420 passed, 21 skipped**, 3 warning có sẵn.
- Render Poppler toàn hình + zoom 150 DPI: đường spot liên tục, không còn bậc
  răng cưa; donut/chữ B có đủ interior CutContour.
- Không cập nhật snapshot/golden; chưa chạy smoke WebView/Tauri hoặc máy bế thật.
