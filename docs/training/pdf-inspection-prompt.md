# 🖨️ BUILD: PDF Comparison & Print Imposition Inspection System
# Dành cho ngành In ấn (Printing Industry)

---

## 🎯 TỔNG QUAN DỰ ÁN

Xây dựng một Web Application chuyên nghiệp phục vụ ngành in ấn với 2 chức năng cốt lõi:

### Chức năng 1 — PDF Version Compare (Đối chiếu trước/sau khi sửa)
So sánh 2 file PDF (bản gốc và bản đã chỉnh sửa), tự động phát hiện và highlight TẤT CẢ vùng thay đổi gồm: văn bản, hình ảnh, layout, font, màu sắc.

### Chức năng 2 — Imposition Verification (Kiểm tra bình vào khổ in)
So sánh file PDF thiết kế gốc (từng trang đơn A4/A3...) với file PDF đã bình vào khổ in (imposition sheet — nhiều trang xếp trên 1 tờ lớn như SRA3, B1...) để đảm bảo không có sai sót, mất nội dung, sai vị trí, sai trang trong quá trình bình.

---

## 🛠️ TECH STACK BẮT BUỘC

### Backend (Python — mạnh nhất cho xử lý PDF/Image)
- **Runtime:** Python 3.11+
- **Web Framework:** FastAPI (async, hiệu năng cao)
- **PDF Processing:** pikepdf + pypdfium2 — nhanh nhất, hỗ trợ CMYK native
- **PDF to Image:** pdf2image + Poppler
- **Image Comparison:** OpenCV 4.x, scikit-image (SSIM), Pillow
- **OCR (nếu cần):** EasyOCR hoặc Tesseract 5
- **Task Queue:** Celery + Redis (xử lý bất đồng bộ cho file lớn)
- **File Storage:** MinIO (self-hosted S3-compatible) hoặc local filesystem
- **Database:** PostgreSQL (lưu metadata, jobs, kết quả)
- **ORM:** SQLAlchemy + Alembic

### Frontend
- **Framework:** Next.js 14 (App Router) + TypeScript
- **UI Library:** shadcn/ui + Tailwind CSS
- **PDF Viewer:** `wojtekmaj/react-pdf` v9+ — **MIT License ✅** (wrapper của pdf.js, miễn phí thương mại)
  - npm: `react-pdf` — https://github.com/wojtekmaj/react-pdf
  - ⚠️ KHÔNG dùng `react-pdf-viewer` (yêu cầu mua commercial license $49+)
- **PDF Worker:** `pdfjs-dist` (Mozilla pdf.js — Apache 2.0 ✅)
- **Synchronized Scroll:** `scroll-sync-react` (MIT ✅) — đồng bộ cuộn 2 viewer
- **Image Viewer / Deep Zoom:** OpenSeadragon (BSD-3 ✅) — zoom sâu cho bản in 300 DPI
- **State Management:** Zustand
- **API Client:** TanStack Query (React Query)
- **Real-time Updates:** WebSocket (FastAPI + native WebSocket)

### Infrastructure
- **Containerization:** Docker + Docker Compose
- **Web Server:** Nginx (reverse proxy)
- **Process Manager:** Supervisor (quản lý Celery workers)

---

## 📁 CẤU TRÚC THƯ MỤC DỰ ÁN

