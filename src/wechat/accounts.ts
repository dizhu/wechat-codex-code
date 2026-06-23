import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { loadJson, saveJson, validateAccountId } from '../store.js';
import { logger } from '../logger.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}

const ACCOUNTS_DIR = join(homedir(), '.wechat-codex-code', 'accounts');

function accountPath(accountId: string): string {
  validateAccountId(accountId);
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

/** Persist account credentials to disk. */
export function saveAccount(data: AccountData): void {
  const filePath = accountPath(data.accountId);
  saveJson(filePath, data);
  logger.info('Account saved', { accountId: data.accountId });
}

/** Load account credentials by ID. Returns null if not found. */
export function loadAccount(accountId: string): AccountData | null {
  const filePath = accountPath(accountId);
  const data = loadJson<AccountData | null>(filePath, null);
  if (data) {
    logger.info('Account loaded', { accountId });
  }
  return data;
}

/**
 * Load every bound account. Each ilink bot is 1:1 with the WeChat user who
 * scanned to bind it, so serving multiple employees means running one bot per
 * person — this returns all of them for the daemon to poll concurrently.
 */
export function loadAllAccounts(): AccountData[] {
  try {
    const files = readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
    const accounts: AccountData[] = [];
    for (const file of files) {
      const account = loadAccount(file.replace(/\.json$/, ''));
      if (account) accounts.push(account);
    }
    return accounts;
  } catch {
    return [];
  }
}
