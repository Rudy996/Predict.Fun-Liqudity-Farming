import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'

if (typeof window !== 'undefined') {
  window.addEventListener('error', ev => {
    globalThis.console.error('[window.error]', ev.message, ev.error)
  })
  window.addEventListener('unhandledrejection', ev => {
    globalThis.console.error('[unhandledrejection]', ev.reason)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
