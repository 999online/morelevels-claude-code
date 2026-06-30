---
description: Assess your Claude Code level (0-10) and submit allowlisted signals to the morelevels dashboard
argument-hint: "[--assess | --build]"
---

# /morelevels

Run the **morelevels-assess** skill on this environment.

- (no flag) — scan, assess, submit to morelevels, show the server's level + next step
- `--assess` — scan, assess, submit; skip the optional "build the first step" offer
- `--build` — skip assessment; jump to building the first roadmap step

Follow the `morelevels-assess` skill end to end. Submit results ONLY through the
`morelevels_submit` MCP tool — never write a local HTML dashboard, never POST inline.

Arguments: $ARGUMENTS
