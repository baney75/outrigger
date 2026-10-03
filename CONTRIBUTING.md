# Contributing

Outrigger is a small independent companion for T3 Code. A useful change should preserve the first run path, the user's choice over what to send, and the distinction between a confirmed and uncertain delivery.

## Work locally

Install Node.js 22.12 or newer, then run:

```sh
npm ci
npx playwright install chromium
npm run check
```

`npm run check` type checks, runs Vitest, builds `dist`, and exercises that packaged extension in headless Chromium. The browser tests use a synthetic local T3 fixture. They do not prove compatibility with every live T3 release. For a separate, isolated upstream check, see [live testing](docs/live-testing.md). Do not use a personal T3 database or publish pairing links, tokens, session text, or local test state in an issue or screenshot.

For UI changes, inspect the built side panel at a normal width and a short 320 × 500 viewport, in light and dark appearances. Keep screenshots synthetic. If you change protocol handling, test accepted, rejected, and lost-acknowledgement paths, and state the exact T3 version and protocol observed. Do not silently replay a command when the server may already have received it.

Please keep changes focused, explain the user-visible result, and include the command and observed result used to check it. The design and data boundaries are documented in [architecture](docs/architecture.md) and [privacy](docs/privacy.md). T3 Code palette material carries an upstream [MIT notice](docs/T3-LICENSE.txt).
