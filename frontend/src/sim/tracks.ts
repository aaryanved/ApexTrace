// The circuits, generated once from the track layouts by the Python track
// builder (backend/scripts/export_sim_fixtures.py in git history).
import type { TrackId, TrackProfile } from '../types/schemas'
import baku from './tracks/baku.json'
import monza from './tracks/monza.json'

export const TRACKS: Record<TrackId, TrackProfile> = {
  monza: monza as TrackProfile,
  baku: baku as TrackProfile,
}

export const TRACK_IDS: TrackId[] = ['monza', 'baku']
