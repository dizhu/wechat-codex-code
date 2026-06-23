import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".wechat-codex-code", "logs");
const MAX_LOG_FILES = 30; // Keep at most 30 days of logs

/** Clean up old log files beyond MAX_LOG_FILES retention. */
function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("bridge-") && f.endsWith(".log"))
      .sort();
    while (files.length > MAX_LOG_FILES) {
      unlinkSync(join(LOG_DIR, files.shift()!));
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Redact sensitive values from a string:
 * - Bearer tokens (Authorization headers)
 * - aes_key values
 * - generic token/secret values in JSON payloads
 */
export function redact(obj: unknown): string {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (!raw) return raw;

  let safe = raw;
  // Mask Bearer tokens: "Bearer <anything>"
  safe = safe.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer ***");
  // Mask sensitive JSON string values by key name. Matches snake_case,
  // camelCase and kebab-case keys whose name contains a sensitive substring
  // (token, secret, password, api[-_]?key, aes[-_]?key, EncodingAESKey,
  // credential, authorization, signature).
  safe = safe.replace(
    /"([^"]*?(?:token|secret|password|api[-_]?key|aes[-_]?key|encodingaeskey|credential|authorization|signature)[^"]*?)"\s*:\s*"[^"]*"/gi,
    (_match, key: string) => `"${key}": "***"`,
  );
  // Mask credentials embedded in URLs (userinfo form: scheme://user:pass@host).
  // Single bounded character class (no nested unbounded quantifiers) so a long
  // URL-like value without an '@' can't trigger catastrophic backtracking.
  safe = safe.replace(/([a-z][a-z0-9+.\-]{0,32}:\/\/)[^/@\s"]{1,256}@/gi, "$1***@");
  // Mask sensitive query-string parameters (?token=…, &key=…, …); bounded classes.
  safe = safe.replace(
    /([?&][^=&\s"]{0,64}(?:token|secret|key|password|signature)[^=&\s"]{0,64}=)[^&\s"]{1,512}/gi,
    "$1***",
  );
  return safe;
}

function ensureLogDir(): void {
  // Logs contain conversation contents — keep dir/files owner-only (like creds).
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  cleanupOldLogs();
}

function getLogFilePath(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `bridge-${date}.log`);
}

function writeLogLine(level: string, message: string, data?: unknown): void {
  ensureLogDir();
  const ts = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const timestamp = ts.replace('Z', '+08:00');
  const parts = [timestamp, level, message];
  if (data !== undefined) {
    parts.push(redact(data));
  }
  const line = parts.join(" ") + "\n";
  // mode applies only on file creation; new log files are owner-only (0600).
  appendFileSync(getLogFilePath(), line, { encoding: "utf-8", mode: 0o600 });
}

export const logger = {
  info(message: string, data?: unknown): void {
    writeLogLine("INFO", message, data);
  },
  warn(message: string, data?: unknown): void {
    writeLogLine("WARN", message, data);
  },
  error(message: string, data?: unknown): void {
    writeLogLine("ERROR", message, data);
  },
  debug(message: string, data?: unknown): void {
    writeLogLine("DEBUG", message, data);
  },
} as const;
