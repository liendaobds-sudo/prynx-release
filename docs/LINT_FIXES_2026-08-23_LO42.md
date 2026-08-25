# Lô lint P2.38 — 2026-08-23

## Phạm vi

Dọn 18/19 finding `no-unused-vars` trong `desktop/src/components/ImpositionTab.tsx`:

- Bỏ import, binding selector/store và alias không có consumer.
- Bỏ helper `getWorkingBytes` chết; luồng live dùng `getWorkingFile`/`applyAcrobatEdits` riêng.
- Loại File khỏi recipe merge bằng xóa khóa tương đương, không giữ binding giả.
- Thu hẹp callback extract về tham số thực sự dùng; AcrobatViewer vẫn sở hữu `deleteAfter`.

Giữ lại `handleReset`: đây là đường duy nhất mở modal xác nhận đóng file chưa lưu
nhưng hiện không có consumer. Xóa nó sẽ che dấu một trigger UI có thể đang bị ngắt.

## Verify

- `no-unused-vars`: 19 → 1; helper chết bị bỏ đồng thời giảm thêm 1 `no-explicit-any`.
- Test dashboard/viewer/imposition + recipe: 8 file, 46/46 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.231 → 1.212 errors; warnings giữ 103.

## Kết luận

Giảm 19 lỗi tổng trong một file mà không xóa ý đồ bảo vệ tài liệu chưa lưu;
`handleReset` được giữ làm finding cần audit dây UI riêng.
