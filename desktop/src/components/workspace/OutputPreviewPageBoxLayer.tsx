import {
    getVisibleOutputPreviewPageBoxOverlays,
    type OutputPreviewPageBoxes,
    type OutputPreviewPageBoxKind,
} from '../../lib/outputPreviewOverlay';

const PAGE_BOX_STYLE: Record<OutputPreviewPageBoxKind, {
    borderColor: string;
    borderStyle: 'solid' | 'dashed' | 'dotted';
}> = {
    bleedbox: { borderColor: '#2563eb', borderStyle: 'solid' },
    trimbox: { borderColor: '#16a34a', borderStyle: 'dashed' },
    artbox: { borderColor: '#e11d48', borderStyle: 'dotted' },
};

interface OutputPreviewPageBoxLayerProps {
    boxes: OutputPreviewPageBoxes | null;
    viewerPageNum: number;
    show: boolean;
}

/** Lớp khung PageBox chỉ để quan sát, không nhận pointer và không sửa PDF. */
export default function OutputPreviewPageBoxLayer({
    boxes,
    viewerPageNum,
    show,
}: OutputPreviewPageBoxLayerProps) {
    const overlays = getVisibleOutputPreviewPageBoxOverlays(boxes, viewerPageNum, show);
    if (overlays.length === 0) return null;

    return (
        <div
            data-output-preview-page-box-layer
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[55] overflow-hidden"
        >
            {overlays.map(({ kind, rect }) => (
                <div
                    key={kind}
                    data-output-preview-page-box={kind}
                    className="absolute"
                    style={{
                        left: `${rect.x0 * 100}%`,
                        top: `${rect.y0 * 100}%`,
                        width: `${(rect.x1 - rect.x0) * 100}%`,
                        height: `${(rect.y1 - rect.y0) * 100}%`,
                        boxSizing: 'border-box',
                        borderWidth: 2,
                        ...PAGE_BOX_STYLE[kind],
                    }}
                />
            ))}
        </div>
    );
}
