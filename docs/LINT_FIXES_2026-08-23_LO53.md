# Lô lint P2.49 — 2026-08-23

## Phạm vi

Thu hẹp bốn `no-explicit-any` có contract tĩnh rõ:

- `AcrobatModals2`: giá trị vị trí chèn dùng union `'after' | 'before'`.
- `PresetSelector`: nhóm preset chỉ đọc nhận `object`.
- `OutputSettingsSection`: cast select dùng type sinh `CutType` (`default | one_dao`).
- `coverNumberingPlanner`: item sort tối thiểu có `id: string`.

Không đổi giá trị lựa chọn, payload preset, cài đặt dao cắt hoặc thứ tự cụm.

## Verify

- ESLint hẹp: 4 file còn 0 `no-explicit-any` mục tiêu.
- Modal/acrobat + imposition + cover numbering: 27 file test, 222/222 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.181 → 1.177 errors; warnings giữ 103.

## Kết luận

Lô chỉ thay kiểu tĩnh tại boundary đã có hợp đồng; hành vi runtime giữ nguyên.
