# In PDF (Ctrl+P) — PrynX

## Tổng quan

In native trên **Windows** qua PDFium → GDI HDC (không dùng `window.print()` WebView).

```
Ctrl+P / File → In…
  → tab handler → usePrintDialog
  → PrintDialog (UI kiểu Acrobat)
  → print_pdf_direct (Rust)
  → fallback PrintDlgW (print_pdf)
```

## Tab hỗ trợ

| Tool | In |
|------|-----|
| Bình bài / N-up / Tem bế / CNC | ✅ |
| Preflight, Combine, Dieline | ✅ |
| So sánh PDF | ✅ (in bản B nếu có, không thì A) |
| Khác | Toast hướng dẫn |

## Modal — tính năng

| Nhóm | Có |
|------|-----|
| Máy in + Properties / Advanced | ✅ |
| Số bản, Collate, Grayscale | ✅ |
| All / Current / Range | ✅ |
| Odd / Even / Reverse | ✅ |
| Scale: Fit / Actual / Shrink / Custom % | ✅ |
| Orientation Auto / Portrait / Landscape | ✅ |
| **Size** (1 trang/tờ) | ✅ |
| **Multiple** (2/4/6/9/16 trang/tờ) | ✅ |
| **Booklet** (saddle-stitch 2-up) | ✅ |
| **Poster** (tile C×R) | ✅ |
| Annotations on/off | ✅ |
| Preview page-on-paper | ✅ |
| Page Setup (orientation + lề driver) | ✅ |
| Tiến độ tờ in + Hủy job | ✅ |

**Duplex / khay / khổ A3:** mở **Thuộc tính…** (driver).

## Backend

- `print_layout.rs` — subset, reverse, multipage grid, booklet order, poster tiles (unit tests)
- `print.rs` — `print_pdf_direct` + `cancel_print_job` + event `print-progress`
- Flag hủy: `PRINT_CANCEL_FLAG` kiểm tra giữa các tờ

## Preview layout

Preview bên phải vẽ **composite tờ in** khớp backend (`printPreviewLayout.ts` ↔ `print_layout.rs`):

- Size: 1 trang / tờ  
- Multiple: lưới 2/4/6/9/16 với badge số trang  
- Booklet: 2-up + blank pad, điều hướng mặt trước/sau  
- Poster: từng mảnh tile (cột,hàng)  

## Giới hạn

- Chỉ **Windows**
- Fallback `print_pdf` (PrintDlgW) không mang đủ option advanced

## Kiểm thử nhanh

1. Mở PDF ở Bình bài → Ctrl+P → In 1 trang  
2. Multiple 4-up, Booklet 8 trang, Poster 2×2  
3. Odd pages + reverse  
4. File → In…  
5. Tab So sánh: upload 2 file → Ctrl+P  
6. Hủy giữa chừng (nếu job dài)  
