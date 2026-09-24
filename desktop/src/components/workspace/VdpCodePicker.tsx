import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
    isBackgroundImage,
    normalizeRect,
    rectFromBbox,
    rectFullyContains,
    rectsIntersect,
    type BBox,
    type PickerRect,
    type VdpPickerObject,
    type VdpPickerObjectType,
} from './VdpCodePicker.geometry';

export type { BBox, PickerRect, VdpPickerObject, VdpPickerObjectType };

export type VdpFieldType = 'qrcode' | 'barcode';

export interface VdpCodePickerSelection {
    drawIndices: number[];
    fieldType: VdpFieldType;
    barcodeType?: string;
    name?: string;
}

export interface VdpDetectResult {
    fieldType: VdpFieldType | null;
    barcodeType: string | null;
    decoded: boolean;
}

export interface VdpCodePickerProps {
    objects: readonly VdpPickerObject[];
    /** Canvas pixels per PDF point. */
    scale: number;
    busy?: boolean;
    pageSize?: { width: number; height: number };
    onPick: (selection: VdpCodePickerSelection) => Promise<void> | void;
    onDetect?: (drawIndices: number[]) => Promise<VdpDetectResult>;
    onClose?: () => void;
}

const MIN_MARQUEE_SIZE = 3;

function pickTopmost(objects: readonly VdpPickerObject[], point: { x: number; y: number }, scale: number): VdpPickerObject | undefined {
    for (let i = objects.length - 1; i >= 0; i -= 1) {
        const object = objects[i];
        const rect = rectFromBbox(object.bbox, scale);
        if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
            return object;
        }
    }
    return undefined;
}

/**
 * Picker VDP cho đối tượng QR/mã vạch (ảnh và vector).
 * Tự động nhận diện loại mã khi nhấp hoặc quét khung, không hiển thị thanh công cụ
 * nổi để giữ View chính gọn gàng, chỉ tập trung vào tài liệu và thanh Preview.
 */
