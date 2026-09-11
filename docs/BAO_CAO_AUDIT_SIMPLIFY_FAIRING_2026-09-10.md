# Simplify đường bế: nghiên cứu và đối chứng trên Binder2 trang 12

Ngày 2026-09-10. Phạm vi: tìm hướng giải quyết chất lượng đường bế sau phản hồi
người dùng rằng B3/B4 gần như không khác Illustrator trước Simplify. Đây là
**nghiên cứu + prototype độc lập, chưa phải bản sửa PrynX và chưa nghiệm thu**.
HEAD lúc kiểm: `5d4e7fe`. Giữ nguyên các thay đổi sản phẩm đang có trong worktree.

## 1. Kết luận điều hành

Hướng đáng triển khai tiếp là **refit với vị trí neo và hướng tay nắm tự do,
kèm mục tiêu làm mượt độ cong, rồi kiểm an toàn độc lập**. Không chỉ gộp các
đoạn giữ nguyên neo/tiếp tuyến cũ, không chỉ đổi Potrace thành VTracer.

Đã chạy được một prototype theo hướng này trên đường thử trang 12, bù 2 mm:

- Nguồn B3 **122 neo**, kết quả **60 neo** (-50,8%).
- Sau mô phỏng làm tròn `.4f` điểm PDF và đọc lại SVG: lệch hai chiều lấy mẫu
  **0,088411 mm**; cận Hausdorff bảo thủ từ flatten + khoảng cách mẫu
  **0,093512 mm** khi làm tròn lên.
- P95 bước nhảy độ cong **21,045 → 1,269 /mm**; lớn nhất
  **37,624 → 1,699 /mm**. Đây là đại lượng hình học, không phải phép đo dao thật.
- Đường đóng; polyline kiểm tra không tự giao. Chưa có chứng nhận topology
  liên tục, bảo toàn góc/cusp được khóa, hay kiểm driver/máy bế.
- **Chưa đạt giới hạn 0,05 mm hiện tại**, chưa chứng minh bằng hoặc hơn
  Illustrator. 0,10 mm là mức khảo sát, không phải yêu cầu sản xuất do người
  dùng xác nhận; không thay ngưỡng UI trong lượt này.

Main đã đọc solver, chạy lại ứng viên cuối: control points trùng hoàn toàn
với lần chạy của agent (`max absolute difference = 0`), rồi đo lại bằng cách
lấy mẫu khác và kiểm sau lượng tử hóa. Các kết quả không đạt cũng được giữ.

## 2. Đầu vào và giới hạn so sánh

