// Áp dụng một RecommendationOption (ProductAdvisor) vào useImposerSettingsStore.
// Tách khỏi ProductAdvisor (thuần toán) để module lõi không phụ thuộc store/UI.

import type { StoreApi } from 'zustand';
import type { ImposerSettingsState } from './useImposerSettingsStore';
import type { RecommendationOption } from '../../lib/imposerEngine/ProductAdvisor';

/**
 * Đổ bundle của option đã chọn vào store. Chỉ set field in nhanh; KHÔNG đụng
 * foldPattern/gripperMargin/interleave (bundle không chứa). `chainNup` được engine
 * suy từ scaleMode ('chain_nup'/'cut_stack') ở handleStartBooklet nên không set ở đây.
 */
export function applyRecommendation(
    store: StoreApi<ImposerSettingsState>,
    option: RecommendationOption,
): void {
    const b = option.settings;
    const s = store.getState();
    s.setTaskMode(b.taskMode);
    s.setPaperClassification(b.paperClassification);
    s.setSignatureMode(b.signatureMode);
    s.setScaleMode(b.scaleMode);
    s.setFormsize(b.formsize);
    s.setCustomSheetWidth(b.customSheetWidth);
    s.setCustomSheetHeight(b.customSheetHeight);
    s.setBleed(b.bleed);
    s.setGapX(b.gapX);
    s.setGapY(b.gapY);
    s.setBlankPlacement(b.blankPlacement);
    s.setSpreadDistribution(b.spreadDistribution);
    if (b.foliosize != null) s.setFoliosize(b.foliosize);
}
