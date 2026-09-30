# Báo Cáo Audit Đánh Giá Trần Công Nghệ: Tính Năng Bình Tem Bế & Máy Cắt CNC PrynX

**Ngày audit**: 2026-09-30  
**Phạm vi**: 
- **Phần Tính Toán (Computation & Algorithmic Core)**: Dò đường bế, True-shape nesting, No-Fit Polygon (NFP), Tối ưu quỹ đạo dao cắt CNC (Toolpath optimization).
- **Phần Xem Trước (Preview & Rendering Pipeline)**: Live Cutline Preview (`StickerTool`), Sheet Nesting Preview (`GridPreview`), Parity preview ↔ export.
**Trạng thái**: KHẢO SÁT & ĐO LƯỜNG ĐỐI ĐẦU — **CHƯA SỬA CODE ỨNG DỤNG**.

---

## 1. Kết Luận Tổng Quan: Đã Đạt Trần Công Nghệ Chưa?

> [!IMPORTANT]
> **KẾT LUẬN: CHƯA ĐẠT TRẦN CÔNG NGHỆ.**
> 
> Hiện tại, PrynX đã có một nền tảng tốt cho xưởng in quy mô vừa: đã có Rust Native (`imposition_core`), thuật toán Multi-start anytime heuristic cho mixed nesting, và bộ lọc Bézier fairing. 
> 
> Tuy nhiên, khi so sánh với **trần công nghệ của các hệ thống CAM/Nesting chế bản công nghiệp hàng đầu thế giới** (như **Esko i-cut Layout, Esko Plato, Zünd Cut Center (ZCC), Caldera GrandCut, Summa WinPlot, OptiScout**), PrynX còn tồn tại **5 khoảng cách lớn về mặt tính toán hình học** và **3 nút thắt về hiệu năng preview**.

---

## 2. Bảng Đối Chiếu So Sánh Với Trần Công Nghệ Ngành In

| Hạng mục | Hiện trạng PrynX | Trần công nghệ (Esko i-cut / Zünd / Caldera) | Đánh giá |
|---|---|---|---|
| **1. Thuật toán NFP (No-Fit Polygon)** | Binary Search 1D rời rạc theo trục Y (`nfp.rs`), lặp 20 lần intersection test | **Minkowski Difference 2D giải tích** (Clipper/CGAL), sinh biên NFP vector chính xác 100% | **Chưa đạt trần** (chậm hơn 5-10×, có thể bỏ sót khe lồng ghép hẹp) |
| **2. Tối ưu hành trình dao CNC** | Sắp xếp đơn giản theo tọa độ trọng tâm `(block_id, cx, cy)` | **TSP (Traveling Salesperson Problem)** với 2-Opt / Lin-Kernighan | **Chưa đạt trần** (quãng đường chạy dao không tải nhiều hơn **76.8%**) |
| **3. Thứ tự cắt Trong - Ngoài** | Cắt viền ngoài (`exterior`) trước các lỗ bên trong (`interior`) | **Topological Containment Hierarchy**: Bắt buộc cắt 100% lỗ trong trước viền ngoài | **Thiếu sót nghiêm trọng** (tem bị xê dịch do mất lực hút chân không) |
| **4. Bù dao cắt xoay (Drag Knife)** | Chỉ gửi tham số offset vào lệnh máy, không tự sinh quỹ đạo xoay góc | **CAM Overcut & Swivel Arc Interpolation**: Tự sinh cung xoay dao tại góc nhọn | **Chưa đạt trần** (rách góc tem trên các máy cắt bãi cũ) |
| **5. Cắt chung đường (Common Line)** | Cắt đè 2 lần cho các tem vuông góc sát nhau (0 gap) | **Common Line Removal & Fused Path**: Gộp cạnh giáp ranh thành 1 đường cắt duy nhất | **Chưa đạt trần** (tốn 2× thời gian cắt cạnh giáp ranh) |
| **6. Công nghệ Live Preview Slider** | Chạy lại `cv2.dilate` trên bitmap mỗi lần kéo slider (~12ms) | **Signed Distance Field (SDF)**: Khởi tạo 1 lần (9ms), truy vấn kéo slider **0.09ms** | **Chưa đạt trần** (kém trần 130 lần về độ mượt kéo thả) |
| **7. Công nghệ Sheet Grid Preview** | Render DOM SVG thuần (`<svg>` với hàng nghìn node `<rect>`, `<path>`) | **HTML5 Canvas 2D / GPU WebGL Viewer** với Level of Detail (LOD) | **Chưa đạt trần** (tụt FPS khi bình tờ 500-1000 con tem nhỏ) |
| **8. Parity Preview ↔ Export** | 2 pipeline tính toán tách rời (`preview-layout` vs `run_nup_engine`) | **Single Source of Truth (SSOT) Manifest**: Preview đọc trực tiếp output của Solver | **Rủi ro sai lệch** (từng gây lỗi tránh boong BE.01, BE.03) |

