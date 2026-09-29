# BÁO CÁO AUDIT HIỆU NĂNG TÍNH NĂNG CHUYỂN HỆ MÀU (RGB → CMYK) — 2026-09-29

> **Đơn vị rà soát**: Luồng Chuyển hệ màu (`ConvertColorsTool` ⇄ `preflight.py` ⇄ `color_conversion_preview.py` ⇄ `pdf_actions_native.py`)
> **Người yêu cầu**: Người dùng phản ánh *"tốc độ xử lý quá lâu, không tức thì như Illustrator hay Photoshop"*.
> **Môi trường đo lường**: Windows 11, Python 3.11, CPU AMD/Intel đa nhân, RAM ≥ 16GB.

---

## 1. Tóm tắt kết quả đo lường thực nghiệm (Evidence-based Benchmarks)

Thử nghiệm trên một trang PDF điển hình chứa 1 ảnh màu kích thước 2000×2000 (~A4 200 DPI):

| Thao tác | Hiện trạng PrynX | Photoshop / Illustrator | Độ chênh lệch |
|---|---|---|---|
| **Thời gian mở Preview lần đầu** (`balanced-v1`) | **5.225 giây** (thậm chí 18s+ trên file nặng) | **~10 – 30 ms** | PrynX chậm hơn **170× – 500×** |
| **Kéo thanh trượt Preview** (`manual`) | **4.498 giây / 1 nấc kéo** | **< 16 ms (60 FPS mượt mà)** | PrynX chậm hơn **280×** |
| **Convert ảnh raster** (`adaptive_vivid`) | **2.952 giây / 1 ảnh** | **~0.05 – 0.1 giây** | PrynX chậm hơn **30× – 50×** |
| **Convert ảnh raster** (`standard icc`) | **0.171 giây / 1 ảnh** | **~0.05 – 0.1 giây** | Gần tương đương |
| **Phép tính $\Delta E_{00}$ CIEDE2000** (Python/NumPy) | **1.257 giây** trên mảng 2M pixel | Không tính trong realtime | Gây nghẽn CPU |

---

## 2. Đối chiếu cơ chế kiến trúc: Vì sao Photoshop / Illustrator "Tức thì" còn PrynX lại "Quá lâu"?

### 2.1 Trong Adobe Photoshop / Illustrator:
1. **Preview hoàn toàn trên bộ nhớ hiển thị (In-Memory Display Pipeline)**:
   - Khi bật *Proof Colors* (Ctrl+Y) hoặc chỉnh thanh trượt (Hue/Saturation, Curves, Assign Profile), Adobe **tuyệt đối không ghi đĩa, không can thiệp vào file gốc**.
   - GPU / CPU chỉ áp bảng tra màu **ICC 3D LUT** trực tiếp lên các pixel đang hiển thị trên màn hình (viewport framebuffer). Quá trình này chỉ mất vài mili-giây, đạt chuẩn 60 khung hình/giây.
2. **Không chạy kiểm định đo màu khi kéo thanh trượt**:
   - Khi đang chỉnh sửa mắt nhìn, Adobe không bắt CPU phải tính toán độ sai lệch màu $\Delta E_{00}$ từng pixel hay bóc tách 4 kẽm in để đo diện tích phủ mực (TAC).
3. **Thực thi chuyển đổi bằng C++ Native đa luồng (Multi-threading + SIMD)**:
   - Khi thực hiện `Convert to Profile` hoặc đổi Color Mode, lõi C++ của Adobe dùng tập lệnh vector AVX2/SSE và phân bổ các block ảnh cho toàn bộ các nhân CPU xử lý song song.

### 2.2 Trong PrynX hiện tại:
1. **Preview "Dùng búa tạ đập hạt dẻ" (Full File Recreation Overhead)**:
   - Mỗi lần mở tool hoặc kéo thanh trượt (sau 280ms debounce), thay vì chỉ áp ICC lên ảnh đang xem, PrynX lại gọi hàm `pdf_actions_native.convert_to_cmyk` để **biên dịch và ghi một file PDF tạm mới hoàn toàn ra ổ cứng**.
   - Sau đó gọi tiếp `SoftProofEngine.render_softproof` để PDFium/PPE mở file PDF tạm đó lên RIP thành ảnh PNG và encode Base64.
