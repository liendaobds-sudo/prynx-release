import type { RecipeRunner } from './PlaybackRunner';
import type { StickerSheetTabState } from '../../components/preprocess-tools/stickerSheetStore';
import { sanitizeStickerOutputSettings } from '../../components/preprocess-tools/stickerOutputSettings';
import { resolveStickerDetectionStrategy } from '../../components/preprocess-tools/stickerDetectionSettings';
import {
    inspectStickerSourceManifest, detectStickerSourceManifest, previewStickerCutline,
    confirmStickerSource, exportStickerSheet, closeStickerSheetSession,
    type StickerSheetPageExport, type StickerDetectionStrategy,
} from '../stickerSheetApi';
import { tv } from '../../i18n';

const tuningOf = (page: Pick<StickerSheetTabState, 'cutlineSmoothness' | 'cutlineFidelity' | 'curveTension' | 'cutlineDenoise' | 'minDetailAreaMm2'>) => ({
    cutlineSmoothness: page.cutlineSmoothness, cutlineFidelity: page.cutlineFidelity,
    curveTension: page.curveTension, cutlineDenoise: page.cutlineDenoise, minDetailAreaMm2: page.minDetailAreaMm2,
});

/** UNIFIED (2026-09-06): recipe lưu quy tắc, không lưu ID/mask của một file khách. */
export function makeUnifiedStickerRecipe(tab: StickerSheetTabState, pageOrder?: number[]): Record<string, unknown> | null {
    const count = tab.inspection?.page_count ?? tab.manifest?.page_count ?? 1;
    const order = pageOrder?.length ? pageOrder : Array.from({ length: count }, (_, i) => i + 1);
    if (order.length !== count || order.some((n, i) => n !== i + 1)) return null;
    const pages = order.map(n => tab.pages[n] || (n === tab.activeSourcePage ? tab : null));
    if (pages.some(page => !page?.manifest || page.edits.length || page.whiteBackgroundStale
        || page.manifest.vector_geometry_ref?.kind === 'pdf-object-selection')) return null;
    const first = pages[0]!;
    const tuning = tuningOf(first);
    const preferred = tab.detectionStrategy || (first.manifest!.boundary_source === 'page-box' ? 'page-box' : 'auto');
    const removeWhiteBg = tab.removeWhiteBg ?? preferred !== 'page-box';
    const strategy = resolveStickerDetectionStrategy(tab.outputSettings.cutMode, removeWhiteBg, preferred);
    if (pages.some(page => JSON.stringify(tuningOf(page!)) !== JSON.stringify(tuning)
        || (page!.manifest!.boundary_source === 'page-box') !== (strategy === 'page-box')
        || page!.preserveExistingCut !== first.preserveExistingCut)) return null;
    return {
        workflow: 'unified-v2', productType: 'sticker', ...tab.outputSettings,
        ...tuning, strategy, removeWhiteBg, preserveExistingCut: first.preserveExistingCut,
        bleedColorHex: tab.outputSettings.solidBleedCmyk.join(','),
    };
}

