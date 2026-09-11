# Simplify: tăng tốc preview/Thực thi và mặc định tự động — 2026-09-10

Đợt này nối các bản tối ưu đã được duyệt vào luồng sản phẩm, đồng thời giảm
thao tác cho đường cắt mới. Không thay dung sai tối đa 0,10 mm, không bỏ kiểm
topology/góc/độ cong, và không đụng `CutContour` đã có trong PDF.

## Thay đổi

- Bộ gộp bảo toàn dùng dữ liệu lazy + necessary-hull prefilter; solver neo tự
  do dùng Jacobian giải tích. Thứ tự seed, objective, verifier và fallback giữ
  nguyên.
- Memo thuần hình học chỉ sống trong session RAM. Khóa gồm geometry có thứ tự,
  frame/đơn vị, tolerance, chế độ conservative và phiên bản thuật toán; lưu cả
  kết quả `changed=false`. Không đọc cache từ đĩa hoặc nhận memo qua HTTP.
- Preview classic toàn trang lưu final CUT + memo. Lượt lặp cùng source,
  revision, fingerprint và thiết lập trả bản sao cache; Thực thi snapshot memo
  đã kiểm rồi truyền nội bộ vào worker.
- UI chọn AUTO cho tài liệu mới khi trang hiện tại là biên raster/Alpha/AI và
  chưa có `CutContour`: mức hiệu dụng là 0,10 mm. Vector, page-box, trang có
  CUT, nguồn không chắc chắn và lỗi nhận diện giữ 0. Kéo thủ công về 0 là
  override thật; đổi file tự trở về AUTO.
- Recipe ghi và phát lại `cutline_simplify_auto`, để backend xét từng trang
  thay vì áp 0,10 mm đồng loạt lên tài liệu lẫn vector/raster.

## Bằng chứng đã chạy

- Binder2 trang 12, preview classic: 122 → 64 cubic, cận verifier/writer
  báo 0,0886759633 mm. Lượt đo tốc độ này không thay thế phép đo độc lập.
- Cùng phiên và cùng fingerprint: preview nóng trả tức thì, không tạo worker
  mới.
- Ca Thực thi cùng geometry: 8,30 s lạnh → 0,52 s khi dùng memo preview;
  122 → 64 cubic và stats giữ nguyên. Đo trực tiếp trong engine với worker
  preview inline để tránh giới hạn tạo process của môi trường kiểm thử; test
  process-spawn riêng vẫn đạt.
- Backend: 56 test nhóm Simplify/memo/auto/preview/Jacobian; frontend: 131
  test liên quan, thêm 36 test recipe; Windows typecheck, `py_compile` và
  `git diff --check` đều đạt.

## Kiểm full frontend sau yêu cầu chạy ngoài sandbox

- Lệnh `npm run test` đã chạy được ngoài sandbox, không còn `spawn EPERM`.
  Lần đầu: 3.565 đạt, 2 lỗi. Test audit JPG vượt timeout mặc định 5 giây
  khi chạy cùng toàn bộ suite; nâng riêng timeout test này lên 15 giây,
  không đổi logic xử lý ảnh hoặc timeout production. Icon trợ giúp của
  `RichSelect` đổi từ role note sang img với cùng nhãn truy cập, phân biệt
  với thông báo bảo toàn CutContour của panel.
- Sau chỉnh: **311 file test đạt; 3.567 test đạt, 2 bỏ qua** (40,48 giây).
  Typecheck và diff-check đạt. Không tắt test lỗi hoặc sửa golden.
- Tauri dev: đã kiểm không có cửa sổ PrynX/listener dev, nhưng yêu cầu
  khởi chạy ngoài sandbox hết thời gian ở bộ xét quyền cả lần đầu và lần
  thử lại. Lệnh chưa được thực thi, chưa tạo backend/Vite/Tauri của lượt
  này; không coi đây là lỗi runtime PrynX hay lỗi `EPERM` từ Tauri.

## Giới hạn còn lại

Chưa chạy GUI Tauri, build installer hoặc thử dao bế trên máy thật trong lượt
này. Preview lạnh vẫn phải dựng một lần; cache chỉ loại công việc lặp đúng
source/revision/geometry. Mức AUTO không sửa đường đã có `CutContour`.

## Bổ sung đo hiệu năng 2026-09-11