- File gốc `D:/pdfcompare/test/Binder2.pdf`: 13 trang, SHA256
  `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.
  Hash được kiểm lại cuối lượt, không thay đổi. Trang 12 có artwork raster
  với alpha, không có đường CUT vector nguyên thủy của tác giả.
- Vector bất biến để đối chứng:
  `D:/pdfcompare/output/pdf/Binder2-page12-global-final-2026-09-10/Binder2_page12_offset2_B3.pdf`,
  SHA256 `c73cc2e66f536b6ed852bee9b23174bdd58467773485ded638888865e59c9526`.
  Một CutContour đóng, 122 cubic; bbox khoảng 61,865 × 65,277 mm;
  chu vi 254,354 mm. Chỉ parse CUT, không đếm lệnh artwork. CTM chỉ tịnh tiến.
- Ảnh Illustrator người dùng xác nhận thuộc trang 12. Ảnh có vẻ khớp toàn
  thiết kế bù khoảng 2 mm và xoay 90°, nhưng **chưa xác nhận tham số thật**.
  Không đánh đồng đường thử B3 này với vector chính xác trước Simplify trong ảnh.
- Offset 0 là một ca khác: sáu ring, hoa 55 cubic. B4 55→45 trên hoa không
  đại diện cho kết quả 122→106 trên outline bù 2 mm.
- Đăng ký hai screenshot cho thấy khoảng 10,88 pixel/mm nếu dùng kích thước
  outline thử. 0,05 mm tương đương khoảng 0,54 pixel, trong khi neo xanh rộng
  3–5 pixel. Không dùng khoảng cách giữa dấu mực trong ảnh để suy ra sai số
  vector hoặc khẳng định Illustrator cho phép lệch 0,2 mm.

Các số lệch bên dưới đều so với **vector B3 bất biến**, không phải sai số
tổng từ alpha gốc qua dò biên, bù, trace và Simplify.

## 3. Vì sao cách đang có không đạt mục tiêu

### §FAIR.1 — CONFIRMED, P2, effort L: miền nghiệm bị khóa quá nhiều

Trong [cutline_global_simplify.py](D:/pdfcompare/backend/app/workers/cutline_global_simplify.py:38),
`_fit` chỉ giải hai độ dài tay nắm; điểm đầu/cuối và hướng tiếp tuyến giữ
nguyên. Trong `global_refit_ring`, ranh giới candidate vẫn là endpoint của
các cubic nguồn. DP chọn ít cạnh nhất trong đồ thị này, **không chọn giữa
mọi vị trí neo/hướng tay nắm có thể có**. Đây là giới hạn thiết kế đã xác
nhận, không phải lỗi DP hay khẳng định DP vô ích.

Luồng sử dụng đã đọc lại:

| Mắt xích | Điểm kiểm trong source |
|---|---|
| UI classic | `StickerTool.tsx:1467`, slider `cutlineSimplifyMm` |
| Preview request | `useClassicCutlinePreview.ts:603` |
| API thực thi | `pdf_tools.py:1645`, `cutline_simplify_mm` |
| Preview engine | `sticker_cutline_preview.py:1159` |
| Nguồn alpha | `sticker_source_pipeline.py:642` |
| Adapter canonical | `sticker_engine.py:6182` |
| Reducer/DP | `cutline_cubic_simplify.py:320`, `cutline_global_simplify.py:38` |
| Writer classic | `sticker_engine.py:11281`, bộ lệnh CUT sau simplify |
| Artifact/consumer | PDF B3/B4 nêu trên; parse CUT và SVG probe đọc lại |

### §FAIR.2 — CONFIRMED, P2, effort L: G1 và ít node chưa đủ để hết gợn

Đường B3 122 cubic có góc lệch tiếp tuyến ở join lớn nhất chỉ khoảng
0,02124°, nhưng P95 bước nhảy độ cong tới 21,045 /mm. Vì vậy nối tiếp tuyến
trơn không đồng nghĩa độ cong biến thiên trơn. Các probe penalty yếu còn
cho ít node/sai lệch thấp nhưng làm bước nhảy độ cong lớn hơn.

Đây cũng là giới hạn được [Kurbo ghi rõ](https://docs.rs/kurbo/latest/kurbo/simplify/fn.simplify_bezpath.html):
nguồn nhiễu cao tần có thể simplify kém vì giữ G1 và diện tích nguồn;
khuyến nghị smoothing/low-pass hoặc fit spline mượt. [Raph Levien](https://raphlinus.github.io/curves/2023/04/18/bezpath-simplify.html)
phân tích cả trường hợp khoảng cách đạt mà vẫn có bump, và hướng tối ưu
vị trí chia cùng góc tiếp tuyến dùng chung.

### Quyết định còn thiếu — không coi là bug đã chứng minh

Cap 0,05 mm đang xuất hiện ở UI/API/engine là quyết định của đợt triển khai,
không phải tolerance người dùng cung cấp. Chưa có dữ liệu để nói phải nới
cap này mới làm được. Cần khảo sát chất lượng ở 0,05 và các mức khác, cho
người dùng duyệt hình/sai lệch; không âm thầm đổi nó.

## 4. Đối chứng bằng thư viện thật

### 4.1. Vector → vector

| Cách | Ngưỡng tham số, mm | Số cubic/neo | Lệch hai chiều đo, mm |
|---|---:|---:|---:|
| B3 nguồn | — | 122 | 0 |
| Paper.js 0.12.18 | 0,05 | 131 | 0,04994 |
| curve-fit-nd | 0,05 | 126 | 0,04555 |
| Paper.js 0.12.18 | 0,10 | 89 | 0,09896 |
| curve-fit-nd, góc 45° | 0,10 | 86 | 0,08767 |
| curve-fit-nd, góc 45° | 0,20 | 59 | 0,18677 |
| curve-fit-nd, góc 180°, seed G1 | 0,20 | 60 | 0,18677 |
| Prototype neo tự do + fair 0,30, lượng tử PDF | mục tiêu 0,10 | **60** | **0,08841** |

Paper.js và curve-fit-nd là hai implementation được tải/build/chạy nguyên
bản trong thư mục thử, không thêm dependency vào sản phẩm. Main đo lại các
file curve-fit-nd 0,05/0,10/0,20 và Paper.js 0,05/0,10 bằng helper độc lập,
các sai khác phép đo chỉ ở vài phần triệu mm.

Lưu ý đối chứng Paper.js: gọi `simplify` trực tiếp trên neo cubic cũ bỏ mất
handles, cho 78 node nhưng lệch 0,298 mm — loại kết quả đó. Script hợp lệ
lấy mẫu toàn quỹ đạo, xử lý seam bằng open-loop đóng lại, truyền tolerance
theo phép so khoảng cách bình phương trong code và chuẩn hóa đơn vị số học.
Không dùng kết quả đường đóng mặc định bị mất phần gần seam trong probe.
[Nguồn PathFitter chính thức](https://raw.githubusercontent.com/paperjs/paper.js/v0.12.18/src/path/PathFitter.js).

curve-fit-nd chạy `curve_fit_cubic_to_points_refit_db`, cyclic/high-quality,
8.479 mẫu đều 0,03 mm, commit `5d75a7adbc2451420a13323496c13b5d20184f54`,
giấy phép trong repo BSD-3-Clause. Fit riêng khoảng 0,08–0,11 giây trên máy
này; không phải thời gian PrynX end-to-end. [Mã gốc](https://github.com/ideasman42/curve-fit-nd).

### 4.2. VTracer: không đánh tráo retrace raster thành simplify vector

Đã chạy WASM VTracer `1.0.0-alpha.4` trên mask tô từ đường B3, đo **cả**
sai số raster + trace + simplify so với B3:

| DPI | Simplify, mm | Cubic | Lệch tổng đo, mm |
|---:|---:|---:|---:|
| 600 | tắt | 433 | 0,14501 |
| 600 | 0,10 | 80 | 0,14530 |
| 600 | 0,20 | 58 | 0,25526 |
| 2400 | tắt | 1652 | 0,03781 |
| 2400 | 0,05 | 276 | 0,06688 |
| 2400 | 0,10 | 240 | 0,09697 |

Các cấu hình đã thử không thay thế trực tiếp được vector simplifier.
Không kết luận mọi cấu hình VTracer đều kém. [Nguồn dự án](https://github.com/visioncortex/vtracer).
Potrace cũng là bộ bitmap→vector, có `opticurve/opttolerance` giảm cubic;
không phải solver tổng quát cho mọi vector đầu vào.
[Tài liệu thư viện của tác giả](https://potrace.sourceforge.net/potracelib.pdf).

### 4.3. Những probe phải loại hoặc chưa đủ

- Periodic SciPy `splprep`: mức RMS 0,005 mm cho 424 cubic, max lệch đo
  0,02835 mm; RMS 0,02 mm cho 225 cubic, max 0,08557 mm. Độ cong nối C2
  cải thiện nhưng số node tăng. `s` là tổng bình phương sai số, không phải
  dung sai cực đại. [Tài liệu SciPy 1.12](https://docs.scipy.org/doc/scipy-1.12.0/reference/generated/scipy.interpolate.splprep.html).
- Spline rồi curve-fit-nd: một ca 66 node, max 0,13348 mm; không được gắn
  nhãn đạt 0,10 mm chỉ vì tham số bước cuối là 0,10. Cần đo từ nguồn bất biến.
- Neo tự do nhưng fairness yếu: 60 node, max 0,08930 mm, nhưng max bước nhảy
  độ cong tăng lên 75,423 /mm. Không nhận đây là đường đã mượt.
- Seed 86 node thả neo vẫn chỉ đạt 0,06550 mm trong probe hiện tại,
  **không đạt 0,05 mm**.

## 5. Prototype có tiến bộ: thả neo + tangent + phạt bước nhảy độ cong

Mỗi neo có năm biến: `(x, y)`, góc tiếp tuyến chung và log độ dài hai tay
nắm. Vì các đoạn dùng chung vị trí/góc nối nên G1 được bảo đảm trước lượng
tử hóa, nhưng góc đó không bị ghim theo đường gợn cũ.

Các vòng tối ưu cập nhật correspondence gần nhất cả hai chiều, rồi dùng
least-squares thưa và trọng số tăng ở vùng lệch lớn. Hàm mục tiêu thêm
penalty bước nhảy độ cong. **Prototype chưa tối ưu trực tiếp tích phân
biến thiên độ cong trong mỗi đoạn**, chưa tìm số node tối thiểu toàn cục;
số 60 đến từ seed độc lập, solver cải thiện hình học ở cùng số node.

| Bản 60 node | Max lệch đo, mm | P95 nhảy độ cong /mm | Max nhảy /mm |
|---|---:|---:|---:|
| Seed curve-fit-nd G1 | 0,18677 | 4,190 | 7,427 |
| Thả neo, fairness yếu | 0,08930 | 9,405 | 75,423 |
| Penalty 0,03 | 0,08797 | 2,957 | 3,561 |
| Penalty 0,30 | 0,08842 | 1,269 | 1,699 |

Hai chiều được đo từ full cubic, không nối tắt neo. Penalty mạnh giảm lỗi
nối cong so với seed mà vẫn giữ max lệch nhỏ hơn một nửa. Số đổi dấu độ
cong của bản cuối là 42, bằng nguồn B3, không được nói mọi gợn đều biến mất.
Chưa có khóa semantic corner; phải bổ sung trước nghiệm thu sản xuất.

### Kiểm độc lập sau lượng tử hóa

Main dùng một sampler khác: de Casteljau đến khi mọi control point của mỗi
nhánh cách chord ≤ `f = 0,00005 mm`, chord dài không quá `h = 0,01 mm`.
Đo đỉnh polyline tới đoạn polyline đối diện cả hai chiều bằng STRtree.

Do tính chất convex-hull và tính liên tục, khoảng cách Hausdorff giữa mỗi
nhánh cubic với chord bị chặn bởi f. Hàm khoảng cách tới tập đóng là
1-Lipschitz; giữa hai đỉnh cách nhau h, điểm bất kỳ cách đỉnh gần nhất ≤h/2.
Vì thế cận giữa hai đường gốc là:

`max(d_source_vertices + h_source/2, d_target_vertices + h_target/2) + 2f`.

Kết quả sau làm tròn `.4f` pt, ghi và đọc lại SVG 9 chữ số mm:

- đo dày: 0,0884111345 mm;
- cận bảo thủ: 0,0935110905 mm;
- area ratio 1,00004649; perimeter ratio 0,99558230;
- tổng biến thiên độ cong proxy: 2890,214 → 336,491 /mm.

Đây là cận hình học số thực dấu phẩy động trên vector B3, không phải proof
interval-arithmetic hoặc certificate sản phẩm. Kiểm polyline simple không
chứng minh mọi khả năng tự giao giữa mẫu, cũng không thay thế Fréchet/thứ
tự đi dao. Mô phỏng làm tròn chưa thay thế việc xuất PDF thật từ writer PrynX.

## 6. Tri thức bên ngoài và cách chọn nền tảng

| Nguồn chính | Điều đáng dùng | Giới hạn / trạng thái |
|---|---|---|
| [Kurbo](https://docs.rs/kurbo/latest/kurbo/fn.fit_to_bezpath_opt.html) | Seed/refit có vị trí phân đoạn ngoài neo cũ; area/moment, xử lý curve | MIT/Apache-2.0 theo repo; vẫn bám tangent nguồn, accuracy không phải chứng nhận chặt; chưa chạy Binder2 |
| [Inkscape Livarot](https://inkscape.gitlab.io/inkscape/doxygen/PathSimplify_8cpp_source.html) | Fit lại polyline, giải tự do cả hai control point bên trong | Ctrl+L không phải lib2geom Schneider; endpoint vẫn trên mẫu; không global fairness; GPL-2.0-or-later, chỉ nghiên cứu, chưa chạy app |
| [Zheng et al. 2012](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/Fast-B-spline-curve-fitting-by-L-BFGS.pdf) | Tối ưu đồng thời control points và footpoint parameters với L-BFGS | Bài dùng knots cố định, metric không phải max Hausdorff; cơ sở cho solver tự do, không code drop-in |
| [Wang et al. SIGGRAPH Asia 2023](https://cims.nyu.edu/gcl/papers/2023-Bezier-Simplification.pdf) | Phép giảm đoạn theo metric tích phân, tối ưu các biến nội bộ ở lân cận | Công bố benchmark tốt hơn Illustrator của bài, không phải Binder2; chưa xác minh public code; prototype MATLAB không phải slider realtime |
| [DAKM 2025](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0325458) | Điều chỉnh knot/parameter theo feature trong fitting B-spline | Dữ liệu và supplementary code có trên bài; chưa chạy, chưa xác minh license riêng; không chứng minh quỹ đạo dao của PrynX |
| [PolyFit 2020](https://www.cs.ubc.ca/labs/imager/tr/2020/ClipArtVectorization/) | Phục hồi cấu trúc clip-art từ raster | Bài toán tái dựng ý đồ hình dạng, khác giữ đúng vector đã duyệt; code MIT theo repo, chưa chạy Binder2 |
| [img2bez](https://github.com/eliheuer/img2bez) | Phân tích cấu trúc, fit rồi refine/hài hòa G2 | Experimental, thiên về font; không mang nguyên grid snapping/axis locking sang đường bế |

Riêng paper 2023 có tài liệu bằng sáng chế liên quan
[US12586273B2](https://patents.google.com/patent/US12586273B2/en), trang hồ sơ
ghi Adobe và ngày cấp 24/03/2026. Không suy từ paper công khai ra quyền
copy vào sản phẩm thương mại; cần đánh giá quyền nếu chọn cơ chế đó. Đây
không phải kết luận vi phạm hay kết luận pháp lý về solver thử hiện tại.

Không có nguồn đã kiểm nào xác nhận chính xác thuật toán nội bộ Illustrator
trong phiên bản người dùng đang sử dụng.

## 7. Đề xuất triển khai sau chốt duyệt

1. **Lõi tạo candidate riêng:** giữ nguồn bất biến, nhận góc/cusp thật và
   dùng free-anchor/free-tangent optimization cho các vùng trơn. Khóa vị
   trí góc bắt buộc, không khóa mọi tangent nhiễu. Chuẩn hóa tham số theo mm.
2. **Tối ưu cả hình lẫn độ cong:** đo sai số hai chiều/thứ tự, số đoạn, bước
   nhảy độ cong và biến thiên độ cong nội đoạn. Thử giảm số nhịp rồi refit;
   không chỉ tối thiểu node hoặc ép G2 qua các góc thật.
3. **Bộ kiểm độc lập sau tất cả thay đổi:** sai lệch so nguồn bất biến,
   kín/vòng/lỗ/winding/tự giao/chi tiết nhỏ, lượng tử writer, rồi parse PDF
   xuất thật. Fallback giữ nguồn khi không chứng minh được.
4. **Đưa vào đúng classic PDF đã có biên:** preview và export dùng một
   canonical vector, scope/fingerprint có mọi tham số, hiển thị số neo và
   lệch lớn nhất thực. Không chỉ nối sang Tách nhiều tem.
5. **Nghiệm thu:** cùng trang 12/cùng offset, ảnh neo và overlay trước-sau,
   giữ cusp/lỗ thật; đối chứng vector Illustrator nếu có; mở lại PDF thực,
   kiểm app đang chạy mã mới, sau đó driver/dao thật. Kiểm toàn Binder2 để
   chống suy diễn từ một outline duy nhất.

Lô đầu nên chỉ chạm lõi candidate + verifier + test (≤5 file), không đổi UI
cap ngay. Chỉ tích hợp sau khi frontier node/error/roughness có ích. Không
tuyên bố mất chi tiết là “node thừa”, không tự mở rộng tolerance vì cần đạt
một con số node đẹp. Theo `prynx-audit-workflow`, báo cáo này là chốt nghiên
cứu/đề xuất; chưa triển khai lô sản phẩm tiếp theo.

## 8. Bằng chứng và tái lập

- [Ảnh đối chiếu cùng tỷ lệ](D:/pdfcompare/docs/audit/SIMPLIFY_FAIRING_RESEARCH_2026-09-10/free-g1-comparison.png).
- [Số đo và cận độc lập](D:/pdfcompare/docs/audit/SIMPLIFY_FAIRING_RESEARCH_2026-09-10/verified-free-g1.json).
- [SVG nghiên cứu đã lượng tử](D:/pdfcompare/docs/audit/SIMPLIFY_FAIRING_RESEARCH_2026-09-10/candidate-quantized.svg)
  — không phải file lệnh dao đã nghiệm thu.
- Paper/VTracer: `D:/pdfcompare/tmp/pdfs/paper-baseline-20260910/RESEARCH_NOTES.md`,
  `measured-results.json`; `D:/pdfcompare/tmp/pdfs/vtracer-baseline-20260910/`.
- Native curve-fit-nd: `D:/pdfcompare/tmp/curvefit-nd-research-20260910/benchmark.py`,
  `results.csv`, `free_anchor.py`, `free-anchor/fairness_high_results.json`.
- Probe không đạt: `D:/pdfcompare/tmp/simplify-fairing-research-20260910/probe.py`,
  `fair_then_refit.py`, `results.json`, `fair-refit-results.json`.
- Script main đo/làm tròn/vẽ:
  `D:/pdfcompare/tmp/simplify-fairing-research-20260910/verify_free_g1.py`.
- Probe screenshot: `D:/pdfcompare/tmp/simplify-screenshot-research-20260910/analyze.py`.

Chạy từ `D:/pdfcompare`:

```powershell
.\backend\venv\Scripts\python.exe tmp/curvefit-nd-research-20260910/free_anchor.py
.\backend\venv\Scripts\python.exe tmp/curvefit-nd-research-20260910/free_anchor.py --fairness-high
.\backend\venv\Scripts\python.exe tmp/simplify-fairing-research-20260910/verify_free_g1.py tmp/curvefit-nd-research-20260910/free-anchor/free_g1_60_fair0.3.npy
```

Không build/release, không restart phiên PrynX, không đổi snapshot/golden,
không sửa PDF mẫu. Không chạy lại toàn pytest/Vitest vì không có thay đổi
mã sản phẩm trong lượt nghiên cứu. Các kiểm chất lượng được báo đúng là
probe, artifact nghiên cứu và phép đo độc lập; chưa nâng trạng thái RUNTIME.
