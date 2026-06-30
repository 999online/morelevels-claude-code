# morelevels MCP server

The submission path for the `morelevels` plugin. The `/morelevels` skill never calls the API
directly — it calls these tools, and this server builds the request from an allowlist only, so no
file content, path, or env value can leak (morelevels `compliance.md`, "THE LINE").

## One-time setup

```bash
cd plugins/morelevels/mcp
npm install
node server.js --selftest   # asserts the allowlist strips smuggled fields
```

## Tools

| Tool | Calls | Returns |
| --- | --- | --- |
| `morelevels_submit` | `POST /submissions` | `{ submission, claimedLevel, corrected }` |
| `morelevels_my_level` | `GET /me/level` | `{ current, highest, levelName, history, nextStep }` |

## Config (env, via the plugin `.mcp.json`)

| Var | Default | Notes |
| --- | --- | --- |
| `MORELEVELS_API_URL` | `http://localhost:8787` | morelevels API base URL |
| `MORELEVELS_TOKEN` | _(required)_ | Bearer submission token — mint from the dashboard or `POST /dev/mint-token` locally |

The server reads these from its environment. The bundled `.mcp.json` passes them through from your
shell, so the token stays out of the repo. Requires Node 18+ (built-in `fetch`).