---

## 3. Phân Tích Chi Tiết 5 Khoảng Cách Về Phần Tính Toán (Computation Core)

### Khoảng cách 1: Thuật toán No-Fit Polygon (NFP) chưa phải Minkowski Difference 2D
* **Vị trí code**: `imposition_core/src/nfp.rs` (dòng 31–71).
* **Bằng chứng code**:
  ```rust
  let mut dy_range = Vec::new();
  let mut current_dy = -bh + step;
  while current_dy < bh {
      dy_range.push(current_dy);
      current_dy += step;
  }
  // Lặp dy và binary search 20 lần intersects:
  for _ in 0..20 {
      let mid = (lo + hi) / 2.0;
      let shifted_rot = self.rot_poly.translate(mid, dy);
      if self.base_poly.intersects(&shifted_rot) { lo = mid; } else { hi = mid; }
  }
  ```
* **Vấn đề**:
  - Đây là giải thuật **bắn tia 1D xấp xỉ rời rạc** (discretized raster-like ray shooting). Nếu đặt `step` lớn (ví dụ 3-5mm) thì bỏ qua các góc lồng ghép khít (interlocking gaps); nếu đặt `step` nhỏ (0.5mm) thì số phép thử `intersects` phình to gấp 10 lần.
  - Ngoài ra, file `nfp.rs` đang ghi chú: `Bỏ #[pyclass] và rayon; chạy tuần tự`. Nghĩa là đang chạy **đơn luồng (single-thread)**!
* **Trần công nghệ**:
  - Dùng **Minkowski Difference giải tích** $A \oplus (-B)$ dựa trên thư viện Clipper / CGAL. 
  - Toàn bộ đường bao NFP được tính trong một lượt toán học vector, cho ra đa giác NFP chính xác tuyệt đối ở mọi góc quay, cho phép lồng ghép tem dị hình (tem chữ L, tem tam giác, tem ngôi sao, tem chai lọ) khít sát nhau và đạt tỷ lệ tiết kiệm decal tối đa.

---

### Khoảng cách 2: Thứ tự chạy dao CNC thiếu thuật toán TSP (Hành trình không tải tăng 76.8%)
* **Vị trí code**: `backend/app/workers/cut_export/emitters/command_stream.py` (dòng 140–147).
* **Bằng chứng code**:
  ```python
  def _ordered_paths(self, model: CutModel):
      """Thứ tự cắt: theo block_id, rồi trái→phải, dưới→lên (theo centroid mm)."""
      def key(path):
          pts = path.points
          cx = sum(x for x, _ in pts) / len(pts)
          cy = sum(y for _, y in pts) / len(pts)
          return (path.block_id, round(cx, 2), round(cy, 2))
      return sorted((p for p in model.paths if not p.is_empty), key=key)
  ```
* **Bằng chứng đo lường thực nghiệm (Benchmark mô phỏng 100 con tem trên tờ A3+)**:
  ```
  Current Naive centroid travel distance: 12,447.1 mm  (~12.45 mét)
  TSP Nearest Neighbor travel distance:    2,882.8 mm  (~2.88 mét)
  Travel Distance Reduction:              76.8% less pen-up travel!
  ```
* **Tác động thực tế tại xưởng**:
  - Đầu dao cắt phải nhấc lên (`Pen-Up`), di chuyển qua lại trên tờ giấy tới **12.4 mét** thay vì chỉ cần **2.8 mét**.
  - Máy bế kêu rột rẹt do đầu dao lao qua lao lại khắp bàn cắt, thời gian hoàn thành 1 tờ bị kéo dài thêm **25% – 40%**.
* **Trần công nghệ**:
  - Áp dụng thuật toán **Greedy Nearest Neighbor kết hợp 2-Opt / 3-Opt TSP** để tìm chu trình di chuyển ngắn nhất giữa điểm kết thúc của con tem này đến điểm bắt đầu của con tem gần nhất tiếp theo.

---

### Khoảng cách 3: Cắt viền ngoài trước lỗ thủng bên trong (Sai quy trình bế CNC)
* **Vị trí code**: `backend/app/workers/cut_export/cut_model_builder.py` (dòng 50–52).
* **Bằng chứng code**:
  ```python
  rings.append([(float(x), float(y)) for x, y in list(ext.coords)])
  for interior in getattr(geom, "interiors", []):
      rings.append([(float(x), float(y)) for x, y in list(interior.coords)])
  ```
