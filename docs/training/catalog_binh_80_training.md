# Tài liệu training: Bài bình catalog ghim giữa 80 trang

## 0) Phạm vi và giả định
- Loại thành phẩm: **catalog / brochure bấm ghim giữa**.
- Bài gốc người dùng cung cấp là trường hợp **bìa và ruột khác chất liệu**.
- Cách hiểu đang dùng trong tài liệu này:
  - **Tổng 80 mặt thành phẩm**.
  - **Bìa ngoài** không đánh số.
  - **Mặt trong bìa** mang số **1** và **78**.
  - Ruột các tay in rời vì vậy chạy từ **2 đến 77**.
  - Quy luật đối trang của toàn block số là: **hai trang đối nhau cộng 79**.
- Nếu job thực tế của bạn quy ước số trang khác (ví dụ 80 trang ruột + bìa riêng), phải tính lại theo công thức ở mục 6.

**Nguồn sơ đồ gốc**  
[1A–1B](https://www.genspark.ai/api/files/s/5T8563p9)  
[2A–2B](https://www.genspark.ai/api/files/s/WxuNljyw)  
[3A–3B](https://www.genspark.ai/api/files/s/cNx2mpgj)  
[4A–4B](https://www.genspark.ai/api/files/s/086TTa8q)  
[Bìa tự trở](https://www.genspark.ai/api/files/s/awF9RqXa)  
[8 trang lẻ tự trở](https://www.genspark.ai/api/files/s/QaW12ht6)  
[4 trang lẻ tự trở](https://www.genspark.ai/api/files/s/VNV70Wuq)

---

## 1) Tóm tắt chính
- Cấu trúc bài là **đúng về nguyên lý**: bìa riêng, ruột chia **16 + 16 + 16 + 16 + 8 + 4**.
- Bộ sơ đồ gốc có **2 lỗi cần sửa**:
  1. **4B bị sai** (đang lặp nhầm nhóm của 3B).
  2. **8 trang lẻ tự trở bị sai / bị dán nhầm**.
- Sau khi sửa, bộ bài hợp lý sẽ là:
  - **Bìa tự trở**: bìa trước, bìa sau, 1, 78
  - **4 trang lẻ tự trở**: 2, 3, 76, 77
  - **8 trang lẻ tự trở**: 4, 5, 6, 7, 72, 73, 74, 75
  - **4A–4B**: 8–15 và 64–71
  - **3A–3B**: 16–23 và 56–63
  - **2A–2B**: 24–31 và 48–55
  - **1A–1B**: 32–47

---

## 2) Bảng siêu gọn 1 trang

> Mục đích: gửi thẳng cho chế bản / nhà in.  
> Ghi chú: cột **Mặt** dùng cho A/B hoặc ngoài/trong bìa. Với **tự trở**, một bình được in rồi trở giấy.

| Tay in | Kiểu chạy | Mặt | Các trang chứa | Ghi chú dễ nhớ |
|---|---|---|---|---|
| Bìa | Tự trở | Ngoài + trong | Bìa trước, bìa sau, 1, 78 | Bìa riêng vì khác chất liệu |
| 4 trang lẻ | Tự trở | 1 bình + trở | 2, 3, 76, 77 | Đúng theo logic bài gốc |
| 8 trang lẻ | Tự trở | 1 bình + trở | 4, 5, 6, 7, 72, 73, 74, 75 | Phải sửa lại, file gốc đang sai |
| 4 | A/B | 4A | 9, 10, 13, 14, 65, 66, 69, 70 | Đúng theo file gốc |
| 4 | A/B | 4B | 8, 11, 12, 15, 64, 67, 68, 71 | **Bản đúng phải thay cho file gốc** |
| 3 | A/B | 3A | 17, 18, 21, 22, 57, 58, 61, 62 | Đúng theo file gốc |
| 3 | A/B | 3B | 16, 19, 20, 23, 56, 59, 60, 63 | Đúng theo file gốc |
| 2 | A/B | 2A | 25, 26, 29, 30, 49, 50, 53, 54 | Đúng theo file gốc |
| 2 | A/B | 2B | 24, 27, 28, 31, 48, 51, 52, 55 | Đúng theo file gốc |
| 1 | A/B | 1A | 33, 34, 37, 38, 41, 42, 45, 46 | Đúng theo file gốc |
| 1 | A/B | 1B | 32, 35, 36, 39, 40, 43, 44, 47 | Đúng theo file gốc |

### 2.1) Mapping chi tiết theo ô (TL/TR/BL/BR)

#### Bìa tự trở (khái niệm)
> Bìa tự trở phụ thuộc đầu nhíp, nên có thể **soi gương trái-phải** giữa các máy. Cái phải giữ là **tập nội dung**:
- **Ngoài bìa**: bìa trước / bìa sau
- **Trong bìa**: 1 / 78

#### 4 trang lẻ tự trở
- Cụm trái: **TL 76 / TR 3 / BL 3 / BR 76**
- Cụm phải: **TL 2 / TR 77 / BL 77 / BR 2**

#### 8 trang lẻ tự trở (bản dựng đúng, khuyến nghị)
- Cụm trái: **TL 74 / TR 5 / BL 7 / BR 72**
- Cụm phải: **TL 4 / TR 75 / BL 73 / BR 6**

> Lưu ý: cụm 8 trang lẻ có thể đổi trái-phải toàn cụm khi đổi đầu nhíp / kiểu trở, nhưng **tập trang bắt buộc vẫn là 4, 5, 6, 7, 72, 73, 74, 75**.

#### 4A
- Cụm trái: **TL 70 / TR 9 / BL 69 / BR 10**
- Cụm phải: **TL 13 / TR 66 / BL 65 / BR 14**

#### 4B (bản đúng)
- Cụm trái: **TL 12 / TR 67 / BL 15 / BR 64**
- Cụm phải: **TL 71 / TR 8 / BL 11 / BR 68**

#### 3A
- Cụm trái: **TL 62 / TR 17 / BL 61 / BR 18**
- Cụm phải: **TL 21 / TR 58 / BL 57 / BR 22**

#### 3B
- Cụm trái: **TL 20 / TR 59 / BL 23 / BR 56**
- Cụm phải: **TL 63 / TR 16 / BL 19 / BR 60**

#### 2A
- Cụm trái: **TL 54 / TR 25 / BL 53 / BR 26**
- Cụm phải: **TL 29 / TR 50 / BL 49 / BR 30**

#### 2B
- Cụm trái: **TL 28 / TR 51 / BL 31 / BR 48**
- Cụm phải: **TL 55 / TR 24 / BL 27 / BR 52**

#### 1A
- Cụm trái: **TL 46 / TR 33 / BL 45 / BR 34**
- Cụm phải: **TL 37 / TR 42 / BL 41 / BR 38**

#### 1B
- Cụm trái: **TL 36 / TR 43 / BL 39 / BR 40**
- Cụm phải: **TL 47 / TR 32 / BL 35 / BR 44**

---

## 3) Sơ đồ ASCII toàn bộ bài bình

### 3.1) Quy ước
- `ĐẦU/KẸP GIẤY` = phía kẹp nhíp máy.
- `ĐUÔI GIẤY` = phía đuôi tờ.
- Dấu `↺` = ô ở hàng trên đang xoay 180° so với hàng dưới.
- Khi đổi đầu nhíp / đổi kiểu trở, **toàn sơ đồ có thể soi gương trái-phải**, nhưng **tập trang của từng tay không đổi**.

### 3.2) Bìa tự trở (khái niệm, có thể soi gương)

```text
BÌA TỰ TRỞ (KHÁI NIỆM)
ĐẦU/KẸP GIẤY
┌─────────────── NGOÀI BÌA ───────────────┐   ┌─────────────── TRONG BÌA ───────────────┐
│ bìa sau ↺      | bìa trước ↺            │   │ 78 ↺            | 1 ↺                  │
│----------------+------------------------│   │-----------------+----------------------│
│ bìa trước      | bìa sau                │   │ 1               | 78                   │
└─────────────────────────────────────────┘   └────────────────────────────────────────┘
ĐUÔI GIẤY
```

### 3.3) 4 trang lẻ tự trở

```text
4 TRANG LẺ TỰ TRỞ
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 76 ↺ | 3 ↺    │   │ 2 ↺  | 77 ↺   │
│------+--------│   │------+--------│
│ 3    | 76     │   │ 77   | 2      │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.4) 8 trang lẻ tự trở (bản dựng đúng, khuyến nghị)

```text
8 TRANG LẺ TỰ TRỞ
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 74 ↺ | 5 ↺    │   │ 4 ↺  | 75 ↺   │
│------+--------│   │------+--------│
│ 7    | 72     │   │ 73   | 6      │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.5) 4A

```text
4A
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 70 ↺ | 9 ↺    │   │ 13 ↺ | 66 ↺   │
│------+--------│   │------+--------│
│ 69   | 10     │   │ 65   | 14     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.6) 4B (bản đúng)

```text
4B
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 12 ↺ | 67 ↺   │   │ 71 ↺ | 8 ↺    │
│------+--------│   │------+--------│
│ 15   | 64     │   │ 11   | 68     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.7) 3A

```text
3A
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 62 ↺ | 17 ↺   │   │ 21 ↺ | 58 ↺   │
│------+--------│   │------+--------│
│ 61   | 18     │   │ 57   | 22     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.8) 3B

```text
3B
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 20 ↺ | 59 ↺   │   │ 63 ↺ | 16 ↺   │
│------+--------│   │------+--------│
│ 23   | 56     │   │ 19   | 60     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.9) 2A

```text
2A
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 54 ↺ | 25 ↺   │   │ 29 ↺ | 50 ↺   │
│------+--------│   │------+--------│
│ 53   | 26     │   │ 49   | 30     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.10) 2B

```text
2B
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 28 ↺ | 51 ↺   │   │ 55 ↺ | 24 ↺   │
│------+--------│   │------+--------│
│ 31   | 48     │   │ 27   | 52     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.11) 1A

```text
1A
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 46 ↺ | 33 ↺   │   │ 37 ↺ | 42 ↺   │
│------+--------│   │------+--------│
│ 45   | 34     │   │ 41   | 38     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

### 3.12) 1B

```text
1B
ĐẦU/KẸP GIẤY
┌───────────────┐   ┌───────────────┐
│ 36 ↺ | 43 ↺   │   │ 47 ↺ | 32 ↺   │
│------+--------│   │------+--------│
│ 39   | 40     │   │ 35   | 44     │
└───────────────┘   └───────────────┘
ĐUÔI GIẤY
```

---

## 4) Checklist kiểm bài bình ghim giữa trước khi xuất kẽm

### 4.1) Kiểm số trang
- [ ] Đã chốt rõ **đếm theo mặt thành phẩm hay theo trang đánh số**.
- [ ] Đã chốt rõ **bìa có chạy riêng hay không**.
- [ ] Đã chốt rõ **mặt trong bìa có tính số hay không**.
- [ ] Tổng ruột sau khi tách bìa vẫn là **bội số của 4**.
- [ ] Tất cả các form cộng lại **không thiếu trang, không trùng trang**.

### 4.2) Kiểm đối trang / quy luật cặp trang
- [ ] Xác định đúng **tổng cặp**.
- [ ] Với bài này: mọi cặp phải cộng **79**.
- [ ] Kiểm ngẫu nhiên ít nhất 6 cặp: 2↔77, 3↔76, 8↔71, 12↔67, 39↔40, 1↔78.
- [ ] Nếu có cặp nào lệch tổng, form đó đang sai.

### 4.3) Kiểm A/B
- [ ] Mỗi tay 16 trang có đủ **mặt A** và **mặt B**.
- [ ] A và B cùng thuộc **một block trang**, không nhảy block.
- [ ] Không có hiện tượng **mặt B lặp nhầm block của tay khác**.
- [ ] Với bài này, cần kiểm đặc biệt: **4B không được lặp 3B**.

### 4.4) Kiểm tự trở
- [ ] Bìa tự trở đúng logic ngoài / trong bìa.
- [ ] 4 trang lẻ tự trở đúng tập trang ngoài cùng của ruột.
- [ ] 8 trang lẻ tự trở đúng tập trang kế tiếp của ruột.
- [ ] Đã chốt **đầu nhíp / kiểu trở** với nhà in.
- [ ] Nếu đổi đầu nhíp, chỉ được **soi gương toàn cụm**, không được đổi tập trang.

### 4.5) Kiểm bìa khác chất liệu
- [ ] Bìa được tách job riêng.
- [ ] Xác nhận đúng giấy, định lượng, chiều xơ, cán/UV/ép kim nếu có.
- [ ] Kiểm độ dày bìa có ảnh hưởng đến xén 3 cạnh và bụng sách.
- [ ] Kiểm bìa trước / bìa sau / trong bìa không lẫn vào ruột.

### 4.6) Kiểm creep (xô bụng / ăn vào gáy)
- [ ] Số lượng lồng tay đã đủ để phải tính creep chưa.
- [ ] Các tay gần giữa đã được bù creep lớn hơn tay ngoài.
- [ ] Hình / chữ sát mép trong không bị ăn vào sau xén.
- [ ] Số trang, đầu đề chạy, chân trang không bị lệch nhìn thấy.
- [ ] Nếu catalog dày, có bản proof hoặc dummy gấp ghim để kiểm thực tế.

### 4.7) Kiểm chừa xén / an toàn nội dung
- [ ] Bleed đủ theo tiêu chuẩn nhà in.
- [ ] Nội dung quan trọng nằm trong safe zone.
- [ ] Ảnh tràn nền không bị hở trắng khi xén.
- [ ] Các đường cắt, dấu màu, dấu đăng ký nằm đúng vùng kỹ thuật.
- [ ] Bài bình có tính đến dung sai xén 3 cạnh sau ghim.

### 4.8) Kiểm thực chiến trước khi xuất kẽm
- [ ] In proof thu nhỏ hoặc in laser mockup.
- [ ] Gấp - lồng - ghim thử ít nhất 1 bộ.
- [ ] Lật nhanh từ đầu đến cuối để bắt lỗi nhảy trang.
- [ ] Kiểm đúng chiều đọc tất cả mặt trên / mặt dưới.
- [ ] Chốt lần cuối với chế bản: **block trang, đầu nhíp, kiểu trở, bìa riêng**.

---

## 5) Nguyên lý ngắn gọn để training

### 5.1) Công thức lõi
1. Xác định **block trang thật sự** đang chạy trong từng job.
2. Xác định **tổng cặp đối trang**.
3. Tách tay theo ưu tiên **16 → 8 → 4**.
4. Mỗi tay phải phủ kín block của nó, **không trùng, không sót**.
5. A/B hay tự trở chỉ là **cách chạy máy**, không làm đổi toán trang.

### 5.2) Công thức tổng cặp
Nếu block số chạy từ `a` đến `b` thì:

`trang đối nhau = tổng cặp = a + b`

Ví dụ:
- Block 1–78 → tổng cặp 79
- Block 2–77 → tổng cặp 79
- Block 1–76 → tổng cặp 77
- Block 1–40 → tổng cặp 41

### 5.3) Công thức tách tay
- Tổng trang của **mỗi job in riêng** phải là **bội số của 4**.
- Ưu tiên chia theo: **16 trang**, nếu dư thì thêm **8 trang**, nếu còn dư thì thêm **4 trang**.
- Một số tổng thường gặp:
  - 40 = 16 + 16 + 8
  - 48 = 16 + 16 + 16
  - 64 = 16 + 16 + 16 + 16
  - 72 = 16 + 16 + 16 + 16 + 8
  - 80 = 16 + 16 + 16 + 16 + 16
  - 96 = 16 × 6

---

## 6) Quy tắc áp dụng cho catalog 40 / 48 / 64 / 72 / 80 / 96 trang

### 6.1) Trường hợp A: bìa **cùng chất liệu** với ruột (self-cover hoặc không cần tách riêng)
- Toàn bộ cuốn đi như **một block duy nhất**.
- Nếu tổng trang là `N`, cặp đối nhau có tổng: **N + 1**.
- Chia tay trên chính `N` trang đó.

| Tổng trang | Tổng cặp đối trang | Gợi ý chia tay |
|---:|---:|---|
| 40 | 41 | 16 + 16 + 8 |
| 48 | 49 | 16 + 16 + 16 |
| 64 | 65 | 16 + 16 + 16 + 16 |
| 72 | 73 | 16 + 16 + 16 + 16 + 8 |
| 80 | 81 | 16 + 16 + 16 + 16 + 16 |
| 96 | 97 | 16 + 16 + 16 + 16 + 16 + 16 |

### 6.2) Trường hợp B1: bìa **khác chất liệu**, mặt trong bìa **có tính số**
- Bìa chạy riêng.
- Tổng thành phẩm là `N` mặt.
- Bìa chứa: **bìa trước, bìa sau, 1, N-2**.
- Ruột rời chứa: **2 đến N-3**.
- Cặp đối nhau của block số: **N - 1**.
- Phần ruột rời để chia tay có số lượng: **N - 4**.

| Tổng thành phẩm | Block số toàn cuốn | Tổng cặp | Ruột rời để chia tay | Gợi ý chia tay ruột |
|---:|---|---:|---:|---|
| 40 | 1–38 | 39 | 36 | 16 + 16 + 4 |
| 48 | 1–46 | 47 | 44 | 16 + 16 + 8 + 4 |
| 64 | 1–62 | 63 | 60 | 16 + 16 + 16 + 8 + 4 |
| 72 | 1–70 | 71 | 68 | 16 + 16 + 16 + 16 + 4 |
| 80 | 1–78 | 79 | 76 | 16 + 16 + 16 + 16 + 8 + 4 |
| 96 | 1–94 | 95 | 92 | 16 + 16 + 16 + 16 + 16 + 8 + 4 |

### 6.3) Trường hợp B2: bìa **khác chất liệu**, bìa **không tính số**
- Bìa chạy riêng hoàn toàn.
- Ruột là block **1 đến N-4**.
- Cặp đối nhau trong ruột: **N - 3**.
- Số lượng ruột để chia tay vẫn là **N - 4**.

| Tổng thành phẩm | Ruột đánh số | Tổng cặp ruột | Gợi ý chia tay ruột |
|---:|---|---:|---|
| 40 | 1–36 | 39 | 16 + 16 + 4 |
| 48 | 1–44 | 45 | 16 + 16 + 8 + 4 |
| 64 | 1–60 | 61 | 16 + 16 + 16 + 8 + 4 |
| 72 | 1–68 | 69 | 16 + 16 + 16 + 16 + 4 |
| 80 | 1–76 | 77 | 16 + 16 + 16 + 16 + 8 + 4 |
| 96 | 1–92 | 93 | 16 + 16 + 16 + 16 + 16 + 8 + 4 |

### 6.4) So sánh nhanh: bìa cùng vs khác chất liệu

| Tiêu chí | Bìa cùng chất liệu | Bìa khác chất liệu |
|---|---|---|
| Cách xử lý | Có thể đi chung 1 block | Nên tách bìa riêng |
| Tổng cặp | `N + 1` | Tùy cách đánh số bìa: thường là `N - 1` hoặc `N - 3` |
| Số job in | Ít hơn | Nhiều hơn |
| Kiểm soát hoàn thiện bìa | Kém linh hoạt hơn | Linh hoạt hơn |
| Phù hợp cán/ép kim/UV riêng | Kém | Tốt |
| Rủi ro lẫn bìa vào ruột | Thấp | Phải kiểm riêng |
| Kiểm creep | Trên toàn block | Trên ruột rời + kiểm ăn vào bìa |

---

## 7) Kết luận để dùng training
- Với bài 80 mặt thành phẩm đang xét, cấu trúc chuẩn là:
  - **Bìa tự trở**
  - **4 trang lẻ tự trở**
  - **8 trang lẻ tự trở**
  - **4 tay 16 trang A/B**
- **4B đúng** phải là:
  - Trái: **12 | 67 / 15 | 64**
  - Phải: **71 | 8 / 11 | 68**
- **8 trang lẻ tự trở đúng** phải chứa:
  - **4, 5, 6, 7, 72, 73, 74, 75**
- Mẹo kiểm nhanh nhất:
  1. Xác định block số.
  2. Tính tổng cặp.
  3. So từng form xem có phủ kín block không.
  4. Bất cứ form nào làm **trùng trang / sót trang / lệch tổng cặp** là sai.

---

## 8) Danh sách nguồn tham chiếu gốc
- 1A–1B: https://www.genspark.ai/api/files/s/5T8563p9
- 2A–2B: https://www.genspark.ai/api/files/s/WxuNljyw
- 3A–3B: https://www.genspark.ai/api/files/s/cNx2mpgj
- 4A–4B: https://www.genspark.ai/api/files/s/086TTa8q
- Bìa tự trở: https://www.genspark.ai/api/files/s/awF9RqXa
- 8 trang lẻ tự trở: https://www.genspark.ai/api/files/s/QaW12ht6
- 4 trang lẻ tự trở: https://www.genspark.ai/api/files/s/VNV70Wuq
