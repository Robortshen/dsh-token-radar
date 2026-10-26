# dsh-token-radar

English | [中文](README.md)

A per-call token meter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
A colour-coded pill sits below the composer and expands into a dashboard that shows what every
single model call actually cost — not just daily or per-model aggregates.

![collapsed](https://raw.githubusercontent.com/Robortshen/dsh-token-radar/main/docs/%E6%94%B6%E8%B5%B7%E6%80%81.png)

![expanded](https://raw.githubusercontent.com/Robortshen/dsh-token-radar/main/docs/%E5%B1%95%E5%BC%80%E6%80%81.png)

## What it shows

**Collapsed (below the composer, one line, ~240 px)**

```
▣ Token 雷达  530k   新 28.8k   ¥0.107  ▸
```

Session total, fresh input (blue), estimated cost (violet). Full numbers are in the tooltip; on
narrow windows the secondary field hides itself instead of pushing the host's status row into
ellipsis.

**Expanded (above the composer, in normal flow)**

| Block | Content |
|---|---|
| Three cards | this session (blue) / today (amber) / all time (violet): total tokens, calls, cost, fresh input, cache hits, output, hit rate |
| Per-call charts | **two** charts — total tokens (cache re-sends included) and the **billable part** (fresh input + output). One bar per model call, hover for the exact numbers and the tool names used in that step |
| Last 14 days | stacked daily bars |
| Sub-agents | each child session with its own steps / tokens / cost, nested by depth |
| Tool attribution | calls and estimated context growth per tool |
| By model | tokens, cost and share per provider:model |

Numbers refresh every 8 s (paused while the page is hidden); the panel also has a manual refresh.

## Where the numbers come from

Every `assistant/message` event in a DSH session log carries the provider-reported `usage`
(`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`). The host
half reads `~/.dsh/sessions/**/*.zstd` directly, so the numbers are the same ones the provider
billed — not an estimate.

- **Fresh input** = cache-miss input, **cache hits** = cache-read input (about 1/30 the price),
  **output** includes reasoning.
- Tools never call the model. "Tool attribution" splits the measured prompt growth between two
  consecutive calls (`next prompt − previous output`) across the tool results by size; it is an
  attribution, and the panel says so.
- Sub-agents are separate sessions with a `parentSession`; they are summed over the parent tree.
- Cost is estimated at DeepSeek off-peak rates (flash 0.007 / 0.22 / 0.66 USD per 1M cache-hit /
  cache-miss / output; pro 0.022 / 0.66 / 1.98), converted at 7.2 CNY/USD.

### De-duplication

Two kinds of duplication exist in the logs, and the plugin removes both:

1. one session id can have several migrated log copies (v0 / v3 / v4) — the richest one wins;
2. a sub-agent or continued session copies its parent's history verbatim (identical timestamps) —
   records are de-duplicated by `(time, turn, step, input, cacheRead, cacheWrite, output)`.

Without that, a day's usage reads exactly double.

## Privacy and footprint

- **Read-only.** The plugin reads session logs and never writes to them; it never writes to your
  workspace either.
- **No network.** No HTTP client, no telemetry, no remote calls: the browser fetches one same-origin
  route served by the plugin's own host half.
- **No dependencies.** `dependencies: {}` — the host half uses only `node:fs`, `node:zlib`,
  `node:path`, `node:os`; the client half only React, which the host page already provides.
- The host route (`GET /dsh-token-meter/stats`) is served on the local Harness port only; it is
  never exposed by the plugin.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-token-radar
```

From a source checkout / local folder:

```sh
dsh plugin --profile <your-profile> add /path/to/dsh-token-radar
```

The bundle patch inserts one row (`token-radar`). **Restart the Harness after installing** — a new
bundle is composed at process start, so the running process will not pick it up by itself
(Desktop: *DeepSeek Harness → 重启应用与 Host*).

Requirements: `dsh >= 0.1.0-rc.5`, Node `>= 20` (the host half uses Node's built-in zstd, available
from 22.15; on older Node the route reports that it cannot decode).

## Performance

First scan of 142 log files (71 MB compressed) takes ~2.2 s. Files are cached by size + mtime, so a
poll after that costs 10–30 ms; the assembled document has a 2.5 s TTL so rapid polls do not rescan.

## Layout

| File | Role |
|---|---|
| `index.js` | host half: multi-frame zstd decode, parse, de-duplicate, aggregate, serve one route |
| `client.js` | client half: pill in `conversation.composer.dock`, panel in `conversation.input.dock`, shared module-level store |
| `cordis.patch.yml` | loader row |
| `locale/{en,zh}.json` | display name and description in the Plugin Manager |
| `icon.svg` | package icon |

## License

MIT
