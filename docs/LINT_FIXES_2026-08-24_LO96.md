# Lô LO96 — Tách camera preset helper (2026-08-24)

## Phạm vi

- `desktop/src/components/dieline-tool/CameraRig.tsx`
- `desktop/src/components/dieline-tool/cameraRigPresets.ts`
- `desktop/src/components/dieline-tool/useSceneExport.ts`

## Thay đổi

Tách `PRESETS`, `computeTargetPose` và easing camera khỏi component R3F; cập nhật
`useSceneExport` dùng module helper mới. Giá trị FOV, hướng camera, hệ số khoảng
cách và giới hạn chuyển cảnh giữ nguyên. Component vẫn chỉ đảm nhiệm hook/render
camera, còn helper thuần không gây cảnh báo Fast Refresh.

Trong verify vòng đầu, test phát hiện thiếu hàm easing sau khi tách; hàm đã được
đưa vào helper và import rõ ràng trước khi chốt.

## Verify

- ESLint `CameraRig.tsx` + `cameraRigPresets.ts`: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/components/dieline-tool/__tests__/renderWiring.integration.test.ts`:
  21/21 passed.

Không thay đổi hình học khuôn; không cập nhật golden snapshot, không commit/push/build
release.
