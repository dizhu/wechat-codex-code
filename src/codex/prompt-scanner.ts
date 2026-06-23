import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';

export interface PromptInfo {
  name: string;
  description: string;
  path: string;
}

/** Codex custom-prompt directory ($CODEX_HOME/prompts, default ~/.codex/prompts). */
function promptsDir(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'prompts');
}

/**
 * Parse an optional one-line description from a Codex prompt file. Supports a
 * YAML-ish frontmatter `description:` field, falling back to the first
 * non-empty, non-heading line of the body.
 */
function parseDescription(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const descMatch = fm[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim().replace(/^["']|["']$/g, '');
  }
  const body = fm ? content.slice(fm[0].length) : content;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line.slice(0, 120);
  }
  return '';
}

/**
 * Scan $CODEX_HOME/prompts for `*.md` files. Each file is a custom prompt
 * invokable as `/<name>` (name = filename without extension), the Codex analog
 * of Claude Code skills.
 */
export function scanAllPrompts(): PromptInfo[] {
  const dir = promptsDir();
  const prompts: PromptInfo[] = [];
  if (!existsSync(dir)) return prompts;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return prompts;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = join(dir, entry.name);
    let description = '';
    try {
      description = parseDescription(readFileSync(fullPath, 'utf-8'));
    } catch {
      logger.warn(`Failed to read Codex prompt: ${fullPath}`);
    }
    prompts.push({ name: entry.name.replace(/\.md$/, ''), description, path: fullPath });
  }

  logger.info(`Scanned ${prompts.length} Codex prompts`);
  return prompts;
}

/** Find a prompt by name (case-insensitive). */
export function findPrompt(prompts: PromptInfo[], name: string): PromptInfo | undefined {
  const lower = name.toLowerCase();
  return prompts.find((p) => p.name.toLowerCase() === lower);
}

/**
 * Load a prompt file's body and substitute arguments. Mirrors Codex's own
 * placeholder handling: `$ARGUMENTS` (or `$@`) → all args; `$1`..`$9` →
 * positional words. Frontmatter is stripped. If no placeholder is present, the
 * args are appended on a new line so a prompt without placeholders still
 * receives them.
 */
export function loadPromptContent(info: PromptInfo, args: string): string {
  let content: string;
  try {
    content = readFileSync(info.path, 'utf-8');
  } catch {
    return args ? `${info.name}: ${args}` : info.name;
  }
  const fm = content.match(/^---\n[\s\S]*?\n---\n?/);
  let body = fm ? content.slice(fm[0].length) : content;

  const positional = args.split(/\s+/).filter(Boolean);
  const hasPlaceholder = /\$ARGUMENTS|\$@|\$\d/.test(body);
  body = body
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$@/g, args)
    // Match the full run of digits so `$10` is positional 10, not `$1` + "0".
    .replace(/\$(\d+)/g, (_m, d) => positional[Number(d) - 1] ?? '');

  if (!hasPlaceholder && args) body = `${body.trimEnd()}\n\n${args}`;
  return body.trim();
}
