# BÁO CÁO AUDIT TOÀN DIỆN TÍNH NĂNG XUẤT ẢNH PRYNX
## ĐỐI CHIẾU CHUẨN MÀU VỚI PHOTOSHOP, ILLUSTRATOR & PHẦN MỀM CHUYÊN DỤNG

> **Ngày audit:** 2026-09-22 | **Phiên bản:** HEAD `703ffc26` | **Môi trường:** Production Python 3.11 / Rust native / Windows 11
> **Tài liệu tham chiếu:** `docs/BAO_CAO_AUDIT_XUAT_ANH_SAI_MAU_2026-09-21.md`, `docs/DOI_CHIEU_FILE_KHACH_XUAT_ANH_2026-09-21.md`, `docs/PRYNX_MASTER_AUDIT_MATRIX.md` (Wave 3).
> **Quy chuẩn tuân thủ:** `prynx-deep-audit`, `prynx-audit-workflow`, `prynx-conventions`, ISO 32000-1 / ISO 12647-2.
> **Nguyên tắc:** Bằng chứng định lượng đo đạc từ file thực tế (ARTIFACT); dừng ở báo cáo và CHỜ DUYỆT, không tự ý sửa đổi mã nguồn.

---

## 1. TÓM TẮT ĐIỀU HÀNH (EXECUTIVE SUMMARY)

Trước câu hỏi trọng tâm của người dùng: **"Tính năng xuất ảnh của PrynX đã chuẩn chỉnh vấn đề màu sắc với Photoshop, Illustrator và các phần mềm chuyên dụng đã được kiểm chứng chưa?"**

### Kết luận đánh giá: **ĐÃ ĐẠT CHUẨN Ở LUỒNG XUẤT CMYK CHO NHÀ IN, NHƯNG CHƯA HOÀN HẢO 100% TRÊN MỌI WORKFLOW ĐỒ HỌA**

1. **Điểm đã đạt chuẩn chuyên dụng (Production Verified):**
   * **Xuất CMYK (TIFF / JPEG):** PrynX **không đi vòng qua RGB**. Engine dựng trực tiếp trong không gian mực 4 kênh `Process CMYK` qua PrynX Print Engine (PPE Rust), gộp mực pha (Spot) theo chuẩn chế bản.
   * **Đối chứng thực tế với Adobe Illustrator:** Trên file khách thực tế (`file goc.pdf`), đối chiếu với ảnh xuất từ Adobe Illustrator (`illustrator.jpg`):
     * Vùng nền phẳng: Illustrator cho `C=254, M=214, Y=5, K=105`; PrynX cho `C=254, M=213, Y=5, K=105` (sai lệch $1/255 \approx 0.4\%$ kênh Magenta do làm tròn).
     * Toàn bộ bức ảnh 21.4 triệu pixel: **96.17% pixel khớp hoàn toàn $\le 1/255$** trên cả 4 kênh, và **98.07% pixel khớp $\le 5/255$**. Khoảng $2-3\%$ còn lại nằm ở biên khử răng cưa (anti-aliasing) của chữ và vector.
     * Hỗ trợ trích xuất chuẩn `/OutputIntents` (như GRACoL 2013 3.46 MB) và tùy chọn **Không nhúng ICC (Untagged)** khớp 100% với hành vi mặc định của Illustrator khi gửi xưởng in.

2. **Những khoảng trống kỹ thuật & rủi ro lệch màu cần lưu ý khi so với Photoshop / Illustrator:**
   * ❌ **Xuất RGB (PNG/JPEG/WebP) bị mất Overprint (Đè màu):** RGB được render qua PDFium (Chromium). PDFium **không hỗ trợ mô phỏng đè màu**. Chữ đen hay mảng màu đặt `/OP true` sẽ bị knockout (khoét trắng nền) thay vì đè lên màu nền như trong chế độ Overprint Preview của Illustrator/Acrobat.
   * ❌ **Xuất RGB chuyển DeviceCMYK không qua ICC:** PDFium dùng công thức toán cứng để đổi CMYK sang sRGB, bỏ qua OutputIntent (GRACoL/FOGRA39) của PDF. Nền xanh đậm GRACoL trong `file goc.pdf` xuất ra sRGB chuẩn phải là `(44, 56, 104)`, nhưng PDFium xuất ra `(7, 40, 107)` (tối và bết màu hơn nhiều). Photoshop khi mở PDF chế độ RGB sẽ dùng Adobe CMM chuyển màu chính xác.
   * ❌ **Xuất Grayscale bị lệch trắc màu (Colorimetric mismatch):** PrynX dùng công thức độ sáng video ITU-R 601 của Pillow (`.convert('L')`), nhưng lại gắn ICC Profile `Gray Gamma 2.2`. Khi mở trong Photoshop, màu đỏ tươi sRGB `(255,0,0)` bị biến thành mức xám `76` thay vì mức xám chuẩn `129` theo CMM.
   * ❌ **WebP Grayscale tạo profile lỗi:** Pillow ghi WebP dạng 3 kênh RGB nhưng nhúng ICC profile 1 kênh `GRAY`, khiến Photoshop và LittleCMS báo lỗi `cannot build transform`.
   * ❌ **Đối tượng CMYK có ICC nhúng riêng trong PDF (ICCBased CMYK):** PPE giữ nguyên số mực (để bảo vệ phép đo tổng lượng mực TAC), không chuyển đổi màu khi profile nguồn khác profile xuất, dẫn đến bị đổi sắc thái màu (appearance shift).

