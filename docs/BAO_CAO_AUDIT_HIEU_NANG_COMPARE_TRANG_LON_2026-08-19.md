# BÁO CÁO AUDIT HIỆU NĂNG COMPARE TRANG LỚN — 2026-08-19

**Phạm vi:** Đối chiếu PDF pixel-first, tập trung trang vượt 40 MP và tài liệu nhiều trang.
**Mục tiêu:** Giữ nguyên verdict/độ chính xác hiện tại, giảm RAM, tận dụng máy mạnh và không làm yếu khóa PDFium.
**Trạng thái:** Đã được duyệt và triển khai đủ Lô 0–4; kết quả verify/benchmark nằm
trong `HIEU_NANG_COMPARE_TRANG_LON_FIXES_2026-08-19.md`.

## 1. Kết luận điều hành

1. Nút cổ chai hiện tại không còn là phép so ảnh. Số đo PB-2 cho thấy sau các lô cũ, khoảng 97% sàn thời gian pipeline 250 trang nằm ở render PDFium tuần tự (`comparison_engine.py`), trong khi pixel diff đã dùng Rust/OpenCV và worker.
2. Guard `_MAX_COMPARE_PAGE_PIXELS = 40_000_000` trong `routes/compare.py` đang từ chối toàn bộ job trước khi engine chạy. Ca người dùng: 65,5 MP @150 DPI, backend đề xuất 117 DPI nhưng UI trước đây chỉ có 150/300.
3. Không được nâng thẳng 40 MP. Một cặp RGB 65,5 MP đã khoảng 375 MiB ảnh thô, chưa tính grayscale, mask, highlight, CMYK và cửa sổ nhiều worker.
4. Hướng an toàn là đổi 40 MP từ “trần từ chối” thành “ngưỡng chọn chiến lược”: trang nhỏ đi full-frame như hiện tại; trang lớn đi tile có overlap, verdict vẫn ở DPI người dùng chọn.
5. Muốn vượt trần tốc độ khoảng 1,6× @300 DPI của pipeline thread hiện tại, render phải chạy ở các process có PDFium riêng. Không chia sẻ document handle giữa thread/process.

## 2. Quick-win Lô 0 đã triển khai

### §CL.0A — DPI có đường thoát thực tế

- **Bằng chứng trước sửa:** `CompareTab.tsx` chỉ có 150/300 DPI; lỗi backend yêu cầu 117 DPI hoặc thấp hơn.
- **Thay đổi:** thêm 72/100/117 DPI, giữ 150/300 như cũ.
- **Mức:** P1 / S.

### §CL.0B — CMYK render trùng trang hai lần

- **Bằng chứng trước sửa:** mỗi trang CMYK gọi `render_page()` rồi `render_page_cmyk()` cho cả A và B; `render_page_cmyk()` lại raster PDFium rồi mới chuyển Pillow CMYK.
- **Thay đổi:** `PDFDocumentReader.render_page_bundle()` lấy RGB và CMYK từ cùng một bitmap; engine dùng bundle ở cả đường tuần tự và pipeline.
- **Số đo cùng corpus 8 trang @150 DPI:** render tách `0,570 s` → render gộp `0,358 s`, nhanh **1,59×**; SHA-256 RGB/CMYK trùng hoàn toàn.
- **Verify:** 56 test Compare/API đạt; typecheck + ESLint hẹp đạt; py_compile và diff-check đạt.
- **Mức:** P2 / S.

## 3. Phát hiện cần duyệt

### §CL.1 — [P1 / L] Guard 40 MP chặn sản phẩm thay vì chọn đường render

**Bằng chứng:** `backend/app/api/routes/compare.py:53,256`; job bị trả 413 trước khi tạo. Máy 32 GB/16 luồng vẫn chịu cùng trần cố định.
**Đề xuất:** giữ 40 MP làm ngưỡng full-frame mặc định; vượt ngưỡng chuyển sang tile. Chỉ từ chối khi admission RAM/đĩa cho cả tile cũng thất bại.

### §CL.2 — [P1 / L] Tile phải giữ bất biến căn chỉnh và morphology

**Bằng chứng:** `image_comparator.py:177` căn dịch toàn trang bằng phase correlation; `:207,305` morphology và `cluster_regions` có quan hệ qua biên. Chia tile ngây thơ sẽ căn mỗi tile khác nhau và cắt vùng lỗi ở mép.
**Đề xuất:** tính translation một lần trên preview giới hạn; render tile theo translation đó; overlap đủ cho kernel/merge-distance; bỏ vùng guard khi hợp nhất và cluster lại trên tọa độ toàn trang.

