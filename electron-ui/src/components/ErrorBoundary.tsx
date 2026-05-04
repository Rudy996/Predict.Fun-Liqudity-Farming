import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }

type State = { error: Error | null }

/**
 * Без границы ошибок при исключении в рендере React снимает всё дерево — остаётся только фон окна (серый экран).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const msg = `[UI ErrorBoundary] ${error.message}\n${info.componentStack ?? ''}`
    if (typeof globalThis.console !== 'undefined') {
      globalThis.console.error(msg)
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-dark-900 text-gray-200 flex flex-col items-center justify-center p-6">
          <p className="text-lg font-semibold text-center mb-2">Интерфейс остановился</p>
          <p className="text-sm text-gray-500 text-center max-w-md mb-4">
            Ошибка отрисовки. Сервер может продолжать работать — обновите окно (F5 или кнопка ниже).
          </p>
          <pre className="text-xs text-red-400/90 max-w-full max-h-40 overflow-auto mb-4 p-2 bg-dark-800 rounded border border-dark-600 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-bnb text-dark-900 font-semibold hover:opacity-95"
            onClick={() => window.location.reload()}
          >
            Перезагрузить окно
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
