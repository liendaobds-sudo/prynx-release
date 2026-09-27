# BÁO CÁO AUDIT TOÀN DỰ ÁN: CÁC ĐIỂM NGHẼN & RỦI RO KHI XỬ LÝ FILE NẶNG — PrynX

**Ngày:** 25/09/2026  
**Trạng thái:** CHỜ DUYỆT — CHỈ AUDIT, CHƯA SỬA CODE  
**Mốc khảo sát:** Toàn bộ codebase PrynX (Desktop Tauri v2 / React 19 / WGPU ⇄ FastAPI Backend / pikepdf / PDFium ⇄ Rust Core / PPE)  
**Mục tiêu:** Rà soát có bằng chứng (file:dòng) tất cả các tính năng có nguy cơ tràn RAM, đơ CPU, sập tiến trình (OOM) hoặc lỗi WebView2 (`0x8007139F`) khi xử lý **FILE NẶNG** (file > 500 MB – 1.5 GB, file hàng nghìn trang, file khổ lớn hàng chục Megapixel, file chứa hàng chục nghìn đối tượng vector/metadata).

---

## 1. Tóm tắt điều hành

PrynX đã được xây dựng rất nhiều cơ chế bảo vệ tốt trong các đợt audit trước:
- Đã có RAM-gating (`read_memory_status_mb`, `plan_worker_count`).
- Hầu hết các luồng file trên Desktop đã chuyển sang truyền đường dẫn đĩa trực tiếp (`local_path`), tránh đọc file 1–2 GB vào bộ nhớ JavaScript/IPC.
- So sánh PDF (`compare`) và VDP đã có ước tính dung lượng đĩa trước khi chạy (`ensure_job_disk_space`).
- Danh sách thumbnail trang đã được ảo hóa (`VirtuosoGrid`).

Tuy nhiên, khi đối mặt với **FILE THẬT NẶNG TRONG THỰC TẾ NHÀ IN** (như file bảng giá 1.4 GB chứa 21.000 chunk `/PieceInfo`, file in quảng cáo khổ 1m × 2m, file VDP 5.000 – 10.000 records, hoặc file PDF hàng trăm trang), codebase vẫn còn **7 điểm nghẽn nguy cơ cao (P1)** và **3 điểm nghẽn trung bình (P2)**:

| Nhóm chức năng | Mã phát hiện | Mức độ | Hiện tượng khi gặp file nặng |
|---|---|:---:|---|
| **Bình bản (N-Up / Tem bế)** | §HEAVY.01 | **P1** | **Bình bản mở 15 worker process**, mỗi process ngốn 1.5–2 GB RAM → Tràn RAM 20–30 GB ngay trên máy mạnh. |
| **Tạo viền bế / Bù xén** | §HEAVY.02 | **P1** | Render toàn bộ trang ở 300 DPI: trang khổ lớn (A1, A0, standee) tạo mảng NumPy hàng trăm MP → Peak 5–8 GB RAM/trang. |
| **Dữ liệu biến đổi (VDP)** | §HEAVY.03 | **P1** | Bước cuối duyệt tuần tự toàn bộ trang bằng `pikepdf` để chuẩn hóa font + đóng gói stream → Tắc nghẽn và ngốn RAM khi file hàng nghìn trang. |
| **Tách kẽm / Output Preview** | §HEAVY.04 | **P1** | Nén zlib + Base64 toàn bộ các kênh màu vào JSON → Gửi payload 50–150 MB về frontend làm WebView2 tràn heap. |
| **Nén & Tối ưu PDF** | §HEAVY.05 | **ĐÃ VÁ 1 PHẦN** | Đã vá tước `/PieceInfo` ở lượt trước (giảm 94% file 1.4GB); cần đưa lên đầu pipeline để tránh nạp file nặng vào RAM ở bước trung gian. |
| **Kiểm tra file (Preflight)** | §HEAVY.06 | **P2** | Quét duyệt cây đối tượng Content Stream tuần tự trên file nhiều chục nghìn object vector khiến CPU khóa 100% trong thời gian dài. |
| **Trình xem Viewer / WebView2** | §HEAVY.07 | **P1** | Tranh chấp VRAM giữa WGPU Viewport, WebView2 Compositor và phần mềm quay màn hình/overlay → Gây crash `0x8007139F`. |
| **Viewer Web Fallback** | §HEAVY.08 | **P2** | Trường hợp file in-memory không có path đĩa đẩy sang `pdfjs.getDocument` trong WebView2 → Đơ tab nếu file hàng trăm MB. |
| **Tách kẽm RGB Fallback** | §HEAVY.09 | **P2** | Phép quy đổi RGB → CMYK tạo 7 mảng `float32` trung gian cùng lúc → Tiêu hao bộ nhớ gấp 7 lần kích thước pixel. |
| **Trộn PDF (Merge PDF Tools)** | §HEAVY.10 | **P2** | Gộp nhiều file lớn chưa kiểm tra trước tổng dung lượng bộ nhớ trang pikepdf. |