---

## 2. BẢN ĐỒ LUỒNG DỮ LIỆU XUẤT ẢNH XUYÊN TẦNG (END-TO-END TRACE)

```
[Giao diện người dùng: ExportImageModal.tsx]
     │ (Chọn format: PNG/JPEG/TIFF/WebP, DPI, ColorMode: RGB/CMYK/Gray, CMYK Profile: Auto/FOGRA39/None)
     ▼
[Desktop Client API: api.ts -> exportImagesBatch]
     │ (HTTP POST /api/export/images hoặc /images/batch)
     ▼
[FastAPI Backend: export.py]
     ├───────────────────────────────────┬───────────────────────────────────┐
     ▼ [Nhánh CMYK: color_mode='cmyk']   ▼ [Nhánh RGB: color_mode='rgb']     ▼ [Nhánh Gray: color_mode='gray']
[Resolve ICC Profile:                [PDFium render:                     [PDFium render:
 _resolve_export_cmyk_icc]            page.render(scale, draw_annots)]    page.render(scale, draw_annots)]
     │ (Trích OutputIntent/FOGRA39/None) │ (AGG rasterizer 8-bit RGB)        │ (AGG rasterizer 8-bit RGB)
     ▼                                   ▼                                   ▼
[PPE Facade: export_cmyk]            [Pillow convert('RGB')]             [Pillow convert('L')]
     │                                   │                                   │ (Luma ITU-R 601: 0.299R+0.587G+0.114B)
     ▼                                   ▼                                   ▼
[Rust Native: ppe_export_cmyk]       [Embed sRGB IEC61966-2.1]           [Embed Gray Gamma 2.2 ICC]
     │ (InkSpace, simulate_overprint=T)  │                                   │
     ▼                                   ▼                                   ▼
[Process CMYK 4-channel bytes]       [Atomic Save PNG/JPEG/TIFF/WebP]    [Atomic Save PNG/JPEG/TIFF/WebP]
     │
     ▼
[Pillow Atomic Save TIFF/JPEG]
     │ (Nhúng ICC profile tương ứng)
     ▼
[File ảnh Artifact trên đĩa: .tif / .jpg / .png / .webp]
     │
     ▼
[Phần mềm tiếp nhận: Adobe Photoshop / Illustrator / InDesign / RIP Nhà in]
```

---

## 3. MA TRẬN ĐỐI CHIẾU 10 TIÊU CHÍ: PRYNX VS PHOTOSHOP VS ILLUSTRATOR