2. **Quá tải vì đo lường khoa học màu không cần thiết cho Preview**:
   - Sau khi có ảnh xem trước, PrynX bắt CPU chạy hàm `delta_e_ciede2000` (tính toán lượng giác $arctan, \cos, \sin$ ma trận float64 trên hàng triệu pixel bằng NumPy, ngốn **1.26 giây**).
   - Tiếp tục gọi `SeparationEngine.extract_separations` để RIP riêng 4 kẽm màu C-M-Y-K (ngốn **188 ms**).
   - Tiếp tục đo tổng lượng phủ mực TAC (`measure_tac`).
3. **Chính sách `balanced-v1` nhân 4 lần khối lượng**:
   - Khi mở công cụ, chế độ mặc định `balanced-v1` tự động chạy chu trình trên đến **4 lần liên tiếp** (mức 0, mức +1, mức +2, mức vibrance 4) để tìm ra thông số tối ưu. Kết quả là giao diện bị đơ từ **15 đến 20 giây** trước khi hiện được bản xem trước đầu tiên.
4. **Thuật toán `adaptive_vivid` làm chậm 17.2 lần so với chuẩn ICC**:
   - Giao diện đặt mặc định `gamut_mapping = 'adaptive_vivid'`.
   - Với mỗi ảnh, thuật toán này ép qua **5 lần chuyển đổi LittleCMS** liên tiếp (`RGB → CMYK → Lab → CMYK → Lab`) cùng các phép toán ma trận nặng, khiến thời gian xử lý 1 ảnh từ **0.17s vọt lên 2.95s** (chậm gấp 1720%).
5. **Thực thi chuyển đổi file (`convert_colors`) chạy hoàn toàn đơn luồng**:
   - Toàn bộ việc quét `pdf.objects`, giải nén ảnh, chạy LittleCMS và nén lại Flate/zlib đều diễn ra tuần tự trên 1 CPU core duy nhất trong Python.
   - Thư viện Python `zlib.compress(raw)` mặc định ở `level=6`. Với các file in ấn chứa nhiều ảnh 300 DPI (mỗi ảnh giải nén ra 30–50MB CMYK thô), nén zlib đơn luồng ngốn 1.5–3 giây cho mỗi ảnh. Nếu file có 10 trang/10 ảnh, người dùng phải chờ 30–60 giây.

---

## 3. Danh mục các điểm nghẽn hiệu năng (Findings)

| Mã | Mức độ | Vị trí | Hiện tượng & Nguyên nhân |
|---|---|---|---|
| **PERF-COLOR-01** | **CRITICAL** | `backend/app/core/color_conversion_preview.py:507` | Preview 1 trang nhưng lại sinh và ghi cả file PDF mới ra đĩa qua `convert_to_cmyk`. Lãng phí I/O đĩa và CPU. |
| **PERF-COLOR-02** | **CRITICAL** | `desktop/src/components/preprocess-tools/ConvertColorsTool.tsx:380` | Mặc định chọn `adaptive_vivid` thay vì `icc`, làm tốc độ chuyển đổi màu chậm hơn **17.2 lần** (2.95s so với 0.17s). |
| **PERF-COLOR-03** | **HIGH** | `backend/app/core/color_conversion_preview.py:778-830` | Chính sách `balanced-v1` chạy lặp 4 lần pipeline nặng khiến thời gian mở tool lần đầu kéo dài 15–20s. |
| **PERF-COLOR-04** | **HIGH** | `backend/app/core/color_conversion_preview.py:292` | Hàm `measure_appearance` tính CIEDE2000 float64 trên toàn bộ pixel ảnh (tốn 1.26s). Không cần thiết khi kéo thanh trượt thông thường. |
| **PERF-COLOR-05** | **HIGH** | `backend/app/core/color_conversion_preview.py:598` | Tự động bóc tách 4 kẽm màu RIP (`extract_separations`) và đo TAC trong mỗi lần preview, gây trễ thêm 200–500ms. |
| **PERF-COLOR-06** | **HIGH** | `backend/app/core/pdf_actions_native.py:3541` | Nén `zlib.compress(raw)` đơn luồng ở level 6 mặc định, cực kỳ chậm trên các ảnh in ấn dung lượng lớn. |
| **PERF-COLOR-07** | **MEDIUM** | `backend/app/core/pdf_actions_native.py:4721` | Vòng lặp chuyển đổi ảnh trong PDF chạy tuần tự (single-threaded), không tận dụng kiến trúc CPU đa nhân của máy mạnh. |
| **PERF-COLOR-08** | **MEDIUM** | `desktop/src/components/preprocess-tools/ConvertColorsTool.tsx:820-858` | Chu trình thực thi phải upload toàn bộ PDF lên server, đợi convert ra đĩa, rồi download lại toàn bộ blob qua HTTP. |