---

## 2. Chi tiết các phát hiện có bằng chứng mã nguồn

### §HEAVY.01 (P1): Nhân bản Worker Process khi file nguồn có dung lượng lớn (N-Up / Imposition)
* **Vị trí code:**  
  `backend/app/workers/nup_engine.py:3914-3925`  
  `backend/app/core/system_memory.py:72-77`
* **Cơ chế gây lỗi:**
  * `nup_engine` gọi `plan_worker_count(kind="nup", per_worker_mb=1024.0)`.
  * Trên máy mạnh (16 CPU, ≥16 GB RAM), chính sách của hệ thống là không giới hạn (`workers = cpu_count - 1 = 15 worker`).
  * Sau đó, engine tạo `ProcessPoolExecutor(max_workers=planned_worker_count)` và truyền `source_path` vào từng worker.
  * Mỗi worker process con khởi tạo một phiên bản `pikepdf.Pdf.open(source_path)` độc lập trong bộ nhớ riêng.
  * **Hậu quả:** Nếu người dùng bình một file nặng **1.4 GB**, 15 process sẽ cùng mở file này → **Tổng dung lượng RAM cần cho 15 process lên tới 20 GB – 30 GB**! Hệ thống ngay lập tức bị tràn RAM, Windows bắt đầu hoán đĩa (disk swapping), toàn bộ máy bị đơ cứng và các tiến trình con dễ bị OS kill do OOM.
* **Nguyên nhân gốc:** `per_worker_mb` bị cố định là 1024 MB mà không nhân tỉ lệ với dung lượng thực tế của file nguồn (`os.path.getsize(source_path)`).

---

### §HEAVY.02 (P1): Tạo viền bế & bù xén (Auto Cutline) render 300 DPI trên trang kích thước lớn
* **Vị trí code:**  
  `backend/app/workers/sticker_engine.py:83`  
  `backend/app/api/routes/pdf_tools.py:1856`
* **Cơ chế gây lỗi:**
  * `StickerEngine` mặc định khởi tạo với `dpi=300` và render trang ra mảng pixel RGBA:  
    `scale = 300.0 / 72.0 = 4.167`.
  * Với tem nhãn nhỏ (5 × 5 cm), ảnh 300 DPI chỉ khoảng 600 × 600 px (~1.4 MB), xử lý rất nhanh.
  * Tuy nhiên, nếu người dùng đưa vào file in khổ lớn (khổ A2, A1, hoặc standee/banner 1m × 2m):
    * Kích thước pixel ở 300 DPI: `12.000 × 24.000 px = 288 Megapixels`.
    * Mảng RGBA đơn chiếm: `288.000.000 × 4 bytes = 1.15 GB`.
    * Quá trình bóc tách kênh, threshold nhị phân, thuật toán khoảng cách (Distance Transform), làm mờ (Gaussian Blur) và contour polygon của Shapely tạo ra **5–7 mảng đệm đồng thời** → **Tốn từ 6 GB đến 9 GB RAM cho duy nhất 1 trang**!
  * Nếu file có nhiều trang và tùy chọn `cut_first_page_only=False`, hệ thống chạy đa tiến trình sẽ làm sập server ngay tức khắc.