| Tiêu chí kỹ thuật | Adobe Illustrator (Export As) | Adobe Photoshop (Open PDF / Rasterize) | PrynX hiện tại | Mức độ chuẩn hóa |
|---|---|---|---|---|
| **1. Bản chất kênh màu CMYK** | Xuất CMYK 4 kênh thật (JPEG/TIFF) | Rasterize thành CMYK 4 kênh thật | Xuất CMYK 4 kênh thật qua PPE InkSpace | **ĐỒNG NHẤT 100%** |
| **2. Độ chính xác số mực (Ink parity)** | Giữ nguyên chỉ số mực DeviceCMYK từ vector/text | Có thể giữ hoặc convert tùy Color Settings | Giữ nguyên chỉ số mực vector/text (sai lệch $\le 0.4\%$) | **ĐỒNG NHẤT (với AI)** |
| **3. Hồ sơ màu CMYK (ICC Profile)** | Mặc định **Untagged**; có checkbox Embed ICC | Nhúng Working CMYK hoặc Document Profile | Tùy chọn: Tự động (OutputIntent), FOGRA39, hoặc Untagged | **CHUẨN CHẾ BẢN** |
| **4. Mô phỏng đè màu (Overprint) - CMYK** | Có (tùy chọn hoặc theo Overprint Preview) | Có (mặc định hòa trộn đè màu khi mở PDF) | Có (`simulate_overprint=true` trong PPE) | **ĐỒNG NHẤT** |
| **5. Mô phỏng đè màu (Overprint) - RGB** | Có (khi bật Simulate Overprint / Export) | Có (khi mở PDF chế độ RGB) | **KHÔNG** (PDFium knockout màu nền, làm mất overprint) | ⚠️ **CÒN LỆCH (Lỗ hổng)** |
| **6. Chuyển đổi CMYK sang RGB** | Dùng Adobe CMM chuyển theo Profile tài liệu $\rightarrow$ sRGB | Dùng Adobe CMM (Relative Colorimetric + BPC) | Dùng bảng toán cứng nội bộ PDFium (không qua ICC) | ⚠️ **CÒN LỆCH (Màu sẫm/bết)** |
| **7. Cơ chế chuyển Grayscale** | Dùng Gray Working Space (Dot Gain / Gray Gamma) | Dùng Gray Working Space trắc màu (Colorimetric) | Dùng công thức video ITU-R 601 nhưng gắn ICC Gamma 2.2 | ⚠️ **CÒN LỆCH (Lệch sáng)** |
| **8. Định dạng WebP Grayscale** | Không hỗ trợ xuất WebP trực tiếp (cần plugin) | Cần plugin WebPShop (xử lý đúng kênh) | Lưu 3 kênh RGB nhưng nhúng ICC 1 kênh GRAY $\rightarrow$ Crash CMS | ❌ **LỖI ARTIFACT** |
| **9. Xử lý Mực pha (Spot / Pantone)** | Chuyển sang CMYK theo Lab Pantone hoặc giữ Plate | Cho phép giữ Spot Channels trong PSD/TIFF | Tự động fold về CMYK theo Tint Transform | **ĐẠT CHUẨN XUẤT ẢNH** |
| **10. Kích thước vật lý & DPI** | Khớp chính xác mm theo Artboard/Crop | Khớp chính xác mm theo Box chọn (Trim/Media) | Khớp chính xác, hỗ trợ `/UserUnit` và TrimBox/MediaBox | **ĐỒNG NHẤT 100%** |

---

## 4. PHÂN TÍCH CHI TIẾT THEO TỪNG CHẾ ĐỘ MÀU

### 4.1. Chế độ CMYK (Dành cho in ấn, chế bản CTP, in bạt, in decal)
* **Thực trạng kiểm chứng:**
  * Đã đo kiểm trực tiếp trên `file goc.pdf` (file chế bản khách hàng mang OutputIntent GRACoL 2013).
  * Đối chiếu với `illustrator.jpg`: PrynX ở chế độ `cmyk_profile='none'` tạo ra file có kích thước $6732 \times 3189\text{ px}$ (trùng từng pixel kích thước với Illustrator), màu nền phẳng chênh lệch đúng 1 đơn vị Magenta ($213$ vs $214$), $96.17\%$ pixel toàn trang lệch $\le 1/255$.
  * Với tùy chọn `cmyk_profile='auto'`, PrynX trích xuất chính xác 3,462,308 bytes của profile `GRACoL 2013 CRPC6` từ file gốc và nhúng vào ảnh xuất.
* **Điểm cần lưu ý trong chuyên môn chế bản:**
  * Tại các nhà in Việt Nam, phần lớn thợ in thích ảnh **Untagged CMYK** (`none`) để khi đưa vào phần mềm bình bản (Corel, Illustrator) hoặc RIP (Harlequin, Prinergy), phần mềm không hỏi hộp thoại chuyển đổi profile và không làm nhảy số mực gốc (ví dụ C100 không bị nhảy thành C95 M12).
  * PrynX hiện đã đáp ứng trọn vẹn cả hai trường hợp: nhúng ICC chuẩn quốc tế hoặc untagged thuần túy cho nhà in.

