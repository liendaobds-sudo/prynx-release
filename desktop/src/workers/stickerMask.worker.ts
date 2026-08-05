/// <reference lib="webworker" />

import {
    applyStickerMaskEdits,
    decodeLabelRgb,
    decodeUncertaintyAlpha,
    renderStickerMaskOverlay,
    type StickerMaskWorkerRequest,
    type StickerMaskWorkerResponse,
} from './stickerMaskProtocol';


let width = 0;
let height = 0;
let originalLabels: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let uncertainty: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<StickerMaskWorkerRequest>) => {
    try {
        const message = event.data;
        if (message.type === 'init') {
            width = message.width;
            height = message.height;
            originalLabels = decodeLabelRgb(message.labelsRgba);
            uncertainty = decodeUncertaintyAlpha(message.uncertaintyRgba);
            const response: StickerMaskWorkerResponse = { type: 'ready' };
            worker.postMessage(response);
            return;
        }
        if (width <= 0 || height <= 0 || originalLabels.length !== width * height) {
            throw new Error('Mask chưa được khởi tạo.');
        }
        const labels = applyStickerMaskEdits(originalLabels, width, height, message.edits);
        const overlay = renderStickerMaskOverlay(
            labels,
            uncertainty,
            width,
            height,
            message.selectedInstanceId,
        );
        const response: StickerMaskWorkerResponse = {
            type: 'rendered',
            requestId: message.requestId,
            width,
            height,
            overlay,
        };
        worker.postMessage(response, [overlay.buffer]);
    } catch (error) {
        const response: StickerMaskWorkerResponse = {
            type: 'error',
            message: error instanceof Error ? error.message : 'Không cập nhật được mask.',
        };
        worker.postMessage(response);
    }
};

export {};
