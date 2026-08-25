# Lô LO91 — Dọn suppression thừa ở GussetMesh (2026-08-24)

## Phạm vi

`desktop/src/components/dieline-tool/GussetMesh.tsx`.

## Thay đổi

Xóa đúng ba dòng `eslint-disable-next-line react-hooks/exhaustive-deps` mà ESLint
xác nhận không che finding nào. Không thay đổi dependency, hình học gusset,
winding, vật liệu, thứ tự gập hay render CAD.

## Verify

- ESLint file: đạt, không còn warning suppression.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/dieline-tool/__tests__/renderWiring.integration.test.ts`:
  21/21 passed.

Đây là thay đổi comment-only; không cập nhật golden snapshot, không commit/push/build
release.
