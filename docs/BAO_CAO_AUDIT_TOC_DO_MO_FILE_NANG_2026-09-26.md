# BÁO CÁO AUDIT & NGHIÊN CỨU KỸ THUẬT: GIẢI PHÁP MỞ FILE NẶNG TỨC THÌ (NEAR-INSTANT OPEN)

**Ngày:** 26/09/2026  
**Trạng thái:** ĐÃ KHẢO SÁT & ĐỐI CHIẾU THỰC NGHIỆM — CHỜ DUYỆT ĐỂ TRIỂN KHAI  
**Phạm vi:** Luồng mở tài liệu PDF (Bootstrap & Viewport Loader), Rust Backend Tauri (`desktop/src-tauri/src/lib.rs`), Frontend React Viewer (`desktop/src/components/viewer/`), Engine PDFium.  
**Tài liệu đối chiếu:**
- `docs/BAO_CAO_AUDIT_PPE_HIEU_NANG_FILE_NANG_2026-09-25.md`
- `docs/BAO_CAO_AUDIT_XU_LY_FILE_NANG_2026-09-25.md`
- `AGENTS.md`, `prynx-performance`, `prynx-architecture`

---

## 1. Tóm tắt điều hành & Mục tiêu nghiên cứu

### 1.1. Hiện trạng & Vấn đề thực tế
Khi mở các tệp PDF in ấn dung lượng lớn (catalogue, bảng giá sỉ lẻ nhiều vector, sách nhiều trang), người dùng nhận thấy:
- **Adobe Acrobat:** Mở file gần như **tức thì (< 100 ms)**, đạt độ nét ngay lập tức.
- **PrynX:** Mất **vài giây (từ 2 đến 5 giây)** màn hình trắng hoặc xoay tải trước khi trang đầu tiên hiển thị.

**Tệp mẫu thử nghiệm thực tế:**  
`C:\Users\Khanh Pham\Desktop\[CYMK] BẢNG GIÁ SỈ LẺ ATB ver190926 FILE IN_no_pieceinfo.pdf`  
(Kích thước: 88 MB, 45 trang, chứa hàng chục nghìn đối tượng vector đồ họa và bảng biểu phức tạp).

### 1.2. Kết luận nghiên cứu
1. **Lõi PDFium trong PrynX không hề chậm:** Thử nghiệm độc lập cho thấy lõi PDFium chỉ mất **`6.9 ms`** để mở tệp và **`444 ms`** để vẽ toàn bộ vector phức tạp của Trang 1.
2. **Nút thắt nằm ở kiến trúc nạp tuần tự (Eager Pipeline):** PrynX đang bắt toàn bộ tệp 88 MB phải đi qua bộ phân tích cây cú pháp `lopdf` (duyệt toàn bộ 45 trang và hàng chục nghìn đối tượng) **trước khi** cho phép PDFium vẽ Trang 1.
3. **Khả năng đạt tốc độ tức thì:** Hoàn toàn khả thi để đưa thời gian hiển thị Trang 1 của PrynX xuống **`< 300 ms`** (cảm nhận tức thì) bằng cách áp dụng mô hình **Fast-Path Bootstrap + Memory Mapping + Progressive Rendering** tương tự Adobe Acrobat.

---

## 2. Số liệu đo đạc thực nghiệm (Benchmark Baseline)

Đo đạc trực tiếp trên máy trạm thực tế (16 Cores, 32 GB RAM, SSD NVMe) với tệp mẫu 88 MB:

| Thao tác thực nghiệm | Thời gian đo được | Nhận xét |
|---|---|---|
| **Đọc dữ liệu từ ổ cứng (Disk I/O 88 MB)** | **`36.3 ms`** | Ổ cứng NVMe đọc rất nhanh, I/O đĩa không phải nguyên nhân chính. |
| **PDFium: Mở tài liệu (`load_pdf_from_byte_vec`)** | **`6.9 ms`** | Mở tệp, đọc Trailer/XRef cực nhanh (< 1/100 giây). |
| **PDFium: Lấy cấu trúc trang 1 (`get_page(0)`)** | **`76.7 ms`** | Giải mã Dictionary và Resource của Trang 1. |
| **PDFium: Vẽ toàn bộ vector Trang 1 (`render 1.0x`)** | **`444.1 ms`** | Vẽ đầy đủ độ nét chuẩn không nén. |
| **Tổng thời gian PDFium cần để vẽ xong Trang 1** | **`~527 ms`** | **Chỉ khoảng 0.5 giây!** |
| **Thời gian người dùng phải chờ thực tế trên PrynX** | **`2,500 – 4,000 ms`** | **Bị trễ thêm 2 – 3.5 giây do các khâu trung gian.** |

