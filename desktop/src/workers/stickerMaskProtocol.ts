import type { StickerSheetEdit } from '../components/preprocess-tools/stickerSheetStore';


export interface StickerMaskInitMessage {
    type: 'init';
    width: number;
    height: number;
    labelsRgba: Uint8ClampedArray;
    uncertaintyRgba: Uint8ClampedArray;
}

export interface StickerMaskRenderMessage {
    type: 'render';
    requestId: number;
    edits: StickerSheetEdit[];
    selectedInstanceId: number | null;
}

export type StickerMaskWorkerRequest = StickerMaskInitMessage | StickerMaskRenderMessage;

export interface StickerMaskReadyResponse {
    type: 'ready';
}

export interface StickerMaskRenderResponse {
    type: 'rendered';
    requestId: number;
    width: number;
    height: number;
    overlay: Uint8ClampedArray;
}

export interface StickerMaskErrorResponse {
    type: 'error';
    message: string;
}

export type StickerMaskWorkerResponse =
    | StickerMaskReadyResponse
    | StickerMaskRenderResponse
    | StickerMaskErrorResponse;


export function decodeLabelRgb(rgba: Uint8ClampedArray): Uint32Array {
    const labels = new Uint32Array(Math.floor(rgba.length / 4));
    for (let pixel = 0, offset = 0; pixel < labels.length; pixel += 1, offset += 4) {
        labels[pixel] = rgba[offset] | (rgba[offset + 1] << 8) | (rgba[offset + 2] << 16);
    }
    return labels;
}

function paintStroke(
    labels: Uint32Array,
    width: number,
    height: number,
    edit: Extract<StickerSheetEdit, { kind: 'stroke' }>,
): void {
    const radiusPx = Math.max(1, edit.radius * Math.max(width, height));
    const radiusSquared = radiusPx * radiusPx;
    const value = edit.tool === 'restore' ? Math.max(1, edit.instanceId) : 0;
    for (const point of edit.points) {
        const centerX = Math.max(0, Math.min(width - 1, point.x * width));
        const centerY = Math.max(0, Math.min(height - 1, point.y * height));
        const left = Math.max(0, Math.floor(centerX - radiusPx));
        const right = Math.min(width - 1, Math.ceil(centerX + radiusPx));
        const top = Math.max(0, Math.floor(centerY - radiusPx));
        const bottom = Math.min(height - 1, Math.ceil(centerY + radiusPx));
        for (let y = top; y <= bottom; y += 1) {
            const dy = y - centerY;
            const row = y * width;
            for (let x = left; x <= right; x += 1) {
                const dx = x - centerX;
                if (dx * dx + dy * dy <= radiusSquared) labels[row + x] = value;
            }
        }
    }
}

export function applyStickerMaskEdits(
    original: Uint32Array,
    width: number,
    height: number,
    edits: StickerSheetEdit[],
): Uint32Array {
    const labels = original.slice();
    for (const edit of edits) {
        if (edit.kind === 'stroke') {
            paintStroke(labels, width, height, edit);
            continue;
        }
        for (let index = 0; index < labels.length; index += 1) {
            if (labels[index] === edit.sourceId) labels[index] = edit.targetId;
        }
    }
    return labels;
}

function instanceColor(instanceId: number): [number, number, number] {
    const hue = (instanceId * 137.508) % 360;
    const sector = Math.floor(hue / 60);
    const fraction = hue / 60 - sector;
    const high = 245;
    const low = 65;
    const middleUp = Math.round(low + (high - low) * fraction);
    const middleDown = Math.round(high - (high - low) * fraction);
    const colors: [number, number, number][] = [
        [high, middleUp, low], [middleDown, high, low], [low, high, middleUp],
        [low, middleDown, high], [middleUp, low, high], [high, low, middleDown],
    ];
    return colors[sector % 6];
}

export function renderStickerMaskOverlay(
    labels: Uint32Array,
    uncertainty: Uint8Array,
    width: number,
    height: number,
    selectedInstanceId: number | null,
): Uint8ClampedArray {
    const output = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
            const index = row + x;
            const label = labels[index];
            if (label === 0) continue;
            const left = x > 0 ? labels[index - 1] : 0;
            const right = x + 1 < width ? labels[index + 1] : 0;
            const top = y > 0 ? labels[index - width] : 0;
            const bottom = y + 1 < height ? labels[index + width] : 0;
            const edge = left !== label || right !== label || top !== label || bottom !== label;
            const selected = selectedInstanceId === label;
            const offset = index * 4;
            if (uncertainty[index] > 0 && edge) {
                output[offset] = 255;
                output[offset + 1] = 150;
                output[offset + 2] = 20;
                output[offset + 3] = 235;
                continue;
            }
            // UIUX (audit 2026-08-05 §AI2.COLOR1): overlay chỉ mô tả đường biên.
            // Tô cả lòng tem làm artwork bị ám màu dù file xuất vẫn đúng màu nguồn.
            if (!edge) continue;
            const [red, green, blue] = instanceColor(label);
            output[offset] = red;
            output[offset + 1] = green;
            output[offset + 2] = blue;
            output[offset + 3] = selected ? 245 : 190;
        }
    }
    return output;
}

export function decodeUncertaintyAlpha(rgba: Uint8ClampedArray): Uint8Array {
    const uncertainty = new Uint8Array(Math.floor(rgba.length / 4));
    for (let pixel = 0, offset = 0; pixel < uncertainty.length; pixel += 1, offset += 4) {
        uncertainty[pixel] = rgba[offset];
    }
    return uncertainty;
}