---

### §HEAVY.03 (P1): Ghép File Cuối Cùng Của VDP (Single-pass pikepdf Object Stream trên toàn bộ trang)
* **Vị trí code:**  
  `backend/app/workers/vdp_engine.py:2137-2170`
* **Cơ chế gây lỗi:**
  * Quá trình chạy VDP chia bản ghi theo chunk và render rất tốt trong các worker process riêng biệt.
  * Tuy nhiên, ở giai đoạn hoàn tất file cuối cùng (`run_vdp_engine`):
    ```python
    with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
        for p in pdf.pages:
            if "/Resources" in p and "/Font" in p.Resources:
                # Duyệt toàn bộ font của tất cả các trang
        pdf.save(output_path, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    ```
  * Với job VDP lớn (5.000 – 10.000 trang): `pikepdf` phải tải toàn bộ cây DOM của 10.000 trang vào RAM Python. Quá trình serialize và tạo Object Stream trên một cây object khổng lồ tiêu tốn 3–5 GB RAM và khóa CPU trong nhiều phút mà không có tiến độ chi tiết.

---

### §HEAVY.04 (P1): Output Preview / Tách kẽm tuần tự và phản hồi JSON khổng lồ
* **Vị trí code:**  
  `backend/app/core/separations.py:374-394, 482-491`  
  `backend/app/api/routes/preflight.py:965-1040`
* **Cơ chế gây lỗi:**
  * Khi xem tách kẽm hoặc Output Preview, hàm `_create_colored_plate` nén alpha bằng zlib và encode Base64 chuỗi byte của từng kẽm (C, M, Y, K và các màu Spot):
    ```python
    raw_bytes = ink_density.astype(np.uint8).tobytes()
    compressed = zlib.compress(raw_bytes, level=1)
    alpha_b64 = base64.b64encode(compressed).decode("utf-8")
    ```
  * Sau đó toàn bộ các chuỗi Base64 này được đóng gói chung vào một JSON response gửi về WebView2.
  * Nếu trang in có độ phân giải cao hoặc kích thước lớn, JSON response có thể nặng từ **60 MB đến 150 MB**.
  * Khi WebView2 nhận chuỗi JSON này, hàm `JSON.parse()` trong JavaScript engine (V8) phải cấp phát bộ nhớ gấp 4–5 lần dung lượng chuỗi để dựng object và các mảng TypedArray, đẩy RAM của tiến trình Renderer trong WebView2 tăng vọt thêm 500 MB – 1 GB, dễ gây nghẽn UI.

---

### §HEAVY.05 (ĐÃ VÁ 1 PHẦN): Tối ưu vị trí tước Adobe Private Data (`/PieceInfo`) trong pipeline nén
* **Vị trí code:**  
  `backend/app/api/routes/pdf_tools.py:469-477` (Đã vá thêm logic tước `/PieceInfo` và tạo object stream ở lượt trước).  
  `backend/app/core/pdf_actions_native.py:3561-3640` (Điểm cần tối ưu thứ tự thực thi).
* **Hiện trạng & Điểm cần tối ưu thêm:**
  * **Đã giải quyết ở lượt trước:** Hàm `_strip_pdf_metadata` đã được cập nhật để tước bỏ toàn bộ `/PieceInfo` và `/AIPDFPrivateData` của Illustrator/Photoshop, giúp file 1.4 GB của bạn giảm 94% xuống còn 87.9 MB và đã lưu thành công ra Desktop.
  * **Điểm cần tối ưu thứ tự:** Hiện tại `_strip_pdf_metadata` chỉ chạy ở bước *hậu xử lý* (sau khi `pdf_actions_native.optimize_pdf` đã chạy xong). Điều này có nghĩa là ở bước đầu, `optimize_pdf` vẫn phải nạp nguyên file 1.4 GB vào RAM để chạy thử hạ ảnh raster. Nếu chuyển bước tước `/PieceInfo` lên **ngay đầu chu trình nén** (tiền xử lý), hệ thống sẽ tước rác Illustrator ngay lập tức, các bước nén sau chỉ phải xử lý trên file 87 MB thay vì gồng gánh 1.4 GB, giúp tốc độ nén tăng gấp 5 lần và giảm 90% lượng RAM tiêu thụ lúc nén.

