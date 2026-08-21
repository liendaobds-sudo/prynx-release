# Bản vá va chạm L-shape một dao — 2026-08-20

## Phạm vi

- Bình tem bế tứ giác/chữ nhật một dao bằng chiến lược L-shape.
- Va chạm giữa khối chính/khối phụ và vùng cấm ốc, đặc biệt ở hở tem `0 mm`.
- Parity vị trí giữa preview và worker xuất.

## Oracle của file người dùng

File `Thu Hồng 1 hộp card kt 5x9cm ok.png`:

- `1063×591 px` ở `299.9994 DPI`.
- Kích thước vật lý `90.00084×50.03811 mm`.
- Preset: tờ `320×430 mm`, lề giấy `5 mm`, ốc tròn `5 mm`, lề ốc `7 mm`.

Ở hở `0 mm`, solver sinh 27 placement thô:

```text
block 0 (chính): 24 = 4 hàng × 6
block 2 (phụ đáy): 3
```

Kết quả đúng sau collision:

```text
block 0 (chính): 23 = 3 hàng × 6 + 1 hàng biên × 5, canh tâm riêng
block 2 (phụ đáy): 3, giữ nguyên
tổng: 26 tem/tờ
```

Harness cho cùng artifact/preset trả `26 tem/tờ` ở cả hở `0`, `0.5` và `1 mm`.

Với preset `A3 lỡ 320×450 mm`, lề `3 mm`, cùng cấu hình ốc, oracle khác là
`27 tem/tờ` ở cả hở `0` và `2 mm`. Gap 0 từng chọn nhầm candidate main 21 +
aux 6 cao khoảng `440.268 mm`, va ốc rồi bị xóa còn 25. Candidate đúng là
main xoay 24 + aux đáy 3, cao khoảng `410.041 mm`, sạch va chạm.

## Thay đổi đã áp dụng

1. Giữ `blockId=0/1/2` do solver L-shape phát qua `finalize_placements()`.
2. Dựng footprint collision theo kích thước hiệu dụng của từng placement, gồm khối phụ xoay 90°.
3. Khi chính khối phụ va ốc, thử dịch cứng nguyên `blockId=1/2`; không xóa/dồn riêng từng tem trước.
4. Khi va chạm còn ở khối chính, reflow riêng `blockId=0` trong bounding box của chính nó:
   - Aux đáy ưu tiên xử lý hàng.
   - Aux phải ưu tiên xử lý cột.
   - Aux giữ nguyên khi ghép lại.
5. Không dùng phép dịch toàn hình L làm kết quả cuối cho ca file thật; tâm tạm sau finalize không còn kéo anchor reflow của khối chính.
6. Tách ngưỡng va ốc `PONT_COLLISION_EPS_PT2 = 1e-9` khỏi ngưỡng overlap tem–tem. Tiếp tuyến/diện tích sai số số học không còn bị tính là va chạm.
7. Preview tương đối đổi lại `abs_x/abs_y` sau resolve về `x/y`, nên không làm rơi phép dịch hoặc canh giữa.
8. Chỉ nhận ứng viên cuối khi toàn layout hết va ốc và không có tem chồng nhau.
9. Đồng bộ Rust/Python ở bước canh giữa khối hẹp theo trục ghép; layout không còn lệch trước collision.
10. Khi hòa sản lượng ở mọi gap, chọn candidate có mép thoáng/footprint gọn hơn; không tạo vách rơi ngay trên gap 0.

## Regression hẹp

Đã chạy:

```text
backend/venv/Scripts/python.exe -m pytest \
  -p no:cacheprovider \
  tests/test_pont_collision_lshape_auxiliary_reflow.py -q
```

Kết quả: **14 passed**.

Các assertion quan trọng:

- File thật: 27 → 26.
- Main: 24 → 23, đúng phân bố `[5, 6, 6, 6]`.
- Hàng 5 tem có tâm trùng tâm khổ theo trục ngang.
- Aux đáy vẫn đủ 3 tem và giữ nguyên tọa độ.
- Kết quả không còn va ốc và không overlap tem–tem.
- Dịch khối phụ phải/đáy ở gap 0 giữ nguyên số tem trong các ca chuyên biệt.
- Layout có block phụ trộn hướng không bị nhận nhầm là L-shape một dao.
- Preview tương đối giữ đúng vị trí đã resolve.
- A3 lỡ gap `0/0.5/1/2`: cùng main xoay 24 + aux đáy 3, tổng 27; native và Python khớp nhau.

## Verify diện rộng

- Regression collision, N-up, pont/CNC, solver và golden: **141 passed**.
- Lõi Rust: **38 passed** (`37` unit + `1` parity).
- Smoke endpoint thật ở gap `0/0.5/1 mm`: 26 cell, không trùng, không tràn,
  không va ốc và giữ thứ tự placement sống sót.
- Smoke endpoint A3 lỡ ở gap `0/0.5/1/2 mm`: đều 27 cell, main xoay 24 + aux đáy 3.
- `py_compile` cho `pont_collision.py`, `imposition_finalize.py`, `imposition.py`: đạt.
- `git diff --check` cho phạm vi bản vá: đạt.

## Giới hạn xác minh

- Chưa tuyên bố kết quả cho full backend suite trong log này.
- Đối chiếu pixel PDF xuất cuối/Tauri runtime là bước thủ công riêng nếu cần trước phát hành.
- Candidate có đồng thời fill phải + fill đáy vẫn có finding overlap riêng §LS-PONT.8;
  file Thu Hồng không đi cấu trúc này và finding được tách lô để tránh đổi rộng không kiểm soát.
