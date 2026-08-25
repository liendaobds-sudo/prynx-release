# Lô LO97 — Tách preset EnvironmentRig (2026-08-24)

## Phạm vi

- `desktop/src/components/dieline-tool/EnvironmentRig.tsx`
- `desktop/src/components/dieline-tool/environmentPresets.ts`
- `desktop/src/components/dieline-tool/MockupPanel.tsx`
- `desktop/src/components/dieline-tool/__tests__/noNetwork.integration.test.ts`

## Thay đổi

Tách `HdriPreset`, `HDRI_PRESETS` và `getHdriPreset` sang module dữ liệu thuần;
cập nhật panel và test import từ module mới. Toàn bộ preset, màu, vị trí
Lightformer, fallback và contract không-network giữ nguyên. Component vẫn giữ
timeout/error boundary.

## Verify

- ESLint lô: các finding React Refresh của EnvironmentRig đã hết; còn một finding
  `react-hooks/refs` cũ tại phép cập nhật `currentPresetRef` trong render, để lô
  vòng đời hook riêng.
- `npx vitest run src/components/dieline-tool/__tests__/noNetwork.integration.test.ts`:
  8/8 passed.
- `npm run typecheck`: đạt.

Không thay đổi geometry/golden snapshot; chưa commit/push/build release.
