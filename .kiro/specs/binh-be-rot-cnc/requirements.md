# Requirements Document

> Tài liệu Yêu cầu — Công cụ "Bình Bế Rớt (CNC)"

## Introduction

Hiện công cụ **Bình Tem Bế** chuyên cho tem decal/nhãn (kiss-cut, cán 1 mặt, pont/ốc, 1 Dao). Các sản phẩm **bế rớt / cắt rời trên máy CNC** (thẻ treo, card cắt hình, standee, sản phẩm rớt khỏi tờ) có nhu cầu khác biệt:
- **In 2 mặt** (Mặt trước / Mặt sau) — rất phổ biến.
- **Dấu canh máy CNC** (nhiều loại tùy máy: Graphtec, flatbed…), khác với pont/ốc của tem.
- Cắt **đứt rời** (cut-through) thay vì kiss-cut.

Thay vì dồn hết vào Bình Tem Bế (gây rối UI, lẫn nghiệp vụ), tính năng này tạo **một công cụ riêng "Bình Bế Rớt (CNC)"** — là một **card mới trong menu** — nhưng **dùng chung engine xếp (solver Rust), nhận diện hình, report, lưu file** với Bình Tem Bế. Khác biệt chính chỉ ở: **bình 2 mặt (lật gương mặt sau)**, **dấu canh CNC**, và **xuất 3 trang/job (Mặt trước / Mặt sau / Khuôn)**.

Quyết định đã chốt với người dùng:
- Bình 2 mặt **chỉ ở CNC**; Bình Tem Bế giữ thuần tem 1 mặt (đã bỏ "số mặt cán" khỏi Bế tem).
- Ghép cặp Mặt trước/sau theo **thứ tự trang** (trang lẻ = trước, trang chẵn = sau) — phương án A.
- Mặt sau **lật đối xứng**; mặc định **lật cạnh dài**, cho phép chọn cạnh ngắn.
- Output: **3 trang** — Mặt trước, Mặt sau, Khuôn (giống script Illustrator).
- Thuật toán xếp **giống** Bình Tem Bế (không viết lại solver).

## Glossary
- **Bế rớt (CNC)**: cắt đứt rời sản phẩm trên máy CNC/flatbed (sản phẩm "rớt" khỏi tờ).
- **Mặt trước / Mặt sau**: 2 mặt in của cùng một sản phẩm 2 mặt.
- **Lật gương (mirror)**: lật đối xứng layout mặt sau để khi in lật giấy, bế 2 mặt trùng khít.
- **Cạnh lật (flip edge)**: lật quanh cạnh dài (long-edge) hay cạnh ngắn (short-edge) của tờ in.
- **Dấu canh CNC**: dấu định vị để máy CNC/camera nhận vị trí cắt (khác pont/ốc của tem).
- **Khuôn**: trang chỉ chứa đường cắt/bế (cut file) để gửi máy CNC.

---

## Requirements

### Yêu cầu 1 — Công cụ riêng trong menu

**User Story:** Là người dùng, tôi muốn có một card "Bình Bế Rớt (CNC)" riêng trong menu để chọn đúng quy trình cho máy CNC, không phải lục trong Bình Tem Bế.

#### Acceptance Criteria
1. THE hệ thống SHALL thêm một card công cụ mới "Bình Bế Rớt (CNC)" trong menu (tool registry), mô tả ngắn gọn (vd "Cắt rời CNC, bình 2 mặt").
2. WHEN người dùng mở công cụ này THEN hệ thống SHALL dùng lại dashboard/engine bình bài hiện có thông qua một **chế độ riêng** (tool id / capability profile), KHÔNG nhân bản solver.
3. THE công cụ CNC SHALL chỉ hiện các tùy chọn liên quan (2 mặt, dấu canh CNC, cắt rời); Bình Tem Bế KHÔNG hiện các tùy chọn CNC và ngược lại.

### Yêu cầu 2 — Bình 2 mặt (ghép cặp theo thứ tự trang)

**User Story:** Là thợ chế bản, tôi muốn bình file 2 mặt sao cho mặt trước/mặt sau khớp nhau, để in lật giấy là bế trùng khít.

#### Acceptance Criteria
1. WHEN bật chế độ "In 2 mặt" THEN hệ thống SHALL ghép cặp theo thứ tự trang: trang 1 = Mặt trước, trang 2 = Mặt sau (3↔4, 5↔6…).
2. IF số trang lẻ (không ghép đủ cặp) THEN hệ thống SHALL cảnh báo rõ ràng và không xuất sai.
3. THE hệ thống SHALL hiển thị **xem trước ghép cặp** (Mẫu A: Trước = Trang 1, Sau = Trang 2…) để người dùng xác nhận trước khi chạy.
4. THE layout xếp tem SHALL dùng **cùng thuật toán** với Bình Tem Bế (solver Rust), áp cho mặt trước; mặt sau dùng cùng vị trí ô.

