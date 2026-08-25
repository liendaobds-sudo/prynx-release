// src/lib/imposerEngine/ProductAdvisor.ts
// =========================================================================
//  Product-First Advisor — IN NHANH (digital) — Phase 1
//
//  Người dùng khai báo SẢN PHẨM + khổ giấy in nhanh + file → đề xuất bộ thiết
//  lập bình (cho engine booklet hiện tại) kèm "1 tờ mấy con", số tờ in, %hao.
//
//  Thuần toán — KHÔNG UI, KHÔNG đụng PDF. Tái dùng engine sẵn có:
//    - NupGridSolver.solveOptimalNupLayout  → fit "1 tờ mấy con" (đã xử lý xoay)
//    - VirtualMap.generateBindingMap        → số tay/mặt mỗi cuốn
//
//  RÀNG BUỘC: chỉ in nhanh. Bundle KHÔNG bao giờ chứa foldPattern / gripperMargin
//  / interleave (đó là offset) — Property 1, có test chặn.
// =========================================================================

import { MM_TO_POINTS } from '../pdfImposer';
import { solveOptimalNupLayout } from './NupGridSolver';
import type { NupBlock, NupCell } from './NupGridSolver';
import { generateBindingMap } from './VirtualMap';

// ==================== TYPES ====================

/** Kiểu đóng cho in nhanh (sản phẩm). */
export type InNhanhBinding = 'saddle' | 'thread' | 'perfect' | 'cut_stacks' | 'flush_mount';

export type EngineSignatureMode = 'saddle' | 'thread' | 'continuous' | 'cut_stacks' | 'flush_mount';

export interface ProductInput {
    printMethod: 'in_nhanh';          // Phase 1 khoá cứng
    binding: InNhanhBinding;
    finishedWidthMm: number;          // khổ thành phẩm (trim)
    finishedHeightMm: number;
    pageCount: number;
    sheetKey?: string;                // key khổ giấy (chỉ để hiển thị)
    sheetWidthMm: number;
    sheetHeightMm: number;
    quantity?: number;                // số cuốn cần (để ước tính tờ in)
    bleedMm?: number;                 // mặc định 3
    foliosize?: number;               // cho thread (bội số 4)
    marginMm?: number;                // lề quanh khổ (mặc định 0 cho in nhanh)
}

/** Bộ knob đổ vào useImposerSettingsStore (chỉ field in nhanh). */
export interface BookletSettingsBundle {
    taskMode: 'booklet';
    paperClassification: 'in_nhanh';
    signatureMode: EngineSignatureMode;
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    chainNup: boolean;
    cutStack: boolean;
    formsize: string;                 // 'custom'
    customSheetWidth: number;         // mm
    customSheetHeight: number;        // mm
    bleed: number;                    // mm
    gapX: number;
    gapY: number;
    blankPlacement: 'end' | 'center';
    spreadDistribution: 'clustered' | 'even';
    foliosize?: number;
}

export interface RecommendationOption {
    id: string;
    strategy: 'one_up' | 'multi_up' | 'cut_stack';
    copiesPerSheet: number;           // "1 tờ mấy con"
    cols: number;
    rows: number;
    rotatedSheet: boolean;            // có xoay spread 90° để fit tốt hơn không
    sheetsPerCopySet: number;         // số tờ in cho 1 lượt (in duplex: = số tờ/cuốn)
    totalSheets?: number;             // nếu có quantity
    wastePercent: number;             // %hao lấp đầy (0..100)
    explanation: string;
    warnings: string[];
    settings: BookletSettingsBundle;
}

export interface RecommendResult {
    options: RecommendationOption[];  // đã xếp hạng (tốt nhất trước); [] nếu bất khả thi
    errors: string[];
}

// ==================== MAPPING ====================

const BINDING_TO_SIGMODE: Record<InNhanhBinding, EngineSignatureMode> = {
    saddle: 'saddle',
    thread: 'thread',
    perfect: 'continuous',
    cut_stacks: 'cut_stacks',
    flush_mount: 'flush_mount',
};

// ==================== HELPERS ====================

/** Footprint vật lý 1 spread (2 trang ghép ngang) trên tờ in, gồm bleed. (pt) */
function spreadFootprintPt(finishedWmm: number, finishedHmm: number, bleedMm: number) {
    // page-with-bleed = trim + 2*bleed mỗi chiều; 2 trang ghép ngang, bleed gáy chồng nhau.
    const w = (finishedWmm * 2 + 2 * bleedMm) * MM_TO_POINTS;
    const h = (finishedHmm + 2 * bleedMm) * MM_TO_POINTS;
    return { w, h };
}

/** Số tờ in vật lý / cuốn (in duplex: 1 tờ = 2 mặt). */
function sheetsPerCopy(pageCount: number, sigMode: EngineSignatureMode, foliosize: number): number {
    const map = generateBindingMap(Math.max(pageCount, 1), sigMode, foliosize, 'end');
    return Math.max(1, map.sheets.length);
}

function makeBundle(
    input: ProductInput,
    strategy: RecommendationOption['strategy'],
): BookletSettingsBundle {
    const sigMode = BINDING_TO_SIGMODE[input.binding];
    const bleed = input.bleedMm ?? 3;
    const base: BookletSettingsBundle = {
        taskMode: 'booklet',
        paperClassification: 'in_nhanh',
        signatureMode: sigMode,
        scaleMode: 'fit',
        chainNup: false,
        cutStack: false,
        formsize: 'custom',
        customSheetWidth: input.sheetWidthMm,
        customSheetHeight: input.sheetHeightMm,
        bleed,
        gapX: 0,
        gapY: 0,
        blankPlacement: 'end',
        spreadDistribution: 'clustered',
        foliosize: input.foliosize ?? 16,
    };
    if (strategy === 'multi_up') {
        base.scaleMode = 'chain_nup';
        base.chainNup = true;
    } else if (strategy === 'cut_stack') {
        // Sản phẩm cắt-ráp-xấp dùng signatureMode 'cut_stacks' (đã set qua binding).
        base.scaleMode = 'fit';
    }
    return base;
}

