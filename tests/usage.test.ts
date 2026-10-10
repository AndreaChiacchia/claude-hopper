import { expect, test } from 'claude-code/testing'

import { barCells, figures, paceDelta, resetIn, tone } from '../hooks/usage'

const HOUR = 3600_000
const NOW = Date.parse('2026-10-10T12:00:00Z')

test('pace delta matches the status line: under pace is positive', () => {
  // 3h into a 5h window (60% elapsed) with 40% used: 20 points under pace
  expect(paceDelta(40, NOW + 2 * HOUR, 5, NOW)).toBe(20)
})

test('pace delta is negative over pace and hidden under 5 points', () => {
  expect(paceDelta(90, NOW + 2 * HOUR, 5, NOW)).toBe(-30)
  expect(paceDelta(58, NOW + 2 * HOUR, 5, NOW)).toBe(null)
})

test('weekly window uses 168 hours', () => {
  // 4 days left of 7: 3/7 elapsed = 42.9%, 21% used
  expect(paceDelta(21, NOW + 96 * HOUR, 168, NOW)).toBe(22)
})

test('a stored window past its reset reads as fresh', () => {
  const f = figures({ percentUsed: 73, resetsAt: new Date(NOW - 60_000).toISOString() }, 5, NOW)
  expect(f).toEqual({ percent: 0, resetIn: '', delta: null, isReset: true })
})

test('reset countdown and bar', () => {
  expect(resetIn(NOW + 72 * 60_000, NOW)).toBe('1h12m')
  expect(resetIn(NOW + 4 * 24 * HOUR, NOW)).toBe('4d')
  expect(barCells(48)).toEqual({ filled: 2, empty: 3 })
  expect(barCells(1)).toEqual({ filled: 1, empty: 4 })
  expect(tone(48)).toBe('success')
  expect(tone(63)).toBe('warning')
  expect(tone(80)).toBe('error')
})