---

## 4. Đề xuất giải pháp kiến trúc tối ưu (PrynX Fast-Track Architecture)

Để đạt được trải nghiệm phản hồi nhanh như Photoshop / Illustrator nhưng vẫn đảm bảo tính chuẩn xác và fail-closed của ngành in:

### Giai đoạn 1: Tối ưu hoá tức thì luồng Preview (Instant Visual Preview)
1. **Tách biệt hiển thị xem trước (Visual Proof) khỏi đo lường sâu (Deep Metrics)**:
   - **Xem trước hình ảnh (Instant)**: Render trang hiện tại thành ảnh RGB (85ms) -> Dùng LittleCMS áp ICC Transform + Brightness/Contrast trực tiếp lên bitmap trong bộ nhớ RAM (**chỉ mất ~20ms**). Trả về ảnh xem trước cho người dùng **trong vòng < 150ms** (tức thì!).
   - **Đo lường sâu ($\Delta E_{00}$, TAC, Kẽm màu)**: Chạy bất đồng bộ ở chế độ nền (background task) hoặc chỉ kích hoạt khi người dùng bấm mở tab "Phân tích kỹ thuật" (`technicalOpen`).
2. **Đổi Gamut Mapping mặc định sang chuẩn `icc` (Relative Colorimetric + BPC)**:
   - Chuẩn quốc tế của ngành in offset/digital là ICC Relative + BPC (nhanh, chuẩn xác, phổ biến nhất trong Adobe InDesign/Acrobat).
   - Tăng tốc độ tức thì **17.2 lần** cho mọi thao tác. Giữ `adaptive_vivid` như một tùy chọn nâng cao khi người dùng chủ động bật.
3. **Tối ưu hóa chính sách Gợi ý (`balanced-v1`)**:
   - Không chạy lặp 4 lần PDF conversion đầy đủ. Đánh giá nhanh trên biểu đồ histogram hoặc mẫu đại diện (downsampled thumbnail), chỉ khi người dùng bấm "Áp dụng gợi ý" mới áp dụng thông số.

### Giai đoạn 2: Tối ưu hoá luồng Thực thi chuyển đổi file (`convert_colors`)
1. **Xử lý ảnh song song đa nhân (Parallel Image Processing)**:
   - Với máy $\ge 16\text{GB}$ RAM (theo quy tắc vàng `prynx-performance`), sử dụng `concurrent.futures.ThreadPoolExecutor` để giải nén, biến đổi ICC LittleCMS và nén Flate cho nhiều ảnh cùng lúc trên tất cả các nhân CPU.
2. **Tối ưu hóa mức nén zlib (`level=1` hoặc native Rust)**:
   - Đổi `zlib.compress(raw, level=1)` (hoặc đưa vào Rust print_engine). Mức nén level 1 cho tốc độ nhanh gấp **4–5 lần** so với level 6 trong khi kích thước file PDF chênh lệch không đáng kể (< 3%).

---

## 5. Kế hoạch triển khai theo lô (Batch Execution Plan)

* **Lô 1 (Frontend + Quick Win Defaults)**:
  - Đổi mặc định `gamutMapping` sang `'icc'` (Relative + BPC chuẩn ngành in).
  - Tách preview hiển thị tức thì (Fast Viewport Proof) ra khỏi luồng đo $\Delta E_{00}$/TAC nặng.
* **Lô 2 (Backend Fast Preview Pipeline)**:
  - Viết hàm tạo preview nhanh trực tiếp từ raster RGB trang mà không ghi file PDF trung gian ra đĩa.
  - Chuyển việc đo TAC và $\Delta E_{00}$ thành tác vụ tùy chọn / tính toán nền.
* **Lô 3 (Backend Execution Engine Acceleration)**:
  - Tối ưu `zlib` nén nhanh level 1 và hỗ trợ xử lý song song các ảnh trong PDF qua pool worker (tuân thủ RAM-gating của máy).
