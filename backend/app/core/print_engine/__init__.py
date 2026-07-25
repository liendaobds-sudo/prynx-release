"""PrynX Print Engine (PPE) — lớp facade Python.

Đây là **biên giới duy nhất** giữa backend và engine prepress Rust
(`print_engine` qua binding `pdfcompare_native.ppe_separations`). Mọi chỗ
trong `app/` muốn tách kẽm / đo TAC phải đi qua đây, không gọi thẳng native.

Lý do có lớp này thay vì gọi trực tiếp:

1. **Contract ổn định.** Native trả plate `bytes` thô; `separations.py` cần
   plate đã nén zlib + base64 kèm màu hiển thị. Facade quy đổi một chỗ.
2. **Chính sách độ tin cậy nằm một chỗ.** Việc map hai trục cảnh báo của
   engine sang `accuracy` là quyết định prepress, không phải chi tiết render.
3. **PPE-first, GS-fallback.** Caller không cần biết engine nào đã chạy.

# Hai trục hỏng — vì sao không gộp thành một cờ

Engine trả **hai** cờ độc lập, phân theo *hệ quả với lượng mực*:

* `ink_unsound` — có nội dung đáng lẽ lên mực mà chưa lên (object bị bỏ,
  transparency chưa dựng, `/OC` chưa xét, màu phải xấp xỉ). Đỉnh TAC đo được
  có thể **thấp hơn thực tế** ⇒ tuyệt đối không dùng để chốt kẽm hay kết luận
  "đạt ngưỡng mực". Đây là chiều sai làm hỏng lô in.
* `geometry_approximate` — nội dung *đã* lên mực nhưng hình khác bản gốc
  (font không nhúng đã thay). Đỉnh mực vùng đặc vẫn đúng; chỉ **diện tích
  phủ** là xấp xỉ.

Gộp hai trục lại nghe an toàn hơn nhưng phá chính mục tiêu fail-loud: gần như
mọi file xưởng thật đều có một nhãn chữ font không nhúng, nên cờ gộp sẽ bật
trên hầu hết file và người dùng học cách bỏ qua cảnh báo. Cảnh báo báo oan vô
dụng ngang không cảnh báo.
"""

from __future__ import annotations

from .facade import (
    ACCURACY_RIP,
    ACCURACY_RIP_APPROX_GEOMETRY,
    PpeResultUntrusted,
    PpeUnavailable,
    capabilities,
    is_available,
    separations,
)

__all__ = [
    "ACCURACY_RIP",
    "ACCURACY_RIP_APPROX_GEOMETRY",
    "PpeResultUntrusted",
    "PpeUnavailable",
    "capabilities",
    "is_available",
    "separations",
]
