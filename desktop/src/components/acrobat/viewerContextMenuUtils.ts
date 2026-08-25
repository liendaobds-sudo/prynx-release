import type { CrossFileTarget } from './ViewerContextMenu';

/** Liệt kê các PDF đang mở khác để menu chuyển trang dùng chung toàn shell. */
export function listOtherOpenPdfTargets(currentPdfUrl: string | null | undefined): CrossFileTarget[] {
    if (!currentPdfUrl) return [];
    const seen = new Set<string>();
    const out: CrossFileTarget[] = [];

    const add = (url: string | null, name: string | null, tabId: string | null, numPagesRaw: string | null) => {
        if (!url || url === currentPdfUrl || seen.has(url)) return;
        seen.add(url);
        const numPages = numPagesRaw ? parseInt(numPagesRaw, 10) : NaN;
        out.push({
            pdfUrl: url,
            name: name || 'PDF',
            tabId: tabId || undefined,
            numPages: Number.isFinite(numPages) && numPages >= 0 ? numPages : undefined,
        });
    };

    document.querySelectorAll('[data-prynx-open-pdf]').forEach((node) => {
        const element = node as HTMLElement;
        add(
            element.getAttribute('data-prynx-open-pdf'),
            element.getAttribute('data-file-name'),
            element.getAttribute('data-prynx-tab-id'),
            element.getAttribute('data-prynx-num-pages'),
        );
    });
    document.querySelectorAll('.acro-thumb-scroll[data-pdf-url]').forEach((node) => {
        const element = node as HTMLElement;
        const root = element.closest('[data-prynx-open-pdf]') as HTMLElement | null;
        add(
            element.getAttribute('data-pdf-url'),
            element.getAttribute('data-file-name') || root?.getAttribute('data-file-name') || null,
            root?.getAttribute('data-prynx-tab-id') || null,
            root?.getAttribute('data-prynx-num-pages') || null,
        );
    });
    return out;
}
