# Chuẩn bị scene và tái sử dụng tài liệu — R25.GPU.31

Người dùng duyệt triển khai bằng “tiến hành đi” sau đề xuất giữ phiên tài liệu,
scene, tài nguyên GPU và chuẩn bị theo nhu cầu. Không thay công cụ, profile màu
hoặc độ phân giải để tạo số đo nhanh giả. Áp dụng theo lô, kiểm trước/sau trên R01.

## Bằng chứng đầu vào

- Trace ngày 25/09: viewport mở khoảng 62 ms, `GPU_SCENE_READY page=1
  prepare_ms=3706`. Tổng này gồm cả IPC/compile/material/pipeline, chưa được tách.
- `scene_worker.rs::compile` tạo process mới cho mỗi yêu cầu. `run_stdio` đọc
  file và parse lại; không có phiên tài liệu dài hạn.
- `RetainedRenderer::new` tạo lại material ảnh, bảng ICC và pipeline trên mỗi
  scene mới. GPU context toàn ứng dụng đã được giữ, không cần tạo cơ chế thứ hai.
- Scene/renderer đang gắn vào viewport; quay lại trang không có cache độc lập.
- Benchmark cũ trên R01: compile khoảng 272 ms, wire decode khoảng 34 ms,
  chuẩn bị renderer khoảng 1,43 giây. Đây là benchmark cũ, không thay phép đo mới.

## Các lô đã duyệt

1. Tách timing và chốt baseline từ source hiện tại trong staging ngoài dev watcher.
2. Tái sử dụng bảng màu/pipeline theo đúng hợp đồng màu và GPU device. Giảm việc
   phải làm trước frame đầu; kiểm pixel trước/sau và nhóm/clip/spot/transparency.
3. Giữ worker tài liệu, scene và renderer theo file identity + document token +
   trang; lease viewport chỉ giữ camera/input. Không dùng revision IPC làm key
   nội dung. Hủy job lỗi thời, dọn khi đóng tài liệu, kiểm đồng thời nhiều tab.
4. Chốt ma trận cold/warm/quay lại trang/sửa tài liệu/hủy, áp source sau khi đã
   chuẩn bị và kiểm thử. Máy >=16 GiB không bị hard-cap tùy tiện; thu hồi cache
   theo vòng đời và áp lực bộ nhớ, không giảm chất lượng.

## Điều kiện kiểm chứng

- Cache hit không compile/material-upload lại; file/token thay đổi không hit cũ.
- Pixel sau tối ưu khớp baseline trên cùng scene/camera, gồm đảo chiều và pan.
- Thời gian first frame báo riêng với thời gian chuẩn bị; không coi ACK là hiện ảnh.
- Ghi rõ test tích hợp và runtime người dùng; không tuyên bố ngang Acrobat.

Bằng chứng/benchmark/source staging: `.tmp/gpu-scene-session-2026-09-25/`.

## Kết quả điều tra và thay đổi R25.GPU.31

- Baseline cùng source, R01 trang 1: chuyển ảnh/mipmap sang material chiếm
  1.174–2.073 ms; LUT ICC 296–607 ms. Parse khoảng 31 ms, compile 227 ms.
  Vì vậy chỉ cache parser không giải quyết phần chờ lớn nhất.
- Chuyển ảnh/mipmap theo các dải hàng độc lập, mỗi tác vụ có LCMS/InkSpace
  riêng. Không giảm kích thước ảnh, số kênh, grid ICC hay số mẫu mipmap.
- `RendererResources` giữ ICC/pipeline cùng hợp đồng màu và định danh GPU.
  Không dùng equality của `wgpu::Device` làm khóa: device từ hai Instance khác
  nhau có thể có cùng ID nội bộ. Test hai context độc lập đã bắt được lỗi này.
- Scene/material bất biến dùng chung; mỗi viewport có scratch, pool và trạng
  thái hủy riêng. Kiểm bằng hai viewport encode trước/submit sau, màu cyan và
  magenta không ghi đè lẫn nhau.
- Worker dùng protocol có độ dài từng message, giữ cấu trúc PDF đã parse.
  Cache trang phân biệt file identity, content token, trang, GPU và format;
  revision chỉ thuộc yêu cầu/view. Close lease tài liệu cuối dọn cache/worker.
- Material được dựng sau culling. Nếu material phát hiện cần PPE, bỏ toàn bộ
  command chưa submit, dùng PPE cho phần còn lại của lease; không đổi engine
  qua lại theo zoom. Ma trận ảnh được cập nhật sau quyết định fallback.
- Token scene frontend độc lập với `tile-refined`. Tile nét hơn không phải
  sửa PDF và không được phá scene đã chuẩn bị.
- Cache thu hồi theo RAM khả dụng và ngân sách VRAM động của Windows, không
  đặt số trang tối đa hoặc hạ chất lượng vô điều kiện trên máy mạnh.

### Lỗi bộ nhớ phát hiện khi kiểm chuyển trang

R01 trang 2 có 492 mask, 1.019 shading và 1.092 clip. Renderer cũ giữ kết quả
mọi mask đến cuối frame. Ở 1081×811, riêng 492 mặt phẳng mực/alpha/shape
đã cần khoảng 11,25 GiB, chưa kể bản sao driver, clip và resource khác.
Bài kiểm tra native đã gặp lỗi cấp phát. Đây là đường xử lý có sẵn, không phải
bằng chứng cho kết luận ban đầu rằng chạy typecheck cùng build gây hết RAM.

