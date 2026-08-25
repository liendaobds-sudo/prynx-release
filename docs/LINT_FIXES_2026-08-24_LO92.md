# Lô LO92 — Viewer context menu helper (2026-08-24)

## Phạm vi

- `desktop/src/components/acrobat/ViewerContextMenu.tsx`
- `desktop/src/components/acrobat/viewerContextMenuUtils.ts`

## Thay đổi

Tách hàm DOM thuần `listOtherOpenPdfTargets` khỏi module JSX menu. Module menu
giữ component và các type contract hiện có; helper mới chỉ đọc marker DOM và trả
cùng cấu trúc mục tiêu. Không đổi cách lọc PDF hiện tại, thứ tự, dedupe, fallback
thumbnail, hay hành vi copy/move.

## Verify

- ESLint hai file: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/acrobat/viewerModalContract.test.tsx`:
  3/3 passed.

Worker/legacy QR không thuộc lô này; chưa commit/push/build release.
