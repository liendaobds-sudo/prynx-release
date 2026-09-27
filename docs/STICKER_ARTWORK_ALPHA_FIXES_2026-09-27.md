# Giữ chi tiết artwork Alpha khi bù xén — 27/09/2026

## Phạm vi

Người dùng báo trang 4 “NICE WORK” của Binder2 có hàng nghìn node clipping
ôm sát mảng màu và làm mất chi tiết. Đã tạo checkpoint `d251c80` theo yêu
cầu trước khi sửa; đây là baseline của lô này. Không sửa solver, số vòng,
dung sai, denoise của CUT, worker/memo hoặc frontend. Không commit/push lô
này, không build bộ cài, không cập nhật golden.

Lô 4 file: `backend/app/workers/sticker_engine.py`, test mới
`backend/tests/test_sticker_artwork_alpha_clip.py`, cập nhật một test về biểu
diễn bleed trong `test_sticker_engine_e2e.py`, và báo cáo này.

## Nguyên nhân đã xác minh

Ảnh gốc trang 4 có JPEG và SMask, không có path clip. Engine giữ nguyên các
byte đó nhưng thêm clip vector từ footprint đã qua threshold/denoise/lọc
chi tiết của dao. Footprint lại bị rasterize rồi trace thành polyline trước
lệnh PDF `W n`; bản baseline có 15 contour / 3.587 đoạn thẳng cho clip.

Chỉ việc giữ byte ảnh/SMask nguyên không bảo đảm phần nhìn thấy nguyên vẹn:
clip bổ sung có thể che những pixel còn nằm trong nguồn. Đối chứng tại
600 DPI: 28.802 pixel của artwork trang 4 có Alpha bị giảm bởi clip. Đây là
so artwork riêng tại cùng CTM/khổ trang, không tính màu bleed như nội dung
nguồn. Probe ban đầu cũng tìm thấy 2.398 pixel gần đục bị che hoàn toàn.

Pipeline CUT và clip artwork là hai nhánh: không cần ghi clip vector dày
đặc để xuất dao. Việc mất chi tiết đến từ mask hiển thị, không phải QR hay
memo vừa tối ưu. Clip nằm trong nhóm việc phụ khoảng 0,04 giây ở log trang4;
không gọi sửa mask là cách giải quyết 6–24 giây Simplify.

## §CLIP.ART — thay đổi

### Gate bảo toàn nguồn theo từng trang

Chỉ bỏ clip bổ sung khi có đủ bằng chứng:

- Chính **toàn trang nguồn** đã được PDFium render với nền trong suốt và
  trả Alpha thực tế. Cờ Alpha toàn tài liệu hay việc tìm thấy một Image
  có SMask không đủ (có thể còn nền trắng đục bên dưới).
- Không phải selection, xén chữ nhật, mask approved/alpha override, bóc nền
  thực sự, fallback tách nền hoặc page-box mask.
- Không yêu cầu lẹm mép: `edge_bite_mm=0`.

Trong nhánh này, artwork được vẽ bằng Form gốc + SMask gốc, không thêm
clip lấy từ hình học đã lọc. Bỏ nền chỉ là checkbox nhưng không thực sự
thay Alpha nguồn không tự làm mất quyền giữ artwork. Mask đã sửa/duyệt,
nền đục cần bóc và lẹm mép vẫn giữ nhánh mask có chủ đích.

### Tách lớp màu, giữ mối nối

- Bù màu đặc vốn nằm dưới artwork, giữ nguyên mask/màu/CTM và không thêm clip.
- Bù màu lấy mẫu (`image`, `trajectory`, `inpaint`) cần giữ bước xử lý quầng
  sáng ở mối nối đã có test. Chuyển toàn bộ xuống dưới sẽ tái tạo halo cũ.
- Giữ **toàn bộ bleed ring** ở dưới artwork; trên artwork chỉ còn lớp xử lý
  mí quanh footprint. Hai lớp dùng cùng RGB/CTM, khác SMask. Đảo Alpha thật
  bị lọc khỏi footprint CUT được bảo vệ khỏi lớp mí, kể cả biên bán trong
  suốt và miền nội suy một pixel quanh đảo.
- Không lấy `ring − seam` làm underlay: thử nghiệm đã phát hiện hai mask
  bổ sung nhau theo giá trị mẫu vẫn tạo khe sáng khi PDF nội suy/ghép opacity.
  Bản cuối dùng full ring dưới, có regression và đối chứng âm ở 600/1200 DPI.
- Nhãn component chỉ tính trên vùng ảnh nguồn, không cấp int32 cho padding
  bleed. Các mảng nhãn/mask tạm được nhả ngay sau khi dùng/nén.
- Không sửa mask/hình học đầu vào của CUT; chỉ thay clip/lớp hiển thị.

## Bằng chứng PDF

Corpus `test/Binder2.pdf`, SHA-256 giữ nguyên:
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.