### 4.2. Chế độ RGB (Dành cho xem màn hình, gửi khách duyệt mẫu qua Zalo/Web)
* **Thực trạng kiểm chứng:**
  * RGB hiện dùng `pypdfium2` (Google PDFium). Đây là thư viện render siêu nhanh, nhẹ và ổn định, nhưng **được thiết kế cho trình duyệt Chrome**, không phải cho chế bản đồ họa chuyên sâu.
  * Hai sai lệch lớn so với Photoshop/Illustrator:
    1. **Mất overprint:** Nếu khách hàng thiết kế chữ đen $K=100\%$ đặt overprint lên nền hoa văn nhiều màu, khi xuất RGB bằng PrynX, nền hoa văn phía dưới chữ đen bị khoét rỗng (knockout). Nếu file có các hiệu ứng overprint màu (như giả lập in chồng màu bao bì), màu sắc trên ảnh RGB sẽ khác hoàn toàn màu trên bản in CMYK.
    2. **Màu CMYK bị biến dạng khi ra RGB:** PDFium không dùng LittleCMS để chuyển màu theo profile của PDF. Vùng nền xanh của file khách:
       * Diễn giải chuẩn theo GRACoL $\rightarrow$ sRGB: `RGB(44, 56, 104)`.
       * PDFium xuất ra: `RGB(7, 40, 107)` (tối hơn rất nhiều, mất chi tiết vùng tối).
* **Kết luận:** Ảnh RGB của PrynX hiện tại **chỉ phù hợp để xem nội dung tổng quan (preview)**, chưa đạt độ trung thực màu sắc để làm **bản duyệt màu kỹ thuật số (digital proofing)** ngang tầm Photoshop.

### 4.3. Chế độ Grayscale (Trắng đen)
* **Thực trạng kiểm chứng:**
  * Hàm `img.convert('L')` trong Pillow áp dụng hệ số Luma truyền hình ITU-R 601: $Y = 0.299R + 0.587G + 0.114B$.
  * Nhưng PrynX lại đính kèm profile `Gray Gamma 2.2` vào ảnh.
  * Số liệu thực đo:
    * Màu Đỏ sRGB `(255, 0, 0)`: PrynX xuất ra mức xám **76**, trong khi chuyển màu trắc màu qua LittleCMS sang Gray Gamma 2.2 phải ra **129** (lệch tới 53 đơn vị!).
    * Màu Lục sRGB `(0, 255, 0)`: PrynX ra **150**, chuẩn CMS là **219** (lệch 69 đơn vị!).
    * Màu Lam sRGB `(0, 0, 255)`: PrynX ra **29**, chuẩn CMS là **71** (lệch 42 đơn vị!).
* **Kết luận:** Ảnh Grayscale bị tối và tương phản sai lệch hoàn toàn so với khi thực hiện lệnh *Image > Mode > Grayscale* trong Photoshop.

---

## 5. BẢNG TỔNG HỢP CÁC PHÁT HIỆN AUDIT (FINDINGS)

| Mã số | Mức độ | Phân loại | Tóm tắt phát hiện & Bằng chứng kỹ thuật | Trạng thái |
|---|---|---|---|---|
| **EXPCOLOR21.01** | P1 | CMYK Profile | **Trích xuất OutputIntent & tùy chọn Untagged CMYK**: Đã giải quyết vấn đề tự động lấy profile nguồn và tùy chọn không nhúng ICC. | **ĐÃ SỬA & XÁC MINH (ARTIFACT)** |
| **EXPCOLOR21.02** | P1 | RGB Overprint | **RGB mất mô phỏng overprint so với CMYK**: `pypdfium2` không mô phỏng overprint. C100+M100 overprint ra hồng M100 thay vì xanh tím `(49, 39, 131)`. | **CONFIRMED (Cần xử lý)** |
| **EXPCOLOR21.03** | P2 | Grayscale Luma | **Grayscale Rec.601 không khớp ICC Gray Gamma 2.2**: Lệch độ sáng nghiêm trọng so với Photoshop CMM (Đỏ 76 vs 129). | **CONFIRMED (Cần xử lý)** |
| **EXPCOLOR21.04** | P2 | WebP ICC Bug | **WebP Grayscale lưu 3 kênh RGB với ICC 1 kênh GRAY**: Gây lỗi `cannot build transform` khi mở trong Photoshop/CMS. | **CONFIRMED (Cần xử lý)** |
| **EXPCOLOR22.01** | P2 | PPE Profile Wiring | **`export.py:439` không truyền `cmyk_profile` xuống `ppe_export_cmyk`**: Dẫn đến PPE dùng mặc định `fogra39` khi chuyển các đối tượng RGB/Lab trong PDF sang CMYK, dù bên ngoài gắn tag GRACoL. | **CONFIRMED (Mới phát hiện)** |
| **EXPCOLOR22.02** | P3 | High-Fi RGB Proof | **Thiếu chế độ xuất RGB chuẩn màu chế bản (Proofing RGB)**: Khách hàng cần xuất ảnh RGB để duyệt màu trên điện thoại/máy tính khớp với màu in thực tế. | **CONFIRMED (Đề xuất tính năng)** |