```
pdf-inspection-system/
├── backend/
│   ├── app/
│   │   ├── main.py                    # FastAPI entry point
│   │   ├── config.py                  # Settings, env vars
│   │   ├── database.py                # DB connection
│   │   ├── models/
│   │   │   ├── job.py                 # ComparisonJob model
│   │   │   └── user.py                # User model (auth)
│   │   ├── schemas/
│   │   │   ├── job.py                 # Pydantic schemas
│   │   │   └── comparison.py
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── upload.py          # Upload PDF endpoints
│   │   │   │   ├── compare.py         # Trigger comparison
│   │   │   │   ├── results.py         # Get results
│   │   │   │   ├── jobs.py            # Job management
│   │   │   │   └── ws.py              # WebSocket progress
│   │   ├── core/
│   │   │   ├── pdf_processor.py       # PDF → Image conversion
│   │   │   ├── text_extractor.py      # Extract text layer từ PDF
│   │   │   ├── image_comparator.py    # Pixel-level comparison
│   │   │   ├── text_comparator.py     # Text diff comparison
│   │   │   ├── imposition_detector.py # Detect pages trong imposition sheet
│   │   │   ├── imposition_verifier.py # So sánh gốc vs imposition
│   │   │   ├── highlight_renderer.py  # Render highlight overlay
│   │   │   └── report_generator.py    # Xuất báo cáo PDF
│   │   ├── workers/
│   │   │   ├── celery_app.py          # Celery config
│   │   │   ├── compare_task.py        # Async comparison task
│   │   │   └── imposition_task.py     # Async imposition task
│   │   └── utils/
│   │       ├── file_handler.py
│   │       └── image_utils.py
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx               # Dashboard / Home
│   │   │   ├── compare/
│   │   │   │   └── page.tsx           # PDF Version Compare UI
│   │   │   ├── imposition/
│   │   │   │   └── page.tsx           # Imposition Verify UI
│   │   │   └── results/
│   │   │       └── [jobId]/page.tsx   # Kết quả chi tiết
│   │   ├── components/
│   │   │   ├── PDFUploader.tsx        # Drag & drop upload
│   │   │   ├── DualPDFViewer.tsx      # Hiển thị song song 2 PDF (react-pdf MIT)
│   │   │   ├── DiffHighlighter.tsx    # Overlay highlight sai khác
│   │   │   ├── DiffSidebar.tsx        # Danh sách lỗi tìm được
│   │   │   ├── ProgressTracker.tsx    # Real-time progress bar
│   │   │   ├── ImpositionMapper.tsx   # Map trang gốc vào sheet
│   │   │   └── ReportExporter.tsx     # Xuất báo cáo
│   │   ├── lib/
│   │   │   ├── api.ts
│   │   │   └── websocket.ts
│   │   └── stores/
│   │       └── comparisonStore.ts
│   └── Dockerfile
├── nginx/
│   └── nginx.conf
├── docker-compose.yml
└── README.md
```

---

## ⚙️ CHI TIẾT IMPLEMENTATION

### MODULE 1: PDF Processor (`pdf_processor.py`)

```python
# Yêu cầu implement đầy đủ:

class PDFProcessor:
    """
    Convert PDF pages sang high-resolution images để so sánh.
    
    Specs:
    - DPI: 150 DPI cho preview, 300 DPI cho comparison chính xác
    - Color Space: Preserve CMYK (quan trọng cho ngành in)
    - Format output: PNG (lossless)
    - Xử lý PDF nhiều trang: chunking từng 10 trang
    - Memory management: giải phóng memory sau mỗi chunk
    - Hỗ trợ PDF có password
    - Detect và report: số trang, kích thước trang, color space, DPI gốc
    """
    
    def convert_to_images(self, pdf_path: str, dpi: int = 300) -> List[np.ndarray]:
        # Convert từng trang PDF thành numpy array (OpenCV format)
        pass
    
    def get_pdf_metadata(self, pdf_path: str) -> PDFMetadata:
        # Trả về: page_count, page_sizes, color_spaces, fonts_used
        pass
    
    def extract_page(self, pdf_path: str, page_num: int, dpi: int) -> np.ndarray:
        # Extract 1 trang cụ thể
        pass
```

### MODULE 2: Image Comparator (`image_comparator.py`)

```python
class ImageComparator:
    """
    So sánh 2 ảnh pixel-by-pixel với nhiều phương pháp.
    
    Algorithms cần implement:
    1. SSIM (Structural Similarity Index) — phát hiện thay đổi cấu trúc
    2. Pixel Difference (absolute diff) — phát hiện thay đổi màu sắc
    3. Contour Detection — xác định vùng bounding box của thay đổi
    4. Clustering — gom nhóm các vùng thay đổi gần nhau thành 1 vùng
    
    Output:
    - diff_mask: binary mask vùng thay đổi
    - diff_regions: list of {bbox, area, type, severity}
    - similarity_score: float 0-100%
    - highlighted_image: ảnh với vùng thay đổi được highlight màu đỏ/vàng
    
    Tolerance levels (quan trọng cho in ấn):
    - STRICT: mọi pixel khác nhau đều báo (threshold = 0)
    - NORMAL: bỏ qua anti-aliasing nhỏ (threshold = 5%)  
    - LOOSE: chỉ báo thay đổi lớn (threshold = 15%)
    
    Pre-processing trước khi compare:
    - Auto-align 2 ảnh nếu có lệch nhỏ (homography correction)
    - Normalize brightness nếu scan ảnh bị sáng/tối khác nhau
    - Resize về cùng resolution nếu khác nhau
    """
    
    def compare(
        self, 
        img1: np.ndarray, 
        img2: np.ndarray,
        tolerance: str = "NORMAL",
        method: str = "SSIM"
    ) -> ComparisonResult:
        pass
    
    def highlight_differences(
        self, 
        img1: np.ndarray, 
        img2: np.ndarray, 
        diff_mask: np.ndarray,
        highlight_color: tuple = (255, 0, 0),  # RED
        overlay_alpha: float = 0.4
    ) -> np.ndarray:
        pass
```