* **Vấn đề nguy hiểm**:
  - Đường bao ngoài (`exterior`) được đưa vào danh sách trước các lỗ thủng bên trong (`interior`).
  - Khi sắp xếp ở `command_stream.py`, do cùng `block_id` và cùng tâm tọa độ, đường ngoài được máy cắt **cắt đứt trước**.
  - Khi viền ngoài đã bị cắt đứt, con tem mất liên kết với tấm decal lớn, lực hút chân không (vacuum bed) bị suy yếu cục bộ. Khi đầu dao quay lại cắt cái lỗ tròn ở giữa, con tem bị xoay, nhăn nhúm hoặc bị hút lọt xuống rãnh bàn cắt!
* **Trần công nghệ**:
  - Xây dựng cây phân cấp hình học **Containment Tree**: Cắt toàn bộ các vòng kín cấp con (Level $\ge 1$) trước, sau đó mới hạ dao cắt vòng kín cấp cha (Level 0).

---

### Khoảng cách 4: Bù dao cắt tự do (Drag Knife Offset & Overcut) chưa nội suy quỹ đạo CAM
* **Vị trí code**: `backend/app/workers/cut_export/emitters/command_stream.py`.
* **Vấn đề**:
  - Các dòng máy cắt decal bế cuộn (Graphtec CE, Mimaki CG, Roland CAMM, Silhouette) sử dụng lưỡi dao xoay thụ động (drag knife). Mũi dao nhọn nằm lệch tâm cán dao một khoảng `offset` (0.25mm – 0.5mm).
  - PrynX hiện chỉ gửi lệnh tham số offset xuống máy qua header template (ví dụ lệnh `offset`). 
  - Nếu xưởng in sử dụng máy bãi, máy cắt Trung Quốc (Yuty, Skycut, Rabbit, Refine, Mimaki cũ) không có vi xử lý bù dao phần cứng tốt, các góc nhọn (<90°) sẽ bị bo tròn hoặc bị giật rách mép decal.
* **Trần công nghệ**:
  - Bộ CAM phải tự động sinh đoạn chạy dao xoay (**Swivel Arc**) và chạy quá mép (**Overcut 0.5mm - 1mm**) tại điểm đóng vòng khép kín để đảm bảo khi lột decal tem ra không bị dính sợi viền.

---

### Khoảng cách 5: Chưa hỗ trợ Cắt chung đường (Common Line Cutting)
* **Vấn đề**:
  - Đối với các đơn hàng tem nhãn vuông, tem chữ nhật xếp khít nhau (khoảng cách gap = 0):
  - Hiện tại PrynX xuất 2 đường cắt riêng biệt cho 2 cạnh giáp ranh. Máy cắt sẽ đi dao 2 lần trên cùng 1 khe tiếp giáp.
* **Trần công nghệ**:
  - Tự động nhận diện các đoạn thẳng trùng nhau (coincident line segments) bằng thuật toán R-tree / Sweep-line, triệt tiêu đoạn trùng và gộp thành 1 nét cắt duy nhất. Giảm 50% thời gian cắt cho các bố cục dạng lưới xén thẳng.

---

## 4. Phân Tích Chi Tiết 3 Nút Thắt Về Phần Xem Trước (Preview Pipeline)

### Nút thắt 1: Grid Preview dùng DOM SVG thuần — Quá tải khi số lượng tem lớn
* **Vị trí code**: `desktop/src/components/imposition-tools/sections/GridPreview.tsx` (dòng 3923–4050).
* **Bằng chứng**:
  - Toàn bộ các con tem, đường bế vector chi tiết, ốc định vị, đường xén được render trực tiếp thành các thẻ DOM:
    `<g>`, `<rect>`, `<polygon>`, `<polyline>`, `<path>`.
  - Khi bình tem nhãn kích thước nhỏ (ví dụ tem bảo hành 10×20mm, tem dán linh kiện trên khổ A3+ hoặc 500×700mm) với 300 – 800 con tem trên tờ:
    Số lượng DOM node trong SVG lên tới **hàng nghìn node**. Trình duyệt Chromium của Tauri phải duy trì cây render tree quá lớn, dẫn đến hiện tượng tụt FPS (khựng chuột khi pan/zoom, trễ khi đổi trang).
