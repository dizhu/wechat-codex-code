import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = process.env.WCX_DATA_DIR || join(homedir(), '.wechat-codex-code');

export const DEFAULT_WORKING_DIR = join(homedir(), 'Documents', 'CodexCode');

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * Expand a leading `~` to the home directory, but only when it is bare or
 * followed by a path separator — so `~user` (a different user's home) is left
 * untouched rather than mis-expanded. The single source of truth for tilde
 * handling across the daemon, command handlers and the sender.
 */
export function expandTilde(p: string): string {
  return p.replace(/^~(?=$|\/)/, homedir());
}

/**
 * Keepalive messages sent during long silences while Codex is working. Shared
 * by the daemon (which sends them) and the log viewer (which detects them) so
 * the two can never drift out of sync.
 */
export const SILENCE_MESSAGES = [
  '我还在处理中，这个问题有点复杂，请再稍等一下',
  '正在努力干活中，马上就有结果了，请稍等片刻',
  '有点复杂正在处理，再给我一点时间，很快就好',
  '快好了别着急，正在收尾阶段，马上给你回复',
  '还在跑呢，任务量比较大，不过马上就能出结果了',
  '任务比想象的复杂一些，再等等我，正在全力处理',
  '正在处理中，进展顺利，再等一会儿就好',
  '还没完不过已经快了，再给我一分钟就能搞定',
  '我在认真思考这个问题，请再稍等一会儿',
  '稍微有点棘手，不过已经快解决了，再等我一下',
];
