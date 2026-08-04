# Báo cáo audit đường cắt theo biên trong suốt — 2026-08-04

## 1. Tóm tắt điều hành

Phạm vi audit: **Bù xén → Bế tem nhãn → Đường cắt theo biên trong suốt**, từ UI,
payload API, raster Alpha, dựng polygon, lùi đường cắt, rút gọn hình học đến content stream
`CutContour` trong PDF đầu ra.

Phản ánh của người dùng là **đúng và đã tái hiện trên artifact thật**. Đây không phải lỗi hiển thị
của viewer. Chế độ Alpha đang đi qua một logic khác các chế độ còn lại:

- UI và backend đều ép `corner_style="preserve"` và `shape_mode="contour"`;
- mask Alpha không blur/morphology;
- contour lấy trực tiếp từ marching squares của raster 300 DPI;
- dung sai rút gọn chỉ **0,02 mm**, nhỏ hơn một pixel 300 DPI (**0,0847 mm**);
- writer xuất contour `preserve` bằng toàn đoạn thẳng `l`, không có đường cong Bézier `c`.

Trên trang 1 của file lỗi, CutContour có **1 lệnh `m` + 1.201 lệnh `l` + `h`, không có
Bézier**. Trên 72 trang, contour chính có từ **146 đến 1.408 node**, trung vị **991,5 node**.
Vì vậy máy cắt và phần mềm chế bản nhận đúng một đường gấp khúc dày đặc, không phải chỉ thấy
răng cưa do phóng to màn hình.

| Mã | Mức | Trạng thái | Kết luận |
|---|---:|---|---|
| §ALPHA.1 | P1 | `[CONFIRMED]` | Raster Alpha bị chuyển gần như nguyên từng bậc pixel thành polyline sản xuất |
| §ALPHA.2 | P1 | `[CONFIRMED]` | Bản vá bảo vệ độ lùi 0,15 mm dùng dung sai 0,02 mm, giải quyết vị trí nhưng gây hồi quy độ mượt/mật độ node |
| §ALPHA.3 | P2 | `[CONFIRMED]` | Test Alpha thiếu oracle mật độ node, độ dài đoạn, độ gãy và sai lệch hình học cục bộ |
| §ALPHA.4 | P2 | `[CONFIRMED]` | UI ẩn kiểu góc và cả UI/backend đều ép `preserve`, nên người dùng không có lựa chọn làm mượt có kiểm soát |

Không sửa mã production trong giai đoạn audit này. Báo cáo này là chốt duyệt trước khi sửa theo
quy trình audit của dự án.

## 2. Phạm vi và đường chạy đã truy vết

### 2.1 Entry → artifact

1. UI dựng form-data tại
   `desktop/src/components/preprocess-tools/StickerTool.tsx:391-419`.
2. Khi `cutMode === "alpha"`, UI gửi `corner_style=preserve`, `shape_mode=contour` và ẩn bộ
   chọn kiểu góc tại `StickerTool.tsx:744-759`.
3. Route `POST /pdf-tools/sticker-dieline` nhận payload tại
   `backend/app/api/routes/pdf_tools.py:1257-1346` rồi gọi `StickerEngine.process_pdf()`.
4. Backend tiếp tục ép Alpha về `preserve/contour` tại
   `backend/app/workers/sticker_engine.py:2584-2596`, nên cả client cũ hoặc caller gửi
   `corner_style=round` cũng không thay đổi được kết quả.
5. Alpha được threshold ở mức 64, bỏ qua blur/morphology và đưa thẳng vào
   `skimage.measure.find_contours()` tại `sticker_engine.py:2890-2921`.
6. Chỉ `corner_style="round"` mới chạy cửa sổ làm mượt vật lý khoảng 1 mm tại
   `sticker_engine.py:3037-3053`; Alpha bị loại khỏi nhánh này.
7. Alpha được lùi 0,15 mm rồi `simplify(0,02 mm)` tại
   `sticker_engine.py:3154-3161`.
