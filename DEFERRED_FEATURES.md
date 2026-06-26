# Tính năng tạm ẨN — phát triển lại sau

> Ghi lại các tính năng đã **ẩn khỏi UI** (không xoá code) do chưa đạt chất lượng / có rủi ro.
> Bật lại = bỏ comment entry tương ứng trong `desktop/src/lib/toolRegistry.ts` (TOOL_REGISTRY)
> sau khi đã khắc phục nguyên nhân ghi dưới đây.

---

## 1. OCR Searchable PDF — ẩn 2026-06-26

**Trạng thái:** Ẩn khỏi catalog (`TOOL_REGISTRY` entry OCR bị comment). Backend + component vẫn còn.

**Lý do (audit verify-to-ground-truth):**
- Lớp text ẩn nhúng qua `insert_text(render_mode=3)` (`backend/app/workers/pdf_ops.py`) encode bằng
  `.encode('latin-1', errors='replace')` + font base-14 **Helvetica** (WinAnsi).
- latin-1/Helvetica KHÔNG chứa ký tự tiếng Việt → mọi chữ có dấu (ế, ệ, ơ, ữ...) thành `?`.
  Đã chạy chứng minh: `"Tiếng Việt".encode('latin-1','replace')` → `?`.
- Hệ quả: **Ctrl+F / bôi đen / copy tiếng Việt KHÔNG hoạt động** (chỉ đúng cho English/ASCII).
  Đây trái với lời hứa của tool và ngôn ngữ mặc định `vie+eng`.

**Phần KHÔNG lỗi (đã verify, giữ nguyên):**
- Nhận diện Tesseract `vie+eng` OK (tessdata có `vie`+`eng`).
- Toạ độ đặt chữ ĐÚNG (có flip `y = page_height - point.y`, không lật dọc).
- Engine xử lý ảnh (denoise/threshold/deskew) hợp lý.

**Điều kiện bật lại:** nhúng **font TrueType Unicode** (đã có `backend/app/assets/fonts/DejaVuSans.ttf`)
dạng CID + `ToUnicode` CMap, encode text theo font đó thay cho latin-1/Helvetica — giới hạn phạm vi
ở đường `render_mode=3` để không đụng các chỗ chèn text khác.

**Code giữ lại:** `desktop/src/components/preprocess-tools/OcrTool.tsx`, route `/pdf-tools/ocr-searchable`,
`backend/app/core/ocr_engine.py` (`make_searchable_pdf`), routing `WORKSPACE_TOOL_PANEL`/`PREPROCESS_ROUTER_TOOLS`.

> Lưu ý: OCR vẫn được dùng NGẦM làm fallback cho QC (`/qc/extract-text`) và PDF Compare
> (so trang scan) — các đường đó KHÔNG bị ảnh hưởng (chỉ dùng text trong Python, không nhúng
> latin-1). Việc ẩn chỉ gỡ **tool OCR Searchable độc lập** khỏi menu.

---

## 2. Soát lỗi AI (AI QC) — đã ẩn từ trước

**Trạng thái:** Entry `ai_qc` trong `TOOL_REGISTRY` đã bị comment (xem ghi chú tại đó).
**Lý do:** rủi ro rò API key qua message lỗi/log, gửi nội dung file khách lên bên thứ ba
(Gemini) không cảnh báo, thiếu giới hạn kích thước/chi phí. Component `AiQcTab.tsx` + route `/qc/*` giữ lại.
