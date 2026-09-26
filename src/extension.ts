import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as claude from './claudeFiles';
import { COLORS, ColorName, ProfileMeta, ProfileStore } from './profiles';
import { fetchUsage, parseUsage, RateLimitedError, refreshTokens, UnauthorizedError, Usage, Window } from './usage';

interface UsageEntry {
  usage?: Usage; // last good data, kept when later requests fail
  error?: string;
  blockedUntil?: number; // set after HTTP 429
}

// The usage endpoint is rate limited per account, so never ask more often than this.
const MIN_FETCH_GAP_MS = 2 * 60_000;

let extCtx: vscode.ExtensionContext;
let store: ProfileStore;
let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastActiveId: string | undefined;
const usageCache = new Map<string, UsageEntry>();

export function activate(ctx: vscode.ExtensionContext) {
  extCtx = ctx;
  store = new ProfileStore(ctx);
  resumePending();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'claudeSwitcher.pick';
  statusItem.show();

  ctx.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeSwitcher.pick', showPicker),
    vscode.commands.registerCommand('claudeSwitcher.saveCurrent', saveCurrent),
    vscode.commands.registerCommand('claudeSwitcher.remove', removeProfile),
    vscode.commands.registerCommand('claudeSwitcher.setLabel', () => editLabel()),
    vscode.commands.registerCommand('claudeSwitcher.refresh', () => refreshActive(true)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeSwitcher')) startTimer();
    }),
  );

  // Pick up logins/token refreshes done by Claude Code itself.
  let debounce: NodeJS.Timeout | undefined;
  const onCredsChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onLiveChanged(), 1500);
  };
  // .claude.json too: on macOS the tokens are in the Keychain, so only this file changes on /login.
  for (const file of [claude.CREDENTIALS_PATH, claude.CLAUDE_JSON_PATH]) {
    fs.watchFile(file, { interval: 3000 }, onCredsChange);
    ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, onCredsChange) });
  }

  startTimer();
  const resetTicker = setInterval(checkResets, 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(resetTicker) });
  refreshAll();
}

export function deactivate() {
  if (timer) clearInterval(timer);
}

function config() {
  const c = vscode.workspace.getConfiguration('claudeSwitcher');
  return {
    intervalMin: Math.max(1, c.get<number>('refreshIntervalMinutes', 5)),
    warn: c.get<number>('warningThreshold', 80),
    notifyOnReset: c.get<boolean>('notifyOnReset', true),
  };
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(refreshAll, config().intervalMin * 60_000);
}

/** Active account first, then the others (needed for reset alerts and "most quota left"). */
async function refreshAll() {
  await refreshActive(false);
  for (const meta of store.list()) {
    if (meta.id !== lastActiveId) await updateUsage(meta.id, false);
  }
  render(lastActiveId);
}

// ---------------------------------------------------------------------------
// Reset notifications

const notifiedResets = new Set<string>();

/** Tells the user when a limit that was running high has reset. */
function checkResets() {
  const { warn, notifyOnReset } = config();
  const now = Date.now();
  let changed = false;
  for (const meta of store.list()) {
    const u = usageCache.get(meta.id)?.usage;
    if (!u) continue;
    const windows: [string, Window | undefined][] = [['5-hour', u.fiveHour], ['weekly', u.sevenDay]];
    for (const [name, w] of windows) {
      if (!w?.resetsAt || w.resetsAt.getTime() > now) continue;
      const resetAt = w.resetsAt.getTime();
      const wasHigh = w.percent >= warn;
      // Until the next fetch, show the window as reset.
      w.percent = 0;
      w.resetsAt = undefined;
      changed = true;

      const key = `${meta.id}:${name}:${resetAt}`;
      if (!notifyOnReset || !wasHigh || notifiedResets.has(key) || now - resetAt > 30 * 60_000) continue;
      notifiedResets.add(key);
      notifyReset(meta, name);
    }
  }
  if (changed) render(lastActiveId);
}

async function notifyReset(meta: ProfileMeta, windowName: string) {
  const isActive = meta.id === lastActiveId;
  const choice = await vscode.window.showInformationMessage(
    `✅ ${dot(meta)}${displayName(meta)}: ${windowName} limit has reset${isActive ? '' : ' — ready to use again'}.`,
    ...(isActive ? [] : ['Switch to it']),
  );
  if (choice === 'Switch to it') await switchTo(meta.id);
}

// ---------------------------------------------------------------------------
// Active account