export const VdpCodePicker: React.FC<VdpCodePickerProps> = ({
    objects,
    scale,
    busy = false,
    pageSize,
    onPick,
    onDetect,
    onClose,
}) => {
    const { t } = useTranslation();
    const surfaceRef = useRef<HTMLDivElement>(null);
    const pointerRef = useRef<{ id: number; startX: number; startY: number } | null>(null);
    const [selected, setSelected] = useState<number[]>([]);
    const [marquee, setMarquee] = useState<PickerRect | null>(null);

    const objectByDrawIndex = useMemo(() => {
        const map = new Map<number, VdpPickerObject>();
        for (const object of objects) {
            map.set(object.drawIndex, object);
            if (object.memberDrawIndices) {
                for (const idx of object.memberDrawIndices) {
                    map.set(idx, object);
                }
            }
        }
        return map;
    }, [objects]);

    const selectedObjects = useMemo(
        () => selected.map((drawIndex) => objectByDrawIndex.get(drawIndex)).filter((object): object is VdpPickerObject => Boolean(object)),
        [objectByDrawIndex, selected],
    );
    const selectedBounds = useMemo(() => {
        const rects = selectedObjects.map((object) => rectFromBbox(object.bbox, scale));
        if (rects.length === 0) return null;
        const left = Math.min(...rects.map((rect) => rect.x));
        const top = Math.min(...rects.map((rect) => rect.y));
        const right = Math.max(...rects.map((rect) => rect.x + rect.width));
        const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
        return { x: left, y: top, width: right - left, height: bottom - top };
    }, [scale, selectedObjects]);

    const clearPendingOrClose = useCallback(() => {
        if (marquee) {
            setMarquee(null);
            return;
        }
        if (selected.length > 0) {
            setSelected([]);
            return;
        }
        onClose?.();
    }, [marquee, onClose, selected.length]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                clearPendingOrClose();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [clearPendingOrClose]);

    const pointFromEvent = useCallback((event: React.PointerEvent) => {
        const bounds = surfaceRef.current?.getBoundingClientRect();
        if (!bounds) return { x: event.clientX, y: event.clientY };
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }, []);

    // Tự động nhận diện và bóc tách đối tượng mã VDP đã chọn
    const triggerPick = useCallback(async (drawIndices: number[]) => {
        if (busy || drawIndices.length === 0) return;
        let detectedKind: VdpFieldType = 'qrcode';
        let detectedBarcodeType: string | undefined = undefined;

        // Ước lượng loại mã dựa theo tỉ lệ khung hình (Aspect Ratio)
        const targetObjs = drawIndices
            .map((idx) => objectByDrawIndex.get(idx))
            .filter((o): o is VdpPickerObject => Boolean(o));

        if (targetObjs.length > 0) {
            const rects = targetObjs.map((o) => rectFromBbox(o.bbox, scale));
            const minX = Math.min(...rects.map((r) => r.x));
            const maxX = Math.max(...rects.map((r) => r.x + r.width));
            const minY = Math.min(...rects.map((r) => r.y));
            const maxY = Math.max(...rects.map((r) => r.y + r.height));
            const w = maxX - minX;
            const h = maxY - minY;
            const ratio = h > 0 ? w / h : 1;
            // Dẹt ngang hoặc dọc rõ rệt -> Barcode; Vuông vắn -> QR Code
            if (ratio < 0.75 || ratio > 1.35) {
                detectedKind = 'barcode';
                detectedBarcodeType = 'code128';
            }
        }

        // Nhận diện mã chính xác bằng OpenCV/backend nếu có
        if (onDetect) {
            try {
                const result = await onDetect(drawIndices);
                if (result && result.fieldType) {
                    detectedKind = result.fieldType;
                    if (result.barcodeType) {
                        detectedBarcodeType = result.barcodeType;
                    }
                }
            } catch {
                // Tiếp tục dùng kết quả ước lượng hình học
            }
        }

        await onPick({
            drawIndices,
            fieldType: detectedKind,
            barcodeType: detectedKind === 'barcode' ? (detectedBarcodeType || 'code128') : undefined,
        });
    }, [busy, objectByDrawIndex, onDetect, onPick, scale]);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (busy || event.button !== 0) return;
        event.stopPropagation();
        const point = pointFromEvent(event);
        const hit = pickTopmost(objects, point, scale);
        if (hit) {
            const hitRect = rectFromBbox(hit.bbox, scale);
            if (hit.type === 'image' && isBackgroundImage(hitRect, pageSize)) {
                toast.warning(t('misc.vdpPicker:background_image_hint'));
                return;
            }
            const hitIndices = hit.memberDrawIndices && hit.memberDrawIndices.length > 0
                ? [...hit.memberDrawIndices]
                : [hit.drawIndex];
            setSelected(hitIndices);
            void triggerPick(hitIndices);
            return;
        }

        pointerRef.current = { id: event.pointerId, startX: point.x, startY: point.y };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
    }, [busy, objects, pageSize, pointFromEvent, scale, t, triggerPick]);

    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const pointer = pointerRef.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        event.stopPropagation();
        const point = pointFromEvent(event);
        setMarquee(normalizeRect(pointer.startX, pointer.startY, point.x, point.y));
    }, [pointFromEvent]);

    const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const pointer = pointerRef.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        event.stopPropagation();
        pointerRef.current = null;
        const point = pointFromEvent(event);
        const rect = normalizeRect(pointer.startX, pointer.startY, point.x, point.y);
        setMarquee(null);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (rect.width < MIN_MARQUEE_SIZE || rect.height < MIN_MARQUEE_SIZE) {
            return;
        }
        const contained = objects.filter((object) => rectFullyContains(rect, rectFromBbox(object.bbox, scale)));
        const blocked = objects.some(
            (object) => object.type === 'image'
                && rectsIntersect(rect, rectFromBbox(object.bbox, scale))
                && !rectFullyContains(rect, rectFromBbox(object.bbox, scale))
        );
        if (blocked) {
            toast.warning(t('misc.vdpPicker:partial_image_hint'));
        }
        const safe = contained.filter(
            (object) => !(object.type === 'image' && isBackgroundImage(rectFromBbox(object.bbox, scale), pageSize))
        );
        if (safe.length > 0) {
            const indices = safe.flatMap((object) =>
                object.memberDrawIndices && object.memberDrawIndices.length > 0
                    ? object.memberDrawIndices
                    : [object.drawIndex]
            );
            setSelected(indices);
            void triggerPick(indices);
        }
    }, [objects, pageSize, pointFromEvent, scale, t, triggerPick]);

    return (
        <div
            ref={surfaceRef}
            data-testid="vdp-code-picker"
            className="absolute inset-0 z-[75] pointer-events-auto select-none"
            style={{ touchAction: 'none' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            {objects.map((object) => {
                const rect = rectFromBbox(object.bbox, scale);
                const active = selected.includes(object.drawIndex) ||
                    (object.memberDrawIndices && object.memberDrawIndices.some((idx) => selected.includes(idx)));
                return (
                    <div
                        key={`${object.id}-${object.drawIndex}`}
                        data-testid={`vdp-object-${object.drawIndex}`}
                        className={`absolute rounded transition-all duration-150 ${
                            active
                                ? 'border-2 border-teal-400 bg-teal-400/25 ring-2 ring-teal-400/60 z-[72]'
                                : 'border border-transparent bg-transparent hover:border-indigo-400 hover:bg-indigo-500/15 hover:shadow-sm z-[71]'
                        } ${busy ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                        style={{
                            left: rect.x,
                            top: rect.y,
                            width: Math.max(rect.width, 2),
                            height: Math.max(rect.height, 2),
                        }}
                        title={object.label ? `${object.label} — ${t('misc.vdpPicker:click_to_pick', 'Nhấp để chọn làm trường mã')}` : t('misc.vdpPicker:click_to_pick', 'Nhấp hoặc quét khung để chọn làm trường mã')}
                        aria-label={object.label ?? object.type}
                    />
                );
            })}
            {selectedBounds && (
                <div
                    data-testid="vdp-selection-bounds"
                    className="pointer-events-none absolute border-2 border-teal-300 bg-teal-300/10 shadow-sm"
                    style={{
                        left: selectedBounds.x,
                        top: selectedBounds.y,
                        width: selectedBounds.width,
                        height: selectedBounds.height,
                    }}
                />
            )}
            {marquee && (
                <div
                    data-testid="vdp-marquee"
                    className="pointer-events-none absolute border border-dashed border-sky-400 bg-sky-400/20"
                    style={{
                        left: marquee.x,
                        top: marquee.y,
                        width: marquee.width,
                        height: marquee.height,
                    }}
                />
            )}
        </div>
    );
};

export default VdpCodePicker;
