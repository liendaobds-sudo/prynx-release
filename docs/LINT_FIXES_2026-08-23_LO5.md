# Lô lint P2.1 — 2026-08-23

## Phạm vi

Đổi `let` thành `const` tại các biến không bị gán lại, giữ nguyên toàn bộ luồng
viewer và thao tác PDF:

- `desktop/src/components/AcrobatViewer.tsx` — 4 finding
- `desktop/src/components/ImpositionTab.tsx` — 1 finding
- `desktop/src/components/workspace/LivePageFrame.tsx` — 2 finding
- `desktop/src/hooks/viewer/useViewerHotkeys.ts` — 1 finding

Không đưa `desktop/src/lib/dieline/autoBottomHelpers.ts` vào lô này; file đó
được tách sang lô khuôn bế riêng theo skill/test chuyên ngành.

## Verify

- ESLint hẹp trên 4 file: `prefer-const` còn 0 finding.
- Regression viewer: 3 file, 56/56 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.438 → 1.430`, warnings `108 → 108`;
  budget gate đạt.
- `prefer-const`: `9 → 1` (1 finding còn lại ở file dieline đã nêu trên).

## Kết luận

Đây là thay đổi cơ học, không đổi dữ liệu/API hay hành vi render. Chưa build
release, commit hoặc push.
