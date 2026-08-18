import { describe, expect, it } from 'vitest';
import { initialFileOpeningPhase } from '../lib/impositionOpeningState';

describe('trạng thái mở tab kết quả bình bài', () => {
    it('hiện đang mở ngay khi tab được tạo cùng file kết quả', () => {
        const resultFile = new File(['pdf'], 'Imposed_test.pdf', {
            type: 'application/pdf',
        });

        expect(initialFileOpeningPhase(resultFile)).toBe('loading');
    });

    it('chỉ hiện uploader khi tab thật sự chưa có file', () => {
        expect(initialFileOpeningPhase(null)).toBe('idle');
    });
});
