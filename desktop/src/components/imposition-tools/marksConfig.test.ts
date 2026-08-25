import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKS_CONFIG } from './marksConfig';

describe('DEFAULT_MARKS_CONFIG', () => {
    it('giữ nguyên thông số dấu xén mặc định', () => {
        expect(DEFAULT_MARKS_CONFIG).toEqual({
            style: 1,
            distance: 3,
            length: 5,
            thickness: 0.25,
        });
    });
});
