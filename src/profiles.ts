import * as vscode from 'vscode';
import { CredentialsFile, OAuthAccount } from './claudeFiles';

export const COLORS = {
  blue: { dot: '🔵', theme: 'charts.blue' },
  green: { dot: '🟢', theme: 'charts.green' },
  purple: { dot: '🟣', theme: 'charts.purple' },
  orange: { dot: '🟠', theme: 'charts.orange' },
  yellow: { dot: '🟡', theme: 'charts.yellow' },
  red: { dot: '🔴', theme: 'charts.red' },
} as const;
export type ColorName = keyof typeof COLORS;

export interface ProfileMeta {
  id: string; // accountUuid
  email: string;
  label?: string; // optional user label; the email is shown when unset
  color?: ColorName;
  plan?: string;
  broken?: boolean; // saved session was rejected; needs /login again
}

export interface Profile extends ProfileMeta {
  credentials: CredentialsFile;
  account: OAuthAccount;
}

const INDEX_KEY = 'claudeSwitcher.profiles';
const secretKey = (id: string) => `claudeSwitcher.profile.${id}`;

/** Saved accounts: metadata in globalState, tokens in VS Code SecretStorage (OS keychain). */
export class ProfileStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): ProfileMeta[] {
    // v0.1 stored the email as label; treat that as "no label".
    return this.ctx.globalState
      .get<ProfileMeta[]>(INDEX_KEY, [])
      .map(p => (p.label === p.email ? { ...p, label: undefined } : p));
  }

  async get(id: string): Promise<Profile | undefined> {
    const meta = this.list().find(p => p.id === id);
    const raw = await this.ctx.secrets.get(secretKey(id));
    if (!meta || !raw) return undefined;
    const { credentials, account } = JSON.parse(raw);
    return { ...meta, credentials, account };
  }

  async save(credentials: CredentialsFile, account: OAuthAccount): Promise<ProfileMeta> {
    const existing = this.list().find(p => p.id === account.accountUuid);
    const meta: ProfileMeta = {
      id: account.accountUuid,
      email: account.emailAddress,
      label: existing?.label,
      color: existing?.color,
      plan: credentials.claudeAiOauth.subscriptionType,
    };
    await this.ctx.secrets.store(secretKey(meta.id), JSON.stringify({ credentials, account }));
    await this.put(meta);
    return meta;
  }

  async updateCredentials(id: string, credentials: CredentialsFile): Promise<void> {
    const profile = await this.get(id);
    if (!profile) return;
    await this.ctx.secrets.store(secretKey(id), JSON.stringify({ credentials, account: profile.account }));
  }

  async setLabel(id: string, label: string | undefined, color: ColorName | undefined): Promise<void> {
    const meta = this.list().find(p => p.id === id);
    if (meta) await this.put({ ...meta, label: label || undefined, color });
  }

  async setBroken(id: string, broken: boolean): Promise<void> {
    const meta = this.list().find(p => p.id === id);
    if (meta && !!meta.broken !== broken) await this.put({ ...meta, broken: broken || undefined });
  }

  async remove(id: string): Promise<void> {
    await this.ctx.secrets.delete(secretKey(id));
    await this.ctx.globalState.update(INDEX_KEY, this.list().filter(p => p.id !== id));
  }

  /** Insert or replace, keeping the original order. */
  private async put(meta: ProfileMeta): Promise<void> {
    const list = this.list();
    const i = list.findIndex(p => p.id === meta.id);
    if (i >= 0) list[i] = meta;
    else list.push(meta);
    await this.ctx.globalState.update(INDEX_KEY, list);
  }
}
