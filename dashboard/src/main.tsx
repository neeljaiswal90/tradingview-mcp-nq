import { Component, StrictMode } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Dashboard] Render error:', error, info);
  }
  render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <div style={{ padding: '40px', color: '#ef4444', fontFamily: 'monospace', background: '#0f1117', minHeight: '100vh' }}>
          <h2 style={{ marginBottom: '16px' }}>Dashboard crashed</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {err.message}{'\n\n'}{err.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
