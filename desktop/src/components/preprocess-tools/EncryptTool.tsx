import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { ToolSectionLabel, ToolCheckboxOption, ToolInfo } from './ToolUI';
import { useTranslation } from 'react-i18next';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void | boolean | Promise<void | boolean>;
}

type Mode = 'lock' | 'unlock';

export default function EncryptTool({ pdfFile, onFileFixed }: Props) {
    const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();

    const [mode, setMode] = useState<Mode>('lock');
    const [userPassword, setUserPassword] = useState('');
    const [ownerPassword, setOwnerPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [openPassword, setOpenPassword] = useState('');
    const [unlockPassword, setUnlockPassword] = useState('');

    const [allowPrint, setAllowPrint] = useState(true);
    const [allowCopy, setAllowCopy] = useState(true);
    const [allowModify, setAllowModify] = useState(false);
    const [allowAnnotate, setAllowAnnotate] = useState(true);

    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const handleLock = async () => {
        if (!pdfFile) {
            setError(t('preprocess.encrypt:chua_mo_file'));
            return;
        }
        if (!userPassword && !ownerPassword) {
            setError(t('preprocess.encrypt:can_mat_khau'));
            return;
        }
        if (userPassword && userPassword !== confirmPassword) {
            setError(t('preprocess.encrypt:mat_khau_khong_khop'));
            return;
        }

        setIsProcessing(true);
        setError('');
        setSuccess('');
        setProgress(t('preprocess.encrypt:dang_khoa'));

        try {
            // Không ghi recipe: không lưu mật khẩu vào chuỗi phát lại.
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('user_password', userPassword);
            formData.append('owner_password', ownerPassword || userPassword);
            formData.append('allow_print', allowPrint ? 'true' : 'false');
            formData.append('allow_copy', allowCopy ? 'true' : 'false');
            formData.append('allow_modify', allowModify ? 'true' : 'false');
            formData.append('allow_annotate', allowAnnotate ? 'true' : 'false');
            formData.append('allow_form', 'true');
            formData.append('allow_assembly', 'false');
            if (openPassword) formData.append('open_password', openPassword);

            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/encrypt`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                throw new Error(errData?.detail || t('preprocess.encrypt:loi_server', { status: response.status }));
            }

            const blob = await response.blob();
            setProgress('');
            if (onFileFixed) {
                // RECIPE (audit 2026-08-17 §REC.4R): commit bị chặn → không báo thành công.
                const committed = await onFileFixed(blob, `encrypted_${pdfFile.name}`);
                if (committed !== false) setSuccess(t('preprocess.encrypt:khoa_thanh_cong'));
            } else {
                setSuccess(t('preprocess.encrypt:khoa_thanh_cong'));
            }
        } catch (e: any) {
            setError(e.message || t('preprocess.encrypt:loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleUnlock = async () => {
        if (!pdfFile) {
            setError(t('preprocess.encrypt:chua_mo_file'));
            return;
        }
        if (!unlockPassword) {
            setError(t('preprocess.encrypt:can_mat_khau_mo'));
            return;
        }

        setIsProcessing(true);
        setError('');
        setSuccess('');
        setProgress(t('preprocess.encrypt:dang_mo_khoa'));

        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('password', unlockPassword);

            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/decrypt`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                throw new Error(errData?.detail || t('preprocess.encrypt:loi_server', { status: response.status }));
            }

            const blob = await response.blob();
            setProgress('');
            if (onFileFixed) {
                const committed = await onFileFixed(blob, `decrypted_${pdfFile.name}`);
                if (committed !== false) setSuccess(t('preprocess.encrypt:mo_khoa_thanh_cong'));
            } else {
                setSuccess(t('preprocess.encrypt:mo_khoa_thanh_cong'));
            }
        } catch (e: any) {
            setError(e.message || t('preprocess.encrypt:loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Mode switch */}
            <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-zinc-700">
                <button
                    type="button"
                    onClick={() => { setMode('lock'); setError(''); setSuccess(''); }}
                    className={`flex-1 py-2 text-[12px] font-bold transition-colors ${
                        mode === 'lock'
                            ? 'bg-amber-500 text-white'
                            : 'bg-slate-50 dark:bg-zinc-800 text-slate-600 dark:text-slate-300'
                    }`}
                >
                    🔒 {t('preprocess.encrypt:tab_khoa')}
                </button>
                <button
                    type="button"
                    onClick={() => { setMode('unlock'); setError(''); setSuccess(''); }}
                    className={`flex-1 py-2 text-[12px] font-bold transition-colors ${
                        mode === 'unlock'
                            ? 'bg-sky-500 text-white'
                            : 'bg-slate-50 dark:bg-zinc-800 text-slate-600 dark:text-slate-300'
                    }`}
                >
                    🔓 {t('preprocess.encrypt:tab_mo_khoa')}
                </button>
            </div>

            {mode === 'lock' ? (
                <>
                    <div>
                        <ToolSectionLabel>{t('preprocess.encrypt:mat_khau')}</ToolSectionLabel>
                        <div className="flex flex-col gap-2">
                            <label className="text-[11px] text-slate-500">{t('preprocess.encrypt:user_password')}</label>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={userPassword}
                                onChange={(e) => setUserPassword(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                                placeholder={t('preprocess.encrypt:placeholder_user')}
                            />
                            <label className="text-[11px] text-slate-500">{t('preprocess.encrypt:confirm_password')}</label>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                            />
                            <label className="text-[11px] text-slate-500">{t('preprocess.encrypt:owner_password')}</label>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={ownerPassword}
                                onChange={(e) => setOwnerPassword(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                                placeholder={t('preprocess.encrypt:placeholder_owner')}
                            />
                            <label className="text-[11px] text-slate-500">{t('preprocess.encrypt:open_password_if_locked')}</label>
                            <input
                                type="password"
                                autoComplete="off"
                                value={openPassword}
                                onChange={(e) => setOpenPassword(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                                placeholder={t('preprocess.encrypt:placeholder_open')}
                            />
                        </div>
                    </div>

                    <div>
                        <ToolSectionLabel>{t('preprocess.encrypt:quyen_han')}</ToolSectionLabel>
                        <div className="flex flex-col gap-1.5">
                            <ToolCheckboxOption
                                label={t('preprocess.encrypt:allow_print')}
                                desc={t('preprocess.encrypt:allow_print_desc')}
                                selected={allowPrint}
                                onClick={() => setAllowPrint(!allowPrint)}
                            />
                            <ToolCheckboxOption
                                label={t('preprocess.encrypt:allow_copy')}
                                desc={t('preprocess.encrypt:allow_copy_desc')}
                                selected={allowCopy}
                                onClick={() => setAllowCopy(!allowCopy)}
                            />
                            <ToolCheckboxOption
                                label={t('preprocess.encrypt:allow_modify')}
                                desc={t('preprocess.encrypt:allow_modify_desc')}
                                selected={allowModify}
                                onClick={() => setAllowModify(!allowModify)}
                            />
                            <ToolCheckboxOption
                                label={t('preprocess.encrypt:allow_annotate')}
                                desc={t('preprocess.encrypt:allow_annotate_desc')}
                                selected={allowAnnotate}
                                onClick={() => setAllowAnnotate(!allowAnnotate)}
                            />
                        </div>
                    </div>

                    <ToolInfo desc={<>{t('preprocess.encrypt:info_lock')}</>} />

                    <button
                        type="button"
                        onClick={handleLock}
                        disabled={isProcessing || !pdfFile}
                        className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg ${
                            isProcessing || !pdfFile
                                ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                                : 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white shadow-amber-500/25'
                        }`}
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </>
            ) : (
                <>
                    <div>
                        <ToolSectionLabel>{t('preprocess.encrypt:mat_khau_hien_tai')}</ToolSectionLabel>
                        <input
                            type="password"
                            autoComplete="off"
                            value={unlockPassword}
                            onChange={(e) => setUnlockPassword(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                            placeholder={t('preprocess.encrypt:placeholder_unlock')}
                        />
                    </div>

                    <ToolInfo desc={<>{t('preprocess.encrypt:info_unlock')}</>} />

                    <button
                        type="button"
                        onClick={handleUnlock}
                        disabled={isProcessing || !pdfFile}
                        className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg ${
                            isProcessing || !pdfFile
                                ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                                : 'bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white shadow-sky-500/25'
                        }`}
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </>
            )}

            {progress && (
                <div className="flex items-center gap-3 bg-teal-50 dark:bg-teal-900/20 p-3 rounded-lg border border-teal-200 dark:border-teal-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-teal-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-teal-700 dark:text-teal-300 font-medium">{progress}</span>
                </div>
            )}

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