Đã bổ sung tính số lần dùng mask: pool tái sử dụng kết quả ngay sau invocation
cuối, lệnh ghi mới đứng sau composite trong cùng queue. Mask dùng chung vẫn
sống tới lần dùng cuối. Test 39 mask, gồm một mask dùng lại cuối trang, giữ
tối đa 2 kết quả đồng thời và kiểm pixel. Native chuyển trang 1→2→1 đã qua.

### Đo tích hợp native trong staging

File thực tế còn trên máy là
`C:\Users\Khanh Pham\Desktop\PDF\CMNM2026 - Giay moi_BLUE - in.pdf`,
SHA256 `95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184`.
Đường `_5e2846.pdf` được gửi trước đây không còn tồn tại ở vị trí cũ.

`native-session/timing.csv`, bản dev, 1081×811:

| Lượt | Nạp scene bên gọi đo | Vẽ frame đầu và chờ GPU |
|---|---:|---:|
| Trang 1 lần đầu | 971 ms | 612 ms |
| Trang 2 | 1.113 ms | 6.886 ms |
| Quay lại trang 1 | 3,3 ms | 305 ms |
| Gắn lại trang 1 | 1,6 ms | 294 ms |

Log bên trong cache tương ứng hai cache hit là 3,1/1,4 ms. Hai phạm vi đo
khác nhau được giữ nguyên, không lấy số ACK thay cho first frame.
Trang 2 không còn crash bộ nhớ nhưng vẫn chậm; tối ưu startup không chứng
minh đã đạt ngân sách frame cho mọi trang nhiều transparency.

### Kiểm chứng cuối trước áp dụng

- TypeScript toàn frontend: đạt (`frontend-typecheck.log`).
- 98 test frontend / 6 file: đạt (`frontend-tests.log`). JSDOM in cảnh báo
  canvas chưa triển khai của bài thử tile hiện hữu; không có test thất bại.
- 40 test GPU mặc định: đạt (`gpu-final-tests.log`); 3 test benchmark ignored
  trong lượt mặc định. Hai benchmark liên quan được chạy riêng như dưới đây;
  không dùng tên test prototype để suy ra đã đạt golden Acrobat/soak thực.
- 34 test native viewport/session/cancel/Win32: đạt (`native-tests.log`).
- Test PPE fallback RGB và material tạo muộn: đạt (`native-fallback-tests.log`),
  gồm ảnh rộng hơn texture thiết bị, pan, crop, rotation và zoom lẻ.
- 16 cặp buffer RGBA khớp **từng byte** (`pixel-verification.json`): 6 ảnh trang
  1 trước/sau ở 1081×811; 6 ảnh khi giới hạn Rayon còn 2 luồng trong lượt kiểm
  phần chuyển ảnh; 2 ảnh trang 2 trước/sau sửa mask ở 216×162; 2 cặp quay lại
  trang 1 qua native worker ở 1081×811. So sánh 2 luồng không phải đo trên một
  máy RAM thấp thật và không chứng minh toàn bộ chính sách pressure đã qua soak.
- Trang 2 ở phép đo 216×162 vẽ 492 mask nhưng chỉ giữ tối đa 1 kết quả mask
  đồng thời. Cùng ảnh trước/sau, không giảm mẫu hay bỏ transparency.

Đo tuần tự lại để tránh tranh tài nguyên (`final-baseline/`, `final-after/`):

| Phạm vi GPU test, trang 1 | Trước | Sau |
|---|---:|---:|
| Chuẩn bị renderer + frame đầu, lần đầu | 1.570 ms | 569 ms |
| Gắn lại trang, tài nguyên đã có | vẫn dựng lại: 2.753 / 3.203 ms | 108 / 100 ms |

Số sau lần đầu gồm 76 ms tài nguyên chung + 0,16 ms gắn scene + 492 ms frame
đầu (bao gồm material tạo muộn). Không chỉ báo `prepare_us` gần 0 để che phần
chuyển sang frame đầu. Parse/compile, tạo GPU context và trình bày HWND không
nằm trong bảng GPU này; xem bảng native phía trên và runtime thực tế riêng.

23 file source/manifest/test sẵn trong `ready/`, có `review.patch`, guard SHA256
trước/sau trong `apply-manifest.json`, và script backup/apply có kiểm tra hash.
Người dùng đã xác nhận lưu và dừng run_dev. Đã áp dụng đủ 23 file, backup
trong `before-apply/`, hash nguồn khớp manifest; bản dev build lúc
15:10:33 ngày 25/09/2026 (UTC+7), SHA256 `c2aee2432458a6a175fea2c813969b29b1248a9a5b6def557f68eab1fdbc9531`.
Typecheck và 98 test frontend trên source thật đạt. 35 test native chạy lại với
worker từ executable mới đạt (`native-final-tests.log`); thêm 3 ảnh từ worker mới
khớp ảnh staging từng byte, tổng 19 cặp. Bản native test harness
là bản biên dịch staging cùng source đã đối chiếu hash. Chưa có lượt thao tác
người dùng trên cửa sổ Tauri/WebView2 sau R31.

Lượt kiểm cuối với worker từ executable mới (`native-final-session/timing.csv`):
trang 1 lần đầu nạp scene 470 ms + vẽ/chờ GPU 763 ms; quay lại nạp scene dưới
1 ms + vẽ/chờ GPU 298–336 ms. Trang 2 nạp scene 1.032 ms và frame đầu 7.967 ms.
Đây vẫn là test tự động, không bao quát toàn bộ thao tác và trình bày WebView2.