function liveAccount() {
  const credentials = claude.readCredentials();
  const account = claude.readOAuthAccount();
  if (!credentials || !account) return undefined;
  // Mid-/login the two files can disagree; never pair one account's tokens with another's info.
  return claude.isConsistent(credentials, account) ? { credentials, account } : undefined;
}

/**
 * Saves whatever account Claude Code is logged into. Called often so the saved copy
 * always holds the latest (rotated) tokens, and new logins get remembered automatically.
 */
let lastSavedToken: string | undefined;

async function syncLive(): Promise<string | undefined> {
  const live = liveAccount();
  if (!live) return undefined;
  const token = live.credentials.claudeAiOauth.accessToken;
  const known = store.list().some(p => p.id === live.account.accountUuid);
  if (token !== lastSavedToken || !known) {
    await store.save(live.credentials, live.account);
    lastSavedToken = token;
  }
  return live.account.accountUuid;
}

/** Credentials file changed: a token refresh (same account) or a new login / switch. */
async function onLiveChanged(attempt = 0) {
  const id = await syncLive();
  if (!id && claude.readCredentials() && attempt < 5) {
    setTimeout(() => onLiveChanged(attempt + 1), 3000); // login still being written, try again shortly
    return;
  }
  if (id !== lastActiveId) await refreshActive(false);
  else render(id);
}

async function refreshActive(force: boolean) {
  const activeId = await syncLive();
  lastActiveId = activeId;
  if (activeId) {
    await updateUsage(activeId, force);
    const entry = usageCache.get(activeId);
    if (force && entry?.error) vscode.window.showWarningMessage(`Claude usage: ${entry.error}`);
  }
  render(activeId);
}

async function updateUsage(id: string, force: boolean) {
  const entry = usageCache.get(id) ?? {};
  const now = Date.now();
  if (entry.blockedUntil && entry.blockedUntil > now) return;
  if (entry.usage && now - entry.usage.fetchedAt.getTime() < MIN_FETCH_GAP_MS) return;

  const live = liveAccount();
  const isActive = live?.account.accountUuid === id;

  // Claude Code caches the active account's usage itself; reuse it instead of calling the API.
  if (isActive) {
    const cached = claude.readCachedUsage();
    const age = cached ? now - cached.fetchedAtMs : Infinity;
    if (cached?.accountUuid === id && (age < MIN_FETCH_GAP_MS || (!force && age < config().intervalMin * 60_000))) {
      usageCache.set(id, { usage: parseUsage(cached.utilization, new Date(cached.fetchedAtMs)) });
      return;
    }
  }

  try {
    const usage = isActive ? await fetchUsage(live!.credentials.claudeAiOauth.accessToken) : await fetchInactiveUsage(id);
    usageCache.set(id, { usage });
    if (!isActive) await store.setBroken(id, false);
  } catch (err) {
    usageCache.set(id, { usage: entry.usage, ...describeError(err, isActive) });
    // A saved (inactive) session that even a token refresh can't revive is dead.
    if (!isActive && err instanceof UnauthorizedError) await store.setBroken(id, true);
  }
}

/** Usage for a saved account that is not active; refreshes its tokens if needed. */
async function fetchInactiveUsage(id: string): Promise<Usage> {
  const profile = await store.get(id);
  if (!profile) throw new Error('not found');
  let tokens = profile.credentials.claudeAiOauth;
  const refresh = async () => {
    tokens = await refreshTokens(tokens);
    await store.updateCredentials(id, { ...profile.credentials, claudeAiOauth: tokens });
  };
  if (tokens.expiresAt < Date.now() + 60_000) await refresh();
  try {
    return await fetchUsage(tokens.accessToken);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    await refresh(); // access token revoked early; one retry with fresh tokens
    return fetchUsage(tokens.accessToken);
  }
}

function describeError(err: unknown, isActive: boolean): Pick<UsageEntry, 'error' | 'blockedUntil'> {
  if (err instanceof RateLimitedError) {
    return {
      error: `rate limited, retry in ${Math.ceil(err.retryAfterMs / 60_000)}m`,
      blockedUntil: Date.now() + err.retryAfterMs,
    };
  }
  if (err instanceof UnauthorizedError) {
    return {
      error: isActive
        ? 'token expired (Claude Code will refresh it on next use)'
        : 'session expired — log in to this account again',
    };
  }
  return { error: (err as Error).message };
}

// ---------------------------------------------------------------------------
// Rendering