### Yêu cầu 3 — Lật gương mặt sau

**User Story:** Là thợ in, tôi muốn mặt sau được lật đối xứng đúng cạnh, để khi lật giấy in mặt 2 thì các ô bế chồng khít mặt 1.

#### Acceptance Criteria
1. WHEN xếp mặt sau THEN hệ thống SHALL **lật gương** layout mặt sau tương ứng mặt trước.
2. THE hệ thống SHALL cho chọn **cạnh lật**: cạnh dài (long-edge) hoặc cạnh ngắn (short-edge); **mặc định cạnh dài**.
3. THE vị trí từng ô mặt sau SHALL khớp (đối xứng) với ô mặt trước tương ứng để bế 2 mặt trùng nhau.

### Yêu cầu 4 — Dấu canh CNC (nhiều loại)

> ⚠️ **CẬP NHẬT:** Yêu cầu "nhiều loại dấu canh" này **chưa được hiện thực** đúng như mô tả.
> Code hiện tại chỉ có **một** loại dấu canh in 2 mặt (`cncDuplexMarks` →
> `cnc_marks.draw_duplex_marks`: 4 dấu tròn + chữ thập ở giữa cạnh, vẽ cả Mặt trước & Mặt sau).
> Việc định vị máy cắt dùng lại hệ **boong (pont)** của Bình Tem Bế (chỉ Mặt trước + Khuôn).

**User Story:** Là người vận hành CNC, tôi muốn chọn loại dấu canh phù hợp máy của mình, để máy nhận đúng vị trí cắt.

#### Acceptance Criteria
1. THE hệ thống SHALL cung cấp **nhiều loại dấu canh CNC** cho người dùng chọn (danh sách cụ thể chốt ở bước design — ví dụ Graphtec registration, dấu góc, dấu tròn…).
2. WHERE in 2 mặt THE dấu canh SHALL được vẽ nhất quán trên cả mặt trước và mặt sau để canh chồng.
3. THE việc chọn loại dấu canh SHALL được lưu (persist) cho lần dùng sau.

### Yêu cầu 5 — Xuất 3 trang (Mặt trước / Mặt sau / Khuôn)

**User Story:** Là thợ chế bản, tôi muốn file kết quả gồm Mặt trước, Mặt sau, và Khuôn (cut) riêng — để gửi in 2 mặt và gửi máy CNC.

#### Acceptance Criteria
1. WHEN chạy job 2 mặt THEN hệ thống SHALL xuất theo thứ tự **Mặt trước → Mặt sau → Khuôn** cho mỗi đơn vị bình (giống script).
2. THE trang Khuôn SHALL chỉ chứa đường cắt/bế (không có artwork) để gửi máy CNC.
3. WHERE 1 mặt (không bật 2 mặt) THE hệ thống SHALL xuất **Mặt trước → Khuôn** (2 trang).
4. THE chức năng **lưu file in** (chọn thư mục, tách file, đặt tên) SHALL tái dùng cơ chế đã có (`SavePrintFilesModal`).

### Yêu cầu 6 — Tái dùng Report & Số lượng

**User Story:** Là người dùng, tôi muốn công cụ CNC cũng có report (số tờ cần in, chất liệu…) như Bế tem, để nhất quán.

#### Acceptance Criteria
1. THE công cụ CNC SHALL tái dùng hệ thống **report + xuất tờ duy nhất + bảng tổng hợp lệnh in** đã làm cho Bình Tem Bế.
2. WHERE sản phẩm CNC cán 2 mặt THE report SHALL cho ghi "cán 2 mặt" (số mặt cán là tùy chọn của CNC, không phải của Bế tem).

### Yêu cầu 7 — Không phá vỡ Bình Tem Bế & các công cụ khác

#### Acceptance Criteria
1. WHEN thêm công cụ CNC THEN Bình Tem Bế, N-Up, Booklet SHALL giữ nguyên hành vi hiện tại.
2. THE thay đổi SHALL không làm hỏng test backend hiện có.
3. THE việc xếp 2 mặt SHALL dùng lại hạ tầng duplex/engine sẵn có thay vì viết solver mới (tránh trùng lặp).

---

## Out of Scope
- Viết lại thuật toán xếp (dùng chung solver Rust với Bình Tem Bế).
- Tem decal cuộn / kiss-cut / 1 Dao (thuộc Bình Tem Bế).
- Tích hợp trực tiếp driver máy CNC (chỉ xuất file đúng chuẩn để nạp máy).
