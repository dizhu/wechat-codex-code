import { decryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "../constants.js";

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!/^[A-Za-z0-9%=&+._~\-/]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/**
 * Resolve a 16-byte AES key from any of the three forms the WeChat API uses:
 *   1. raw hex string         — 32 hex chars (the flat `aeskey` alt field)
 *   2. base64-of-raw-16-bytes — decodes directly to 16 bytes
 *   3. base64-of-hex-string   — decodes to a 32-char hex string
 * The raw-hex case is checked first: a 32-char hex string is also valid base64,
 * so without this it would be mis-decoded (~24 garbage bytes) and yield a wrong
 * key. base64 of 16 raw bytes is 24 chars and base64 of a 32-char hex string is
 * 44 chars, so neither collides with the 32-hex-char test.
 */
function resolveAesKey(key: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/.test(key)) {
    return Buffer.from(key, "hex");
  }
  const raw = Buffer.from(key, "base64");
  if (raw.length === 16) {
    return raw;
  }
  return Buffer.from(raw.toString("utf-8"), "hex");
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    // Don't follow redirects: the download host is the fixed trusted CDN base;
    // a 3xx could steer the fetch to an untrusted host.
    response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`CDN download redirected, refused (status ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  const decrypted = decryptAesEcb(resolveAesKey(aesKeyBase64), encrypted);
  logger.info("CDN download and decrypt succeeded", { size: decrypted.length });

  return decrypted;
}
