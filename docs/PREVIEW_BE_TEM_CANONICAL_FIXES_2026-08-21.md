# Nhật ký sửa preview đường bế tem canonical — 2026-08-21

## Lô 1 — Hợp đồng backend

- [x] Cache đủ fingerprint, Alpha, quality, DPI và denoise.
- [x] Cache key khóa cả denoise.
- [x] Snapshot artifact một-tem với kiểm revision/fingerprint/source/tuning.
- [x] Route classic dùng snapshot, không detect/fit lần hai.
- [x] Giữ metadata màu nền để bù xén không hút halo.

## Lô 2 — Lifecycle frontend

- [x] Hook công bố reference của frame mới nhất.
- [x] Thay tuning làm reference stale ngay, vẫn giữ SVG cũ để tránh chớp.
- [x] Thực thi gửi reference và không đóng session giữa request.

## Lô 3 — Hiệu năng fitter DPI thấp

- [x] Sửa cap denoise theo pixel nguồn có điều kiện.
- [x] Đo số đoạn, thời gian và cổng an toàn trên fixture thật.

## Lô 4 — Chốt race và fast guard

- [x] Snapshot canonical chạy trong threadpool nhẹ, không khóa event loop khi
  hash/copy Alpha hoặc chờ `operation_lock`.
- [x] Khóa Thực thi cả khoảng `isUpdating` đầu tiên; không còn khe rơi về detect/fit
  legacy trước khi preview canonical hoàn tất.
- [x] Chế độ Alpha cũng tái dùng canonical artifact dù policy giữ
  `remove_white_bg=false`.
- [x] Thay phép đo Hausdorff O(n²) lặp theo candidate bằng cận trên bảo thủ từ
  guard buffer hai chiều; candidate vượt trần vẫn đo exact và bị fail-closed.

## Verify

- [x] Backend focused (243 passed).
- [x] Frontend focused (38 passed).
- [x] Typecheck.
- [x] Backend engine/API/source/trajectory/màu viền/khử nền: 331 passed.
- [x] Frontend toàn bộ: 250 file, 2.492 passed, 2 skipped; typecheck 0 lỗi.
- [x] Benchmark đúng wrapper `pdf-lib` của ứng dụng với
  `Desktop\tải xuống.jpg`: detect 0,381 s, preview 0,635 s, execute 1,210 s;
  snapshot khoảng 0,006–0,007 s, 0 cusp và 174 đoạn.