- Nút thắt chính của preview lạnh không nằm ở solver neo tự do mà ở verifier
  khoảng cách: flatten tới `0,00005 mm` tạo khoảng 38 nghìn đỉnh cho một ring,
  rồi chạy STRtree hai chiều. Trên Binder2 trang 12, riêng hai lượt này đo
  khoảng 6,6 giây trong profiler.
- Verifier nay dùng polyline Bézier có cận convex-hull và `buffer/covers` hai
  chiều, tìm bán kính bằng 8 bước nhị phân. Chỉ khi candidate gần như trùng
  nguồn mới đo mẫu dày cũ để ghi `sampled_maximum_error_mm`; quyết định nhận/
  loại vẫn dựa trên cận liên tục. Các guard đóng vòng, winding, topology,
  góc, độ cong và lượng tử writer không đổi.
- Đo trực tiếp Binder2 trang 12, mode original, offset 2 mm, denoise 30,
  Simplify `0,10 mm`: **122 → 64 cubic**, cận sau writer **0,0895 mm**,
  khoảng **3,2–3,8 giây** cho một lượt render trong process hiện tại, so với
  khoảng **8,1 giây** trước tối ưu verifier. Đây là đo backend worker, chưa
  phải thời gian UI Tauri hay toàn bộ file 13 trang.
- Classic preview dùng một `ProcessPoolExecutor(spawn)` giữ sẵn trong
  lifetime sidecar; đổi trang chỉ gửi job mới, không nạp lại interpreter và
  PDFium. Nếu môi trường bị chặn named pipe, code quay về pool tạm và giữ
  nguyên cách ly process. Sandbox phiên này trả `WinError 5` khi tạo pipe nên
  chưa có benchmark warm-pool thật trên máy này.
- Pipeline whole-page nay bake CUT nền với `cutline_simplify_mm=0` một lần
  trong worker rồi refit trên vector đó khi đổi slider. Cache nền có digest
  SHA-256, giữ một working-set/trang và không dùng lại khi nội dung PDF đổi;
  vì vậy preview không gọi lại toàn bộ dựng biên cho mỗi mức Simplify.
- Đo trực tiếp cùng trang 12: bake nền **0,55 giây**; mức `0,05 mm` dùng
  reducer nhanh **1,45 giây**, cho `122 → 106` cubic và cận `0,04963 mm`.
  Mức `0,10 mm` vẫn cần fairing để đạt **64 cubic**, nên dao động khoảng
  `4–10 giây` tùy tải CPU; đây là chi phí chất lượng cao nhất, không còn là
  chi phí dựng lại PDF nền.
- Với preview live, mức từ `0,075 mm` trở lên chạy fairing trước để bỏ lượt
  reducer không giảm được node; kết quả Simplify đã chứng nhận được lưu theo
  từng dung sai trong working-set của CUT nền. Đo lại cùng process: chuỗi
  `0 → 0,05 → 0,10 → 0,10 → 0,05` lần lượt khoảng **0,57 / 1,48 / 6,00 /
  0,006 / 0,004 giây**; các lượt lặp không chạy solver nữa.

## Bổ sung đo và tối ưu Execute 2026-09-11

- Profiler trên Binder2 trang 12 xác nhận hotspot còn lại là
  `global_refit_ring`: gần 38.000 cạnh ứng viên, trong khi raster chỉ khoảng
  0,01 giây. Luồng sản phẩm nay dùng tối đa **3 vòng cập nhật tham số cho mỗi
  ứng viên** ở chế độ preview/Execute (API lõi mặc định vẫn giữ 7 vòng để bảo
  toàn các caller cũ). Verifier liên tục, kiểm topology/góc/độ cong và lượng tử
  writer không đổi.
- Đo lại cùng cấu hình `original`, offset 2 mm, denoise 30, Simplify `0,10 mm`,
  ép tuần tự để loại ảnh hưởng ProcessPool: trang 12 khoảng **2,6 giây**,
  `280 → 68` cubic, cận sau writer **0,099984 mm**; toàn Binder2 13 trang
  khoảng **17,6 giây**, tổng `1.474 → 508` cubic. Đây là đo backend worker,
  chưa phải thời gian GUI/Tauri trên máy người dùng.
- Preview dùng cùng chế độ nhanh với Execute; các nhánh `CutContour` có sẵn,
  vector và góc tròn không bị đổi đường. Khi verifier không chứng nhận ứng viên,
  engine vẫn giữ đường nguồn/fallback như trước.
