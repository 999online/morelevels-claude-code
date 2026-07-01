---
name: morelevels-assess
description: >
  Assess a user's Claude Code setup level (0-10, MIT "10 Levels of Claude Code" model) by scanning
  their environment, map findings to allowlisted signals, compute the level locally, then submit it
  to the morelevels dashboard via the morelevels_submit MCP tool and show the server's re-derived
  level + next step. Use for /morelevels, "what's my Claude Code level", "level up", "morelevels".
---

# morelevels — assess & submit

Scan the environment, determine the Claude Code **setup maturity** level (0-10), submit the
allowlisted signals to morelevels, and report the server's re-derived level and next step.

These levels measure how much the user has *built around* Claude Code, not coding skill. Level 0 is
a bare install; Level 10 (agents managing agents) is rare. Run repeatedly — the assessment updates.

## ⚠️ THE LINE — what may leave this machine

The scan reads the **contents** of `CLAUDE.md`, `.mcp.json`, `~/.claude.json`, and `settings.json`,
which can hold API keys, tokens, repo paths, and source. You submit **ONLY**:

- an integer `level` (0-10),
- the 13 allowlisted **signals** (booleans + two counts) below,
- an `os` tag,
- optionally `levelDetails` — short per-level HTML **summaries** for the dashboard (Phase 3), built
  ONLY from the signals + the level model.

**Never** pass file contents, file paths, env values, repo/company names, or secrets — not in the
signals and **not in `levelDetails`**. The server bounds + leak-scans `levelDetails` (absolute
paths, secrets, emails, env values, and `<script>`/event handlers → 400) and the MCP server rejects
the same, but you must not put them there in the first place. Generic level-model filenames
(`CLAUDE.md`, `.mcp.json`, `settings.json`, `.claude/rules/`) are fine — they describe the model.

---

## Phase 1 — Scan the environment

Scan silently (no per-check permission prompts). Map everything to these 13 signals. When a signal
has OS-specific forms, treat them as equivalent (cross-OS fairness — a Windows setup must never read
as a gap).

| Signal | Type | How to derive it |
| --- | --- | --- |
| `hasClaudeMd` | bool | Any of `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md` exists |
| `mcpServerCount` | int≥0 | Count distinct MCP servers across project `.mcp.json` + `~/.claude.json` `mcpServers` |
| `customSkillCount` | int≥0 | Count entries in `.claude/commands/` + `.claude/skills/` (project and `~/.claude/`) |
| `hasManagedMemory` | bool | Native Auto Memory in use (`~/.claude/projects/<proj>/memory/MEMORY.md` exists with real content, not just an empty scaffold) **OR** a legacy `memory/` directory with real structure |
| `hasContextRouting` | bool | Context is intentionally composed/scoped: CLAUDE.md uses `@import`/`@path`, **OR** `.claude/rules/*.md` exist, **OR** a CLAUDE.md references the memory dir (legacy) |
| `hasComplexSkills` | bool | At least one skill is 80+ lines OR has multi-phase steps / approval gates / tool calls |
| `hasSubagents` | bool | Agent definitions in `.claude/agents/` or `~/.claude/agents/`, or skills that spawn subagents |
| `hasHooks` | bool | Hook configs in `.claude/settings.json` (PreToolUse / PostToolUse / etc.) |
| `hasHeadlessScripts` | bool | Shell scripts calling `claude -p` / `claude --print` (headless/JSON piping) |
| `hasBrowserAutomation` | bool | Playwright / Puppeteer / Chrome integration / a browser MCP in the project |
| `isMultiAgent` | bool | tmux multi-session setups, multiple role-specific CLAUDE.md, or coordinated parallel instances |
| `hasScheduledAutomation` | bool | cron **or** launchd **or** systemd **or** Windows Task Scheduler running Claude on a schedule |
| `hasAgentOrchestration` | bool | Autonomous loops / orchestration frameworks — agents that spawn and manage other agents |

Then detect `os`: macOS → `macos`, Linux → `linux`, Windows → `windows`, WSL → `wsl`, else `other`
(use `uname` / platform; WSL shows Linux + a Microsoft kernel string). `os` is a tag only — it never
changes the level.

You MAY ask the user (optional, for the explanation only, NOT submitted): what they mainly use
Claude Code for, their biggest friction, and the one thing they'd most want to automate.

## Phase 2 — Compute the level locally (contiguous ladder)

The level is the **highest tier whose criteria hold, with every tier below also met** — climb the
ladder, stop at the first gap. (Same rule as the morelevels server, which re-derives independently.)

| Level | Met when |
| --- | --- |
| 1 Grounded | `hasClaudeMd` |
| 2 Connected | `mcpServerCount >= 1` |
| 3 Skilled | `customSkillCount >= 3` |
| 4 Context Architect | `hasManagedMemory && hasContextRouting` |
| 5 System Builder | `hasComplexSkills && hasSubagents && hasHooks` |
| 6 Pipeline Engineer | `hasHeadlessScripts` |
| 7 Browser Commander | `hasBrowserAutomation` |
| 8 Multi-Agent Operator | `isMultiAgent` |
| 9 Always On | `hasScheduledAutomation` |
| 10 Swarm Architect | `hasAgentOrchestration` |

