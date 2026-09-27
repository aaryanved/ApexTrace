import { useBackendHealth } from '../hooks/useBackendHealth'
import { StatusBadge } from './StatusBadge'

// Silent while everything works; only speaks up when the backend is down.
export function ConnectionStatus() {
  const status = useBackendHealth()
  if (status !== 'unreachable') return null
  // Hosted build: the free backend sleeps when idle and takes up to a minute to wake.
  const label = import.meta.env.VITE_API_BASE_URL
    ? 'Backend waking up — this can take up to a minute'
    : 'Backend unreachable — start it with scripts/start.sh'
  return <StatusBadge label={label} tone="danger" />
}
