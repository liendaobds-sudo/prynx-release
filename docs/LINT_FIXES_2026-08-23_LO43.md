# Lô lint P1.39 — 2026-08-23

## Phạm vi

Giảm 2 lỗi React Refresh trong 4 file:

- `desktop/src/components/imposition-tools/PaperSettingsUI.tsx`
- `desktop/src/components/imposition-tools/usePaperPresets.ts` (mới)
- `desktop/src/components/imposition-tools/usePaperPresets.test.tsx` (mới)
- `desktop/src/components/imposition-tools/ImposerDashboard.tsx`

Bỏ re-export `formUsages` không có consumer và chuyển hook preset giấy sang module riêng.
Load/save/update/delete, `storageKey` và public behavior được giữ nguyên.

## Verify

- React Refresh của `PaperSettingsUI`: 2 → 0.
- Hai lỗi `set-state-in-effect` và warning dependency được giữ nguyên, không né/chuyển thành suppression.
- Test hook + `paperUtils`: 8/8 đạt.
- `npm run typecheck`: đạt.
- Diff/whitespace check: đạt.
- `npm run lint:budget`: 1.202 → 1.200 errors; warnings giữ 103.

## Kết luận

Ranh giới HMR được tách sạch; nợ lifecycle của hook được giữ lại cho lô React Hooks có test riêng.
