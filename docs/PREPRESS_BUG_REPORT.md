# Cách báo bug prepress (tem bế / CNC / N-Up / crop)

Dùng khi file in thật lỗi — giúp team tái hiện nhanh **không** cần remote vào máy bạn.

## 1. Thông tin bắt buộc

| Mục | Ví dụ |
|-----|--------|
| **Tool** | Bình Tem Bế / Bình Bế Rớt CNC / Bình Cắt Xén / Crop |
| **Phiên bản PrynX** | About → version (hoặc tên installer) |
| **Windows** | 10 / 11 |
| **Mô tả 1 câu** | “1 Dao page-size va chạm boong sai” |
| **Kỳ vọng** | “Tem xếp kín tờ, không đè boong” |
| **Thực tế** | “Boong đè lên tem góc dưới-trái” |

## 2. File & bước tái hiện

1. File PDF nguồn (hoặc 1 trang mẫu đã ẩn data nhạy cảm).
2. Các bước: mở Home → tool X → chỉnh A/B/C → Preview / Export.
3. Ảnh chụp **Preview** và (nếu có) **PDF export**.
4. Ghi thông số: khổ tờ, gap, cutType (1 Dao / multi), dieSizeMode (page/die), cluster.

## 3. Không gửi

- License key, mật khẩu PDF, file khách có NDAs.
- Toàn bộ thư mục cài đặt app.

## 4. Log hữu ích (tuỳ chọn)

- DevTools Console (F12) nếu lỗi đỏ lúc preview/export.
- `collision_debug` / log backend nếu bật trong bản dev.

## 5. Checklist trước khi báo

- [ ] Thử file 1 trang đơn giản (hình chữ nhật stroke)
- [ ] Tắt cluster / 1 Dao xem còn lỗi không
- [ ] So Preview vs file Export (parity)

---

*Tài liệu Phase A — PrynX feature plan.*