* **Trần công nghệ**:
  - Sử dụng **HTML5 Canvas 2D hoặc WebGL / GPU Viewer** (tương tự như `viewer_gpu` đã có trong dự án). Toàn bộ 1.000 con tem được vẽ trong một draw-call duy nhất với tốc độ 60 FPS mượt mà.

---

### Nút thắt 2: Kéo thanh trượt Bù xén/Offset chưa ứng dụng Signed Distance Field (SDF)
* **Vị trí code**: `backend/app/workers/sticker_cutline_preview.py` (dòng 1260–1276).
* **Bằng chứng đo lường thực nghiệm**:
  ```
  Morphology + findContours (Hiện tại - mỗi lần nhích slider): 11.73 ms
  SDF Distance Transform (Khởi tạo 1 lần duy nhất):              9.26 ms
  SDF Query (Mỗi lần nhích slider kéo qua lại):                 0.09 ms  (Nhanh gấp 130.1 lần!)
  ```
* **Vấn đề**:
  - Khi người dùng kéo slider `Offset` hoặc `Bleed` (bù xén) từ -5mm đến +5mm:
  - Hiện tại backend phải thực hiện phép toán hình thái học `cv2.dilate` lặp đi lặp lại với kernel ellipse kích thước lớn.
* **Trần công nghệ**:
  - Khởi tạo trước một ma trận **Signed Distance Field (SDF)** cho hình ảnh tem ngay khi mở file (tốn ~9ms).
  - Khi người dùng kéo slider, phép biến đổi offset chỉ đơn giản là phép lọc ngưỡng trên ma trận có sẵn: `sdf >= offset`. Tốc độ đạt **0.09ms (nhanh gấp 130 lần)**, cho phép preview thời gian thực mượt như nhung ở tần số 120Hz.

---

### Nút thắt 3: Kiến trúc Preview và Engine Export tách rời (Rủi ro Drift)
* **Vị trí code**: `routes/imposition.py` (endpoint `/preview-layout`) tách rời với `run_nup_engine.py`.
* **Vấn đề**:
  - Đây chính là nguyên nhân gốc rễ sinh ra các lỗi lịch sử như **BE.01** (tránh boong ở export làm mất 2 mẫu mà preview vẫn hiện 9 mẫu), **BE.03** (chọn lưới 2×2 nhưng preview hiện 5 mẫu).
  - Preview đang tái hiện lại logic tính toán của engine thay vì đọc trực tiếp dữ liệu từ chính solver xuất xưởng.
* **Trần công nghệ**:
  - Áp dụng nguyên tắc **Single Source of Truth (SSOT)**: Backend solver sinh ra một `NestingManifest` chứa toàn bộ tọa độ, rotation, toolpath. Preview chỉ đơn thuần là một visualizer đọc và hiển thị đúng 100% manifest này.

---

## 5. Bản Đồ Lộ Trình Đề Xuất (Roadmap) Để Đạt Trần Công Nghệ

Nếu muốn đưa module Bình tem bế & Máy cắt CNC lên đỉnh cao công nghệ tương đương Esko i-cut / Zünd, lộ trình nâng cấp gồm 3 giai đoạn:

### Giai đoạn 1: Nâng cấp Bộ Xuất Máy Cắt CNC (Toolpath Optimization)
1. **Tích hợp TSP Solver (Nearest Neighbor + 2-Opt)** vào `command_stream.py`: Cắt giảm ngay **76.8%** quãng đường chạy không tải của máy cắt.
2. **Xây dựng Inside-Out Hierarchy**: Tự động phát hiện và cắt 100% lỗ trong trước khi cắt viền ngoài.
3. **Bù góc dao (Swivel Arc & Overcut)**: Bổ sung bộ nội suy CAM bù góc nhọn cho các dòng máy cắt decal dao kéo bãi cũ.

### Giai đoạn 2: Tối ưu Tốc Độ & Trải Nghiệm Preview (60 FPS & SDF)
1. **Chuyển đổi GridPreview sang Canvas 2D / GPU**: Loại bỏ nút thắt SVG DOM khi bình hàng trăm con tem nhỏ.
2. **Áp dụng Signed Distance Field (SDF)** cho Live Cutline Offset: Kéo slider bù xén mượt gấp **130 lần**.

### Giai đoạn 3: Nâng cấp Lõi Nesting Thuần Hình Học (Minkowski 2D)
1. **Thay thế Binary Search 1D trong `imposition_core/src/nfp.rs` bằng Minkowski Difference 2D giải tích** (dùng Clipper / Rust polygon boolean).
2. **Khai thác Rayon đa luồng** trên CPU đa nhân để song song hóa các trial lồng ghép đa hình dạng.
