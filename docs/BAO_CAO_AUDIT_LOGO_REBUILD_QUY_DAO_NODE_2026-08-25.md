# BÁO CÁO AUDIT VECTOR HÓA LOGO — HOÀN THIỆN QUỸ ĐẠO VÀ GIẢM NODE

Ngày audit: 2026-08-25  
Phạm vi: tính năng **Vector hóa logo / Logo Rebuild**, từ raster đầu vào đến SVG xuất ra, gồm engine native, QC và UI/UX.  
Trạng thái: **đã triển khai lô sửa chính sau khi người dùng duyệt; verify được ghi trong nhật ký fixes.**

## 1. Kết luận điều hành

Phản ánh “đường vẫn lượn nhẹ, khúc khuỷu nhẹ và còn quá nhiều node” là **đúng**. Đây không phải lỗi hiển thị đơn thuần và cũng không thể giải quyết triệt để bằng cách tăng thanh **Độ mượt**.

Pipeline hiện tại đang tối ưu bài toán gần với:

> Bám một đường bao pixel trong sai số cho phép.

Trong khi mục tiêu người dùng cần là:

> Suy ra quỹ đạo hình học có chủ ý, biểu diễn nó bằng loại đường phù hợp và dùng số node ít nhất dưới một ngân sách sai số hình học có kiểm chứng.

Ba nguyên nhân gốc đã được xác nhận:

1. Biên đầu vào bị lượng tử thành đường đi theo cạnh ô pixel trước khi fitter làm việc, nên tín hiệu vị trí biên dưới pixel từ anti-alias gần như đã mất.
2. Corner detector và nhánh ưu tiên `Line` coi nhiều bước răng cưa của raster là góc thật; fitter cubic hiện là phiên bản cục bộ, thiếu tái tham số hóa Newton–Raphson và tối ưu toàn cục số đoạn.
3. QC hiện chủ yếu đo IoU/MAE raster và topology thô, chưa đo độ gợn, độ liên tục tiếp tuyến/độ cong, sai số hai chiều hoặc số node theo kích thước hình học.

Vì vậy, lời giải đúng không phải “xóa node hậu kỳ”, mà là kiến trúc **primitive-first + fair-curve reconstruction**:

```text
Raster/alpha liên tục
  → biên subpixel + shared-boundary graph
  → nhận góc thật đa tỷ lệ
  → nhận dạng line/circle/ellipse/arc/rounded-rect
  → fit đường cong tự do có G1, ưu tiên G2 và curvature fairness
  → tối thiểu số đoạn dưới geometric error budget
  → QC hình học hai chiều + QC raster
  → SVG semantic hoặc cubic tương thích
```

## 2. Bằng chứng từ ảnh người dùng và probe production

### 2.1 Ảnh người dùng

Ảnh chụp 1087 × 854 cho thấy biên xanh/trắng gồm nhiều đoạn gần thẳng nối nhau với các đổi hướng nhỏ. Phân tích raster ở sai số RDP 1 px cho kết quả:

| Biên đo | Số mốc còn lại | Góc đổi hướng trung vị | Góc lớn nhất |
|---|---:|---:|---:|
| Đỏ–trắng | 18 | 6,21° | 15,48° |
| Trắng–xanh | 10 | 8,13° | 13,72° |

Đây là bằng chứng định lượng rằng khúc gãy nhìn thấy là có thật. Tuy nhiên ảnh chụp không chứa lệnh path gốc, nên trạng thái finding cho đúng artifact này là **CONFIRMED VISUAL**; muốn quy trách nhiệm chính xác từng command `L/C/A` cần SVG và raster nguồn của phiên đó.

### 2.2 Probe hình tròn qua engine thật

Probe FlatColor với hình tròn raster 256 × 256:

| Độ mượt | Node nguồn → output | Thành phần output | IoU | Trạng thái QC |
|---:|---:|---|---:|---|
| 0 | 564 → 196 | 196 Line, 0 Cubic | 0,996818 | `ready` |
| 0,5 | 564 → 42 | 28 Line, 14 Cubic | 0,994703 | `ready` |
| 1 | 564 → 24 | 14 Line, 10 Cubic | 0,993715 | `ready` |

