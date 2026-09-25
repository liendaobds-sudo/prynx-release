# CUT24.04 — đối chứng live fitter trên flower

Đợi geometry agent báo kết thúc benchmark core rồi chạy tuần tự; sau đo đã
bàn giao CPU về root/geometry. Không sửa production trong lượt đo.

Function trước lấy bằng `git show HEAD:backend/app/workers/sticker_engine.py`,
AST compile vào namespace riêng; function sau lấy working tree. Hai function
dùng cùng dependencies hiện tại, cùng polygon 400 điểm và settings từ audit.
Import SciPy ngoài timer. Source hash được kiểm đầu/cuối; không có thay đổi
engine trong lượt đo. **N=1** mỗi fixture/function, không phải benchmark thiết
bị chuyên dụng hoặc thời gian HTTP/Tauri/PDF.

| Đại lượng | Flower12 trước → sau | Flower3 trước → sau |
|---|---:|---:|
| Node/cubic | 104 → 101 | 16 → 15 |
| Bước nhảy độ cong max (/mm) | 6,15038 → 6,79e-14 | 2,05177 → 1,72e-15 |
| Hausdorff đo trên polygon sampled (mm) | 0,152423 → 0,245316 | 0,116603 → 0,186314 |
| Budget fitter (mm), trước = sau | 0,29718 | 0,29718 |
| Wall-time function (s) | 0,01938 → 0,12398 | 0,00427 → 0,02221 |

Đường sau ít node hơn và gần C2 theo metric tại khớp; khoảng cách tới nguồn
lớn hơn nhưng vẫn trong budget cũ. Không gọi sampled Hausdorff là chứng nhận
liên tục độc lập hoặc tolerance Simplify 0,10 mm: đây là budget bước trace live.
Chi phí tăng quan sát khoảng 0,105 s và 0,018 s để xem đủ ứng viên, không che bằng
chỉ báo tỷ lệ giảm node. Chưa suy rộng ra mọi mask/nhiều tem hoặc dao thật.

## Chi phí và khả năng tái dùng — chỉ đề xuất

Lượt instrumentation **riêng** sau đo, cùng control-points hash với output sau:

- Cả hai fixture: 8 smoothing, 8 loại neo ngắn, 4 C2, 4 G1, 8 kiểm machine safety.
- Rank đầy đủ 8 lần trên flower12 (~0,0404 s tích lũy), 7 lần trên flower3
  (~0,00696 s). Thời gian instrumented không dùng thay wall-time bảng.
- `build_candidate` hiện lặp smoothing → Polygon/simplify → coords cho C2 và
  G1 cùng strength (`sticker_engine.py:5292–5315`). Các bước này không phụ thuộc
  builder: có thể chuẩn bị một bộ coords cho mỗi `(strength,part,ring)` trong
  đúng invocation, giảm 8→4 trên fixture một ring mà vẫn dựng đủ 8 candidate.
- Có thể tách resample theo spacing ra khỏi Gaussian theo strength:
  `_smooth_closed_ring_source_scale :1816` hiện resample cùng ring/spacing
  ở cả 8 lần. Tuy nhiên nên làm riêng, so bit tọa độ thứ tự/hole/seam và
  chứng minh đầu vào không bị builder sửa; không thêm cache dài hạn.
- Không thay rank bằng một chỉ số rẻ hoặc cắt bớt candidate. Machine safety
  summary và rank dùng các chi tiết metric khác nhau; không ghép kết quả chỉ
  vì cả hai đều có độ dài/góc nối.

Root quyết định giữ bản hiện tại: chi phí tăng tuyệt đối nhỏ trong hai ca
đo, ưu tiên chất lượng và tránh thêm refactor vào lô này. Các đề xuất trên
chưa triển khai, không hứa speedup.

Harness: `probe_live_fitter.py`; số liệu/metric đầy đủ và source hash:
`live_fitter_before_after.json`.
