import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="h-full w-full flex items-center justify-center bg-bg-dark p-8">
          <div className="max-w-md text-center">
            <h2 className="text-lg font-bold text-text-dark mb-2">渲染错误</h2>
            <p className="text-sm text-text-muted mb-4 whitespace-pre-wrap">
              {this.state.error?.message || '未知错误'}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/85"
            >
              重试
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
