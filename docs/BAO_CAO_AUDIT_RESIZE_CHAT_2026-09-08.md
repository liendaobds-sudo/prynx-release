# BÁO CÁO AUDIT — RESIZE ẢNH THU NHỎ BỊ MỜ

**Ngày:** 2026-09-08  
**Phạm vi:** ảnh JPG mở thành Working PDF → `PageResizerTool` → `runResize` → `/pdf-tools/resize` → `resize_pages_smart` / downsample native.  
**Fixture:** `D:\pdfcompare\test\Tem thuc pham sach Duc An.jpg`  
**Trạng thái:** Đã triển khai Lô 1–3 sau khi được duyệt; còn kiểm tay Tauri.

## 1. Kết luận điều hành

Ca này có hai nguyên nhân khác nhau:

1. **Giảm pixel là hành vi đang được yêu cầu bởi lựa chọn DPI.** Ảnh 5 × 5 cm ở
   300 DPI chỉ cần `591 × 591 px`; ở 600 DPI chỉ cần `1181 × 1181 px`. Ảnh nguồn
   có `5216 × 5216 px`, nên việc chọn 300/600 DPI bắt buộc loại bỏ phần lớn pixel
   nguồn. Nếu muốn giữ nguyên dữ liệu ảnh, phải chọn **Giữ nguyên** (`target_dpi=0`).
2. **Nhánh `raster` có thể làm giảm thêm chất lượng.** Nhánh này render toàn
   trang thành bitmap rồi ghi lại JPEG ở DPI đích; nó bỏ XObject ảnh gốc,
   ICC/CMYK và mọi vector/text. Sau bản sửa, `auto` luôn chọn `vector`; raster
   chỉ chạy khi người dùng chọn tường minh.

Vì vậy không có bằng chứng `api.ts` tự hạ DPI ngoài giá trị người dùng chọn. Có
bằng chứng rõ ràng rằng hợp đồng UI đang gọi “In nét cao” là **giới hạn đầu ra
600 DPI**, không phải “giữ chất lượng gốc”. Ngoài ra, fixture có DPI trong EXIF
nhưng không có JFIF; PrynX cố ý bỏ qua EXIF nên hiển thị khổ nguồn `184 × 184 cm`.

## 2. Metadata fixture và artifact kiểm chứng

Pillow đọc trực tiếp fixture:

| Thuộc tính | Giá trị |
|---|---:|
| Format / mode | JPEG / RGB |
| Pixel | `5216 × 5216` |
| Pillow `info['dpi']` | `288 × 288 DPI` (đến từ EXIF/Adobe metadata) |
| JFIF APP0 | Không có (`_read_jpeg_jfif_dpi(...) -> None`) |
| EXIF Orientation | `1` |
| ICC | `3144 byte`, sRGB |

Artifact do `desktop/src/lib/imageNormalizer.ts` tạo tại
`tmp/quality_audit/current_image_normalizer.pdf` có:

- `/MediaBox = 5216 × 5216 pt` = xấp xỉ `1840 × 1840 mm` = `184 × 184 cm`;
- Image XObject `5216 × 5216`, `/DCTDecode`, `/ICCBased /N 3`;
- không có `/Font`.

Khi chạy đúng backend với đích `50 × 50 mm` (tương đương `5 × 5 cm`), `fit`,
`apply_to=all`, kết quả đo được:

| Cấu hình | Khổ PDF | Pixel ảnh trong output | Dạng dữ liệu | Kích thước file |
|---|---:|---:|---|---:|
| `target_dpi=0`, `vector` | `50 × 50 mm` | `5216 × 5216` | JPEG DCT gốc trong Form | `3.02 MB` |
| `300`, `vector` | `50 × 50 mm` | `591 × 591` | Flate raw RGB + ICC | `0.34 MB` |
| `600`, `vector` | `50 × 50 mm` | `1181 × 1181` | Flate raw RGB + ICC | `1.14 MB` |
| `300`, `raster` | `≈50 × 50 mm` | `591 × 591` | JPEG DCT, RGB | `0.066 MB` |
| `600`, `raster` | `≈50 × 50 mm` | `1181 × 1181` | JPEG DCT, RGB | `0.17 MB` |

Ở cùng mức 300 DPI, giải mã Image XObject của hai bản `vector` và `raster` cho
PSNR khoảng **26,6 dB** (MSE `140,8`). Đây là sai khác đo được do nhánh raster
render/JPEG, không chỉ là khác metadata; bản vector giữ mẫu Flate nên không có
lần nén JPEG thứ hai.

`auto` trên fixture trả `vector` theo policy chất lượng mới; ảnh giữ `/ICCBased`.
Bản `1200/vector` trong probe
giữ nguyên `5216 × 5216`: downsample native đã tạo bản Flate lớn hơn JPEG nguồn
và code chủ động fallback về bản chỉ đổi hình học. Đây là hành vi an toàn cho
chất lượng nhưng làm cho “DPI đã chọn” không phải lúc nào cũng là DPI thực thi.

## 3. Luồng thực thi có bằng chứng

