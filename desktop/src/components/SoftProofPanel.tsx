import React, { useState, useCallback, useEffect, useRef } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import type {
    OutputPreviewRenderingIntent,
    OutputPreviewRgb,
    OutputPreviewShowFilter,
} from '../stores/useWorkspaceStore';
import { useTranslation } from 'react-i18next';

// TYPE (audit 2026-08-23 §P2.68): response lỗi là boundary không tin cậy.
function getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (message) return String(message);
    }
    return fallback;
}

interface SoftProofPanelProps {
    fileId?: string;
    pageNum?: number;
    profileId: string;
    intent: OutputPreviewRenderingIntent;
    simulateOverprint: boolean;
    outputPreviewFilter?: OutputPreviewShowFilter;
    simulatePaperColor?: boolean;
    simulateBlackInk?: boolean;
    pageBackgroundRgb?: OutputPreviewRgb | null;
    forceGamutWarning?: boolean;
    autoRender?: boolean;
}

export default function SoftProofPanel({
    fileId: fileIdProp,
    pageNum,
    profileId,
    intent,
    simulateOverprint,
    outputPreviewFilter = 'all',
    simulatePaperColor = false,
    simulateBlackInk = false,
    pageBackgroundRgb = null,
    forceGamutWarning = false,
    autoRender = false,
}: SoftProofPanelProps) {
  const { t } = useTranslation();
    const {
        viewerActivePage: activePage, viewerNumPages: numPages,
        softProofActive, setSoftProofActive,
        setSoftProofImageUrl, setGamutWarningUrl,
        selectionFileId,
    } = useWorkspaceStore();

    // Use prop first, then fallback to selectionFileId from store
    const fileId = fileIdProp || selectionFileId || '';

    const [manualShowGamut, setManualShowGamut] = useState(false);
    const [loading, setLoading] = useState(false);
    const [outOfGamutPct, setOutOfGamutPct] = useState(0);
    const [profileName, setProfileName] = useState('');
    const [warning, setWarning] = useState('');
    const [engineInfo, setEngineInfo] = useState('');
    const requestGenerationRef = useRef(0);
    const requestAbortRef = useRef<AbortController | null>(null);
    const showGamut = forceGamutWarning || manualShowGamut;
    const targetPage = pageNum ?? activePage;

    const doSoftProof = useCallback(async () => {
        if (!fileId) {
            setWarning(t('misc.softProof:chua_co_file_hay_mo_mot_file_pdf_truoc'));
            return;
        }
        const generation = ++requestGenerationRef.current;
        requestAbortRef.current?.abort();
        const controller = new AbortController();
        requestAbortRef.current = controller;
        setLoading(true);
        setWarning('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/softproof`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    file_id: fileId,
                    page: targetPage,
                    profile_id: profileId,
                    intent,
                    simulate_overprint: simulateOverprint,
                    show_gamut_warning: showGamut,
                    output_preview_filter: outputPreviewFilter,
                    simulate_paper_color: simulatePaperColor,
                    simulate_black_ink: simulateBlackInk,
                    page_background_rgb: pageBackgroundRgb,
                    dpi: 150,
                }),
            });
            if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
                setWarning(`Lỗi server: ${errData.detail || res.statusText}`);
                return;
            }
            const data = await res.json();
            if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
            if (data.softproof_b64) {
                setSoftProofImageUrl(`data:image/jpeg;base64,${data.softproof_b64}`);
                setSoftProofActive(true);
            }
            if (data.gamut_b64) {
                setGamutWarningUrl(`data:image/png;base64,${data.gamut_b64}`);
            } else {
                setGamutWarningUrl(null);
            }
            setOutOfGamutPct(data.out_of_gamut_pct || 0);
            setProfileName(data.profile_name || '');
            const eng = [data.engine, data.accuracy].filter(Boolean).join(' · ');
            setEngineInfo(eng);
            if (data.warning) setWarning(data.warning);
            else if (data.accuracy === 'rip_softproof') setWarning('');
        } catch (error: unknown) {
            if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
            setWarning(getErrorMessage(error, t('misc.softProof:loi_khi_tao_soft_proof')));
        } finally {
            if (generation === requestGenerationRef.current) {
                requestAbortRef.current = null;
                setLoading(false);
            }
        }
    }, [fileId, intent, outputPreviewFilter, pageBackgroundRgb, profileId, setGamutWarningUrl, setSoftProofActive, setSoftProofImageUrl, showGamut, simulateBlackInk, simulateOverprint, simulatePaperColor, t, targetPage]);

    const clearSoftProof = useCallback(() => {
        requestGenerationRef.current += 1;
        requestAbortRef.current?.abort();
        requestAbortRef.current = null;
        setLoading(false);
        setSoftProofActive(false);
        setSoftProofImageUrl(null);
        setGamutWarningUrl(null);
        setOutOfGamutPct(0);
        setWarning('');
        setEngineInfo('');
    }, [setSoftProofActive, setSoftProofImageUrl, setGamutWarningUrl]);

    // PREFLIGHT (audit 2026-08-10 §OP.8): Color Warnings là Preview mode thật,
    // nên đổi Show/Simulation phải tự dựng thế hệ mới; response cũ bị abort/latest-only.
    useEffect(() => {
        if (!autoRender) return;
        void doSoftProof();
        return () => {
            requestGenerationRef.current += 1;
            requestAbortRef.current?.abort();
            requestAbortRef.current = null;
        };
    }, [autoRender, doSoftProof]);

    useEffect(() => () => {
        requestGenerationRef.current += 1;
        requestAbortRef.current?.abort();
    }, []);

    return (
        <div className="flex flex-col gap-3" style={{ padding: '12px 0' }}>
            {/* Gamut Warning Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={showGamut}
                    disabled={forceGamutWarning}
                    onChange={(e) => setManualShowGamut(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                />
                <span className="text-[12px] text-slate-600 dark:text-zinc-300">{t('misc.softProof:hien_canh_bao_gamut')}</span>
                <div className="w-3 h-3 rounded-sm bg-[#00FF00] ring-1 ring-black/10 ml-auto"></div>
            </label>

            {/* Action Buttons */}
            <div className="flex gap-2">
                <button
                    onClick={doSoftProof}
                    disabled={loading || !fileId}
                    className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('misc.softProof:dang_xu_ly')}</>
                    ) : (
                        <>🔍 Soft-Proof</>
                    )}
                </button>
                {softProofActive && (
                    <button
                        onClick={clearSoftProof}
                        className="px-3 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 rounded-lg text-[12px] font-bold transition-colors"
                    >
                        {t('misc.softProof:tat')}
                    </button>
                )}
            </div>

            {/* Results */}
            {softProofActive && (
                <div className="bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-100 dark:border-zinc-800" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">Profile:</span>
                        <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">{profileName}</span>
                    </div>
                    {engineInfo && (
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-slate-500">Engine:</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                engineInfo.includes('rip_softproof')
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                            }`}>{engineInfo}</span>
                        </div>
                    )}
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">Trang:</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">{targetPage} / {numPages}</span>
                    </div>
                    {showGamut && (
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] text-slate-500">{t('misc.softProof:ngoai_gamut')}</span>
                            <span className={`text-[11px] font-bold ${outOfGamutPct > 5 ? 'text-red-500' : outOfGamutPct > 1 ? 'text-amber-500' : 'text-emerald-500'}`}>
                                {outOfGamutPct}%
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Warning */}
            {warning && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2 border border-amber-200 dark:border-amber-800">
                    ⚠️ {warning}
                </div>
            )}

            {/* Help */}
            <div className="text-[10px] text-slate-400 leading-tight mt-1">
                {t('misc.softProof:soft_proof_mo_phong_cach_file_se_trong')}
            </div>
        </div>
    );
}
