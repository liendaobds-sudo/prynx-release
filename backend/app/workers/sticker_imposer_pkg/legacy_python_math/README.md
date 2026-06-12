# Legacy Python Math Fallback

Thư mục này chứa các thuật toán dàn trang (Imposition Solvers) thuần Python nguyên bản, được giữ lại nhằm mục đích:

1. **Native Fallback (Dự phòng môi trường)**: Đảm bảo ứng dụng không bao giờ bị Crash `500` nếu thư viện lõi Rust (`pdfcompare_native`) gặp lỗi biên dịch hoặc thiếu thư viện hệ thống (như `glibc`, `msvc`) trên các server đặc thù. Khi Rust không thể load, hệ thống sẽ tự động hạ cấp xuống các file tính toán trong thư mục này.
2. **Reference & QA**: Kho lưu trữ thuật toán toán học nguyên gốc làm cơ sở tham chiếu (Reference) khi cần so sánh độ chính xác kết quả giữa lõi Rust mới và thuật toán gốc.

> **Lưu ý dành cho Lập trình viên:** 
> - Bạn không cần thiết phải cập nhật thư mục này nếu bạn chỉ thay đổi cấu trúc dữ liệu của Rust, miễn là API trả về kết quả giống nhau.
> - Các file ở thư mục cha (`../grid_layouts.py`, `../shape_layouts.py`, ...) sẽ gọi thư viện Rust làm luồng chính, và chỉ import vào đây trong khối `except ImportError`.
