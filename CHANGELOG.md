# Changelog

## 1.0.0

First public release.

- Switch between saved Claude Code accounts from the status bar, without logging in again.
- Accounts are saved automatically after `/login`; tokens are kept in VS Code SecretStorage (OS keychain).
- 5-hour and weekly usage for every account, with bars, reset times and a yellow/red status bar warning.
- Optional label and colour per account.
- After switching: resume the same conversation, open a new one, restart extensions or reload the window.
- ⭐ marks the account with the most quota left.
- Notification when a limit that was running high resets.
- Detects saved sessions that were revoked or expired and asks to log in again.
- macOS Keychain and `CLAUDE_CONFIG_DIR` support.
