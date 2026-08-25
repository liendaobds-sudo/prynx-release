import { describe, expect, it } from 'vitest';

import { DEFAULT_PONT_CONFIG } from './pontConfigDefaults';
import { getPontConfigValidationError } from './pontConfigValidation';
import type { PontConfig } from './types';


const config = (override: Partial<PontConfig> = {}): PontConfig => ({
    ...DEFAULT_PONT_CONFIG,
    ...override,
});


describe('PontSettingsDialog validation', () => {
    it('accepts the production defaults and Unicode names', () => {
        expect(getPontConfigValidationError(config({
            layerName: 'LỚP ỐC / 01',
            groupName: 'NHÓM ỐC #1',
            itemName: 'ỐC ĐỊNH VỊ / #1',
        }))).toBeNull();
    });

    it.each([
        [{ size: 0 }, 'loi_kich_thuoc_oc'],
        [{ size: -1 }, 'loi_kich_thuoc_oc'],
        [{ thickness: 0 }, 'loi_do_day_oc'],
        [{ marginLeft: -1 }, 'loi_le_oc'],
        [{ layerName: '   ' }, 'loi_ten_lop_oc'],
        [{ groupName: '' }, 'loi_ten_nhom_oc'],
        [{ itemName: '' }, 'loi_ten_doi_tuong_oc'],
        [{ isGraphtec: true, layerInfoName: '' }, 'loi_ten_graphtec'],
        [{ guide1Enabled: true, guide1Length: 0 }, 'loi_thanh_dan'],
        [{ guide1Enabled: true, guide1Pos: 'XX' }, 'loi_thanh_dan'],
        [{ guide2Enabled: true, guide2Thickness: 0 }, 'loi_thanh_dan'],
    ] satisfies Array<[Partial<PontConfig>, string]>)('rejects %o', (override, error) => {
        expect(getPontConfigValidationError(config(override))).toBe(error);
    });
});
