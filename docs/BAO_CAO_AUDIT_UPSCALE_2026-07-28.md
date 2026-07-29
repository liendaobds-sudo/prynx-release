# BÁO CÁO AUDIT TÍNH NĂNG UPSCALE

**Ngày audit:** 2026-07-28  
**Phạm vi:** giao diện Upscale, API FastAPI, engine Real-ESRGAN ONNX, đóng gói model và kiểm thử phát hành.  
**Trạng thái:** báo cáo chờ duyệt; chưa sửa engine trong đợt audit này.

## 1. Kết luận điều hành

Upscale của PrynX **có chạy AI thật**, không chỉ dùng phép nội suy để tăng số pixel. Benchmark cục bộ trên hai ảnh đồ họa của dự án cho thấy Real-ESRGAN cải thiện khoảng **1,5 dB PSNR** và **0,02 SSIM** so với Lanczos khi phục hồi ảnh đã bị thu nhỏ 4 lần.

Tuy nhiên, tính năng hiện **chưa đạt mức “upscale phục vụ chế bản/in ấn” và chưa thể so ngang công cụ thương mại**. Nguyên nhân không chỉ nằm ở model nhỏ, mà còn ở pipeline:

- ảnh có cạnh lớn hơn 2.000 px bị thu nhỏ âm thầm trước khi chạy AI, nên lựa chọn ×4 có thể thực tế chỉ là ×2, ×1, thậm chí làm ảnh nhỏ đi;
- chỉ có một model Real-ESRGAN loại “tiny” dùng chung cho ảnh chụp, chữ, logo và minh họa;
- pipeline ép về RGB 8-bit PNG và không giữ ICC, DPI, EXIF, CMYK hay độ sâu 16-bit;
- chế độ ×2 thực chất chạy AI ×4 rồi thu lại bằng canvas của trình duyệt;
- chưa có bộ kiểm thử chất lượng, kích thước, metadata hoặc smoke test model trong bản phát hành.

**Đánh giá sẵn sàng hiện tại:** dùng được ở mức tiện ích nhanh cho ảnh phổ thông nhỏ; **chưa sẵn sàng để quảng bá là phục hồi chi tiết chất lượng cao cho chế bản**.

## 2. Bằng chứng engine thực sự làm super-resolution

- API `/pdf-tools/upscale` gọi `backend/app/workers/realesrgan_engine.py`, chạy ONNX Runtime theo từng tile và tạo đầu ra ×4.
- Model được đóng gói là `realesr-general-x4v3.onnx`, dung lượng khoảng 4,87 MB.
- Script build dựng kiến trúc `SRVGGNetCompact` từ trọng số Real-ESRGAN chính thức.
- Route chạy trong threadpool và engine có fallback GPU DirectML → CPU; đây là các điểm triển khai đúng.
- Giao diện đã có thanh so sánh trước/sau và zoom, đủ để người dùng kiểm tra trực quan cơ bản.

Benchmark kiểm chứng nhanh, lấy ảnh gốc làm chuẩn, thu nhỏ 4 lần rồi phục hồi về kích thước gốc:

| Ảnh | Đầu vào thấp | Lanczos PSNR / SSIM | AI PSNR / SSIM | CPU |
|---|---:|---:|---:|---:|
| `auto_bottom.png` | 474 × 246 | 24,7475 / 0,925849 | **26,3428 / 0,945671** | 4,99 giây |
| `double_tray.png` | theo tỷ lệ ×1/4 | 23,5421 / 0,918884 | **25,0806 / 0,942677** | 3,94 giây |

Đây là kiểm chứng kỹ thuật hẹp trên hai ảnh đồ họa nội bộ, không thay thế benchmark đầy đủ cho ảnh chụp, chữ nhỏ, tram in, JPEG nhiễu và chân dung.

## 3. Phát hiện theo mức ưu tiên

### UP-01 — P1: Giới hạn 2.000 px làm sai hệ số upscale

**Bằng chứng:** `backend/app/api/routes/pdf_tools.py:1688-1693` luôn thu cạnh dài về tối đa 2.000 px trước khi gọi model ×4.

| Cạnh dài đầu vào | Đầu ra hiện tại | Hệ số thực |
|---:|---:|---:|
| 1.000 px | 4.000 px | ×4 |
| 4.000 px | 8.000 px | ×2 |
| 8.000 px | 8.000 px | ×1 |
| 12.000 px | 8.000 px | ×0,67 — ảnh bị nhỏ đi |

