import React, { useEffect, useRef, useState } from 'react';
import { previewVdpRecord, type VdpPreviewResult } from '@/lib/api';

type PreviewKind = 'csv' | 'xlsx' | 'gsheet';

export interface VdpProofPreviewProps {
    fields: readonly unknown[];
    requestedIndex: number;
    templateFile: File | null;
    getWorkingFile?: () => Promise<File>;
    rows?: Record<string, string>[];
    kind?: PreviewKind;
    sourceFile?: File;
    url?: string;
    text?: string;
    sheet?: string;
    hasHeader?: boolean;
    disabled?: boolean;
}

/**
 * VDP (audit 2026-10-01 §VDP.03): preview raster từ đúng API production,
 * để người dùng đối chiếu output engine thay vì chỉ tin overlay WebView.
 */
export default function VdpProofPreview({
    fields, requestedIndex, templateFile, getWorkingFile, rows, kind, sourceFile,
    url, text, sheet, hasHeader = true, disabled = false,
}: VdpProofPreviewProps) {
    const [result, setResult] = useState<VdpPreviewResult | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const handlePreview = async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError('');
        try {
            let template = templateFile;
            if (getWorkingFile) template = await getWorkingFile();
            if (!template) throw new Error('Chưa có file PDF mẫu để xem preview production.');
            const templatePath = (template as File & { path?: string }).path;
            const preview = await previewVdpRecord({
                fields,
                requestedIndex,
                ...(templatePath ? { templatePath } : { template }),
                ...(rows ? { rows } : {}),
                kind,
                file: sourceFile,
                url,
                text,
                sheet,
                hasHeader,
                signal: controller.signal,
            });
            if (!controller.signal.aborted) {
                setResult(preview);
                setOpen(true);
            }
        } catch (err) {
            if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={disabled || busy || fields.length === 0}
                className="h-9 flex-1 px-3 text-[12px] font-semibold text-blue-700 dark:text-blue-200 border border-blue-300 dark:border-blue-700 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
                {busy ? 'Đang render preview PDF...' : 'Xem preview production'}
            </button>
            {error && <div className="text-[11px] text-red-600 dark:text-red-300">{error}</div>}
            {open && result && (
                <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
                    <div className="max-w-3xl max-h-[90vh] w-full overflow-auto rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-2xl">
                        <div className="flex items-center justify-between gap-3 mb-3">
                            <h3 className="font-bold text-sm">Preview production — record {result.record_index}</h3>
                            <button type="button" onClick={() => setOpen(false)} className="px-2 py-1 text-xs rounded border">Đóng</button>
                        </div>
                        {result.image_png_base64 ? (
                            <img src={`data:image/png;base64,${result.image_png_base64}`} alt="VDP production preview" className="max-h-[70vh] max-w-full mx-auto border" />
                        ) : (
                            <p className="text-sm text-slate-500">Nguồn dữ liệu rỗng.</p>
                        )}
                        {result.field_errors.length > 0 && (
                            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                                {result.field_errors.map((item, index) => <div key={`${item.field}-${index}`}>{item.kind}: {item.field} — {item.reason}</div>)}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
