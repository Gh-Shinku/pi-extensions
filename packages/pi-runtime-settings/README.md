# 🔎 Pi Runtime Settings

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/badlogic/pi-mono)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Inspect the values held by the active Pi session to confirm that model and compaction configuration was applied.

## Features

- Reports the active model's `contextWindow` and `maxTokens` values.
- Reports resolved `compaction.enabled`, `compaction.reserveTokens`, and `compaction.keepRecentTokens` values, including Pi defaults.
- Reads runtime objects only; it does not parse `settings.json` or `models.json`.

## Install

Load the package directory with Pi:

```sh
pi -e ./packages/pi-runtime-settings
```

## Commands

Run `/runtime-settings` in an active Pi session. The values are displayed as a notification and reflect the model and settings manager currently held in memory.

Pi 0.85 does not publicly expose its resolved settings manager to extension command contexts. The extension therefore captures that instance during session construction through the manager method Pi calls immediately after extension loading. If a later Pi version exposes `ctx.settingsManager`, that public runtime value takes precedence automatically.

## License

MIT