UI vẫn ghi ×4 và không cảnh báo. Đây là lỗi đúng/sai đầu ra, đồng thời vi phạm nguyên tắc phần cứng của PrynX vì hard-cap áp dụng vô điều kiện cho cả máy mạnh.

**Khuyến nghị:** bỏ việc thu nhỏ âm thầm; tính trước kích thước, RAM/VRAM và thời gian. Máy yếu có thể được đề xuất giảm hoặc chia tile nhỏ hơn, nhưng phải cho người dùng biết và không được đổi hệ số đã chọn.

**Công sức:** M.

### UP-02 — P1: Model duy nhất là bản nhỏ, không đủ cho nhiều loại ảnh in

Engine chỉ có `realesr-general-x4v3`. Tài liệu chính thức của Real-ESRGAN mô tả đây là model rất nhỏ, tiết kiệm bộ nhớ/thời gian nhưng khả năng deblur và denoise không mạnh. Chính upstream còn cung cấp model tổng quát lớn hơn, model minh họa/anime, điều chỉnh cường độ khử nhiễu và tăng cường khuôn mặt.

PrynX hiện không phân biệt:

- ảnh chụp và chân dung;
- chữ nhỏ, logo, line-art và đồ họa bao bì;
- JPEG nén mạnh, ảnh nhiễu, ảnh mờ;
- ảnh đã tốt cần giữ nguyên hạt/texture.

Do đó model có thể làm mịn chữ, tạo chi tiết giả hoặc xử lý thiếu mạnh tùy loại nguồn. Khoảng cách với công cụ thương mại nằm chủ yếu ở đây: nhiều model theo nội dung, kiểm soát denoise/deblur/texture, bảo vệ chữ và phục hồi khuôn mặt.

**Khuyến nghị:** xây ít nhất ba chế độ có ý nghĩa với PrynX: `Nhanh`, `Ảnh chụp chất lượng`, `Chữ & minh họa`; bổ sung điều chỉnh khử nhiễu và cảnh báo chi tiết do AI suy đoán. Máy ≥16 GB mặc định được dùng pipeline chất lượng; máy yếu mới ưu tiên model nhẹ.

**Công sức:** L.

### UP-03 — P1: Mất dữ liệu màu và metadata phục vụ in

**Bằng chứng:** `realesrgan_engine.py:169-172` chuyển ảnh sang RGB float 8-bit; `pdf_tools.py:1693` lưu PNG mới mà không truyền metadata.

Hậu quả:

- mất ICC profile và khả năng diễn giải màu nguồn;
- mất DPI/PPI, EXIF và thông tin định hướng;
- CMYK bị chuyển sang RGB không có quản lý màu;
- ảnh 16-bit bị hạ còn 8-bit;
- TIFF bị chuyển sớm sang PNG ở helper phía desktop;
- EXIF orientation chưa được chuẩn hóa trước khi EXIF bị bỏ, có nguy cơ ảnh điện thoại xoay sai.

Với ứng dụng chế bản, đây là lỗi nghiêm trọng hơn chênh lệch vài điểm sắc nét.

**Khuyến nghị:** chuẩn hóa orientation, giữ/nhúng ICC và DPI, thiết kế chuyển màu có quản lý, bảo toàn alpha; cảnh báo rõ với CMYK/16-bit nếu engine chưa thể xử lý nguyên trạng.

**Công sức:** M–L.

### UP-04 — P1: Chọn ×2 và thay đổi tùy chọn không phản ánh đúng kết quả

- `UpscaleTool.tsx:20-39,80-84`: ×2 luôn gọi model ×4 rồi giảm một nửa bằng canvas trình duyệt; metadata tiếp tục bị mất và chất lượng phụ thuộc bộ resample của WebView.
- `UpscaleTool.tsx:55`: item đã `success` bị bỏ qua. Nếu người dùng đổi ×4 sang ×2 hoặc ngược lại, kết quả cũ không bị vô hiệu hóa; nút lưu có thể lưu ảnh của cấu hình trước.

**Khuyến nghị:** gửi hệ số đích vào backend, resize hậu kỳ ở backend bằng thuật toán xác định hoặc dùng model ×2 thật; mọi thay đổi tùy chọn phải đánh dấu kết quả cũ là cần chạy lại.

**Công sức:** S–M.