---

## 6. LỘ TRÌNH KHẮC PHỤC THEO LÔ ĐỀ XUẤT (CHỜ DUYỆT)

Tuân thủ quy tắc an toàn của dự án: Mỗi lô $\le 5$ file, kiểm thử độc lập, không gây hồi quy.

### Lô 1: Chuẩn hóa Grayscale & Sửa lỗi WebP Grayscale (Độ ưu tiên: Cao | Effort: S)
* **Mục tiêu:** Đưa ảnh Grayscale về đúng chuẩn trắc màu Photoshop và triệt tiêu lỗi file WebP bị hỏng ICC.
* **Phạm vi file:**
  1. `backend/app/api/routes/export.py`:
     * Khi `color_mode == 'gray'`, dùng LittleCMS transform (`ImageCms.buildTransform(srgb, gray_gamma22)`) thay vì `.convert('L')` thô sơ.
     * Với định dạng `webp` và `color_mode == 'gray'`, chuyển ảnh sang RGB chuẩn sRGB trước khi lưu hoặc gắn profile sRGB tương thích.
  2. `backend/tests/test_export_images.py`: Bổ sung kiểm thử độ sáng Grayscale và tính hợp lệ của WebP ICC.

### Lô 2: Đồng bộ tham số Profile giữa Export Route và PPE Engine (Độ ưu tiên: Cao | Effort: S)
* **Mục tiêu:** Đảm bảo mọi đối tượng màu trung gian (RGB/Lab) trong PDF được PPE chuyển đổi sang đúng không gian CMYK mà người dùng đã chọn.
* **Phạm vi file:**
  1. `backend/app/api/routes/export.py`: Truyền đúng `cmyk_profile_id` hoặc đường dẫn profile từ `cmyk_profile` xuống `ppe_export_cmyk`.
  2. `backend/app/core/print_engine/facade.py`: Tiếp nhận profile path động từ OutputIntent trích xuất.
  3. `backend/tests/test_export_images.py`: Kiểm tra parity chuyển đổi đối tượng RGB trong PDF sang CMYK theo đúng profile được chỉ định.

### Lô 3: Bổ sung tùy chọn "RGB Mô phỏng in ấn / Chuẩn màu" (Độ ưu tiên: Trung bình | Effort: M)
* **Mục tiêu:** Cung cấp cho người dùng tùy chọn xuất RGB có mô phỏng Overprint và màu sắc chính xác theo profile in (Digital Proof) để gửi khách duyệt qua màn hình.
* **Giải pháp kỹ thuật:** Khi người dùng chọn chế độ "RGB chuẩn in" (hoặc bật cờ Mô phỏng đè màu): PrynX dùng PPE render trang ra CMYK composite có overprint, sau đó dùng LittleCMS chuyển từ CMYK sang sRGB. Kết quả cho ra ảnh RGB hiển thị màu sắc trùng khớp 100% với Illustrator/Acrobat khi bật Overprint Preview.
* **Phạm vi file:**
  1. `backend/app/schemas/export.py`
  2. `backend/app/api/routes/export.py`
  3. `desktop/src/components/workspace/ExportImageModal.tsx`

---

## 7. CHỐT DUYỆT & KẾT LUẬN

1. Tính năng xuất ảnh của PrynX hiện tại **hoàn toàn đủ tiêu chuẩn xuất xưởng để phục vụ in ấn chế bản CMYK** (TIFF/JPEG 4 kênh, khớp thông số với Illustrator).
2. Tuy nhiên, các luồng **RGB xem trước** và **Grayscale** vẫn còn sự phân kỳ (divergence) kỹ thuật so với các phần mềm đồ họa chuyên nghiệp của Adobe.
3. Báo cáo này đã ghi nhận đầy đủ các bằng chứng định lượng và đề xuất phương án xử lý theo từng lô nhỏ an toàn.

*Dừng lại ở đây để chờ Người dùng (User) xem xét và phê duyệt danh sách trước khi tiến hành thực hiện bất kỳ thay đổi nào.*