Level 0 = no `CLAUDE.md`. A lone cron job without a CLAUDE.md is **not** Level 9 — the ladder is
contiguous. Lots of simple skills is still Level 3; integration matters more than quantity.

Present the assessment to the user: their level + name, walk bottom-to-top through what you found
for each tier they cleared, then name the first gap and why it matters. Talk like a knowledgeable
friend, not a grading rubric. If `--assess` was passed, still submit (Phase 3) but skip the Phase 4
build offer.

## Phase 3 — Submit to morelevels (replaces the old HTML dashboard)

**First, write `levelDetails`** — short HTML summaries the dashboard shows under each tier in the
journey tab (this is the summarized form of the old per-level HTML). Keys are level numbers as
strings, `"0"`..`"10"`. Cover the tiers the user has cleared plus the next one — skip levels beyond
next (the dashboard shows their default quest text). For each:

- **Cleared level** → *what you have*, from the signals. e.g. `"2": "<span>✓ 3 MCP servers connected</span>"`,
  `"3": "<span>✓ 4 custom skills</span>"`.
- **Next level** → the **gap** (which criteria are missing) + **one** concrete step. e.g.
  `"5": "Have complex skills + subagents; <strong>missing hooks</strong>. Add a PostToolUse hook in settings.json."`

Rules (the server + MCP reject violations): derive **only** from the signals + level model; ≤600
chars per level, ≤12 levels; plain inline tags only (`<span> <strong> <em> <br> <code> <ul> <li>`)
with **no attributes**; **never** file paths, repo/company names, env values, secrets, or file
contents. Generic model filenames (`CLAUDE.md`, `settings.json`…) are fine.

Then call the **`morelevels_submit`** MCP tool:

```json
{ "level": <0-10>, "signals": { ...the 13 signals... }, "os": "<os>", "levelDetails": { "<lvl>": "<html>", ... } }
```

`levelDetails` is optional — omit it only if you truly can't summarize. The tool returns:

```json
{ "submission": { "id", "level", "os", "createdAt" }, "claimedLevel": <n>, "corrected": <bool> }
```

- `submission.level` is the **server's** re-derived level — treat it as authoritative.
- If `corrected` is true, your local level differed from the server's. Explain why in plain terms
  (usually a tier below the claimed level wasn't actually met — the ladder is contiguous).
- Then call **`morelevels_my_level`** and show progression: `current`, `highest`, `levelName`, and
  `nextStep` (what to do to reach the next level). If `nextStep` is null they're at Level 10.

**First run — no token yet?** If `morelevels_submit` returns an error containing `NO_TOKEN` or
`UNAUTHORIZED`, do **not** fail. Run this one-time setup, then retry — no env vars, no restart:

1. Tell the user: "morelevels needs a one-time token. Open your morelevels dashboard, sign in, mint
   a submission token, and paste it here." (Local dev: they can instead run
   `curl -X POST <apiUrl>/dev/mint-token -H 'content-type: application/json' -d '{"email":"you@example.com"}'`
   and paste the `token` from the response.)
2. Take the pasted token and call the **`morelevels_save_config`** MCP tool with
   `{ "token": "<pasted>" }` (add `"apiUrl"` only if they're not on the default). It saves to
   `~/.morelevels.json` (chmod 600) — tell them they won't be asked again.
3. Retry `morelevels_submit` with the same `{ level, signals, os }`. It now reads the saved token.

Never ask the user to set environment variables or edit shell files. If the retry still fails, show
the local assessment so the run isn't wasted and report the exact error.

## Phase 4 — Build the first step (optional)

Unless `--assess` was passed, offer: "Want me to build the first step toward Level N+1 now?" If yes,
do the local action for the next tier (all local, nothing submitted):

- → L1: draft a `CLAUDE.md` for this project.
- → L2: set up the user's first MCP server in `.mcp.json`.
- → L3: create a `.claude/commands/` skill for their most-repeated task.
- → L4: verify native Auto Memory is on (`/memory`; on by default since Claude Code v2.1.59), then add context routing — a `.claude/rules/<scope>.md` scoped rule and/or a CLAUDE.md `@import`. (A legacy `memory/` dir referenced from CLAUDE.md still counts.)
- → L5: add phases + an approval gate (and a subagent call / hook) to their most-used skill.
- → L6: write a `claude -p` headless script for a routine task.
- → L7+: walk them through browser automation / multi-agent / scheduling / orchestration setup.

If `--build` was passed, skip Phases 1-3 and go straight to building (ask which level to target).

---

**Reference — the 10 levels** (name + the quest to reach it):

0 Terminal Tourist · 1 Grounded (add a CLAUDE.md) · 2 Connected (connect an MCP) · 3 Skilled (3+
skills) · 4 Context Architect (managed memory + context routing — Auto Memory / `@imports` / `.claude/rules/`) · 5 System Builder
(multi-phase skill + subagents + hooks) · 6 Pipeline Engineer (`claude -p` scripts) · 7 Browser
Commander (Playwright/Puppeteer) · 8 Multi-Agent Operator (coordinated parallel agents) · 9 Always
On (scheduled/unattended) · 10 Swarm Architect (agents managing agents).
