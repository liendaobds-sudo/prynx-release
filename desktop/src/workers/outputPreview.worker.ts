/// <reference lib="webworker" />

import pako from 'pako';

import {
  buildPlateRgba,
  buildTacHeatmapRgba,
  type OutputPreviewPlateInput,
  type OutputPreviewRenderedPlate,
  type OutputPreviewWorkerRequest,
  type OutputPreviewWorkerResponse,
} from '../lib/outputPreviewPixels';


const worker = self as unknown as DedicatedWorkerGlobalScope;
let pageWidth = 0;
let pageHeight = 0;
let tacTotals = new Uint16Array(0);

function decodeAlphaData(
  plate: OutputPreviewPlateInput,
  pixelCount: number,
): Uint8ClampedArray<ArrayBuffer> {
  const binary = atob(plate.alphaData);
  const compressed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index);
  }
  const inflated = pako.inflate(compressed);
  if (inflated.length !== pixelCount) {
    throw new Error(`Kẽm ${plate.name} có dữ liệu alpha không khớp kích thước trang.`);
  }
  const alpha = new Uint8ClampedArray(pixelCount);
  alpha.set(inflated);
  return alpha;
}

async function rgbaToPngBlob(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  try {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Web Worker không khởi tạo được canvas PNG.');
    }
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function reconstructPlates(
  request: Extract<OutputPreviewWorkerRequest, { type: 'reconstruct' }>,
): Promise<OutputPreviewWorkerResponse> {
  const pixelCount = request.width * request.height;
  if (
    !Number.isInteger(request.width)
    || !Number.isInteger(request.height)
    || request.width <= 0
    || request.height <= 0
    || !Number.isSafeInteger(pixelCount)
  ) {
    throw new Error('Kích thước ảnh phân tách kẽm không hợp lệ.');
  }

  pageWidth = request.width;
  pageHeight = request.height;
  tacTotals = new Uint16Array(pixelCount);
  const plates: OutputPreviewRenderedPlate[] = [];
  const transfers: Transferable[] = [];

  // PERF (audit 2026-08-05 §PERF.6): inflate, vòng pixel và PNG encode đều
  // chạy ở worker. Alpha chuyển quyền về UI cho hover; worker chỉ giữ Uint16 TAC.
  for (const plate of request.plates) {
    const alpha = decodeAlphaData(plate, pixelCount);
    const rgba = buildPlateRgba(alpha, plate.color, tacTotals);
    const png = await rgbaToPngBlob(rgba, pageWidth, pageHeight);
    plates.push({
      name: plate.name,
      color: plate.color,
      isSpot: plate.isSpot,
      png,
      alphaBuffer: alpha.buffer,
    });
    transfers.push(alpha.buffer);
  }

  const response: OutputPreviewWorkerResponse = {
    type: 'reconstructed',
    requestId: request.requestId,
    width: pageWidth,
    height: pageHeight,
    plates,
  };
  worker.postMessage(response, transfers);
  return response;
}

async function renderTac(
  request: Extract<OutputPreviewWorkerRequest, { type: 'tac' }>,
): Promise<void> {
  if (pageWidth <= 0 || pageHeight <= 0 || tacTotals.length !== pageWidth * pageHeight) {
    throw new Error('Dữ liệu TAC chưa được khởi tạo.');
  }
  const rgba = buildTacHeatmapRgba(tacTotals, request.threshold);
  const png = await rgbaToPngBlob(rgba, pageWidth, pageHeight);
  const response: OutputPreviewWorkerResponse = {
    type: 'tac-rendered',
    requestId: request.requestId,
    png,
  };
  worker.postMessage(response);
}

worker.onmessage = async (event: MessageEvent<OutputPreviewWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'reconstruct') {
      await reconstructPlates(request);
    } else {
      await renderTac(request);
    }
  } catch (error) {
    const response: OutputPreviewWorkerResponse = {
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Không dựng được ảnh phân tách kẽm.',
    };
    worker.postMessage(response);
  }
};

export {};
