import React from 'react';
import { tv } from './i18n';
import { APP_VERSION, buildUiDiagnosticReport, copyUiDiagnosticReport, createUiErrorId, reportUiError } from './lib/uiErrorDiagnostics';

interface Props {
  children: React.ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
  errorId: string;
  copied: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorId: '', copied: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error, errorId: createUiErrorId('root'), copied: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Ghi lỗi ra console để vẫn chẩn đoán được sau sự cố (kể cả production),
    // KHÔNG hiển thị stack/đường dẫn nội bộ ra UI người dùng cuối.
    console.error('[ErrorBoundary] React crashed:', error, info.componentStack);
    reportUiError('root', this.state.errorId, error, info.componentStack || undefined);
  }

  private copyDiagnostics = async () => {
    const report = buildUiDiagnosticReport('root', this.state.errorId, this.state.error);
    const copied = await copyUiDiagnosticReport(report);
    this.setState({ copied });
  };

  render() {
    if (this.state.hasError) {
      // DEV: hiện đầy đủ stack để debug nhanh.
      // PROD: chỉ thông báo thân thiện + nút tải lại, không lộ stack (audit §12.4).
      const isDev = import.meta.env.DEV;
      return (
        <div style={{ padding: '2rem', background: '#330000', color: '#ffaaaa', height: '100vh', overflow: 'auto', fontFamily: 'monospace' }}>
          <h1>{tv('Đã xảy ra lỗi')}</h1>
          {isDev ? (
            <>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error?.message}</pre>
              <pre style={{ marginTop: '1rem', color: '#ff5555', whiteSpace: 'pre-wrap' }}>{this.state.error?.stack}</pre>
            </>
          ) : (
            <p style={{ marginTop: '1rem' }}>
              {tv('Ứng dụng gặp sự cố ngoài ý muốn. Vui lòng tải lại để tiếp tục.')}
            </p>
          )}
          <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', opacity: 0.8 }}>
            {tv('Mã lỗi')}: {this.state.errorId} · {tv('Phiên bản')}: {APP_VERSION}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: '1.5rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
          >
            {tv('Tải lại')}
          </button>
          <button
            type="button"
            onClick={this.copyDiagnostics}
            style={{ marginTop: '1.5rem', marginLeft: '0.75rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
          >
            {this.state.copied ? tv('Đã sao chép') : tv('Sao chép chẩn đoán')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
