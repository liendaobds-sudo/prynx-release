import React from 'react';

interface Props {
  children: React.ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Ghi lỗi ra console để vẫn chẩn đoán được sau sự cố (kể cả production),
    // KHÔNG hiển thị stack/đường dẫn nội bộ ra UI người dùng cuối.
    console.error('[ErrorBoundary] React crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // DEV: hiện đầy đủ stack để debug nhanh.
      // PROD: chỉ thông báo thân thiện + nút tải lại, không lộ stack (audit §12.4).
      const isDev = import.meta.env.DEV;
      return (
        <div style={{ padding: '2rem', background: '#330000', color: '#ffaaaa', height: '100vh', overflow: 'auto', fontFamily: 'monospace' }}>
          <h1>Đã xảy ra lỗi</h1>
          {isDev ? (
            <>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error?.message}</pre>
              <pre style={{ marginTop: '1rem', color: '#ff5555', whiteSpace: 'pre-wrap' }}>{this.state.error?.stack}</pre>
            </>
          ) : (
            <p style={{ marginTop: '1rem' }}>
              Ứng dụng gặp sự cố ngoài ý muốn. Vui lòng tải lại để tiếp tục.
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: '1.5rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
          >
            Tải lại
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
