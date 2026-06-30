# AI Usage

AI Usage is a small cross-platform desktop dashboard for local AI coding usage statistics. It currently supports Codex and Claude Code.

## Current scope

- No tray integration.
- Reads local Codex and Claude Code data in read-only mode.
- Supports macOS, Windows, and Linux through Electron.
- Uses `CODEX_HOME` when set, otherwise defaults to `~/.codex`.
- Uses `CLAUDE_CONFIG_DIR` or `CLAUDE_HOME` when set, otherwise defaults to `~/.claude`.
- Includes a settings view for Codex directory, Claude Code directory, active provider, theme, accent color, and chart period.
- Defaults to a 30-day chart period.
- Estimates cost from local Codex session token events using a CodexBar-compatible `$1 / 1M local tokens` estimate.
- Uses a quiet dashboard layout with a sidebar workspace shell for multiple providers.
- Shows local Codex account name and plan type when available.

## Development

```sh
npm install
npm run dev
```

If Electron download is slow, use your local proxy or mirror for that install command:

```sh
ELECTRON_GET_USE_PROXY=true \
GLOBAL_AGENT_HTTP_PROXY=http://127.0.0.1:7897 \
GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7897 \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
npm install
```

## Tests

```sh
npm test
```

## Packaging

```sh
npm run package:mac
npm run package:win
npm run package:linux
```
