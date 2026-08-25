import { describe, expect, it } from 'vitest';

import {
    createSourceImageRevisionOwner,
    isSourceImageRevisionCurrent,
} from './sourceImageRevision';

function revision(
    file: File,
    overrides: Partial<{
        viewerPageOrder: number[];
        viewerPageInstanceIds: string[];
        viewerPageRotations: number[];
        editGeneration: number;
    }> = {},
) {
    return {
        file,
        viewerPageOrder: overrides.viewerPageOrder,
        viewerPageInstanceIds: overrides.viewerPageInstanceIds,
        viewerPageRotations: overrides.viewerPageRotations,
        editGeneration: overrides.editGeneration ?? 4,
    };
}

describe('source image revision owner', () => {
    it('chỉ cho dùng ảnh shadow ở PDF một trang chưa bị chỉnh', () => {
        const pdf = new File(['pdf'], 'anh.pdf', { type: 'application/pdf' });
        const owner = createSourceImageRevisionOwner(pdf, 4);

        expect(isSourceImageRevisionCurrent(owner, revision(pdf))).toBe(true);
        expect(isSourceImageRevisionCurrent(owner, revision(pdf, {
            viewerPageOrder: [1],
            viewerPageInstanceIds: ['page-1'],
            viewerPageRotations: [0],
        }))).toBe(true);
        expect(isSourceImageRevisionCurrent(owner, revision(pdf, {
            viewerPageOrder: [1, 1],
            viewerPageInstanceIds: ['page-1', 'page-2'],
            viewerPageRotations: [0, 0],
        }))).toBe(false);
        expect(isSourceImageRevisionCurrent(owner, revision(pdf, {
            viewerPageOrder: [1],
            viewerPageRotations: [90],
        }))).toBe(false);
        expect(isSourceImageRevisionCurrent(owner, revision(pdf, {
            editGeneration: 5,
        }))).toBe(false);
        expect(isSourceImageRevisionCurrent(owner, revision(
            new File(['other'], 'other.pdf', { type: 'application/pdf' }),
        ))).toBe(false);
    });
});
