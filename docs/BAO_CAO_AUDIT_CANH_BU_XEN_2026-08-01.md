# Báo cáo audit chọn cạnh bù xén — 2026-08-01

## 1. Tóm tắt điều hành

Phạm vi audit: **Tạo đường cắt (bù xén) → Xén vuông góc → Cạnh bù xén**, từ UI,
payload API, chuẩn hóa danh sách cạnh, sinh màu bù xén, page box và khả năng dùng file
đầu ra ở tầng Bình bản.

Kết luận: phản ánh “bật cả 4 cạnh thì ổn, chọn riêng thì lỗi” **có cơ sở**. Audit tái
hiện được lỗi đầu ra ở các nhánh raster: khi cạnh **Dưới** không được chọn, artwork bị
clip hụt đúng một pixel nguồn ở đáy trang. Tại 300 DPI, dải giấy trắng đo được là
**0,0847 mm**. Khi bật đủ 4 cạnh, lớp màu bù xén dưới che mất khe này nên ca mặc định
trông đúng.

Ngoài lỗi trực tiếp trên, audit phát hiện thêm hai vấn đề hợp đồng: trang có `/Rotate`
được xử lý sai trong nhánh StickerEngine, và tầng Bình bản chỉ tự nhận được bleed đối
xứng nên không biểu diễn đúng file bù xén theo từng cạnh.

| Mã | Mức | Effort | Kết luận |
|---|---:|---:|---|
| §CBS.1 | P0 | S | Nhánh raster clip hụt 1 pixel ở cạnh dưới không bù xén |
| §CBS.2 | P0 | M | Trang có `/Rotate` bị mất xoay và ánh xạ sai cạnh |
| §CBS.3 | P1 | M | Bình bản không tự nhận đúng bleed bất đối xứng |
| §CBS.4 | P1 | S | Không có regression test nào cho `bleed_sides` |

Không sửa mã nguồn trong giai đoạn audit này. Báo cáo là chốt duyệt trước khi sửa.

## 2. Phạm vi và cách xác minh

### 2.1 Luồng đã đọc

1. UI và lưu cấu hình: `desktop/src/components/preprocess-tools/StickerTool.tsx`.
2. Form-data của nhánh Xén vuông góc: `bleed_sides` được gửi ở
   `StickerTool.tsx:391-393`.
3. API nhận nguyên chuỗi tại `backend/app/api/routes/pdf_tools.py:1386-1389`.
4. Chuẩn hóa về tuple `(trái, phải, dưới, trên)` tại
   `backend/app/core/bleed_sides.py:88-153`.
5. Hình học/pad/clip tại `backend/app/workers/sticker_engine.py`.
6. Nhánh Lật gương tại `backend/app/core/page_boxes.py:1190-1351`.
7. Tự nhận bleed ở `backend/app/api/routes/imposition.py:482-504` và tiêu thụ ở
   `desktop/src/components/imposition-tools/ImposerDashboard.tsx:682-713`.

### 2.2 Probe E2E

Dựng PDF 120×80 pt có bốn mép mang bốn màu riêng, bù xén 5 mm, chạy trực tiếp
`StickerEngine.process_pdf` ở 300 DPI với năm cấu hình: cả 4 cạnh, chỉ Trái, chỉ Phải,
chỉ Dưới, chỉ Trên. Render đầu ra ở 600 DPI để đo pixel và quy đổi vật lý.

Các mode đã kiểm:

- Kéo thẳng mép ảnh (`image`, nhánh vector).
- Làm mượt vùng ảnh (`inpaint`, nhánh raster).
- Theo quỹ đạo dải màu (`trajectory`, nhánh raster).
- Đổ màu trơn (`solid`, nhánh raster).
- Lật gương (`PageBoxesEngine.add_mirror_bleed`).

Kết quả hình học page box cho file không xoay là đúng: ví dụ chỉ bù 5 mm cạnh Dưới,
MediaBox từ 120×80 pt thành 120×94,173 pt và TrimBox là
`[0; 14,173; 120; 94,173]`.

Baseline tự động hiện tại:

```text
65 passed, 2 warnings in 23.67s
```

Lệnh test bao phủ `test_sticker_engine_e2e.py`, `test_mirror_bleed_origin.py` và
`test_sticker_page_canvas.py`. Bộ test xanh nhưng không có ca nào truyền
`bleed_sides`, vì vậy không phủ được lỗi người dùng báo.

## 3. Phát hiện

### §CBS.1 — P0 — Nhánh raster clip hụt một pixel ở cạnh dưới không bù xén

**Triệu chứng đã tái hiện.** Với `inpaint`, `trajectory` và `solid`, khi chỉ bật Trái,
Phải hoặc Trên, cạnh Dưới không được bù xuất hiện một dải trắng. Ở pipeline 300 DPI,
render đo được dải trắng **2 px tại 600 DPI = 0,0847 mm**, tương ứng đúng **1 pixel
nguồn 300 DPI**. Chọn riêng cạnh Dưới hoặc chọn đủ 4 cạnh thì lớp bleed dưới phủ kín,
nên không thấy khe.

