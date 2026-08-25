# Lô lint P1.2 — 2026-08-23

## Phạm vi

Tách hook useDialogLifecycle khỏi module chứa các React modal để React Refresh
không coi hook là export hỗn hợp:

- desktop/src/components/acrobat/AcrobatModals.tsx
- desktop/src/components/acrobat/AcrobatModals2.tsx
- desktop/src/components/acrobat/CrossFileInsertModal.tsx
- desktop/src/components/acrobat/dialogLifecycle.ts

Không đổi hành vi focus, vòng Tab, Escape hoặc restore focus.

## Verify

- ESLint 4 file: không còn finding React Refresh; còn 2 finding baseline ở
  consumer (any và set-state-in-effect), không phát sinh từ refactor.
- Acrobat suite: 7 file, 44 test đạt.
- Modal contract: 3 test đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.469 -> 1.468; React Refresh 60 -> 59;
  warnings giữ 108; gate vẫn fail vì 59 > 32.
- git diff --check: đạt.

## Kết luận

Refactor chỉ chuyển helper dùng chung sang module riêng và cập nhật hai consumer.
Chưa build release, commit hoặc push. Lô tiếp theo phải tiếp tục theo nhóm file
sạch, không trộn vào các file feature đang dirty.