8. `build_contour_path_stream()` tại
   `backend/app/workers/cutline_geometry.py:75-83` chỉ sinh Bézier cho `round`; `preserve`
   sinh toàn lệnh thẳng.
9. PDF thật đã được mở lại và parse trực tiếp content stream sau `/CutContour CS`.

### 2.2 Bất biến cần giữ

- Đường cắt Alpha phải nằm bên trong silhouette, mặc định lùi khoảng 0,15 mm để tránh vùng
  bán trong suốt.
- Không làm mất lỗ, notch hoặc chi tiết có ý nghĩa sản xuất.
- Không tạo self-intersection, đổi số polygon/lỗ hoặc làm đường cắt vượt ra ngoài Alpha.
- Không biến nhiễu từng pixel thành hàng trăm–hàng nghìn điểm dao.
- Đơn vị làm mượt/rút gọn phải là mm vật lý và không phụ thuộc DPI/raster cap.
- Artifact PDF phải được kiểm bằng path thật; preview hoặc bbox không đủ làm oracle.

## 3. Bằng chứng artifact thật

### 3.1 Corpus người dùng

- Nguồn: `d07e3ff4aba347679b7b623ca88c52e9.pdf`, 72 trang, 301.915.799 byte.
- Kết quả: `sticker_7e58a05e.pdf`, 72 trang, 302.463.030 byte.
- Trang nguồn đầu: khoảng 74 × 74 mm; raster Alpha của engine ở 300 DPI là 875 × 875 px.
- HEAD lúc audit: `6d2b947`, branch `codex/pre-release-audit-2026-08-04`.

Hai output gần nhất `sticker_7e58a05e.pdf` và `sticker_af97328b.pdf` có cùng hình học/node
CutContour; khác page box/crop. Vì vậy chúng không phải cặp đối chứng Alpha–Round.

### 3.2 Mật độ node

| Chỉ số | Kết quả |
|---|---:|
| Trang 1 | 1 `m` + 1.201 `l` + `h`; 0 `c` |
| Trang 7 | 1 `m` + 1.407 `l` + `h`; 0 `c` |
| 72 trang — node contour chính | min 146; median 991,5; max 1.408 |
| Trang 1 — chu vi | 242,68 mm |
| Trang 1 — độ dài đoạn trung vị | 0,1514 mm |
| Đoạn ngắn hơn 0,2 mm | 701/1.202 = 58,3% |
| Đoạn ngắn hơn 0,3 mm | 1.015/1.202 = 84,4% |
| Node đổi hướng trên 15° | 1.201/1.202 = 99,9% |

Một pixel ở 300 DPI là `25,4 / 300 = 0,0847 mm`. Dung sai hiện tại 0,02 mm chỉ bằng
khoảng **0,24 pixel**, nên về thực tế gần như giữ lại toàn bộ bậc thang raster.

### 3.3 Probe dung sai trên chính trang 1

Probe dựng lại đúng silhouette Alpha ở 300 DPI, lùi 0,15 mm, sau đó thử các dung sai vật lý.
`min gap` là khoảng cách cục bộ nhỏ nhất còn lại tới biên Alpha; `outside` cho biết candidate
có vượt khỏi Alpha hay không.

| Dung sai | Node | Giảm node | Hausdorff so với đường lùi gốc | `min gap` tới Alpha | Vượt Alpha |
|---:|---:|---:|---:|---:|---:|
| 0,02 mm | 1.203 | baseline | 0,0199 mm | 0,1265 mm | 0 |
| 0,05 mm | 401 | 66,7% | 0,0498 mm | 0,0974 mm | 0 |
| 0,08 mm | 246 | 79,6% | 0,0782 mm | 0,0682 mm | 0 |
| 0,10 mm | 217 | 82,0% | 0,0979 mm | 0,0532 mm | 0 |
| 0,15 mm | 170 | 85,9% | 0,1492 mm | 0,0041 mm | 0 |
| 0,20 mm | 145 | 87,9% | 0,1976 mm | 0 mm | 0,023703 mm² |

Kết luận của probe:

