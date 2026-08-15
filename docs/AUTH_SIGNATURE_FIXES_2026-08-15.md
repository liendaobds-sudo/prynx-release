# AUTH SIGNATURE FIXES 2026-08-15

## Phạm vi

Sửa lỗi `403 Invalid request signature` được báo tại Upscale nhưng phát sinh ở lớp HMAC dùng chung của sidecar. Phạm vi bao gồm mọi HTTP API đi qua `authenticatedFetch` hoặc interceptor backend; không thay đổi thuật toán xử lý ảnh/PDF của từng công cụ.

## §SIG.01 — Token mới lệch binding Rust

- Frontend chụp `licenseKey + licenseToken` trong cùng một snapshot và truyền token vào mọi lần ký.
- Rust so hash token request với binding đã native-verify trước khi tạo HMAC.
- Khi cache stale, frontend đăng ký lại đúng token rồi ký lại đúng một lần; chỉ gửi một HTTP request sau khi có chữ ký mới.
- Regression test khóa chuỗi `sign → register → sign → fetch` và xác nhận token/header/chữ ký cùng phiên.

## §SIG.02 — Sidecar chết sau startup

- PID sidecar được cập nhật theo từng thế hệ và vẫn dọn cả cây khi app thoát.
- Mỗi thế hệ dùng cờ thoát riêng; event reader cũ đóng muộn không thể làm supervisor hiểu nhầm sidecar mới đã chết.
- Supervisor chỉ respawn khi port rảnh; nếu listener còn tồn tại thì phải vượt startup HMAC proof bằng secret của chính app.
- Thế hệ mới nhận lại cùng storage, biến môi trường và secret qua stdin, sau đó phải vượt startup proof trước khi được coi là sẵn sàng.
- Không tự ý kill listener không xác thực; backoff có giới hạn và dừng sau ba lần thất bại.

## Verify trên working tree hiện tại

- Frontend auth/upload/Upscale: `17 passed`.
- Backend license/Upscale: `91 passed`.
- Rust: token-binding release `2 passed`; supervisor `7 passed` debug và `7 passed` release.
- `npm run typecheck`, ESLint hẹp, `cargo check --release`, rustfmt hẹp và scanner self-test `17/17`: đạt.

## Khoảng trống còn lại

Chưa build installer mới, chưa chạy key khách thật và chưa fault-inject bằng cách kill sidecar trên bản cài. Vì vậy mức bằng chứng hiện tại là `AUTO`; RC5 không chứa patch này và không được dùng để nghiệm thu bản sửa.
