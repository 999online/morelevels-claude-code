# morelevels-plugin

A Claude Code **plugin marketplace** (GitHub) for the `morelevels` level-up plugin. Mirrors the
`lm-claude-code` layout, hosted on GitHub.

The `morelevels` plugin assesses your Claude Code setup level (0-10, the MIT "10 Levels of Claude
Code" model), then submits **allowlisted signals only** to the [morelevels](https://github.com/999online/morelevels-plugin)
dashboard via a bundled MCP server. It never sends file contents, paths, env values, or repo names.

## Setup (3 steps, no terminal)

```
/plugin marketplace add https://github.com/999online/morelevels-plugin
/plugin install morelevels
/morelevels
```

On the **first** `/morelevels`, it asks for your token once: open your morelevels dashboard → mint a
submission token → paste it. That's it — the token is saved to `~/.morelevels.json` and every later
run just works. **No environment variables, no `npm install`, no shell editing.**

(For local development: `/plugin marketplace add ~/Desktop/ideas/morelevels-claude-code`.)

## Use

```
/morelevels            # scan, assess, submit, show your level + next step
/morelevels --assess   # same, but skip the "build the first step" offer
/morelevels --build    # skip assessment, build the next roadmap step
```

## For developers (optional)

The MCP server is zero-dependency — `node plugins/morelevels/mcp/server.js` runs with no install.
Self-check: `node plugins/morelevels/mcp/server.js --selftest`. You can override config with the
`MORELEVELS_TOKEN` / `MORELEVELS_API_URL` env vars (they win over `~/.morelevels.json`); see
`.env.example`. Set `DEFAULT_API_URL` in `server.js` to the production URL at deploy.

## What gets submitted (and what never does)

Submitted: an integer `level` (0-10), 13 boolean/count **signals**, and an `os` tag.
**Never** submitted: file contents, paths, environment values, repo or company names. The morelevels
API enforces this with strict schema validation (extra field → 400); the bundled MCP server strips
to the allowlist as the client-side half of the same guard.

## Layout

```
.claude-plugin/marketplace.json      # marketplace catalog
plugins/morelevels/
  .claude-plugin/plugin.json         # plugin manifest
  commands/morelevels.md             # /morelevels command
  skills/morelevels-assess/SKILL.md  # scan -> assess -> submit flow
  mcp/server.js                      # MCP server wrapping the morelevels API
  .mcp.json                          # MCP server registration (env passthrough)
```