### MODULE 3: Text Comparator (`text_comparator.py`)

```python
class TextComparator:
    """
    So sánh text layer của 2 PDF (không qua OCR — đọc trực tiếp từ PDF).
    
    Cần implement:
    1. Extract text với vị trí (x, y, width, height) từng ký tự/từ/dòng
    2. Diff text sử dụng difflib hoặc Levenshtein distance
    3. Map vị trí thay đổi về tọa độ trên PDF page để highlight
    4. Phát hiện các loại thay đổi:
       - TEXT_ADDED: thêm mới text
       - TEXT_REMOVED: xóa text
       - TEXT_MODIFIED: thay đổi nội dung text
       - FONT_CHANGED: thay đổi font/size/style
       - COLOR_CHANGED: thay đổi màu chữ
       - POSITION_SHIFTED: text bị dịch vị trí
    
    Xử lý đặc biệt:
    - So sánh text đã được hyphenate, wrap line
    - Bỏ qua khoảng trắng thừa nếu cần (configurable)
    - Hỗ trợ Unicode đầy đủ (tiếng Việt, CJK, Arabic...)
    """
    
    def extract_text_blocks(self, pdf_path: str, page_num: int) -> List[TextBlock]:
        # Dùng pikepdf: page.get_text("dict") để lấy text + vị trí
        pass
    
    def compare_pages(
        self, 
        pdf1_path: str, 
        pdf2_path: str, 
        page_num: int
    ) -> TextDiffResult:
        pass
```

### MODULE 4: Imposition Detector (`imposition_detector.py`)

```python
class ImpositionDetector:
    """
    ĐÂY LÀ MODULE PHỨC TẠP NHẤT — Detect và extract từng trang đơn
    trong file PDF đã bình vào khổ in (imposition sheet).
    
    Ví dụ: File gốc có 8 trang A4, sau khi bình thành 2 tờ SRA3,
    mỗi tờ SRA3 chứa 4 trang A4 xếp theo bố cục 2x2.
    
    Cần implement:
    
    BƯỚC 1 — Phát hiện bố cục imposition:
    - Phân tích kích thước tờ in (SRA3, B1, B2...)
    - Detect đường crop mark / trim mark / bleed mark
    - Detect registration marks (chữ thập góc)
    - Từ đó xác định: số hàng x số cột (2x4, 4x4...) và vị trí từng trang
    
    BƯỚC 2 — Map trang về số thứ tự:
    - Đọc page number từ text layer nếu có
    - Hoặc dùng visual fingerprint (hash ảnh) để match với trang gốc
    - Xây dựng mapping: {sheet_1_pos_A: original_page_3, ...}
    
    BƯỚC 3 — Extract từng trang:
    - Crop chính xác từng trang dựa trên trim box
    - Loại bỏ bleed area nếu cần
    - Chuẩn hóa về đúng kích thước trang gốc
    
    BƯỚC 4 — Detect rotation:
    - Một số imposition có trang bị xoay 180° (work-and-turn)
    - Detect và correct rotation trước khi compare
    
    Fallback nếu không detect được tự động:
    - Cho phép user manually define grid layout (rows x cols)
    - Cho phép user click chọn vùng từng trang trên viewer
    """
    
    def detect_layout(self, imposition_pdf_path: str) -> ImpositionLayout:
        # Returns: sheet_size, rows, cols, page_positions[], margins
        pass
    
    def extract_pages(
        self, 
        imposition_pdf_path: str, 
        layout: ImpositionLayout
    ) -> List[ExtractedPage]:
        # Returns: list of {page_image, detected_page_num, position, rotation}
        pass
    
    def match_to_originals(
        self,
        extracted_pages: List[ExtractedPage],
        original_pdf_path: str
    ) -> List[PageMapping]:
        # Returns: [{extracted_page, original_page_num, confidence}]
        pass
```