### §RZ.1 — DPI đích là trần pixel, không phải mức giữ chất lượng gốc (**P1, M**)

- `desktop/src/lib/processHandlers.ts:1177-1183` tính `targetDpi` từ lựa chọn
  người dùng; nếu để tự động và khổ nhỏ hơn thì tự đặt `300`.
- `desktop/src/lib/processHandlers.ts:1200-1203` buộc mọi ca có `targetDpi > 0`
  đi backend.
- `desktop/src/lib/api.ts:1369-1379` chuyển nguyên `target_dpi` và `mode` sang
  backend, không có tham số giữ pixel nguồn hay cảnh báo mật độ đầu ra.
- `backend/app/core/pdf_actions_native.py:386-415` tính DPI hiệu dụng theo
  kích thước đặt sau resize và hạ ảnh về `target_dpi`.

Với fixture, 50 mm ở 600 DPI = `round(50 / 25.4 × 600) = 1181 px`; đây đúng là
pixel output đo được. Ảnh nhìn mềm hơn khi phóng lớn là hệ quả của phép giảm
mẫu từ 5216 xuống 1182, không phải lỗi tính sai khổ.

### §RZ.2 — Nhánh `raster` raster hóa lại và JPEG hóa lần nữa (**P1, M; đã chặn auto**)

- `backend/app/workers/pdf_tools_engine.py:504-512` mô tả rõ nhánh raster: render
  mỗi trang ở DPI đích, raster hóa và mất vector/text/CMYK.
- `backend/app/workers/pdf_tools_engine.py:518-519` khóa canvas đúng số pixel
  theo `target_dpi`.
- `backend/app/workers/pdf_tools_engine.py:555-563` render bitmap rồi paste vào
  canvas; `:571-574` ghi lại PDF bằng PIL.
- `backend/app/workers/pdf_tools_engine.py:687-703` trước đây cho phép `auto`
  chọn raster khi tài liệu chỉ có ảnh RGB; hiện policy đã cố định `auto` ở
  `vector`, còn `mode=raster` vẫn là lựa chọn tường minh.

Trong nhánh này, ngay cả khi nguồn là JPEG chất lượng cao, ảnh bị giải mã →
render PDFium → resize → ghi lại DCT JPEG. Đây là đường có nguy cơ mờ cao nhất
và còn mất ICC/CMYK nếu tài liệu không được chặn trước.

### §RZ.3 — Nhánh `vector` vẫn giảm mẫu bằng LANCZOS và đổi JPEG thành Flate (**P1, M**)

- `backend/app/core/pdf_actions_native.py:393-415` quyết định kích thước mới từ
  DPI hiệu dụng sau khi Form đã scale.
- `backend/app/core/pdf_actions_native.py:495-503` thay nội dung Image XObject;
  `:541-553` dùng `Image.LANCZOS`, giải mã toàn ảnh rồi ghi lại bằng
  `/FlateDecode` raw.

Nhánh này giữ ICC và cấu trúc Form tốt hơn raster, nhưng vẫn là downsample thật;
chữ raster rất nhỏ/đường mảnh có thể mềm đi. Đây là lý do bản 600/vector vẫn
khác bản `target_dpi=0`, dù không raster hóa cả trang.

### §RZ.4 — DPI nguồn của fixture bị đọc sai do chỉ nhận JFIF (**P2, S**)

- `desktop/src/lib/imageNormalizer.ts:315-325` chỉ đọc JPEG APP0/JFIF, PNG
  `pHYs`, TIFF; comment `:318` nêu rõ bỏ qua EXIF.
- `desktop/src/lib/imageNormalizer.ts:351-379` trả `null` khi không có APP0/JFIF.
- `desktop/src/lib/imageNormalizer.ts:467-475` dùng fallback 72 DPI, nên
  `5216 px → 5216 pt → 184 cm`.
- Backend manifest lặp cùng chính sách tại
  `backend/app/workers/pdf_manifest_engine.py:208-268`.

Fixture có `info['dpi'] = 288` nhưng `_read_jpeg_jfif_dpi` trả `None`; đây là
bằng chứng giải thích vì sao UI hiển thị 184 cm. Nó không làm số pixel 5 cm ở
600 DPI tăng lên, nhưng làm sai khổ vật lý ban đầu và có thể khiến người dùng
chọn tỷ lệ/khổ đích dựa trên số đo sai.

### §RZ.5 — UI không nói rõ số pixel thực tế và cơ chế mất dữ liệu (**P2, S**)

- `desktop/src/components/preprocess-tools/PageResizerTool.tsx:356-380` đặt
  nhóm là “Giảm dung lượng theo khổ mới”; `600` chỉ có mô tả “In nét cao”.
- `desktop/src/components/preprocess-tools/PageResizerTool.tsx:384-418` không
  hiển thị công thức `50 mm @ 600 DPI = 1182 px`, không cảnh báo rằng vector/text
  có thể bị raster hóa ở mode `raster`, và không hiển thị DPI hiệu dụng trước/sau.

