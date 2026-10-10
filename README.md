# Claude-Hopper

![version](https://img.shields.io/badge/version-0.1.0-blue)

A mod for the Claude Code CLI for switching between several Claude accounts without logging in again. A switch happens inside the running session: your next message goes out on the other account, and the conversation carries on.

```
Accounts
1: ● personal                      max
   personal@example.com
   5h █░░░░   3%  3h19m  [+31%]
   wk ░░░░░   0%  6d18h

2: ○ work                         team
   work@example.com · Acme · 2h ago
   5h ░░░░░   0%  reset
   wk █████  97%  3d12h  [-47%]

↵ switch   r: refresh   esc close
```

## Features

- **Account switcher panel** (`/account`, or click the account name in the bottom right). Press 1–9 or Enter to switch.
- **Usage at a glance** for every saved account: the 5-hour and weekly windows with bar, reset countdown and pace delta (`[+n%]` under an even burn rate, `[-n%]` over it, hidden under 5 points).
- **Remembers logins.** Each account's tokens are kept until its refresh token expires, so `/login` is needed only once per account.
- **Saves accounts automatically.** The account you're logged in to is saved on startup. `/login` saves the account you're leaving before the login and the new one after it.
- **Current account in the footer:** `⇄ <name>` in the bottom-right corner, next to Claude Code's mode labels.

## Install

**Claude Code CLI only.** The mod runs in the CLI in any terminal, including the terminals built into VS Code or JetBrains. It does not run in the Claude desktop app, the VS Code extension's chat panel, the web or mobile, because it needs to run local commands, which the mod API allows only in the CLI.

You also need Claude Code 2.1.296 or later and Node.js on `PATH`. The vault encryption is Windows-only for now; see Limitations.

Load it in every session by adding the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\projects\\mods\\claude-hopper"
  }
}
```

Or load it for a single session with `claude --plugin-dir <path to this folder>`.

## Usage

| Command | What it does |
|---|---|
| `/account` | Open the switcher panel |
| `/account <name>` | Switch to a saved account (same as `/account switch <name>`) |
| `/account add [name]` | Save the logged-in account, or rename it |
| `/account rename <old> <new>` | Rename a saved account |
| `/account remove <name>` | Forget a saved account |
| `/account list` | List saved accounts |

To add another account, run `/login` with it. Accounts are named after the email address; rename them with `/account rename`.

The helper also runs from a terminal: `node bin/ch.js list`, `node bin/ch.js switch <name>`, `node bin/ch.js help`.

## How it works

Claude Code keeps its login in two files: the tokens in `~/.claude/.credentials.json` (`claudeAiOauth`) and the identity in `~/.claude.json` (`oauthAccount`). It re-reads the credentials file before each request, so replacing those two entries switches accounts without a restart.

- **Vault:** `~/.claudehopper/`. `accounts.json` holds names, emails and plans; `secrets/` holds each account's tokens, encrypted with Windows DPAPI (readable only by your Windows user); `usage.json` holds the last usage reading of each account.
- **Token refreshes:** Claude Code renews the access token and replaces the refresh token from time to time. Claude-Hopper saves the current tokens back to the vault every 10 minutes and before every switch, so the stored copy stays valid.
- **Which account is active** is read from a fingerprint of the token in the credentials file, not from `~/.claude.json`, which a running session may rewrite with its old identity. A token it has never seen is checked with Anthropic's profile endpoint before it's stored, so tokens are never filed under the wrong account.
- **Usage** comes from the rate-limit readings Claude Code gets with each response. An account you're not using shows its last reading and how old it is; a window whose reset time has passed shows as reset.

## Limitations

- **CLI only.** See Install.
- **All open sessions switch together.** They share one credentials file, and the panel lists the other open sessions.
- **`/status` in an already-open session** may show the previous email until restart. The account actually in use is the one in the footer label.
- **Windows only for now.** The vault is encrypted with DPAPI. On macOS Claude Code keeps its login in the Keychain, which Claude-Hopper doesn't read.
- **Usage of accounts you aren't using** is the last reading, not live. Usage from elsewhere (claude.ai, another machine) shows up once you switch to that account.
- **`/logout`** may revoke the token server-side. To add an account, use `/login` directly instead of logging out first.

## Development

```
claude plugin validate .
claude plugin test .
```

| Path | Contents |
|---|---|
| `hooks/register.tsx` | the mod: `/account`, the panel, the footer label, usage recording, `/login` hooks |
| `hooks/usage.ts` | usage figures: pace delta, reset countdown, bars |
| `bin/ch.js` | the vault helper the mod runs (Node, no dependencies) |
| `types/index.d.ts` | the mod's state contract |
| `tests/` | tests for the usage math, the panel and the footer label |

## License

MIT, see [LICENSE](LICENSE).