function bar(percent: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function severityDot(percent: number): string {
  if (percent >= 95) return '🔴';
  if (percent >= config().warn) return '🟡';
  return '🟢';
}

function resetText(w: Window): string {
  if (!w.resetsAt) return '';
  const ms = w.resetsAt.getTime() - Date.now();
  if (ms <= 0) return 'now';
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  return w.resetsAt.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function windows(u: Usage): [string, Window][] {
  const all: [string, Window | undefined][] = [
    ['5h', u.fiveHour],
    ['7d', u.sevenDay],
    ['7d Opus', u.sevenDayOpus],
    ['7d Sonnet', u.sevenDaySonnet],
  ];
  return all.filter((x): x is [string, Window] => !!x[1]);
}

/** One-line usage summary for the account list. */
function usageDetail(entry: UsageEntry | undefined): string {
  const u = entry?.usage;
  if (!u) return entry?.error ? `$(warning) ${entry.error}` : '$(loading~spin) loading usage…';
  const parts = windows(u).map(([name, w]) => {
    const reset = resetText(w);
    return `${severityDot(w.percent)} ${name} ${bar(w.percent)} ${Math.round(w.percent)}%${reset ? ` $(history) ${reset}` : ''}`;
  });
  if (entry.error) parts.push(`$(warning) ${entry.error}`);
  return parts.join('     ');
}

function displayName(meta: ProfileMeta): string {
  return meta.label || meta.email;
}

/** Short name for the status bar: label, or the part of the email before @. */
function shortName(meta: ProfileMeta): string {
  return meta.label || meta.email.split('@')[0];
}

function planName(plan: string | undefined): string {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '';
}

function dot(meta: ProfileMeta): string {
  return meta.color ? `${COLORS[meta.color].dot} ` : '';
}

function render(activeId: string | undefined) {
  const meta = store.list().find(p => p.id === activeId);
  if (!meta) {
    statusItem.text = '$(account) Claude: not logged in';
    statusItem.tooltip = 'Log in with Claude Code, then click here.';
    statusItem.backgroundColor = undefined;
    statusItem.color = undefined;
    return;
  }

  const entry = usageCache.get(meta.id);
  const u = entry?.usage;
  let text = `$(account) ${shortName(meta)}`;
  let worst = 0;
  if (u) {
    const parts: string[] = [];
    if (u.fiveHour) parts.push(`5h ${Math.round(u.fiveHour.percent)}%`);
    if (u.sevenDay) parts.push(`7d ${Math.round(u.sevenDay.percent)}%`);
    if (parts.length) text += `  $(pulse) ${parts.join('  ')}`;
    worst = Math.max(u.fiveHour?.percent ?? 0, u.sevenDay?.percent ?? 0);
  }
  if (entry?.error) text += ' $(warning)';
  statusItem.text = text;

  statusItem.backgroundColor =
    worst >= 95
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst >= config().warn
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  // The label colour tints the text (only visible when no warning background is set).
  statusItem.color = meta.color && !statusItem.backgroundColor ? new vscode.ThemeColor(COLORS[meta.color].theme) : undefined;
  statusItem.tooltip = tooltip(meta, entry);
}

function tooltip(meta: ProfileMeta, entry: UsageEntry | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeSwitcher.pick', 'claudeSwitcher.refresh', 'claudeSwitcher.setLabel'] };

  const plan = planName(meta.plan);
  md.appendMarkdown(`### ${dot(meta)}${displayName(meta)}${plan ? ` &nbsp;\`${plan}\`` : ''}\n\n`);
  if (meta.label) md.appendMarkdown(`$(mail) ${meta.email}\n\n`);

  const u = entry?.usage;
  if (u) {
    const names: Record<string, string> = { '5h': '5-hour', '7d': 'Weekly', '7d Opus': 'Weekly Opus', '7d Sonnet': 'Weekly Sonnet' };
    md.appendMarkdown('| | | | |\n|:--|:--|--:|:--|\n');
    for (const [name, w] of windows(u)) {
      const reset = resetText(w);
      md.appendMarkdown(
        `| ${severityDot(w.percent)} ${names[name]} | \`${bar(w.percent, 12)}\` | **${Math.round(w.percent)}%** | ${reset ? `$(history) ${reset}` : ''} |\n`,
      );
    }
    md.appendMarkdown('\n');
  }
  if (entry?.error) md.appendMarkdown(`$(warning) ${entry.error}\n\n`);
  if (!u && !entry?.error) md.appendMarkdown('$(loading~spin) loading usage…\n\n');

  const others = rankOthers(meta.id);
  if (others.length) {
    const bestId = bestOtherId(meta.id);
    md.appendMarkdown('---\n\n');
    for (const o of others) {
      const ou = usageCache.get(o.id)?.usage;
      const summary = o.broken
        ? '$(error) login needed'
        : ou
          ? windows(ou)
              .slice(0, 2)
              .map(([n, w]) => `${n} ${Math.round(w.percent)}%`)
              .join(' · ')
          : '';
      const star = o.id === bestId ? ' ⭐' : '';
      md.appendMarkdown(`${dot(o)}${displayName(o)}${star}${summary ? ` — ${summary}` : ''}  \n`);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(
    '[$(arrow-swap) Switch](command:claudeSwitcher.pick) &nbsp;·&nbsp; ' +
      '[$(refresh) Refresh](command:claudeSwitcher.refresh) &nbsp;·&nbsp; ' +
      '[$(tag) Label](command:claudeSwitcher.setLabel)' +
      (u ? ` &nbsp;·&nbsp; updated ${u.fetchedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''),
  );
  return md;
}

// ---------------------------------------------------------------------------
// Commands

interface AccountItem extends vscode.QuickPickItem {
  profileId?: string;
  action?: 'add' | 'refresh';
}

const labelButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('tag'), tooltip: 'Set label' };
const removeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };

/** Percent of quota still free: limited by whichever of 5h / 7d is fuller. */
function headroom(meta: ProfileMeta): number | undefined {
  const u = usageCache.get(meta.id)?.usage;
  if (!u || meta.broken) return undefined;
  return 100 - Math.max(u.fiveHour?.percent ?? 0, u.sevenDay?.percent ?? 0);
}

/** Other accounts, most free quota first; unknown and broken ones last (stable order). */
function rankOthers(activeId: string | undefined): ProfileMeta[] {
  return store
    .list()
    .filter(p => p.id !== activeId)
    .map((p, i) => ({ p, i, h: headroom(p) ?? -1 }))
    .sort((a, b) => b.h - a.h || a.i - b.i)
    .map(x => x.p);
}

function bestOtherId(activeId: string | undefined): string | undefined {
  const best = rankOthers(activeId)[0];
  const h = best && headroom(best);
  return h !== undefined && h > 0 ? best.id : undefined;
}

const loginButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('sign-in'), tooltip: 'Log in again' };

function accountItem(meta: ProfileMeta, active: boolean, best: boolean): AccountItem {
  const plan = planName(meta.plan);
  if (meta.broken && !active) {
    return {
      profileId: meta.id,
      label: `$(error) ${dot(meta)}${displayName(meta)}`,
      description: [meta.label ? meta.email : '', plan].filter(Boolean).join('  ·  '),
      detail: '$(warning) Saved session expired or was revoked — select to log in again',
      buttons: [loginButton, labelButton, removeButton],
    };
  }
  return {
    profileId: meta.id,
    label: `${active ? '$(pass-filled)' : '$(account)'} ${dot(meta)}${displayName(meta)}`,
    description: [best ? '⭐ most quota left' : '', meta.label ? meta.email : '', plan].filter(Boolean).join('  ·  '),
    detail: usageDetail(usageCache.get(meta.id)),
    buttons: active ? [labelButton] : [labelButton, removeButton],
  };
}

async function showPicker() {
  const activeId = await syncLive();
  const qp = vscode.window.createQuickPick<AccountItem>();
  qp.title = 'Claude Accounts';
  qp.placeholder = 'Switch to… (type to filter by label or email)';
  qp.matchOnDescription = true;

  const buildItems = (): AccountItem[] => {
    const active = store.list().filter(p => p.id === activeId);
    const others = rankOthers(activeId);
    const bestId = bestOtherId(activeId);
    const sep = (label: string): AccountItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    return [
      ...(active.length ? [sep('Active'), ...active.map(m => accountItem(m, true, false))] : []),
      ...(others.length ? [sep('Switch to'), ...others.map(m => accountItem(m, false, m.id === bestId))] : []),
      sep(''),
      { label: '$(add) Add another account…', action: 'add' },
      { label: '$(refresh) Refresh usage', action: 'refresh' },
    ];
  };

  const loadAll = async (force: boolean) => {
    qp.busy = true;
    await Promise.all(
      store.list().map(async meta => {
        await updateUsage(meta.id, force);
        qp.items = buildItems();
      }),
    );
    qp.busy = false;
    render(activeId);
  };

  qp.items = buildItems();
  qp.onDidTriggerItemButton(async e => {
    const id = e.item.profileId!;
    if (e.button === removeButton) {
      const meta = store.list().find(p => p.id === id)!;
      const ok = await vscode.window.showWarningMessage(`Remove ${displayName(meta)} from saved accounts?`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await store.remove(id);
      usageCache.delete(id);
      qp.items = buildItems();
      return;
    }
    qp.hide();
    if (e.button === loginButton) await explainAdd(store.list().find(p => p.id === id)?.email);
    else await editLabel(id);
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    if (item.action === 'refresh') {
      loadAll(true);
      return;
    }
    qp.hide();
    if (item.action === 'add') await explainAdd();
    else if (item.profileId && item.profileId !== activeId) await switchTo(item.profileId);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  loadAll(false);
}

/** Asks for a label and colour. An empty label goes back to showing the email. */
async function editLabel(id?: string) {
  if (!id) {
    const activeId = claude.readOAuthAccount()?.accountUuid;
    const pick = await vscode.window.showQuickPick(
      store.list().map(p => ({
        label: `${p.id === activeId ? '$(pass-filled)' : '$(account)'} ${dot(p)}${displayName(p)}`,
        description: p.label ? p.email : '',
        id: p.id,
      })),
      { title: 'Set label', placeHolder: 'Which account?' },
    );
    if (!pick) return;
    id = pick.id;
  }
  const meta = store.list().find(p => p.id === id);
  if (!meta) return;

  const label = await vscode.window.showInputBox({
    title: `Label for ${meta.email}`,
    prompt: 'e.g. "Kantor" or "💼 Pribadi". Leave empty to show the email.',
    value: meta.label ?? '',
  });
  if (label === undefined) return; // cancelled

  const colorItems = [
    { label: '$(circle-slash) No colour', color: undefined as ColorName | undefined },
    ...(Object.keys(COLORS) as ColorName[]).map(c => ({
      label: `${COLORS[c].dot} ${c.charAt(0).toUpperCase() + c.slice(1)}`,
      color: c as ColorName | undefined,
    })),
  ];
  const colorPick = await vscode.window.showQuickPick(colorItems, {
    title: `Colour for ${label.trim() || meta.email}`,
    placeHolder: 'Shown as a dot in the list and tints the status bar',
  });
  if (!colorPick) return;

  await store.setLabel(meta.id, label.trim(), colorPick.color);
  render(claude.readOAuthAccount()?.accountUuid);
}

async function switchTo(id: string) {
  await syncLive(); // keep the outgoing account's latest tokens
  const profile = await store.get(id);
  if (!profile) {
    vscode.window.showErrorMessage('Saved account not found.');
    return;
  }
  if (profile.broken) {
    // Writing a dead session would just log Claude Code out; log in fresh instead.
    await explainAdd(profile.email);
    return;
  }
  try {
    claude.activate(profile.credentials, profile.account);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not switch account: ${(err as Error).message}`);
    return;
  }
  await refreshActive(false);
  await afterSwitch(displayName(profile));
}

const PENDING_RESUME_KEY = 'claudeSwitcher.pendingResume';
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Most recently written Claude Code transcript, preferring this workspace's project folder. */
function latestSessionId(): string | undefined {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  // Claude Code names project folders after the path with every non-alphanumeric char as '-'.
  const wanted = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase());
  const inWorkspace = dirs.filter(d => wanted.includes(d.toLowerCase()));

  let best: { id: string; mtime: number } | undefined;
  for (const dir of inWorkspace.length ? inWorkspace : dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, dir)).filter(f => SESSION_FILE.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const mtime = fs.statSync(path.join(root, dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { id: f.slice(0, -'.jsonl'.length), mtime };
    }
  }
  return best?.id;
}