/** Dò lại nguồn mới, dùng đúng API/preview/export của workspace; recipe cũ giữ runner cũ. */
export const runUnifiedStickerRecipe: RecipeRunner = async (ctx, params) => {
    const controller = new AbortController();
    let sessionId: string | null = null;
    const canceled = () => { if (controller.signal.aborted) throw new DOMException('Hủy', 'AbortError'); };
    const percent = (key: string, fallback: number, max = 100) => {
        const value = params[key];
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
    };
    const tuning = { cutlineSmoothness: percent('cutlineSmoothness', 50), cutlineFidelity: percent('cutlineFidelity', 50),
        curveTension: percent('curveTension', 50), cutlineDenoise: percent('cutlineDenoise', 50), minDetailAreaMm2: percent('minDetailAreaMm2', 1, 25) };
    const settings = sanitizeStickerOutputSettings(params);
    const preferred: StickerDetectionStrategy = ['page-box', 'alpha', 'simple-bg', 'ai'].includes(String(params.strategy))
        ? params.strategy as StickerDetectionStrategy : 'auto';
    const removeWhiteBg = typeof params.removeWhiteBg === 'boolean' ? params.removeWhiteBg : preferred !== 'page-box';
    const strategy = resolveStickerDetectionStrategy(settings.cutMode, removeWhiteBg, preferred);
    ctx.setError(''); ctx.setIsProcessing(true); ctx.setProcessStatus(tv('Đang nhận diện tem và tạo đường cắt'));
    ctx.setCancelHandler?.(async () => { controller.abort(); });
    try {
        const bytes = await ctx.getWorkingBytes(); canceled();
        const source = new File([bytes as BlobPart], ctx.file.name, { type: 'application/pdf' });
        const inspection = await inspectStickerSourceManifest(source, controller.signal);
        sessionId = inspection.session_id;
        canceled();
        const pages: StickerSheetPageExport[] = [];
        const warnings: string[] = [];
        let allPreserve = params.preserveExistingCut === true;
        for (let pageNumber = 1; pageNumber <= inspection.page_count; pageNumber++) {
            canceled();
            const detected = await detectStickerSourceManifest(sessionId, { strategy, pageNumber, signal: controller.signal });
            if (detected.strategy_confidence < 0.5 || detected.warnings.includes('simple-bg-ai-artwork-loss-rejected')) {
                throw new Error(tv('Nguồn cần kiểm tra thủ công trước khi tiếp tục quy trình.'));
            }
            allPreserve &&= detected.boundary_source === 'existing-cut' && detected.vector_geometry_ref?.preserve_original === true;
            warnings.push(...detected.warnings);
            const dpi = detected.dpi?.[0] ?? 72;
            const dpiY = detected.dpi?.[1] ?? dpi;
            const preview = settings.cutMode !== 'none'
                ? await previewStickerCutline(sessionId, { baseRevision: detected.mask_revision ?? 1,
                    pageNumber, edits: [], dpi, dpiY, ...settings, ...tuning, signal: controller.signal }) : null;
            if (!await confirmStickerSource(sessionId, { pageNumber, signal: controller.signal })) {
                throw new Error(tv('Không xác nhận được vùng tem.'));
            }
            pages.push({ sourcePage: pageNumber, expectedRevision: detected.mask_revision ?? 1,
                edits: [], dpi, dpiY, ...tuning, expectedFingerprint: preview?.fingerprint });
        }
        canceled();
        const result = await exportStickerSheet(sessionId, { edits: [], pages: pages.map(page => ({ ...page,
            expectedFingerprint: allPreserve ? undefined : page.expectedFingerprint })),
            pageOrder: pages.map(page => page.sourcePage), dpi: pages[0]?.dpi ?? 72, dpiY: pages[0]?.dpiY ?? 72,
            ...settings, ...tuning, offsetMm: allPreserve ? 0 : settings.offsetMm,
            bleedMm: allPreserve ? 0 : settings.bleedMm, cutMode: allPreserve ? 'original' : settings.cutMode,
            cornerStyle: allPreserve ? 'preserve' : settings.cornerStyle,
            cropToSticker: allPreserve ? false : settings.cropToSticker,
            preserveExistingCut: allPreserve, outputFormat: 'pdf', signal: controller.signal });
        canceled();
        // Output nằm dưới session tạm. Commit bytes sang working-file owner;
        // không trao path sẽ bị closeSession xóa ngay sau đó.
        await ctx.commitWorkingFile(result.blob, result.filename);
        return { status: 'completed', warnings: [...new Set(warnings)] };
    } catch (error) {
        if (controller.signal.aborted) return { status: 'canceled' };
        const message = error instanceof Error ? error.message : String(error);
        ctx.setError(message);
        return { status: 'error', error: message };
    } finally {
        if (sessionId) await closeStickerSheetSession(sessionId);
        ctx.setCancelHandler?.(null); ctx.setIsProcessing(false); ctx.setProcessStatus('');
    }
};
