# morelevels-plugin

A Claude Code **plugin marketplace** (GitHub) for the `morelevels` level-up plugin. Mirrors the
`lm-claude-code` layout, hosted on GitHub.

The `morelevels` plugin assesses your Claude Code setup level (0-10, the MIT "10 Levels of Claude
Code" model), then submits **allowlisted signals only** to the [morelevels](https://github.com/999online/morelevels-plugin)
dashboard via a bundled MCP server. It never sends file contents, paths, env values, or repo names.

## Install

```
/plugin marketplace add https://github.com/999online/morelevels-plugin
/plugin install morelevels
```

(For local development: `/plugin marketplace add ~/Desktop/ideas/morelevels-claude-code`.)

## One-time setup

1. **Install the MCP server deps:**
   ```bash
   cd plugins/morelevels/mcp && npm install && node server.js --selftest
   ```
2. **Mint a submission token** from the morelevels dashboard (sign in → mint a token). For local
   QA against a dev API, use the dev-only endpoint:
   ```bash
   curl -X POST http://localhost:8787/dev/mint-token \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com"}'
   ```
3. **Export the env vars** (see `.env.example`) before starting Claude Code:
   ```bash
   export MORELEVELS_API_URL=http://localhost:8787   # omit to use the default
   export MORELEVELS_TOKEN=<your-token>
   ```

## Use

```
/morelevels            # scan, assess, submit, show your level + next step
/morelevels --assess   # same, but skip the "build the first step" offer
/morelevels --build    # skip assessment, build the next roadmap step
```

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