### MODULE 5: Imposition Verifier (`imposition_verifier.py`)

```python
class ImpositionVerifier:
    """
    Xác minh toàn bộ imposition so với file gốc.
    
    Kiểm tra:
    1. PAGE COMPLETENESS: Tất cả trang gốc đều có trong imposition?
    2. PAGE ORDER: Thứ tự trang có đúng không?
    3. PAGE CONTENT: Nội dung từng trang có giống hệt không?
    4. PAGE ROTATION: Các trang có bị xoay sai không?
    5. BLEED CHECK: Vùng bleed có đủ không (thường 3mm)?
    6. DUPLICATE CHECK: Có trang nào bị lặp không?
    7. MISSING CHECK: Có trang nào bị thiếu không?
    
    Output report:
    - overall_status: PASS / FAIL / WARNING
    - page_by_page_results: [{page_num, status, issues[], similarity_score}]
    - critical_errors: list các lỗi nghiêm trọng
    - warnings: list cảnh báo
    - summary: tổng số trang OK / FAIL / WARNING
    """
    
    def verify(
        self,
        original_pdf: str,
        imposition_pdf: str,
        layout: ImpositionLayout = None,  # None = auto-detect
        tolerance: str = "NORMAL"
    ) -> VerificationReport:
        pass
```

---

## 🌐 API ENDPOINTS

```
POST   /api/upload                    Upload 1 hoặc nhiều file PDF
POST   /api/jobs/compare              Tạo job so sánh 2 PDF versions  
POST   /api/jobs/verify-imposition    Tạo job kiểm tra imposition
GET    /api/jobs/{job_id}             Lấy trạng thái job
GET    /api/jobs/{job_id}/results     Lấy kết quả đầy đủ
GET    /api/jobs/{job_id}/page/{n}    Lấy kết quả trang N
GET    /api/jobs/{job_id}/report      Download báo cáo PDF
DELETE /api/jobs/{job_id}             Xóa job
WS     /ws/jobs/{job_id}/progress     Real-time progress updates

Request body cho /api/jobs/compare:
{
  "file_a_id": "uuid",           // File gốc (before)
  "file_b_id": "uuid",           // File sửa (after)
  "comparison_mode": "full",     // full | text_only | image_only
  "tolerance": "NORMAL",         // STRICT | NORMAL | LOOSE
  "dpi": 300,                    // 150 | 300
  "highlight_color": "#FF0000"   // Màu highlight
}

Request body cho /api/jobs/verify-imposition:
{
  "original_pdf_id": "uuid",
  "imposition_pdf_id": "uuid",
  "layout_mode": "auto",         // auto | manual
  "manual_layout": {             // Chỉ cần nếu layout_mode = manual
    "rows": 2,
    "cols": 4,
    "margin_top_mm": 10,
    "margin_left_mm": 10
  },
  "tolerance": "NORMAL",
  "check_bleed": true,
  "bleed_mm": 3
}
```

---

## 🖥️ UI/UX YÊU CẦU

### Trang Compare PDF (`/compare`)

**Layout:** Split view 50/50 trái-phải

**Bên trái:**
- File upload area (drag & drop) cho PDF A (Bản gốc)
- Label: "PDF Gốc (Trước khi sửa)"
- Preview thumbnail trang đầu

**Bên phải:**
- File upload area cho PDF B (Bản sửa)
- Label: "PDF Đã Sửa (Sau khi sửa)"
- Preview thumbnail trang đầu

**Controls:**
- Dropdown: Tolerance (Nghiêm ngặt / Bình thường / Rộng)
- Dropdown: DPI (150 - Nhanh / 300 - Chính xác)
- Toggle: So sánh Text / So sánh Hình ảnh / Cả hai
- Button: "Bắt đầu So sánh" (primary, lớn)

