# AI Usage

[![GitHub](https://img.shields.io/badge/GitHub-peipeitu%2Fai--usage-24292f?logo=github)](https://github.com/peipeitu/ai-usage)
[![Issues](https://img.shields.io/github/issues/peipeitu/ai-usage)](https://github.com/peipeitu/ai-usage/issues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

AI Usage is a small cross-platform Tauri desktop dashboard for local AI coding usage statistics. It reads local data in read-only mode and shows recent usage, token estimates, model distribution, workspace distribution, and recent sessions.

## Supported AI Sources

- Codex
  - Reads local Codex data from `CODEX_HOME` when set.
  - Defaults to `~/.codex`.
  - Shows local account name and Codex plan information when available.
  - Estimates cost from local Codex session token events using a CodexBar-compatible `$1 / 1M local tokens` estimate.
- Claude Code
  - Reads local Claude Code session logs from `CLAUDE_CONFIG_DIR` or `CLAUDE_HOME` when set.
  - Defaults to `~/.claude`.
  - Aggregates assistant message usage from Claude Code JSONL logs.

## Current Scope

- Supports macOS, Windows, and Linux through Tauri.
- Uses a local desktop dashboard with a sidebar provider switch.
- Includes settings for Codex directory, Claude Code directory, theme, accent color, and chart period.
- Defaults to a 30-day chart period.
- No tray integration yet.

## Development

```sh
npm install
npm run dev
```

Run tests:

```sh
npm test
```

## Feedback

Bug reports, feature requests, and usage questions are welcome in [GitHub Issues](https://github.com/peipeitu/ai-usage/issues).

## License

This project is licensed under the [MIT License](LICENSE).

## Packaging

Build all artifacts from the repository root after installing dependencies.

### macOS

```sh
npm run package:mac
```

Outputs:

- `src-tauri/target/release/bundle/macos/AI Usage.app`

Install from the app bundle:

```sh
cp -R "src-tauri/target/release/bundle/macos/AI Usage.app" /Applications/
open "/Applications/AI Usage.app"
```

For unsigned local test builds, macOS may show "damaged" or block the app. You can clear the quarantine attribute for a trusted local build:

```sh
xattr -dr com.apple.quarantine "/Applications/AI Usage.app"
open "/Applications/AI Usage.app"
```

For normal distribution to other users, sign with a Developer ID certificate and notarize the app.

### Windows

```sh
npm run package:win
```

Output:

- `src-tauri/target/release/bundle/nsis/AI Usage_<version>_<arch>-setup.exe`

Install:

1. Run the generated `.exe` installer.
2. Follow the installer prompts.
3. Launch `AI Usage` from the Start menu or desktop shortcut.

Unsigned Windows builds may show a SmartScreen warning. Users can continue manually for trusted test builds.

### Linux

```sh
npm run package:linux
```

Outputs:

- `src-tauri/target/release/bundle/appimage/ai-usage_<version>_<arch>.AppImage`
- `src-tauri/target/release/bundle/deb/ai-usage_<version>_<arch>.deb`

Install AppImage:

```sh
chmod +x src-tauri/target/release/bundle/appimage/ai-usage_0.1.1_amd64.AppImage
./src-tauri/target/release/bundle/appimage/ai-usage_0.1.1_amd64.AppImage
```

Install Debian package:

```sh
sudo apt install ./src-tauri/target/release/bundle/deb/ai-usage_0.1.1_amd64.deb
```

Package filenames include the current package version and target architecture, so adjust the examples if your generated filename differs.
