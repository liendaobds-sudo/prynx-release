import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { ToolSectionLabel, ToolInfo } from './ToolUI';
import { useTranslation } from 'react-i18next';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void | boolean | Promise<void | boolean>;
}

const FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'] as const;
type FieldKey = (typeof FIELDS)[number];

const EMPTY: Record<FieldKey, string> = {
    Title: '',
    Author: '',
    Subject: '',
    Keywords: '',
    Creator: '',
    Producer: '',
};

export default function MetadataTool({ pdfFile, onFileFixed }: Props) {
    const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();

    const [fields, setFields] = useState<Record<FieldKey, string>>({ ...EMPTY });
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const expectedOutputNameRef = useRef<string | null>(null);

    const loadMetadata = async (preserveSuccess = false) => {
        if (!pdfFile) {
            setFields({ ...EMPTY });
            return;
        }
        setIsLoading(true);
        setError('');
        if (!preserveSuccess) setSuccess('');
        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            if (password) formData.append('password', password);

            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/metadata/read`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                throw new Error(errData?.detail || t('preprocess.metadata:loi_server', { status: res.status }));
            }
            const data = await res.json();
            const meta = data?.metadata || {};
            setFields({
                Title: meta.Title || '',
                Author: meta.Author || '',
                Subject: meta.Subject || '',
                Keywords: meta.Keywords || '',
                Creator: meta.Creator || '',
                Producer: meta.Producer || '',
            });
        } catch (caughtError: unknown) {
            const message = caughtError instanceof Error ? caughtError.message : '';
            setError(message || t('preprocess.metadata:loi_khong_xac_dinh'));
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        // UIUX (audit 2026-07-28 §PF.1): đọc lại metadata nhưng giữ thông báo của file vừa lưu.
        const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
        expectedOutputNameRef.current = null;
        loadMetadata(preserveSuccess);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when file changes
    }, [pdfFile?.name, pdfFile?.size, pdfFile?.lastModified]);

    const setField = (key: FieldKey, value: string) => {
        setFields((prev) => ({ ...prev, [key]: value }));
    };

    const handleSave = async (clearAll = false) => {
        if (!pdfFile) {
            setError(t('preprocess.metadata:chua_mo_file'));
            return;
        }
        setIsProcessing(true);
        setError('');
        setSuccess('');
        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('title', clearAll ? '' : fields.Title);
            formData.append('author', clearAll ? '' : fields.Author);
            formData.append('subject', clearAll ? '' : fields.Subject);
            formData.append('keywords', clearAll ? '' : fields.Keywords);
            formData.append('creator', clearAll ? '' : fields.Creator);
            formData.append('producer', clearAll ? '' : fields.Producer);
            formData.append('clear_all', clearAll ? 'true' : 'false');
            if (password) formData.append('password', password);

            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/metadata/write`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                throw new Error(errData?.detail || t('preprocess.metadata:loi_server', { status: res.status }));
            }
            const blob = await res.blob();
            if (onFileFixed) {
                // RECIPE (audit 2026-08-17 §REC.4R): commit bị chặn → không báo thành công
                // và không đổi field/expected name để lần đọc lại không hiểu nhầm.
                const outputName = `metadata_${pdfFile.name}`;
                expectedOutputNameRef.current = outputName;
                const committed = await onFileFixed(blob, outputName);
                if (committed === false) {
                    expectedOutputNameRef.current = null;
                    return;
                }
            }
            setSuccess(clearAll ? t('preprocess.metadata:xoa_thanh_cong') : t('preprocess.metadata:luu_thanh_cong'));
            if (clearAll) setFields({ ...EMPTY });
        } catch (caughtError: unknown) {
            const message = caughtError instanceof Error ? caughtError.message : '';
            setError(message || t('preprocess.metadata:loi_khong_xac_dinh'));
        } finally {
            setIsProcessing(false);
        }
    };

    const fieldLabel = (key: FieldKey) => t(`preprocess.metadata:field_${key.toLowerCase()}`);

    return (
        <div className="flex flex-col gap-4">
            <ToolInfo desc={<>{t('preprocess.metadata:info')}</>} />

            <div>
                <ToolSectionLabel>{t('preprocess.metadata:password_if_locked')}</ToolSectionLabel>
                <div className="flex gap-2">
                    <input
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                        placeholder={t('preprocess.metadata:password_placeholder')}
                    />
                    <button
                        type="button"
                        onClick={() => loadMetadata()}
                        disabled={!pdfFile || isLoading}
                        className="px-3 py-2 rounded-lg text-[12px] font-bold bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 disabled:opacity-50"
                    >
                        {isLoading ? '…' : t('preprocess.metadata:tai_lai')}
                    </button>
                </div>
            </div>

            <div>
                <ToolSectionLabel>{t('preprocess.metadata:truong')}</ToolSectionLabel>
                <div className="flex flex-col gap-2">
                    {FIELDS.map((key) => (
                        <div key={key}>
                            <label className="text-[11px] text-slate-500 block mb-0.5">{fieldLabel(key)}</label>
                            <input
                                type="text"
                                value={fields[key]}
                                onChange={(e) => setField(key, e.target.value)}
                                disabled={isLoading || isProcessing}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px] disabled:opacity-50"
                            />
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <button
                    type="button"
                    onClick={() => handleSave(false)}
                    disabled={isProcessing || !pdfFile}
                    className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg ${
                        isProcessing || !pdfFile
                            ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                            : 'bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white shadow-violet-500/25'
                    }`}
                >
                    {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                </button>
                <button
                    type="button"
                    onClick={() => handleSave(true)}
                    disabled={isProcessing || !pdfFile}
                    className="w-full py-2.5 rounded-xl text-[12px] font-bold border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                    {t('preprocess.metadata:btn_xoa_het')}
                </button>
            </div>

            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
            {success && (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded-lg border border-emerald-200 dark:border-emerald-800/50">
                    <span className="text-[12px] text-emerald-700 dark:text-emerald-400 font-medium">✅ {success}</span>
                </div>
            )}
        </div>
    );
}
