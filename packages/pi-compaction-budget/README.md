# 📉 Pi Compaction Budget

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/badlogic/pi-mono)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Predict how many output tokens Pi's summarization request will actually get, and which setting is capping it.

## Why

Pi sends the compaction summary with

```
maxTokens = min(0.8 * compaction.reserveTokens,
                model.maxTokens,
                contextWindow - promptTokens - 4096)
```

The last term is the usual surprise. The summary prompt inlines the whole serialized conversation, so a nearly full context leaves almost no room for the answer. The provider then stops with `finish_reason: "length"` and compaction fails with

```
Summarization failed: generation hit the token cap and the summary is incomplete
```

`/compact-budget` reproduces that arithmetic before you run `/compact`, so you can adjust `compaction.reserveTokens` or `compaction.keepRecentTokens` instead of guessing.

## Install

Load the package directory with Pi:

```sh
pi -e ./packages/pi-compaction-budget
```

## Commands

```
/compact-budget                 report for the current session
/compact-budget 32768           simulate compaction.reserveTokens = 32768
/compact-budget 32768 60000     also simulate keepRecentTokens = 60000
```

Report fields:

- Header: active model, `contextWindow`, `model.maxTokens`, thinking level, current context usage, the auto-compaction trigger (`contextWindow - reserveTokens`), and the resolved compaction settings with their source (`settings live` when taken from the running session, `settings disk` when it had to read `settings.json`).
- Per summarization request (`history summary`, plus `turn prefix summary` for a split turn): estimated input tokens, window room, resulting `maxTokens`, reserved thinking tokens, text room, and which ceiling bound the result.
- `verdict: OK | TIGHT | FAIL`, followed by hints naming the setting to change. `FAIL` means the summary will be truncated.

`TIGHT` means the text room is below 4096 tokens, which is usually too small for the structured summary Pi asks for.

## Behavior

- Read-only. The extension never writes settings and never applies its suggestions.
- Settings come from the live `SettingsManager` Pi constructed (captured at session start), so in-memory, SDK, and model-specific overrides the running Pi version resolves are reported exactly. Reading from disk is only a fallback.
- A `session_before_compact` hook recomputes the budget from the prepared compaction. If the verdict is not `OK`, it emits a warning at the moment `/compact` starts, so a failing compaction explains itself.

## Accuracy and maintenance

Pi does not expose its compaction internals, so this package mirrors them:

- Numeric mirrors (`clampMaxTokensToContext` margin, thinking budgets, reserve ratios, estimator divisor) and prompt mirrors live in [`src/pi-internals.ts`](./src/pi-internals.ts), each annotated with its upstream file.
- The input estimate uses the same `ceil(chars / 4)` estimator as pi ([`packages/ai/src/utils/estimate.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/estimate.ts)), so it can differ from a provider tokenizer.
- Mirrors were verified against `@earendil-works/pi-coding-agent` 0.85.1, the pinned peer range. Update them together with the peer range.

## License

MIT