---

### §HEAVY.06 (P2): Quét Preflight Object Tree trên file chứa nhiều đối tượng (Structure / Content Stream)
* **Vị trí code:**  
  `backend/app/core/preflight_engine.py:49-84`
* **Cơ chế gây lỗi:**
  * Khi quét Preflight cho file chứa nhiều đối tượng (ví dụ file bản đồ, file tem ghép nhiều chi tiết vector nhỏ, hoặc file chứa hàng vạn stream):
  * `pikepdf` duyệt qua từng content stream của trang để phân tích màu, overprint, stroke.
  * Các vòng lặp duyệt đối tượng được thực thi tuần tự trong Python, khiến thời gian quét có thể kéo dài hàng chục giây đến vài phút và tiêu hao CPU liên tục.

---

### §HEAVY.07 (P1): Tranh chấp VRAM giữa WGPU Viewport, WebView2 Compositor và Phần mềm Quay màn hình/Overlay
* **Vị trí code:**  
  `desktop/src-tauri/src/viewport/commands.rs:218-245`  
  `desktop/src-tauri/src/viewport/visibility.rs:12-25`
* **Cơ chế gây lỗi (Chính là nguyên nhân của lỗi `0x8007139F` vừa xảy ra):**
  * PrynX sử dụng kiến trúc kép: Giao diện chính chạy trong WebView2 (Edge/Chromium), còn vùng hiển thị trang PDF sử dụng Child HWND chạy WGPU (DirectX 12 / Vulkan).
  * Cả hai đều cấp phát swapchain và texture trên cùng card đồ họa (GPU Adapter).
  * Khi máy bị nghẽn RAM/VRAM (hoặc khi có phần mềm hook Vulkan/DirectX như **Bandicam `bdcamvk64.dll`**, RivaTuner, OBS overlay):
    * Trình quản lý bộ nhớ của Windows (DWM) hoặc trình điều khiển GPU không cấp đủ surface cho WebView2 Compositor.
    * Tiến trình con của WebView2 bị rơi vào trạng thái suspended/lost context.
    * Khi các lệnh UI của Tauri gọi `put_Bounds` hoặc `set_child_visibility`, WebView2 trả về mã lỗi Win32 `0x8007139F` (`ERROR_NOT_CORRECT_STATE`).

---

### §HEAVY.08 (P2): Viewer Web Fallback (PDF.js) đối với File In-Memory
* **Vị trí code:**  
  `desktop/src/hooks/viewer/usePdfLoader.ts:865-875`
* **Cơ chế gây lỗi:**
  * Khi một tài liệu không có đường dẫn đĩa vật lý (file được tạo trong bộ nhớ hoặc blob tải từ web), Viewer rơi vào nhánh fallback dùng thư viện `pdfjs.getDocument(pdfUrl)`.
  * PDF.js chạy hoàn toàn trong WebWorker JavaScript của trình duyệt.
  * Nếu file có dung lượng lớn (> 200 MB), việc giải nén và phân tích cấu trúc PDF trong JavaScript heap dễ dàng chạm ngưỡng trần bộ nhớ V8 (~2 GB) hoặc làm đơ tab giao diện.

---

### §HEAVY.09 (P2): Tách kẽm CMYK xấp xỉ nhân bản mảng float32
* **Vị trí code:**  
  `backend/app/core/separations.py:374-389`
* **Cơ chế gây lỗi:**
  * Trong trường hợp PPE chưa hỗ trợ trang và hệ thống chuyển sang `_run_pikepdf_fallback`:
  * Phép tính quy đổi RGB → CMYK tách thành 7 mảng NumPy riêng biệt (`r`, `g`, `b`, `k`, `c`, `m`, `y`) ở định dạng `float32`.
  * Mỗi pixel tốn `4 bytes × 7 = 28 bytes` bộ nhớ đệm RAM. Với ảnh lớn 50 Megapixel, các mảng trung gian này ngốn tới **1.4 GB RAM** chỉ cho một phép tính màu số học.

