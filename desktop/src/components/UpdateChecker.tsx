import { useEffect, useState } from 'react';

/**
 * Tự động kiểm tra bản cập nhật (Tauri updater) khi khởi động.
 * Updater tải manifest latest.json từ endpoint trong tauri.conf.json, verify chữ ký
 * minisign bằng pubkey nhúng. Nếu có bản mới → hiện thẻ nhỏ cho người dùng cài.
 * Hoàn toàn không chặn UI; chỉ chạy trong môi trường Tauri.
 */
export default function UpdateChecker() {
    const [update, setUpdate] = useState<any>(null);
    const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
    const [percent, setPercent] = useState(0);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (!(window as any).__TAURI_INTERNALS__) return; // chỉ trong app desktop
                const { check } = await import('@tauri-apps/plugin-updater');
                const found = await check();
                if (!cancelled && found) setUpdate(found);
            } catch (e) {
                console.debug('[Updater] check failed:', e);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (!update || dismissed) return null;

    const doInstall = async () => {
        try {
            setStatus('downloading');
            let total = 0;
            let got = 0;
            await update.downloadAndInstall((ev: any) => {
                if (ev.event === 'Started') {
                    total = ev.data?.contentLength || 0;
                } else if (ev.event === 'Progress') {
                    got += ev.data?.chunkLength || 0;
                    if (total > 0) setPercent(Math.min(100, Math.round((got / total) * 100)));
                } else if (ev.event === 'Finished') {
                    setPercent(100);
                }
            });
            setStatus('done');
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch (e) {
            console.error('[Updater] install failed:', e);
            setStatus('error');
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-[10000] w-80 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-slate-800 dark:text-zinc-100">
                    Có bản cập nhật mới {update.version ? `(${update.version})` : ''}
                </div>
                {status === 'idle' && (
                    <button onClick={() => setDismissed(true)} className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 leading-none text-lg" title="Để sau">×</button>
                )}
            </div>

            {update.body && status === 'idle' && (
                <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400 max-h-20 overflow-auto whitespace-pre-line">{update.body}</p>
            )}

            {status === 'idle' && (
                <div className="mt-3 flex gap-2">
                    <button onClick={doInstall} className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-semibold transition-colors">
                        Cập nhật & khởi động lại
                    </button>
                    <button onClick={() => setDismissed(true)} className="px-3 py-1.5 rounded border border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800">
                        Để sau
                    </button>
                </div>
            )}

            {status === 'downloading' && (
                <div className="mt-3">
                    <div className="text-xs text-slate-500 dark:text-zinc-400 mb-1">Đang tải bản cập nhật... {percent}%</div>
                    <div className="h-2 w-full bg-slate-200 dark:bg-zinc-700 rounded overflow-hidden">
                        <div className="h-full bg-indigo-600 transition-all" style={{ width: `${percent}%` }} />
                    </div>
                </div>
            )}

            {status === 'done' && (
                <div className="mt-3 text-xs text-emerald-600">Đã tải xong, đang khởi động lại...</div>
            )}

            {status === 'error' && (
                <div className="mt-3">
                    <div className="text-xs text-red-600 mb-2">Cập nhật thất bại. Thử lại sau hoặc tải bản mới thủ công.</div>
                    <button onClick={() => setDismissed(true)} className="text-xs text-slate-500 hover:underline">Đóng</button>
                </div>
            )}
        </div>
    );
}
