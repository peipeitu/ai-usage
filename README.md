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
- GitHub Copilot
  - Reads local VS Code Copilot extension storage from `GITHUB_COPILOT_HOME` or `COPILOT_HOME` when set.
  - Defaults to VS Code/Copilot global storage, such as `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat` on macOS.
  - Aggregates recognized local Copilot chat usage fields and falls back to text-length token estimates when explicit token usage is unavailable.
- Cursor
  - Reads local Cursor editor storage from `AI_USAGE_CURSOR_HOME` or `CURSOR_HOME` when set.
  - Defaults to Cursor global storage, such as `~/Library/Application Support/Cursor/User/globalStorage` on macOS.
  - Aggregates recognized local Cursor chat/composer usage fields and falls back to text-length token estimates when explicit token usage is unavailable.
- ChatGPT
  - Reads local ChatGPT data from `AI_USAGE_CHATGPT_HOME` or `CHATGPT_HOME` when set.
  - Defaults to common ChatGPT desktop app storage, such as `~/Library/Application Support/com.openai.chat` on macOS.
  - Can also read ChatGPT export folders that include `conversations.json`.
  - Aggregates recognized local/exported conversation fields and falls back to text-length token estimates when explicit token usage is unavailable.

## Current Scope

- Supports Windows and Linux release packages through Tauri. macOS can be built locally, but no macOS release package is published yet.
- Uses a local desktop dashboard with a sidebar provider switch.
- Includes settings for Codex directory, Claude Code directory, GitHub Copilot directory, Cursor directory, ChatGPT directory, theme, accent color, and chart period.
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

No macOS package is published for now. macOS distribution needs a Developer ID certificate, signing, and notarization to avoid Gatekeeper warnings, and the updater flow also needs a separate signed macOS artifact.

For local self-use, you can still build an unsigned app on your own Mac:

```sh
npm run package:mac
```

Output:

- `src-tauri/target/release/bundle/macos/AI Usage.app`

Install from the local app bundle:

```sh
cp -R "src-tauri/target/release/bundle/macos/AI Usage.app" /Applications/
open "/Applications/AI Usage.app"
```

If macOS blocks a trusted local build, clear the quarantine attribute:

```sh
xattr -dr com.apple.quarantine "/Applications/AI Usage.app"
open "/Applications/AI Usage.app"
```

This local build command is not used for release publishing.

### Windows

```sh
npm run package:win
```

Output:

- `src-tauri/target/release/bundle/nsis/AI Usage_<version>_<arch>-setup.exe`
- `src-tauri/target/release/bundle/nsis/AI Usage_<version>_<arch>-setup.exe.sig`

Install:

1. Run the generated `.exe` installer.
2. Follow the installer prompts.
3. Launch `AI Usage` from the Start menu or desktop shortcut.

The `.sig` file is used by the in-app updater to verify Windows updates. It is generated when `TAURI_SIGNING_PRIVATE_KEY` is set.

Unsigned Windows builds may show a SmartScreen warning. Use an Authenticode code-signing certificate in CI or your local certificate store for public distribution.

### Linux

```sh
npm run package:linux
```

Outputs:

- `src-tauri/target/release/bundle/appimage/ai-usage_<version>_<arch>.AppImage`
- `src-tauri/target/release/bundle/appimage/ai-usage_<version>_<arch>.AppImage.sig`
- `src-tauri/target/release/bundle/deb/ai-usage_<version>_<arch>.deb`

Install AppImage:

```sh
chmod +x src-tauri/target/release/bundle/appimage/ai-usage_0.1.3_amd64.AppImage
./src-tauri/target/release/bundle/appimage/ai-usage_0.1.3_amd64.AppImage
```

Install Debian package:

```sh
sudo apt install ./src-tauri/target/release/bundle/deb/ai-usage_0.1.3_amd64.deb
```

Package filenames include the current package version and target architecture, so adjust the examples if your generated filename differs.

### Auto Updates

Automatic updates are enabled only for Windows and Linux release builds. macOS is intentionally not wired to the updater or release packaging yet.

Generate updater signing keys once:

```sh
npm run tauri signer generate -- -w ~/.tauri/ai-usage.key
```

Keep the private key secret. Build Windows or Linux releases with the public key embedded and the private key available for artifact signing:

```sh
export AI_USAGE_UPDATER_PUBLIC_KEY="content of the generated public key"
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/ai-usage.key"
npm run package:linux
```

On Windows PowerShell:

```powershell
$env:AI_USAGE_UPDATER_PUBLIC_KEY="content of the generated public key"
$env:TAURI_SIGNING_PRIVATE_KEY="C:\Users\you\.tauri\ai-usage.key"
npm run package:win
```

The app checks `https://github.com/peipeitu/ai-usage/releases/latest/download/latest.json`. Publish a `latest.json` release asset containing Windows and Linux platform entries only, with each `signature` value copied from the generated `.sig` file.

Linux AppImage GPG signing is optional and separate from the updater signature:

```sh
SIGN=1 SIGN_KEY="your-gpg-key-id" APPIMAGETOOL_FORCE_SIGN=1 npm run package:linux
```
