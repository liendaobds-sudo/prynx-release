# Lô lint P2.41 — 2026-08-23

## Phạm vi

Audit dọc 7 finding `no-unused-vars` trong `DielineCanvas2D` cho thấy phần lớn
là consumer UI bị ngắt, không phải mã cần xóa. Lô chạm 2 file:

- `desktop/src/components/dieline-tool/DielineCanvas2D.tsx`
- `desktop/src/components/dieline-tool/__tests__/DielineCanvas2D.interaction.test.tsx`

Đã nối lại thumbnail trong chế độ 2D đơn, nối chú thích kích thước sleeve theo
stack `G/W/D/W/D` của generator live và chỉ xóa helper `screenToSvg` thật sự
không có consumer. Chế độ chia đôi vẫn dùng preview 3D thật, không nhân đôi nhãn.

## Verify

- `no-unused-vars` trong file: sạch.
- Test tương tác DielineCanvas2D: 5/5 đạt.
- Toàn bộ test `src/lib/dieline`: 582 đạt, 2 skipped.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- Không cập nhật snapshot.
- `npm run lint:budget`: số tổng sau LO45–46 là 1.202 errors / 103 warnings; riêng LO45 giảm 7 lỗi.

## Kết luận

Skill dieline làm thay đổi cách xử lý lô này: hai consumer hình học/UI được phục
hồi và khóa regression, chỉ helper trùng mới bị xóa.
