import { createImageBatchStore, type BatchTabState } from './imageBatch/store';

export type DocumentCleanupOperation = 'card' | 'scan';
export type ScanCleanupMode = 'color' | 'gray' | 'bw';
export type CardRatioMode = 'id1' | 'auto' | 'custom';
export type NormalizedPoint = { x: number; y: number };

export type CardDetectionState = {
    points: NormalizedPoint[];
    confidence: number;
    needsReview: boolean;
    method: string;
};

export type DocumentCleanupOptions = {
    operation: DocumentCleanupOperation;
    scanMode: ScanCleanupMode;
    strength: number;
    removeShadows: boolean;
    deskew: boolean;
    cardRatio: CardRatioMode;
    customWidthMm: number;
    customHeightMm: number;
    outputDpi: number;
    detections: Record<string, CardDetectionState>;
};

const DEFAULT_OPTIONS: DocumentCleanupOptions = {
    operation: 'card',
    scanMode: 'color',
    strength: 0.55,
    removeShadows: true,
    deskew: true,
    cardRatio: 'id1',
    customWidthMm: 85.6,
    customHeightMm: 53.98,
    outputDpi: 300,
    detections: {},
};

export type DocumentCleanupTabState = BatchTabState<DocumentCleanupOptions>;

export const defaultDocumentCleanupTabState: DocumentCleanupTabState = {
    batchItems: [],
    selectedId: null,
    options: { ...DEFAULT_OPTIONS, detections: {} },
    isProcessing: false,
    progress: '',
    error: '',
};

export const useDocumentCleanupStore = createImageBatchStore<DocumentCleanupOptions>(DEFAULT_OPTIONS);
