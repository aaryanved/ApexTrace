import { Component, type ErrorInfo, type ReactNode } from 'react'

// A crash inside one screen must not blank the whole app (nav included).
// Keyed by screen in App.tsx, so switching screens starts a fresh boundary.
export class ScreenBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed:', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" style={{ padding: 'var(--space-xl)', paddingTop: 96, color: 'var(--color-white)', fontFamily: 'var(--font-base)' }}>
        <h2 style={{ margin: 0 }}>This screen hit an error</h2>
        <p style={{ color: 'var(--color-neutral)' }}>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
}