| Mode | Chỉ Trái | Chỉ Phải | Chỉ Trên | Chỉ Dưới | Cả 4 |
|---|---:|---:|---:|---:|---:|
| Làm mượt | trắng 0,0847 mm ở đáy | trắng 0,0847 mm ở đáy | trắng 0,0847 mm ở đáy | đạt | đạt |
| Theo quỹ đạo | trắng 0,0847 mm ở đáy | trắng 0,0847 mm ở đáy | trắng 0,0847 mm ở đáy | đạt | đạt |
| Đổ màu trơn | trắng 0,0847 mm ở đáy | cùng đường raster | cùng đường raster | đạt | đạt |
| Kéo thẳng mép ảnh | đạt | đạt | đạt | đạt | đạt |
| Lật gương | đạt | đạt | đạt | đạt | đạt |

**Nguyên nhân gốc.** Nhánh raster:

1. Pad theo từng cạnh tại `sticker_engine.py:2904-2916`.
2. Dựng `sticker_footprint` từ contour của mask pixel tại `:3037-3045`.
3. Chuyển contour pixel thành clip PDF tại `:3364-3382` bằng
   `y = shift_y + (fp_h_px - py) / scale`.

Với mask kín H hàng, tọa độ tâm pixel cuối là `py = H - 1`; công thức hiện tại đặt
biên clip dưới cách mép thật `1 / scale`, không phải tại 0. Khi cạnh dưới có bleed,
`bleed_ring` nằm dưới artwork che khe; khi cạnh dưới tắt, không còn lớp màu ngoài mép
để che nên giấy trắng lộ ra. Đây là lỗi chuyển **mask pixel → biên hình học PDF**, không
phải lỗi parser tên cạnh.

**Hướng sửa đề xuất.** Với `rectangle_mode`, không trace lại hình chữ nhật full-page
qua OpenCV. Clip artwork trực tiếp bằng hình chữ nhật vật lý
`(exp_left + bite_left, exp_bottom + bite_bottom, width - bites, height - bites)` như
nhánh vector đang làm tại `:3347-3358`. Cách này loại bỏ sai số pixel và giữ vector.

### §CBS.2 — P0 — Trang có `/Rotate` bị mất xoay và ánh xạ sai cạnh

**Bằng chứng.** Probe nguồn MediaBox 120×80 pt, `/Rotate=90`, hiển thị thực tế
80×120 pt. Sau khi chạy nhánh Kéo thẳng mép ảnh:

- đầu ra bị đặt `/Rotate=0`;
- bật cả 4 cạnh cho khổ 148,346×108,347 pt, trong khi khổ hiển thị đúng phải là
  108,347×148,346 pt;
- màu các mép bị đổi hướng và cạnh phải có vùng trắng.

`StickerEngine` không có bước canonicalize `/Rotate`; tìm kiếm trong file chỉ thấy cờ
`-dAutoRotatePages=/None` của renderer (`sticker_engine.py:638-646`). Trong khi đó,
nhánh Lật gương đã có `_canonicalize_rotated_page_for_mirror` và test 90/180/270 độ ở
`test_mirror_bleed_origin.py`.

Lỗi này không chỉ riêng lựa chọn cạnh, nhưng bù 4 cạnh đối xứng có thể che một phần sai
ánh xạ; chọn một cạnh làm sai hướng lộ rõ hơn.

**Hướng sửa đề xuất.** Chuẩn hóa trang xoay trước khi cả pikepdf Form XObject và
PDFium/raster cùng đọc trang, hoặc giữ `/Rotate` và ánh xạ lựa chọn cạnh từ hệ hiển thị
về hệ page-space. Không sửa riêng tên `top/bottom` sau cùng vì artwork, CropBox,
TrimBox và raster phải dùng cùng một hệ tọa độ.

### §CBS.3 — P1 — Bình bản không tự nhận đúng bleed bất đối xứng

**Bằng chứng.** File đầu ra đã mã hóa đúng vị trí thành phẩm bằng TrimBox lệch trong
MediaBox. Tuy nhiên `/api/imposition/pdf-meta` chỉ tính:

```text
bx = (MediaBox.width  - TrimBox.width)  / 2
by = (MediaBox.height - TrimBox.height) / 2
```

tại `backend/app/api/routes/imposition.py:493-502`, rồi chỉ nhận khi cả `bx` và `by`
dương và gần bằng nhau.

Hệ quả:

- chỉ bù một cạnh ngang/dọc 5 mm → một trục bằng 0 → `detected_bleed_mm = 0`;
- bù hai cạnh kề, mỗi cạnh 5 mm → chênh tổng mỗi trục là 5 mm, phép chia 2 báo sai
  thành 2,5 mm;
- UI chỉ nhận một số scalar tại `ImposerDashboard.tsx:707-709`, không có cấu trúc bốn
  inset để bảo toàn bleed bất đối xứng.

Sticker/CNC đang bỏ qua auto-fill này (`ImposerDashboard.tsx:687`), nên phạm vi ảnh
hưởng trực tiếp là các mode Bình bản khác và mọi consumer tiếp tục giả định bleed đối
xứng. Người dùng có thể sửa tay một phần, nhưng một scalar vẫn không mô tả được bốn
cạnh khác nhau.