**Sau khi có kết quả:**
- Dual viewer synchronized scroll (cuộn 1 bên → bên kia cuộn theo)
  - Dùng `scroll-sync-react` (MIT) để đồng bộ scroll position giữa 2 viewer
- Overlay highlight màu đỏ trên vùng thay đổi
- Sidebar phải: Danh sách tất cả thay đổi, click để navigate
- Mỗi item trong list: [Page X] [Loại thay đổi] [Preview nhỏ]
- Footer: "Tìm thấy X thay đổi | Độ tương đồng: Y%"
- Button: "Xuất báo cáo PDF"

### Trang Imposition Verify (`/imposition`)

**Bước 1 — Upload:**
- Upload PDF gốc (nhiều trang đơn)
- Upload PDF imposition (tờ in đã bình)
- Button: "Phân tích Layout Tự động"

**Bước 2 — Xác nhận Layout:**
- Preview tờ imposition với grid overlay hiển thị các trang detected
- Hiển thị bảng mapping: Vị trí → Trang số
- Cho phép user sửa mapping nếu detect sai
- Button: "Xác nhận & Kiểm tra"

**Bước 3 — Kết quả:**
- Overview: Số trang PASS (xanh) / FAIL (đỏ) / WARNING (vàng)
- Grid view: Hiển thị từng trang thu nhỏ với status icon
- Click vào trang: Mở chi tiết với split view so sánh trang đó
- Sidebar: List tất cả lỗi, severity level, mô tả chi tiết
- Button: "Xuất báo cáo kiểm tra"

---

## ⚡ PERFORMANCE REQUIREMENTS

```
File size tối đa: 500MB per file
Số trang tối đa: 500 trang
Thời gian xử lý mục tiêu:
  - PDF 10 trang @ 150 DPI: < 30 giây
  - PDF 10 trang @ 300 DPI: < 90 giây
  - Imposition 64 trang: < 3 phút

Giải pháp tối ưu hóa bắt buộc:
1. Celery async task queue (không block UI)
2. WebSocket real-time progress updates (0%...25%...50%...100%)
3. Process pages in parallel (multiprocessing.Pool)
4. Cache converted images (không convert lại nếu file đã process)
5. Progressive results: hiển thị kết quả từng trang ngay khi xong
6. Streaming response cho kết quả lớn
```

---

## 📊 DATABASE SCHEMA

```sql
-- File uploads
CREATE TABLE uploaded_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    page_count INTEGER,
    pdf_metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP  -- Auto-delete sau 7 ngày
);

-- Comparison jobs
CREATE TABLE comparison_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(50) NOT NULL,  -- 'version_compare' | 'imposition_verify'
    status VARCHAR(50) DEFAULT 'pending',  -- pending|processing|completed|failed
    file_a_id UUID REFERENCES uploaded_files(id),
    file_b_id UUID REFERENCES uploaded_files(id),
    config JSONB,  -- tolerance, dpi, etc.
    progress INTEGER DEFAULT 0,  -- 0-100
    current_page INTEGER DEFAULT 0,
    total_pages INTEGER,
    result_summary JSONB,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- Page-level results
CREATE TABLE page_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES comparison_jobs(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    status VARCHAR(20),  -- pass|fail|warning
    similarity_score FLOAT,
    diff_count INTEGER,
    diff_regions JSONB,  -- [{bbox, type, severity, description}]
    highlighted_image_path TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🔄 CELERY TASK FLOW

```python
@celery_app.task(bind=True)
def run_comparison_task(self, job_id: str):
    """
    Luồng xử lý:
    1. Load job từ DB → set status = 'processing'
    2. Convert PDF A & B sang images (progress: 0-20%)
    3. For each page pair:
       a. Compare images (SSIM + pixel diff)
       b. Compare text layers
       c. Merge kết quả, tạo highlight overlay
       d. Lưu page_result vào DB
       e. Update progress qua WebSocket
       f. progress: 20% + (page_num/total_pages * 70%)
    4. Generate summary report (progress: 90-100%)
    5. Set status = 'completed'
    6. Notify client qua WebSocket
    
    Error handling:
    - Retry tối đa 3 lần nếu fail
    - Lưu error_message nếu fail hoàn toàn
    - Cleanup temp files sau khi xong
    """
