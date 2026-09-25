# Sửa lõi hình học — 24/09/2026

Người dùng đã duyệt sửa toàn bộ audit. Không commit hoặc build release.

## Lô A — gate nguồn và công việc solver trùng

File: `cutline_fair_simplify.py`, `cutline_fair_seed.py`,
`cutline_cubic_simplify.py` (salt), `test_cutline_core_reuse.py`, nhật ký này.
Không sửa verifier/dung sai.

- Bỏ điều kiện nguồn >100 cubic tắt fairing; số biến được quyết định bởi
  seed, không bởi các phép chia dư trong nguồn. Góc/topology/band vẫn kiểm
  với nguồn cubic bất biến.
- Dựng seed theo nhu cầu, nguyên thứ tự1,1×/1×/1,25×. Nếu lượt nhanh không
  đạt, lượt đầy đủ dùng lại seed gốc đã dựng, không dùng nghiệm lỗi.
- Dựng cây chiếu nguồn một lần mỗi lần tối ưu seed, tái dùng qua IRLS;
  mọi điểm/mẫu và Newton giữ nguyên. Candidate thay đổi vẫn dựng cây mới.
- Verify hẹp: core reuse + seed **49 passed/1 deselected**, gồm nguồn128
  đến solver, seed dựng lười, full fallback dùng seed gốc, cache phép chiếu
  có output đúng bit và không alias. Test mới lúc đầu sai kiểu fixture
  (tuple chứa ndarray); đã sửa fixture thành tọa độ tuple như API thật.
- Salt đổi thành `free-g1-v4-certified-spans` để cache/memo cũ không thắng
  kết quả mới sau khi mở fairing cho nguồn dày.
- Bỏ gate có thể tăng thời gian ở ring vốn bị bỏ
  qua; không gọi đây là tăng tốc toàn bộ chức năng trước khi đo đầu ra thật.

## Lô B — hoàn nguyên phép chia và đồ thị span

File: helper mới `cutline_exact_coalesce.py`, cubic/global simplify,
`test_cutline_representation_quality.py`, nhật ký này.

- Hoàn nguyên de Casteljau chỉ khi forward split khớp mọi control point
  trong sai số số học; cộng cận control hull vào budget, giữ nguyên seam.
- Bỏ cap12/24. DP xét theo cận dưới số lệnh còn lại, không fit cạnh không
  thể cải thiện nghiệm đã có. Không nhận candidate thiếu verifier.
- Verify lôB: **107 passed/1 skipped/2 deselected**, gồm representation,
  cubic/global, core reuse, seed; hai ca corpus chưa chạy ở chốt này.
  Không đổi kỳ vọng số node của các test cũ. Trường hợp xấu vẫn O(N²),
  không hứa preview tức thì.

## Probe trước/sau và cold core

`fixes/probe_geometry.py quality` cố định live fixture bằng hàm HEAD của
phiên audit, tránh CUT24.04 sửa fitter làm đổi đầu vào giữa hai lần đo.
Kết quả `geometry_after.json`:

- Cùng quỹ đạo G1 16 hoặc128 cubic đều ra7, cận0,06840625mm.
- Hình phóng3×, không có lệnh <0,25mm:16 hoặc128 đều ra15,
  cận0,098875mm; nguồn128 trước bị giữ nguyên.
- Circle32: seam0→4; seam1/3/5→5, giữ start, Δκ gần0, cận sauwriter
  0,00004989mm. Trước các seam này ra8 và cận0,044515mm.
- Polygon128/256→4, cùng dung sai0,05mm, cận0,049177/0,048391mm.
  Trước cap12 lần lượt11/22. Đổi lấy ít lệnh hơn: probe256 có cả metric
  khoảng5,13s, trước cap1,32s; toànspan cũ12,71s. Đây trade-off thật,
  không gọi mọi hình nhanh hơn. DP vẫn chặn fit cạnh không thể thắng theo
  chi phí hậu tố; bucket tái dùng thứ tự, không sort toàn suffix mỗi lần.

`core_capture_p12.json` lấy nguồn73 cubic **trước writer** từ Binder2
trang12, original/offset2/denoise30, .10mm preview_fast, nguồnPDF giữSHA.
Hai process tuần tự, cùng dữ liệu/options; baseline nạp4 module từHEAD
vào namespace riêng, không chép đè source:

| Core | Wall | CPU | Kết quả |
|---|---:|---:|---|
| Trước | 23,6577s | 22,8125s | 73→56, cận0,099375723mm |
| Sau | 16,5574s | 16,4375s | Khớp toàn bộ tọa độ/stats với trước |

Đây N=1 trên máy dùng chung, không hứa30% speedup cố định. Direct core không
đi qua worker thread budget. Không gộp thời gian capture/render vào timing
solver. JSON `core_p12_before.json`/`core_p12_after.json` giữ toàn đường.

## Lô C — hợp đồng regression trên corpus hiện hành

`test_cutline_global_simplify.py` có ceiling46 từ bộ nguồn cũ; root đã xác
nhận audit trước sửa cũng fail48>46. Lượt sau sửa tái hiện48, nên không phải
hồi quy mới. Giữ so sánh giảm hơn pairwise **trên cùng input**, band0,05mm,
join/curvature/short segment và bổ sung input bất biến + các góc thật≥45°
giữ đúng vị trí. Bỏ ceiling lịch sử, không đổi46 thành48 để xanh.

Corpus đã chạy lại **1 passed/23,55s** sau thay hợp đồng, không đổi output
48 thành một con số khác. `py_compile` và `git diff --check` các
module/harness đã đạt. Root chạy suite tích hợp sau khi các agent kết thúc.
