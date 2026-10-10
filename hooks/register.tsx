import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, UsageRecord, UsageWindow, View } from '../types'
import { ago, barCells, figures, tone } from './usage'

const PANE = 'claudehopper'
const SYNC_EVERY_MS = 10 * 60_000
const REFRESH_EVERY_MS = 60_000
const TICK_EVERY_MS = 30_000

const EMPTY: View = {
  accounts: [],
  activeId: null,
  activeName: null,
  liveEmail: null,
  otherSessions: [],
  usage: {},
  usageFile: null,
  busy: null,
  error: null,
}

const view = atom({ plugin: 'claudehopper', key: 'view' } as const, EMPTY)
const tick = atom({ plugin: 'claudehopper', key: 'tick' } as const, 0)

type Status = Omit<View, 'usage' | 'busy' | 'error'> & { error?: string }
type Saved = { saved?: boolean; created?: boolean; name?: string; email?: string; reason?: string }
type Switched = { name: string; email: string; needsLogin?: boolean; unchanged?: boolean }

const HELP = [
  '/account                 open the account switcher',
  '/account <name>          switch to a saved account (same as /account switch <name>)',
  '/account add [name]      save the logged-in account (or rename it)',
  '/account remove <name>   forget a saved account',
  '/account rename <a> <b>  rename a saved account',
  '/account list            list saved accounts',
  '',
  'To add another account: run /login with it; claudehopper saves the one you leave and the one you log in to.',
  'A switch applies to every open Claude Code session from its next message.',
].join('\n')

let sessionId = ''

// ---------- helper process ----------

async function ch<T>($: EngineInterface, args: string[], timeoutMs = 30_000): Promise<T> {
  const script = `${$.plugin.root}/bin/ch.js`
  const run = await $.process.run(['node', script, ...args, '--json'], { timeoutMs })
  const line = run.stdout.trim().split('\n').pop() ?? ''
  let parsed: (T & { error?: string }) | undefined
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(run.stderr.trim() || `ch ${args[0]} exited ${run.exitCode}`)
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) throw new Error(parsed.error)

  return parsed as T
}

async function readUsage($: EngineInterface, file: string | null): Promise<Record<string, UsageRecord>> {
  if (!file) return {}
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return {}
  }
}

async function refresh($: EngineInterface) {
  try {
    const status = await ch<Status>($, ['status', '--session', sessionId])
    const usage = await readUsage($, status.usageFile)
    await update($, view, v => ({ ...v, ...status, usage, error: null }))
  } catch (err) {
    await update($, view, v => ({ ...v, error: String((err as Error).message ?? err) }))
  }
}

// Saves the account that is logged in now: updates its tokens, or adds it when it is new.
async function adopt($: EngineInterface, { announce }: { announce: boolean }) {
  try {
    const saved = await ch<Saved>($, ['adopt'])
    if (saved.created && announce) {
      $.ui.toast(`claudehopper: saved ${saved.email} as "${saved.name}" (/account rename to change)`)
    }
  } catch (err) {
    $.ui.log(`claudehopper: could not save the current account: ${(err as Error).message}`, { to: 'debug' })
  }
}

async function recordUsage($: EngineInterface, windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  if (windows.length === 0) return
  await refresh($) // another session may have switched accounts since the last look
  const v = await read($, view)
  if (!v.activeId || !v.usageFile) return
  const pick = (kind: string): UsageWindow | undefined => {
    const w = windows.find(one => one.kind === kind)

    return w ? { percentUsed: w.percentUsed, resetsAt: w.resetsAt } : undefined
  }
  const record: UsageRecord = { fiveHour: pick('five_hour'), sevenDay: pick('seven_day'), at: await $.clock.now() }
  const activeId = v.activeId
  const stored = await readUsage($, v.usageFile)
  stored[activeId] = record
  await $.fs.write(v.usageFile, JSON.stringify(stored, null, 2))
  await update($, view, cur => ({ ...cur, usage: { ...cur.usage, [activeId]: record } }))
}

// ---------- switching ----------

