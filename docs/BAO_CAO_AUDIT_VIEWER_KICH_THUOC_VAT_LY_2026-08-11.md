# Báo cáo audit Viewer — kích thước vật lý và độ nét 1:1

Ngày: 2026-08-11
Phạm vi: Zoom 100%, Fit Page/Fit Width, DPI màn hình, mật độ raster PDFium/PPE.
Không đổi: `pageDim`, point/mm của PDF, DIM, VDP, edit geometry và dữ liệu file.

## Tóm tắt điều hành

Máy kiểm tra dùng Dell U2422H, Windows scale 100%, DPR 1. API Windows trả Effective DPI = 96 nhưng Raw DPI = 92. Viewer cũ dùng cố định `96 / 72`, vì vậy tài liệu 15 cm được dựng khoảng 566,93 CSS px, tương đương khoảng 15,65 cm vật lý trên màn 92 PPI.

Lô A đã tách zoom UI khỏi zoom hiển thị: UI vẫn báo 100%, còn lớp layout/render dùng `physicalScale = rawDpi / (96 × DPR)`. Với màn hiện tại, hệ số là `92 / 96 = 0,958333`; tài liệu 15 cm còn khoảng 543,31 device px, đúng 15 cm theo Raw DPI.

Tuy nhiên audit phát hiện một chốt chất lượng còn thiếu: đường raster hiện ép sàn DPR 1 và PPE làm tròn lên nấc 12 DPI neo tại 96. Nếu chỉ sửa layout, bitmap 96 DPI vẫn bị WebView2 co xuống bề mặt 92 DPI khoảng 4,17%. Đây là một nguồn resampling có thể làm chữ/mảng mảnh trông nhiễu hoặc không “khóa nét” như Acrobat.

## Phát hiện có bằng chứng

| Mã | Mức | Bằng chứng | Kết luận | Trạng thái |
|---|---|---|---|---|
| §AS.1 | P1 | `desktop/src/components/AcrobatViewer.tsx:560` trước đây dùng `pageWidthPt * (96 / 72)` trực tiếp cho 100%; đo hệ thống: Raw DPI 92, DPR 1 | 100% cũ không phải kích thước vật lý trên màn hình này | Lô A đã sửa |
| §AS.2 | P1 | `desktop/src/components/workspace/renderZoomPolicy.ts` từng dùng `Math.max(dpr, ...)` | Sau hiệu chỉnh 92/96, compatibility bitmap vẫn có thể ở scale 1 rồi co 4,17% | Lô B đã sửa |
| §AS.3 | P1 | `desktop/src/hooks/viewer/useTileRenderer.ts` từng neo bucket 12 DPI tại 96 | PPE tại 100% vật lý 92 DPI vẫn xin 96 DPI; không map raster 1:1 với device pixel | Lô C đã sửa |
| §AS.4 | P2 | Raw DPI Windows là số nguyên và EDID có thể thiếu/sai | Auto-detect không bảo đảm sai số tuyệt đối bằng 0 trên mọi màn hình | Cần hiệu chỉnh tay theo monitor ở lô sau |

## Lô A — đã triển khai

1. Tauri lấy Raw DPI của đúng monitor chứa cửa sổ bằng `GetDpiForMonitor(MDT_RAW_DPI)`.
2. Frontend dùng một tracker dùng chung, tự cập nhật khi cửa sổ chuyển màn hình hoặc đổi scale.
3. `viewerZoom` tiếp tục là zoom user (100% = 1); `effectiveZoom` chỉ dùng cho layout/render/thước.
4. Fit Page/Fit Width tính theo kích thước đã hiệu chỉnh.
5. Fallback an toàn về 1 nếu hệ điều hành không trả Raw DPI; không đổi hợp đồng `pageDim`.

## Các lô đã được duyệt và triển khai

### Lô B — raster compatibility map 1:1 (≤4 file)

- Trạng thái: hoàn thành.
- Truyền `physicalDisplayScale` tới `LivePageFrame`.
- Đổi sàn raster từ `DPR` thành `DPR × physicalDisplayScale` nhưng vẫn giữ oversampling khi user thu nhỏ.
- Khóa test 15 cm @ 92 PPI và test chính sách render không co 96 → 92 ngoài ý muốn.

### Lô C — PPE bucket theo DPI vật lý (≤5 file)

- Trạng thái: hoàn thành.
- Neo lưới bucket 12 DPI tại Raw DPI của monitor thay vì luôn tại 96.
- 100% trên màn 92 PPI xin đúng 92 DPI; 125% xin nấc gần nhất không thấp hơn target.
- Giữ cache reuse và latest-wins hiện tại, không biến mọi mức wheel thành cache miss.

### Lô D — hiệu chỉnh tay theo monitor (tách riêng)

- Thước chuẩn 10 cm, user kéo đến khi khớp thước thật.
- Lưu override theo monitor ID; auto Raw DPI vẫn là mặc định/fallback.

## Verify hiện có

- Công thức 92/96, HiDPI và fallback: 4/4 test đạt.
- Lô B: 34/34 test policy/Viewer đạt; TypeScript đạt.
- Lô C: 110/110 test Viewer/PPE đạt; TypeScript đạt.
- Ca đa màn hình cùng tỷ lệ CSS nhưng khác DPR đã có regression test.
- Follow-up runtime: thước mount trước scroller nên lần mở đầu không có vạch; đã thêm tín hiệu `layoutReady`, 4/4 test lifecycle và 71/71 test nhóm Viewer liên quan đạt.
- Toàn frontend: 2.245 test đạt, 2 skip; 1 test `OutputPreviewLayout` timeout khi chạy song song nhưng chạy riêng đạt 1/1 trong 609 ms (không có hồi quy kết quả).
- TypeScript toàn desktop: đạt.
- `cargo fmt --check`: đạt.
- Tauri dev đã sinh binary sau thời điểm sửa source; `cargo check` độc lập bị file resource của phiên `run_dev` đang chạy giữ lock, không phải lỗi biên dịch code.

## Nghiệm thu runtime còn bắt buộc

1. Mở tài liệu có đoạn chuẩn 15 cm, đặt 100%, đo bằng thước thật.
2. Kiểm tra Fit Page/Fit Width, zoom/pan và thước trong Viewer.
3. Nếu có màn hình thứ hai, kéo cửa sổ sang màn khác và đo lại.
4. Sau Lô B–C, chụp cùng vùng ở 100% để so sánh chữ/mảng mảnh với Acrobat.