- Không thể đơn giản đổi lại 0,20 mm: candidate đã chạm và vượt biên Alpha, tái tạo đúng rủi
  ro mà bản vá ngày 02/08 muốn ngăn.
- Khoảng 0,05–0,08 mm là vùng thử nghiệm có tiềm năng: giảm 67–80% node mà vẫn nằm trong
  Alpha trên artifact này.
- Chỉ tăng `simplify` vẫn tạo polyline. Muốn đường nhìn và chạy dao thực sự mượt, cần thêm
  bước làm mượt cục bộ có kiểm soát và kiểm lại sai lệch, không dùng Catmull–Rom toàn contour
  một cách mù quáng.

## 4. Phát hiện

### §ALPHA.1 — P1 — Bậc pixel trở thành điểm dao thật

**Triệu chứng.** Đường CutContour màu xanh gấp thành từng khúc ngắn và dày node quanh vùng
cong. Parse PDF xác nhận đây là path thật gồm hàng trăm–hàng nghìn lệnh thẳng.

**Nguyên nhân gốc.** Alpha được xem là silhouette “đã chủ đích”, nên code ép `preserve`, bỏ
lọc raster, bỏ cửa sổ làm mượt và bỏ Bézier. Sau đó dung sai thấp hơn một pixel khiến marching
squares gần như được xuất nguyên vẹn.

**Ảnh hưởng.** File PDF nặng path hơn cần thiết; Illustrator/Corel hiển thị dày điểm neo; máy
cắt có thể đổi hướng liên tục theo các bậc raster thay vì chạy một đường cong ổn định. Đây là lỗi
chất lượng đầu ra sản xuất, không phải thẩm mỹ preview.

### §ALPHA.2 — P1 — Hồi quy do bảo vệ một bất biến nhưng thiếu ngân sách sai lệch tổng

`ALPHA_CONTOUR_SIMPLIFY_MM = 0.02` được thêm ở commit `7ebcd344` ngày 02/08. Mục tiêu đúng:
không để `simplify(0,20 mm)` đẩy đường cắt đã lùi 0,15 mm quay ra gần mép Alpha. Tuy nhiên
giải pháp cố định 0,02 mm chỉ khóa vị trí/bbox, không khóa độ mượt hoặc mật độ node.

Đây là bài toán hai mục tiêu:

1. bảo vệ khoảng lùi và topology;
2. loại nhiễu raster/điểm dao không có ý nghĩa.

Một hằng số đơn không đủ. Candidate phải được đo lại với biên Alpha và tự hạ mức làm mượt khi
vi phạm ngân sách sai lệch.

### §ALPHA.3 — P2 — Test hiện tại xanh nhưng không phủ lỗi

Hai test liên quan đều đạt (`2 passed` trong 7,30 giây):

- `test_alpha_cut_mode_uses_pdf_smask_and_keeps_white_outline` kiểm đúng nguồn Alpha, bbox và
  độ lùi x/y, nhưng chỉ kiểm `CutContour` tồn tại;
- `test_preserve_mode_bypasses_reconstruction_smoothing_and_bezier` có oracle
  `line_count < 100`, nhưng chạy `cut_mode="original"`, không chạy nhánh Alpha có constant
  0,02 mm.

Thiếu các oracle:

- số node theo chu vi hoặc mật độ node/mm;
- tỷ lệ đoạn dưới 0,1/0,2 mm;
- góc đổi hướng dày đặc;
- Hausdorff/sai lệch cục bộ so với đường lùi lý tưởng;
- candidate có vượt Alpha hoặc đổi topology/lỗ hay không;
- path stream có số đoạn/đường cong phù hợp cho sản xuất.

### §ALPHA.4 — P2 — Người dùng không có quyền chọn mức làm mượt

UI ẩn toàn bộ `CORNER_STYLES` khi `cutMode === "alpha"`, rồi gửi `preserve`. Backend lại ép
lần thứ hai. Vì vậy đây không phải trường hợp người dùng chọn nhầm “Giữ nguyên”; mọi lần chạy
Alpha đều bắt buộc dùng logic này.

