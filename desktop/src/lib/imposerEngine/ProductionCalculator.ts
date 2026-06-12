// src/lib/imposerEngine/ProductionCalculator.ts
// =========================================================================
//  Tính toán sản lượng, hao hụt, cân bài — Theo đặc tả §10
// =========================================================================

import type { SpoilagePolicy, FormProductionMetrics, PressMode, TurnPolicy } from './ImpositionTypes';

/**
 * Số bộ cần sản xuất (gồm hao hụt)
 * §10.2: required_sets = ceil(books × (1 + spoilage_rate))
 */
export function computeRequiredSets(
    books: number,
    spoilagePolicy: SpoilagePolicy,
    stockGroup: string
): number {
    let rate = spoilagePolicy.default_rate;
    if (spoilagePolicy.method === 'per_stock_group') {
        if (stockGroup === 'cover' && spoilagePolicy.cover_rate != null) {
            rate = spoilagePolicy.cover_rate;
        } else if (stockGroup === 'text' && spoilagePolicy.text_rate != null) {
            rate = spoilagePolicy.text_rate;
        }
    }

    const setsFromRate = Math.ceil(books * (1 + rate));

    if (spoilagePolicy.flat_sheets != null && spoilagePolicy.flat_sheets > 0) {
        return setsFromRate + spoilagePolicy.flat_sheets;
    }
    return setsFromRate;
}

/**
 * Số tờ cần in cho một bài
 * §10.2: sheets_required = ceil(required_sets / sets_per_sheet)
 */
export function computeSheetsRequired(requiredSets: number, setsPerSheet: number): number {
    if (setsPerSheet <= 0) return requiredSets;
    return Math.ceil(requiredSets / setsPerSheet);
}

/**
 * Số lượt in (Pass = Impression)
 * §10.2: impressions = sheets_required × passes_per_sheet
 */
export function computeImpressions(sheetsRequired: number, passesPerSheet: number): number {
    return sheetsRequired * passesPerSheet;
}

/**
 * Số lượt in trên mỗi tờ
 * §10.4:
 *   - Máy 1 mặt: 2 pass (in A rồi trở in B)
 *   - Perfecting press: 1 pass
 *   - Self-turn: 2 pass (cùng kẽm nhưng trở giấy)
 */
export function resolvePassesPerSheet(
    pressMode: PressMode,
    workStyle: TurnPolicy
): number {
    if (pressMode === 'perfecting') return 1;
    // Máy 1 mặt: sheetwise = 2 pass, self-turn = 2 pass (khác logic, cùng số)
    return 2;
}

/**
 * Số mặt kẽm (plate sides)
 * §10.3:
 *   - Sheetwise (A/B): 2 mặt kẽm
 *   - Self-turn (work_and_turn / work_and_tumble): 1 mặt kẽm
 */
export function resolvePlateSides(workStyle: TurnPolicy): number {
    if (workStyle === 'work_and_turn' || workStyle === 'work_and_tumble') return 1;
    return 2; // sheetwise hoặc perfecting
}

/**
 * Số bộ/tờ (sets per sheet)
 * §4.1:
 *   - Tay 16 (sheetwise): 1 bộ/tờ
 *   - Tay 8 tự trở: 1 bộ/tờ
 *   - Tay 4 tự trở: 2 bộ/tờ
 *   - Bìa tự trở: 2 bìa/tờ
 */
export function resolveSetsPerSheet(sigSize: number, workStyle: TurnPolicy): number {
    if (workStyle === 'sheetwise' || workStyle === 'perfecting') return 1;
    // Self-turn: tay 4 → 2 bộ/tờ, tay 8 → 1 bộ/tờ
    if (sigSize <= 4) return 2;
    return 1;
}

/**
 * Cân bài — Yield balancing
 * §10.6: Số cuốn giao hữu dụng = min(tất cả bộ hữu dụng của mọi form)
 */
export function computeYieldBalance(
    metrics: FormProductionMetrics[]
): { max_deliverable_sets: number; bottleneck_form: string } {
    if (metrics.length === 0) {
        return { max_deliverable_sets: 0, bottleneck_form: '' };
    }

    let minSets = Infinity;
    let bottleneck = '';

    for (const m of metrics) {
        // Số bộ hữu dụng = sheets_required × sets_per_sheet
        // (thực tế lô in thường ra đúng required_sets, trừ khi bị hư thêm)
        const usableSets = m.sheets_required * m.sets_per_sheet;
        if (usableSets < minSets) {
            minSets = usableSets;
            bottleneck = m.form_id;
        }
    }

    return { max_deliverable_sets: minSets, bottleneck_form: bottleneck };
}

/**
 * Tính toàn bộ production metrics cho 1 form
 */
export function computeFormMetrics(
    formId: string,
    sigSize: number,
    workStyle: TurnPolicy,
    stockGroup: string,
    books: number,
    spoilagePolicy: SpoilagePolicy,
    pressMode: PressMode
): FormProductionMetrics {
    const setsPerSheet = resolveSetsPerSheet(sigSize, workStyle);
    const requiredSets = computeRequiredSets(books, spoilagePolicy, stockGroup);
    const sheetsRequired = computeSheetsRequired(requiredSets, setsPerSheet);
    const passesPerSheet = resolvePassesPerSheet(pressMode, workStyle);
    const impressions = computeImpressions(sheetsRequired, passesPerSheet);
    const plateSides = resolvePlateSides(workStyle);

    return {
        form_id: formId,
        sets_per_sheet: setsPerSheet,
        required_sets: requiredSets,
        sheets_required: sheetsRequired,
        passes_per_sheet: passesPerSheet,
        impressions,
        plate_sides: plateSides,
        stock_group: stockGroup,
    };
}