// ==================== CORE ====================

export function recommendInNhanh(input: ProductInput): RecommendResult {
    const errors: string[] = [];
    const bleed = input.bleedMm ?? 3;
    const foliosize = input.foliosize ?? 16;
    const sigMode = BINDING_TO_SIGMODE[input.binding];

    // Validate cơ bản
    if (!(input.finishedWidthMm > 0 && input.finishedHeightMm > 0)) {
        return { options: [], errors: ['Khổ thành phẩm không hợp lệ.'] };
    }
    if (!(input.sheetWidthMm > 0 && input.sheetHeightMm > 0)) {
        return { options: [], errors: ['Khổ giấy không hợp lệ.'] };
    }
    if (input.pageCount < 1) {
        return { options: [], errors: ['File chưa có trang nào.'] };
    }

    const margin = input.marginMm ?? 0;
    const usableW = (input.sheetWidthMm - 2 * margin) * MM_TO_POINTS;
    const usableH = (input.sheetHeightMm - 2 * margin) * MM_TO_POINTS;
    const spread = spreadFootprintPt(input.finishedWidthMm, input.finishedHeightMm, bleed);

    // Fit "1 tờ mấy con" — tái dùng NupGridSolver (đã thử xoay 90°).
    const layout = solveOptimalNupLayout(usableW, usableH, spread.w, spread.h, 0, 0, 'simple_auto', 0, 0);
    const copiesPerSheet = layout.totalItems;

    if (copiesPerSheet < 1) {
        // Khổ quá nhỏ — gợi ý khổ tối thiểu (1 spread + lề).
        const minWmm = Math.ceil(spread.w / MM_TO_POINTS + 2 * margin);
        const minHmm = Math.ceil(spread.h / MM_TO_POINTS + 2 * margin);
        errors.push(
            `Khổ giấy ${input.sheetWidthMm}×${input.sheetHeightMm}mm quá nhỏ: 1 spread cần tối thiểu ` +
            `~${minWmm}×${minHmm}mm. Hãy chọn khổ lớn hơn hoặc giảm khổ thành phẩm.`
        );
        return { options: [], errors };
    }

    const firstCell: NupCell | undefined = layout.cells[0];
    const firstBlock: NupBlock | undefined = layout.blocks[0];
    const rotatedSheet = firstCell?.isRotated === true;
    const cols = firstBlock?.cols ?? 0;
    const rows = firstBlock?.rows ?? 0;
    const sheetsPerCopy_ = sheetsPerCopy(input.pageCount, sigMode, foliosize);
    const sheetAreaPt = usableW * usableH;
    const spreadAreaPt = spread.w * spread.h;

    // Cảnh báo padding trang trắng
    const padBase = sigMode === 'flush_mount' ? 2 : 4;
    const padded = Math.ceil(input.pageCount / padBase) * padBase;
    const sharedWarnings: string[] = [];
    if (padded !== input.pageCount) {
        sharedWarnings.push(
            `Số trang ${input.pageCount} không chia hết ${padBase} → chèn ${padded - input.pageCount} trang trắng ` +
            `(vị trí: cuối sách — đổi được trong Nâng cao).`
        );
    }

    const buildOption = (strategy: RecommendationOption['strategy'], n: number): RecommendationOption => {
        const waste = sheetAreaPt > 0 ? Math.max(0, Math.round((1 - (n * spreadAreaPt) / sheetAreaPt) * 1000) / 10) : 0;
        const totalSheets = input.quantity && input.quantity > 0
            ? sheetsPerCopy_ * Math.ceil(input.quantity / n)
            : undefined;
        const sheetLabel = input.sheetKey || `${input.sheetWidthMm}×${input.sheetHeightMm}mm`;
        const parts = [
            `1 tờ ${sheetLabel} = ${n} cuốn/tờ`,
            `${padded} trang → ${sheetsPerCopy_} tờ/cuốn`,
        ];
        if (totalSheets !== undefined) parts.push(`tổng ${totalSheets} tờ in cho ${input.quantity} cuốn`);
        if (rotatedSheet) parts.push('(xoay khổ để fit)');
        return {
            id: `${strategy}_${n}`,
            strategy,
            copiesPerSheet: n,
            cols, rows, rotatedSheet,
            sheetsPerCopySet: sheetsPerCopy_,
            totalSheets,
            wastePercent: waste,
            explanation: parts.join(' • '),
            warnings: [...sharedWarnings],
            settings: makeBundle(input, strategy),
        };
    };

    const options: RecommendationOption[] = [];

    if (input.binding === 'cut_stacks') {
        // Sản phẩm cắt-ráp-xấp: 1 phương án (binding cut_stacks lo việc ghép nửa).
        options.push(buildOption('cut_stack', Math.max(1, copiesPerSheet)));
    } else {
        if (copiesPerSheet >= 2) {
            // Nhiều cuốn/tờ (step & repeat) — tối ưu số tờ in.
            options.push(buildOption('multi_up', copiesPerSheet));
        }
        // Luôn có phương án 1 cuốn/tờ làm lựa chọn an toàn/đối chiếu.
        options.push(buildOption('one_up', 1));
    }

    // Xếp hạng: ít tờ in hơn (copiesPerSheet cao) trước.
    options.sort((a, b) => b.copiesPerSheet - a.copiesPerSheet);

    return { options, errors };
}