async function switchTo($: EngineInterface, name: string): Promise<string> {
  const v = await read($, view)
  if (v.busy) return `claudehopper: already ${v.busy}`
  await update($, view, cur => ({ ...cur, busy: `switching to ${name}…`, error: null }))
  try {
    const r = await ch<Switched>($, ['switch', name])
    await update($, view, cur => ({ ...cur, busy: null }))
    await refresh($)
    if (r.unchanged) return `Already on ${r.name}.`
    const others = (await read($, view)).otherSessions.length

    return [
      `Switched to ${r.name} (${r.email}). Your next message uses it.`,
      r.needsLogin ? 'Its saved login has expired: run /login.' : '',
      others ? `${others} other open session${others > 1 ? 's' : ''} switched too.` : '',
    ].filter(Boolean).join(' ')
  } catch (err) {
    const message = (err as Error).message
    await update($, view, cur => ({ ...cur, busy: null, error: message }))

    return `claudehopper: ${message}`
  }
}

async function openPane($: EngineInterface) {
  const v = await read($, view)
  const rows = Math.min(30, 2 + v.accounts.length * 5 + (v.otherSessions.length ? 2 : 0))
  await $.ui.open({ id: PANE, title: 'Accounts', focus: true, closeOnEscape: true, rows, columns: 46 })
}

