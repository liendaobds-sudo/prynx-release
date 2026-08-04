# Nhật ký sửa — Độ chính xác kích thước

Ngày triển khai: 2026-08-04

## Kết quả

Toàn bộ `11/11` phát hiện trong `BAO_CAO_AUDIT_DO_CHINH_XAC_KICH_THUOC_UI_2026-08-04.md` đã được xử lý. Chuẩn hiển thị chung giữ ít nhất `0,1 mm`; nơi cần khóa nhận diện khác khổ giữ `0,01 mm`. Các phép làm tròn pixel, cache và số lượng có chủ đích không bị thay đổi.

## Các lô đã thực hiện

### Lô 1 — Report thành phẩm (§DIM.1)

- Thêm formatter frontend dùng quy tắc `ROUND_HALF_UP`, giữ `0,1 mm` và bỏ `.0` thừa.
- Backend dùng `Decimal(str(value))` + `ROUND_HALF_UP` để khớp JavaScript ở điểm giữa `.5`.
- Report preview và report ghi lên PDF nay giữ `147,1 × 51,3 mm` thay vì `147 × 51 mm`.
- Thêm test ca PDF thực và ca làm tròn `148,55 → 148,6`.

### Lô 2 — Kích thước thật và Tạo tài liệu (§DIM.2–§DIM.3)

- Preset Letter của Đổi kích thước trang đổi sang đúng `215,9 × 279,4 mm`; giá trị chính xác được truyền vào engine.
- Tóm tắt Tạo tài liệu giữ phần thập phân có nghĩa.
- Tên mặc định giữ số đo thật: `Untitled_147.1x51.3mm.pdf`.
- Test mở lại PDF xác nhận page box vẫn đúng `147,1 × 51,3 mm`.

### Lô 3 — Nhãn Viewer, In và report khổ tờ (§DIM.4–§DIM.6, §DIM.10)

- Chip khổ giấy trong Print Dialog dùng geometry thật của driver đến `0,1 mm`.
- Report sách, report bình và preview giữ khổ tờ tùy chỉnh đến `0,1 mm`.
- Tooltip thumbnail hoán rộng/cao đúng sau xoay 90°/270°.
- Advisor ẩn nhận kích thước thành phẩm số thực, không còn làm tròn trước quyết định fit.

### Lô 4 — Nhãn gần đúng và luồng cũ (§DIM.7–§DIM.9)

- Combine vẫn gom theo dung sai `0,5 mm`, nhưng nhãn có dấu `≈` và tên file dùng prefix `approx_` để không giả là số đo chính xác.
- Luồng `pdfImposer` cũ dùng khóa kích thước `0,01 mm`, không còn gộp các trang lệch dưới khoảng `1 mm`.
- Cảnh báo Booklet hiển thị `0,1 mm`, cho thấy rõ phần thập phân làm spread không vừa khổ.

### Lô 5 — Nhãn lồng khuôn (§DIM.11)

- Chỉ đổi formatter của overlap/saved/shift trong strategy và label sang `0,1 mm`.
- Không thay thuật toán, tọa độ, số khuôn, collision, profile hoặc hình học CUT/CREASE/BLEED.
- Ca tiết kiệm `0,3 mm` nay hiện `−0,3 mm`, không còn `−0 mm`.
- Bundle dieline sidecar đã được build lại; golden master không cập nhật vì hình học không đổi.

## Bằng chứng kiểm thử

- Backend report + Bình nguyên tấm + đường viền cắt: `70 passed`.
- Toàn bộ frontend: `186` file test đạt; `1.837` test đạt; `2` test bỏ qua.
- TypeScript typecheck: đạt.
- Dieline riêng: `582` test đạt, `2` test bỏ qua; nesting `30/30` đạt.
- Dieline sidecar build: đạt; WebView bundle check: đạt.
- `git diff --check`: sạch; chỉ có cảnh báo quy ước LF/CRLF của working copy.

## Chưa thực hiện

- Chưa chạy kiểm tay trên app desktop thật cho toàn bộ 11 màn hình.
- Không build release, không tạo bản phát hành GitHub.
- Không commit hoặc push.
