export type Account = {
  name: string
  id: string
  email: string
  displayName: string
  orgName: string
  plan: string
  tier: string
  savedAt: number
  refreshExpiresAt: number | null
  needsLogin: boolean
  isActive: boolean
}

export type RunningSession = { pid: number; sessionId: string; name: string; cwd: string; status: string }

export type UsageWindow = { percentUsed: number; resetsAt?: string }

/** The last rate-limit reading seen while an account was active. */
export type UsageRecord = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; at: number }

export type View = {
  accounts: Account[]
  activeId: string | null
  activeName: string | null
  liveEmail: string | null
  otherSessions: RunningSession[]
  usage: Record<string, UsageRecord>
  usageFile: string | null
  busy: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'claudehopper': { view: View; tick: number }
  }
}
