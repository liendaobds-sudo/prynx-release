# Lô lint P1.32 — 2026-08-23

## Phạm vi

Giảm 4 lỗi `react-refresh/only-export-components` trong đúng 5 file:

- `desktop/src/components/workspace/ExportImageModal.tsx`
- `desktop/src/components/workspace/exportImagePlan.ts` (mới)
- `desktop/src/components/workspace/ExportImageModal.test.ts`
- `desktop/src/components/ui/Toast.tsx`
- `desktop/src/components/ui/confirmDialog.tsx`

Hai helper lập kế hoạch xuất ảnh được chuyển nguyên hành vi sang module thuần.
`toast` và `confirmDialog` dùng suppression đúng một dòng, có lý do: API mệnh
lệnh/Promise và host component phải dùng chung một Zustand store.

## Verify

- Rule React Refresh trong 5 file: sạch; 3 lỗi `no-explicit-any` lịch sử của modal giữ nguyên cho lô contract riêng.
- Test `ExportImageModal`: 7/7 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.284 → 1.273 errors; warnings giữ 103. Delta gồm LO35 chạy đồng thời; riêng LO36 giảm 4 lỗi.

## Kết luận

Không đổi kế hoạch batch, range trang, Toast hoặc Confirm runtime; chỉ tách ranh giới HMR và ghi nhận hai ngoại lệ có chủ đích.
