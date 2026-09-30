import './App.css'
import { ErrorProvider } from './app/ErrorContext'
import { ScreenBoundary } from './app/ScreenBoundary'
import { ErrorBanner } from './components/ErrorBanner'
import { DriveScreen } from './screens/DriveScreen'

function App() {
  return (
    <ErrorProvider>
      <div id="app-root">
        <ErrorBanner />
        <ScreenBoundary>
          <DriveScreen />
        </ScreenBoundary>
      </div>
    </ErrorProvider>
  )
}

export default App