export const register: Register = on => {
  // ---------- lifecycle ----------

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()

    await $.command.register({
      name: 'account',
      description: 'Switch between saved Claude accounts (claudehopper)',
      argumentHint: '[name | add | remove | rename | list]',
    })

    void (async () => {
      await adopt($, { announce: true })
      await refresh($)
      const { rateLimits } = await $.session.usage()
      if (rateLimits.length) await recordUsage($, rateLimits)
    })()

    $.clock.every(SYNC_EVERY_MS, () => {
      void ch($, ['sync']).catch(() => undefined)
    })
    $.clock.every(REFRESH_EVERY_MS, () => {
      void refresh($)
    })
    $.clock.every(TICK_EVERY_MS, () => {
      void update($, tick, n => n + 1)
    })

    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await recordUsage($, e.rateLimits).catch(() => undefined)

    return next(e)
  })

  // /login replaces the stored credentials: save the account being left first, the new one after.
  on('command.run', { command: 'login' }, async ($, e, next) => {
    await ch($, ['sync']).catch(() => undefined)
    const result = await next(e)
    await adopt($, { announce: true })
    await refresh($)

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'logout' }, async ($, e, next) => {
    await ch($, ['sync']).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------- /account ----------

  on('command.run', { command: 'account' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const action = sub.toLowerCase()

    try {
      switch (action) {
        case '':
          await refresh($)
          await openPane($)

          return { text: 'Account switcher opened.' }
        case 'help':
          return { text: HELP }
        case 'list':
        case 'ls': {
          await refresh($)
          const v = await read($, view)
          if (v.accounts.length === 0) return { text: 'No saved accounts yet.' }

          return { text: v.accounts.map(a => `${a.isActive ? '●' : '○'} ${a.name}  ${a.email}  ${a.plan}${a.needsLogin ? '  (login expired)' : ''}`).join('\n') }
        }
        case 'add':
        case 'save': {
          const saved = await ch<Saved>($, ['add', ...(rest[0] ? [rest[0]] : [])])
          await refresh($)

          return { text: `Saved ${saved.email} as "${saved.name}".` }
        }
        case 'remove':
        case 'rm': {
          if (!rest[0]) return { text: 'Usage: /account remove <name>' }
          await ch($, ['remove', rest[0]])
          await refresh($)

          return { text: `Removed "${rest[0]}".` }
        }
        case 'rename': {
          const [from, to] = rest
          if (!from || !to) return { text: 'Usage: /account rename <old> <new>' }
          await ch($, ['rename', from, to])
          await refresh($)

          return { text: `Renamed "${from}" to "${to}".` }
        }
        case 'switch':
        case 'use':
          if (!rest[0]) return { text: 'Usage: /account switch <name>' }

          return { text: await switchTo($, rest[0]) }
        default:
          return { text: await switchTo($, sub) }
      }
    } catch (err) {
      return { text: `claudehopper: ${(err as Error).message}` }
    }
  })

  // ---------- bottom right: the footer's mode labels ----------

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await read($, view)
    const label = v.activeName ?? (v.liveEmail ? `${v.liveEmail} (unsaved)` : null)
    if (!label) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        {e.props.modes.length ? <Text dimColor>{`${e.props.modes.join(' & ')} · `}</Text> : ''}
        <Box key="account-label-hover">
          <Button
            key="account-label"
            plain
            dimColor
            hover={{ dimColor: false, underline: true }}
            onPress={() => void refresh($).then(() => openPane($))}
          >
            ⇄ {label}
          </Button>
        </Box>
      </Box>
    )
  })

  // ---------- the pane ----------
  // Built for a narrow dock: one line per fact, cut with an ellipsis rather than wrapped.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    await read($, tick)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 48
    const showDelta = columns >= 32

    const windowLine = (label: string, w: UsageWindow | undefined, hours: number) => {
      const f = figures(w, hours, now)
      if (!f) return null
      const { filled, empty } = barCells(f.percent)
      const t = tone(f.percent)
      const when = f.isReset ? 'reset' : f.resetIn

      return (
        <Text wrap="truncate-end">
          <Text dimColor>{label} </Text>
          <Text color={t}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(empty)}</Text>
          <Text color={t}>{`${String(f.percent).padStart(4)}%`}</Text>
          <Text dimColor>{`  ${when.padEnd(6)}`}</Text>
          {showDelta && f.delta !== null ? (
            <Text>
              {' ['}
              <Text color={f.delta >= 0 ? 'success' : 'error'}>{`${f.delta >= 0 ? '+' : ''}${f.delta}%`}</Text>
              {']'}
            </Text>
          ) : (
            ''
          )}
        </Text>
      )
    }

    const accountBlock = (a: Account, i: number) => {
      const u = v.usage[a.id]
      // Personal accounts carry an org named "<email>'s Organization": noise, so left out.
      const org = a.orgName && !a.orgName.endsWith("'s Organization") ? a.orgName : ''
      const detail = [a.email, org, u && !a.isActive ? ago(u.at, now) : ''].filter(Boolean).join(' · ')

      return (
        <Box key={`row-${a.id}`} flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Button
              key={`acct-${a.id}`}
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              autoFocus={a.isActive ? true : undefined}
              onPress={() => {
                if (a.isActive) return
                void switchTo($, a.name).then(text => $.ui.toast(text))
              }}
            >
              <Text color={a.isActive ? 'success' : undefined}>{a.isActive ? '●' : '○'} </Text>
              <Text bold={a.isActive}>{a.name}</Text>
            </Button>
            <Text color={a.needsLogin ? 'error' : undefined} dimColor={!a.needsLogin}>
              {a.needsLogin ? 'login expired' : a.plan}
            </Text>
          </Box>
          <Box paddingLeft={3} flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {detail}
            </Text>
            {u ? windowLine('5h', u.fiveHour, 5) : <Text dimColor>no usage yet</Text>}
            {u ? windowLine('wk', u.sevenDay, 168) : ''}
          </Box>
        </Box>
      )
    }

    const unsaved = v.liveEmail && !v.activeName
    const others = v.otherSessions.map(s => s.name || String(s.pid))

    return (
      <Box flexDirection="column" paddingX={1}>
        {v.accounts.length === 0 && <Text dimColor>No saved accounts yet. Run /login.</Text>}
        {v.accounts.map(accountBlock)}

        {unsaved ? (
          <Box columnGap={1}>
            <Text color="warning" wrap="truncate-end">
              {v.liveEmail} not saved
            </Text>
            <Button key="save-live" plain hotkey="s" label="save" onPress={() => void adopt($, { announce: true }).then(() => refresh($))} />
          </Box>
        ) : (
          ''
        )}
        {v.busy ? (
          <Text color="suggestion" wrap="truncate-end">
            {v.busy}
          </Text>
        ) : (
          ''
        )}
        {v.error ? (
          <Text color="error" wrap="wrap">
            {v.error}
          </Text>
        ) : (
          ''
        )}
        {others.length > 0 ? (
          <Text dimColor wrap="truncate-end">
            also switches: {others.join(', ')}
          </Text>
        ) : (
          ''
        )}

        <Box columnGap={2} marginTop={others.length > 0 || v.busy || v.error ? 1 : 0}>
          <Text dimColor>↵ switch</Text>
          <Button key="refresh" plain dimColor hotkey="r" label="refresh" onPress={() => void refresh($)} />
          <Text dimColor>esc close</Text>
        </Box>
      </Box>
    )
  })
}
