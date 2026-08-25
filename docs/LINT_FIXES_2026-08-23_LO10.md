# Lô lint P2.6 — 2026-08-23

## Phạm vi

Loại bỏ import/hằng không dùng trong 5 test/helper thuần:

- `desktop/src/lib/imposerEngine/__tests__/FoldPatterns.test.ts` — type `SpreadFoldPattern`
- `desktop/src/lib/imposerEngine/__tests__/SheetOptimizer.test.ts` — hằng `A4_PT`
- `desktop/src/lib/paperLibrary/spine.test.ts` — `MIN_SPINE_BY_BINDING`
- `desktop/src/lib/recipe/playbackPublisher.test.ts` — import `vi`
- `desktop/src/lib/recipe/recipeTypes.test.ts` — type `Recipe`

## Verify

- ESLint hẹp: các finding `no-unused-vars` của lô đã hết; `recipeTypes.test.ts`
  còn 3 `no-explicit-any` baseline, không phát sinh từ cleanup.
- Regression: 5 file, 58/58 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.411 → 1.406`, warnings `108 → 108`;
  budget gate đạt.

## Kết luận

Chỉ dọn symbol không tham chiếu trong test, không đổi production code. Chưa
build release, commit hoặc push.
