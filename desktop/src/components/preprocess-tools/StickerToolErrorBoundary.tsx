import React from 'react';

import { tv } from '../../i18n';
import {
    APP_VERSION,
    buildUiDiagnosticReport,
    copyUiDiagnosticReport,
    createUiErrorId,
    reportUiError,
} from '../../lib/uiErrorDiagnostics';
import { resetStickerPreferences } from './StickerTool';

interface State {
    error: Error | null;
    errorId: string;
    attempt: number;
    copied: boolean;
}

export default class StickerToolErrorBoundary extends React.Component<React.PropsWithChildren, State> {
    state: State = {
        error: null,
        errorId: '',
        attempt: 0,
        copied: false,
    };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return {
            error,
            errorId: createUiErrorId('sticker'),
            copied: false,
        };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        const errorId = this.state.errorId || createUiErrorId('sticker');
        if (!this.state.errorId) this.setState({ errorId });
        reportUiError('sticker-tool', errorId, error, info.componentStack || undefined);
    }

    private retry = (resetPreferences: boolean) => {
        if (resetPreferences) resetStickerPreferences();
        this.setState(state => ({
            error: null,
            errorId: '',
            copied: false,
            attempt: state.attempt + 1,
        }));
    };

    private copyDiagnostics = async () => {
        const report = buildUiDiagnosticReport('sticker-tool', this.state.errorId, this.state.error);
        const copied = await copyUiDiagnosticReport(report);
        this.setState({ copied });
    };

    render() {
        if (!this.state.error) {
            return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
        }
        return (
            <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100">
                <h3 className="text-sm font-bold">{tv('Không thể mở công cụ Bù xén – Tạo đường cắt')}</h3>
                <p className="mt-1 text-xs leading-relaxed opacity-80">
                    {tv('Cấu hình cũ hoặc dữ liệu giao diện trên máy này có thể bị lỗi. File PDF của bạn không bị thay đổi.')}
                </p>
                <p className="mt-2 font-mono text-[10px] opacity-70">
                    {tv('Mã lỗi')}: {this.state.errorId} · {tv('Phiên bản')}: {APP_VERSION}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => this.retry(true)} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-700">
                        {tv('Khôi phục cấu hình và thử lại')}
                    </button>
                    <button type="button" onClick={() => this.retry(false)} className="rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-zinc-900 dark:text-rose-200">
                        {tv('Thử lại')}
                    </button>
                    <button type="button" onClick={this.copyDiagnostics} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                        {this.state.copied ? tv('Đã sao chép') : tv('Sao chép chẩn đoán')}
                    </button>
                </div>
            </div>
        );
    }
}
