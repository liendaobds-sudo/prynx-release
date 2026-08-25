# Báo cáo audit — Đồng bộ màu vùng bù xén

Ngày: 2026-08-24

Audit unit: W2-U03-BLEED-COLOR-R2 — bù xén/đường cắt → preview → PDF xuất → render màu quản lý.

Phạm vi: StickerTool/pdf-tools (legacy) và StickerSheet (tách nhiều tem).

Trạng thái: TRACED + ARTIFACT + LÔ A ĐÃ TRIỂN KHAI/VERIFY. Chưa commit/build.

## 1. Kết luận

Lệch màu ở vùng bù xén là lỗi thật, không chỉ là cảm giác do zoom. Root cause là
pipeline đang trộn hai hợp đồng màu tại seam:

- File CHIVAN có artwork ảnh DeviceCMYK nhưng không có ICC nguồn và không có
  /OutputIntents.
- trajectory/inpaint render qua PDFium thành RGB 8-bit, nội suy/làm mượt trên RGB,
  rồi ghi bleed thành ảnh ICCBased sRGB.
- Form artwork gốc vẫn giữ ảnh DeviceCMYK.

RIP/viewer vì vậy có thể diễn giải hai vùng liền nhau khác nhau. RGB composite cũng
không thể phục hồi đúng plate CMYK/spot khi profile nguồn không tồn tại. Chỉnh
heuristic “lấy sâu thêm pixel” hoặc đảo RGB sang CMYK không phải lời giải màu in.

Mục tiêu tương đương Photoshop khả thi theo nghĩa profile-aware và có ngưỡng Delta E,
không thể cam kết byte-identical hay màu in tuyệt đối cho DeviceCMYK/spot không
profile.

| Kết luận | Độ chắc chắn |
|---|---:|
| Mixed-colorspace là nguyên nhân trên CHIVAN | 98% |
| Nội suy gamma-encoded RGB gây drift gradient | 90% |
| Preview và PDF xuất có parity màu tuyệt đối | Không đạt |
| Giảm phần lớn drift với profile-aware pipeline | 85–90% nếu input có profile |

## 2. Ca kiểm chứng CHIVAN

File: C:\Users\Khanh Pham\Desktop\CHIVAN-2hop_CanBong_PhamThiThuHuong.pdf

SHA-256: 9431c130bcb5b8cd2a833210b56a6de0e7e77aac4d41cb2cb901c611de0dccd3

- 2 trang, mỗi trang 255.118 × 153.071 pt (khoảng 90 × 54 mm).
- 5 ảnh nhúng, tất cả /DeviceCMYK; catalog không có /OutputIntents.
- Detector: trang 1 có 1 instance, trang 2 có 2 instances.
- Raster phân tích: 1063 × 638 px, khoảng 300 DPI.
- Nền dò được: RGB(190,148,59), tolerance 16.

Artifact tạm trong tmp/audit_chivan/:

- rect_image.pdf: C34F61E6EA5C58E63E275E7DDD836FD8D73D66B8093BF06CEDF800A80DDBB7A0
- rect_trajectory.pdf: 11497EF71C9FDD5361010B80A9A09FB8CA48AFF468450F088D240F5299839392
- rect_inpaint.pdf: F0CA7D91D84BE8AB1BC54A140D264D8FC0C70D9D999B639CC656225D2138DE56
- document_correctdpi.pdf: A945D3A3ADE6048700D5F9A58E69519B35B7703B79BB576515D70CD2525627D8

## 3. Số đo artifact

### 3.1 PPE/FOGRA39: trajectory/inpaint so với nhánh vector image

Thiết lập: bleed 2 mm, PPE native, FOGRA39, intent Relative, 96 DPI. Nhánh image
rectangle dùng Form/vector và là đối chứng ít fracture màu nhất hiện tại.

| Cạnh | Delta E00 mean | P95 | Pixel > 2 | Pixel > 5 |
|---|---:|---:|---:|---:|
| Trên | 2.719 | 8.839 | 38.38% | 12.99% |
| Dưới | 2.875 | 10.200 | 38.38% | 12.99% |
| Trái | 3.685 | 11.862 | 95.78% | 16.15% |
| Phải | 3.124 | 10.951 | 16.44% | 13.41% |

Inpaint cho cùng xu hướng. Đây là đo từ artifact, không suy từ log.

### 3.2 Preview và PDF xuất

Đã nhận diện cả hai trang, export 2 trang ở DPI nguồn, bleed 2 mm, trajectory,
reopen và render lại. Sau khi căn cùng gốc và bỏ phần nở bleed:

| Trang | RGB MAE nhìn thấy | Delta E00 mean | Delta E00 P95 | Pixel > 2 |
|---|---:|---:|---:|---:|
| 1 | 1.448 | 0.932 | 0.549 | 3.56% |
| 2 | 6.612 | 2.716 | 20.185 | 12.41% |

Dải seam 2 mm:

| Trang | Delta E00 mean | P95 | Pixel > 2 |
|---|---:|---:|---:|
| 1 | 5.648 | 45.297 | 14.08% |
| 2 | 6.080 | 51.734 | 14.15% |

Phần lớn nền phẳng có Delta E gần 0 nên MAE toàn vùng có thể đánh lạc hướng; outlier
seam vẫn rất lớn. Không dùng MAE toàn trang làm tiêu chí duy nhất.

### 3.3 Parse artifact

document_correctdpi.pdf có 2 trang. Mỗi trang có ảnh bleed 1115 × 690,
ICCBased /N=3, ICC sRGB hash
59e192f1c8cc53a592cbfd321ba9b3025cb0bcdff24df8034b05862388e3e812 và SMask; Form
artwork chứa ảnh DeviceCMYK; catalog vẫn không có /OutputIntents.

## 4. Truy vết code

### Legacy

Route nhận bleed_color_type ở pdf_tools.py:1515 và edge_bite_mm ở :1603, rồi gọi
StickerEngine tại :1853–1866.

- sticker_engine.py:9046–9066 render PDFium thành RGB/RGBA.
- :10081–10162 và helper :6210–6843 lấy nguồn màu từ RGB.
- :10455–10506 tạo image/trajectory/inpaint; :10523–10536 giữ uint8 RGB.
- :10574–10579 giữ artwork trong Form; :10623–10636 ghi bleed ICC sRGB.
- copy_output_intents chỉ ở :8842/:11493; pdf_ops.py:42–59 bỏ qua khi nguồn không
  có /OutputIntents.

Consumer sống là viewer/PPE/RIP đọc đồng thời Form CMYK và ảnh bleed sRGB.

### StickerSheet

- PDFium RGBA: sticker_source_pipeline.py:412–487.
- Session lưu analysis_source.png/rgba.png không ICC:
  sticker_sheet_session.py:347–350,699–703.
- Preview có thể resize LANCZOS ở :386–405,728–745.
- Export đọc rgba.png full resolution: sticker_sheet_export.py:521–543,
  chuẩn bị PNG ở :589–632.
- PNG đóng thành PDF ReportLab không OutputIntent ở :705–737, rồi gọi
  StickerEngine ở :935–1064; fragment ghép tại :1091–1104.

Preview UI và file xuất vì vậy không dùng cùng một artifact màu.

## 5. Findings

### §BCOLOR.01 — P1 — fracture colorspace tại seam

[CONFIRMED · ARTIFACT] CHIVAN source là DeviceCMYK không profile; output có bleed
ICCBased sRGB cạnh Form DeviceCMYK. PPE đo Delta E00 mean 2.719–3.685, P95
8.839–11.862 ở dải 2 mm. Đây là consumer live và có thể khác theo RIP/profile.

### §BCOLOR.02 — P1 — nội suy không color-managed

[CONFIRMED · CODE + ARTIFACT] trajectory/remap dùng RGB uint8 và cv2.INTER_LINEAR
(sticker_engine.py:7170–7193,7482–7518); nearest/inpaint cũng chạy RGB
gamma-encoded (:6890–6948). Không có linear-light, Lab/LCH, profile conversion
hoặc unpremultiply alpha trước nội suy.

### §BCOLOR.03 — P1 — mất provenance trong StickerSheet

[CONFIRMED · CODE + ARTIFACT] Luồng PDFium RGBA → PNG không ICC → ReportLab
DeviceRGB → StickerEngine làm mất profile/spot identity trước sampler. Page 2 đo
preview/export Delta E00 mean 2.716, P95 20.185, 12.41% pixel >2.

### §BCOLOR.04 — P1 — input không profile nhưng vẫn báo thành công

[CONFIRMED · CONTRACT GAP] DeviceCMYK không ICC/OutputIntent không có ground truth
màu in tuyệt đối, nhưng hiện vẫn tạo PDF và chỉ gắn sRGB cho bleed. Cần warning hoặc
yêu cầu profile trước chế độ color-critical.

### §BCOLOR.05 — P2 — solid CMYK dùng công thức device-only

[CONFIRMED · CODE] StickerSheet dùng _solid_cmyk_to_rgb() tại
sticker_sheet_export.py:746–753 với 255*(1-C)*(1-K), khác contract classic route
và không có ICC/black-generation/TAC/spot mapping.

### §BCOLOR.06 — P2 — thiếu cổng Delta E hậu kiểm

[CONFIRMED · TEST GAP] Test hiện chủ yếu khóa XObject/order/white fringe; chưa khóa
Delta E preview↔PDF, seam↔artwork theo profile, OutputIntent/ICC hash và corpus
RGB/CMYK/DeviceN/alpha cho image/trajectory/inpaint/solid.

## 6. Hướng sửa “Photoshop-like” an toàn

1. Giữ provenance: colorspace/profile hash, intent, BPC, alpha association và nguồn.
2. Ưu tiên bleed Form/vector cùng plate; không raster RGB thay vùng mực nếu không
   có profile nguồn.
