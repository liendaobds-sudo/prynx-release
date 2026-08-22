import { describe, expect, it } from 'vitest';

import {
    clampOutputPreviewPanelOffset,
    OUTPUT_PREVIEW_WORKSPACE_GAP_PX,
} from './outputPreviewPanelLayout';

describe('Output Preview — vị trí panel trong vùng làm việc', () => {
    it('giữ khoảng hở dương với mép trên vùng làm việc', () => {
        expect(OUTPUT_PREVIEW_WORKSPACE_GAP_PX).toBeGreaterThan(0);
    });

    const bounds = {
        workspaceWidth: 900,
        workspaceHeight: 700,
        panelWidth: 380,
        panelHeight: 500,
    };

    it('không cho kéo panel ra khỏi bất kỳ cạnh nào', () => {
        expect(clampOutputPreviewPanelOffset({ x: -999, y: -80 }, bounds))
            .toEqual({ x: -450, y: 0 });
        expect(clampOutputPreviewPanelOffset({ x: 999, y: 999 }, bounds))
            .toEqual({ x: 50, y: 180 });
    });

    it('giữ nguyên vị trí kéo hợp lệ', () => {
        expect(clampOutputPreviewPanelOffset({ x: 16, y: 32 }, bounds))
            .toEqual({ x: 16, y: 32 });
    });

    it('re-clamp được vị trí cũ khi workspace thu nhỏ', () => {
        expect(clampOutputPreviewPanelOffset({ x: -300, y: 160 }, {
            ...bounds,
            workspaceWidth: 600,
            workspaceHeight: 580,
        })).toEqual({ x: -150, y: 60 });
    });
});
