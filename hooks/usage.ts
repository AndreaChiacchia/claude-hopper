// Rate-limit figures as the person's own status line draws them.

export type Tone = 'success' | 'warning' | 'error'

export type WindowFigures = {
  percent: number
  resetIn: string
  delta: number | null
  isReset: boolean
}

const HOUR = 3600_000

/** Percentage points ahead (+) or behind (-) an even burn rate; null under 5 or outside the window. */
export function paceDelta(used: number, resetsAtMs: number, windowHours: number, now: number): number | null {
  const windowMs = windowHours * HOUR
  const start = resetsAtMs - windowMs
  if (now >= resetsAtMs || now < start) return null
  const raw = ((now - start) * 100 - used * windowMs) / windowMs
  const delta = raw >= 0 ? Math.floor(raw + 0.5) : Math.ceil(raw - 0.5)

  return Math.abs(delta) < 5 ? null : delta
}

export function resetIn(resetsAtMs: number, now: number): string {
  const rem = Math.floor((resetsAtMs - now) / 1000)
  if (rem <= 0) return ''
  const d = Math.floor(rem / 86400)
  const h = Math.floor((rem % 86400) / 3600)
  const m = Math.floor((rem % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return `${m}m`

  return '<1m'
}

export function ago(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

export function tone(percent: number): Tone {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}

export function barCells(percent: number, width = 5): { filled: number; empty: number } {
  let filled = Math.floor((percent * width + 50) / 100)
  if (filled === 0 && percent > 0) filled = 1
  filled = Math.min(filled, width)

  return { filled, empty: width - filled }
}

/** A stored reading as it stands now: a window whose reset has passed reads as fresh. */
export function figures(
  window: { percentUsed: number; resetsAt?: string } | undefined,
  windowHours: number,
  now: number,
): WindowFigures | null {
  if (!window) return null
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  if (Number.isFinite(resetsAtMs) && resetsAtMs <= now) {
    return { percent: 0, resetIn: '', delta: null, isReset: true }
  }
  const percent = Math.round(window.percentUsed)
  if (!Number.isFinite(resetsAtMs)) return { percent, resetIn: '', delta: null, isReset: false }

  return {
    percent,
    resetIn: resetIn(resetsAtMs, now),
    delta: paceDelta(percent, resetsAtMs, windowHours, now),
    isReset: false,
  }
}
