/**
 * reportPreview.ts — Dựng chuỗi report cho XEM TRƯỚC (live preview).
 *
 * Mirror logic backend `nup_report.compute_report_data` + `build_report_string`
 * để preview khớp output. Logic thuần — không phụ thuộc React.
 */
import type { ReportDisplayConfig } from '../components/imposition-tools/types';
import { LAMINATION_OPTIONS, DEFAULT_REPORT_CONFIG } from '../components/imposition-tools/types';

const DEFAULT_FIELD_ORDER = DEFAULT_REPORT_CONFIG.fieldOrder;

function removeDiacritics(s: string): string {
    if (!s) return s || '';
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D');
}

export interface ReportPreviewData {
    orderCode?: string;
    identifier?: string;
    gangCount?: number;
    labelName?: string;
    widthMm?: number;
    heightMm?: number;
    paperSize?: string;
    itemsPerSheet?: number;
    requestedQty?: number;
    material?: string;
    laminationType?: number;
    laminationSides?: number;
    cutFileRef?: string;
    modeLabel?: string;
}

/** Tính sheetCount/actualQty + format text từng field (mirror compute_report_data). */
function computeFields(data: ReportPreviewData): Record<string, string> {
    const ips = Math.max(0, Math.floor(data.itemsPerSheet || 0));
    const qty = Math.max(0, Math.floor(data.requestedQty || 0));

    let sheetCount = 0;
    let actualQty = 0;
    if (ips <= 0) {
        sheetCount = 0; actualQty = 0;
    } else if (qty <= 0) {
        sheetCount = 1; actualQty = ips;
    } else {
        sheetCount = Math.ceil(qty / ips);
        actualQty = sheetCount * ips;
    }

    let dims = '';
    if (data.widthMm && data.heightMm) {
        dims = `${Math.round(data.widthMm)} x ${Math.round(data.heightMm)} mm`;
    }

    const lamType = Number(data.laminationType || 0);
    let lamination = lamType > 0 && lamType < LAMINATION_OPTIONS.length ? LAMINATION_OPTIONS[lamType] : '';
    const lamSides = Number(data.laminationSides || 1);
    if (lamination && lamSides >= 2) {
        lamination = `${lamination} ${lamSides} mặt`;
    }

    return {
        orderCode: data.orderCode || '',
        identifier: data.identifier || '',
        gangCount: data.gangCount && data.gangCount > 0 ? `${data.gangCount} mẫu` : '',
        labelName: data.labelName || '',
        dimensions: dims,
        paperSize: data.paperSize || '',
        labelsPerSheet: ips > 0 ? `SL/tờ: ${ips}` : '',
        sheetCount: sheetCount > 0 ? `Số tờ: ${sheetCount}` : '',
        actualQty: actualQty > 0 ? `SL thực: ${actualQty}` : '',
        material: data.material || '',
        lamination,
        cutFileRef: data.cutFileRef || '',
        modeLabel: data.modeLabel || '',
    };
}

const SHOW_FLAG_KEY: Record<string, keyof ReportDisplayConfig> = {
    identifier: 'showIdentifier',
    gangCount: 'showGangCount',
    labelName: 'showLabelName',
    dimensions: 'showDimensions',
    paperSize: 'showPaperSize',
    labelsPerSheet: 'showLabelsPerSheet',
    sheetCount: 'showSheetCount',
    actualQty: 'showActualQty',
    material: 'showMaterial',
    lamination: 'showLamination',
    cutFileRef: 'showCutFileRef',
    modeLabel: 'showModeLabel',
};

/** Nối các field được bật thành chuỗi report (mirror build_report_string). */
export function buildReportPreview(cfg: ReportDisplayConfig | undefined, data: ReportPreviewData): string {
    const rd = cfg || DEFAULT_REPORT_CONFIG;
    const fields = computeFields(data);
    const order = rd.fieldOrder && rd.fieldOrder.length ? rd.fieldOrder : DEFAULT_FIELD_ORDER;

    const parts: string[] = [];
    const orderCode = (fields.orderCode || '').trim();
    if (orderCode) parts.push(orderCode);

    const used = new Set<string>(['orderCode']);
    for (const key of order) {
        if (used.has(key)) continue;
        used.add(key);
        const flagKey = SHOW_FLAG_KEY[key];
        if (flagKey && rd[flagKey] === false) continue;
        const content = (fields[key] || '').trim();
        if (content) parts.push(content);
    }

    let result = parts.join(' - ');
    const custom = (rd.customText || '').trim();
    if (custom) result = result ? `${result} - ${custom}` : custom;
    result = result.replace(/\s*-\s*-\s*/g, ' - ').replace(/^[\s-]+|[\s-]+$/g, '');
    if (rd.removeDiacritics) result = removeDiacritics(result);
    return result;
}
