import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('portal của workspace khi tab ở nền', () => {
    it('truyền trạng thái tab vào dashboard và đóng mọi dialog portal ở nền', () => {
        const tabSource = readFileSync(resolve(process.cwd(), 'src/components/ImpositionTab.tsx'), 'utf8');
        const dashboardSource = readFileSync(resolve(process.cwd(), 'src/components/imposition-tools/ImposerDashboard.tsx'), 'utf8');

        expect(tabSource).toMatch(/<ImposerDashboard[\s\S]*?isActive=\{isActive\}/);
        for (const openExpression of [
            'isOpen={isActive !== false && s.showSettings}',
            'isOpen={isActive !== false && s.showMarksModal}',
            'isOpen={isActive !== false && s.showPontModal}',
            'isOpen={isActive !== false && s.isPresetOpen}',
            'isOpen={isActive !== false && s.showFlipbook}',
            'isOpen={isActive !== false && s.showSheetViewer}',
        ]) {
            expect(dashboardSource).toContain(openExpression);
        }
    });
});