Node còn tăng theo độ phân giải với cùng một hình học: FlatColor, độ mượt 1 cho kết quả 64² → 6 node, 128² → 10 node, 256² → 24 node. Điều này chứng minh output chưa có tính bất biến theo tỷ lệ và chưa mang ngữ nghĩa “đường tròn”.

Probe đúng ABI structured core với đĩa 160 × 160, bán kính 60 px còn cho thấy profile Silhouette ở độ mượt 1 vẫn xuất 108 `Line`, bán kính tại node dao động 59,363–60,605 px và có góc quay cực đại 90°. IoU xấp xỉ 0,9948 vẫn không nói lên rằng đường cong đã sạch.

## 3. Trace luồng production

```text
LogoRebuildWorkspace
  → backend logo_rebuild
  → engine = prynx_core
  → preprocess_rgba
  → extract_contours
  → classify/build layers
  → simplify_closed + corner detection
  → fit_closed_ring
  → VectorScene
  → SVG writer
  → raster QC
```

Các điểm can thiệp chính:

- `native/src/logo_engine/preprocess.rs`
- `native/src/logo_engine/contour.rs`
- `native/src/logo_engine/simplify.rs`
- `native/src/logo_engine/curve_fit.rs`
- `native/src/logo_engine/profiles/flat_color.rs`
- `native/src/logo_engine/profiles/silhouette.rs`
- `native/src/logo_engine/scene.rs`
- `native/src/logo_engine/svg_writer.rs`
- `native/src/logo_engine/qc.rs`
- `backend/app/workers/logo_rebuild.py`
- `backend/app/workers/logo_svg_cleanup.py`
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`

## 4. Findings có bằng chứng

### F-01 — P1 CONFIRMED: mất quỹ đạo subpixel trước khi fit

- `native/src/logo_engine/contour.rs:66-115` dựng contour theo cạnh ô pixel nguyên, tạo các bước ngang/dọc.
- `native/src/logo_engine/contour.rs:174` và `:208-223` chủ yếu bỏ điểm thẳng hàng, không khôi phục iso-line subpixel.
- `native/src/logo_engine/preprocess.rs:52-67` phân lớp alpha/màu thành nhãn rời; FlatColor buộc mỗi pixel thuộc đúng một palette label.

Hậu quả: fitter không nhìn thấy quỹ đạo tiềm ẩn mà chỉ nhìn thấy một polygon bậc thang. Mọi thuật toán fit sau đó đều phải đoán lại thông tin đã bị lượng tử hóa.

### F-02 — P1 CONFIRMED: corner/line-first heuristic biến răng cưa thành hình học

- `native/src/logo_engine/curve_fit.rs:77-79` chỉ dành 1/4 tolerance cho RDP.
- `native/src/logo_engine/curve_fit.rs:81-127` phân loại góc trên contour raster bằng cửa sổ/ngưỡng cục bộ rồi chia smooth run tại các điểm đó.
- `native/src/logo_engine/curve_fit.rs:216-225` xuất `Line` ngay nếu span gần dây cung trong tolerance, trước khi thử mô hình cong.
- `native/src/logo_engine/profiles/flat_color.rs:94-104` dùng tolerance cố định khoảng 1–2 px.
- `native/src/logo_engine/profiles/silhouette.rs:74-83` dùng tolerance cố định khoảng 0,25–1 px.

Hậu quả: cùng một logo ở DPI cao hơn sinh nhiều node hơn; đường tròn có thể thành hỗn hợp nhiều line/cubic hoặc hoàn toàn là line.

### F-03 — P1 CONFIRMED: fitter cubic chưa hoàn chỉnh và tối ưu cục bộ

- `native/src/logo_engine/curve_fit.rs:228-263` dùng chord-length parameterization, least-squares fit rồi chia tham lam tại sample lỗi lớn nhất.
- Không có vòng Newton–Raphson reparameterization như thuật toán Schneider gốc.
- Không có merge/global dynamic programming để ưu tiên số đoạn tối thiểu trong cùng tolerance.
- Join hiện mới chia sẻ hướng tangent ở một số nhánh; chưa có gate G2 hay hàm phạt biến thiên độ cong.

Hậu quả: fitter dễ chia quá sớm, tạo nhiều cubic ngắn; các cubic có thể cùng bám sample nhưng vẫn gợn giữa sample.

### F-04 — P1 CONFIRMED: QC tối ưu fidelity raster nhưng mù với fairness

- `native/src/logo_engine/curve_fit.rs:136-141` và `:410-415` chỉ đo từ sample nguồn đến output path; không đo chiều output → nguồn.
- Topology tại `native/src/logo_engine/topology.rs:80-88` được kiểm trên polygon nguồn trước khi fit, không đủ để bắt self-intersection sinh ra sau fit.
- `native/src/logo_engine/qc.rs:145-205` thiên về IoU/MAE raster; `:529-551` chủ yếu kiểm winding/area sign.
- Production ở `backend/app/workers/logo_rebuild.py:1318-1331` không truyền ngưỡng `min_iou`/`max_mae` để gate chặt.
- `backend/app/workers/logo_svg_cleanup.py:585-600` chỉ đẩy review khi node vượt `max(20.000, area × 0,004)`; mức này không bắt một circle 108–196 đoạn.

QC chưa đo:

- symmetric Hausdorff hoặc normal-distance hai chiều;
- tangent jump tại join;
- curvature jump, curvature total variation và số cực trị/điểm uốn thừa;
- segment ngắn bất thường, node trên chu vi vật lý;
- radial residual của circle/ellipse;
- self-intersection và topology sau fit.

### F-05 — P1 CONFIRMED: IR không thể biểu diễn circle/ellipse chính xác

- `native/src/logo_engine/scene.rs:30-40` chỉ có `Line` và `Cubic`.
- `native/src/logo_engine/svg_writer.rs:123-155` chỉ ghi `M/L/C/Z`.

Một đường tròn không thể được biểu diễn chính xác bằng hữu hạn cubic Bézier đa thức. Bốn cubic dùng hệ số kappa chỉ là xấp xỉ rất tốt. Muốn “không biến dạng” theo nghĩa toán học phải giữ primitive `Circle/Ellipse/EllipticalArc` và ghi `<circle>`, `<ellipse>` hoặc command `A`.

Theo SVG 2, một `<circle>` có thể được ánh xạ thành bốn cung ellipse một phần tư. Vì vậy cần hai profile xuất:

- **Hình học chuẩn:** giữ primitive semantic/arc, chính xác.
- **Tương thích phần mềm đồ họa:** chuyển primitive thành 4 cubic; dùng 8 cubic chỉ khi ngân sách sai số hoặc downstream bắt buộc.

### F-06 — P2 CONFIRMED: test hiện tại bỏ lọt lỗi production

- `native/src/logo_engine/curve_fit_tests.rs:105-137` tạo circle từ sample lượng giác trực tiếp, không đi qua contour ngang/dọc của production.
- Test chỉ yêu cầu có ít nhất 2 cubic và output node nhỏ hơn 1/3 nguồn; không khóa 4/8 anchor, radial error, all-cubic hoặc scale invariance.
- `native/src/logo_engine/profile_tests.rs:208-235` chỉ yêu cầu giảm hơn 2 lần và sai số không quá 2 px.

### F-07 — P1 SUSPECTED: biên cong dùng chung giữa hai màu có thể lệch/khe/chồng

- `native/src/logo_engine/topology.rs:24-74` tạo contour theo từng nhãn.
- `native/src/logo_engine/profiles/flat_color.rs:50-64` fit từng ring độc lập.

Identity “cùng một cạnh, đảo chiều” không còn được giữ. Finding này cần fixture hai vùng màu có biên cong để nâng từ **SUSPECTED** lên **CONFIRMED**.

## 5. Phân biệt hai bài toán người dùng yêu cầu

### 5.1 “Tự hoàn thiện quỹ đạo”

Đây là bài toán suy ý đồ từ raster, không có nghiệm duy nhất. Cùng một dải pixel có thể là đường tròn, ellipse, một spline tự do hoặc một nét cố tình méo. Engine phải dùng prior hình học và công khai mức can thiệp với người dùng.

Giải pháp:

1. Giữ alpha/color membership liên tục và dựng iso-line subpixel.
2. Resample đều theo arc length.
3. Phát hiện corner/junction bền qua nhiều tỷ lệ; chỉ khóa landmark thật.
4. Trên mỗi smooth run, thử model theo thứ tự line → circle/arc → ellipse → fair cubic spline.
5. Chỉ chấp nhận model khi residual hai chiều, area, winding và topology cùng đạt.
6. Với freeform, dùng regularization theo biến thiên độ cong và chỉ cho phép sửa trong fidelity band.

### 5.2 “100 node thành 4 hoặc 8 mà không biến dạng độ cong”

Không được hard-cap mọi đường còn 4/8 node. Quy tắc đúng là:

> Tối thiểu số node trước, nhưng luôn dưới sai số hình học và ràng buộc topology/fairness.

- Circle/ellipse nhận dạng đúng: 1 primitive semantic; hoặc 4/8 anchor ở profile cubic.
- Rounded rectangle: line + arc/cubic theo đúng các corner.
- S-curve/freeform: số node phụ thuộc số điểm uốn, extrema độ cong và tolerance; có thể cần hơn 8.
- Xóa node mà không refit toàn đoạn sẽ làm biến dạng; RDP đơn thuần chỉ tạo ít đoạn thẳng hơn.

## 6. Kiến trúc giải pháp đề xuất

### Tầng A — Subpixel boundary reconstruction

- Không nhị phân hóa alpha thành `0`/`>0` trước khi ước lượng biên.
- Với silhouette, lấy iso-contour coverage bằng marching squares nội suy.
- Với FlatColor, ước lượng vị trí chuyển màu theo hỗn hợp của hai màu palette hoặc signed distance.
- Dựng shared-boundary graph: hai vùng kề nhau tham chiếu cùng một geometry, một bên dùng chiều đảo ngược.

### Tầng B — Semantic segmentation của đường bao

- Resample đều theo chiều dài cung, tránh để mật độ pixel chi phối quyết định.
- Corner detection đa tỷ lệ/curvature scale-space.
- Pin corner, cusp, junction và điểm tiếp giáp topology; không pin staircase turn.
- Tách smooth runs giữa các landmark.

### Tầng C — Primitive recognition

Thử các candidate theo complexity tăng dần:

1. Total-least-squares line.
2. Circle/circular arc với khởi tạo đại số và refine theo orthogonal distance.
3. Ellipse/elliptical arc với direct least-squares init, sau đó geometric refinement.
4. Rounded rectangle/capsule khi pattern line–arc lặp và residual đạt.

Chọn model theo mục tiêu lexicographic:

```text
(đạt toàn bộ hard constraints?)
  → ít primitive/segment nhất
  → max geometric error nhỏ nhất
  → curvature ripple nhỏ nhất
