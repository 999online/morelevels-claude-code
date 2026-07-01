#!/usr/bin/env node
/**
 * morelevels MCP server — the ONLY place the morelevels HTTP API is called.
 *
 * ZERO DEPENDENCIES: speaks the MCP stdio protocol (newline-delimited JSON-RPC 2.0) directly, so
 * `node server.js` works the instant the plugin is installed — no `npm install`, no node_modules,
 * no network. Uses Node 18+ global `fetch`.
 *
 * THE LINE (morelevels compliance.md): the submission carries an integer level + an allowlist of
 * boolean/count signals + an os tag — and NOTHING else. buildSubmitPayload() reconstructs the
 * payload from the allowlist only, so any smuggled field (file content, path, env value, repo
 * name) is dropped here before it can reach the wire. The API also enforces this with zod
 * .strict() (extra field -> 400); this is the client-side half of the same guard.
 *
 * CONFIG (no env vars required — built for non-developers):
 *   token:   MORELEVELS_TOKEN env (dev override) -> ~/.morelevels.json `.token`
 *   apiUrl:  MORELEVELS_API_URL env -> ~/.morelevels.json `.apiUrl` -> DEFAULT_API_URL
 * The config file is read LAZILY on every call, so a token saved mid-session (via
 * morelevels_save_config) takes effect with no Claude Code restart.
 *
 * Tools:
 *   morelevels_submit       POST /submissions  -> { submission, claimedLevel, corrected }
 *   morelevels_my_level     GET  /me/level     -> { current, highest, levelName, history, nextStep }
 *   morelevels_save_config  write ~/.morelevels.json (token + optional apiUrl), mode 0600
 *
 * Self-check: `node server.js --selftest` (no deps) — allowlist strip, range validation,
 * tools/list, initialize shape, and a config round-trip + env-over-file precedence.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Set to the morelevels production URL at deploy. Localhost is the dev default.
const DEFAULT_API_URL = 'https://morelevels-api.999online.workers.dev';
const PROTOCOL_VERSION = '2025-06-18';

// ---- the allowlist (mirrors morelevels packages/core/src/schemas.ts) ----
const BOOL_SIGNALS = [
  'hasClaudeMd',
  'hasManagedMemory',
  'hasContextRouting',
  'hasComplexSkills',
  'hasSubagents',
  'hasHooks',
  'hasHeadlessScripts',
  'hasBrowserAutomation',
  'isMultiAgent',
  'hasScheduledAutomation',
  'hasAgentOrchestration',
];
const COUNT_SIGNALS = ['mcpServerCount', 'customSkillCount'];
const OS_VALUES = ['macos', 'linux', 'windows', 'wsl', 'other'];

// levelDetails: bounded, leak-scanned per-level HTML summaries (mirrors morelevels
// packages/core/src/schemas.ts). Free text re-opens THE LINE, so it is capped + marker-scanned
// here too. Generic model filenames (CLAUDE.md, settings.json…) are fine; paths/secrets/emails/
// env values/scripts are NOT.
const LEVEL_DETAILS_MAX_ENTRIES = 12;
const LEVEL_DETAIL_MAX_LEN = 600;
const LEVEL_KEY_RE = /^(?:10|[0-9])$/;
const LEVEL_DETAILS_FORBIDDEN = [
  /\/Users\/|\/home\//, // unix home path
  /[A-Za-z]:\\/, // windows path
  /sk-|api[_-]?key|secret|bearer|password|-{5}BEGIN/i, // secret / key literal
  /@[\w.-]+\.\w+/, // email address
  /\w+=\w/, // env assignment / raw attribute
  /<script|on\w+\s*=|javascript:/i, // script / event handler / js url
];

/**
 * Validate + strip levelDetails to the bounded, leak-safe shape. Keys must be a level "0".."10",
 * values short HTML with no forbidden marker. Throws on any violation so the model fixes it.
 */
