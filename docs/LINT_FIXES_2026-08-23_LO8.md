# Lô lint P2.4 — 2026-08-23

## Phạm vi

Loại bỏ 5 import không dùng, không đổi hành vi:

- `desktop/src/components/SettingRow.tsx` — `cn`
- `desktop/src/components/SettingsModal.tsx` — `relaunch`
- `desktop/src/components/workspace/SaveModal.tsx` — `Button`
- `desktop/src/lib/__tests__/coverNumberingPlanner.test.ts` — type `SortMethod`
- `desktop/src/components/imposition-tools/sections/BookletSettingsSection.tsx` — `Checkbox`

## Verify

- ESLint hẹp: 5 file không còn `no-unused-vars`; các finding còn lại đều là
  rule baseline khác (`any`/`ban-ts-comment`).
- Cover numbering: 1 file, 15/15 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.423 → 1.418`, warnings `108 → 108`;
  budget gate đạt.

## Kết luận

Chỉ dọn import type/value không được tham chiếu. Chưa build release, commit hoặc
push.
