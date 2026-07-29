import { describe, expect, it } from 'vitest';

import {
    clampOutputPreviewPanelOffset,
    OUTPUT_PREVIEW_WORKSPACE_GAP_PX,
} from './outputPreviewPanelLayout';

describe('Output Preview — vị trí panel trong vùng làm việc', () => {
    it('giữ khoảng hở dương với mép trên vùng làm việc', () => {
        expect(OUTPUT_PREVIEW_WORKSPACE_GAP_PX).toBeGreaterThan(0);
    });

    it('không cho kéo panel lên phía sau thanh ứng dụng', () => {
        expect(clampOutputPreviewPanelOffset({ x: -24, y: -80 }))
            .toEqual({ x: -24, y: 0 });
    });

    it('giữ nguyên vị trí kéo hợp lệ', () => {
        expect(clampOutputPreviewPanelOffset({ x: 16, y: 32 }))
            .toEqual({ x: 16, y: 32 });
    });
});
