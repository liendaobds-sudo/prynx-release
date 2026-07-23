/**
 * Lightweight performance marks used for repeatable startup measurements.
 *
 * The helper is intentionally no-op when the Performance API is unavailable
 * (for example in a non-browser test environment). Marks stay in the browser
 * performance buffer and can be inspected from DevTools without adding a
 * synchronous logging path to the critical startup flow.
 */
const perfFlag = String(import.meta.env.VITE_PRYNX_PERF || '').toLowerCase();
export const APP_PERF_ENABLED = import.meta.env.DEV || perfFlag === '1' || perfFlag === 'true';

export const appPerf = {
    mark(name: string): void {
        if (!APP_PERF_ENABLED) return;
        if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
        performance.mark(`prynx:${name}`);
    },

    measure(name: string, startMark: string, endMark?: string): void {
        if (!APP_PERF_ENABLED) return;
        if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
        try {
            performance.measure(
                `prynx:${name}`,
                `prynx:${startMark}`,
                endMark ? `prynx:${endMark}` : undefined,
            );
        } catch {
            // A missing mark must never affect application startup.
        }
    },

    /**
     * Read back every prynx measure as {name, ms} pairs, sorted by duration.
     * Meant to be called from the DevTools console (window.__prynxPerf())
     * so a baseline can be captured without digging through the Performance tab.
     */
    dump(): Array<{ name: string; ms: number }> {
        if (!APP_PERF_ENABLED) return [];
        if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
            return [];
        }
        return performance
            .getEntriesByType('measure')
            .filter((e) => e.name.startsWith('prynx:'))
            .map((e) => ({ name: e.name.replace(/^prynx:/, ''), ms: Math.round(e.duration) }))
            .sort((a, b) => b.ms - a.ms);
    },
};

if (APP_PERF_ENABLED && typeof window !== 'undefined') {
    (window as Window & { __prynxPerf?: typeof appPerf.dump }).__prynxPerf = () => appPerf.dump();
}

