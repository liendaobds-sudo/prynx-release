# Lô lint P2.23 — 2026-08-23

## Phạm vi

Giữ rõ contract legacy của ImposerDashboard:

- desktop/src/components/imposition-tools/ImposerDashboard.tsx
  - đánh dấu initialFeature và lockedMode là prop tương thích caller cũ;
  - active tool hiện vẫn lấy từ store, không đổi entitlement hoặc routing.

Không xóa prop khỏi ImposerDashboardProps và không đổi state dashboard.

## Verify

- ESLint no-unused-vars hẹp: sạch.
- Regression: 2 test files dashboard/imposition, 3/3 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.335 → 1.333, warnings 104 → 103; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

API caller không bị phá, đồng thời debt dead-parameter được ghi nhận minh bạch.
