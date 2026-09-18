import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from './Button';
import { toast } from './ui/Toast';
import { RefreshCw, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';

interface BridgeSyncStatus {
    illustratorFound: boolean;
    illustratorSynced: boolean;
    illustratorPath?: string | null;
    corelFound: boolean;
    corelSynced: boolean;
    corelPath?: string | null;
    details: string[];
}

export default function DesignBridgeSettings() {
    const [status, setStatus] = useState<BridgeSyncStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [exportMode, setExportMode] = useState<'adaptive' | 'strict'>('adaptive');

    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const res = await invoke<BridgeSyncStatus>('get_design_bridge_status');
            setStatus(res);
        } catch (err) {
            console.error('Không thể đọc trạng thái cầu nối:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadStatus();
    }, [loadStatus]);

    const handleSync = async () => {
        setSyncing(true);
        try {
            const res = await invoke<BridgeSyncStatus>('sync_design_bridges');
            setStatus(res);
            toast.success('Đã đồng bộ cầu nối Illustrator & CorelDRAW thành công!');
        } catch (err) {
            toast.error(`Lỗi đồng bộ cầu nối: ${String(err)}`);
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="animate-fade-in flex flex-col h-full space-y-6">
            <div>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                    🌉 Cầu nối Thiết kế (Illustrator & CorelDRAW)
                </h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 leading-relaxed">
                    Tự động kết nối 2 chiều giữa PrynX và phần mềm đồ họa. Xuất file chuyển sang PrynX chỉ với 1 cú click chuột, bảo toàn 100% đường bế Spot Color và tràn lề Bleed.
                </p>
            </div>

            {/* Trạng thái kết nối các ứng dụng */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Adobe Illustrator */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-zinc-800/40 flex flex-col justify-between">
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                                <span className="text-orange-500 font-extrabold text-base">Ai</span> Adobe Illustrator
                            </span>
                            {status?.illustratorSynced ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 rounded-full">
                                    <CheckCircle2 className="w-3.5 h-3.5" /> Đã kết nối
                                </span>
                            ) : status?.illustratorFound ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 rounded-full">
                                    <AlertCircle className="w-3.5 h-3.5" /> Chưa đồng bộ
                                </span>
                            ) : (
                                <span className="text-xs text-slate-400 dark:text-zinc-500">Chưa phát hiện</span>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-zinc-400 line-clamp-2">
                            {status?.illustratorPath || 'Không tìm thấy cài đặt Illustrator trên máy.'}
                        </p>
                        {status?.illustratorSynced && (
                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-2">
                                ✓ Đã cài sẵn script vào menu: <b>File &gt; Scripts &gt; PrynX Bridge</b>
                            </p>
                        )}
                    </div>
                </div>

                {/* CorelDRAW */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-zinc-800/40 flex flex-col justify-between">
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                                <span className="text-emerald-500 font-extrabold text-base">CDR</span> CorelDRAW
                            </span>
                            {status?.corelSynced ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 rounded-full">
                                    <CheckCircle2 className="w-3.5 h-3.5" /> Đã kết nối
                                </span>
                            ) : status?.corelFound ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 rounded-full">
                                    <AlertCircle className="w-3.5 h-3.5" /> Chưa đồng bộ
                                </span>
                            ) : (
                                <span className="text-xs text-slate-400 dark:text-zinc-500">Chưa phát hiện</span>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-zinc-400 line-clamp-2">
                            {status?.corelPath || 'Không tìm thấy cài đặt CorelDRAW trên máy.'}
                        </p>
                        {status?.corelSynced && (
                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-2">
                                ✓ Đã tạo macro GMS sẵn sàng kéo ra thanh công cụ.
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Thiết lập chế độ xuất PDF */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 space-y-3">
                <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-500" /> Chế độ xuất PDF từ Illustrator
                </div>
                <div className="space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors">
                        <input
                            type="radio"
                            name="exportMode"
                            checked={exportMode === 'adaptive'}
                            onChange={() => setExportMode('adaptive')}
                            className="mt-1 text-indigo-600"
                        />
                        <div>
                            <div className="text-sm font-medium text-slate-800 dark:text-zinc-200">
                                Kế thừa thiết lập lần xuất gần nhất + Chốt an toàn (Khuyên dùng)
                            </div>
                            <div className="text-xs text-slate-500 dark:text-zinc-400">
                                Giữ nguyên thói quen xuất file của bạn, đồng thời tự động bảo vệ đường bế Spot Color và bật tràn lề Bleed.
                            </div>
                        </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors">
                        <input
                            type="radio"
                            name="exportMode"
                            checked={exportMode === 'strict'}
                            onChange={() => setExportMode('strict')}
                            className="mt-1 text-indigo-600"
                        />
                        <div>
                            <div className="text-sm font-medium text-slate-800 dark:text-zinc-200">
                                Ép chuẩn in ấn PrynX Print Standard (PDF/X-4)
                            </div>
                            <div className="text-xs text-slate-500 dark:text-zinc-400">
                                Xuất chất lượng cao nhất, không suy hao ảnh, giữ nguyên vector và độ trong suốt chuẩn nhà in.
                            </div>
                        </div>
                    </label>
                </div>
            </div>

            {/* Nút hành động */}
            <div className="flex items-center justify-between pt-2">
                <div className="text-xs text-slate-400 dark:text-zinc-500">
                    {loading ? 'Đang kiểm tra kết nối...' : 'Cầu nối tự động kích hoạt mỗi khi PrynX khởi động.'}
                </div>
                <Button
                    onClick={handleSync}
                    disabled={syncing}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2 rounded-lg"
                >
                    <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Đang đồng bộ...' : 'Đồng bộ lại Cầu nối ngay'}
                </Button>
            </div>
        </div>
    );
}
