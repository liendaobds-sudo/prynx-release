# Requirements Document

> Siêu công cụ **Mẹc Số ⇄ Mẹc Bìa** (chạy số ruột + chạy số bìa phối hợp đồng bộ).
> Port + nâng cấp cặp script Illustrator `2. dev Nô lệ mẹc số.jsx` (đánh số ruột)
> và `3. Nô lệ mẹc bìa.jsx` (đánh số bìa) thành một công cụ thống nhất trong Prynx.

## Introduction

Trong sản xuất sổ/quyển nhiều liên (hoá đơn, biên lai, vé), thợ chế bản dùng **cặp đôi**:
- **Mẹc số**: đánh số các tờ **RUỘT** (mỗi cuốn gồm `perBooklet` liên).
- **Mẹc bìa**: đánh số các tờ **BÌA**, mỗi bìa in `số cuốn (X)` và **dải ruột của cuốn đó** `(Y → Z)`.

Hiện tại (trên Illustrator) là 2 script rời, người dùng nhập dải số + cách chia cuốn **hai lần** → dễ lệch. Tính năng này hợp nhất thành một công cụ với **một "Numbering Job" dùng chung** điều khiển CẢ ruột lẫn bìa, đảm bảo dải số bìa luôn khớp số ruột thật.

Trọng tâm rủi ro (verify-by-artifact bắt buộc): **thứ tự đánh số theo vị trí + chế độ chạy** — đây là phần dễ sai nhất (sai → cắt chồng ra số loạn). Mọi tổ hợp phải có test.

## Glossary
- **Numbering Job**: bộ cấu hình dùng chung (dải số, chia cuốn, kiểu đánh ruột, chế độ chạy, kiểu quét, offset cuốn).
- **perBooklet**: số liên (tờ ruột) mỗi cuốn = `totalNumbers / bookletCount`.
- **Cụm (cluster/group)**: một nhóm field đại diện 1 vị trí (1 con tem/bìa) đã được người dùng đặt trên tờ in đã bình.
- **Kiểu quét (sortMethod)**: thứ tự duyệt vị trí cụm — `rows` (Z), `cols` (N ngược), `snake` (U), `clockwise` (C ngược).
- **Chế độ chạy (distribution)**: `stack` (cắt chồng) vs `sequential` (tuần tự) — cách số chạy qua các tờ in.
- **Kiểu đánh ruột (innerMode)**: `continuous` (liên tục cả job) vs `reset` (reset về đầu mỗi cuốn).
- **Ruột / Bìa**: hai loại artwork riêng (khác giấy/khổ); KHÔNG tự nhận diện — người dùng gán/chọn.

---

## Requirements

### Yêu cầu 1 — Numbering Job dùng chung (nền tảng đồng bộ)

**User Story:** Là thợ chế bản, tôi muốn khai báo dải số + cách chia cuốn MỘT LẦN rồi dùng cho cả ruột và bìa, để bìa "từ Y đến Z" luôn khớp số ruột thật mà không nhập tay hai lần.

#### Acceptance Criteria
1. WHEN người dùng tạo một Numbering Job THEN hệ thống SHALL lưu các tham số: `startNum`, `endNum`, `padding`, `bookletCount`, `bookletOffset`, `innerMode`, `distribution`, `sortMethod`.
2. WHEN cả chế độ Ruột và chế độ Bìa cùng tham chiếu một Job THEN hệ thống SHALL tính `perBooklet`, dải mỗi cuốn, và thứ tự đánh số từ CÙNG bộ tham số (không nhập trùng).
3. IF `totalNumbers (= endNum - startNum + 1)` không chia hết cho `bookletCount` THEN hệ thống SHALL báo lỗi rõ ràng và gợi ý `bookletCount` hợp lệ gần nhất (port "gợi ý tối ưu" của script).
4. IF `bookletCount <= 0` HOẶC `totalNumbers <= 0` (start > end) THEN hệ thống SHALL từ chối sinh và báo lỗi, KHÔNG treo.
5. WHEN số phần tử cần sinh vượt ngưỡng an toàn (cap) THEN hệ thống SHALL dừng có kiểm soát (không sinh vô hạn) — tái dùng guard của chạy số.

### Yêu cầu 2 — Đánh số RUỘT (mẹc số)

**User Story:** Là thợ in, tôi muốn đánh số các tờ ruột theo đúng thứ tự cắt để sau khi in–cắt–xếp, mỗi cuốn gom đúng một dải số liên tiếp.

