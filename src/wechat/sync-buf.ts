import { loadJson, saveJson, validateAccountId } from '../store.js';
import { DATA_DIR } from '../constants.js';
import { join } from 'node:path';

// The long-poll cursor (get_updates_buf) is BOT-SPECIFIC — it encodes a
// position in one bot's update stream. With multiple bots polling concurrently,
// a single shared file would let them overwrite each other's cursor, causing
// missed/duplicated messages. Key it per bot account instead.
function syncBufPath(accountId: string): string {
  validateAccountId(accountId);
  return join(DATA_DIR, 'sync', `${accountId}.json`);
}

export function loadSyncBuf(accountId: string): string {
  return loadJson<string>(syncBufPath(accountId), '');
}

export function saveSyncBuf(accountId: string, buf: string): void {
  saveJson(syncBufPath(accountId), buf);
}
