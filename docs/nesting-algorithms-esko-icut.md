# Thuật toán Nesting trong Esko i-cut Suite

**Tài liệu chuyên sâu về No-Fit Polygon, Bottom-Left-Fill và các kỹ thuật packing hình bất kỳ**

---

## Mục lục

1. [Bối cảnh & Định vị bài toán](#1-bối-cảnh--định-vị-bài-toán)
2. [Kiến trúc thuật toán nesting trong i-cut Layout / i-cut Layout+](#2-kiến-trúc-thuật-toán-nesting-trong-i-cut-layout--i-cut-layout)
3. [Bài toán Irregular Bin Packing — hình thức hoá](#3-bài-toán-irregular-bin-packing--hình-thức-hoá)
4. [Pha hình học 1: No-Fit Polygon (NFP)](#4-pha-hình-học-1-no-fit-polygon-nfp)
5. [Pha hình học 2: Inner-Fit Polygon (IFP)](#5-pha-hình-học-2-inner-fit-polygon-ifp)
6. [Pha đặt: Bottom-Left-Fill (BLF)](#6-pha-đặt-bottom-left-fill-blf)
7. [Pha sắp thứ tự: Meta-heuristic bao ngoài](#7-pha-sắp-thứ-tự-meta-heuristic-bao-ngoài)
8. [Nhánh Guillotine Nesting](#8-nhánh-guillotine-nesting)
9. [Chiến lược Minimum Waste vs Minimum Layouts](#9-chiến-lược-minimum-waste-vs-minimum-layouts)
10. [Reverso, Double-sided và các tuỳ chọn nâng cao](#10-reverso-double-sided-và-các-tuỳ-chọn-nâng-cao)
11. [Xử lý xoay (rotation)](#11-xử-lý-xoay-rotation)
12. [Phân tích độ phức tạp & Kỹ thuật tăng tốc](#12-phân-tích-độ-phức-tạp--kỹ-thuật-tăng-tốc)
13. [Cấu trúc dữ liệu triển khai](#13-cấu-trúc-dữ-liệu-triển-khai)
14. [So sánh với đối thủ (Enfocus, Caldera, Onyx, deepnest.io)](#14-so-sánh-với-đối-thủ)
15. [Pseudo-code minh hoạ](#15-pseudo-code-minh-hoạ)
16. [Các case biên (degenerate cases) cần xử lý](#16-các-case-biên-degenerate-cases)
17. [Xu hướng nghiên cứu 2020-2026](#17-xu-hướng-nghiên-cứu-2020-2026)
18. [Tài liệu tham khảo](#18-tài-liệu-tham-khảo)

---

## 1. Bối cảnh & Định vị bài toán

**Esko i-cut Suite** là bộ phần mềm prepress dành cho ngành in ấn khổ lớn và digital finishing (máy cắt phẳng Kongsberg, cutter Zünd, Summa, v.v.). Trong bộ này, module chịu trách nhiệm nesting là:

- **i-cut Layout** — tối ưu hoá sheet layout đầy đủ (nesting + tiling + bleed + double-sided).
- **i-cut Layout Essential** — bản gọn cho sign-making.
- **i-cut Layout+** — bản mở rộng với nhiều tuỳ chọn nesting nâng cao.

Trong tất cả các bản, Esko phân **hai họ thuật toán nesting hoàn toàn khác nhau** ở tuỳ chọn *Nesting Type*:

1. **True Shape** — nesting theo biên dạng thực (contour) — bài toán **Irregular Bin Packing (2D)**.
2. **Guillotine** — nesting theo nhát cắt thẳng suốt tấm — bài toán **Guillotine Cutting Stock**.

Đây là hai bài toán tổ hợp riêng biệt, thuộc hai nhánh khác nhau của lý thuyết Cutting & Packing (phân loại Wäscher 2007).

> **Ghi chú thẩm quyền**: Esko không công bố công thức nội bộ chính xác (mã đóng). Nội dung dưới đây tái dựng thuật toán từ (a) tài liệu người dùng công khai của Esko, (b) hành vi quan sát được của phần mềm, và (c) các phương pháp khoa học kinh điển mà một hệ nesting công nghiệp bắt buộc phải dùng. Các thành phần cụ thể (ví dụ: có phải Genetic Algorithm hay Simulated Annealing) là suy luận có căn cứ, không phải khẳng định chính thức.

---

## 2. Kiến trúc thuật toán nesting trong i-cut Layout / i-cut Layout+

```
┌─────────────────────────────────────────────────────────────────┐
│                    INPUT: PDF cut contours + qty                │
└─────────────────────────────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Preprocessing:                                                 │
│    • Trích cut contour → đa giác (polygonization đường cong)   │
│    • Đơn giản hoá đa giác (Douglas-Peucker)                     │
│    • Áp gutter/kerf/bleed (Minkowski dilation)                  │
│    • Chuẩn hoá orientation (CCW cho A, CCW cho B)               │
└─────────────────────────────────────────────────────────────────┘
                                ▼
                    ┌───────────┴───────────┐
              True Shape                Guillotine
                    │                       │
        ┌───────────▼──────────┐  ┌────────▼────────────┐
        │ NFP cache            │  │ Guillotine cut tree │
        │ (precompute pairwise │  │ (recursive strip    │
        │  & với sheet → IFP)  │  │  decomposition)     │
        └───────────┬──────────┘  └────────┬────────────┘
                    ▼                       ▼
        ┌──────────────────────┐  ┌──────────────────────┐
        │ BLF placement        │  │ Beasley-style DP or  │
        │ + meta-heuristic     │  │ column generation    │
        │ (GA/SA sequencing)   │  │ per-strip            │
        └──────────┬───────────┘  └──────────┬───────────┘
                   │                          │
                   └──────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Post-processing:                                               │
│    • Reverso pairing (nếu bật)                                  │
│    • Back-side mirror layout (double-sided)                     │
│    • Least-cuts optimization (gộp cạnh trùng)                   │
│    • Sinh cut file (JDF/ACM/PDF+cut layer)                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Bài toán Irregular Bin Packing — hình thức hoá

### 3.1 Phát biểu toán học

Cho:
- Tập mảnh `P = {p₁, p₂, …, pₙ}`, mỗi mảnh `pᵢ` là một đa giác đơn (có thể lõm, có thể chứa lỗ), với số lượng cần in `qᵢ`.
- Tập tấm vật liệu `S` — hình chữ nhật kích thước `W × H` (hoặc strip vô hạn `W × ∞`).
- Tập góc xoay cho phép `R = {θ₁, θ₂, …, θₖ}` (thường `{0°, 90°, 180°, 270°}` hoặc `{0°, 180°}`).

Tìm ánh xạ đặt vị trí `f: P → ℝ² × R × ℕ` (toạ độ `(x,y)`, góc `θ`, chỉ số sheet), thoả:

**Ràng buộc**:
- (C1) **Không chồng lấn**: với mọi `i ≠ j` trên cùng sheet, `int(pᵢ) ∩ int(pⱼ) = ∅`.
- (C2) **Chứa trong sheet**: mọi `pᵢ ⊆ S`.
- (C3) **Đủ số lượng**: mỗi `pᵢ` xuất hiện đúng `qᵢ` lần.
- (C4) **Kerf/gutter**: khoảng cách cạnh–cạnh ≥ `g`.

**Mục tiêu** (chọn 1 trong 3):
- **Minimum Waste (Strip Packing)**: `min L` với `L = max{y_max của tất cả pᵢ}` trên một strip vô hạn.
- **Minimum Sheets (Bin Packing)**: `min |{sheet index đã dùng}|`.
- **Minimum Distinct Layouts (Cutting Stock)**: `min |{layout riêng biệt}|` với tổng số bản in đúng `qᵢ`.

### 3.2 Độ phức tạp

Bài toán này thuộc lớp **NP-hard**. Dạng quyết định "có xếp được `n` mảnh vào strip chiều cao `H` không?" là **NP-complete**. Không tồn tại thuật toán đa thức tối ưu (trừ khi P=NP). Mọi hệ CAM công nghiệp — kể cả Esko i-cut — đều dùng **heuristic + meta-heuristic**.

### 3.3 Tại sao không dùng test lượng giác trực tiếp?

Test chồng lấn hai đa giác `A`, `B` bằng cắt cạnh + point-in-polygon có độ phức tạp `O(m·n)` với `m`, `n` là số đỉnh. Trong meta-heuristic sinh hàng triệu configuration, chi phí này không chấp nhận được. Đó là lý do tất cả nesting engine hiện đại **precompute NFP một lần** cho mọi cặp mảnh, rồi test chồng lấn = **một điểm-trong-đa-giác duy nhất** — `O(m+n)` xuống `O(log(m+n))` với BSP/BVH.

---

## 4. Pha hình học 1: No-Fit Polygon (NFP)

### 4.1 Định nghĩa hình thức

Cho hai đa giác `A` (cố định) và `B` (di động, có điểm tham chiếu `rB` — thường lấy centroid hoặc đỉnh dưới-trái). Cho `B` tịnh tiến (không xoay, không lật) quanh `A`, luôn tiếp xúc với `A` mà không chồng lên. Quỹ tích của `rB` chính là **NFP(A,B)**:

$$
\text{NFP}(A,B) = \partial \big( A \oplus (-B) \big) = \partial \{ a - b : a \in A, b \in B \}
$$

trong đó `⊕` là Minkowski sum và `-B` là B lật dấu (phản chiếu qua gốc).

### 4.2 Tính chất then chốt

| Vị trí `rB` | Quan hệ A ↔ B | Cách test |
|---|---|---|
| Trong NFP | A và B chồng lấn | Point-in-polygon `O(v)` hoặc `O(log v)` |
| Trên biên NFP | A và B tiếp xúc (tối ưu packing) | Boundary test |
| Ngoài NFP | A và B rời nhau | Point-in-polygon |

Đây là **rút gọn cơ bản** biến bài toán collision-detection thành bài toán point-location.

### 4.3 Trường hợp cả A và B đều lồi

Thuật toán `O(m+n)`:

1. Định hướng A ngược chiều kim đồng hồ (CCW).
2. Định hướng `-B` theo chiều kim đồng hồ (CW) — thực tế lật `B` qua gốc và giữ CCW.
3. **Sort tất cả cạnh** của A và `-B` theo góc phương vị.
4. Nối chúng đầu-đuôi theo thứ tự đã sort → NFP là đa giác lồi.

### 4.4 Trường hợp lõm — bốn kỹ thuật

#### (a) Decomposition (phân rã lồi)

- Chia A → `{A₁,…,Aₘ}` đa giác lồi con (Seidel `O(n log n)`, Watson-Tobias, Hertel-Mehlhorn).
- Chia B → `{B₁,…,Bₙ}`.
- Sinh `NFP(Aᵢ, Bⱼ)` cho mọi cặp → `m·n` đa giác lồi con.
- **Hợp** thành NFP tổng: `NFP(A,B) = ⋃ᵢⱼ NFP(Aᵢ, Bⱼ)`.

**Khó**: khi hợp, các biên NFP con có thể cắt nhau → phải phân biệt "biên ngoài" (outer boundary) với "vùng lỗ trong" (holes). Đặc biệt khó khi A có lỗ thật hoặc concavity kiểu jigsaw.

#### (b) Minkowski Sum theo Ghosh (1993)

Ghosh đưa ra **bộ định lý cộng biên (boundary addition theorem)** cho cả trường hợp lồi và lõm. Bennell & Song (2008) tinh chỉnh thành thuật toán bước-từng-bước:

1. Chuẩn hoá orientation cạnh của A và `-B`.
2. Sinh tập ứng viên "edge concatenation" theo thứ tự góc.
3. Loại các cạnh không thuộc biên NFP (bằng "traceability test").

Mạnh nhưng nhiều edge case — cần cả kiểm tra concave vertex và interior loop.

#### (c) Sliding / Orbiting Algorithm (Mahadevan 1984, Whitwell 2005, Luo 2022)

**Đây là kỹ thuật được các nesting engine công nghiệp dùng phổ biến nhất**. Ý tưởng gốc: bắt chước định nghĩa NFP một cách trực tiếp — thực sự "trượt" B quanh A và ghi lại quỹ đạo `rB`. Mỗi vòng lặp sinh ra **một cạnh của NFP**:

**Bước 1 — Tìm touching group**

Quét mọi cặp (cạnh A, cạnh B) tìm vị trí tiếp xúc. Có 3 loại touching case:

- (a) Đỉnh A ↔ đỉnh B (touching group có 4 cạnh: 2 kề mỗi đỉnh).
- (b) Đỉnh A ↔ giữa cạnh B (touching group có 3 cạnh).
- (c) Đỉnh B ↔ giữa cạnh A (touching group có 3 cạnh).

**Bước 2 — Xác định vector tịnh tiến khả thi**

Từ mỗi touching group, sinh 1 vector ứng viên. Ứng viên khả thi khi và chỉ khi mọi touching group khác đều cho phép nó (test bằng "góc quay tự do" tại điểm tiếp xúc). Nếu có nhiều vector khả thi (case suy biến — concavity hẹp, jigsaw), chọn vector "gần nhất theo thứ tự cạnh" so với bước trước.

**Bước 3 — Tính chiều dài tịnh tiến**

Chiếu vector tại mỗi đỉnh `B` lên các cạnh `A` (và ngược lại). Đoạn chiếu ngắn nhất mà xảy ra giao cắt = độ dài an toàn. Đây là bước tốn thời gian nhất (`O(m·n)` mỗi lần lặp) — Luo 2022 đề xuất **point-exclusion strategy** dùng upper/lower bound theo phương của vector để loại các đỉnh không thể va chạm trước khi test.

**Bước 4 — Kiểm tra hoàn tất & search unvisited edges**

Sau khi tịnh tiến, kiểm tra `rB` đã trở về vị trí ban đầu chưa. Nếu chưa → lặp lại. Nếu A có concavity hẹp mà B không lọt vào bằng cách trượt liên tục → cần bước phụ **searching feasible starting position** để sinh thêm thành phần liên thông của NFP (internal NFP cho các "túi" bên trong A).

#### (d) Phi-function (Stoyan)

Biểu diễn quan hệ hình học bằng biểu thức đại số:
- `Φ(A, B; x, y, θ) > 0` → rời nhau
- `Φ = 0` → tiếp xúc
- `Φ < 0` → chồng lấn (giá trị âm = khoảng cách Euclid vào bên trong)

**Ưu**: xử lý được cả **cung tròn** — quan trọng cho nhãn/decal bo góc, logo hình tròn. Là biểu thức giải tích liên tục — có thể lấy gradient để dùng với continuous optimization.

**Nhược**: thiếu thuật toán tự động xây `Φ` từ đa giác đầu vào → khó tổng quát hoá. Chủ yếu dùng trong nghiên cứu, không phổ biến trong CAM thương mại.

### 4.5 Trường hợp có lỗ (holes)

Khi A có lỗ thật (ví dụ: khung tranh, chữ "O"), NFP có nhiều thành phần liên thông:

- **Outer NFP** — biên ngoài, cấm `rB` đi vào để khỏi chồng A từ ngoài.
- **Inner NFP** (một hoặc nhiều) — nằm bên trong lỗ, là **vùng cho phép** rB nằm ⇒ B có thể lồng vào lỗ của A.

Điểm này cho phép các phần mềm như i-cut, deepnest.io **lồng mảnh nhỏ vào lỗ của mảnh lớn** — tăng tỉ lệ vật liệu đáng kể trong in decal khung tranh hay pattern chữ.

### 4.6 Kích thước NFP

Với A có `m` đỉnh, B có `n` đỉnh:
- Trường hợp lồi–lồi: NFP có tối đa `m+n` đỉnh.
- Trường hợp lồi–lõm: `O(m·n)` đỉnh (worst case).
- Trường hợp lõm–lõm: **`O(m²·n²)` đỉnh** (worst case) — đây là lý do NFP cho các mảnh phức tạp có thể phình rất lớn và phải qua bước đơn giản hoá.

---

## 5. Pha hình học 2: Inner-Fit Polygon (IFP)

### 5.1 Định nghĩa

IFP là **song sinh của NFP**, dùng cho ràng buộc "B phải nằm hoàn toàn trong tấm S":

$$
\text{IFP}(S,B) = \{ (x,y) : B \oplus (x,y) \subseteq S \}
$$

Nếu S là hình chữ nhật `W × H` và B có bounding box `(bx, by, bw, bh)`:

```
IFP(S, B) = chữ nhật [-bx, W - bx - bw] × [-by, H - by - bh]
```

(khi `rB` là gốc toạ độ của B). Với S là đa giác bất kỳ (tấm vật liệu bị cắt vát), IFP tính bằng **Minkowski erosion**: `IFP = S ⊖ B`.

### 5.2 Vùng khả thi tại bước đặt thứ k

$$
\text{Feasible}_k = \text{IFP}(S, B_k) \ \setminus\ \bigcup_{i<k} \text{NFP}(A_i, B_k)
$$

- `rBₖ` **phải** ∈ IFP (ràng buộc chứa).
- `rBₖ` **không được** ∈ bất kỳ NFP nào của mảnh đã đặt.

Đây là **cấu trúc dữ liệu trung tâm** trong mỗi bước placement. Trong triển khai, `Feasible_k` là đa giác đôi khi rất phức tạp — nhưng chỉ cần **liệt kê các đỉnh của nó** để tìm điểm BL.

---

## 6. Pha đặt: Bottom-Left-Fill (BLF)

### 6.1 Nguyên tắc

BLF là heuristic đặt từng mảnh **một lần** (không di chuyển lại) sao cho mảnh mới nằm càng "thấp và trái" càng tốt trong vùng khả thi.

**Nguyên bản (Chazelle 1983)** — chỉ cho hình chữ nhật, chỉ dùng "skyline".

**Bottom-Left-Fill (Burke et al. 2006)** — mở rộng cho hình bất kỳ, **cho phép lấp các khoang (pockets)** đã hình thành trong các bước trước, không chỉ đặt lên skyline. Đây là bước nhảy chất lượng và là baseline cho mọi nesting engine hiện đại.

### 6.2 Thuật toán chi tiết bằng NFP

Input: thứ tự mảnh `π = (Bπ(1), Bπ(2), …, Bπ(n))`, tập góc xoay `R`.

```
Bước k (đặt Bπ(k)):
  1. Tính combined NFP:
        CNFP_k = ⋃_{i<k} NFP(Aᵢ, Bπ(k))
     (mỗi Aᵢ đã đặt với góc θᵢ, Bπ(k) xét ở góc θ ∈ R)

  2. Tính IFP_k = IFP(S, Bπ(k))

  3. Feasible_k = IFP_k \ CNFP_k

  4. Với mỗi góc θ ∈ R:
       Ứng viên BL = argmin_{p ∈ vertices(Feasible_k)} (p.y, p.x)
     (phá hoà bằng x, sau đó bằng θ có ít vật liệu thừa nhất)

  5. Đặt Bπ(k) tại điểm ứng viên tốt nhất qua các θ.
```

### 6.3 Đỉnh khả thi ứng viên

`Feasible_k` là hợp/hiệu của đa giác — biên của nó gồm:

- Đỉnh của IFP không bị CNFP che.
- Đỉnh của CNFP không bị IFP loại.
- Giao điểm cạnh giữa IFP và CNFP.

Ứng viên BL luôn là **một trong tập đỉnh này** — chỉ cần duyệt hữu hạn.

### 6.4 Biến thể

- **Bottom-Left-Fill với multi-criteria**: thay `min(y, x)` bằng hàm mục tiêu tổ hợp (min waste ngay lập tức, min "hố trống" tạo ra, max mật độ cục bộ).
- **Lowest-Gravity Fill**: thay BL bằng "hạ trọng tâm" — đẩy mảnh sao cho centroid có `y` nhỏ nhất.
- **Best-Fit BLF**: thử vài orientation, chọn cái tạo ít waste nhất — Esko chắc chắn dùng biến thể này.

### 6.5 Complexity mỗi bước

- Xây `CNFP_k`: `O(k·v)` (k mảnh đã đặt, v đỉnh trung bình).
- Boolean difference với IFP: `O(k·v·log(k·v))` với sweep line.
- Duyệt đỉnh: `O(k·v)`.

Tổng cho một permutation `n` mảnh: `O(n²·v·log(n·v))`.

---

## 7. Pha sắp thứ tự: Meta-heuristic bao ngoài

BLF chỉ trả lời "đặt ở đâu". Câu hỏi "**đặt theo thứ tự nào và góc xoay nào**" mới quyết định chất lượng. Không gian nghiệm: `n! × |R|ⁿ`.

### 7.1 Các heuristic sắp thứ tự đơn giản

| Rule | Mô tả | Ưu / nhược |
|---|---|---|
| **Decreasing Area** | Sort giảm dần theo diện tích | Baseline, hoạt động tốt cho mảnh "nặng" trước |
| **Decreasing Height** | Sort giảm dần theo chiều cao bounding box | Tốt cho strip packing |
| **Decreasing Density** | Sort giảm dần theo (area / bbox area) | Ưu tiên mảnh "đặc" trước |
| **Decreasing Perimeter** | Sort theo chu vi | Đôi khi cạnh tranh với area |
| **Convexity-Based** | Ưu tiên mảnh phức tạp lõm trước | Tránh kẹt hình phức tạp cuối cùng |

Esko i-cut Layout Essential (bản gọn) nhiều khả năng chỉ dùng rule đơn giản như "Decreasing Area + BLF".

### 7.2 Meta-heuristic thực sự

Bản đầy đủ (i-cut Layout / Layout+) hầu như chắc chắn có meta-heuristic bao ngoài. Các ứng viên:

#### (a) Tabu Search
- Neighborhood: hoán vị 2 mảnh, đảo đoạn, thay đổi 1 góc xoay.
- Tabu list: các move gần đây bị cấm để tránh lặp.
- Ưu: hội tụ nhanh, ít tham số.

#### (b) Simulated Annealing (SA)
- Chấp nhận nghiệm xấu với xác suất `e^(-ΔE/T)`, `T` giảm dần.
- Ưu: đơn giản, thoát cực trị địa phương tốt.
- Được dùng trong Optinest, một số phiên bản SigmaNEST.

#### (c) Genetic Algorithm (GA) — **ứng viên số 1 cho i-cut**
- Chromosome: hoán vị mảnh + vector góc xoay.
- Crossover: PMX (Partially Matched Crossover) hoặc OX (Order Crossover).
- Mutation: swap, insert, invert; góc xoay đột biến.
- Fitness: waste hoặc `L` từ BLF.
- Deepnest.io (dựa trên SVGnest) — mã nguồn mở tương đương chức năng — **chính xác dùng GA + BLF + NFP**.

#### (d) Column Generation cho Cutting Stock
- Cho **Minimum Layouts**: mô hình LP master + pricing subproblem sinh layout mới.
- Master: `min Σ xⱼ` s.t. `Σ aᵢⱼ · xⱼ ≥ qᵢ`, `xⱼ ≥ 0`, với `aᵢⱼ` = số lần mảnh `i` xuất hiện trong layout `j`.
- Pricing: sinh layout mới có reduced cost `1 - Σ πᵢ·aᵢⱼ < 0`. Subroutine sinh layout = BLF/NFP.

#### (e) Beam Search / Best-First
- Duy trì `k` nghiệm tốt nhất tại mỗi độ sâu, mở rộng song song.

#### (f) Reinforcement Learning (2023+)
- Policy network chọn mảnh và vị trí. Nghiên cứu mới nổi, chưa vào CAM thương mại.

### 7.3 Kết hợp thực tế trong công nghiệp

Kiến trúc phổ biến (deepnest, likely i-cut):

```
GA population
  ↓
mỗi individual (permutation + rotations)
  ↓
BLF placement (dùng cached NFP)
  ↓
fitness = 1 / (waste + λ·num_sheets)
  ↓
selection + crossover + mutation → generation kế
```

---

## 8. Nhánh Guillotine Nesting

Khi bật *Nesting Type: Guillotine*, i-cut chuyển sang **họ thuật toán hoàn toàn khác** — không dùng NFP, mà dùng **cấu trúc cây cắt đệ quy**.

### 8.1 Định nghĩa Guillotine cut

Một nhát cắt guillotine chạy **suốt từ mép này sang mép đối diện** của tấm/dải hiện tại. Kết quả: mỗi cắt chia tấm thành 2 tấm con.

Layout guillotine = **cây nhị phân** trong đó:
- Node trong: nhát cắt (ngang hoặc dọc) + toạ độ.
- Lá: mảnh đơn (hoặc waste).

### 8.2 Thuật toán kinh điển

- **Wang (1983) — bottom-up construction**: bắt đầu từ mảnh đơn, ghép cặp thành strips lớn dần.
- **Beasley (1985) — dynamic programming**: `V(x, y)` = giá trị tối ưu cho tấm `x × y`, quy hoạch động theo mọi vị trí cắt khả thi. Complexity `O(m·n·(m+n))` với chiều rời rạc `m × n`.
- **Christofides & Whitlock (1977)**: nhánh cận, exact.
- **Column generation**: cho unrestricted guillotine với số bản in nhiều.

### 8.3 Tuỳ chọn "Strips" trong i-cut

- **Allow mixed** — sau nhát đầu, mỗi strip có thể chứa nhiều loại job.
- **Single graphic** — mỗi strip chỉ 1 loại. Tương đương "n-stage cutting" bậc thấp.
- **Complete strips** — Single graphic + strip đầy hoàn toàn (waste chỉ ở đuôi strip cuối).

Ba mức này tương ứng với **1-stage, 2-stage, 3-stage cutting** trong lý thuyết Cutting Stock.

### 8.4 First Cut direction

Cho phép ép nhát đầu ngang hoặc dọc. Ràng buộc thực tế: máy guillotine chỉ có 1 trục cố định, đảo tấm mất thời gian.

---

## 9. Chiến lược Minimum Waste vs Minimum Layouts

### 9.1 Minimum Waste (chiến lược tối ưu vật liệu)

- Hàm mục tiêu: `min Σ waste_area` hoặc `min L` (chiều dài strip dùng).
- Cho phép **mỗi lần in một layout khác nhau**.
- Dùng khi: chi phí vật liệu >> chi phí setup máy cắt.
- Bài toán: **2D Irregular Strip Packing** thuần tuý.

### 9.2 Minimum Layouts (chiến lược tối ưu setup)

- Hàm mục tiêu: `min |{distinct layouts}|`.
- Ràng buộc: mỗi mảnh phải in đủ `qᵢ` bản.
- Dùng khi: setup máy cắt tốn nhiều thời gian (thay tool, calibration), số lượng in lớn.
- Bài toán: **2D Irregular Cutting Stock** — thường giải bằng column generation.

### 9.3 Overrun (in dư)

i-cut cho phép in dư `k%` với một số job. Tương đương relaxation ràng buộc:

```
Σⱼ aᵢⱼ · xⱼ ∈ [qᵢ, qᵢ · (1 + k/100)]
```

Cho phép **giảm số layout khác nhau** đáng kể — trade-off vật liệu thừa vs setup.

### 9.4 Ví dụ định lượng

Cho 5 loại nhãn, mỗi loại 1000 bản:

| Chiến lược | Layouts | Waste | Setup time |
|---|---|---|---|
| Minimum Waste | 47 khác nhau | 8% | 47 × 3 phút = 141 phút |
| Minimum Layouts (no overrun) | 5 layouts | 14% | 5 × 3 phút = 15 phút |
| Minimum Layouts + 5% overrun | 3 layouts | 12% | 9 phút |

Con số minh hoạ — thực tế phụ thuộc hình dạng cụ thể.

---

## 10. Reverso, Double-sided và các tuỳ chọn nâng cao

### 10.1 Reverso Nesting

Ý tưởng: với mảnh có cạnh nghiêng (tam giác, hình thang), **xen kẽ mảnh và mảnh xoay 180°** để chúng "kẹp" vào nhau như răng lược.

Triển khai: thêm `B_reversed = rot(B, 180°)` vào tập orientation. NFP mới `NFP(A, B_reversed)` được tính riêng. BLF chọn trong 2 orientation, ưu tiên cặp có tổng NFP thấp nhất.

**Ứng dụng**: nhãn tam giác, tem thư hình thang, decal bo góc chéo — tăng 8-25% mật độ.

### 10.2 Double-Sided Nesting

Với vật liệu in 2 mặt, layout mặt sau phải khớp mặt trước sao cho khi cắt xuyên qua tấm, cả 2 mặt đều đúng registration.

Triển khai:
1. Nest mặt trước bình thường bằng NFP+BLF.
2. Sinh layout mặt sau bằng **phép lật gương** (mirror qua trục X hoặc Y) của layout mặt trước.
3. Kiểm tra mảnh mặt sau (đã lật) có bounding box khớp mảnh mặt trước tại cùng vị trí.

### 10.3 Least-Cuts Optimization

Sau khi có layout, i-cut chạy pass tối ưu **đường cắt**: gộp các cạnh trùng của 2 mảnh liền kề thành **1 cut path chung** — máy cắt chỉ chạy 1 lần thay vì 2. Áp dụng chủ yếu cho mảnh chữ nhật hoặc mảnh có cạnh thẳng dài.

Bài toán liên quan: **Chinese Postman Problem** trên đồ thị cắt — tối thiểu tổng chiều dài route của đầu cắt.

### 10.4 Bleed & Gutter

- **Bleed**: mở rộng biên đồ hoạ ra ngoài cut path (thường 2-3 mm) để tránh viền trắng do lệch registration.
- **Gutter**: khoảng cách bắt buộc giữa các cut path (thường 3-5 mm) để dao cắt không xé rách.

Cả hai đều triển khai bằng **Minkowski dilation** đa giác đầu vào trước khi sinh NFP:

```
B_expanded = B ⊕ disk(gutter/2)
```

Sinh NFP trên `B_expanded` thay vì B gốc → gutter tự động được tôn trọng.

### 10.5 Tiling (cho oversized job)

Khi mảnh lớn hơn tấm vật liệu, i-cut tự động **cắt mảnh thành các tile chồng lấn** (overlap 5-10 mm), sinh registration mark cho việc ghép sau in. Đây không phải nesting mà là **decomposition** — nhưng cùng nằm trong panel Layout.

---

## 11. Xử lý xoay (rotation)

### 11.1 Discretization

NFP chỉ đúng cho **một cặp góc xoay cố định** của A và B. Nếu tập góc cho phép là `R = {0°, 90°, 180°, 270°}`, số NFP cần precompute:

$$
N_{\text{NFP}} = |P|^2 \cdot |R|^2 = n^2 \cdot 16
$$

Ví dụ 50 mảnh khác nhau, 4 orientation → 40 000 NFP. Mỗi NFP có thể 20-500 đỉnh → cache **hàng chục MB**.

### 11.2 Continuous rotation

Với xoay tự do (`R = [0°, 360°)`), phải:
- Rời rạc hoá góc (thường 12°, 15° hoặc 24° step) → tăng số NFP.
- Hoặc dùng **continuous NFP** (Martinez-Sykora 2017) — biểu diễn NFP là hàm của θ, tính bằng calculus of variations. Chỉ áp dụng được cho các case đơn giản.

### 11.3 Symmetry exploitation

Nếu B có đối xứng bậc `k` (chữ nhật: k=2; hình tròn: k=∞), giảm `|R|` xuống `|R|/k`. Esko phát hiện đối xứng tự động và bỏ NFP dư.

### 11.4 Rotation trong i-cut

Panel Nesting cho chọn:
- **None** — chỉ 0°.
- **90° steps** — {0°, 90°, 180°, 270°}.
- **180° only** — {0°, 180°} (cho vật liệu có "grain" — vân sợi).
- **Free** — rời rạc hoá nội bộ.

Grain constraint là ràng buộc vật liệu thật (vải, gỗ có vân) — không xoay 90° được vì vân sợi phải chạy đúng hướng.

---

## 12. Phân tích độ phức tạp & Kỹ thuật tăng tốc

### 12.1 Bảng complexity tổng hợp

| Phép toán | Best | Typical | Worst |
|---|---|---|---|
| Sinh NFP 2 đa giác lồi | `O(m+n)` | `O(m+n)` | `O(m+n)` |
| Sinh NFP lồi–lõm (sliding) | `O((m+n)²)` | `O(m·n)` | `O(m·n)` |
| Sinh NFP lõm–lõm (sliding) | `O(m·n)` | `O((m+n)²)` | `O(m²·n²)` |
| Precompute all NFP (n mảnh, R góc) | `O(n²·R²·v²)` | — | — |
| BLF 1 permutation | `O(n²·v)` | — | `O(n²·v·log)` |
| GA `G` generations, pop `P` | `O(G·P·n²·v)` | — | — |

### 12.2 Kỹ thuật tăng tốc cụ thể

#### (a) NFP Cache
- Precompute mọi cặp `(A, B, θ_A, θ_B)` một lần, lưu vào bảng băm.
- Với `n = 100` và `|R| = 4` → 160 000 entries.
- Bộ nhớ: 100-500 MB điển hình.

#### (b) Polygon Simplification
- Douglas-Peucker với `ε = 0.1-0.5 mm` giảm 60-80% số đỉnh mà không mất chất lượng cắt.
- **Bắt buộc** cho mảnh có đường cong (Bezier polygonized).

#### (c) Spatial Indexing
- R-tree hoặc BVH trên bounding box.
- Trong BLF, để tìm CNFP giao với IFP tại điểm ứng viên: `O(log n)` thay vì `O(n)`.

#### (d) Convex Decomposition Cache
- Với decomposition NFP, cache kết quả phân rã lồi mỗi mảnh.

#### (e) Symmetry Detection
- Trước khi precompute NFP, phát hiện `B` = `rot(B, α)` cho một `α` nào đó → bỏ orientation dư.

#### (f) Parallel NFP Computation
- Các cặp NFP độc lập → sinh song song trên nhiều core CPU. Modern CAM dùng 8-16 thread.

#### (g) GPU-accelerated Point-in-Polygon
- Với NFP cache trên GPU, test triệu vị trí trong meta-heuristic → tăng tốc 10-50×. Chưa rõ i-cut có dùng.

#### (h) Point Exclusion (Luo 2022 cho sliding)
- Trong bước compute translation distance, upper/lower bound theo phương vector loại trước các đỉnh không thể va chạm. Giảm 60-80% test giao cắt.

#### (i) Right-side Test
- Trong sliding, khi có nhiều vector khả thi, right-side test nhanh chóng loại vector không hợp.

### 12.3 Memory footprint điển hình

| Dự án | n | \|R\| | NFP cache | RAM tổng |
|---|---|---|---|---|
| Nhỏ (sign shop) | 10 | 4 | 5 MB | 200 MB |
| Trung bình (label printer) | 50 | 4 | 80 MB | 800 MB |
| Lớn (packaging plant) | 500 | 2 | 1.2 GB | 4 GB |

---

## 13. Cấu trúc dữ liệu triển khai

### 13.1 Đa giác

```cpp
struct Polygon {
    std::vector<Point2D> outer;         // biên ngoài, CCW
    std::vector<std::vector<Point2D>> holes;  // các lỗ, CW
    Point2D reference;                  // rB — điểm tham chiếu
    BBox bbox;                          // cache bounding box
    double area;                        // cache diện tích
    int part_id;                        // ID mảnh gốc
    int orientation;                    // index trong R
};
```

### 13.2 NFP cache

```cpp
using NFPKey = std::tuple<int, int, int, int>;  // (A_id, B_id, θA, θB)
using NFPCache = std::unordered_map<NFPKey, Polygon>;
```

### 13.3 Placement state

```cpp
struct Placement {
    int part_id;
    Point2D translation;   // (x, y) — vị trí rB
    int orientation;
    int sheet_index;
};

struct NestingResult {
    std::vector<Placement> placements;
    std::vector<Sheet> sheets;
    double total_waste;
    int num_distinct_layouts;
};
```

### 13.4 Sliding algorithm — pseudo state

```cpp
struct TouchingGroup {
    Edge edge_a1, edge_a2;   // 2 cạnh của A tại điểm tiếp xúc
    Edge edge_b1, edge_b2;   // 2 cạnh của B
    Point2D contact_point;
    TouchingType type;       // vertex-vertex, vertex-edge_A, vertex-edge_B
};
```

---

## 14. So sánh với đối thủ

| Phần mềm | NFP engine | Sequencing | Ghi chú |
|---|---|---|---|
| **Esko i-cut Layout** | Đóng, likely sliding + custom | Likely GA/SA | Tích hợp Kongsberg native |
| **Enfocus PitStop / PowerLayout** | Cơ bản, mainly rectangle-based | Sort heuristic | Prepress-oriented, không mạnh với irregular |
| **Caldera Nesting-cut** | True-shape với NFP | Local search | Mạnh cho grand format |
| **Onyx Layout Tool** | True-shape | Sort + local swap | Simple, tốc độ cao |
| **SigmaNEST** | Mixed (NFP + phi-function claims) | Advanced GA | Mạnh cho sheet metal — kim loại |
| **Optinest (Alma CAM)** | NFP + advanced | SA + tabu | Chuyên vật liệu tấm |
| **Deepnest.io** (open source) | Minkowski via Clipper + sliding | GA (SVGnest-based) | Miễn phí, phổ biến cho Kongsberg tự chế |
| **SVGnest** (open source, web) | Sliding NFP | GA nhỏ | Origin của deepnest |
| **CutLogic 2D** | Guillotine chủ yếu | Beasley DP | Chuyên guillotine |

**Nhận xét**: về mặt thuật toán, không có bí mật nào riêng của Esko — công cụ khác biệt là (a) chất lượng triển khai NFP robust, (b) tích hợp workflow với Kongsberg (JDF, mark generation, production console), (c) UI panel prepress mature.

---

## 15. Pseudo-code minh hoạ

### 15.1 Sliding NFP (đơn giản hoá)

```python
def sliding_nfp(A, B):
    """
    A: fixed polygon (CCW)
    B: orbital polygon (CCW), điểm tham chiếu rB = B[0]
    Trả về: NFP polygon (list điểm)
    """
    # Đặt B sao cho y_min(B) chạm y_max(A)
    B = translate(B, start_position(A, B))
    trace = [rB(B)]
    prev_move = None

    while True:
        # 1. Tìm touching groups
        groups = find_touching_groups(A, B)
        if not groups:
            break  # Không còn tiếp xúc — kết thúc

        # 2. Chọn vector tịnh tiến khả thi
        candidates = [potential_vector(g) for g in groups]
        feasible = [v for v in candidates if is_feasible(v, groups)]
        vector = choose_by_edge_order(feasible, prev_move)

        # 3. Tính chiều dài an toàn
        max_dist = compute_max_translation(A, B, vector)
        vector = truncate(vector, max_dist)

        # 4. Tịnh tiến B
        B = translate(B, vector)
        trace.append(rB(B))
        prev_move = vector

        # 5. Kiểm tra đóng vòng
        if len(trace) > 2 and distance(trace[-1], trace[0]) < EPS:
            break

    # Tìm thêm starting position cho concavity hẹp
    additional = search_unvisited_starts(A, B, trace)
    for start in additional:
        trace.extend(sliding_nfp_from(A, B, start))

    return simplify_polygon(trace)
```

### 15.2 BLF placement

```python
def blf_place(parts_sequence, sheet, rotations, nfp_cache):
    placements = []
    for i, part in enumerate(parts_sequence):
        best = None
        for theta in rotations:
            B = rotate(part, theta)
            ifp = compute_ifp(sheet, B)
            cnfp = None
            for prev in placements:
                nfp = nfp_cache[(prev.part_id, part.id, prev.theta, theta)]
                nfp_translated = translate(nfp, prev.translation)
                cnfp = polygon_union(cnfp, nfp_translated)

            feasible = polygon_difference(ifp, cnfp)
            if not feasible.is_empty():
                # Chọn đỉnh có (y, x) nhỏ nhất
                bl_point = min(feasible.vertices(), key=lambda p: (p.y, p.x))
                if best is None or bl_point.y < best.y:
                    best = (bl_point, theta)

        if best is None:
            # Không đặt được — cần sheet mới hoặc bỏ mảnh
            sheet = new_sheet()
            placements = []
        else:
            placements.append(Placement(part.id, best[0], best[1]))

    return placements
```

### 15.3 GA outer loop

```python
def ga_nest(parts, sheet, rotations, generations=100, pop_size=50):
    population = [random_permutation(parts) for _ in range(pop_size)]

    for gen in range(generations):
        # Evaluate
        fitness = [
            -total_waste(blf_place(ind, sheet, rotations, nfp_cache))
            for ind in population
        ]

        # Selection (tournament)
        parents = tournament_select(population, fitness, k=3)

        # Crossover (PMX)
        offspring = []
        for p1, p2 in pairs(parents):
            c1, c2 = pmx_crossover(p1, p2)
            offspring += [c1, c2]

        # Mutation
        for ind in offspring:
            if random() < 0.1:
                swap_random(ind)
            if random() < 0.05:
                rotate_random_part(ind)

        # Elitism: giữ 5 nghiệm tốt nhất
        elite = top_k(population, fitness, k=5)
        population = elite + offspring[:pop_size - 5]

    best = max(population, key=lambda ind: -total_waste(...))
    return blf_place(best, sheet, rotations, nfp_cache)
```

---

## 16. Các case biên (degenerate cases)

Robust NFP generator phải xử lý được các case sau — đây là chỗ nhiều implementation trở nên buggy:

### 16.1 Collinear edges
Cạnh song song trùng phương → nhiều vector tịnh tiến ứng viên có cùng hướng. Cần tie-breaking theo edge order.

### 16.2 Vertex-on-edge exact touch
Đỉnh của B nằm chính xác trên giữa cạnh A. Xử lý bằng "case (b)" trong sliding algorithm.

### 16.3 Concentric contact
B chạm A tại 2 điểm cùng lúc → 2 touching group phải xử đồng thời.

### 16.4 Interlocking concavities
A và B có concavity kiểu răng cưa lồng vào nhau → nhiều feasible starting position, nhiều thành phần NFP.

### 16.5 Holes
A có lỗ → cần sinh cả outer NFP và inner NFP cho mỗi lỗ.

### 16.6 Jigsaw pieces
Mảnh có concavity sâu bao trọn mảnh khác → NFP có thành phần "nhồi vào bên trong", khó phát hiện.

### 16.7 Numerical precision
Toạ độ float → tính giao cắt cạnh có sai số ~1e-9. Cần **snap rounding** hoặc integer arithmetic (Clipper library) để tránh non-manifold NFP.

### 16.8 Self-intersecting input
Đầu vào PDF có contour tự cắt (do lỗi vẽ) → phải sanitize bằng winding rule + Boolean cleanup trước khi sinh NFP.

### 16.9 Non-simple polygons
Mảnh có nhiều contour rời (ví dụ: chữ "i" — thân + chấm) → xử lý như multi-polygon, sinh NFP hợp.

---

## 17. Xu hướng nghiên cứu 2020-2026

### 17.1 Deep Reinforcement Learning
- Policy network học chọn mảnh + vị trí + góc.
- Đã đạt kết quả cạnh tranh với GA trên benchmark ESICUP.
- Nhược: cần training data lớn, chưa robust với distribution shift.

### 17.2 Graph Neural Networks
- Biểu diễn tập mảnh làm graph, học embedding của contour.
- Kết hợp với GNN + attention để đề xuất pairing tốt.

### 17.3 Differentiable Packing
- Biểu diễn NFP/Phi-function bằng hàm khả vi → dùng gradient descent trực tiếp trên (x, y, θ) liên tục.
- Fang et al. 2024 — knowledge-guided algorithm với continuous optimization.

### 17.4 Cloud-based Massively Parallel
- Chạy hàng triệu GA generation trên cloud, mỗi individual trên 1 core.
- Sử dụng cho packaging plant lớn.

### 17.5 Hybrid CP + Meta-heuristic
- Constraint programming làm upper bound + tabu search làm improvement.

### 17.6 Approximate NFP
- Học neural approximation của NFP → thay thế sliding algorithm chậm.
- Trade-off: đôi chồng lấn nhẹ vs tốc độ.

---

## 18. Tài liệu tham khảo

### Sách & Survey

1. **Bennell, J. A., Oliveira, J. F.** (2008). *The geometry of nesting problems: A tutorial.* European Journal of Operational Research, 184(2), 397-415.
2. **Bennell, J. A., Oliveira, J. F.** (2009). *A tutorial in irregular shape packing problems.* Journal of the Operational Research Society, 60(1), S93-S105.
3. **Leao, A. A. S., Toledo, F. M. B., Oliveira, J. F., Carravilla, M. A., Alvarez-Valdés, R.** (2020). *Irregular packing problems: A review of mathematical models.* EJOR, 282(3), 803-822.
4. **Wäscher, G., Haußner, H., Schumann, H.** (2007). *An improved typology of cutting and packing problems.* EJOR, 183(3), 1109-1130.
5. **Guo, B., Hu, J., Wu, F., Peng, Q.** (2022). *Two-dimensional irregular packing problems: A review.* Frontiers in Mechanical Engineering, 8:966691.

   https://www.frontiersin.org/journals/mechanical-engineering/articles/10.3389/fmech.2022.966691/full

### No-Fit Polygon

6. **Art Jr., R. C.** (1966). *An approach to the two-dimensional irregular cutting stock problem.* IBM Cambridge Scientific Center Report 36-Y08.
7. **Mahadevan, A.** (1984). *Optimization in Computer-Aided Pattern Packing.* PhD Thesis, North Carolina State University.
8. **Ghosh, P. K.** (1993). *A unified computational framework for Minkowski operations.* Computers & Graphics, 17(4), 357-378.
9. **Bennell, J. A., Dowsland, K. A., Dowsland, W. B.** (2001). *The irregular cutting-stock problem — a new procedure for deriving the no-fit polygon.* Computers & OR, 28(3), 271-287.
10. **Burke, E. K., Hellier, R. S. R., Kendall, G., Whitwell, G.** (2007). *Complete and robust no-fit polygon generation for the irregular stock cutting problem.* EJOR, 179(1), 27-49.

    https://www.sciencedirect.com/science/article/abs/pii/S0377221706001639
11. **Luo, Q., Rao, Y.** (2022). *Improved Sliding Algorithm for Generating No-Fit Polygon in the 2D Irregular Packing Problem.* Mathematics, 10(16), 2941.

    https://www.mdpi.com/2227-7390/10/16/2941

### Placement — BLF

12. **Chazelle, B.** (1983). *The bottom-left bin-packing heuristic: An efficient implementation.* IEEE Trans. Comput., C-32(8), 697-707.
13. **Burke, E. K., Hellier, R. S. R., Kendall, G., Whitwell, G.** (2006). *A New Bottom-Left-Fill Heuristic Algorithm for the Two-Dimensional Irregular Packing Problem.* Operations Research, 54(3), 587-601.

    https://pubsonline.informs.org/doi/10.1287/opre.1060.0293
14. **Chehrazad, S., Roose, D., Wauters, T.** (2022). *A fast and scalable bottom-left-fill algorithm to solve nesting problems using a semi-discrete representation.* EJOR, 300(3), 809-826.

    https://www.sciencedirect.com/science/article/abs/pii/S0377221721008936

### Guillotine

15. **Wang, P. Y.** (1983). *Two algorithms for constrained two-dimensional cutting stock problems.* Operations Research, 31(3), 573-586.
16. **Beasley, J. E.** (1985). *Algorithms for unconstrained two-dimensional guillotine cutting.* Journal of the Operational Research Society, 36(4), 297-306.
17. **Christofides, N., Whitlock, C.** (1977). *An algorithm for two-dimensional cutting problems.* Operations Research, 25(1), 30-44.

### Meta-heuristic

18. **Hopper, E., Turton, B.** (2001). *An empirical investigation of meta-heuristic and heuristic algorithms for a 2D packing problem.* EJOR, 128(1), 34-57.
19. **Gomes, A. M., Oliveira, J. F.** (2006). *Solving irregular strip packing problems by hybridising simulated annealing and linear programming.* EJOR, 171(3), 811-829.
20. **Egeblad, J., Nielsen, B. K., Odgaard, A.** (2007). *Fast neighborhood search for two- and three-dimensional nesting problems.* EJOR, 183(3), 1249-1266.

### Phi-function

21. **Stoyan, Y., Terno, J., Scheithauer, G., Gil, N., Romanova, T.** (2001). *Phi-function for complex 2D objects.* 4OR-A Quarterly Journal of Operations Research.
22. **Chernov, N., Stoyan, Y., Romanova, T.** (2010). *Mathematical model and efficient algorithms for object packing problem.* Computational Geometry, 43(5), 535-553.

### Modern approaches

23. **Fang, J., Rao, Y., Luo, Q., Xu, J.** (2024). *A new approach for bin packing problem using knowledge reuse and constraint satisfaction.* PMC11685533.

    https://pmc.ncbi.nlm.nih.gov/articles/PMC11685533/
24. **Liu, C., Zhang, J., Xu, J.** (2023). *Optimizing Two-Dimensional Irregular Packing: A Hybrid Approach.* Applied Sciences, 13(22), 12474.

    https://www.mdpi.com/2076-3417/13/22/12474
25. **Hendriks, J.** (2025). *An Exploration of Exact Methods to Solve the Irregular Strip Packing Problem.* Master's Thesis, Tilburg University.

    http://arno.uvt.nl/show.cgi?fid=184689

### Tài liệu Esko chính thức

26. Esko Documentation. *i-cut Layout+ 14 User Guide — Nesting Options.*

    https://docs.esko.com/docs/en-us/icutlayoutplus/14/userguide/en-us/common/icp/concept/co_icp_nestingoptions.html
27. Esko-Graphics. *i-cut Suite Catalog.* DirectIndustry.

    https://pdf.directindustry.com/pdf/esko-graphics/i-cut-suite/19673-592527.html

### Mã nguồn mở tham khảo

28. **Deepnest.io** — https://github.com/Jack000/Deepnest — GA + BLF + NFP, C++ core, dùng Clipper library cho Boolean.
29. **SVGnest** — https://github.com/Jack000/SVGnest — bản gốc web JS.
30. **libnest2d** — https://github.com/tamasmeszaros/libnest2d — C++ library dùng trong PrusaSlicer.
31. **Clipper2** — https://github.com/AngusJohnson/Clipper2 — thư viện Boolean polygon chuẩn công nghiệp, cơ sở cho nhiều nesting engine.

---

## Phụ lục A — Tổng kết ngắn

| Thành phần | Vai trò | Kỹ thuật lõi |
|---|---|---|
| **NFP** | Test chồng lấn nhanh | Sliding / Minkowski / Decomposition |
| **IFP** | Ràng buộc chứa trong sheet | Minkowski erosion |
| **BLF** | Đặt từng mảnh (placement) | Vertex enumeration trên `IFP \ CNFP` |
| **GA/SA/Tabu** | Sắp thứ tự mảnh + góc xoay | Meta-heuristic |
| **Column generation** | Minimum Layouts | LP + pricing subproblem |
| **Guillotine tree** | Nhánh guillotine | Beasley DP / Wang bottom-up |
| **Minkowski dilation** | Gutter/kerf/bleed | Buffer polygon |
| **Least-cuts pass** | Gộp cạnh trùng | Đồ thị cạnh + Chinese Postman |

---

*Tài liệu được biên soạn ngày 2026-08-29. Nội dung học thuật tổng hợp từ các publications 2001-2025 và tài liệu công khai của Esko. Chi tiết triển khai nội bộ của i-cut là mã đóng — nội dung ở đây là kỹ thuật kinh điển mà một hệ nesting công nghiệp phải có.*
