import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_WORKING_DIR } from "./constants.js";

export interface Config {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  /**
   * Multi-user allowlist: WeChat from_user_id values authorized to drive Codex
   * in addition to the bound owner. Empty/absent = owner-only (single-user).
   * WARNING: every id here gets full command execution on this machine.
   */
  authorizedUsers?: string[];
}

const CONFIG_DIR = join(homedir(), ".wechat-codex-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  workingDirectory: DEFAULT_WORKING_DIR,
};

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const config: Config = {
      workingDirectory: parsed.workingDirectory || DEFAULT_CONFIG.workingDirectory,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      authorizedUsers: Array.isArray(parsed.authorizedUsers)
        ? parsed.authorizedUsers.filter((u: unknown): u is string => typeof u === 'string')
        : undefined,
    };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  } catch {
    const config = { ...DEFAULT_CONFIG };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const data: Record<string, unknown> = {
    workingDirectory: config.workingDirectory,
  };
  if (config.model) data.model = config.model;
  if (config.systemPrompt) data.systemPrompt = config.systemPrompt;
  if (config.authorizedUsers && config.authorizedUsers.length > 0) {
    data.authorizedUsers = config.authorizedUsers;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  if (process.platform !== "win32") {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
