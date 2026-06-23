import type { CommandContext, CommandResult } from './router.js';
import { scanAllPrompts, findPrompt, loadPromptContent, type PromptInfo } from '../codex/prompt-scanner.js';
import { loadConfig } from '../config.js';
import { DEFAULT_WORKING_DIR, expandTilde } from '../constants.js';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /clear            清除当前会话
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /compact          压缩上下文（开始新 Codex 会话，保留历史）
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Codex 模型
  /prompt [内容]    查看或设置系统提示词（仅对你自己生效）

其他：
  /prompts [full]   列出 Codex 自定义 prompt（full 显示描述）
  /version          查看版本信息
  /<prompt> [参数]  触发 ~/.codex/prompts 下的自定义 prompt

直接输入文字即可与 Codex 对话`;

// 缓存 prompt 列表，避免每次命令都扫描文件系统
let cachedPrompts: PromptInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getPrompts(): PromptInfo[] {
  const now = Date.now();
  if (!cachedPrompts || now - lastScanTime > CACHE_TTL) {
    cachedPrompts = scanAllPrompts();
    lastScanTime = now;
  }
  return cachedPrompts;
}

/** 清除缓存，用于 /prompts 命令强制刷新 */
export function invalidatePromptCache(): void {
  cachedPrompts = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  // Expand a leading ~ and resolve relative paths against the current cwd.
  const resolved = resolve(ctx.session.workingDirectory, expandTilde(args));

  // Must be an existing directory — validate before confirming (mirrors /send;
  // avoids storing a bad cwd that only fails on the next message).
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { reply: `❌ 目录不存在或不是文件夹: ${resolved}`, handled: true };
  }

  // Non-owner users are confined to their workspace root (fail-closed on any
  // resolution error); the owner (cwdRoot undefined) may switch anywhere.
  if (ctx.cwdRoot) {
    try {
      const root = realpathSync(ctx.cwdRoot);
      const real = realpathSync(resolved);
      if (real !== root && !real.startsWith(root + sep)) {
        return { reply: '❌ 无权切换到工作区以外的目录。', handled: true };
      }
      ctx.updateSession({ workingDirectory: real });
      return { reply: `✅ 工作目录已切换为: ${real}`, handled: true };
    } catch {
      return { reply: '❌ 无法校验目录，已拒绝切换。', handled: true };
    }
  }

  ctx.updateSession({ workingDirectory: resolved });
  return { reply: `✅ 工作目录已切换为: ${resolved}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model gpt-5-codex', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `会话ID: ${s.sdkSessionId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handlePrompts(args: string): CommandResult {
  invalidatePromptCache();
  const prompts = getPrompts();
  if (prompts.length === 0) {
    return { reply: '未找到自定义 prompt。\n在 ~/.codex/prompts/ 放入 <名称>.md 即可用 /<名称> 调用。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = prompts.map(p => `/${p.name}${p.description ? `\n   ${p.description}` : ''}`);
    return { reply: `📋 Codex 自定义 prompt (${prompts.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = prompts.map(p => `/${p.name}`);
  return { reply: `📋 Codex 自定义 prompt (${prompts.length}):\n\n${lines.join('\n')}\n\n使用 /prompts full 查看完整描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 Codex 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 Codex 会话，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 Codex 会话（token 清零）\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-codex-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-codex-code (version unknown)', handled: true };
  }
}

export function handlePrompt(ctx: CommandContext, args: string): CommandResult {
  // Per-user: store on the session, not the global config, so one user's prompt
  // does not leak into everyone else's Codex. Falls back to the global default.
  const globalDefault = loadConfig().systemPrompt;
  if (!args) {
    const current = ctx.session.systemPrompt ?? globalDefault;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    ctx.updateSession({ systemPrompt: undefined });
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  ctx.updateSession({ systemPrompt: args.trim() });
  return { reply: `✅ 系统提示词已设置:\n${args.trim()}`, handled: true };
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  const resolved = args.startsWith('/')
    ? args
    : resolve(ctx.session.workingDirectory, expandTilde(args));
  if (!existsSync(resolved)) {
    return { reply: `文件不存在: ${resolved}`, handled: true };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { reply: `这是一个目录，请指定文件: ${resolved}`, handled: true };
  }

  if (stat.size > 25 * 1024 * 1024) {
    return { reply: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`, handled: true };
  }

  // Non-owner users may only send files inside their workspace root (fail-closed
  // on any resolution error); the owner (cwdRoot undefined) is unrestricted.
  // Without this, /send <absolute path> would let a non-owner exfiltrate any
  // readable file — e.g. another bot's credential store — mirroring the
  // containment /cwd and auto-push already enforce.
  if (ctx.cwdRoot) {
    try {
      const root = realpathSync(ctx.cwdRoot);
      const real = realpathSync(resolved);
      if (real !== root && !real.startsWith(root + sep)) {
        return { reply: '❌ 无权发送工作区以外的文件。', handled: true };
      }
      return { handled: true, sendFile: real };
    } catch {
      return { reply: '❌ 无法校验文件路径，已拒绝发送。', handled: true };
    }
  }

  return { handled: true, sendFile: resolved };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const prompts = getPrompts();
  const found = findPrompt(prompts, cmd);

  if (found) {
    // Expand the prompt file (with $ARGUMENTS / $1.. substitution) and forward
    // the resulting text to Codex as the message.
    return { handled: true, codexPrompt: loadPromptContent(found, args) };
  }

  return {
    handled: true,
    reply: `未找到自定义 prompt: ${cmd}\n输入 /prompts 查看可用列表`,
  };
}
