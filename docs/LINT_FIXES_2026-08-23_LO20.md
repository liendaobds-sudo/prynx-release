# Lô lint P2.16 — 2026-08-23

## Phạm vi

Thay explicit any bằng kiểu có contract trong 2 file:

- desktop/src/components/preprocess-tools/FontSelector.tsx
  - dùng cờ runtime Tauri với unknown thay vì đọc __TAURI_INTERNALS__ qua any.
- desktop/src/components/imposition-tools/PontSettingsDialog.tsx
  - generic hóa updateLocal theo keyof PontConfig và PontConfig[K].

Không bỏ ts-nocheck hoặc thay đổi cấu trúc Pont dialog trong lô này; các finding lifecycle/Fast Refresh được tách riêng.

## Verify

- ESLint hẹp: các no-explicit-any của lô hết.
- Regression: PontSettingsDialog.validation.test.ts 12/12 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.356 → 1.353, warnings 105 → 105; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Chỉ siết kiểu dữ liệu tại biên UI, giữ nguyên giá trị gửi vào cấu hình và hành vi runtime Tauri.
