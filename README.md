<p align="center">
  <img src="images/icon.png" width="128" alt="Claude Account Switcher logo">
</p>

<h1 align="center">Claude Account Switcher</h1>

<p align="center">
  Switch between multiple Claude Code accounts from the VS Code status bar, without logging in again,<br>
  and see each account's 5-hour and weekly usage at a glance.
</p>

<p align="center">
  <a href="README.id.md">Bahasa Indonesia</a>
</p>

---

```
👤 Work  〰 5h 12%  7d 64%
```

## Features

- **One-click switching.** Click the status bar item, pick an account, done. No `/login` needed.
- **Automatic saving.** Every account you log in with through Claude Code (`/login`) is remembered.
- **Usage at a glance.** 5-hour and weekly usage for every account, with bars and reset times. The status bar turns yellow at 80% and red at 95%.
- **⭐ Most quota left.** Other accounts are sorted by free quota, and the best one is starred.
- **Reset alerts.** Get notified when a limit that was running high resets, with a button to switch to that account.
- **Keep your conversation.** After switching, resume the same conversation with the new account, or start a new one.
- **Labels and colours.** Name accounts ("Work", "💼 Personal") and give them a colour. By default the email is shown.
- **Broken session detection.** A saved session that was revoked or expired is flagged, with a button to log in again, so switching never logs Claude Code out.

## Requirements

- VS Code 1.90 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the VS Code extension or the CLI), logged in with a Claude account (Pro, Max, Team…)
- Windows, macOS or Linux

API-key logins are not supported. There is no account to switch when you use an API key.

## Installation

### From a `.vsix` file

1. Download `claude-account-switcher.vsix` from the [Releases page](https://github.com/RizalWiyono/vscode-claude-account-switcher/releases), or build it yourself (see [Development](#development)).
2. In VS Code: **Extensions** → `···` → **Install from VSIX…**, or run:
   ```bash
   code --install-extension claude-account-switcher.vsix
   ```
3. Run **Developer: Reload Window**.

## Usage

### Add your accounts

1. The account you are logged in with now is saved automatically.
2. Log in with the next account: click the status bar item → **Add another account…** → **Open Terminal**, then type `/login` and sign in.
   > ⚠️ Use `/login`, **not** `/logout`. Logging out revokes the saved session of the current account.
3. The new account is saved as soon as the login finishes. Repeat for every account.

### Switch

Click the status bar item and pick an account. You then choose what happens next:

| Option | What it does |
|---|---|
| **Resume Conversation** | Restarts extensions and reopens your last conversation, now running on the new account. |
| **New Conversation** | Opens a new Claude Code conversation on the new account. Nothing is restarted. |
| **Restart Extensions** | Restarts extensions only. Editors and terminals stay open. |
| **Reload Window** | Reloads the whole VS Code window. |

To skip the question, set `claudeSwitcher.afterSwitch`.

Conversations that are already open keep using the old account until they are restarted or resumed. The first message after resuming a long conversation on another account uses more quota, because the prompt cache is not shared between accounts. Run `/compact` first if the conversation is long.

### Labels and colours

Click 🏷️ next to an account (or run **Claude: Set Account Label**). Leave the label empty to show the email again.

## Commands

| Command | Description |
|---|---|
| `Claude: Switch Account` | Open the account list (same as clicking the status bar) |
| `Claude: Set Account Label` | Set a label and colour for an account |
| `Claude: Refresh Usage` | Refresh usage now |
| `Claude: Save Current Account` | Save the logged-in account manually (normally automatic) |
| `Claude: Remove Saved Account` | Forget a saved account |

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeSwitcher.afterSwitch` | `ask` | What to do after switching: `ask`, `resume`, `newConversation`, `restartExtensions`, `reloadWindow`, `nothing` |
| `claudeSwitcher.refreshIntervalMinutes` | `5` | How often usage is refreshed |
| `claudeSwitcher.warningThreshold` | `80` | Usage percent at which the status bar turns yellow (red at 95%) |
| `claudeSwitcher.notifyOnReset` | `true` | Notify when a limit above the warning threshold resets |

## How it works

Claude Code keeps its login in two places. Switching replaces both:

| | Windows / Linux | macOS |
|---|---|---|
| Tokens | `~/.claude/.credentials.json` | Keychain item `Claude Code-credentials` |
| Account info | `oauthAccount` in `~/.claude.json` | same |

If `CLAUDE_CONFIG_DIR` is set, that folder is used instead of `~/.claude`.

Everything else is shared by all accounts and never touched: skills, plugins, agents, hooks, settings, MCP servers and conversation history. Things tied to your claude.ai account follow the account: connectors (Gmail, Drive…), organisation skills, model access and limits.

## Privacy & security

- Saved tokens are stored in **VS Code SecretStorage**, which uses the OS keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux). They never leave your machine except to talk to Anthropic.
- The extension only contacts Anthropic:
  - `api.anthropic.com/api/oauth/usage` to read usage
  - `platform.claude.com` / `console.anthropic.com` to refresh the tokens of accounts that are not active
- Before every switch, a copy of the files it changes is written to `~/.claude-switcher-backup/`, readable only by you.
- No telemetry, no analytics.

## Troubleshooting

| Problem | Solution |
|---|---|
| `rate limited, retry in Xm` | The usage endpoint is rate limited. The last known values stay visible, and it retries automatically. |
| ❌ *Saved session expired or was revoked* | Log in to that account again with `/login`. The flag clears by itself. |
| `claude` is not recognized in the terminal | Use **Add another account… → Open Terminal**. It starts the CLI bundled with the Claude Code extension. |
| Usage shows nothing | Usage comes from an undocumented endpoint that may change. Switching accounts keeps working even if usage stops. |

## Development

```bash
npm install          # once
npm run compile      # build to out/
npm run watch        # rebuild on save
npm run package      # build claude-account-switcher.vsix
code --install-extension claude-account-switcher.vsix --force
```

Press `F5` in VS Code to launch an Extension Development Host.

| File | Contents |
|---|---|
| `src/extension.ts` | Status bar, account list, commands, notifications |
| `src/usage.ts` | Usage API and token refresh |
| `src/profiles.ts` | Saved accounts (SecretStorage) |
| `src/claudeFiles.ts` | Reading and writing Claude Code's login (files / macOS Keychain) |

## Disclaimer

This is an independent, community-made extension. It is **not affiliated with, endorsed by, or supported by Anthropic**. "Claude" and "Claude Code" are trademarks of Anthropic, PBC. The extension relies on undocumented behaviour of Claude Code that may change at any time. Use at your own risk.

## Author

Made by **Rizal Wiyono**.

## License

[MIT](LICENSE) © 2026 Rizal Wiyono
