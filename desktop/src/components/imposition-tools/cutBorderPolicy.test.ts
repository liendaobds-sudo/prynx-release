import { describe, expect, it } from 'vitest';

import { canUseCutBorder } from './cutBorderPolicy';

describe('canUseCutBorder', () => {
    it.each(['nup', 'step_repeat'] as const)(
        'cho phép tác vụ xén %s trong công cụ N-Up',
        (taskMode) => {
            expect(canUseCutBorder({ activeTool: 'nup', taskMode })).toBe(true);
        },
    );

    it('chặn chế độ nguyên tờ dù task mode giống N-Up', () => {
        expect(canUseCutBorder({
            activeTool: 'nup',
            taskMode: 'step_repeat',
            pageSheetMode: true,
        })).toBe(false);
    });

    it.each([
        ['booklet', 'booklet'],
        ['sticker_imposer', 'nup'],
        ['cnc_imposer', 'step_repeat'],
        ['nup', 'offset'],
    ] as const)('chặn công cụ/chế độ không hỗ trợ %s + %s', (activeTool, taskMode) => {
        expect(canUseCutBorder({ activeTool, taskMode })).toBe(false);
    });
});