### §CL.3 — [P1 / M] Artifact full-page có thể tái tạo đỉnh RAM

**Bằng chứng:** `comparison_engine.py:981-997` vẫn encode PNG/GIF theo trang; `highlight_renderer.py:23-48` nhận ndarray toàn trang. Tiled verdict nhưng ghép highlight trong RAM sẽ làm mất lợi ích chính.
**Đề xuất:** dựng PNG highlight bằng staging disk-backed/streaming; GIF luôn dùng preview giới hạn 1.200 px như policy hiện tại. Giữ nguyên URL/schema kết quả để frontend không đổi hợp đồng.

### §CL.4 — [P1 / L] Render tuần tự là trần hiệu năng còn lại

**Bằng chứng:** PB-2 đo render chiếm khoảng 97% sàn tuần tự; `comparison_engine.py:785` chỉ đưa so ảnh sang ThreadPool, còn `pdf_processor.py:414` render dưới khóa PDFium process-wide.
**Đề xuất:** sau khi tile parity đạt, thêm ProcessPool cho nhánh 1:1 đã chốt cặp. Mỗi process mở A/B riêng, nhận số trang/tile, tự render+compare+encode; process chính chỉ commit DB theo thứ tự. Nhánh bình bài/căn trang đặc thù giữ đường hiện tại tới khi có benchmark riêng.

### §CL.5 — [P2 / M] Artifact sinh sớm làm chậm ca nhiều khác biệt

**Bằng chứng:** benchmark cũ 1.000 trang @150 DPI: 1/3 trang khác `61,4 s`, all-diff `216,1 s`, artifact all-diff khoảng `1,35 GiB`.
**Đề xuất sau tile:** thumbnail/metadata sinh ngay; PNG/GIF đầy đủ sinh theo nhu cầu khi người dùng mở trang. Đây là thay đổi hợp đồng UI/API nên tách lô và duyệt riêng, không trộn vào tile nền.

## 4. Lộ trình sửa đề xuất

### Lô 1 — Primitive render vùng, ≤3 file

- `pdf_processor.py`: API render vùng theo pixel, đóng page/bitmap trong `pdfium_guard`.
- Test parity full-render-crop ↔ region-render, gồm mép trang và kích thước không chia hết tile.
- Không đổi route/engine; hành vi sản phẩm chưa đổi.

### Lô 2 — Comparator tile parity, ≤3 file

- Global translation preview; overlap/guard; hợp nhất diff mask/region toàn trang.
- Test STRICT/NORMAL/LOOSE: nét 1 px qua biên, vùng khác nằm đúng góc tile, dịch 1–2 px, trang giống hoàn toàn.
- Golden/parity phải trùng full-frame dưới ngưỡng 40 MP trước khi cho trang lớn dùng.

### Lô 3 — Engine + guard chiến lược, ≤4 file

- `comparison_engine.py`: chọn full-frame/tile theo pixel và phần cứng; cancel/progress theo tile.
- `routes/compare.py`: 40 MP thành ngưỡng chuyển chiến lược, không còn 413 khi tile khả dụng.
- Artifact staging không giữ raster toàn trang trong RAM; giữ URL/schema hiện hành.
- Benchmark ca 65,5 MP @150 DPI và ca A4 cũ để chứng minh không hồi quy máy mạnh.

### Lô 4 — Render đa tiến trình, sau khi Lô 1–3 ổn định

- Chỉ nhánh 1:1 có cặp trang xác định trước.
- Worker theo policy RAM chuẩn; máy <8/<16 GB giảm, máy ≥16 GB dùng full CPU-1.
- Benchmark 150/300 DPI, 20/250/1.000 trang; parity DB/PNG/GIF SHA-256.

## 5. Gate nghiệm thu

- Trang 65,5 MP @150 DPI tạo job và hoàn tất, không hạ DPI, không OOM.
- Peak RAM không tăng tuyến tính theo diện tích trang; cancel giữa tile dọn sạch staging/artifact.
- Full-frame và tile cho cùng corpus dưới 40 MP phải có verdict, diff region và artifact parity đã giải thích được.
- A4 150/300 DPI không chậm quá 5% so baseline PB-2; máy 32 GB vẫn dùng full công suất.
- Không thay đổi PDF nguồn, schema kết quả hoặc snapshot/golden nếu chưa duyệt riêng.

## 6. Điểm chốt cần duyệt

Đề nghị duyệt **Lô 1 → Lô 2 → Lô 3** để giải quyết trang lớn trước. **Lô 4** chỉ triển khai sau benchmark tile, vì đa tiến trình tăng blast radius đóng gói/Nuitka và không cần thiết để tháo lỗi 40 MP ban đầu.
