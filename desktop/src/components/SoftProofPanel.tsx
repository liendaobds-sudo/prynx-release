import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

interface IccProfile {
    id: string;
    name: string;
    description: string;
    available: boolean;
}

export default function SoftProofPanel({ fileId: fileIdProp }: { fileId?: string }) {
    const {
        viewerActivePage: activePage, viewerNumPages: numPages,
        softProofActive, setSoftProofActive,
        setSoftProofImageUrl, setGamutWarningUrl,
        selectionFileId,
    } = useWorkspaceStore();

    // Use prop first, then fallback to selectionFileId from store
    const fileId = fileIdProp || selectionFileId || '';

    const [profiles, setProfiles] = useState<IccProfile[]>([]);
    const [selectedProfile, setSelectedProfile] = useState('fogra39');
    const [intent, setIntent] = useState('relative');
    const [showGamut, setShowGamut] = useState(false);
    const [loading, setLoading] = useState(false);
    const [outOfGamutPct, setOutOfGamutPct] = useState(0);
    const [profileName, setProfileName] = useState('');
    const [warning, setWarning] = useState('');

    // Fetch available ICC profiles
    useEffect(() => {
        fetch(`${getApiUrl()}/preflight/icc-profiles`)
            .then(res => res.json())
            .then(data => setProfiles(data.profiles || []))
            .catch(() => {});
    }, []);

    const doSoftProof = useCallback(async () => {
        if (!fileId) {
            setWarning('Chưa có file. Hãy mở một file PDF trước.');
            return;
        }
        setLoading(true);
        setWarning('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/softproof`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    page: activePage,
                    profile_id: selectedProfile,
                    intent,
                    show_gamut_warning: showGamut,
                    dpi: 150,
                }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                setWarning(`Lỗi server: ${errData.detail || res.statusText}`);
                setLoading(false);
                return;
            }
            const data = await res.json();
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
            if (data.warning) setWarning(data.warning);
        } catch (err: any) {
            setWarning(err.message || 'Lỗi khi tạo Soft-Proof');
        } finally {
            setLoading(false);
        }
    }, [fileId, activePage, selectedProfile, intent, showGamut, setSoftProofImageUrl, setGamutWarningUrl, setSoftProofActive]);

    const clearSoftProof = useCallback(() => {
        setSoftProofActive(false);
        setSoftProofImageUrl(null);
        setGamutWarningUrl(null);
        setOutOfGamutPct(0);
        setWarning('');
    }, [setSoftProofActive, setSoftProofImageUrl, setGamutWarningUrl]);

    const INTENTS: Record<string, string> = {
        perceptual: 'Perceptual',
        relative: 'Relative Colorimetric',
        saturation: 'Saturation',
        absolute: 'Absolute Colorimetric',
    };

    return (
        <div className="flex flex-col gap-3" style={{ padding: '12px 0' }}>
            {/* Profile Selection */}
            <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block mb-1">ICC Profile đầu ra</label>
                <select
                    value={selectedProfile}
                    onChange={(e) => setSelectedProfile(e.target.value)}
                    className="w-full h-8 text-[12px] rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 px-2 focus:ring-1 focus:ring-indigo-400 focus:outline-none"
                >
                    {profiles.map(p => (
                        <option key={p.id} value={p.id} disabled={!p.available}>
                            {p.name} {!p.available ? '(chưa cài)' : ''}
                        </option>
                    ))}
                    {profiles.length === 0 && (
                        <option value="fogra39">FOGRA39 (đang tải...)</option>
                    )}
                </select>
                {profiles.find(p => p.id === selectedProfile) && (
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                        {profiles.find(p => p.id === selectedProfile)?.description}
                    </span>
                )}
            </div>

            {/* Rendering Intent */}
            <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Rendering Intent</label>
                <select
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    className="w-full h-8 text-[12px] rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 px-2 focus:ring-1 focus:ring-indigo-400 focus:outline-none"
                >
                    {Object.entries(INTENTS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
            </div>

            {/* Gamut Warning Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={showGamut}
                    onChange={(e) => setShowGamut(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                />
                <span className="text-[12px] text-slate-600 dark:text-zinc-300">Hiện cảnh báo Gamut</span>
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
                        <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang xử lý...</>
                    ) : (
                        <>🔍 Soft-Proof</>
                    )}
                </button>
                {softProofActive && (
                    <button
                        onClick={clearSoftProof}
                        className="px-3 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 rounded-lg text-[12px] font-bold transition-colors"
                    >
                        Tắt
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
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">Trang:</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">{activePage} / {numPages}</span>
                    </div>
                    {showGamut && (
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] text-slate-500">Ngoài gamut:</span>
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
                Soft-Proof mô phỏng cách file sẽ trông khi in. Gamut Warning highlight vùng có màu ngoài phạm vi in (xanh neon).
            </div>
        </div>
    );
}
