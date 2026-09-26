import { OAuthTokens } from './claudeFiles';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
// Public OAuth client id of Claude Code.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export interface Window {
  percent: number;
  resetsAt?: Date;
}

export interface Usage {
  fiveHour?: Window;
  sevenDay?: Window;
  sevenDayOpus?: Window;
  sevenDaySonnet?: Window;
  fetchedAt: Date;
}

export class UnauthorizedError extends Error {}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('rate limited');
  }
}

function toWindow(raw: any): Window | undefined {
  if (!raw || typeof raw.utilization !== 'number') return undefined;
  return { percent: raw.utilization, resetsAt: raw.resets_at ? new Date(raw.resets_at) : undefined };
}

/** Parses the usage endpoint's JSON (also the shape Claude Code caches in ~/.claude.json). */
export function parseUsage(data: any, fetchedAt = new Date()): Usage {
  return {
    fiveHour: toWindow(data?.five_hour),
    sevenDay: toWindow(data?.seven_day),
    sevenDayOpus: toWindow(data?.seven_day_opus),
    sevenDaySonnet: toWindow(data?.seven_day_sonnet),
    fetchedAt,
  };
}

export async function fetchUsage(accessToken: string): Promise<Usage> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(`HTTP ${res.status}`);
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    throw new RateLimitedError((Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000);
  }
  if (!res.ok) throw new Error(`Usage request failed: HTTP ${res.status}`);
  return parseUsage(await res.json());
}

/**
 * Exchanges a refresh token for new tokens. Refresh tokens rotate, so only call this
 * for saved accounts that Claude Code is NOT currently using.
 */
export async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  let lastError: unknown;
  for (const url of TOKEN_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (res.status === 400 || res.status === 401) {
        throw new UnauthorizedError(`refresh token rejected (HTTP ${res.status})`); // session is dead
      }
      if (!res.ok) {
        lastError = new Error(`Token refresh failed: HTTP ${res.status}`);
        continue;
      }
      const data: any = await res.json();
      return {
        ...tokens,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        scopes: typeof data.scope === 'string' ? data.scope.split(' ') : tokens.scopes,
      };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