### UP-05 — P1: Không có cổng kiểm thử chất lượng và phát hành

Không tìm thấy test riêng cho Upscale trong `backend/tests`; `run_release_qa.ps1` và `verify_installed_artifact.ps1` không kiểm tra model. Build chỉ xác nhận file ONNX tồn tại rồi đóng gói.

Đang thiếu:

- test kích thước đầu ra và hệ số thực;
- test ICC/DPI/alpha/orientation/CMYK/16-bit;
- smoke inference bằng model đã đóng gói;
- checksum và provenance của model;
- golden crops cho chữ nhỏ, line-art, ảnh chụp, da người, JPEG và tram;
- ngưỡng hồi quy PSNR/SSIM/LPIPS cùng kiểm tra mắt người.

**Khuyến nghị:** tạo corpus nhỏ có giấy phép rõ ràng, khóa baseline cho từng model và thêm smoke test vào QA release.

**Công sức:** M.

### UP-06 — P2: Tile padding 16 px có sai khác ở đường ghép

Thử nghiệm `auto_bottom.png` với tile 256 cho thấy padding 16 có sai khác tối đa 5 mức màu ở vùng ghép; padding 40 cho kết quả trùng với chạy toàn ảnh trong mẫu này. Upstream cũng cảnh báo xử lý theo tile có thể tạo block inconsistency.

**Khuyến nghị:** xác định receptive field phù hợp, nâng padding có kiểm chứng hoặc blend vùng chồng; thêm golden seam test.

**Công sức:** S.

### UP-07 — P2: Giới hạn hiện tại không ngăn được OOM khi đọc ảnh lớn

Route gọi `img.load()` trước khi thu về 2.000 px, nghĩa là ảnh giải nén cực lớn vẫn được nạp đầy vào RAM. Tile chỉ giảm bộ nhớ inference, không bảo vệ bước decode. Kích thước tile 512 cũng cố định, chưa điều chỉnh theo RAM/VRAM.

**Khuyến nghị:** kiểm tra pixel count trước decode đầy đủ, áp dụng giới hạn an toàn minh bạch, chọn tile theo hồ sơ phần cứng và cho phép hủy job.

**Công sức:** M.

### UP-08 — P2: Trải nghiệm batch thiếu hủy, tiến độ và thông tin đầu ra

- Batch chạy tuần tự, chỉ báo số item, không có tiến độ tile/job và không có nút hủy.
- Lỗi warmup bị bỏ qua bằng `catch(() => {})`, nên model hỏng chỉ lộ ra sau khi người dùng bấm chạy.
- UI không hiện kích thước pixel đầu ra, hệ số thực, DPI, model hoặc GPU/CPU.

**Khuyến nghị:** thêm hủy có kiểm soát, tiến độ theo ảnh/tile, dự báo kích thước và thời gian, trạng thái model/thiết bị; warmup thất bại phải hiện cảnh báo có thể xử lý.

**Công sức:** M.

### UP-09 — P2: Hợp đồng định dạng chưa nhất quán

- Bộ chọn nhận `.tif`, nhưng allowlist đường dẫn backend có nơi chỉ nhận `.tiff`.
- Helper có thể nhận GIF qua drag/drop nhưng backend chỉ lấy frame đầu rồi lưu PNG tĩnh.
- Tên đầu ra được dựng bằng cách cắt tên tại dấu chấm đầu tiên, có thể làm tên file không như mong đợi.

**Khuyến nghị:** thống nhất allowlist toàn pipeline, từ chối định dạng/animation không hỗ trợ bằng thông báo rõ và dùng API xử lý tên file chuẩn.

**Công sức:** S.

### UP-10 — P2: Nội dung UI đang hứa quá khả năng thực tế

Registry/i18n mô tả “phục hồi chi tiết” và “khử nhiễu mà không vỡ hạt”, trong khi model upstream thừa nhận năng lực deblur/denoise của biến thể tiny bị giới hạn và PrynX không có điều khiển bảo toàn hạt.

**Khuyến nghị:** trước khi có pipeline chất lượng, đổi nội dung thành mô tả thận trọng: AI cải thiện độ nét cảm nhận và có thể suy đoán chi tiết; luôn kiểm tra chữ/logo ở 100%.

**Công sức:** S.

### UP-11 — P2: Thiếu thông báo bản quyền và nguồn gốc model