```

---

## 📄 BÁO CÁO PDF OUTPUT

Báo cáo xuất ra phải bao gồm:

```
TRANG 1 — TỔNG QUAN
- Tên dự án, ngày giờ kiểm tra
- File A vs File B (tên, số trang, kích thước)
- Kết quả tổng: X trang kiểm tra, Y trang có lỗi
- Biểu đồ tóm tắt

TRANG 2+ — CHI TIẾT TỪNG TRANG CÓ LỖI
- Số trang, % tương đồng
- Ảnh so sánh: [Bản gốc] [Bản mới] [Highlight diff]
- Danh sách lỗi chi tiết với vị trí tọa độ

TRANG CUỐI — KÝ XÁC NHẬN
- Bảng ký duyệt (để in ra ký tay)
```

Thư viện: `reportlab` hoặc `weasyprint`

---

## 🚀 DOCKER COMPOSE

```yaml
services:
  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql://...
      REDIS_URL: redis://redis:6379
      MINIO_URL: http://minio:9000
    volumes:
      - ./uploads:/app/uploads
    depends_on: [postgres, redis, minio]

  worker:
    build: ./backend
    command: celery -A app.workers.celery_app worker --concurrency=4 --loglevel=info
    environment: *backend-env
    depends_on: [redis, postgres]

  frontend:
    build: ./frontend
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:8000

  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
```

---

## ✅ ACCEPTANCE CRITERIA (Tiêu chí nghiệm thu)

### Chức năng 1 — Version Compare:
- [ ] Upload 2 PDF tối đa 100MB, xử lý thành công
- [ ] Phát hiện thay đổi text chính xác 100% (test với known diff)
- [ ] Phát hiện thay đổi hình ảnh (pixel diff > 0.5%)
- [ ] Highlight vùng thay đổi rõ ràng, đúng vị trí
- [ ] Synchronized scroll 2 trang (dùng scroll-sync-react — MIT)
- [ ] Xuất báo cáo PDF đầy đủ
- [ ] Xử lý PDF 50 trang trong < 3 phút

### Chức năng 2 — Imposition Verify:
- [ ] Auto-detect layout imposition đúng với 8-up, 16-up phổ biến
- [ ] Match đúng trang gốc với trang trong imposition (accuracy > 95%)
- [ ] Phát hiện trang thiếu, trang lặp, trang sai vị trí
- [ ] Phát hiện nội dung sai khác giữa gốc và imposition
- [ ] Cho phép manual mapping nếu auto fail
- [ ] Xuất báo cáo kiểm tra imposition

---

## 🔑 NOTES QUAN TRỌNG CHO AI AGENT

1. **CMYK COLOR SPACE**: Ngành in dùng CMYK, không phải RGB.
   pikepdf hỗ trợ native CMYK → KHÔNG convert sang RGB khi so sánh màu.
   Chỉ convert sang RGB khi hiển thị trên web.

2. **HIGH RESOLUTION**: Độ phân giải 300 DPI là tiêu chuẩn ngành in.
   Ảnh 300 DPI của trang A4 = 2480 x 3508 pixels.
   Cần tối ưu memory khi xử lý: process từng trang, không load toàn bộ vào RAM.

3. **IMPOSITION COMPLEXITY**: Đây là phần khó nhất.
   Nếu auto-detect không hoạt động 100%, ưu tiên xây dựng manual mode hoàn chỉnh trước.
   Auto-detect có thể improve dần.

4. **FONT HANDLING**: PDF in ấn thường embed font hoàn toàn.
   pikepdf có thể extract font info — dùng để detect font changes.

5. **BLEED & TRIM**: File in có bleed area (thường 3mm ngoài trim box).
   Khi so sánh nội dung, chỉ so sánh trong trim box, bỏ qua bleed.
   pikepdf: page.trimbox vs page.mediabox

6. **PERFORMANCE**: Chạy comparison trong Celery worker, KHÔNG chạy trong API request thread.
   API chỉ tạo job và return job_id ngay lập tức.
   Client poll hoặc nhận WebSocket để biết khi nào xong.

7. **ERROR MESSAGES**: Mọi lỗi phải có message tiếng Việt rõ ràng cho user.
   Ví dụ: "File PDF bị mã hóa, vui lòng nhập mật khẩu" thay vì "Encrypted PDF error".

8. **PDF VIEWER LICENSE**: 
   - ✅ DÙNG: `wojtekmaj/react-pdf` (MIT License) — `npm install react-pdf pdfjs-dist`
   - ✅ DÙNG: `scroll-sync-react` (MIT License) — đồng bộ scroll 2 viewer
   - ❌ KHÔNG dùng: `react-pdf-viewer` (commercial license, phải mua $49+/developer)

---

## 🖥️ FRONTEND IMPLEMENTATION — DualPDFViewer

### Cài đặt dependencies (tất cả MIT/Apache ✅)

```bash
npm install react-pdf pdfjs-dist          # MIT - PDF rendering
npm install scroll-sync-react             # MIT - synchronized scroll
npm install @types/react-pdf              # TypeScript types
```

### `DualPDFViewer.tsx` — Implementation mẫu

```tsx
import { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ScrollSync, ScrollSyncPane } from 'scroll-sync-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Cấu hình pdf.js worker (Apache 2.0)
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface DiffRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'text' | 'image' | 'layout';
  severity: 'high' | 'medium' | 'low';
}

