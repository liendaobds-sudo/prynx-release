import React from 'react';
import type { StickerCutlinePreview } from '../../lib/stickerSheetApi';

export interface ThumbnailCutlinePreviewItem {
    cutlinePreview?: StickerCutlinePreview | null;
    previewUrl?: string | null;
}

export function sameCutlinePreview(
    prev?: ThumbnailCutlinePreviewItem | null,
    next?: ThumbnailCutlinePreviewItem | null,
): boolean {
    if (prev === next) return true;
    if (!prev && !next) return true;
    if (!prev || !next) return false;
    if (prev.previewUrl !== next.previewUrl) return false;
    if (prev.cutlinePreview === next.cutlinePreview) return true;
    if (!prev.cutlinePreview || !next.cutlinePreview) return false;
    return prev.cutlinePreview.fingerprint === next.cutlinePreview.fingerprint
        && prev.cutlinePreview.mask_revision === next.cutlinePreview.mask_revision
        && prev.cutlinePreview.preview_width_px === next.cutlinePreview.preview_width_px
        && prev.cutlinePreview.preview_height_px === next.cutlinePreview.preview_height_px
        && prev.cutlinePreview.paths.length === next.cutlinePreview.paths.length;
}

export function ThumbnailCutlinePreviewLayer({
    item,
}: {
    item?: ThumbnailCutlinePreviewItem | null;
}) {
    if (!item) return null;
    const { cutlinePreview, previewUrl } = item;
    if (!cutlinePreview && !previewUrl) return null;

    return (
        <div
            data-testid="thumbnail-cutline-preview-layer"
            className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
        >
            {previewUrl && (
                <img
                    src={previewUrl}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                />
            )}
            {cutlinePreview && cutlinePreview.paths.length > 0 && (
                <svg
                    data-testid="thumbnail-cutline-svg"
                    viewBox={`0 0 ${cutlinePreview.preview_width_px} ${cutlinePreview.preview_height_px}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                >
                    {cutlinePreview.paths.map(path => (
                        <path
                            key={path.instance_id}
                            d={path.d}
                            fill="none"
                            stroke="#7c3aed"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    ))}
                </svg>
            )}
        </div>
    );
}
