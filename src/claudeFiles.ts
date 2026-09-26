import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Where Claude Code keeps its login state. CLAUDE_CONFIG_DIR moves both files.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const CREDENTIALS_PATH = path.join(CONFIG_DIR, '.credentials.json');
export const CLAUDE_JSON_PATH = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json');
const BACKUP_DIR = path.join(os.homedir(), '.claude-switcher-backup');

// On macOS the tokens live in the login Keychain instead of .credentials.json.
const IS_MAC = process.platform === 'darwin';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/** Whole content of ~/.claude/.credentials.json (or the macOS Keychain item). */
export interface CredentialsFile {
  claudeAiOauth: OAuthTokens;
  [key: string]: unknown;
}

/** The `oauthAccount` block inside ~/.claude.json. */
export interface OAuthAccount {
  accountUuid: string;
  emailAddress: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
  [key: string]: unknown;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  const tmp = `${file}.switcher-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(BACKUP_DIR, path.basename(file) + '.bak');
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
}

function readKeychain(): CredentialsFile | undefined {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out.trim());
  } catch {
    return undefined;
  }
}

function writeKeychain(creds: CredentialsFile): void {
  // Send the secret as hex over stdin (`security -i`) so it never shows up in the process list.
  const hex = Buffer.from(JSON.stringify(creds), 'utf8').toString('hex');
  const account = os.userInfo().username;
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

export function readCredentials(): CredentialsFile | undefined {
  const creds = (IS_MAC ? readKeychain() : undefined) ?? readJson<CredentialsFile>(CREDENTIALS_PATH);
  return creds?.claudeAiOauth?.accessToken ? creds : undefined;
}

export function readOAuthAccount(): OAuthAccount | undefined {
  return readJson<{ oauthAccount?: OAuthAccount }>(CLAUDE_JSON_PATH)?.oauthAccount;
}

/** The usage snapshot Claude Code itself caches in ~/.claude.json, if any. */
export function readCachedUsage(): { accountUuid: string; fetchedAtMs: number; utilization: unknown } | undefined {
  const cached = readJson<{ cachedUsageUtilization?: any }>(CLAUDE_JSON_PATH)?.cachedUsageUtilization;
  return cached?.accountUuid && cached.fetchedAtMs && cached.utilization ? cached : undefined;
}

/**
 * During /login Claude Code writes the tokens and the account info at slightly different
 * times. Only trust the pair when both point at the same organization.
 */
export function isConsistent(creds: CredentialsFile, account: OAuthAccount): boolean {
  const credsOrg = creds.organizationUuid;
  return !credsOrg || !account.organizationUuid || credsOrg === account.organizationUuid;
}

/** Makes `creds` + `account` the logged-in Claude Code account. */
export function activate(creds: CredentialsFile, account: OAuthAccount): void {
  backup(CLAUDE_JSON_PATH);

  if (IS_MAC && readKeychain()) {
    writeKeychain(creds);
  } else {
    backup(CREDENTIALS_PATH);
    writeJsonAtomic(CREDENTIALS_PATH, creds, 0o600);
  }

  // ~/.claude.json holds lots of unrelated state: only touch oauthAccount,
  // and re-read right before writing to lose as little concurrent change as possible.
  const claudeJson = readJson<Record<string, unknown>>(CLAUDE_JSON_PATH) ?? {};
  claudeJson.oauthAccount = account;
  writeJsonAtomic(CLAUDE_JSON_PATH, claudeJson);
}
