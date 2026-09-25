# Sửa nhánh hiệu năng CUT — 2026-09-24

Người dùng đã duyệt toàn bộ audit. Các lô giữ verifier/dung sai/quỹ đạo,
không cap chất lượng hay worker của máy mạnh. Không commit.

Đối chứng bổ sung CUT24.04: xem `live_fitter_measurement.md` và
`live_fitter_before_after.json`. Flower12 104→101 node, bước nhảy độ cong
6,15038→~0 trong budget cũ, thời gian0,01938→0,12398s. Flower3 16→15,
2,05177→~0, thời gian0,00427→0,02221s. Đây là N1 direct function, không GUI.

## Lô CUT24.08 — hủy verifier

- Thêm checkpoint trước/sau topology, metric, GEOS coverage/reference distance,
  trong flatten/subdivision và từng cubic khi tính diện tích/độ cong.
- `PreviewCancelled` vẫn là BaseException; không rơi vào nhánh fail-safe
  hình học trả đường cũ. Không ngắt giữa một lệnh GEOS/native đơn lẻ.
- Source: `cutline_fair_verify.py`; test: `test_cutline_fair_verify.py`.
- **58 passed**, 1 warning Pydantic cũ, **3,04 s**: verifier + cancellation.
- Probe circle trước: chạy hai metric và distance sau cancel, trả accepted;
  sau: raise cancellation ở metric đầu, không distance. Timer nằm trong
  `verifier_cancel_after.json`, không coi là benchmark HTTP/Tauri hay worst-case.
- Bốn file của lô: production, test, JSON sau và nhật ký này.

## Lô bổ sung CUT24.08 — topology dùng chung

- Root cho phép sau khi xác nhận geometry agent không sửa
  `cutline_polyline_reduction.py`. Thêm checkpoint đầu `_continuous_paths_simple`,
  từng curve/cặp STRtree và từng nhánh đệ quy `_curves_disjoint`, trước khi
  trả chứng nhận toàn nhóm. Giữ nguyên depth16/hull và mọi guard.
- Hai regression hủy ở giữa split đệ quy và giữa cặp topology: mỗi trường hợp
  chỉ làm một bước rồi raise `PreviewCancelled`, không trả kết quả hình học.
- **18 passed, 1 deselected**, 1 warning Pydantic cũ, **6,89 s**: polyline
  trừ Binder2 tree để không cạnh tranh benchmark root. Các ca circle/distance,
  topology, quantization và nested Form vẫn đạt.
- Ba file của lô: production polyline, test polyline, nhật ký này.

## Lô CUT24.06 — ngân sách BLAS/OpenCV thực

- Helper `numerical_worker_threads.py` đọc các thư viện đã nạp trong process,
  dùng cặp getter/setter native cho OpenBLAS/MKL. Scope nạp NumPy/SciPy trước
  để phủ cả hai BLAS độc lập trên wheel Windows, restore trong `finally` kể
  cả Exception và cancellation. Không sửa `os.environ`, không thêm dependency.
- Root tích hợp decorator picklable `with_worker_thread_budget` vào worker
  và bỏ block env/cv2 cũ trong `sticker_engine.py`. Planner giữ nguyên số worker,
  RAM policy và ngân sách tổng CPU; requested32 vẫn được chuyển nguyên32.
- **33 passed**, một warning Pydantic cũ, **4,62 s**: helper, parallel fallback,
  admission. Bộ helper riêng trước đó7 passed nằm trong bộ33, không cộng dồn.
- Probe actual worker với engine stub: NumPy và SciPy đều **16→1→16**, OpenCV
  **16→1→16**, env nguyên, wrapper pickle/unpickle trỏ đúng callable toàn cục.
  Xem `worker_threads_after.json`. Trước sửa NumPy vẫn16 khi yêu cầu1.
- Chưa benchmark full PDF đa process cho speedup; import SciPy lần đầu có
  chi phí khởi tạo. Direct core không qua worker không được dùng để khẳng định
  tác dụng của scope này. API thư viện MKL/đóng gói Nuitka chưa kiểm runtime.
- Năm file của lô: helper, test helper, tích hợp engine do root sửa, JSON sau,
  nhật ký này.

## Lô CUT24.07 — identity nội dung

- Bỏ cache stat không bao giờ chạy và fallback nuốt NameError; helper đọc
  byte nguồn thật mỗi lần, giữ lỗi I/O nguyên vẹn, có chốt cancellation.
- Worker chỉ hash một lần cho hai khóa baseline/source trong cùng bước.
  Không bỏ kiểm digest đầu/cuối job và snapshot; không tin size/mtime.
- Source: `sticker_classic_page_preview.py`; test mới:
  `test_classic_cutline_identity.py` gồm rewrite cùng size/mtime, lỗi I/O
  không bị retry âm thầm, hai lượt worker mỗi lượt một digest.
- **43 passed**: identity + memo + jobs. Test đầu thất bại vì fixture output
  chưa có CUT, sửa riêng fixture thành stream CUT đóng kín rồi chạy lại đạt.
- `digest_after.json`: ba request vẫn ba content hash có chủ đích, **0 lỗi bị
  nuốt** thay vì ba NameError. Không tuyên bố speedup solver; lợi ích đo bằng
  giảm hai hash liên tiếp về một trong worker và bỏ exception path.
- Bốn file của lô: production, test, JSON sau và nhật ký này.
