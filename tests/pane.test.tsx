import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-10T08:30:00Z')
const HOUR = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

const STATUS = {
  activeId: 'u1:o1',
  activeName: 'personal',
  liveEmail: 'personal@example.com',
  otherSessions: [{ pid: 1, sessionId: 's', name: 'other-project-3f', cwd: '', status: 'idle' }],
  usageFile: 'usage.json',
  accounts: [
    { name: 'personal', id: 'u1:o1', email: 'personal@example.com', displayName: '', orgName: "personal@example.com's Organization", plan: 'max', tier: '', savedAt: 0, refreshExpiresAt: null, needsLogin: false, isActive: true },
    { name: 'work', id: 'u2:o2', email: 'work@example.com', displayName: '', orgName: 'Acme', plan: 'team', tier: '', savedAt: 0, refreshExpiresAt: null, needsLogin: false, isActive: false },
  ],
}

const USAGE = {
  'u1:o1': { fiveHour: { percentUsed: 3, resetsAt: iso(NOW + 3.3 * HOUR) }, sevenDay: { percentUsed: 0, resetsAt: iso(NOW + 162 * HOUR) }, at: NOW },
  'u2:o2': { fiveHour: { percentUsed: 7, resetsAt: iso(NOW - HOUR) }, sevenDay: { percentUsed: 97, resetsAt: iso(NOW + 84 * HOUR) }, at: NOW - 2 * HOUR },
}

for (const bodyColumns of [34, 60]) {
  test(`the account pane draws compactly at ${bodyColumns} columns`, async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' } }))
    on('fs.read', () => ({ value: JSON.stringify(USAGE) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('clock.now', () => ({ value: NOW }))

    await $.command.run({ command: 'account', args: 'list' })
    const ui = await $.ui.mount({
      plugin: 'claudehopper',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'claudehopper',
      props: { title: 'Accounts', isFocused: true, bodyColumns, placement: 'dock' },
    })

    expect(await ui.find({ key: 'acct-u1:o1' })).toBeDefined()
    expect(await ui.find({ key: 'acct-u2:o2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Organization/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /work@example\.com · Acme · 2h ago/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /also switches: other-project-3f/ })).toBeDefined()
    // the pace delta in brackets, as the status line draws it: work's week is 97% used, 50% elapsed
    expect(await ui.find({ type: 'Text', text: /\[-47%\]/ })).toBeDefined()
    await ui.unmount()
  })
}