---

## 3. Tại sao Adobe Acrobat mở file "ngay tức thì" (< 100 ms)?

Adobe Acrobat là chuẩn mực công nghiệp về tốc độ mở PDF nhờ 4 trụ cột kỹ thuật:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        KIẾN TRÚC ADOBE ACROBAT                         │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Memory-Mapped Files (mmap): Ánh xạ đĩa ảo -> Mở file trong 0 ms     │
│ 2. Lazy On-Demand Parsing: Nhảy thẳng đến EOF -> Chỉ đọc Trang 1       │
│ 3. Progressive Rendering: Vẽ nháp Low-DPI (20 ms) -> Swap bản nét      │
│ 4. Zero-IPC DirectComposition: Xuất thẳng phần cứng GPU Swapchain       │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Bộ nhớ ánh xạ đĩa (`Memory-Mapped Files` - Win32 `MapViewOfFile`):**
   - Acrobat **không cấp phát RAM để đọc 88 MB hay 1.5 GB vào bộ nhớ**.
   - Nó yêu cầu Windows Kernel ánh xạ trực tiếp tệp từ ổ cứng vào không gian địa chỉ ảo (Virtual Address Space). Thời gian mở tệp coi như bằng **0 ms**. Hệ điều hành chỉ nạp các trang nhớ 4 KB vào RAM khi CPU thực sự chạm đến byte đó.
2. **Đọc lười theo nhu cầu (`Lazy On-Demand Parsing`):**
   - Cấu trúc PDF (ISO 32000) được thiết kế có chủ đích cho việc truy xuất ngẫu nhiên. Bảng chỉ mục (`xref`) và thẻ kết thúc (`trailer`) luôn nằm ở cuối tệp.
   - Khi mở tệp, Acrobat nhảy ngay xuống cuối tệp đọc bảng `xref`, lần theo cây đối tượng `/Root` $\rightarrow$ `/Pages` $\rightarrow$ `Trang 1`.
   - Nó **chỉ nạp và phân tích duy nhất Trang 1** (chỉ tốn ~1–2 MB dữ liệu). Toàn bộ 44 trang còn lại và hàng vạn đối tượng khác bị bỏ qua hoàn toàn.
3. **Hiển thị đa mức phân giải (`Progressive Coarse-to-Fine Rasterization`):**
   - Trong vòng **15–30 ms**, Acrobat vẽ ngay một bản phác thảo độ phân giải thấp (Low-DPI / Thumbnail) để lấp đầy khung nhìn, người dùng lập tức nhìn thấy bố cục trang mà không thấy màn hình trắng.
   - Luồng nền lập tức render tile nét cao (150–300 DPI) và thay thế mượt mà (swap) ngay sau đó.
4. **Vẽ trực tiếp lên GPU (`Zero-IPC DirectComposition`):**
   - Là ứng dụng C++ Win32 nguyên bản, Acrobat đẩy thẳng kết quả render vào DirectComposition / DirectX Swapchain của hệ điều hành, không bị hao phí qua các tầng IPC hay JSON/Base64.

---

## 4. Chẩn đoán các nút thắt trong PrynX (Root Cause Analysis)

Qua truy vết mã nguồn tại `desktop/src-tauri/src/lib.rs` và `desktop/src/components/viewer/`:

