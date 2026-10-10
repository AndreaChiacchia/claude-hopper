import { expect, test } from 'claude-code/testing'

// What the helper's `status` answers: one saved account, active.
const STATUS = {
  activeId: 'u1:o1',
  activeName: 'personal',
  liveEmail: 'me@example.com',
  otherSessions: [],
  usageFile: null,
  accounts: [
    {
      name: 'personal', id: 'u1:o1', email: 'me@example.com', displayName: '', orgName: '', plan: 'max',
      tier: '', savedAt: 0, refreshExpiresAt: null, needsLogin: false, isActive: true,
    },
  ],
}

test('the bottom-right label draws, keeps the modes, and opens the switcher when pressed', async ($, on) => {
  let opened = ''
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' } }))
  on('ui.open', (_$, e) => ((opened = e.id), { value: { isPlaced: true } }))

  await $.command.run({ command: 'account', args: 'list' })
  const ui = await $.ui.mount({ plugin: 'claudehopper', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })

  expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
  expect(await ui.find({ key: 'account-label' })).toBeDefined()

  await ui.press({ key: 'account-label' })
  expect(opened).toBe('claudehopper')
  await ui.unmount()
})
