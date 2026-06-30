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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Set to the morelevels production URL at deploy. Localhost is the dev default.
const DEFAULT_API_URL = 'http://localhost:8787';
const PROTOCOL_VERSION = '2025-06-18';

// ---- the allowlist (mirrors morelevels packages/core/src/schemas.ts) ----
const BOOL_SIGNALS = [
  'hasClaudeMd',
  'hasStructuredMemory',
  'memoryReferencedInClaudeMd',
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
  // allowlist only — nothing outside { level, signals, os } reaches the wire (THE LINE)
  return { level, signals, os: input.os };
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
        hasStructuredMemory: { type: 'boolean' },
        memoryReferencedInClaudeMd: { type: 'boolean' },
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
  },
};

const TOOLS = [
  {
    name: 'morelevels_submit',
    description:
      'Submit a Claude Code level assessment to the morelevels dashboard. Send ONLY the integer ' +
      'level, the allowlisted signals, and the os tag — never file contents, paths, env values, ' +
      'or repo names. Returns the server-re-derived level and a `corrected` flag. If it errors ' +
      'with NO_TOKEN or UNAUTHORIZED, ask the user for their token and call morelevels_save_config.',
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
    hasStructuredMemory: true,
    memoryReferencedInClaudeMd: true,
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
  const tmp = join(process.env.TMPDIR || '/tmp', `morelevels-selftest-${process.pid}.json`);
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
