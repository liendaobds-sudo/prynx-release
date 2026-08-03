// BUILD (audit 2026-08-03 §REL.05): công thức thuần dùng chung cho view và test,
// tách khỏi component để giữ Fast Refresh ổn định.
export const RENDER_BUDGET_PX = { high: 6000, fast: 3000 } as const;

export function computeRenderZoomPure(
    z: number,
    actualWidth100: number,
    pageDimW?: number,
    pageDimH?: number,
    /**
     * PERF (audit độ nét 2026-07-28 §R.9): ngân sách cạnh dài bitmap nối với
     * `previewQuality`. Mặc định vẫn 6000; chỉ hạ khi người dùng chọn `fast`.
     */
    budgetPx: number = RENDER_BUDGET_PX.high,
): number {
    const dpr = window.devicePixelRatio || 1;
    const target = Math.max(dpr, z * dpr);
    const widthAt100 = actualWidth100 || 800;
    const ratio = pageDimW && pageDimW > 0
        ? Math.max(1, (pageDimH || 0) / pageDimW)
        : 1.414;
    const capByBudget = (budgetPx || RENDER_BUDGET_PX.high) / (widthAt100 * ratio);
    return Math.max(dpr, Math.min(24, target, capByBudget));
}
