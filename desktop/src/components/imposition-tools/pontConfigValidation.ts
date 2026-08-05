import type { PontConfig } from './types';


export type PontConfigValidationError =
    | 'loi_hinh_dang_oc'
    | 'loi_kich_thuoc_oc'
    | 'loi_do_day_oc'
    | 'loi_le_oc'
    | 'loi_ten_lop_oc'
    | 'loi_ten_nhom_oc'
    | 'loi_ten_doi_tuong_oc'
    | 'loi_ten_graphtec'
    | 'loi_thanh_dan';

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

export const getPontConfigValidationError = (config: PontConfig): PontConfigValidationError | null => {
    // UIUX (audit 2026-08-05 §OC.2): chặn trước khi lưu để không xuất PDF
    // "thành công" với ốc vô hình hoặc layer/object không tên.
    if (!['circle', 'l_corner', 'l_inverted'].includes(config.shape)) return 'loi_hinh_dang_oc';
    if (!isFiniteNumber(config.size) || config.size <= 0) return 'loi_kich_thuoc_oc';
    if (!isFiniteNumber(config.thickness) || config.thickness <= 0) return 'loi_do_day_oc';
    if ([config.marginTop, config.marginBottom, config.marginLeft, config.marginRight]
        .some(value => !isFiniteNumber(value) || value < 0)) return 'loi_le_oc';
    if (!config.layerName?.trim()) return 'loi_ten_lop_oc';
    if (!config.groupName?.trim()) return 'loi_ten_nhom_oc';
    if (!config.itemName?.trim()) return 'loi_ten_doi_tuong_oc';
    if (config.isGraphtec && !config.layerInfoName?.trim()) return 'loi_ten_graphtec';

    for (const guide of [
        { enabled: config.guide1Enabled, position: config.guide1Pos, length: config.guide1Length, thickness: config.guide1Thickness, offX: config.guide1OffX, offY: config.guide1OffY },
        { enabled: config.guide2Enabled, position: config.guide2Pos, length: config.guide2Length, thickness: config.guide2Thickness, offX: config.guide2OffX, offY: config.guide2OffY },
    ]) {
        if (guide.enabled && (
            !['TL', 'TR', 'BL', 'BR'].includes(guide.position)
            || !isFiniteNumber(guide.length) || guide.length <= 0
            || !isFiniteNumber(guide.thickness) || guide.thickness <= 0
            || !isFiniteNumber(guide.offX) || !isFiniteNumber(guide.offY)
        )) return 'loi_thanh_dan';
    }
    return null;
};
