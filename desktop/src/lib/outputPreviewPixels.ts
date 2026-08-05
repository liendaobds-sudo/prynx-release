export interface OutputPreviewPlateInput {
  name: string;
  color: number[];
  alphaData: string;
  isSpot?: boolean;
}

export type OutputPreviewWorkerRequest =
  | {
      type: 'reconstruct';
      requestId: number;
      width: number;
      height: number;
      plates: OutputPreviewPlateInput[];
    }
  | {
      type: 'tac';
      requestId: number;
      threshold: number;
    };

export type OutputPreviewWorkerRequestPayload =
  | Omit<Extract<OutputPreviewWorkerRequest, { type: 'reconstruct' }>, 'requestId'>
  | Omit<Extract<OutputPreviewWorkerRequest, { type: 'tac' }>, 'requestId'>;

export interface OutputPreviewRenderedPlate {
  name: string;
  color: number[];
  isSpot?: boolean;
  png: Blob;
  alphaBuffer: ArrayBuffer;
}

export type OutputPreviewWorkerResponse =
  | {
      type: 'reconstructed';
      requestId: number;
      width: number;
      height: number;
      plates: OutputPreviewRenderedPlate[];
    }
  | {
      type: 'tac-rendered';
      requestId: number;
      png: Blob;
    }
  | {
      type: 'error';
      requestId: number;
      message: string;
    };

type AlphaArray = Uint8Array<ArrayBufferLike> | Uint8ClampedArray<ArrayBufferLike>;

export function buildPlateRgba(
  alpha: AlphaArray,
  color: readonly number[],
  tacTotals?: Uint16Array,
): Uint8ClampedArray<ArrayBuffer> {
  if (tacTotals && tacTotals.length !== alpha.length) {
    throw new Error('Kích thước alpha không khớp kích thước trang.');
  }
  const rgba = new Uint8ClampedArray(alpha.length * 4);
  const [red = 0, green = 0, blue = 0] = color;
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = red;
    rgba[offset + 1] = green;
    rgba[offset + 2] = blue;
    rgba[offset + 3] = alpha[index];
    if (tacTotals) {
      tacTotals[index] += Math.round((alpha[index] / 255) * 100);
    }
  }
  return rgba;
}

export function accumulateTacTotals(totals: Uint16Array, alpha: AlphaArray): void {
  if (totals.length !== alpha.length) {
    throw new Error('Kích thước alpha không khớp kích thước trang.');
  }
  for (let index = 0; index < alpha.length; index += 1) {
    totals[index] += Math.round((alpha[index] / 255) * 100);
  }
}

export function buildTacHeatmapRgba(
  totals: Uint16Array,
  threshold: number,
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(totals.length * 4);
  for (let index = 0; index < totals.length; index += 1) {
    const total = totals[index];
    if (total <= threshold) continue;
    const severity = Math.min(1, (total - threshold) / 100);
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = Math.round(255 * (1 - severity));
    rgba[offset + 2] = 0;
    rgba[offset + 3] = Math.round(120 + severity * 100);
  }
  return rgba;
}
