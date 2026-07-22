import type {
    BookReportDisplayConfig,
    BookReportFieldKey,
    BookReportRenderConfig,
} from '../components/imposition-tools/types';

export interface BookReportPreviewData {
    pageCount: number;
    finishedWidthMm?: number;
    finishedHeightMm?: number;
    bindingLabel: string;
    paperSizeLabel: string;
}

const FIRST_LINE_FIELDS = new Set<BookReportFieldKey>([
    'orderCode', 'title', 'finishedSize', 'pageCount', 'quantity',
]);

const SHOW_FLAG: Record<BookReportFieldKey, keyof BookReportDisplayConfig> = {
    orderCode: 'showOrderCode',
    title: 'showTitle',
    finishedSize: 'showFinishedSize',
    pageCount: 'showPageCount',
    quantity: 'showQuantity',
    binding: 'showBinding',
    bodyPaper: 'showBodyPaper',
    coverPaper: 'showCoverPaper',
    coverFinish: 'showCoverFinish',
    colorMode: 'showColorMode',
    printSides: 'showPrintSides',
    paperSize: 'showPaperSize',
    notes: 'showNotes',
};

export function removeVietnameseDiacritics(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D');
}

function compact(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function formatDimension(value?: number): string {
    if (!Number.isFinite(value) || !value || value <= 0) return '';
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function valueForField(
    field: BookReportFieldKey,
    config: BookReportDisplayConfig,
    data: BookReportPreviewData,
): string {
    switch (field) {
        case 'orderCode': return config.orderCode ? `Mã ĐH: ${compact(config.orderCode)}` : '';
        case 'title': return config.titleText ? `Tên SP: ${compact(config.titleText)}` : '';
        case 'finishedSize': {
            const width = formatDimension(data.finishedWidthMm);
            const height = formatDimension(data.finishedHeightMm);
            return width && height ? `TP: ${width} × ${height} mm` : '';
        }
        case 'pageCount': return data.pageCount > 0 ? `${Math.round(data.pageCount)} trang` : '';
        case 'quantity': return config.quantity > 0
            ? `SL: ${new Intl.NumberFormat('vi-VN').format(Math.round(config.quantity))} cuốn`
            : '';
        case 'binding': return data.bindingLabel ? `Đóng cuốn: ${compact(data.bindingLabel)}` : '';
        case 'bodyPaper': return config.bodyPaper ? `Ruột: ${compact(config.bodyPaper)}` : '';
        case 'coverPaper': return config.coverPaper ? `Bìa: ${compact(config.coverPaper)}` : '';
        case 'coverFinish': return config.coverFinish ? `Gia công bìa: ${compact(config.coverFinish)}` : '';
        case 'colorMode': return compact(config.colorMode);
        case 'printSides': return compact(config.printSides);
        case 'paperSize': return data.paperSizeLabel ? `Khổ in: ${compact(data.paperSizeLabel)}` : '';
        case 'notes': return config.notes ? `Ghi chú: ${compact(config.notes)}` : '';
        default: return '';
    }
}

export function buildBookReportText(
    config: BookReportDisplayConfig,
    data: BookReportPreviewData,
): string {
    if (!config.enabled) return '';

    const first: string[] = [];
    const second: string[] = [];
    for (const field of config.fieldOrder) {
        if (!config[SHOW_FLAG[field]]) continue;
        const value = valueForField(field, config, data);
        if (!value) continue;
        (FIRST_LINE_FIELDS.has(field) ? first : second).push(value);
    }

    let text = [first.join(' • '), second.join(' • ')].filter(Boolean).join('\n');
    if (config.removeDiacritics) text = removeVietnameseDiacritics(text);
    return text;
}

export function toBookReportRenderConfig(
    config: BookReportDisplayConfig,
    data: BookReportPreviewData,
): BookReportRenderConfig | undefined {
    const text = buildBookReportText(config, data);
    if (!config.enabled || !text) return undefined;
    return {
        enabled: true,
        text,
        position: config.position,
        centered: config.centered,
        offsetX: Math.max(0, Number(config.offsetX) || 0),
        offsetY: Math.max(0, Number(config.offsetY) || 0),
        fontSize: Math.max(4, Number(config.fontSize) || 7),
    };
}
