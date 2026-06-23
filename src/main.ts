import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadAllAccounts, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, sleep, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { codexQuery, type QueryOptions } from './codex/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR, DEFAULT_WORKING_DIR, SILENCE_MESSAGES, expandTilde } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

// Extensions eligible for auto-push when detected in Codex's response
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Codex's response text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths (macOS/Linux), tilde paths, and Windows paths with a file extension
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = expandTilde(raw);
    paths.push(resolved);
  }
  return paths;
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'CodexCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const accounts = loadAllAccounts();

  if (accounts.length === 0) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  // Fail closed per account: a bot with no bound owner would authorize every
  // sender, so skip it rather than run that bot wide open. Also validate the
  // accountId up front — it is used as a path component (sync cursor, session
  // keys); an invalid one would otherwise throw mid-poll and hot-restart.
  const usable = accounts.filter((a) => {
    if (!a.userId) {
      console.error(`账号 ${a.accountId} 缺少绑定用户 (userId)，已跳过。请重新 setup 绑定。`);
      return false;
    }
    if (!/^[a-zA-Z0-9_.@=-]+$/.test(a.accountId)) {
      console.error(`账号 id 非法（含特殊字符），已跳过: ${a.accountId}`);
      return false;
    }
    return true;
  });
  if (usable.length === 0) process.exit(1);

  const sessionStore = createSessionStore();
  const monitors = usable.map((account) => createBotMonitor(account, sessionStore, config));

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    for (const m of monitors) m.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { bots: usable.length });
  console.log(`已启动 (${usable.length} 个 bot: ${usable.map((a) => a.accountId).join(', ')})`);

  // Isolate failures: if one bot's polling loop throws, restart just that bot
  // after a short delay instead of letting Promise.all bring down every bot.
  async function runResilient(m: ReturnType<typeof createMonitor>, label: string): Promise<void> {
    while (true) {
      try {
        await m.run();
        return; // clean stop()
      } catch (err) {
        logger.error('Bot monitor crashed, restarting in 10s', { label, error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }
  await Promise.all(monitors.map((m, i) => runResilient(m, usable[i].accountId)));
}

/**
 * Set up one bot's polling loop. Each ilink bot is 1:1 with its bound WeChat
 * user, so one of these runs per employee. All bots share the machine and the
 * session store but keep isolated per-user runtimes and abort controllers.
 * Returns the monitor; the caller runs and stops it.
 */
function createBotMonitor(
  account: AccountData,
  sessionStore: ReturnType<typeof createSessionStore>,
  config: ReturnType<typeof loadConfig>,
): ReturnType<typeof createMonitor> {
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sender = createSender(api, account.accountId);

  // Abort controllers keyed by from_user_id (one in-flight query per user).
  const activeControllers = new Map<string, AbortController>();

  // Per-user runtime: isolated session, queue, and processing flag so different
  // senders on this bot run concurrently; each user's own messages stay serial.
  interface UserRuntime {
    session: Session;
    queue: WeixinMessage[];
    processing: boolean;
  }
  const runtimes = new Map<string, UserRuntime>();

  const owner = account.userId;
  const baseDir = expandTilde(config.workingDirectory || process.cwd());

  /**
   * Session-store key namespacing a user's state under this bot. userIds with
   * characters outside the store's allowed set are base64url-encoded so the key
   * never throws validation. Both branches carry a distinct prefix (`r_` raw,
   * `b_` encoded) so the two namespaces are disjoint by construction — a raw id
   * can never collide with the encoding of a different id.
   */
  function sessionKeyFor(userId: string): string {
    const safeUserId = /^[a-zA-Z0-9_.@=-]+$/.test(userId)
      ? `r_${userId}`
      : `b_${Buffer.from(userId).toString('base64url')}`;
    return `${account.accountId}__${safeUserId}`;
  }

  /** Filesystem-safe short id for a per-user working directory. */
  function shortId(userId: string): string {
    return userId.replace(/@.*$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'user';
  }

  /** Owner is always allowed; everyone else must be in the config allowlist. */
  function isAuthorized(userId: string): boolean {
    if (userId === owner) return true;
    return (config.authorizedUsers ?? []).includes(userId);
  }

  /** Lazily create/restore an isolated runtime for a user on first contact. */
  function getRuntime(userId: string): UserRuntime {
    const existing = runtimes.get(userId);
    if (existing) return existing;

    const key = sessionKeyFor(userId);
    const session = sessionStore.load(key);

    // First sighting of this user: give them their own working directory so
    // employees don't clobber each other's files at the cwd level. Done once
    // (guarded by workspaceInitialized) so a later /cwd back to the default is
    // not silently relocated on the next restart.
    // Deterministic from userId+baseDir; recorded every load so existing
    // sessions (pre-dating this field) also get a containment root for /cwd.
    session.workspaceRoot = join(baseDir, shortId(userId));
    if (!session.workspaceInitialized) {
      if (!session.workingDirectory
        || session.workingDirectory === process.cwd()
        || session.workingDirectory === DEFAULT_WORKING_DIR) {
        session.workingDirectory = session.workspaceRoot;
      }
      session.workspaceInitialized = true;
    }
    try { mkdirSync(session.workingDirectory, { recursive: true }); } catch { /* best effort */ }

    // Reset stale non-idle state left over from a crash.
    if (session.state !== 'idle') {
      logger.warn('Resetting stale session state on startup', { userId, state: session.state });
      session.state = 'idle';
    }
    sessionStore.save(key, session);

    const rt: UserRuntime = { session, queue: [], processing: false };
    runtimes.set(userId, rt);
    return rt;
  }

  async function drainQueue(userId: string): Promise<void> {
    const rt = getRuntime(userId);
    if (rt.processing) return;
    rt.processing = true;
    try {
      while (rt.queue.length > 0) {
        const msg = rt.queue.shift()!;
        await handleMessage(msg, account, sessionKeyFor(userId), rt.session, sessionStore, sender, config, activeControllers);
      }
    } finally {
      // INVARIANT: clear `processing` BEFORE the queue check below. The re-enter
      // guard at the top of drainQueue (`if (rt.processing) return`) is what
      // prevents double-processing when a concurrent onMessage re-enters here —
      // reordering these two lines would reintroduce that race.
      rt.processing = false;
      // If a handler threw (or a message arrived during the final await), make
      // sure remaining messages aren't stranded until the user sends another.
      if (rt.queue.length > 0) drainQueue(userId).catch(() => { /* logged downstream */ });
    }
  }

  /** Handle /stop immediately, bypassing the per-user serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list || !msg.from_user_id) return false;
    const userId = msg.from_user_id;
    if (!isAuthorized(userId)) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop')) return false;

    const rt = getRuntime(userId);
    const ctrl = activeControllers.get(userId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(userId); }
    rt.queue.length = 0;
    rt.session.state = 'idle';
    sessionStore.save(sessionKeyFor(userId), rt.session);
    sender.sendText(userId, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      const userId = msg.from_user_id;
      if (msg.message_type !== MessageType.USER || !userId) return;
      if (!isAuthorized(userId)) {
        // Log the id so the owner can add it to config.authorizedUsers; stay
        // silent to the sender (no reflected replies to unauthorized users).
        logger.warn('Dropped message from unauthorized sender', { botId: account.accountId, userId });
        return;
      }
      if (handlePriorityCommand(msg)) return;
      getRuntime(userId).queue.push(msg);
      drainQueue(userId);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...', { botId: account.accountId });
      console.error(`⚠️ 微信会话已过期 (${account.accountId})，请重新运行 setup 扫码绑定`);
    },
  };

  return createMonitor(api, callbacks, account.accountId);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  sessionKey: string,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Filter: only user messages with required fields. (Authorization is enforced
  // upstream in the monitor callback before the message is ever queued.)
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  // Drop non-command messages while processing (priority commands already handled upstream)
  if (session.state === 'processing' && !userText.startsWith('/')) {
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(sessionKey, session);
    };

    const ctx: CommandContext = {
      accountId: sessionKey,
      session,
      // Owner (the bot's bound WeChat id) may /cwd anywhere on their own machine;
      // additional authorized users are confined to their workspace root.
      cwdRoot: fromUserId === account.userId ? undefined : session.workspaceRoot,
      updateSession,
      clearSession: () => {
        const cleared = sessionStore.clear(sessionKey, session);
        Object.assign(session, cleared);
        return session;
      },
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.codexPrompt) {
      await sendToCodex(
        result.codexPrompt, imageItem, fileItem, fromUserId, contextToken,
        account, sessionKey, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Codex --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToCodex(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, sessionKey, session, sessionStore, sender, config, activeControllers,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToCodex(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  sessionKey: string,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(sessionKey, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(fromUserId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    const MIN_BATCH_FLUSH_LEN = 30;
    const SOFT_FLUSH_LIMIT = 3800;

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition:
      // new deltas can arrive while the chain awaits sendText,
      // causing the async callback to clear content it never captured.
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
        anySent = true;
        lastSentTime = Date.now();
      }).catch((err) => {
        logger.error('flushText send failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: expandTilde(session.workingDirectory || config.workingDirectory),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        session.systemPrompt ?? config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: async (delta: string) => {
        textBuffer += delta;

        // Flush at structural boundaries (only if buffer is substantial) or when approaching size limit
        const shouldFlush =
          (endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN)
          || textBuffer.length > SOFT_FLUSH_LIMIT;

        if (shouldFlush) {
          await flushText();
        }
      },
      onBlockEnd: () => {
        if (textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN || textBuffer.length > SOFT_FLUSH_LIMIT) {
          flushText();
        }
      },
    };

    let result = await codexQuery(queryOptions);

    // Cancelled via /stop: leave the session as the priority handler set it
    // (idle, queue cleared) and don't send partial output or persist the
    // aborted run's session id. The flush timer is cleared in finally.
    if (result.aborted) {
      logger.info('Query aborted by /stop, discarding partial result');
      return;
    }

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(sessionKey, session);
      const retryResult = await codexQuery(queryOptions);
      // Prefer the retry's output, but fall back to the first attempt's partial
      // text / session id so an early-failing retry (empty text, no session id)
      // doesn't discard content the first attempt already produced.
      result = {
        ...retryResult,
        text: retryResult.text || result.text,
        sessionId: retryResult.sessionId || result.sessionId,
      };
      // The retry can also be aborted by /stop — re-check after merging.
      if (result.aborted) {
        logger.info('Query aborted by /stop during retry, discarding partial result');
        return;
      }
    }

    // Stop periodic flush and send any remaining buffered content
    clearInterval(flushTimer);
    await flushText();

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Codex query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Codex query error', { error: result.error });
      // Surface the actual error (truncated) instead of a generic message — the
      // most common first-run failures (codex not on PATH, auth failure) are
      // otherwise invisible from the phone and only visible in the daemon log.
      const detail = String(result.error).slice(0, 300);
      await sender.sendText(fromUserId, contextToken, `Codex 处理请求时出错：${detail}`);
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Codex 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(sessionKey, session);

    // Auto-push deliverable files mentioned in Codex's response. Skip entirely
    // if /stop already fired — otherwise files keep flooding WeChat for up to
    // ~90s of retry sleeps after the user explicitly cancelled.
    if (result.text && !abortController.signal.aborted) {
      const cwd = expandTilde(session.workingDirectory || config.workingDirectory);
      const detectedPaths = extractFilePathsFromText(result.text, cwd);
      const { existsSync, realpathSync } = await import('node:fs');
      const { extname, resolve, sep } = await import('node:path');
      // Canonicalize (resolve symlinks) on both sides so the prefix compare is
      // consistent — non-owner cwd is stored as a realpath, and macOS dirs like
      // /tmp are symlinks, so a plain resolve() would mismatch and drop files.
      const canon = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
      const cwdReal = canon(cwd);
      const dataDirReal = canon(DATA_DIR);
      const pushable = detectedPaths.filter(f => {
        const ext = extname(f).toLowerCase();
        if (!AUTO_PUSH_EXTENSIONS.has(ext) || !existsSync(f)) return false;
        const fr = canon(f);
        // Only auto-push files inside the session's working directory, and never
        // the daemon's own data/credential store — otherwise merely mentioning a
        // path (e.g. another bot's account token) would exfiltrate it to whoever
        // is chatting. The detector matches any absolute path in the response.
        const inCwd = fr === cwdReal || fr.startsWith(cwdReal + sep);
        const inDataDir = fr === dataDirReal || fr.startsWith(dataDirReal + sep);
        return inCwd && !inDataDir;
      });
      if (pushable.length > 0) {
        const failedFiles: string[] = [];
        for (const filePath of pushable) {
          if (abortController.signal.aborted) break;
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch {
            failedFiles.push(filePath);
          }
        }
        if (failedFiles.length > 0 && !abortController.signal.aborted) {
          // Server-side rate limit requires longer cooldown (observed ret:-2 even after 9s backoff)
          for (let attempt = 0; attempt < 3; attempt++) {
            const delay = (attempt + 1) * 15_000;
            logger.warn(`Rate-limited, retrying ${failedFiles.length} file(s) in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
            // Interruptible: a /stop during the cooldown cancels the remaining retries.
            await sleep(delay, abortController.signal);
            if (abortController.signal.aborted) break;
            const stillFailed: string[] = [];
            for (const filePath of failedFiles) {
              try {
                await sender.sendFile(fromUserId, contextToken, filePath);
              } catch {
                stillFailed.push(filePath);
              }
            }
            if (stillFailed.length === 0) break;
            failedFiles.length = 0;
            failedFiles.push(...stillFailed);
          }
          if (failedFiles.length > 0) {
            logger.error('File delivery failed after all retries', { files: failedFiles });
            await sender.sendText(fromUserId, contextToken, `文件推送失败（服务端限频），请稍后重试。`).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Codex query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToCodex', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(sessionKey, session);
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(fromUserId) === abortController) {
      activeControllers.delete(fromUserId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
