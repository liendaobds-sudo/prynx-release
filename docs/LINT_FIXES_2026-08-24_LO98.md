# Lô LO98 — Tách shader Spot-UV khỏi SolidPanelMesh (2026-08-24)

## Phạm vi

- `desktop/src/components/dieline-tool/SolidPanelMesh.tsx`
- `desktop/src/components/dieline-tool/surfaceFinishShader.ts`
- `desktop/src/components/dieline-tool/__tests__/surfaceFinishShader.test.ts`

## Thay đổi

Tách ba hàm patch shader Spot-UV khỏi component R3F sang helper thuần; cập nhật
SolidPanelMesh và test import module mới. Công thức thay thế roughness/clearcoat,
ngưỡng mask và hằng số vật liệu giữ nguyên từng giá trị. Đây chỉ là thay đổi
module boundary để Fast Refresh không cảnh báo.

## Verify

- ESLint ba file: đạt, ba finding React Refresh của SolidPanelMesh đã hết.
- `npm run typecheck`: đạt.
- Shader + render wiring tests: 25/25 passed.

Không đổi geometry/UV/material runtime ngoài việc gọi cùng helper; chưa commit/push/build
release.