Harness riêng `.tmp/clip-artwork-fix-20260927/verify.py` nạp module baseline
từ `git show d251c80` trong process thử, không rollback source. Đo artwork
với cùng CTM và page box, oracle là Form gốc không có clip sinh thêm; đọc
lại toàn bộ CUT từ PDF, không chỉ so số node. `_page_subset` và
`alpha_source_mode=True` giữ đúng nhánh nguồn Alpha; không tuyên bố đây là
thao tác Tauri hoặc cùng mọi cài đặt đã lưu của người dùng.

- **13/13 trang bù màu đặc:** toàn bộ lệnh/tọa độ CUT khớp baseline; byte ảnh
  và Alpha gốc giữ nguyên; artwork RGBA trong trang kết quả khớp oracle,
  không còn clip sinh thêm.
- Trang4 còn được đối chứng với bù lấy màu viền: CUT khớp, artwork riêng
  khớp oracle, original JPEG/SMask còn nguyên.
- Trang4 bù màu đặc: Alpha mất do clip **28.802 → 0 pixel** tại600 DPI.
  Đã soi lại cặp ảnh cành cây trước/sau, phần mép bị cắt bậc được phục hồi.
- Đã render/soi cả PDF màu lấy mẫu ở600 DPI: bản cuối không còn viền sáng
  của phương án mask bổ sung đầu tiên. Đây là QA ảnh, không nghiệm thu RIP
  hoặc máy in thực tế.
- Artifact chính: `evidence.json` (14ca:13solid+trang4image). Chốt lại riêng
  trang4 trên bản cuối: `final-seam/evidence.json` và PNG/PDF trước/sau.
- Kiểm thêm **ProcessPool thật đủ13trang** (`process-pool/binder-clip-after.pdf`):
  13/13 trang không có clip bổ sung, artwork RGBA khớp Form gốc, toàn bộ
  lệnh/tọa độ CUT khớp artifact cùng cấu hình trước lô này. Không dùng thời
  gian của lượt này làm benchmark vì chạy cùng bộ test hồi quy.

## Test

Test mới đỏ trên baseline ở4 ca artwork pixel, Binder2 trang4 và2ca đảo màu.
Các guard mask có chủ đích đã xanh trước sửa. Bản sửa còn được chặn bằng:

- Solid/image, bật/tắt bỏ nền; giữ đúng JPEG/Flate+SMask và RGBA artwork.
- Chi tiết màu nhỏ, Alpha mềm, denoise0/30/100; không tô đè đảo bị CUT lọc.
- File lẫn trang Alpha/trang nền đục; chứng nhận độc lập từng trang.
- Selection, rectangle, opaque background, mask approved/override, edge bite.
- Tọa độ/lệnh CUT trước/sau bypass clip khớp byte.
- Mối nối halo cũ vẫn đạt; test mới600/1200 DPI bắt khe Alpha do tách mask.

Một E2E cũ giả định chỉ có1ảnh bleed; cập nhật thành chính xác2lớp cho nhánh
Alpha đủ điều kiện và1lớp cho opaque. Vẫn kiểm tất cả RGB/kích thước giống
nhau và độ phủ/màu ở bốn tiếp tuyến sau compositing alpha, không bỏ oracle
chất lượng hoặc đổi snapshot để ép xanh.

Lượt hồi quy cuối: **418 passed, 0 failed, 0 skipped**, 248,63 giây. Gồm
engine E2E158, test Alpha artwork mới27, seam3 và classic preview/source/
tuning/AUTO/contract/parallel230. Không cộng các lượt hẹp trước đó vào tổng.
Chỉ còn3warning Pydantic/Starlette có sẵn. `py_compile` và
`git diff --check` phạm vi lô đạt. Không đổi TS/Rust nên không chạy
Vitest/tsc/Cargo cho lô này.

## Giới hạn và đánh đổi

- Đây là sửa clipping artwork, **không phải tối ưu solver**. Không lấy timing
  probe chạy chung lúc test làm benchmark tăng tốc. Hai stream RGB bleed
  trong nhánh lấy mẫu có cùng bytes nhưng là hai object thật với SMask khác;
  PDF có thể lớn hơn. Nhánh màu đặc thường nhẹ hơn do bỏ hàng nghìn lệnh clip.
- Artwork gốc không bị clip bổ sung; composite trong chế độ lấy màu viền
  vẫn có xử lý halo/mí có chủ đích. Không hứa mọi màu ở mối nối giống source.
  Guard đảo nhỏ áp theo component trên lưới render; không gọi nó là chứng
  minh bảo vệ mọi nhánh nhỏ nối với thân ở độ phân giải bất kỳ.
- Không đổi chính sách CropBox/TrimBox/Crop trang theo tem. Chi tiết nằm
  ngoài page box kết quả do người dùng crop/dao co âm là bài toán khác.
- Mask đã duyệt/chỉnh sửa không được âm thầm thay bằng Alpha gốc.
- Chưa thao tác trong Tauri/Illustrator hoặc chạy bản đóng gói. Backend đang
  mở phải nạp source mới trước khi người dùng thử lại.

Hash production khi chốt source:
`sticker_engine.py` — `E188EFCCCE3CEA5C038AD115ECD42E26988BEAA0AC5976158D886E93E68EB683`.
