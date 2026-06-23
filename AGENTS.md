# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, …) working in this repository.

## What this is

A bridge that lets you chat with the local `codex` CLI from WeChat. A Node/TypeScript
daemon long-polls Tencent's ilink Bot API, forwards WeChat messages to a spawned
`codex exec` process, parses its `--json` event stream, and pushes replies back.

Ported from [`dizhu/wechat-claude-code`](https://github.com/dizhu/wechat-claude-code)
(a security-hardened, multi-user WeChat ↔ Claude Code bridge): the WeChat transport,
multi-bot/multi-user model, and security hardening are unchanged — only the CLI driver
layer was swapped from `claude` to `codex` (`src/codex/`).

## Commands

- `npm run build` — compile TS → `dist/` (tsc). Run after every source edit.
- `npm run daemon -- start|stop|restart|status|logs` — manage the launchd/systemd daemon.
  Use `restart` after `npm run build` to load changes.
- `npm run setup` — QR-bind a WeChat account (each run binds one more bot).
- `npm test` — **no real tests exist**. Verify changes by `build` + smoke-testing the
  provider, or `restart` + reading logs.

There is no lint step and no unit-test suite. The compiler (`strict: true`) is the only gate.

## Architecture

Message flow: `WeChat → ilink Bot API → daemon (long-poll) → spawn codex exec → parse --json → push back`.

- `src/main.ts` — entrypoint. `runDaemon()` loads **all** accounts and starts one
  `createBotMonitor(account)` per bot; `handleMessage` / `sendToCodex` do the per-message work.
- `src/wechat/` — `monitor.ts` (long-poll loop, per-bot), `api.ts` (WeChatApi + `isTrustedWechatUrl`),
  `send.ts`, `media.ts`, `upload.ts`, `accounts.ts` (`loadAllAccounts`), `sync-buf.ts` (per-bot cursor),
  `login.ts`, `crypto.ts`.
- `src/codex/provider.ts` — spawns `codex exec` / `codex exec resume`, parses the `--json`
  JSONL event stream, handles abort/timeout. Public surface (`codexQuery`, `QueryOptions`,
  `QueryResult`) is intentionally identical to the original Claude provider so `main.ts` is unchanged.
- `src/codex/prompt-scanner.ts` — scans `$CODEX_HOME/prompts/*.md` (default `~/.codex/prompts`)
  for custom prompts, the Codex analog of Claude skills. Powers `/prompts` and `/<name>`.
- `src/session.ts` / `src/store.ts` — per-user session persistence (JSON files). `sdkSessionId`
  stores the Codex `thread_id` used for `codex exec resume`.
- `src/commands/` — slash-command routing (`/clear`, `/stop`, `/prompt`, `/cwd`, `/prompts`, …).
- `src/config.ts` — global config (`~/.wechat-codex-code/config.json`).

Data lives in `~/.wechat-codex-code/`: `accounts/` (one `<accountId>.json` per bot),
`sessions/` (`<accountId>__<user>.json`), `sync/` (one cursor per bot), `config.json`, `logs/`.
Codex's own transcripts live in `~/.codex/sessions/` (managed by the `codex` CLI).

## How the Codex provider maps to the CLI

- Fresh turn: `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [--model M] [--image P]... -`
  with the prompt on stdin; spawn `cwd` = the user's working directory (Codex's workspace root).
- Resume: `codex exec resume <thread_id> ...same flags... -`. `exec resume` does NOT accept `-C/--cd`,
  so the working dir is always set via the spawned process `cwd`, never a flag.
- Events parsed from `--json`: `thread.started.thread_id` → sessionId; `item.*` with
  `item.type === 'agent_message'` → streamed/returned text (delta-tracked via `streamedLen`);
  `turn.failed`/`error` → error. `reasoning` and tool/command items are NOT pushed to WeChat by
  default (set `WCX_SHOW_COMMANDS=1` to surface command-execution progress).
- No `--append-system-prompt` exists in Codex, so the system prompt is prepended to the prompt
  only on a fresh thread (a resumed thread already carries it).

## Multi-user / multi-bot model

ilink bots are **1:1** — one bot per WeChat user; you cannot add others to one bot. So
"multiple members" = **one daemon serving N bots**, each member binding their own. The daemon
runs one monitor per bot; everything is keyed per user inside each bot.

## Invariants — do not break these

- **Per-bot sync cursor** (`sync-buf.ts`): the long-poll cursor is bot-specific (encodes the bot
  id). It MUST be keyed by `accountId`. A single shared cursor file makes bots clobber each other.
- **Session keys** (`main.ts` `sessionKeyFor`): `accountId__` + (`r_<userId>` if charset-safe, else
  `b_<base64url>`). The `r_`/`b_` prefixes keep the two namespaces disjoint — keep them or two users
  can collide onto one session.
- **`drainQueue` ordering** (`main.ts`): set `rt.processing = false` BEFORE the queue re-check in
  `finally`. The re-enter guard at the top is what prevents double-processing.
- **`/stop` abort** (`provider.ts` + `main.ts`): abort resolves with `aborted: true` (not a throw);
  `sendToCodex` must early-return on `result.aborted` (incl. after the resume retry) so partial
  output isn't sent and the aborted session id isn't persisted.
- **Per-bot crash isolation** (`runResilient` in `main.ts`): one bot's monitor crashing must not
  bring down the others.
- **Fail-closed startup**: accounts missing `userId`, or with an invalid `accountId`, are skipped —
  never run a bot wide open.
- **Security guards**: `media.ts` basename+containment (path traversal), `isTrustedWechatUrl` on
  every server-supplied URL, SIGTERM→SIGKILL escalation in `provider.ts`, auto-push files confined
  to the session cwd and never the data dir. Don't weaken these.

## Security context

`codex` runs with `--dangerously-bypass-approvals-and-sandbox` (full command execution, no
sandbox) — an accepted decision, because the WeChat side cannot answer approval prompts.
**Messaging a bot ≈ running arbitrary commands on the host.** Sender authorization
(owner-only per bot, by `from_user_id`) is therefore the load-bearing defense; don't weaken it.
Never log bot tokens or AES keys (the logger redacts `*token`/`*secret`/`aes_key`; don't bypass it).

## Conventions

- TypeScript ESM, `.js` import suffixes, `strict: true`, no extra deps beyond `qrcode`/`qrcode-terminal`.
- Match the existing terse style; comments explain *why* (constraints/invariants), not *what*.
- After editing source: `npm run build` then `npm run daemon -- restart`, then check
  `~/.wechat-codex-code/logs/bridge-<date>.log`.
