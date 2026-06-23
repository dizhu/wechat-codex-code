import type { Session } from '../session.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handlePrompts, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  /** Containment root for /cwd: non-owner users are confined here; undefined = unrestricted (owner). */
  cwdRoot?: string;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  codexPrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /prompts  - List Codex custom prompts (~/.codex/prompts)
 *   /<prompt> - Invoke a custom prompt by name (args are forwarded to Codex)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'prompts':
    case 'skills': // 兼容旧叫法
      return handlePrompts(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'send':
      return handleSend(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
