/**
 * Lightweight performance marks used for repeatable startup measurements.
 *
 * The helper is intentionally no-op when the Performance API is unavailable
 * (for example in a non-browser test environment). Marks stay in the browser
 * performance buffer and can be inspected from DevTools without adding a
 * synchronous logging path to the critical startup flow.
 */
export const appPerf = {
    mark(name: string): void {
        if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
        performance.mark(`prynx:${name}`);
    },

    measure(name: string, startMark: string, endMark?: string): void {
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
};