interface DualPDFViewerProps {
  leftPdfUrl: string;           // PDF gốc (before)
  rightPdfUrl: string;          // PDF đã sửa (after)
  diffRegions: DiffRegion[];    // Vùng thay đổi từ backend
  pageWidth?: number;           // Chiều rộng hiển thị (mặc định 600px)
}

const SEVERITY_COLORS = {
  high:   'rgba(239, 68, 68, 0.45)',   // Đỏ — thay đổi quan trọng
  medium: 'rgba(251, 146, 60, 0.40)',  // Cam — thay đổi vừa
  low:    'rgba(250, 204, 21, 0.35)',  // Vàng — thay đổi nhỏ
};

// Overlay component vẽ highlight trên canvas
const DiffOverlay = ({ pageNum, diffRegions, pageWidth }: {
  pageNum: number;
  diffRegions: DiffRegion[];
  pageWidth: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pageRegions = diffRegions.filter(r => r.page === pageNum);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pageRegions.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    pageRegions.forEach(region => {
      // Fill semi-transparent highlight
      ctx.fillStyle = SEVERITY_COLORS[region.severity];
      ctx.fillRect(region.x, region.y, region.width, region.height);

      // Vẽ border rõ
      ctx.strokeStyle = region.severity === 'high' ? '#EF4444' : '#FB923C';
      ctx.lineWidth = 2;
      ctx.strokeRect(region.x, region.y, region.width, region.height);
    });
  }, [pageRegions]);

  if (pageRegions.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      width={pageWidth}
      height={pageWidth * 1.414}  // Tỷ lệ A4
      className="absolute top-0 left-0 pointer-events-none"
      style={{ zIndex: 10 }}
    />
  );
};

