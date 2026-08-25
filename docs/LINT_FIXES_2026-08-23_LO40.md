# Lô lint P1.36 — 2026-08-23

## Phạm vi

Tách cấu hình dấu cắt khỏi component để giảm 1 lỗi React Refresh trong 4 file:

- `desktop/src/components/imposition-tools/marksConfig.ts` (mới)
- `desktop/src/components/imposition-tools/marksConfig.test.ts` (mới)
- `desktop/src/components/imposition-tools/MarksSettingsDialog.tsx`
- `desktop/src/components/imposition-tools/store/slices/marksSlice.ts`

Dialog vẫn re-export type `CropMarksConfig`; store dùng module thuần làm nguồn mặc định.

## Verify

- React Refresh của dialog: sạch; 1 lỗi `set-state-in-effect` lịch sử giữ nguyên.
- Test contract cấu hình: 1/1 đạt.
- `npm run typecheck`: đạt.
- Diff/whitespace check: đạt.
- `npm run lint:budget`: số tổng sau LO39–41 là 1.234 errors / 103 warnings; riêng LO40 giảm 1 lỗi.

## Kết luận

Bốn giá trị mặc định và public type không đổi; chỉ tách ranh giới HMR.
