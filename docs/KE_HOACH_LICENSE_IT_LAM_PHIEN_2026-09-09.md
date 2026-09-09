# License ít làm phiền — phương án đã được duyệt

Ngày 2026-09-09, người dùng duyệt phương án “kích hoạt một lần, xác minh lại âm thầm”.
Baseline `e27cbb3`; không push/deploy/reset slot/đổi credential thật trong quá trình triển khai.

## Bất biến

- Offline tối đa 72 giờ là policy hiện hữu, không tự gia hạn `exp`. Chỉ chứng nhận đã được native kiểm chữ ký/device/anchor mới cấp quyền production.
- Mạng lỗi/429 không thu hồi một chứng nhận vẫn hợp lệ; mã thu hồi/hết hạn và lỗi integrity được xử lý riêng.
- Renewal có network phase không giữ khóa mutation của API; commit key/token/native vẫn có epoch và hàng rào ngắn.
- Native điều phối lịch/owner/cooldown giữa các WebView; lịch không phải quyền sử dụng. Deferred không tự làm token hợp lệ.
- Sau phản biện của người dùng: **không thêm bypass license vào dev**. Giữ luồng kiểm thật; tách key/môi trường và quota thử nghiệm ở rollout riêng. Policy debug phải được công bố đúng qua IPC, và nghiệm thu license cần bật enforcement như bản cài. Release không có fallback dev.
- Không tự cho phép di chuyển slot legacy bằng HWID/bearer token; đổi key cần proof và giữ rollback an toàn.

## Các lô nhỏ, verify trước khi tích hợp tiếp

1. Native policy + sửa phụ thuộc HWID legacy ở V3; hồi quy debug/release và token sai.
2. Coordinator native (module riêng + wiring) và store dùng chung lịch; test owner/epoch/cooldown/late completion.
3. Startup dùng lease đã xác minh trước, renewal nền; test không khóa API lúc chờ mạng, terminal vẫn khóa. Dev-isolation không triển khai bằng key giả hoặc bỏ gọi server; dành riêng rollout môi trường kiểm thử.
4. UI cooldown/recovery cùng key, thông báo đúng nguyên nhân; locale sửa riêng key, giữ thay đổi của tác vụ khác.
5. Native khuôn bế đồng bộ 15 phút/72 giờ và CNG TPM/software hiện hữu, không tạo/xóa identity; test biên + chữ ký/thiết bị không đổi.

Mỗi lô tối đa 5 file code/test; docs ghi tiến độ riêng. Các thao tác runtime có thể gọi key thật phải chờ người dùng chủ động nghiệm thu; không giả lập chúng bằng cách xóa key hoặc nới gate.

## Phần cần rollout riêng

Server activation/renewal quotas và `Retry-After`, đồng bộ source Edge hai repo, recovery slot legacy có audit, và quyền hoàn tất tác vụ đã submit cần integration test/rollout server riêng. Không tự áp migration/deploy vào production. Không gọi đây là hoàn tất kiến trúc khi chỉ mới thay client.

Việc bảo vệ kết quả tác vụ đang chạy phải dùng quyền giới hạn theo job và chỉ cho hoàn tất/lưu tác vụ đã được cấp phép trước đó; không mở API tổng quát sau expiry. Chưa dùng “grace vô điều kiện” để giải quyết bước này.