Không nên chỉ bỏ ép để Alpha đi thẳng vào `round` hiện tại: nhánh `round` dùng làm mượt 1 mm
và Catmull–Rom toàn contour, có thể làm mất notch hoặc overshoot. Cần một lựa chọn/chuẩn Alpha
riêng, ví dụ “Mượt an toàn” (mặc định) và “Bám sát pixel” (trường hợp chuyên biệt), sau khi engine
có guard hình học tương ứng.

## 5. Hướng sửa đề xuất — chờ duyệt

### Lô A — Sửa engine và khóa artifact (tối đa 3 file)

1. `backend/app/workers/sticker_engine.py`
   - tách helper làm mượt Alpha theo mm vật lý;
   - bắt đầu từ đường lùi lý tưởng 0,15 mm;
   - thử candidate trong vùng 0,05–0,08 mm và tự back-off;
   - chỉ nhận candidate khi topology/số lỗ không đổi, không vượt Alpha, `min gap` không thấp
     hơn ngưỡng sản xuất đã chốt và Hausdorff nằm trong ngân sách;
   - làm mượt góc cục bộ có giới hạn; fallback về hình học an toàn nếu guard thất bại.
2. `backend/app/workers/cutline_geometry.py`
   - nếu cần đường cong, dùng writer bounded/non-overshooting hoặc flatten đã kiểm envelope;
   - không tái dùng Catmull–Rom toàn contour mà không kiểm sai lệch.
3. `backend/tests/test_sticker_engine_e2e.py`
   - thêm fixture Alpha cong + notch + lỗ + chi tiết mảnh;
   - thêm oracle node/mm, short-segment ratio, topology, `min gap`, Hausdorff và parse path PDF.

Verify lô A:

- pytest riêng test hình học/writer và sticker E2E;
- parse artifact mới trên trang 1 và toàn bộ 72 trang;
- so ảnh overlay ở 400–800% và mở path trong phần mềm chế bản;
- xác nhận không trang nào vượt Alpha, mất lỗ/notch hoặc có contour invalid.

### Lô B — Hợp đồng UI (tối đa 3 file)

1. `StickerTool.tsx`: hiển thị lựa chọn rõ cho Alpha; mặc định “Mượt an toàn”, tùy chọn chuyên
   sâu “Bám sát pixel” nếu thật sự cần.
2. i18n Việt/Anh: mô tả đúng đánh đổi giữa độ mượt và bám raster.
3. Test UI/payload/recipe: khóa enum, mặc định và tương thích recipe cũ.

Nếu muốn xử lý lỗi đang gặp nhanh nhất, có thể duyệt **Lô A trước**. Lô B chỉ nên thực hiện sau
khi engine đã có guard; không để UI bật một đường cong chưa được kiểm hình học.

## 6. Tiêu chí nghiệm thu đề xuất

- Artifact 72 trang giảm ít nhất 60% node trung vị so với baseline, không tăng page count/file lỗi.
- Trang 1 không còn đa số đoạn ngắn dưới 0,2 mm.
- Không có phần đường cắt nằm ngoài biên Alpha.
- Khoảng lùi cục bộ tối thiểu và Hausdorff nằm trong ngân sách được khóa bằng test; đề xuất
  baseline ban đầu: `min gap ≥ 0,05 mm`, `Hausdorff ≤ 0,08 mm`, rồi xác nhận bằng cắt thử.
- Giữ nguyên số polygon/lỗ và các notch/chi tiết có kích thước trên ngưỡng nghiệp vụ.
- PDF mở lại có `CutContour` spot color hợp lệ, TrimBox/page box không đổi ngoài chủ đích.
- Soi trực quan 400–800% cho thấy đường chạy liên tục, không còn chuỗi gấp khúc pixel như ảnh
  người dùng cung cấp.

Các ngưỡng 0,05/0,08 mm ở trên là **đề xuất khởi điểm có bằng chứng trên artifact**, chưa phải
chuẩn máy cắt cuối cùng. Sau bản vá cần cắt thử ít nhất một tem cong, một tem có góc nhọn/notch
và một tem có lỗ trong trước khi phát hành.
