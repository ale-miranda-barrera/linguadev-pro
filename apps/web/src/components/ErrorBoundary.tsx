import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react';

interface State {
  err?: Error;
}

// Boundary de nivel app. En cada feature grande convendrá envolver también con <FeatureBoundary>.
export class ErrorBoundary extends Component<PropsWithChildren<{ fallback?: ReactNode }>, State> {
  override state: State = {};

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', err, info.componentStack);
  }

  reset = () => this.setState({ err: undefined });

  override render() {
    if (this.state.err) {
      return (
        this.props.fallback ?? (
          <div className="mx-auto my-16 max-w-md rounded-2xl border border-danger-500/20 bg-danger-500/5 p-6 text-center">
            <div className="text-2xl">⚠️</div>
            <h1 className="mt-2 text-lg font-semibold">Algo salió mal</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {this.state.err.message}
            </p>
            <button
              onClick={this.reset}
              className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
            >
              Reintentar
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
