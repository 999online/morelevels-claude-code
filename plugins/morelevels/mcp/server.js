#!/usr/bin/env node
/**
 * morelevels MCP server — the ONLY place the morelevels HTTP API is called.
 *
 * THE LINE (morelevels compliance.md): the submission carries an integer level + an allowlist of
 * boolean/count signals + an os tag — and NOTHING else. buildSubmitPayload() reconstructs the
 * payload from the allowlist only, so any smuggled field (file content, path, env value, repo
 * name) is dropped here before it can reach the wire. The API also enforces this with zod
 * .strict() (extra field -> 400); this is the client-side half of the same guard.
 *
 * Config (from env, passed through the plugin .mcp.json):
 *   MORELEVELS_API_URL  default http://localhost:8787
 *   MORELEVELS_TOKEN    Bearer submission token (mint from the dashboard / dev/mint-token)
 *
 * Tools:
 *   morelevels_submit    POST /submissions  -> { submission, claimedLevel, corrected }
 *   morelevels_my_level  GET  /me/level     -> { current, highest, levelName, history, nextStep }
 *
 * Self-check: `node server.js --selftest` asserts the allowlist strips a smuggled field.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

function apiBase() {
  return ((process.env.MORELEVELS_API_URL || '').trim() || 'http://localhost:8787').replace(
    /\/$/,
    ''
  );
}

async function api(path, init = {}) {
  const token = (process.env.MORELEVELS_TOKEN || '').trim();
  if (!token)
    throw new Error(
      'MORELEVELS_TOKEN is not set. Mint a submission token from the morelevels dashboard ' +
        '(or POST /dev/mint-token locally) and export MORELEVELS_TOKEN before starting Claude Code.'
    );
  const res = await fetch(apiBase() + path, {
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
    throw new Error(`morelevels ${path} -> ${res.status}: ${detail}`);
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
      'or repo names. Returns the server-re-derived level and a `corrected` flag.',
    inputSchema: SUBMIT_INPUT_SCHEMA,
  },
  {
    name: 'morelevels_my_level',
    description:
      'Read the submitter\'s own level progression from morelevels (current, highest, history, ' +
      'next step). No input.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function main() {
  const server = new Server(
    { name: 'morelevels', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === 'morelevels_submit') {
        const payload = buildSubmitPayload(args); // validate + strip to allowlist
        return ok(await api('/submissions', { method: 'POST', body: JSON.stringify(payload) }));
      }
      if (name === 'morelevels_my_level') {
        return ok(await api('/me/level', { method: 'GET' }));
      }
      return fail(`unknown tool: ${name}`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  await server.connect(new StdioServerTransport());
}

// ---- self-check: prove the allowlist strips smuggled fields ----
function selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selftest failed: ${msg}`);
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
  const out = buildSubmitPayload({
    level: 4,
    os: 'macos',
    signals: { ...validSignals, claudeMdContents: 'SECRET KEY', repoName: 'private-repo' },
    filePath: '/Users/me/.claude.json',
    apiKey: 'sk-leak',
  });
  assert(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['level', 'os', 'signals']), 'top-level keys not allowlisted');
  assert(!('filePath' in out) && !('apiKey' in out), 'smuggled top-level field survived');
  assert(!('claudeMdContents' in out.signals) && !('repoName' in out.signals), 'smuggled signal field survived');
  assert(out.level === 4 && out.os === 'macos' && out.signals.mcpServerCount === 2, 'allowlisted values mangled');

  let threw = false;
  try {
    buildSubmitPayload({ level: 11, os: 'macos', signals: validSignals });
  } catch {
    threw = true;
  }
  assert(threw, 'out-of-range level not rejected');

  console.log('selftest OK — payload allowlist strips smuggled fields and validates ranges');
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