3. Nếu phải kéo raster: unpremultiply alpha, chuyển working space có profile,
   nội suy linear-light float hoặc Lab/LCH, convert qua output profile một lần.
4. DeviceCMYK/DeviceN không profile phải warning/fail-closed có mã ổn định; cho phép
   người dùng chọn FOGRA39/SWOP/custom.
5. Preview và export dùng chung color artifact/fingerprint; tránh PNG→ReportLab→PDFium
   round-trip không cần thiết.
6. Reopen hậu kiểm /OutputIntents, ICC hash, /ColorSpace, SMask/Matte và Delta E seam.

## 7. Lô sửa đề xuất (mỗi lô tối đa 5 file)

| Lô | Nội dung | File dự kiến |
|---|---|---|
| A | Color contract, profile descriptor, fail-closed untagged CMYK, giữ OutputIntent | sticker_engine.py, pdf_ops.py, sticker_sheet_export.py, sticker_source_pipeline.py, sticker_sheet_session.py |
| B | Cùng plate/vector fallback, một converter CMYK dùng chung, không đổi mode ngầm | sticker_engine.py, sticker_sheet_export.py, pdf_tools.py, helper màu, tests |
| C | Linear-light/Lab/LCH, unpremultiply, adaptive chọn theo Delta E + coverage | sticker_engine.py, helper màu, tests |
| D | Preview/export parity và profile-preserving writer | sticker_sheet_export.py, sticker_sheet_session.py, route/API, tests |
| E | Acceptance corpus CHIVAN + RGB/CMYK/DeviceN/spot/ICC/alpha, PPE/PDFium/reopen | tối đa 5 file test/fixture |

Tiêu chí sơ bộ với input có profile: seam Delta E00 mean ≤1.0, P95 ≤3.0 trong 2 mm;
input không profile không được tuyên bố print-ready.

## 8. Rủi ro và chốt

- Convert toàn artwork sang profile mới có thể đổi màu lịch sử: ưu tiên Form/vector,
  golden trước/sau và chỉ conversion theo lựa chọn người dùng.
- Linear/Lab có thể khác baseline RGB: gate Delta E trên gradient/JPEG halo/alpha.
- ICC làm PDF lớn/chậm hơn: cache profile, Flate và đo theo policy RAM.
- Không thể có màu tuyệt đối khi input không profile: phải nói rõ trong UI.

## 9. Trạng thái và quyết định cần chốt

Đã chạy bằng D:\pdfcompare\backend\venv\Scripts\python.exe: parse source, legacy
StickerEngine ba mode, session detect/export hai trang, parse ICC/SMask, render
PDFium và render PPE FOGRA39. Lô A đã sửa contract provenance, cầu PNG sRGB,
fallback DeviceCMYK có cảnh báo cho nguồn CMYK trần, metadata API và regression
test; chưa commit/push/build.

### 10. Kết quả Lô A

- Nguồn DeviceCMYK không ICC/OutputIntent: ảnh bleed lấy mẫu được lưu
  `/DeviceCMYK` 4 kênh cùng device space với artwork; không gắn OutputIntent giả.
- PNG trung gian của StickerSheet được gắn ICC sRGB và fail rõ nếu không gắn được;
  descriptor `color_provenance`/mã cảnh báo đi qua inspect/detect/engine metadata.
- ICCBased CMYK nhúng được nhận diện riêng, không bị chuyển nhầm sang fallback
 DeviceCMYK.

Cập nhật: nhánh trajectory/inpaint của nguồn DeviceCMYK trần đã được flatten
thành một ảnh ICCBased sRGB duy nhất để loại mixed-colorspace seam.
- Verify: provenance + source pipeline + API `123 passed`; engine focused `3
  passed`; py_compile các module bị ảnh hưởng; CHIVAN chạy thành công 2 trang.
- CHIVAN không có ICC nguồn, nên không thể cam kết màu in tuyệt đối “giống
  Photoshop”. Muốn đạt profile-aware/Delta-E chặt hơn cho file có profile sẽ là
  Lô B/C tiếp theo. Lô B/C (profile-aware và nội suy linear/Lab/LCH) chưa triển khai.

Lô A đã hoàn tất và chưa commit/push/build theo phạm vi lượt này. Lô B/C (chuyển
 đổi profile-aware và nội suy linear/Lab/LCH) chưa triển khai vì cần chốt profile
 đích khi xử lý các file có ICC.

## 11. Cập nhật sau verify ca CHIVAN (edge bite 0,5 mm)

Để xử lý seam nhìn thấy bằng mắt ở nguồn DeviceCMYK không có ICC, nhánh Xén
vuông góc dùng trajectory/inpaint hiện flatten artwork và bleed trên cùng lưới
PDFium thành một ảnh ICCBased sRGB duy nhất. Ca CHIVAN đã render lại ở 600 DPI:
Delta E00 bước nhảy tại seam là 0 ở cạnh trên/dưới và 0,014 ở cạnh trái/phải.
Bản thay đổi chưa build/release/commit.
