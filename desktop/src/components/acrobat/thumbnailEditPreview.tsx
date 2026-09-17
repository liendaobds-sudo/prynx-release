/* eslint-disable react-refresh/only-export-components */
import type { CSSProperties } from 'react';

import type { SessionPreview } from '../../hooks/useEditSession';


/** Frame ảo mount mới không phải revision mới; chỉ identity file/fid đổi mới được dọn. */
export function editPreviewDocumentChanged(
    previousIdentity: string,
    currentIdentity: string,
): boolean {
    return previousIdentity !== currentIdentity;
}

/**
 * Chỉ frame active cần metadata object để hit-test/panel. Virtuoso có thể mount
 * nhiều trang lân cận; cho tất cả cùng fetch sẽ serialize và đọc PDF vô ích.
 */
export function shouldLoadEditObjectsForFrame(input: {
    isObjectEditMode: boolean;
    isPickingVdpText?: boolean;
    isActiveFrame: boolean;
    originalPageNum: number;
    selectionFileId: string;
    hasPageHeight: boolean;
}): boolean {
    const isModeActive = input.isObjectEditMode || Boolean(input.isPickingVdpText);
    if (!isModeActive) return false;
    // PERF: Chỉ nạp cho frame active, tuyệt đối không để frame ảo/overscan đồng loạt gọi API
    return input.isActiveFrame
        && input.originalPageNum !== -1
        && input.selectionFileId.length > 0
        && input.hasPageHeight;
}

/** Gom preview theo số trang nguồn một-based để chỉ thumbnail bị sửa đổi props. */
export function groupEditPreviewsBySourcePage(
    previews: readonly SessionPreview[] | undefined,
): ReadonlyMap<number, readonly SessionPreview[]> {
    const grouped = new Map<number, SessionPreview[]>();
    for (const preview of previews || []) {
        const sourcePage = preview.page + 1;
        const current = grouped.get(sourcePage);
        if (current) current.push(preview);
        else grouped.set(sourcePage, [preview]);
    }
    return grouped;
}

/** Comparator hẹp cho React.memo; không rerender thumbnail của trang không đổi. */
export function sameEditPreviewSequence(
    previous: readonly SessionPreview[] | undefined,
    next: readonly SessionPreview[] | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous?.length && !next?.length) return true;
    if (!previous || !next || previous.length !== next.length) return false;
    return previous.every((item, index) => {
        const candidate = next[index];
        if (item === candidate) return true;
        if (!candidate
            || item.url !== candidate.url
            || item.full !== candidate.full
            || item.page !== candidate.page
        ) return false;
        const a = item.clipRect;
        const b = candidate.clipRect;
        return a === b || (
            !!a
            && !!b
            && a.length === b.length
            && a.every((value, coord) => Math.abs(value - b[coord]) < 0.01)
        );
    });
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

/** Định vị clip edit-session trong thumbnail bằng tỉ lệ PageBox, độc lập kích thước UI. */
export function thumbnailEditPreviewStyle(
    preview: SessionPreview,
    pageWidthPt: number,
    pageHeightPt: number,
): CSSProperties {
    if (preview.full || !preview.clipRect || pageWidthPt <= 0 || pageHeightPt <= 0) {
        return { left: 0, top: 0, width: '100%', height: '100%' };
    }
    const [x0, y0, x1, y1] = preview.clipRect;
    const left = clampPercent(Math.min(x0, x1) / pageWidthPt * 100);
    const right = clampPercent(Math.max(x0, x1) / pageWidthPt * 100);
    const top = clampPercent((pageHeightPt - Math.max(y0, y1)) / pageHeightPt * 100);
    const bottom = clampPercent((pageHeightPt - Math.min(y0, y1)) / pageHeightPt * 100);
    return {
        left: `${left}%`,
        top: `${top}%`,
        width: `${Math.max(0, right - left)}%`,
        height: `${Math.max(0, bottom - top)}%`,
    };
}

export function ThumbnailEditPreviewLayer({
    previews,
    pageWidthPt,
    pageHeightPt,
}: {
    previews: readonly SessionPreview[] | undefined;
    pageWidthPt: number;
    pageHeightPt: number;
}) {
    if (!previews?.length) return null;
    return previews.map((preview, index) => (
        <img
            key={`${preview.page}-${index}-${preview.url.slice(-24)}`}
            src={preview.url}
            alt=""
            data-testid="thumbnail-edit-preview"
            data-source-page={preview.page + 1}
            draggable={false}
            loading="lazy"
            decoding="async"
            className="pointer-events-none absolute z-[2] block object-fill"
            style={thumbnailEditPreviewStyle(preview, pageWidthPt, pageHeightPt)}
        />
    ));
}
