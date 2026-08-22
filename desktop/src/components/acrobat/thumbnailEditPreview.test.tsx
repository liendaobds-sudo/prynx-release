// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionPreview } from '../../hooks/useEditSession';
import {
    editPreviewDocumentChanged,
    groupEditPreviewsBySourcePage,
    sameEditPreviewSequence,
    shouldLoadEditObjectsForFrame,
    ThumbnailEditPreviewLayer,
} from './thumbnailEditPreview';


function preview(
    page: number,
    url: string,
    clipRect: SessionPreview['clipRect'],
    full = false,
): SessionPreview {
    return { page, url, clipRect, full };
}

describe('thumbnail edit preview — ánh xạ và giới hạn render', () => {
    it('gom theo trang nguồn và giữ memo của trang không bị sửa', () => {
        const pageOne = preview(0, 'data:image/png;base64,page-one', [10, 10, 30, 30]);
        const pageTwo = preview(1, 'data:image/png;base64,page-two', null, true);
        const before = groupEditPreviewsBySourcePage([pageOne, pageTwo]);
        const nextPageOne = preview(0, 'data:image/png;base64,page-one-next', [40, 40, 60, 60]);
        const after = groupEditPreviewsBySourcePage([pageOne, pageTwo, nextPageOne]);

        expect(before.get(1)).toEqual([pageOne]);
        expect(before.get(2)).toEqual([pageTwo]);
        expect(sameEditPreviewSequence(before.get(2), after.get(2))).toBe(true);
        expect(sameEditPreviewSequence(before.get(1), after.get(1))).toBe(false);
    });

    it('dán clip đúng theo phần trăm trang và lớp full phủ toàn thumbnail', () => {
        render(
            <div style={{ position: 'relative', width: 100, height: 200 }}>
                <ThumbnailEditPreviewLayer
                    previews={[
                        preview(0, 'data:image/png;base64,clip', [25, 20, 75, 80]),
                        preview(0, 'data:image/png;base64,full', null, true),
                    ]}
                    pageWidthPt={100}
                    pageHeightPt={100}
                />
            </div>,
        );

        const [clip, full] = screen.getAllByTestId('thumbnail-edit-preview');
        expect(clip.style.left).toBe('25%');
        expect(clip.style.top).toBe('20%');
        expect(clip.style.width).toBe('50%');
        expect(clip.style.height).toBe('60%');
        expect(full.style.left).toBe('0px');
        expect(full.style.top).toBe('0px');
        expect(full.style.width).toBe('100%');
        expect(full.style.height).toBe('100%');
    });

    it('kẹp clip vượt PageBox để không tràn sang thumbnail khác', () => {
        render(
            <ThumbnailEditPreviewLayer
                previews={[
                    preview(1, 'data:image/png;base64,clamped', [-10, -5, 120, 140]),
                ]}
                pageWidthPt={100}
                pageHeightPt={100}
            />,
        );

        const layer = screen.getByTestId('thumbnail-edit-preview');
        expect(layer.getAttribute('data-source-page')).toBe('2');
        expect(layer.style.left).toBe('0%');
        expect(layer.style.top).toBe('0%');
        expect(layer.style.width).toBe('100%');
        expect(layer.style.height).toBe('100%');
    });

    it('chỉ nạp metadata object cho đúng frame active khi cuộn nhiều trang', () => {
        const common = {
            isObjectEditMode: true,
            originalPageNum: 2,
            selectionFileId: 'fid-live',
            hasPageHeight: true,
        };
        expect(shouldLoadEditObjectsForFrame({
            ...common,
            isActiveFrame: true,
        })).toBe(true);
        expect(shouldLoadEditObjectsForFrame({
            ...common,
            isActiveFrame: false,
        })).toBe(false);
        expect(shouldLoadEditObjectsForFrame({
            ...common,
            isActiveFrame: true,
            isObjectEditMode: false,
        })).toBe(false);
        expect(shouldLoadEditObjectsForFrame({
            ...common,
            isActiveFrame: true,
            selectionFileId: '',
        })).toBe(false);
        expect(shouldLoadEditObjectsForFrame({
            ...common,
            isActiveFrame: true,
            originalPageNum: -1,
        })).toBe(false);

        const eligible = Array.from({ length: 100 }, (_unused, index) => (
            shouldLoadEditObjectsForFrame({
                ...common,
                originalPageNum: index + 1,
                isActiveFrame: index === 37,
            })
        )).filter(Boolean);
        // Với 100 frame mounted/overscan, chỉ đúng trang active được phép gọi API.
        expect(eligible).toHaveLength(1);
    });

    it('không xem frame ảo mount cùng URL là một revision tài liệu mới', () => {
        expect(editPreviewDocumentChanged('localfile://working.pdf|fid-1', 'localfile://working.pdf|fid-1'))
            .toBe(false);
        expect(editPreviewDocumentChanged('localfile://working.pdf|fid-1', 'localfile://edited.pdf|fid-2'))
            .toBe(true);
        expect(editPreviewDocumentChanged('localfile://working.pdf|fid-1', 'localfile://working.pdf|fid-2'))
            .toBe(true);
    });
});