export function buildLevelDetails(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src))
    throw new Error('levelDetails must be an object mapping level "0".."10" to an HTML string');
  const keys = Object.keys(src);
  if (keys.length > LEVEL_DETAILS_MAX_ENTRIES)
    throw new Error(`levelDetails accepts at most ${LEVEL_DETAILS_MAX_ENTRIES} levels`);
  const out = {};
  for (const k of keys) {
    if (!LEVEL_KEY_RE.test(k)) throw new Error(`levelDetails key must be a level 0-10, got "${k}"`);
    const v = src[k];
    if (typeof v !== 'string') throw new Error(`levelDetails["${k}"] must be a string`);
    if (v.length > LEVEL_DETAIL_MAX_LEN)
      throw new Error(`levelDetails["${k}"] exceeds ${LEVEL_DETAIL_MAX_LEN} chars — summarize`);
    if (LEVEL_DETAILS_FORBIDDEN.some((re) => re.test(v)))
      throw new Error(
        `levelDetails["${k}"] contains a forbidden marker (path/secret/email/env/script). ` +
          'Summarize from the signals + level model only — no paths, repo names, env values, or secrets.'
      );
    out[k] = v;
  }
  return out;
}

/**
 * Validate AND strip to the allowlist. Returns ONLY { level, signals, os } — anything else on the
 * input (or on input.signals) is discarded here. Throws on a malformed allowlisted field.
 */
export function buildSubmitPayload(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');

  const level = input.level;
  if (!Number.isInteger(level) || level < 0 || level > 10)
    throw new Error('level must be an integer 0..10');

  if (!OS_VALUES.includes(input.os))
    throw new Error(`os must be one of: ${OS_VALUES.join(', ')}`);

  const src = input.signals && typeof input.signals === 'object' ? input.signals : {};
  const signals = {};
  for (const k of COUNT_SIGNALS) {
    const v = src[k];
    if (!Number.isInteger(v) || v < 0) throw new Error(`signals.${k} must be an integer >= 0`);
    signals[k] = v;
  }
  for (const k of BOOL_SIGNALS) {
    const v = src[k];
    if (typeof v !== 'boolean') throw new Error(`signals.${k} must be a boolean`);
    signals[k] = v;
  }
  // allowlist only — nothing outside { level, signals, os, levelDetails } reaches the wire (THE LINE)
  const payload = { level, signals, os: input.os };
  if (input.levelDetails !== undefined && input.levelDetails !== null)
    payload.levelDetails = buildLevelDetails(input.levelDetails);
  return payload;
}

// ---- config (home-dir JSON file; no env vars required) ----
function configPath() {
  return (process.env.MORELEVELS_CONFIG_PATH || '').trim() || join(homedir(), '.morelevels.json');
}

export function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing/unreadable/invalid file -> no config
  }
}

export function saveConfig({ token, apiUrl }) {
  if (typeof token !== 'string' || token.trim().length < 8)
    throw new Error('token must be a non-empty string (paste the token from your dashboard)');
  const merged = { ...loadConfig() };
  merged.token = token.trim();
  if (typeof apiUrl === 'string' && apiUrl.trim()) merged.apiUrl = apiUrl.trim().replace(/\/$/, '');
  const path = configPath();
  // ponytail: mode 0o600 is a no-op on Windows (POSIX bits ignored; NTFS uses ACLs), so the
  // token file isn't owner-restricted there. Fine for a single token; add icacls if it matters.
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return { saved: true, path };
}

function resolveToken() {
  const env = (process.env.MORELEVELS_TOKEN || '').trim();
  if (env) return env;
  const cfg = loadConfig();
  return typeof cfg.token === 'string' ? cfg.token.trim() : '';
}