`THIRD_PARTY_NOTICES.md` có ONNX Runtime/DirectML nhưng chưa thấy Real-ESRGAN và trọng số model. Real-ESRGAN dùng BSD-3-Clause, yêu cầu bản phân phối nhị phân tái hiện copyright, điều khoản và disclaimer trong tài liệu hoặc vật liệu đi kèm.

**Khuyến nghị:** bổ sung attribution/license, nguồn model, phiên bản/tag, checksum và mô tả quá trình chuyển `.pth` → `.onnx`.

**Công sức:** S.

## 4. So với chuẩn công cụ thương mại

Theo tài liệu chính thức của Topaz Photo hiện tại, Upscale thương mại không chỉ chọn hệ số. Nó có nhiều model theo chất lượng/nội dung, kích thước pixel hoặc cm/inch, DPI, giữ resolution nguồn, điều khiển denoise/deblur/compression/texture, bảo vệ chữ và phục hồi khuôn mặt. Giới hạn đầu ra cũng được công khai thay vì âm thầm đổi hệ số.

PrynX không cần sao chép toàn bộ. Lợi thế nên tập trung vào nhu cầu nhà in:

1. **Đúng kích thước và màu trước:** hệ số, DPI, ICC, CMYK và alpha phải đáng tin.
2. **Bảo vệ chữ/logo:** chế độ line-art/text thận trọng, so sánh ở 100%, cảnh báo chi tiết giả.
3. **Chất lượng theo phần cứng:** máy mạnh dùng model tốt; máy yếu dùng model nhanh hoặc tile nhỏ, không hard-cap toàn hệ thống.
4. **Kết quả tái lập:** cùng file và cấu hình phải cho cùng đầu ra ở dev/release; model có checksum và QA.

## 5. Lộ trình đề xuất

### Lô A — Sửa tính đúng đắn trước (ưu tiên phát hành)

1. Bỏ hard-cap 2.000 px âm thầm; đảm bảo đúng hệ số và hiện kích thước đầu ra dự kiến.
2. Xử lý ×2 ở backend và vô hiệu hóa kết quả khi đổi cấu hình.
3. Chuẩn hóa orientation, giữ ICC/DPI/alpha; cảnh báo CMYK/16-bit.
4. Thêm test hệ số, metadata, model smoke và release QA.
5. Bổ sung license/provenance/checksum của Real-ESRGAN.

### Lô B — Nâng chất lượng nhìn thấy

1. Giữ model hiện tại làm chế độ `Nhanh`.
2. Thêm model `Ảnh chụp chất lượng` và `Chữ & minh họa`, sau benchmark thực tế.
3. Thêm mức khử nhiễu/deblur có giới hạn và bảo vệ chữ/logo.
4. Chọn tile/padding theo phần cứng; thêm seam test.

### Lô C — Hoàn thiện sản phẩm

1. Hủy job, tiến độ, dự báo RAM/thời gian/dung lượng.
2. Corpus QA đại diện cho chế bản Việt Nam: chữ Việt nhỏ, logo, bao bì, tram, JPEG khách gửi, ảnh chân dung và sản phẩm.
3. Hiển thị model, thiết bị, kích thước, DPI và các cảnh báo chất lượng trong kết quả.

## 6. Tiêu chí chấp nhận tối thiểu

- ×2/×4 cho đúng kích thước với mọi ảnh trong giới hạn đã công bố; không thu nhỏ âm thầm.
- ICC, DPI, alpha và orientation qua vòng xử lý không bị mất/sai; CMYK/16-bit có chính sách rõ.
- Đổi bất kỳ tùy chọn nào đều buộc kết quả chạy lại.
- Bản release chạy smoke inference bằng đúng ONNX đã bundle và xác nhận checksum.
- Không có seam nhìn thấy ở crop 100–400% trong corpus chuẩn.
- Mỗi model có nhóm ảnh áp dụng, cảnh báo và baseline chất lượng riêng.
- Máy ≥16 GB không bị giảm chất lượng/hard-cap vô điều kiện.

## 7. Nguồn đối chiếu chính thức

- Real-ESRGAN repository và Model Zoo: https://github.com/xinntao/Real-ESRGAN
- Real-ESRGAN model zoo: https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md
- Real-ESRGAN paper: https://arxiv.org/abs/2107.10833
- Real-ESRGAN BSD-3-Clause license: https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE
- Topaz Photo — Upscale & Resize: https://docs.topazlabs.com/topaz-photo/enhancements/upscale-and-resize

