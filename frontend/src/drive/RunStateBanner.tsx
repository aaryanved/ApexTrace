import { useEffect, useRef, useState } from 'react'
import { formatLapTime } from '../scene/trackGeometry'
import type { VehicleStateMessage } from '../types/schemas'
import './RunStateBanner.css'

const FLASH_MS = 3000

interface Flash {
  kind: 'lap' | 'sector' | 'contact'
  text: string
}

// Transient race-control style messages: off track, lap completed (with the
// lap time), sector transitions.
export function RunStateBanner({ vehicleState }: { vehicleState: VehicleStateMessage | null }) {
  const [flash, setFlash] = useState<Flash | null>(null)
  const prevSector = useRef<number | null>(null)
  const prevLaps = useRef<number | null>(null)
  const sector = vehicleState?.sector_index
  const laps = vehicleState?.laps_completed
  const lastLap = vehicleState?.last_lap_s
  const sectorName = vehicleState?.sector_name
  const contacts = vehicleState?.barrier_contacts
  const prevContacts = useRef<number | null>(null)

  useEffect(() => {
    if (contacts === undefined) return
    const before = prevContacts.current
    prevContacts.current = contacts
    if (before !== null && contacts > before) {
      setFlash({ kind: 'contact', text: 'Barrier contact' })
      const t = setTimeout(() => setFlash((f) => (f?.kind === 'contact' ? null : f)), 1800)
      return () => clearTimeout(t)
    }
  }, [contacts])

  useEffect(() => {
    if (laps === undefined) return
    const before = prevLaps.current
    prevLaps.current = laps
    if (before !== null && laps > before) {
      setFlash({ kind: 'lap', text: `Lap ${laps} complete · ${formatLapTime(lastLap)}` })
      const t = setTimeout(() => setFlash(null), FLASH_MS)
      return () => clearTimeout(t)
    }
  }, [laps, lastLap])

  useEffect(() => {
    if (sector === undefined) return
    const before = prevSector.current
    prevSector.current = sector
    if (before !== null && before !== sector && sector !== 0) {
      setFlash((f) => (f?.kind === 'lap' ? f : { kind: 'sector', text: sectorName ?? '' }))
      const t = setTimeout(() => setFlash((f) => (f?.kind === 'sector' ? null : f)), 1500)
      return () => clearTimeout(t)
    }
  }, [sector, sectorName])

  if (!vehicleState) return null

  if (vehicleState.off_track) {
    return (
      <div className="race-msg race-msg--danger" role="status">
        <span aria-hidden="true">✕</span> {flash?.kind === 'contact' ? 'Barrier contact' : 'Off track'} — rejoin safely (
        {vehicleState.track_exits} this run)
      </div>
    )
  }
  if (flash?.kind === 'contact') {
    return (
      <div className="race-msg race-msg--danger" role="status">
        <span aria-hidden="true">✕</span> {flash.text}
      </div>
    )
  }
  if (flash) {
    return (
      <div className={`race-msg ${flash.kind === 'lap' ? 'race-msg--lap' : 'race-msg--info'}`} role="status">
        {flash.kind === 'lap' ? <span aria-hidden="true">■</span> : null} {flash.text}
      </div>
    )
  }
  return null
}
