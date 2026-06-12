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

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', background: '#330000', color: '#ffaaaa', height: '100vh', fontFamily: 'monospace' }}>
          <h1>React Crashed!</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error?.message}</pre>
          <pre style={{ marginTop: '1rem', color: '#ff5555' }}>{this.state.error?.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
