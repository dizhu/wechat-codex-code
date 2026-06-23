import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when a content block ends — use to flush buffered text. */
  onBlockEnd?: () => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
  /** Set when the query was cancelled via abort (e.g. /stop), not a normal finish. */
  aborted?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = join(tmpdir(), 'wechat-codex-code');

// Push every shell command Codex runs as a live progress line to WeChat. Off by
// default: Codex can run dozens of commands per turn and each would be its own
// WeChat message (and hit server-side rate limits). The typing indicator and the
// 5-minute silence reassurance already signal liveness; set WCX_SHOW_COMMANDS=1
// to opt in to per-command progress.
const SHOW_COMMANDS = process.env.WCX_SHOW_COMMANDS === '1';

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function codexQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onBlockEnd,
    abortController,
  } = options;

  logger.info("Starting Codex CLI query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Codex has no `--append-system-prompt`. A resumed thread already carries the
  // system prompt from when it was created, so only inject it on a fresh thread,
  // as a leading block above the user's message.
  let fullPrompt = prompt;
  if (systemPrompt && !resume) {
    fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
  }

  // Save inbound images to temp files; Codex attaches them natively via `-i`.
  const tempImagePaths = images?.length ? saveImageTemp(images) : [];

  // Build CLI arguments.
  //   fresh:  codex exec [common] -
  //   resume: codex exec resume <id> [common] -
  // `-` makes Codex read the prompt from stdin (avoids arg-length limits and
  // shell-quoting pitfalls). The working directory comes from the spawned
  // process cwd, which Codex uses as its workspace root (no `-C` needed, and
  // `exec resume` does not accept `-C`).
  const common: string[] = [
    '--json',
    '--skip-git-repo-check',
  ];
  // Sandbox policy. Default keeps the historical behavior — full access, no
  // approvals — which is what a remote coding agent typically needs and what
  // existing setups rely on. A security-conscious operator can set WCX_SANDBOX
  // to a real codex sandbox mode to confine Codex (the opt-out for the
  // "unsandboxed RCE if an authorized/injected message drives Codex" risk).
  // --ask-for-approval never is required: there is no interactive terminal over
  // WeChat, so any approval prompt would hang the query.
  const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
  const sandboxMode = process.env.WCX_SANDBOX;
  if (sandboxMode && SANDBOX_MODES.includes(sandboxMode)) {
    common.push('--sandbox', sandboxMode, '--ask-for-approval', 'never');
  } else {
    if (sandboxMode) {
      logger.warn('Ignoring invalid WCX_SANDBOX; falling back to bypass mode', {
        value: sandboxMode,
        validModes: SANDBOX_MODES,
      });
    }
    common.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (model) common.push('--model', model);
  for (const p of tempImagePaths) common.push('--image', p);

  const args: string[] = resume
    ? ['exec', 'resume', resume, ...common, '-']
    : ['exec', ...common, '-'];

  // Accumulators
  let sessionId = '';
  const textParts: string[] = [];
  let errorMessage: string | undefined;
  let child: ChildProcess | undefined;
  let settled = false;
  let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;
  const KILL_GRACE_MS = 5000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      resolve(result);
    };

    // Terminate the child gracefully, then force-kill if it ignores SIGTERM so
    // an unresponsive codex process can't linger as a zombie after timeout/abort.
    const terminateChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killGraceTimer = setTimeout(() => {
        try {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      killGraceTimer.unref?.();
    };

    // If /stop already fired before this query started, bail immediately. The
    // resume-retry path reuses a single AbortController across two codexQuery
    // calls; addEventListener('abort', …) below would NOT fire on a signal that
    // is already in the aborted state, so the query would otherwise run to
    // completion past the stop. Finish as aborted without spawning anything.
    if (abortController?.signal.aborted) {
      finish({ text: '', sessionId, aborted: true });
      return;
    }

    try {
      child = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn codex: ${msg}` });
      return;
    }

    // Write prompt to stdin and close. The child may close stdin before we
    // finish writing (e.g. it exits immediately on a bad flag / version
    // mismatch), which fires an async 'error' (EPIPE) on the stdin stream. With
    // no listener that becomes an uncaught exception that crashes the daemon, so
    // handle it here — the real failure still surfaces via stderr and the
    // 'close' handler below.
    child.stdin!.on('error', (err: Error) => {
      logger.warn('codex stdin error (ignored)', { error: err.message });
    });
    try {
      child.stdin!.write(fullPrompt);
      child.stdin!.end();
    } catch (err: unknown) {
      logger.warn('Failed to write prompt to codex stdin', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Codex CLI query timed out, killing process');
      terminateChild();
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Codex query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Codex CLI query aborted');
      terminateChild();
      const partialText = textParts.join('\n').trim();
      finish({ text: partialText, sessionId, aborted: true });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse JSONL events from stdout.
    //
    // Codex `--json` event shapes:
    //   {"type":"thread.started","thread_id":"<uuid>"}
    //   {"type":"turn.started"}
    //   {"type":"item.started"|"item.updated"|"item.completed","item":{id,type,...}}
    //   {"type":"turn.completed","usage":{...}}
    //   {"type":"turn.failed","error":{message}}  /  {"type":"error","message":...}
    //
    // item.type values include: agent_message (assistant prose), reasoning,
    // command_execution, file_change, mcp_tool_call, web_search, todo_list, error.
    //
    // `streamedLen` tracks how much of each agent_message has been forwarded so we
    // emit only deltas — works whether Codex streams via item.updated or delivers
    // the whole message once at item.completed. `pushedIds` dedupes the canonical
    // text appended to `textParts` (the stored/returned reply).
    const streamedLen = new Map<string, number>();
    const pushedIds = new Set<string>();
    let commandNotes = 0;
    const MAX_COMMAND_NOTES = 20;

    const emit = (text: string) => {
      if (text && onText) Promise.resolve(onText(text)).catch(() => {});
    };

    const handleAgentMessage = (item: any, completed: boolean) => {
      const id: string = item.id ?? `anon-${textParts.length}`;
      const text: string = typeof item.text === 'string' ? item.text : '';
      const prev = streamedLen.get(id) ?? 0;
      if (text.length > prev) {
        emit(text.slice(prev));
        streamedLen.set(id, text.length);
      }
      if (completed && !pushedIds.has(id)) {
        pushedIds.add(id);
        if (text) textParts.push(text);
        if (onBlockEnd) Promise.resolve(onBlockEnd()).catch(() => {});
      }
    };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // Skip unparseable lines (banners, partial writes)
        return;
      }

      switch (obj.type) {
        case 'thread.started': {
          if (obj.thread_id) sessionId = obj.thread_id;
          break;
        }
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = obj.item;
          if (!item) break;
          const completed = obj.type === 'item.completed';
          switch (item.type) {
            case 'agent_message':
              handleAgentMessage(item, completed);
              break;
            case 'command_execution':
              // Live progress is opt-in (see SHOW_COMMANDS) to avoid flooding
              // WeChat — emit only once per command, at start.
              if (SHOW_COMMANDS && obj.type === 'item.started' && commandNotes < MAX_COMMAND_NOTES) {
                const cmd = typeof item.command === 'string' ? item.command : '';
                if (cmd) {
                  emit(`\n\n🔧 \`${cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd}\`\n\n`);
                  commandNotes++;
                }
              }
              break;
            case 'error':
              if (completed && typeof item.message === 'string') {
                errorMessage = item.message;
                logger.error('Codex item error', { message: item.message });
              }
              break;
            // reasoning / file_change / mcp_tool_call / web_search / todo_list:
            // intentionally not pushed to WeChat (noise / "消息不刷屏").
            default:
              break;
          }
          break;
        }
        case 'turn.completed': {
          if (obj.usage) {
            logger.info('Codex turn completed', { usage: obj.usage });
          }
          break;
        }
        case 'turn.failed': {
          const msg = obj.error?.message ?? 'Codex turn failed';
          errorMessage = String(msg);
          logger.error('Codex turn failed', { error: msg });
          break;
        }
        case 'error': {
          const msg = obj.message ?? 'Codex error';
          errorMessage = String(msg);
          logger.error('Codex stream error', { error: msg });
          break;
        }
        default:
          break;
      }
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !textParts.length && !errorMessage) {
        const stderr = stderrParts.join('').trim();
        errorMessage = stderr || `codex exited with code ${code}`;
        logger.error('Codex CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = textParts.join('\n').trim();

      if (!fullText && !errorMessage) {
        errorMessage = 'Codex returned an empty response.';
      }

      logger.info("Codex CLI query completed", {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
      });

      finish({
        text: fullText,
        sessionId,
        error: errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId, error: `Failed to spawn codex: ${err.message}` });
    });
  });
}