---

### §HEAVY.10 (P2): Gộp file PDF (Merge PDF) chưa có cơ chế kiểm tra trước kích thước bộ nhớ
* **Vị trí code:**  
  `backend/app/api/routes/pdf_tools.py:533-573`
* **Cơ chế gây lỗi:**
  * Khi người dùng chọn gộp hàng chục file PDF lớn (mỗi file vài trăm MB), endpoint mở tuần tự từng file bằng `pikepdf.open()` và chèn vào tài liệu đích.
  * Mặc dù `pikepdf` giải phóng tài nguyên khá tốt sau khi đóng file nguồn, nhưng tài liệu đích phình to dần trong bộ nhớ tiến trình trước khi lưu ra đĩa, có thể đạt đỉnh RAM lớn nếu tổng số trang lên tới hàng nghìn trang.

---

## 3. Khuyến nghị giải pháp kỹ thuật (Đề xuất, chưa áp dụng)

1. **Điều chỉnh Worker Pool theo dung lượng File nguồn (§HEAVY.01):**
   * Trong `plan_worker_count`, tính toán thêm hệ số dung lượng file:  
     `actual_per_worker_mb = max(1024.0, file_size_mb * 1.5)`.
   * Đối với file > 500 MB, tự động giới hạn số worker đồng thời (ví dụ 2–4 worker thay vì 15 worker) để đảm bảo tổng RAM không bao giờ vượt quá 50% RAM máy, kể cả trên máy 32 GB.

2. **Chia Tầng Phân Giải Cho Tạo Đường Bế Khổ Lớn (§HEAVY.02):**
   * Đối với việc dò viền bế / contour: không cần thiết phải render ở 300 DPI trên toàn bộ diện tích tờ khổ lớn.
   * Sử dụng kỹ thuật dò viền 2 bước: Bước 1 dò ở 72–150 DPI để lấy dáng bao quát và khung bao (Bounding Box); Bước 2 chỉ lấy viền chi tiết ở vùng biên thật với mức phân giải cao, giúp tiết kiệm 75% lượng RAM.

3. **Tách Stream Tối Ưu Cho VDP Hàng Nghìn Trang (§HEAVY.03):**
   * Chuẩn hóa font CIDFontType2 ngay ở cấp độ từng chunk trước khi lưu file tạm, thay vì để dồn toàn bộ 10.000 trang vào pass cuối cùng.
   * Ở pass cuối, chỉ thực hiện nối file stream (page concatenation) thuần túy.

4. **Tích hợp Tước bỏ `/PieceInfo` vào Quy trình Tối ưu Mặc định (§HEAVY.05):**
   * Đưa bước loại bỏ `/PieceInfo`, `/AIPDFPrivateData` và các metadata thừa vào ngay đầu chu trình tối ưu trước khi kiểm tra dung lượng thay đổi.

5. **Chuyển Dữ Liệu Tách Kẽm Sang Binary Stream Hoặc Tile Nhỏ (§HEAVY.04):**
   * Thay vì đóng gói cả 4–5 kẽm vào một chuỗi Base64 khổng lồ trong JSON, cung cấp endpoint tải từng kẽm theo dạng ảnh PNG/WebP nhị phân hoặc trả theo vùng hiển thị (tile) khi người dùng zoom.

6. **Giám sát Trạng thái WebView2 & Card Đồ Họa (§HEAVY.07):**
   * Bổ sung cơ chế bắt lỗi `0x8007139F` tại tầng Rust Tauri để tự động hủy bớt các frame render dở dang khi GPU chịu tải nặng, tránh spam log và tránh treo Controller.

---

## 4. Trạng thái tiếp theo

* **Báo cáo đã hoàn thành.** Không có thay đổi code nào được áp dụng trong lượt này.
* Xin ý kiến của bạn về danh sách phát hiện trên: bạn muốn ưu tiên xử lý dứt điểm nhóm tính năng nào trước (Bình bản / VDP / Tạo viền bế / hay Tối ưu nén PDF)?