```mermaid
flowchart TD
    A["Frontend: usePdfLoader.ts gọi get_pdf_viewer_bootstrap"] --> B["BƯỚC 1: read_pdf_bytes_for_identity (Đọc toàn bộ 88 MB vào Vec<u8>)"]
    B --> C["NÚT THẮT 1 (1.5 - 3s): lopdf::Document::load_mem_with_options (Parse toàn bộ AST BTreeMap 45 trang)"]
    C --> D["NÚT THẮT 2: (*cached_bytes).clone() (Nhân bản thêm 88 MB RAM)"]
    D --> E["PDFium nạp tài liệu và lấy Page Count"]
    E --> F["get_pdf_viewer_bootstrap hoàn thành -> Trả kết quả về Frontend"]
    F --> G["React cập nhật State -> Mount LivePageFrame & LiveTile"]
    G --> H["LiveTile gọi IPC render_pdf_page"]
    H --> I["NÚT THẮT 3: PDFium render bitmap -> Bơm ~34 MB qua Tauri IPC -> Canvas"]
```

### 4.1. Nút thắt số 1 (Chiếm 65–75% thời gian trễ): `load_lopdf_structure` chặn luồng mở
* **Vị trí code:** [`desktop/src-tauri/src/lib.rs:3005`](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs#L3005) trong hàm `build_cached_document`:
  ```rust
  let lopdf_doc = load_lopdf_structure(&bytes, total_ram)?;
  let user_units = collect_pdf_user_units(&lopdf_doc);
  let (bootstrap_color_risk, color_risk) = if include_color_risk { ... };
  drop(lopdf_doc);
  ```
* **Bản chất vấn đề:** 
  - Hàm `load_lopdf_structure` sử dụng thư viện `lopdf` để đọc toàn bộ tệp vào một cây cú pháp trừu tượng khổng lồ (`BTreeMap<ObjectId, Object>`).
  - `lopdf` duyệt qua **từng đối tượng gián tiếp, từng stream, từng font, từng dictionary của toàn bộ 45 trang**.
  - Đối với tệp catalogue in ấn 88 MB chứa hàng chục nghìn vector, việc phân tích cú pháp toàn bộ này mất từ **`1,500 ms đến 3,000 ms`** trên CPU.
  - Mục đích của lần đọc này chỉ là trích xuất `/UserUnit` (hệ số tỉ lệ khổ lớn) và cảnh báo màu ban đầu (`bootstrap_color_risk`). Bắt toàn bộ quá trình mở trang 1 phải dừng lại chờ phân tích toàn bộ tài liệu là nguyên nhân cốt lõi gây trễ.

### 4.2. Nút thắt số 2: Nhân bản bộ nhớ thừa (`clone Vec<u8>`)
* **Vị trí code:** [`desktop/src-tauri/src/lib.rs:3016-3017`](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs#L3016-L3017):
  ```rust
  let cached_bytes = Arc::new(bytes);
  let doc = load_pdf_document_from_bytes(pdfium, (*cached_bytes).clone())?;
  ```
* **Bản chất vấn đề:** 
  - Tệp 88 MB vừa được nạp vào biến `bytes`.
  - Tại dòng 3017, hệ thống gọi `(*cached_bytes).clone()` tạo thêm một bản copy 88 MB thứ hai để đưa vào PDFium. Việc cấp phát liên tục khối nhớ lớn gây áp lực cho trình cấp phát bộ nhớ (Heap Allocator) và làm chậm CPU.

### 4.3. Nút thắt số 3: Đường ống tuần tự (Sequential Blocking Pipeline) giữa Frontend và Rust
* Frontend React (`usePdfLoader.ts`) bị chặn hoàn toàn tại lệnh gọi `get_pdf_viewer_bootstrap`.
* Trong suốt thời gian `lopdf` đang cày xới tệp, Frontend không hề có thông tin kích thước trang 1 để khởi tạo khung nhìn (Viewport).
* Chỉ sau khi `get_pdf_viewer_bootstrap` xong $\rightarrow$ React mới re-render $\rightarrow$ `LivePageFrame` mới mount $\rightarrow$ `LiveTile` mới được kích hoạt $\rightarrow$ mới gửi lệnh `render_pdf_page` sang Rust.

### 4.4. Nút thắt số 4: Vận chuyển Bitmap lớn qua Tauri IPC
* Trang 1 ở tỷ lệ nét cao có kích thước khoảng $2480 \times 3508$ pixels, dung lượng bitmap thô (RGBA) lên đến **~34 MB**.
* Dữ liệu nhị phân này phải truyền qua kênh trung gian Tauri IPC từ Rust sang WebView2, sau đó JavaScript mới đưa lên thẻ `<canvas>`.

---

## 5. Đề xuất kiến trúc: Đường ống mở file tức thì (< 300 ms)

Để PrynX đạt tốc độ mở file ngang ngửa Acrobat, kiến trúc xử lý cần chuyển đổi từ mô hình "Eager Blocking" (làm hết rồi mới vẽ) sang mô hình **"Fast-Path Progressive"** (vẽ trước, phân tích sâu chạy nền).

```
┌────────────────────────────────────────────────────────────────────────┐
│                   KIẾN TRÚC ĐỀ XUẤT CHO PRYNX                          │
├────────────────────────────────────────────────────────────────────────┤
│ PHA 1: FAST-PATH BOOTSTRAP (< 20 ms)                                   │
│  - Mở trực tiếp bằng PDFium (không qua lopdf)                          │
│  - Lấy ngay Page Count và Kích thước Trang 1                           │
│  - Trích xuất /UserUnit Trang 1 bằng parser byte siêu nhẹ (< 1 ms)     │
│  - Trả ngay về Frontend -> Kích hoạt render Trang 1 lập tức           │
├────────────────────────────────────────────────────────────────────────┤
│ PHA 2: PROGRESSIVE RENDERING (< 50 ms)                                 │
│  - PDFium vẽ ngay bản Low-DPI Draft 72 DPI (30-50 ms)                  │
│  - Canvas hiển thị ngay lập tức -> Mắt người dùng thấy hình ảnh tức thì│
│  - Luồng nền tiếp tục vẽ bản High-DPI 150-300 DPI và swap đè lên      │
├────────────────────────────────────────────────────────────────────────┤
│ PHA 3: BACKGROUND ASYNC ANALYSIS (Chạy ngầm không ảnh hưởng UI)        │
│  - lopdf, preflight, spot color risk, cấu trúc 45 trang chạy nền       │
│  - Bộ đệm thông minh tự động nạp trước Trang 2                         │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1. Giải pháp 1: Tách Fast-Path Bootstrap — Trì hoãn `lopdf`
* **Cơ chế:** Khi mở file, `get_pdf_viewer_bootstrap` chỉ sử dụng PDFium (`doc.pages().len()` và `page.width()`, `page.height()`). Khâu này chỉ mất **`< 15 ms`** thay vì 2–3 giây.
* **Xử lý `/UserUnit`:**
  - Thay vì parse toàn bộ tài liệu bằng `lopdf`, viết một hàm quét byte nhẹ (lightweight byte scanner) chỉ trích xuất từ khóa `/UserUnit` trong Dictionary của Trang 1 (thời gian chạy: `< 0.5 ms`).
  - Với các trang sau, `/UserUnit` được cập nhật lười (lazy) khi người dùng cuộn đến trang đó.
* **Chuyển `color_risk` ra Background Worker:** Cảnh báo hệ màu và phân tích tách màu chuyển hoàn toàn thành tác vụ bất đồng bộ, cập nhật lên UI sau khi trang 1 đã vẽ xong.

### 5.2. Giải pháp 2: Mở tệp qua Memory Mapping (`mmap`) & Truyền trực tiếp Buffer
* Sử dụng crate `memmap2` hoặc mở trực tiếp đường dẫn file trong PDFium thay vì gọi `std::fs::read` toàn bộ 88 MB / 1 GB vào bộ nhớ heap.
* Loại bỏ triệt để lệnh `(*cached_bytes).clone()` tại dòng [3017](file:///d:/pdfcompare/desktop/src-tauri/src/lib.rs#L3017), cho phép PDFium chia sẻ con trỏ bộ nhớ hoặc đọc trực tiếp từ bộ đệm của hệ điều hành.

### 5.3. Giải pháp 3: Progressive Rendering (Bản nháp 50 ms $\rightarrow$ Bản nét chi tiết)
* Frontend khi gửi yêu cầu render trang 1 sẽ ưu tiên mức `draft` (độ phân giải màn hình thông thường ~72 DPI hoặc scale 0.5x). PDFium xử lý bản nháp này chỉ mất **`30 – 50 ms`**.
* Canvas hiển thị ảnh nháp này ngay lập tức. Người dùng không còn cảm giác bị "đơ" hay chờ đợi màn hình trắng.
* Tiến trình nền tiếp tục render bản đầy đủ chi tiết nét căng và ghi đè mượt mà lên canvas sau đó ~300 ms.

### 5.4. Giải pháp 4: Prefetch trang kế cận thông minh (Predictive Cache)
* Ngay khi Trang 1 hiển thị ổn định, bộ điều phối tài nguyên (Scheduler) tận dụng thời gian rảnh của CPU để render ngầm Trang 2 vào bộ nhớ đệm (LRU Page Cache).
* Khi người dùng nhấn Next hoặc cuộn chuột, Trang 2 lập tức xuất hiện với độ trễ **`0 ms`**.

---

## 6. Ma trận đánh giá rủi ro & Tính tương thích chế bản

| Tiêu chí | Hiện trạng | Sau khi tối ưu kiến trúc đề xuất | Rủi ro & Giải pháp kiểm soát |
|---|---|---|---|
| **Thời gian mở tệp 88 MB** | 2,500 – 4,000 ms | **< 300 ms** (Tức thì) | Không có rủi ro; cải thiện trải nghiệm vượt bậc. |
| **Độ chính xác kích thước `/UserUnit`** | Trích xuất qua `lopdf` toàn file | Quét trực tiếp Dictionary Trang 1 + Fallback | Rủi ro sai kích thước khổ lớn: Viết test đối chiếu 100% với golden master của `lopdf`. |
| **Cảnh báo màu (`ColorRisk`)** | Chặn luồng mở để phân tích | Phân tích ngầm (Background Task) | UI sẽ hiện badge màu sau khi mở 1–2 giây thay vì hiện tức thì; không ảnh hưởng thao tác xem trang. |
| **Tiêu tốn RAM đỉnh (Peak RAM)** | Cấp phát 2 lần dung lượng tệp | Dùng chung bộ nhớ / Mmap | Giảm 50–70% lượng RAM tiêu thụ khi vừa mở file. |
| **An toàn đa luồng PDFium** | Khóa `pdfium_guard()` / `RENDER_LOCK` | Giữ nguyên khóa an toàn | Tuyệt đối tuân thủ bất biến đa luồng PDFium của PrynX. |

---

## 7. Kế hoạch triển khai dự kiến (Tuân thủ Quy tắc Audit 2 Chốt)

*Theo quy tắc `AGENTS.md`, mọi đợt sửa lớn phải được phân chia thành các lô nhỏ $\le$ 5 file, mỗi lô verify xanh trước khi sang lô kế tiếp:*

* **Lô 1 (Fast-Path Bootstrap không phụ thuộc `lopdf`):**
  - Chỉnh sửa `desktop/src-tauri/src/lib.rs`: Tách `build_cached_document` thành Fast-Path mở bằng PDFium trước, dời `load_lopdf_structure` ra luồng chạy ngầm.
  - Viết parser quét `/UserUnit` nhanh cho Trang 1.
  - Verify: Chạy toàn bộ test `desktop/src-tauri` và kiểm tra thời gian bootstrap với file 88 MB.
* **Lô 2 (Loại bỏ nhân bản bộ nhớ `Vec<u8>` & Tối ưu Memory Mapping):**
  - Tối ưu `load_pdf_document_from_bytes` để tái sử dụng buffer, không clone bộ nhớ.
  - Tích hợp `memmap2` cho các tệp vượt ngưỡng 50 MB.
* **Lô 3 (Progressive Rendering tại Frontend React):**
  - Cập nhật `LivePageFrame.tsx` / `LiveTile.tsx` để hỗ trợ hiển thị bản xem nhanh (Low-Res Placeholder) trước khi tile High-Res hoàn thành.
* **Lô 4 (Prefetch trang kế cận & Kiểm thử hồi quy toàn diện):**
  - Bật cơ chế render ngầm trang kế tiếp khi rảnh CPU.
  - Chạy toàn bộ test suite: `vitest run`, `cargo check`, pytest preflight & imposition.
