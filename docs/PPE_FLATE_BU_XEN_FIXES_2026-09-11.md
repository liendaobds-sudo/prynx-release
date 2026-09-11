# PPE: sửa báo lỗi nhầm sau bù xén vuông góc - 2026-09-11

Trạng thái: đã sửa nguồn, đạt kiểm thử tự động và probe native trên PDF thật.
Chưa nghiệm thu lại thao tác trong ứng dụng Tauri đang mở.

## Ca người dùng

- Công cụ Bù xén - Tạo đường cắt, chế độ Xén vuông góc.
- Bù xén 2 mm, lẹm mép 0,5 mm, cả bốn cạnh, nền Làm mượt vùng ảnh (`inpaint`).
- PDF trước xử lý xem được; sau xử lý trang đầu xem được nhưng trang sau báo
  `PPE_NATIVE_UNSUPPORTED`, `unsupported_feature`.
- File được cung cấp: `test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf`.
- SHA-256 nguồn: `e657eab1a222ca11ccbe01554f663405251bfb0952fb79eee5083f9c0ce06dd1`.
- Kết quả ứng dụng kiểm trực tiếp: `$TEMP/PrynX-dev/results/sticker_c2f67b48.pdf`;
  SHA-256 `d68eddc487aa394b3556a2b0c72bce89ddc4d55fc938d90e02b3ebe0a230985a`.
- Không ghi lại PDF gốc hay file kết quả ứng dụng. Cách mở file ban đầu
  (picker/drop) chưa được quan sát lại trong UI.

## Nguyên nhân được xác nhận

`print_engine/src/pdf.rs::strict_flate_decode` dùng `FlushDecompress::Finish`
ngay lần đầu trong khi buffer đầu ra chỉ dài 65.536 byte. Backend miniz của
flate2 yêu cầu toàn bộ dữ liệu sau giải nén vừa buffer khi dùng Finish lần đầu.
Với stream lớn hơn, decoder bị đánh dấu lỗi; helper rơi về recovery dù lopdf/qpdf
vẫn giải nén đầy đủ. Form nhìn thấy bị cộng `dropped_objects`; Viewer từ chối PNG.

Trước bù xén, content trang chính đi qua `get_page_content`. Bù xén gói artwork
thành Form XObject (`StickerEngine.process_pdf`, `as_form_xobject`), đưa stream
lớn vào helper trên. Lỗi nằm trong bộ đọc PPE, không phải thông báo lazy-image.

| Trang của file kết quả ứng dụng | Dữ liệu Form sau giải nén | Trước: `ink_unsound` | Sau |
|---|---:|---|---|
| 1 | 16.145 byte | false | false |
| 2 | 354.115 byte | true | false |
| 3 | 356.135 byte | true | false |
| 4 | 16.105 byte | false | false |

Trang 2/3 trước sửa cùng báo 9 lần `Do Form (không giải nén được content stream)`.
Probe biên xác nhận 65.536 byte đạt, 65.537 byte bị báo nhầm.

## Bản sửa và phạm vi

- Đổi riêng `Finish` sang `None` để giải nén nối tiếp nhiều block.
- Vẫn yêu cầu `StreamEnd`, đọc hết input và checksum hợp lệ; nhánh recovery giữ nguyên.
- Không đổi kích thước buffer, ngân sách RAM, màu, DPI, cấu hình bù xén hoặc policy Viewer.
- Thêm 3 regression trong `print_engine/tests/render_stream_decode.rs`: biên block
  với payload dễ/khó nén tới 2 MiB; stream lớn bị hỏng/thiếu/dư dữ liệu; Form lớn
  có nét vẽ sau nhiều block phải giữ đúng từng byte kẽm và không hạ soundness.

Các consumer đã rà: Form, soft mask, tiling Pattern, Type3, annotation appearance,
mesh shading; các consumer chỉ lấy bytes gồm Indexed lookup, Function type 0/4,
CIDToGIDMap/CMap và font program. Content trang chính, ảnh và ICC có đường đọc riêng.
Với filter chain/predictor, không suy rộng rằng mọi PDF chỉ đổi cờ cảnh báo;
byte parity bên dưới chỉ được kết luận trên các ca đã đo.

## Verify

- Cả 3 regression mới đỏ trước bản sửa, xanh sau bản sửa.
- `cargo test --offline --locked --test render_stream_decode`: 17 đạt.
- Toàn bộ `print_engine`: 720 đạt, 0 lỗi, 4 ignored có sẵn; không cập nhật golden.
- Tauri `cargo check --offline --locked --lib`: đạt, còn cảnh báo dead code có sẵn.
- Tauri `pdf_engine::render_worker::tests`: 31 đạt, 2 ignored cần runtime riêng.
- Build wheel native release: đạt; giải nén vào thư mục probe riêng, không thay
  package mà backend đang chạy sử dụng.
- Pytest trên wheel mới: `test_ppe_native.py` + `test_ppe_facade.py`: 78 đạt,
  1 cảnh báo Pydantic deprecation.
- Probe 96 DPI, FOGRA39/relative, overprint tắt, optional content View, annotation bật:
  4 trang PDF gốc + 4 trang kết quả ứng dụng + 4 trang tái tạo trực tiếp bằng engine
  hiện tại đều có `ink_unsound=false`; cả 12 bitmap RGB khớp SHA-256 trước/sau.
- Đã soi PNG của cả 4 trang kết quả ứng dụng. Đây là kiểm raster, không phải
  nghiệm thu thao tác UI Tauri.
- Probe trước/sau ở `_tmp_ppe_probe/before/summary.json` và
  `_tmp_ppe_probe/after/summary.json`; native build identity mới:
  `deb1b31bc1b688a09846ec133f12ff90026ba77dd73ae0021ad9af19eff4255d`.

Tauri check mặc định gặp DLL bị app giữ khóa. Check/test được chạy với overlay
chỉ trong tiến trình lệnh `TAURI_CONFIG={"bundle":{"resources":[]}}`, không copy
tài nguyên và không sửa cấu hình repo/EXE đang chạy. Một số cache Cargo cần quyền
ngoài sandbox. Không dừng tiến trình người dùng.

## Nhận bản sửa trong ứng dụng

EXE dev đang có trên đĩa vẫn là bản ngày 09-09, không phải EXE chứa bản sửa này.
Thoát PrynX rồi chạy lại `run_dev.bat` để rebuild/cài native và rebuild Tauri.
Fingerprint dev có theo dõi `print_engine/src`; không cần xoá cache hay sửa PDF.
Sau đó mở lại kết quả bù xén và kiểm trang 2/3. Chưa build installer/phát hành.
