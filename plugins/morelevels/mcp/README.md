# morelevels MCP server

The submission path for the `morelevels` plugin. The `/morelevels` skill never calls the API
directly — it calls these tools, and this server builds the request from an allowlist only, so no
file content, path, or env value can leak (morelevels `compliance.md`, "THE LINE").

**Zero dependencies.** `node server.js` works the moment the plugin is installed — no `npm install`,
no `node_modules`, no network. Requires Node 18+ (built-in `fetch`). Optional self-check:

```bash
node server.js --selftest
```

## Tools

| Tool | Calls | Returns |
| --- | --- | --- |
| `morelevels_submit` | `POST /submissions` | `{ submission, claimedLevel, corrected }` |
| `morelevels_my_level` | `GET /me/level` | `{ current, highest, levelName, history, nextStep }` |
| `morelevels_save_config` | writes `~/.morelevels.json` | `{ saved, path }` |

## Config (no env vars required)

The user pastes their token once when running `/morelevels`; the skill calls `morelevels_save_config`,
which writes `~/.morelevels.json` (mode `0600`). The server reads it **lazily on every call**, so a
token saved mid-session works with no restart.

Resolution order:

| Setting | Order |
| --- | --- |
| token | `MORELEVELS_TOKEN` env (dev override) → `~/.morelevels.json` `.token` |
| apiUrl | `MORELEVELS_API_URL` env → `~/.morelevels.json` `.apiUrl` → `DEFAULT_API_URL` constant |

`DEFAULT_API_URL` in `server.js` is `http://localhost:8787`; set it to the morelevels production URL
at deploy so non-devs need only paste a token. `MORELEVELS_CONFIG_PATH` overrides the config file
location (used by the self-check).
