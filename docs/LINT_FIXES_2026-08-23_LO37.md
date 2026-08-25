# Lô lint P1.33 — 2026-08-23

## Phạm vi

Tách hằng hỗ trợ khỏi component để giảm 1 lỗi React Refresh trong 4 file:

- `desktop/src/lib/supportContact.ts` (mới)
- `desktop/src/lib/supportContact.test.ts` (mới)
- `desktop/src/components/AboutModal.tsx`
- `desktop/src/App.tsx`

Giữ nguyên shape và 5 giá trị website, trang sản phẩm, email, điện thoại và Zalo.

## Verify

- React Refresh riêng `AboutModal`: sạch.
- ESLint hai module mới: đạt.
- Test contract liên hệ: 1/1 đạt.
- `npm run typecheck`: đạt.
- Diff/whitespace check: đạt.
- `npm run lint:budget`: số tổng sau LO37–38 là 1.267 errors / 103 warnings; riêng LO37 giảm 1 lỗi.

## Kết luận

Mọi consumer `SUPPORT` dùng chung module thuần; nội dung hiển thị và liên kết không đổi.