```

Không nhận primitive nếu angular coverage quá ngắn, đè qua corner, đổi topology hoặc residual chỉ tốt một chiều.

### Tầng D — Generic fair-curve fitter

- Schneider đầy đủ: chord-length init → least squares → Newton–Raphson reparameterization 4–5 vòng → split khi vẫn vượt tolerance.
- Sample thích ứng theo độ cong, không chỉ sample thưa theo input vertices.
- Ràng buộc G1 tại smooth join; ưu tiên G2 khi ổn định.
- Hàm mục tiêu gồm data error + segment penalty + curvature-variation penalty.
- Post-merge/global dynamic programming để tìm ít đoạn nhất dưới hard error budget.
- Giữ đúng số inflection; không tạo self-intersection hoặc curvature extrema mới không có bằng chứng.

### Tầng E — Scene IR và writer

Mở rộng segment/shape IR với:

- `CircularArc` hoặc `EllipticalArc`;
- `Circle`/`Ellipse` semantic nếu scene model phù hợp;
- conversion chuẩn sang 4/8 cubic cho compatibility profile.

### Tầng F — Geometric QC

QC mới chạy trên SVG/artifact cuối, không chỉ scene trung gian:

- distance hai chiều bằng adaptive subdivision + nearest/normal projection;
- topology, winding, signed area và self-intersection sau fit;
- tangent angle tại join;
- curvature jump, total variation và số inflection/extrema;
- radial/elliptic residual cho primitive;
- node/segment count chuẩn hóa theo perimeter và kích thước vật lý;
- render nhiều scale + boundary F-score, song song với IoU/MAE hiện tại.

## 7. Đề xuất UI/UX

Thanh **Độ mượt** hiện gom nhiều quyết định khác nhau vào một tolerance cố định theo pixel. Người dùng không biết nó đang xóa noise, bo góc, đổi silhouette hay chỉ giảm node; cùng giá trị lại cho kết quả khác theo DPI.

Đề xuất thay bằng ba preset có ngữ nghĩa:

| Preset | Mục tiêu | Hành vi |
|---|---|---|
| **Bám sát bản gốc** | Giữ chi tiết nhỏ | tolerance thấp, primitive chỉ nhận khi residual rất chắc |
| **Cân bằng** | Mặc định | subpixel + primitive + fair cubic, bảo toàn landmark |
| **Hoàn thiện quỹ đạo** | Logo phẳng/hình học | regularization mạnh hơn trong fidelity band; luôn đánh dấu cần xem lại khi confidence thấp |

Khối **Nâng cao** nên có:

- `Sai số tối đa` theo px ở kích thước nguồn và quy đổi sang mm khi có DPI;
- `Giảm node` là mục tiêu trong error budget, không phải tỷ lệ xóa cố định;
- `Ưu tiên hình học chuẩn` bật nhận circle/ellipse/line/arc;
- `Định dạng đường`: Hình học chuẩn / Cubic tương thích;
- tùy chọn bảo toàn góc, lỗ nhỏ và nét mảnh.

Preview cần hiển thị:

- node trước → sau;
- loại segment (`Line / Arc / Cubic`);
- sai số cực đại và RMS;
- cảnh báo topology hoặc confidence thấp;
- overlay/heatmap vùng bị thay đổi, bật/tắt trước–sau;
- zoom kiểm 800–1600% và nút “chỉ xem vùng sai số cao”.

Không nên hứa “không biến dạng” nếu output là cubic approximation. Copy chính xác hơn:

- semantic primitive: **Giữ hình học chính xác**;
- cubic: **Sai số hình học tối đa … px/mm**.

## 8. Acceptance criteria

Các ngưỡng dưới đây là gate khởi đầu; chỉ điều chỉnh sau khi có golden dataset và phải ghi rõ lý do.

### 8.1 Hard gates chung

- Không đổi số component/hole, winding hoặc Euler characteristic ngoài thay đổi được người dùng duyệt.
- Không self-intersection mới.
- Symmetric geometric distance không vượt tolerance cấu hình cộng uncertainty band của raster.
- Smooth join có tangent jump ≤ 1°; corner/cusp thật được miễn gate này và phải giữ nguyên phân loại.
- Không sinh thêm inflection trên fixture monotone-convex.
- Output SVG parse/render lại phải đạt cùng gate, không chỉ scene nội bộ.

### 8.2 Circle/ellipse

- Raster circle/ellipse tại 64/128/256/512 px, tâm nguyên và lệch subpixel, có/không anti-alias.
- Profile hình học chuẩn: một circle/ellipse hoặc các arc semantic tương đương.
- Profile cubic: circle thường là 4 anchor; chỉ tăng 8 khi approximation budget yêu cầu; không còn `Line` xen trong smooth ring.
- Sai số của conversion primitive → cubic được tách khỏi residual raster → primitive và phải nằm trong budget.
- Node count không tăng theo DPI khi hình học chuẩn hóa là cùng một hình.
- Đo radial max/RMS, eccentricity/axis error và symmetric distance.

### 8.3 Freeform và corner

- Rounded rectangle, capsule, S-curve, star, cusp, chữ Việt có dấu, counter/hole và nét hẹp.
- S-curve giữ đúng số inflection, G1/G2 tại smooth join, không có curvature ripple phụ.
- Corner thật không bị bo; staircase turn không được biến thành corner.
- Biên chung hai màu phải dùng cùng geometry đảo chiều, không khe/chồng khi render 8×.

### 8.4 Hiệu năng

- Benchmark thời gian/RAM trên máy <8 GB, <16 GB và ≥16 GB.
- Không hard-cap worker/chất lượng vô điều kiện; máy ≥16 GB giữ full capability theo quy tắc dự án.
- Primitive pass phải có fast reject; optimizer toàn cục có budget theo độ phức tạp contour, không theo một cap làm giảm chất lượng trên máy mạnh.

## 9. Benchmark/oracle

VTracer upstream 1.0.0-alpha.2/alpha.3 đã có:

- `--simplify <tolerance>` dùng Schneider re-fit từng smooth run, pin corner/junction;
- simplification trên shared boundary để giữ seam-free;
- densify trước fit để tránh cubic phình xa giữa các sample thưa;
- watershed boundary snap về color-midpoint iso-line.

Nên dùng upstream này như **shadow benchmark/oracle**, không nâng dependency production mù vì:

- bản phát hành vẫn alpha;
- pass simplify vẫn fit theo geometry đầu vào, nên có thể giữ lại wiggle;
- chưa giải semantic circle/ellipse, curvature fairness và hard geometric QC như yêu cầu PrynX.

Ma trận benchmark:

| Engine | Fidelity raster | Geometric error | Node | Fairness | Primitive | Topology | Thời gian/RAM |
|---|---:|---:|---:|---:|---:|---:|---:|
| PrynX core hiện tại | baseline | baseline | baseline | baseline | không | baseline | baseline |
| VTracer alpha.3 shadow | đo | đo | đo | đo | không | đo | đo |
| PrynX sau từng lô | không thấp hơn gate | đạt hard gate | tối thiểu trong budget | đạt | có | đạt | không hồi quy quá budget |

## 10. Kế hoạch sửa theo lô ≤5 file

### Lô 0 — Fixture và metric khóa lỗi

Mục tiêu: biến phản ánh thành test đỏ có số đo, trước khi đổi thuật toán.

- Thêm raster circle/ellipse đa DPI và artifact giống ảnh người dùng.
- Parse SVG thật để đếm `L/C/A`, anchor và đoạn ngắn.
- Thêm radial error, symmetric distance, tangent jump, curvature ripple và post-fit topology.
- Baseline PrynX core và VTracer shadow.

Điều kiện qua: test tái hiện đỏ đúng các lỗi F-01…F-06, benchmark lưu được artifact so sánh.

### Lô 1 — Fitter cubic hoàn chỉnh và safe merge

Mục tiêu: giảm node/freeform ripple trong kiến trúc hiện tại, chưa giả vờ giải primitive.

- Bổ sung Newton–Raphson reparameterization.
- Adaptive densification và kiểm reverse deviation.
- Smooth-run merge với hard error/topology guard.
- G1 gate và curvature-ripple metric.

Điều kiện qua: giảm node rõ trên fixture hiện tại, không đổi corner/topology, không vượt geometric tolerance.

### Lô 2 — Primitive IR + circle/ellipse/arc recognizer

Mục tiêu: giải trực tiếp trường hợp “circle 100 node → 4/8 hoặc exact”.

- Thêm primitive vào scene IR/writer.
- Robust line/circle/ellipse/arc fit và residual gate.
- Hai profile xuất semantic/cubic compatibility.
- Regression nhiều DPI/subpixel.

Điều kiện qua: circle/ellipse đạt acceptance 8.2 và node không tăng theo DPI.

### Lô 3 — Subpixel contour + shared-boundary graph

Mục tiêu: không làm mất tín hiệu anti-alias và không tạo seam giữa hai vùng màu.

- Coverage/midpoint iso-line.
- Shared edge identity và reverse reuse.
- Fixture biên cong hai màu, lỗ/nét hẹp.

### Lô 4 — Fair curve/global optimizer

Mục tiêu: hoàn thiện quỹ đạo freeform, không chỉ primitive.

- Corner đa tỷ lệ.
- Curvature-variation regularization.
- Global DP/shortest path tối thiểu segment dưới hard constraints.
- Golden S-curve/letterform/logo organic.

### Lô 5 — UI/UX và telemetry chất lượng

Mục tiêu: người dùng điều khiển đúng ý nghĩa và thấy được trade-off.

- Preset + advanced error budget/profile.
- Node/error/segment telemetry.
- Overlay heatmap và review workflow.
- i18n, keyboard/focus/accessibility và trạng thái loading/error.

Mỗi lô phải verify hẹp trước, sau đó chạy ma trận native/backend/desktop liên quan. Không cập nhật golden chỉ để làm test xanh; mọi thay đổi geometry phải soi artifact trước–sau.

## 11. Dữ liệu còn thiếu cho đúng ca người dùng

Để đưa đúng đường trong ảnh vào golden regression cần:

1. PNG/JPEG nguồn đã nạp, không phải ảnh chụp màn hình.
2. SVG được PrynX sinh đúng phiên đó.
3. Mode/profile, palette, smoothing, despeckle, upscale/crop/perspective và kích thước canvas.
4. Nếu có, vector/logo chuẩn dùng làm ground truth.

Thiếu các artifact này không cản việc sửa lỗi engine đã tái hiện bằng circle synthetic, nhưng cản việc cam kết đúng artifact cụ thể đã hết gợn.

## 12. Nguồn kỹ thuật chính

- Potrace, optimal polygon và OptiCurve: https://potrace.sourceforge.net/potrace.pdf
- Schneider/Graphics Gems implementation có Newton–Raphson: https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c
- SVG 2 circle/ellipse và ánh xạ circle thành bốn quarter arcs: https://www.w3.org/TR/SVG2/shapes.html
- SVG path/elliptical arc: https://www.w3.org/TR/SVG/paths.html
- Fitzgibbon, Direct Least Squares Fitting of Ellipses: https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/FITZGIBBON/ELLIPSE/
- Moreton–Séquin, minimum curvature variation/fairness: https://www2.eecs.berkeley.edu/Pubs/TechRpts/1992/6142.html
- Wang et al., Bézier Spline Simplification Using Locally Integrated Error Metrics: https://cims.nyu.edu/gcl/papers/2023-Bezier-Simplification.pdf
- NVIDIA/UBC, Subpixel Deblurring of Anti-Aliased Raster Clip Art: https://research.nvidia.com/publication/2023-05_subpixel-deblurring-anti-aliased-raster-clip-art
- VTracer releases và simplify/shared-boundary fixes: https://github.com/visioncortex/vtracer/releases

## 13. Quyết định đề xuất tại chốt 1

Đề nghị duyệt hướng **primitive-first + fair-curve**, triển khai trước **Lô 0 + Lô 1** để khóa metric và sửa fitter an toàn. Sau khi có artifact verify của hai lô này mới sang **Lô 2** cho circle/ellipse exact/4–8 anchor.

Không đề nghị chỉ tăng smoothing/tolerance, hard-cap node hoặc nâng VTracer alpha wholesale; các cách đó không đáp ứng đồng thời độ mượt, ít node, topology và sai số có kiểm chứng.