/**
 * Restarting the extension host stops every running Claude process; the conversation is then
 * reopened by id and its new process picks up the new account. See resumePending().
 */
async function restartAndResume() {
  const sessionId = latestSessionId();
  if (!sessionId) {
    vscode.window.showWarningMessage('No Claude conversation found to resume — opening a new one.');
    await vscode.commands.executeCommand('claude-vscode.newConversation');
    return;
  }
  await extCtx.globalState.update(PENDING_RESUME_KEY, { sessionId, at: Date.now() });
  await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

/** Runs on activation: reopens the conversation saved by restartAndResume(). */
async function resumePending() {
  const pending = extCtx.globalState.get<{ sessionId: string; at: number }>(PENDING_RESUME_KEY);
  if (!pending) return;
  await extCtx.globalState.update(PENDING_RESUME_KEY, undefined);
  if (Date.now() - pending.at > 2 * 60_000) return;

  try {
    await vscode.extensions.getExtension('anthropic.claude-code')?.activate();
    await new Promise(r => setTimeout(r, 1500)); // let restored Claude tabs register first
    await vscode.commands.executeCommand('claude-vscode.editor.open', pending.sessionId);
    vscode.window.setStatusBarMessage('$(check) Conversation resumed with the new account', 5000);
  } catch (err) {
    vscode.window.showWarningMessage(`Could not reopen the conversation: ${(err as Error).message}`);
  }
}

const AFTER_SWITCH = {
  resume: { label: 'Resume Conversation', run: restartAndResume },
  newConversation: { label: 'New Conversation', run: () => vscode.commands.executeCommand('claude-vscode.newConversation') },
  restartExtensions: { label: 'Restart Extensions', run: () => vscode.commands.executeCommand('workbench.action.restartExtensionHost') },
  reloadWindow: { label: 'Reload Window', run: () => vscode.commands.executeCommand('workbench.action.reloadWindow') },
};
type AfterSwitch = keyof typeof AFTER_SWITCH;

/**
 * Each Claude Code conversation is its own CLI process that reads the login files on start,
 * so a new conversation already uses the new account; old ones keep the old account.
 */
async function afterSwitch(name: string) {
  const mode = vscode.workspace.getConfiguration('claudeSwitcher').get<string>('afterSwitch', 'ask');
  if (mode in AFTER_SWITCH) {
    vscode.window.setStatusBarMessage(`$(check) Claude switched to ${name}`, 4000);
    await AFTER_SWITCH[mode as AfterSwitch].run();
    return;
  }
  if (mode === 'nothing') {
    vscode.window.setStatusBarMessage(`$(check) Claude switched to ${name} — new conversations use it`, 5000);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Switched Claude to ${name}. New conversations use it; open ones keep the old account.`,
    ...Object.values(AFTER_SWITCH).map(a => a.label),
  );
  await Object.values(AFTER_SWITCH).find(a => a.label === choice)?.run();
}

/** Guides the user through /login; `email` is set when re-logging a broken saved account. */
async function explainAdd(email?: string) {
  const message = email
    ? `The saved session for ${email} has expired or was revoked. Run /login in Claude Code and sign in as ${email} ` +
      '(do NOT use /logout). The account is repaired automatically once login finishes.'
    : 'To add an account: in Claude Code run /login and sign in with the other account (do NOT use /logout — it revokes the saved session). ' +
      'The new account is saved automatically once login finishes.';
  const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Open Terminal');
  if (choice === 'Open Terminal') {
    // Prefer the CLI bundled with the Claude Code VS Code extension; `claude` may not be on PATH.
    const bundled = bundledClaudePath();
    const term = bundled
      ? vscode.window.createTerminal({ name: 'Claude login', shellPath: bundled })
      : vscode.window.createTerminal('Claude login');
    term.show();
    if (!bundled) term.sendText('claude');
    vscode.window.showInformationMessage('Type /login in the Claude terminal and sign in with the other account.');
  }
}

function bundledClaudePath(): string | undefined {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) return undefined;
  const exe = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(exe) ? exe : undefined;
}

async function saveCurrent() {
  const live = liveAccount();
  if (!live) {
    vscode.window.showWarningMessage('Claude Code is not logged in.');
    return;
  }
  const meta = await store.save(live.credentials, live.account);
  vscode.window.showInformationMessage(`Saved Claude account ${meta.email}.`);
  refreshActive(false);
}

async function removeProfile() {
  const activeId = claude.readOAuthAccount()?.accountUuid;
  const pick = await vscode.window.showQuickPick(
    store
      .list()
      .filter(p => p.id !== activeId)
      .map(p => ({ label: `${dot(p)}${displayName(p)}`, description: p.label ? p.email : '', id: p.id })),
    { placeHolder: 'Remove which saved account?' },
  );
  if (!pick) return;
  await store.remove(pick.id);
  usageCache.delete(pick.id);
  vscode.window.showInformationMessage(`Removed ${pick.label}.`);
}