function resolveApiUrl() {
  const env = (process.env.MORELEVELS_API_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  const cfg = loadConfig();
  const fromCfg = typeof cfg.apiUrl === 'string' ? cfg.apiUrl.trim() : '';
  return (fromCfg || DEFAULT_API_URL).replace(/\/$/, '');
}

async function api(path, init = {}) {
  const token = resolveToken();
  if (!token) {
    const err = new Error(
      'NO_TOKEN: morelevels needs a one-time token. Mint one from your morelevels dashboard ' +
        '(or POST /dev/mint-token locally), then save it with the morelevels_save_config tool.'
    );
    err.code = 'NO_TOKEN';
    throw err;
  }
  const res = await fetch(resolveApiUrl() + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    const err = new Error(`morelevels ${path} -> ${res.status}: ${detail}`);
    if (res.status === 401) err.code = 'UNAUTHORIZED';
    throw err;
  }
  return body;
}

// ---- tool definitions ----
const SUBMIT_INPUT_SCHEMA = {
  type: 'object',
  required: ['level', 'signals', 'os'],
  additionalProperties: false,
  properties: {
    level: { type: 'integer', minimum: 0, maximum: 10, description: 'Locally computed level 0-10' },
    os: { type: 'string', enum: OS_VALUES },
    signals: {
      type: 'object',
      required: [...COUNT_SIGNALS, ...BOOL_SIGNALS],
      additionalProperties: false,
      properties: {
        hasClaudeMd: { type: 'boolean' },
        mcpServerCount: { type: 'integer', minimum: 0 },
        customSkillCount: { type: 'integer', minimum: 0 },
        hasManagedMemory: { type: 'boolean' },
        hasContextRouting: { type: 'boolean' },
        hasComplexSkills: { type: 'boolean' },
        hasSubagents: { type: 'boolean' },
        hasHooks: { type: 'boolean' },
        hasHeadlessScripts: { type: 'boolean' },
        hasBrowserAutomation: { type: 'boolean' },
        isMultiAgent: { type: 'boolean' },
        hasScheduledAutomation: { type: 'boolean' },
        hasAgentOrchestration: { type: 'boolean' },
      },
    },
    levelDetails: {
      type: 'object',
      description:
        'Optional. Short HTML summaries per level for the dashboard journey tab — keys "0".."10". ' +
        'Cleared levels: what the user HAS (from signals). Next level: the gap + one step. ' +
        'Derive ONLY from the signals + level model. Inline tags only, no attributes. NEVER include ' +
        'file paths, repo/company names, env values, secrets, or file contents (rejected otherwise).',
      additionalProperties: { type: 'string', maxLength: LEVEL_DETAIL_MAX_LEN },
    },
  },
};

const TOOLS = [
  {
    name: 'morelevels_submit',
    description:
      'Submit a Claude Code level assessment to the morelevels dashboard. Send the integer ' +
      'level, the allowlisted signals, the os tag, and OPTIONALLY `levelDetails` (short per-level ' +
      'HTML summaries for the journey tab). Never send file contents, paths, env values, or repo ' +
      'names — not in signals and not in levelDetails. Returns the server-re-derived level and a ' +
      '`corrected` flag. If it errors with NO_TOKEN or UNAUTHORIZED, ask the user for their token ' +
      'and call morelevels_save_config.',
    inputSchema: SUBMIT_INPUT_SCHEMA,
  },
  {
    name: 'morelevels_my_level',
    description:
      "Read the submitter's own level progression from morelevels (current, highest, history, " +
      'next step). No input.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'morelevels_save_config',
    description:
      'Save the morelevels submission token (and optional apiUrl) to ~/.morelevels.json so the ' +
      'user never has to set environment variables. Call this once after the user pastes their ' +
      'token. Takes effect immediately — no restart needed.',
    inputSchema: {
      type: 'object',
      required: ['token'],
      additionalProperties: false,
      properties: {
        token: { type: 'string', description: 'The submission token pasted by the user' },
        apiUrl: { type: 'string', description: 'Optional API base URL override' },
      },
    },
  },
];

// ---- tool execution ----
async function callTool(name, args) {
  if (name === 'morelevels_submit') {
    const payload = buildSubmitPayload(args); // validate + strip to allowlist
    return api('/submissions', { method: 'POST', body: JSON.stringify(payload) });
  }
  if (name === 'morelevels_my_level') {
    return api('/me/level', { method: 'GET' });
  }
  if (name === 'morelevels_save_config') {
    return saveConfig(args || {});
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---- JSON-RPC dispatch (pure; returns a response object, or null for notifications) ----
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'morelevels', version: '0.1.0' },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null; // notification — never reply
    case 'ping':
      return isNotification ? null : rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const data = await callTool(params?.name, params?.arguments);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        // tool errors are returned in-band (isError) so the model can react (e.g. NO_TOKEN)
        const message = e instanceof Error ? e.message : String(e);
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---- stdio transport: newline-delimited JSON-RPC ----
function serve() {
  const rl = createInterface({ input: process.stdin });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return write(rpcError(null, -32700, 'parse error'));
    }
    try {
      const resp = await handleRequest(msg);
      if (resp) write(resp);
    } catch (e) {
      if (msg && msg.id != null) write(rpcError(msg.id, -32603, String(e)));
    }
  });
}