#### Acceptance Criteria
1. WHEN chế độ Ruột chạy với Job THEN hệ thống SHALL gán mỗi vị trí cụm một số trong dải `[startNum .. endNum]` theo `sortMethod` + `distribution`.
2. WHERE `innerMode = continuous` THE hệ thống SHALL đánh số liên tục toàn job (cuốn 1: start..start+perBooklet-1; cuốn 2 nối tiếp…).
3. WHERE `innerMode = reset` THE hệ thống SHALL đánh số reset về `startNum` ở mỗi cuốn (mọi cuốn cùng dải `start..start+perBooklet-1`).
4. WHEN `distribution = stack` THEN số SHALL chạy sao cho **chồng các tờ in rồi cắt** ra mỗi chồng con là dải liên tiếp.
5. WHEN `distribution = sequential` THEN số SHALL chạy lấp đầy từng tờ in theo thứ tự (cắt rời từng tờ).
6. WHEN có padding bật THEN mọi số SHALL được đệm 0 theo `padding` (suy từ độ dài chuỗi start hoặc nhập tay).

### Yêu cầu 3 — Đánh số BÌA (mẹc bìa)

**User Story:** Là thợ chế bản, tôi muốn mỗi bìa tự in số cuốn và dải ruột của chính cuốn đó, khớp với ruột đã đánh.

#### Acceptance Criteria
1. WHEN chế độ Bìa chạy với Job THEN mỗi cụm bìa SHALL nhận `{X}` = `bookletOffset + bookletIndex`, `{Y}` = số ruột đầu của cuốn, `{Z}` = số ruột cuối của cuốn.
2. WHERE `innerMode = continuous` THE `{Y}` của cuốn i SHALL = `startNum + i*perBooklet`, `{Z}` = `{Y} + perBooklet - 1`.
3. WHERE `innerMode = reset` THE `{Y}`/`{Z}` SHALL = `startNum`/`startNum + perBooklet - 1` cho MỌI cuốn (chỉ `{X}` đổi).
4. WHEN gán cụm bìa vào vị trí THEN thứ tự `bookletIndex` theo vị trí SHALL tuân theo CÙNG `sortMethod` + `distribution` như ruột (để bìa khớp ruột).
5. WHEN `{X}/{Y}/{Z}` được render THEN giá trị SHALL đi qua VDP render hiện có (giữ font/màu/vị trí, đã verify).

### Yêu cầu 4 — Thứ tự theo vị trí (sortMethod) — đồng nhất ruột & bìa

**User Story:** Là thợ in, tôi muốn chọn kiểu quét (Z/N/U/C) khớp cách bình tờ để số ra đúng vị trí vật lý.

#### Acceptance Criteria
1. WHEN người dùng chọn `sortMethod ∈ {rows, cols, snake, clockwise}` THEN hệ thống SHALL sắp các cụm theo vị trí hình học bằng `sortFieldsGeometrically` (đã có) trước khi gán số.
2. WHEN cùng một Job áp cho ruột và bìa THEN cả hai SHALL dùng CÙNG `sortMethod` để thứ tự khớp nhau.
3. WHERE `sortMethod = clockwise` THE thứ tự SHALL theo chu vi (trên→phải→dưới→trái) như script `reverse-c`.

### Yêu cầu 5 — Đầu vào: 2 file liên kết HOẶC 1 file gán role

**User Story:** Là người dùng, tôi muốn linh hoạt đưa ruột & bìa vào dù là 2 file riêng hay 1 file chung.

#### Acceptance Criteria
1. WHEN người dùng mở ruột và bìa ở **2 tab** THEN hệ thống SHALL cho **liên kết** hai tab vào cùng một Job (chia sẻ tham số).
2. WHEN hai tab liên kết dùng Job có tham số khác nhau (vd perBooklet lệch) THEN hệ thống SHALL **cảnh báo** trước khi sinh.
3. WHERE ruột & bìa nằm trong **1 file** THE hệ thống SHALL cho người dùng **GÁN role theo range trang** (vd trang 1 = bìa, 2..n = ruột); KHÔNG tự nhận diện âm thầm.
4. IF có gợi ý tự động (vd theo khổ trang) THEN hệ thống SHALL chỉ **đề xuất** và yêu cầu người dùng xác nhận, KHÔNG tự quyết.

### Yêu cầu 6 — Verify đồng bộ & ca biên (BẮT BUỘC test)

#### Acceptance Criteria
1. WHEN sinh ruột và bìa từ cùng Job THEN với mỗi cuốn, dải số ruột thực tế SHALL bằng `[{Y} .. {Z}]` của bìa cuốn đó (bất biến đồng bộ).
2. WHEN test generator THEN hệ thống SHALL phủ MỌI tổ hợp: `innerMode {continuous,reset} × distribution {stack,sequential} × sortMethod {rows,cols,snake,clockwise}`.
3. WHEN `bookletCount` không chia hết / `bookletCount<=0` / `start>end` / số lượng khổng lồ THEN test SHALL khẳng định lỗi rõ ràng + không treo + không sinh sai.
4. WHEN `distribution = stack` THEN test SHALL khẳng định: chồng tờ + cắt theo vị trí → dải liên tiếp đúng cuốn.