Người dùng dễ hiểu “độ phân giải cao” là bảo toàn độ nét nguồn, trong khi hợp
đồng hiện tại chỉ bảo đảm mật độ in tối đa của ảnh raster đầu ra.

### §RZ.6 — Fallback theo kích thước file làm DPI thực thi không nhất quán (**P2, S**)

- `backend/app/workers/pdf_tools_engine.py:713-722` chỉ nhận bản downsample khi
  file sau ghi nhỏ hơn bản geometry; nếu Flate raw lớn hơn JPEG nguồn thì trả bản
  giữ nguyên ảnh.

Probe `1200/vector` thực tế giữ `5216 × 5216`, trong khi `600/vector` hạ còn
`1182 × 1182`. Fallback này bảo vệ dung lượng/chất lượng, nhưng cần trả metadata
cho UI để người dùng biết DPI đã áp dụng hay đã giữ nguyên.

## 4. Những điểm đã kiểm tra và không phải nguyên nhân chính

- Khổ đích `50 × 50 mm` được ghi đúng (sai số dưới `0,01 mm` ở vector; raster PIL
  lệch khoảng `0,004 mm`). Không có bằng chứng lỗi quy đổi cm/mm trong backend.
- `api.ts` không sửa giá trị DPI; chỉ truyền nguyên request.
- Fixture không có `/Font`, nên không có lỗi font vector bị thay thế.
- Fixture có ICC sRGB và `auto` đi vector; sau bản sửa JPEG RGB không ICC cũng
  không bị raster âm thầm.
- `target_dpi=0` giữ Image XObject `5216 × 5216`, chứng minh pipeline có đường
  giữ nguyên dữ liệu khi người dùng tắt giảm mẫu.

## 5. Đề xuất sửa theo lô và trạng thái triển khai

### Lô 1 — Hợp đồng chất lượng và telemetry (≤5 file) — **đã triển khai**

1. `backend/app/workers/pdf_tools_engine.py`
2. `backend/app/core/pdf_actions_native.py`
3. `backend/app/api/routes/pdf_tools.py`
4. `backend/tests/test_resize_smart.py`

Mục tiêu: mặc định `auto` ưu tiên giữ XObject/vector; chỉ cho phép raster khi
người dùng xác nhận; trả `requested_dpi`, `applied_dpi`, pixel trước/sau, mode
thực thi và lý do fallback. Không tự hạ DPI trên máy mạnh.

### Lô 2 — DPI metadata ảnh và khổ vật lý (≤5 file) — **đã triển khai**

1. `desktop/src/lib/imageNormalizer.ts`
2. `backend/app/workers/pdf_manifest_engine.py`
3. test tương ứng cho JPEG EXIF/Adobe APP14 và trường hợp không có metadata.

Mục tiêu: thống nhất chính sách JFIF/EXIF; nếu vẫn cố ý bỏ EXIF thì phải hiển thị
“DPI không xác định — đang dùng 72” thay vì trình bày 184 cm như số đo chắc chắn.

### Lô 3 — UI minh bạch và regression (≤5 file) — **đã triển khai**

1. `desktop/src/components/preprocess-tools/PageResizerTool.tsx`
2. `desktop/src/lib/processHandlers.ts`
3. `desktop/src/lib/api.ts`
4. `desktop/src/components/preprocess-tools/PageResizerTool.test.ts`
5. `desktop/src/lib/processHandlers.test.ts`

Mục tiêu: hiển thị pixel dự kiến theo `W/H + DPI`, cảnh báo downsample/raster,
phân biệt “Giữ nguyên” với “600 DPI”, và thông báo khi backend fallback giữ ảnh
gốc.

## 6. Ma trận regression bắt buộc sau khi được duyệt

- Fixture thật: 50 mm ở `0/300/600 DPI`, đo page box, pixel XObject, ICC và render
  tại 300/600 DPI.
- Ảnh JPEG RGB không ICC: `auto` không được raster hóa âm thầm nếu người dùng
  chọn ưu tiên chất lượng.
- Ảnh JPEG có ICC, PNG alpha, CMYK/DeviceN: giữ màu/alpha và không mất SMask.
- `mode=vector` giữ Form/vector; `mode=raster` phải có cảnh báo mất vector.
- `target_dpi=1200` và ảnh JPEG nhỏ: kiểm metadata `applied_dpi` khi fallback
  vì file Flate lớn hơn DCT.
- JPEG có EXIF 288 DPI nhưng không JFIF: kiểm khổ vật lý và thông báo nguồn DPI.
- `apply_to` subset: trang ngoài phạm vi giữ nguyên pixel và cấu trúc.
- Test trên máy ≥16 GB và máy yếu: không thêm cap vô điều kiện; chỉ dùng
  admission/RAM-gating hiện có.

## 7. Chốt audit

Anh đã duyệt triển khai. Lô 1–3 đã hoàn tất; kết quả và file đã chạm được ghi
trong `docs/RESIZE_CHAT_FIXES_2026-09-08.md`. Bằng chứng tự động đạt mức 2
(backend/frontend regression + typecheck); còn kiểm tay Tauri mức 3 trên đúng
chuỗi mở JPG → Resize → xuất file.