**Hướng sửa đề xuất.** Bổ sung metadata bốn inset
`left/right/bottom/top = TrimBox so với MediaBox`, giữ scalar cũ chỉ khi bốn inset đối
xứng. Các consumer không hỗ trợ bất đối xứng phải cảnh báo rõ, không tự chia đôi.

### §CBS.4 — P1 — Không có regression test cho lựa chọn cạnh

`rg "bleed_sides|bleedSides" backend/tests` không trả về ca test backend nào. Test UI
cũng chưa khóa payload và trạng thái bốn nút. Vì vậy 65 test liên quan đều xanh dù
§CBS.1 và §CBS.2 còn tồn tại.

Ma trận tối thiểu cần khóa:

1. 5 cấu hình cạnh: all, left, right, bottom, top.
2. 4 mode sinh màu: image, inpaint, trajectory, solid; mirror test riêng.
3. Box: kích thước Media/Crop, bốn inset TrimBox.
4. Pixel oracle: cạnh bật có mực; cạnh tắt giữ nguyên artwork đến sát biên, không trắng.
5. CropBox gốc khác 0.
6. `/Rotate` 0/90/180/270.
7. Recipe cũ thiếu field vẫn về cả 4 cạnh; recipe mới phát lại đúng mask cạnh.

## 4. Những phần đang đúng

- UI chặn trạng thái 0 cạnh và mặc định tương thích ngược về cả 4 cạnh
  (`StickerTool.tsx:169-188`, `:293-301`).
- Payload Xén vuông góc gửi đúng danh sách cạnh; Bế tem nhãn vẫn gửi `all`
  (`StickerTool.tsx:391-393`).
- Bộ chuẩn hóa dùng một thứ tự duy nhất `(left, right, bottom, top)` và hỗ trợ payload
  cũ (`bleed_sides.py`).
- Hình học MediaBox/TrimBox cho trang không xoay và CropBox gốc khác 0 đạt trong probe.
- Nhánh Kéo thẳng mép ảnh (vector) và Lật gương hoạt động đúng với bốn ca một cạnh trên
  file không xoay.
- Recipe đã ghi và phát lại `bleedSides`; recipe cũ thiếu field về cả 4 cạnh.

## 5. Thứ tự sửa đề xuất

### Lô A — Chặn lỗi đầu ra người dùng đang gặp (2 file)

1. `backend/app/workers/sticker_engine.py`: rectangle raster dùng clip hình chữ nhật
   vật lý, không trace full-page mask thành contour.
2. `backend/tests/test_sticker_engine_e2e.py`: thêm ma trận mode × cạnh, box oracle và
   pixel oracle ở 300 DPI.

Verify: pytest riêng file E2E, sau đó ba file baseline đã chạy trong audit; kiểm tay
trên PDF người dùng với chỉ Dưới, chỉ Trên và Trái+Phải.

### Lô B — Trang xoay (tối đa 3 file)

1. Chuẩn hóa/ánh xạ `/Rotate` dùng chung cho StickerEngine.
2. Test 90/180/270 độ với màu bốn mép và lựa chọn từng cạnh.
3. Nếu tách helper dùng chung, giữ thay đổi trong `page_boxes.py`/module nhẹ liên quan.

Verify: pixel oracle hướng cạnh + Media/Crop/TrimBox + mở runtime.

### Lô C — Hợp đồng bleed bất đối xứng sang Bình bản (tối đa 4 file)

1. Backend trả bốn inset thật từ page box.
2. Frontend chỉ auto-fill scalar khi đối xứng; trường hợp bất đối xứng hiển thị cảnh
   báo hoặc truyền cấu trúc cạnh nếu mode hỗ trợ.
3. Test API metadata và test UI auto-detect.

Lô C cần chốt sản phẩm trước: các mode Bình bản sẽ **hỗ trợ bleed bất đối xứng thật**
hay chỉ cảnh báo và yêu cầu chuẩn hóa file.

## 6. Quick wins sau khi duyệt

1. Sửa §CBS.1 và thêm test cùng lô: ít file, đúng lỗi hiện tại, rủi ro thấp.
2. Bổ sung test mirror từng cạnh vì code đã hỗ trợ nhưng chưa khóa hồi quy.
3. Không sửa §CBS.3 bằng cách lấy `max` hoặc tiếp tục chia 2; hai cách đều tạo số đẹp
   nhưng sai vị trí TrimBox.

## 7. Giới hạn và proof gap

- Đã xác minh mức tĩnh và tự động bằng PDF tổng hợp; chưa thao tác lại đúng PDF thật
  của người dùng trong app desktop vì request chưa cung cấp file PDF đầu vào.
- Ảnh chụp UI xác nhận trạng thái chỉ bật cạnh Dưới, nhưng không chứa ảnh output nên
  không thể đối chiếu hình thái lỗi thực tế với §CBS.1.
- Worktree đang có nhiều thay đổi chưa commit từ các đợt khác. Audit chỉ đọc các thay
  đổi đó và thêm báo cáo này; không sửa hoặc hoàn tác file nguồn nào.

