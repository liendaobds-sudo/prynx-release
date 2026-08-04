import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_CONFIG } from '../components/imposition-tools/types';
import { buildReportPreview } from './reportPreview';

describe('buildReportPreview — độ chính xác kích thước', () => {
    const reportConfig = { ...DEFAULT_REPORT_CONFIG, showDimensions: true };

    it('giữ 0,1 mm cho kích thước thành phẩm thực tế', () => {
        expect(buildReportPreview(reportConfig, {
            widthMm: 147.1215,
            heightMm: 51.3327,
        })).toContain('147.1 x 51.3 mm');
    });

    it('dùng quy tắc làm tròn nửa lên', () => {
        expect(buildReportPreview(reportConfig, {
            widthMm: 148.55,
            heightMm: 51.25,
        })).toContain('148.6 x 51.3 mm');
    });
});