export const DualPDFViewer = ({
  leftPdfUrl,
  rightPdfUrl,
  diffRegions,
  pageWidth = 600,
}: DualPDFViewerProps) => {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // Navigate đến trang có diff khi click vào sidebar
  const scrollToPage = (pageNum: number) => {
    setCurrentPage(pageNum);
    document
      .getElementById(`page-${pageNum}`)
      ?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="flex h-screen bg-gray-100">

      {/* MAIN VIEWER AREA */}
      <div className="flex flex-1 overflow-hidden">
        <ScrollSync>
          {/* LEFT: PDF Gốc */}
          <ScrollSyncPane>
            <div className="w-1/2 overflow-y-auto bg-gray-200 p-4 border-r-2 border-gray-400">
              <div className="text-center text-sm font-semibold text-gray-600 mb-3 py-2
                             bg-white rounded shadow-sm">
                📄 PDF GỐC (Trước khi sửa)
              </div>
              <Document
                file={leftPdfUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                loading={<div className="text-center p-8">Đang tải PDF...</div>}
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
                  <div
                    key={`left-${pageNum}`}
                    id={`page-${pageNum}`}
                    className="mb-4 shadow-lg"
                  >
                    <Page
                      pageNumber={pageNum}
                      width={pageWidth}
                      renderAnnotationLayer={false}
                      renderTextLayer={true}
                    />
                  </div>
                ))}
              </Document>
            </div>
          </ScrollSyncPane>

          {/* RIGHT: PDF Đã Sửa + Diff Overlay */}
          <ScrollSyncPane>
            <div className="w-1/2 overflow-y-auto bg-gray-200 p-4">
              <div className="text-center text-sm font-semibold text-red-600 mb-3 py-2
                             bg-white rounded shadow-sm">
                ✏️ PDF ĐÃ SỬA (Sau khi sửa) —
                <span className="ml-1 text-gray-500">
                  {diffRegions.length} vùng thay đổi
                </span>
              </div>
              <Document
                file={rightPdfUrl}
                loading={<div className="text-center p-8">Đang tải PDF...</div>}
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
                  <div
                    key={`right-${pageNum}`}
                    className="mb-4 shadow-lg relative"
                  >
                    <Page
                      pageNumber={pageNum}
                      width={pageWidth}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                    />
                    {/* Canvas overlay highlight diff */}
                    <DiffOverlay
                      pageNum={pageNum}
                      diffRegions={diffRegions}
                      pageWidth={pageWidth}
                    />
                  </div>
                ))}
              </Document>
            </div>
          </ScrollSyncPane>
        </ScrollSync>
      </div>

      {/* SIDEBAR: Danh sách thay đổi */}
      <div className="w-72 bg-white border-l border-gray-200 overflow-y-auto flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h3 className="font-bold text-gray-800">📋 Danh sách thay đổi</h3>
          <div className="mt-2 text-sm text-gray-500">
            Tổng: {diffRegions.length} vùng
            <span className="ml-2 text-red-500 font-medium">
              {diffRegions.filter(r => r.severity === 'high').length} nghiêm trọng
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {diffRegions.map((region, idx) => (
            <div
              key={idx}
              onClick={() => scrollToPage(region.page)}
              className="p-3 border-b border-gray-100 hover:bg-gray-50
                         cursor-pointer flex items-start gap-3"
            >
              {/* Severity indicator */}
              <div className={`mt-1 w-3 h-3 rounded-full flex-shrink-0 ${
                region.severity === 'high'   ? 'bg-red-500' :
                region.severity === 'medium' ? 'bg-orange-400' : 'bg-yellow-400'
              }`} />
              <div>
                <div className="text-sm font-medium text-gray-700">
                  Trang {region.page}
                </div>
                <div className="text-xs text-gray-500 capitalize">
                  {region.type === 'text'   ? '🔤 Thay đổi văn bản' :
                   region.type === 'image'  ? '🖼️ Thay đổi hình ảnh' :
                                             '📐 Thay đổi layout'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};

export default DualPDFViewer;
```

### Sử dụng component trong trang `/compare`

```tsx
// app/compare/page.tsx
import DualPDFViewer from '@/components/DualPDFViewer';

export default function ComparePage() {
  const [jobResult, setJobResult] = useState(null);

  // Khi job comparison hoàn thành, backend trả về:
  // { file_a_url, file_b_url, diff_regions: DiffRegion[] }

  return jobResult ? (
    <DualPDFViewer
      leftPdfUrl={jobResult.file_a_url}
      rightPdfUrl={jobResult.file_b_url}
      diffRegions={jobResult.diff_regions}
      pageWidth={600}
    />
  ) : (
    <UploadForm onComplete={setJobResult} />
  );
}
```

---

## 📦 DELIVERABLES

Sau khi hoàn thành, cần có:
1. Full source code với comments đầy đủ
2. README.md hướng dẫn cài đặt và chạy
3. .env.example với tất cả biến môi trường cần thiết
4. docker-compose.yml để chạy toàn bộ stack bằng 1 lệnh
5. Ít nhất 1 trang test PDF mẫu để demo cả 2 chức năng
6. API documentation (FastAPI auto-generates Swagger tại /docs)

---

## 💡 HƯỚNG DẪN SỬ DỤNG PROMPT NÀY VỚI CLAUDE

Khi bắt đầu một phiên làm việc mới với Claude, thêm đầu prompt:

> "Hãy build từng module một theo thứ tự sau:
> (1) PDF Processor → (2) Image Comparator → (3) Text Comparator →
> (4) Imposition Detector → (5) Imposition Verifier →
> (6) FastAPI Backend → (7) Celery Workers → (8) Frontend.
> Sau mỗi module, hãy viết unit test để xác nhận hoạt động đúng trước khi sang module tiếp theo."