// ---- self-check ----
async function selftest() {
  const assert = (cond, m) => {
    if (!cond) throw new Error(`selftest failed: ${m}`);
  };
  const validSignals = {
    hasClaudeMd: true,
    mcpServerCount: 2,
    customSkillCount: 4,
    hasManagedMemory: true,
    hasContextRouting: true,
    hasComplexSkills: false,
    hasSubagents: false,
    hasHooks: false,
    hasHeadlessScripts: false,
    hasBrowserAutomation: false,
    isMultiAgent: false,
    hasScheduledAutomation: false,
    hasAgentOrchestration: false,
  };

  // allowlist strips smuggled fields
  const out = buildSubmitPayload({
    level: 4,
    os: 'macos',
    signals: { ...validSignals, claudeMdContents: 'SECRET', repoName: 'private-repo' },
    filePath: '/Users/me/.claude.json',
    apiKey: 'sk-leak',
  });
  assert(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['level', 'os', 'signals']), 'top-level keys not allowlisted');
  assert(!('filePath' in out) && !('apiKey' in out), 'smuggled top-level field survived');
  assert(!('claudeMdContents' in out.signals) && !('repoName' in out.signals), 'smuggled signal field survived');
  assert(!('levelDetails' in out), 'levelDetails present when caller sent none');

  // levelDetails: a clean map survives (incl. generic filenames); dirty maps throw
  const withDetails = buildSubmitPayload({
    level: 4,
    os: 'macos',
    signals: validSignals,
    levelDetails: {
      2: '<span>3 MCP servers connected</span>',
      4: 'Next: add <strong>hooks</strong> to settings.json',
    },
  });
  assert(withDetails.levelDetails['2'].includes('MCP'), 'clean levelDetails dropped');
  assert(withDetails.levelDetails['4'].includes('settings.json'), 'generic filename wrongly rejected');
  for (const dirty of [
    { 1: 'see /Users/me/project for details' },
    { 1: 'token sk-abc123def456 leaked' },
    { 1: '<script>alert(1)</script>' },
    { 1: 'ping me at dev@example.com' },
    { 11: 'level key out of range' },
  ]) {
    let bad = false;
    try {
      buildSubmitPayload({ level: 1, os: 'macos', signals: validSignals, levelDetails: dirty });
    } catch {
      bad = true;
    }
    assert(bad, `dirty levelDetails not rejected: ${JSON.stringify(dirty)}`);
  }

  let threw = false;
  try {
    buildSubmitPayload({ level: 11, os: 'macos', signals: validSignals });
  } catch {
    threw = true;
  }
  assert(threw, 'out-of-range level not rejected');

  // JSON-RPC dispatch
  const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert(init.result.serverInfo.name === 'morelevels' && init.result.capabilities.tools, 'initialize result malformed');
  assert((await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null, 'notification got a reply');
  const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['morelevels_my_level', 'morelevels_save_config', 'morelevels_submit']), 'tools/list wrong');
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'no/such' });
  assert(unknown.error && unknown.error.code === -32601, 'unknown method not -32601');

  // config round-trip + precedence (isolated temp path)
  const tmp = join(tmpdir(), `morelevels-selftest-${process.pid}.json`);
  process.env.MORELEVELS_CONFIG_PATH = tmp;
  delete process.env.MORELEVELS_TOKEN;
  delete process.env.MORELEVELS_API_URL;
  saveConfig({ token: 'tok_from_file_123456', apiUrl: 'http://example.test/' });
  assert(resolveToken() === 'tok_from_file_123456', 'token not read from config file');
  assert(resolveApiUrl() === 'http://example.test', 'apiUrl not read/normalized from config file');
  process.env.MORELEVELS_TOKEN = 'tok_from_env_abcdef';
  assert(resolveToken() === 'tok_from_env_abcdef', 'env token did not win over config file');
  try {
    unlinkSync(tmp);
  } catch {
    /* best-effort cleanup */
  }

  console.log('selftest OK — allowlist, range checks, JSON-RPC dispatch, config round-trip + precedence');
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  serve();
}
