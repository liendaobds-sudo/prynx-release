# 🖨️ PrynX — Hệ thống Tự động hóa Prepress & Bình trang

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

---

## 🛠️ Tech Stack

### Desktop App (Tauri v2)
| Layer | Công nghệ |
|-------|-----------|
| **Core** | Tauri v2 (Rust) + Vite |
| **UI** | React 19 + TypeScript + Tailwind CSS v4 |
| **State** | Zustand |
| **PDF & Render** | `pdf-lib`, `react-pdf`, Three.js, `react-pageflip` |
| **Native** | File System, Dialog, Process, Shell (Tauri plugins) |

### Backend (Python FastAPI)
| Layer | Công nghệ |
|-------|-----------|
| **Core** | Python 3.11 + FastAPI + SQLite (dev) |
| **Computer Vision** | OpenCV + scikit-image |
| **PDF Engine** | pypdfium2 (Apache 2.0), PikePDF, pdfplumber |
| **OCR** | Tesseract (tùy chọn) |
| **Color Management** | Ghostscript (CMYK separations) |

### Native Rust Modules
| Module | Vai trò |
|--------|---------|
| `native/` | `pdfcompare_native` — layout solver, fast diff, PDF operations |
| `imposition_core/` | Grid solver, shared between Tauri & Python |

---

## 🚀 Cài đặt Nhanh (One-Click)

### Cách 1: Script tự động (khuyên dùng)

```powershell
# Chạy với quyền Administrator
.\setup_dev_env.bat
```

Script sẽ tự động: kiểm tra → tải → cài đặt tất cả tools cần thiết → setup backend + desktop.

### Cách 2: Cài thủ công

#### Yêu cầu hệ thống

| Tool | Phiên bản | Download |
|------|-----------|----------|
| **Rust** | `>=1.88` | https://rustup.rs |
| **Node.js** | `^20.19.0 \|\| >=22.12.0` | https://nodejs.org |
| **Python** | 3.11 | https://python.org |
| **Ghostscript** | 10+ | https://ghostscript.com |
| **VS Build Tools** | 2022 | https://visualstudio.microsoft.com/visual-cpp-build-tools/ |

#### Bước 1: Setup Backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

#### Bước 2: Setup Desktop
```bash
cd desktop
npm install
```

#### Bước 3: Tạo file `.env`
```bash
# Copy từ template
copy .env.example .env

# Desktop — cần Supabase keys
# Tạo desktop/.env với nội dung:
#   VITE_SUPABASE_URL=<your-url>
#   VITE_SUPABASE_ANON_KEY=<your-key>
```

#### Bước 4: Chạy Development
```bash
# Terminal 1 — Backend
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8000

# Terminal 2 — Desktop (Tauri dev)
cd desktop
npm run dev
```

Hoặc dùng script có sẵn:
```bash
run_dev.bat
```

---

## 📁 Cấu trúc Thư mục

```
PrynX/
├── desktop/                 # Tauri v2 App
│   ├── src/                 # React UI (components, stores, lib)
│   └── src-tauri/           # Rust backend + Tauri config
│       ├── bin/pdfium.dll   # PDFium runtime for Tauri
│       └── binaries/        # Nuitka sidecar (built, gitignored)
│
├── backend/                 # Python FastAPI Backend
│   └── app/
│       ├── api/routes/      # REST endpoints
│       ├── core/            # Business logic (PDF, CV, OCR)
│       └── workers/         # Background processing
│
├── native/                  # Rust native module (pdfcompare_native)
│   ├── src/                 # Rust source (imposition, diff, render)
│   └── pdfium_lib/          # PDFium C library bindings
│
├── imposition_core/         # Shared Rust imposition library
│
├── scripts/                 # Utility & scratch scripts
├── docs/                    # Training docs & specs
│
├── build_production.ps1     # 🏭 Production build (Nuitka + Tauri)
├── setup_dev_env.bat        # 🔧 One-click dev environment setup
└── run_dev.bat              # ▶️ Start dev servers
```

---

## 🏭 Build Production

```powershell
# Đóng gói bản cài cho user (Nuitka sidecar + Tauri installer)
.\build_production.ps1
```

Quy trình: Python → Nuitka `.exe` → Tauri nhúng sidecar → `.msi` installer.
