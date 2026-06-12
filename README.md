# 🖨️ PrynX (formerly PDF Inspector) — Hệ thống Tự động hóa Prepress & Bình trang Toàn diện

Từ một công cụ so sánh PDF đơn thuần, dự án đã tiến hóa thành một **Hệ sinh thái Prepress và Bình trang (Imposition) chuyên nghiệp**, hỗ trợ xử lý file in ấn khối lượng lớn với hiệu năng cao.

## ✨ Tính năng Cốt lõi

### 1. Bình trang Tự động (Advanced Imposition)
- **N-Up & Step-and-Repeat:** Tự động tính toán tay kê, lề kẹp (gripper), tràn lề (bleed) và xếp trang tối ưu. Hỗ trợ xử lý chia nhỏ (chunk processing) cho các file lớn.
- **Booklet & Auto Catalog:** Tự động xếp trang đóng cuốn, hỗ trợ đa dạng kiểu gấp.
- **Virtual Map & 3D Preview:** Engine tính toán tọa độ (Virtual Map) kết hợp với 3D Flipbook giả lập tờ in thực tế trước khi xuất file.

### 2. Công cụ Tiền in & Dữ liệu động (Preprocess & VDP)
- **Đóng Số Nhảy & Text Động:** Tự động chèn text, số nhảy (stick text/number), QR code hàng loạt vào vị trí chỉ định.
- **Tích hợp AI & Nhận dạng hình ảnh:** Sử dụng OCR Engine để bóc tách text, đọc mã vạch và tự động hóa phân loại file in.

### 3. Kiểm soát Chất lượng PDF (PDF Inspection)
- **So sánh PDF (Diff):** Thuật toán SSIM + Pixel-by-pixel, hỗ trợ bóc tách từng kênh màu CMYK để tìm kiếm sự khác biệt nhỏ nhất.
- **Diff Overlay & Tolerance:** Highlight vùng thay đổi theo mức độ nghiêm trọng, hiển thị song song đồng bộ (synchronized scroll).

## 🛠️ Tech Stack Siêu Phân Tán (Tauri + Python)

Hệ thống kết hợp sức mạnh xử lý native của Desktop và khả năng tính toán nặng của Backend.

### Desktop App (Frontend & Native)
- **Core:** Tauri v2 (Rust-based) + Vite
- **UI:** React 19 + TypeScript + Tailwind CSS v4
- **State Management:** Zustand
- **PDF & Render:** `pdf-lib`, `react-pdf`, `Three.js` (@react-three/fiber) cho 3D render, `react-pageflip`
- **Native Plugins:** Hỗ trợ File System, Dialog, Process, Shell của Tauri

### Backend & AI (Processing Engine)
- **Core:** Python 3.11 + FastAPI
- **Task Queue:** Celery + Redis (xử lý bất đồng bộ nặng)
- **Computer Vision:** OpenCV + scikit-image
- **PDF Parser & OCR:** pdf2image, Poppler, PikePDF, Tesseract (OCR Engine)

## 🚀 Hướng dẫn Cài đặt & Chạy (Development)

### 1. Chạy Backend Engine
```bash
cd backend
python -m venv venv
venv\Scripts\activate     # Windows
pip install -r requirements.txt

# Yêu cầu: Redis phải đang chạy
# Chạy API Server
uvicorn app.main:app --reload --port 8000

# Chạy Worker xử lý file nặng (mở terminal khác)
celery -A app.workers.celery_app worker --loglevel=info
```

### 2. Chạy Desktop App (Tauri)
```bash
cd desktop
npm install
npm run dev
```

### Yêu cầu hệ thống phụ trợ:
- **Poppler**: Cần thiết cho `pdf2image` trên backend. (Windows: tải binary và set `POPPLER_PATH`).
- **Tesseract OCR**: Cài đặt engine tesseract nếu dùng tính năng OCR.

## 📁 Cấu trúc Thư mục Chính

```
prynx/
├── desktop/                 # Tauri App (React UI + Rust backend)
│   ├── src/
│   │   ├── components/      # UI components (Imposition, Preprocess, 3D Flipbook)
│   │   ├── lib/             # Core logic (pdfImposer, VirtualMap)
│   │   └── ...
├── backend/                 # Xử lý hình ảnh, OCR, PDF Diff
│   └── app/
│       ├── api/routes/      # API endpoints (vd: imposition.py, cực khủng)
│       ├── core/            # OCR engine, PDF manipulation
│       ├── workers/         # Celery tasks (nup_process_chunk)
│       └── ...
├── data/, results/, uploads/# Thư mục chứa dữ liệu runtime
└── ...
```
