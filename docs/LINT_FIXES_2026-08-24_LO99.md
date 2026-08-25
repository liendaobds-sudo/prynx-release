# Lô LO99 — Vòng đời fallback EnvironmentRig (2026-08-24)

## Phạm vi

`desktop/src/components/dieline-tool/EnvironmentRig.tsx`.

## Thay đổi

- Bỏ `currentPresetRef` không có consumer.
- Thay `setFailed(false)` đồng bộ trong effect bằng state có khóa
  `presetId-resolution`; khi môi trường đổi, trạng thái lỗi cũ tự động không còn
  áp dụng. Timeout/error callback ghi đúng khóa hiện tại.
- Cập nhật dependency `environmentKey` của callback/effect để React Compiler và
  exhaustive-deps phản ánh đúng vòng đời.

Fallback đèn, timeout 10 giây, trạng thái `loading/ready/failed` và no-network
contract giữ nguyên.

## Verify

- ESLint EnvironmentRig + helper: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/dieline-tool/__tests__/noNetwork.integration.test.ts`:
  8/8 passed.

Chưa commit/push/build release.
