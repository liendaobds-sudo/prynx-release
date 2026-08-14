import { describe, expect, it } from 'vitest';

import {
    isViewerTargetScaleReady,
    isViewportTargetCurrent,
    shouldEnableViewerAccurateLayer,
    shouldCompositeViewerTile,
    shouldMountViewerViewportLayer,
    shouldRenderViewerAccurateBaseTile,
    shouldRenderViewerAccurateUnderlay,
    shouldPresentViewerPanGrid,
    selectViewerAccurateBaseZoom,
    shouldRenderViewerBasePage,
    shouldRenderViewerBaseTile,
    shouldShowOutputPreviewBitmap,
    shouldKeepViewerAccurateBaseMounted,
    shouldRequestViewerAccurateBase,
    shouldUseViewerDisplayLayer,
    shouldUseViewerAccurateSimulation,
    viewerBackgroundRenderOwnerId,
    viewerAccurateBaseScaleForRole,
    viewerPageRenderPriority,
    viewerRenderGroupKey,
    viewerTileFileKey,
    VIEWER_ACCURATE_UNDERLAY_SCALE,
} from './LivePageFrame';

describe('Viewer — policy ghép tile progressive', () => {
    it('không cho PDFium hoàn tất muộn ghi đè PPE cùng scale', () => {
        expect(shouldCompositeViewerTile(2, 2, 'display', 2)).toBe(false);
        expect(shouldCompositeViewerTile(2, 2, 'display', 4)).toBe(false);
    });

    it('cho PPE nâng chất lượng và cho cùng pipeline tăng độ nét', () => {
        expect(shouldCompositeViewerTile(1, 2, 'accurate', 2)).toBe(true);
        expect(shouldCompositeViewerTile(1, 2, 'display', 3)).toBe(true);
        expect(shouldCompositeViewerTile(1, 3, 'display', 2)).toBe(false);
    });

    it('không mount target viewport thuộc settled generation cũ', () => {
        expect(isViewportTargetCurrent('zoom:old', 'zoom:new')).toBe(false);
        expect(isViewportTargetCurrent('zoom:new', 'zoom:new')).toBe(true);
    });

    it('tách group render cho hai instance cùng source page', () => {
        const instanceA = viewerRenderGroupKey(1, 'instance-a', false);
        const instanceB = viewerRenderGroupKey(1, 'instance-b', false);

        expect(instanceA).not.toBe(instanceB);
        expect(instanceA).toBe('page:1:instance:instance-a:page');
        expect(viewerRenderGroupKey(1, 'instance-a', true))
            .toBe('page:1:instance:instance-a:viewport');
    });

    it('tách cache Blob khi file bị save-over cùng đường dẫn', () => {
        const first = viewerTileFileKey('D:\\jobs\\same.pdf', true, '100:200:300');
        const second = viewerTileFileKey('D:\\jobs\\same.pdf', true, '101:201:301');
        expect(first).not.toBe(second);
    });

    it('tách cache accurate theo profile và rendering intent', () => {
        const fogra = viewerTileFileKey(
            'D:\\jobs\\same.pdf', true, '100:200:300', undefined, 'fogra39', 'relative',
        );
        const swop = viewerTileFileKey(
            'D:\\jobs\\same.pdf', true, '100:200:300', undefined, 'swop', 'relative',
        );
        const perceptual = viewerTileFileKey(
            'D:\\jobs\\same.pdf', true, '100:200:300', undefined, 'swop', 'perceptual',
        );
        const displayFogra = viewerTileFileKey(
            'D:\\jobs\\same.pdf', false, '100:200:300', undefined, 'fogra39', 'relative',
        );
        const displaySwop = viewerTileFileKey(
            'D:\\jobs\\same.pdf', false, '100:200:300', undefined, 'swop', 'perceptual',
        );

        expect(new Set([fogra, swop, perceptual])).toHaveLength(3);
        expect(displayFogra).toBe(displaySwop);
    });

    it('tách cache accurate theo toàn bộ contract Show/Paper/Black/Background', () => {
        const defaultProof = viewerTileFileKey(
            'D:\\jobs\\same.pdf', true, '100:200:300', undefined,
            'fogra39', 'relative', 'show:all|paper:0|black:0|background:profile',
        );
        const textOnPaper = viewerTileFileKey(
            'D:\\jobs\\same.pdf', true, '100:200:300', undefined,
            'fogra39', 'relative', 'show:text|paper:1|black:1|background:245-240-235',
        );
        const displayDefault = viewerTileFileKey(
            'D:\\jobs\\same.pdf', false, '100:200:300', undefined,
            'fogra39', 'relative', 'show:all|paper:0|black:0|background:profile',
        );
        const displayText = viewerTileFileKey(
            'D:\\jobs\\same.pdf', false, '100:200:300', undefined,
            'fogra39', 'relative', 'show:text|paper:1|black:1|background:245-240-235',
        );

        expect(defaultProof).not.toBe(textOnPaper);
        expect(displayDefault).toBe(displayText);
    });

    it('giữ nền accurate đã dựng trong lúc viewport nét đang chuẩn bị', () => {
        expect(shouldRenderViewerBaseTile(true, true, true, true)).toBe(true);
        expect(shouldRenderViewerBaseTile(true, false, true, true)).toBe(true);
        expect(shouldRenderViewerBaseTile(true, true, false, true)).toBe(true);
        expect(shouldRenderViewerBaseTile(true, true, true, false)).toBe(true);
        expect(shouldRenderViewerBaseTile(false, true, true, true)).toBe(false);
    });

    it('khởi động full-page PPE ngay, không chờ lớp display trên trang màu rủi ro', () => {
        expect(shouldRenderViewerBaseTile(true, true, false, true)).toBe(true);
        expect(shouldRenderViewerBaseTile(true, true, true, true)).toBe(true);
        expect(shouldRenderViewerAccurateBaseTile(true, true, false)).toBe(true);
        expect(shouldRenderViewerAccurateBaseTile(true, true, true)).toBe(false);
        expect(shouldRenderViewerAccurateBaseTile(true, false, false)).toBe(false);
        expect(shouldRenderViewerAccurateBaseTile(false, true, false)).toBe(false);
        expect(shouldEnableViewerAccurateLayer(true, false, false)).toBe(true);
        expect(shouldEnableViewerAccurateLayer(true, true, false)).toBe(true);
        expect(shouldEnableViewerAccurateLayer(false, true, true)).toBe(false);
    });

    it('không cho PDFium vào DOM của trang màu rủi ro kể cả lúc cold-open', () => {
        expect(shouldUseViewerDisplayLayer(true, false)).toBe(false);
        expect(shouldUseViewerDisplayLayer(true, true)).toBe(false);
        expect(shouldUseViewerDisplayLayer(false, false)).toBe(true);
        expect(shouldUseViewerDisplayLayer(false, true)).toBe(true);
        expect(shouldEnableViewerAccurateLayer(true, false, true)).toBe(true);
    });

    it('Output Preview buộc Simulation nhưng giữ ảnh an toàn tới khi PPE sẵn sàng', () => {
        expect(shouldUseViewerAccurateSimulation(false, true)).toBe(true);
        expect(shouldUseViewerAccurateSimulation(false, false)).toBe(false);
        expect(shouldUseViewerAccurateSimulation(true, false)).toBe(true);
        expect(shouldUseViewerDisplayLayer(true, false, true)).toBe(true);
        expect(shouldUseViewerDisplayLayer(true, true, true)).toBe(false);
    });

    it('gắn bitmap Output Preview bằng page identity riêng, không phụ thuộc danh sách kẽm', () => {
        expect(shouldShowOutputPreviewBitmap(true, 2, 2)).toBe(true);
        expect(shouldShowOutputPreviewBitmap(true, 2, 1)).toBe(false);
        expect(shouldShowOutputPreviewBitmap(true, null, 2)).toBe(false);
        expect(shouldShowOutputPreviewBitmap(false, 2, 2)).toBe(false);
    });

    it('không coi PPE coarse là bitmap target đã nét xong', () => {
        expect(isViewerTargetScaleReady(0.25, 1)).toBe(false);
        expect(isViewerTargetScaleReady(1, 1)).toBe(true);
        expect(isViewerTargetScaleReady(1.25, 1)).toBe(true);
    });

    it('giữ nền accurate cũ qua zoom cao và warm fallback nếu chỉ viewport đã đúng', () => {
        expect(shouldKeepViewerAccurateBaseMounted(true, false, true)).toBe(true);
        expect(shouldKeepViewerAccurateBaseMounted(true, true, false)).toBe(true);
        expect(shouldKeepViewerAccurateBaseMounted(false, true, true)).toBe(false);
        expect(shouldRequestViewerAccurateBase(false, true, false)).toBe(true);
        expect(shouldRequestViewerAccurateBase(false, true, true)).toBe(false);
        expect(shouldRequestViewerAccurateBase(true, false, false)).toBe(true);
    });

    it('dựng underlay PPE cứu hộ 24 DPI cho trang vượt ngân sách surface', () => {
        expect(VIEWER_ACCURATE_UNDERLAY_SCALE).toBe(0.25);
        expect(shouldRenderViewerAccurateUnderlay(true, true, true, true)).toBe(true);
        expect(shouldRenderViewerAccurateUnderlay(true, true, false, true)).toBe(false);
        expect(shouldRenderViewerAccurateUnderlay(true, false, true, true)).toBe(false);
        expect(shouldRenderViewerAccurateUnderlay(false, true, true, true)).toBe(false);
        expect(shouldRenderViewerAccurateUnderlay(true, true, true, false)).toBe(false);

        // Standee 800×1600 mm: base 96 DPI vượt ngân sách nhưng frame 24 DPI chỉ ~1,1 MP.
        expect(selectViewerAccurateBaseZoom(1, 3024 * 0.1, 6048 * 0.1, 0.1)).toBe(0.25);
        // Trang thông thường/zoom cao vẫn giữ base nét hơn nếu surface đó còn an toàn.
        expect(selectViewerAccurateBaseZoom(1.5, 3176, 4492, 4)).toBe(1.5);
    });

    it('trang liền kề prefetch đúng mật độ màn hình và đứng sau target active', () => {
        const screenScale = 0.75;
        expect(viewerAccurateBaseScaleForRole(1.5, screenScale, true, true, true)).toBe(1.5);
        expect(viewerAccurateBaseScaleForRole(1.5, screenScale, true, false, false)).toBe(screenScale);
        expect(viewerAccurateBaseScaleForRole(1.5, screenScale, false, true, true)).toBe(screenScale);
        expect(viewerAccurateBaseScaleForRole(1.5, screenScale, false, false, false)).toBe(1.5);

        expect(viewerPageRenderPriority(true, true, false)).toBe(10);
        expect(viewerPageRenderPriority(true, false, true)).toBe(20);
        expect(viewerPageRenderPriority(true, false, false)).toBe(100);
        expect(viewerPageRenderPriority(false, true, true)).toBe(1000);
    });

    it('chỉ hiện atlas trong một lần swap sau khi đã phủ kín viewport', () => {
        expect(shouldPresentViewerPanGrid(true, false, false, true)).toBe(false);
        expect(shouldPresentViewerPanGrid(true, true, false, true)).toBe(true);
        expect(shouldPresentViewerPanGrid(true, true, true, true)).toBe(false);
        expect(shouldPresentViewerPanGrid(true, true, true, false)).toBe(true);
        expect(shouldPresentViewerPanGrid(false, true, false, true)).toBe(false);
    });

    it('cho phép dựng trước nền accurate của trang liền kề khi cổng prefetch đã mở', () => {
        expect(shouldRenderViewerBasePage(true, true, false)).toBe(true);
        expect(shouldRenderViewerBasePage(true, false, true)).toBe(true);
        expect(shouldRenderViewerBasePage(true, false, false)).toBe(false);
        expect(shouldRenderViewerBasePage(false, true, true)).toBe(false);
    });

    it('tách scope prefetch accurate theo từng trang để không tự hủy lẫn nhau', () => {
        expect(viewerBackgroundRenderOwnerId('tab-a', 'page-2', true, false))
            .toBe('tab-a:accurate-base:page-2');
        expect(viewerBackgroundRenderOwnerId('tab-a', 'page-3', true, false))
            .not.toBe(viewerBackgroundRenderOwnerId('tab-a', 'page-2', true, false));
        expect(viewerBackgroundRenderOwnerId('tab-a', 'page-2', true, true))
            .toBe('tab-a:accurate-base:page-2');
        expect(viewerBackgroundRenderOwnerId('tab-a', 'page-2', false, false)).toBe('tab-a');
    });

    it('rời viewport cũ khi zoom-out qua ngưỡng để nền nhanh phủ đồng đều', () => {
        expect(shouldMountViewerViewportLayer(false, true, true)).toBe(false);
        expect(shouldMountViewerViewportLayer(true, false, true)).toBe(true);
    });

    it('không giữ viewport thừa cho trang thường hoặc frame nền', () => {
        expect(shouldMountViewerViewportLayer(false, false, true)).toBe(false);
        expect(shouldMountViewerViewportLayer(false, true, false)).toBe(false);
    });
});
