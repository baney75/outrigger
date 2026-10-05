# Verification record

Release **0.1.0**, checked on 2026-10-02 (America/New_York). Passing checks narrow risk; they do not establish that every browser, server, provider, or workflow works.

## Observed results

| Check                              | Result                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Clean dependencies                 | `npm ci` exited 0 using Node 24.15.0 / npm 11.19.0                                                                  |
| Type checking and production build | `npm run check` exited 0                                                                                            |
| Unit and protocol suite            | **25 passed** across three test files                                                                               |
| Packaged browser suite             | **17 passed** in Chromium **153.0.8010.12**                                                                         |
| Accessibility                      | Axe found no violations in the tested default dark/light session list and light/dark conversation views             |
| Dependency audit                   | `npm audit --audit-level=high` reported **0 vulnerabilities**                                                       |
| Isolated T3 Code 0.0.44            | Protocol 1; exact GPT-6-Sol reply and reconnect persistence passed, exit 0                                          |
| Isolated T3 Code 0.0.45            | Protocol 1; exact GPT-6-Sol reply and reconnect persistence passed, exit 0                                          |
| Native browser interaction         | Pairing grant, notification grant, actual toolbar-opened side panel, selected-text preview and attached send passed |
| Adversarial review                 | Named state failures corrected; independent read-only re-review passed those paths                                  |
| Public copy review                 | Independent ship review passed                                                                                      |
| Archive                            | CRC, paths, manifest, bundled source equality, licenses and private-data checks passed                              |

The archive is **348,907 bytes**, with 13 files. SHA-256:

```text
6cf93a064ca2bc0a7ec48c44e67f2759d810439dd86da980b86305cadb5dd762  outrigger-0.1.0.zip
```

The [release](https://github.com/baney75/outrigger/releases/tag/v0.1.0) contains the archive and `SHA256SUMS.txt`. The [Verify workflow](https://github.com/baney75/outrigger/actions/workflows/ci.yml) runs repository checks on GitHub; its status is separate from this local result.

## What the automated suite exercises

The browser suite loads `dist` as a real Manifest V3 extension against synthetic upstream HTTP and WebSocket fixtures. It checks first run, explicit toolbar-handler wiring, insecure pairing rejection, searching, continuation in the chosen session, draft separation and reload, offline recovery, lost send acknowledgement, question and approval responses, missing approval context, custom theme variants, hostile message containment, light/dark and 320 × 500 layouts, notification/badge cleanup, silent mode, worker restart, notification destinations, concurrent-view drafts, stale revision rejection, and response uncertainty after worker restart.

The notification case uses the same bundle with notification permission declared as granted in a disposable test manifest, because headless Chromium has no native permission prompt. Native optional permission grants were checked separately. The layout checks and screenshots do not certify arbitrary user-supplied palette contrast.

The protocol tests cover safe pairing origins and scopes, omitted/malformed/unsupported protocol descriptors, streaming and heartbeat behavior, receipt ambiguity, question answer modes, and authentication expiry. Browser fixture data and public screenshots are synthetic.

## Live and native boundaries

Both official npm releases were tested with separate private databases, fresh one-use pairing credentials, sacrificial project directories, and the existing native Codex provider. The exact commands and outcomes are in [live testing](live-testing.md). Those runs prove the adapter-to-server path; the packaged panel was tested against the synthetic fixture. No personal T3 database was used.

The [native browser procedure](manual-testing.md) separately verifies real permission prompts and toolbar access. This caught a page-attachment defect that headless extension-page tests missed: automatic panel opening did not grant temporary tab access. The explicit action handler fixed it; a fresh-profile native check then verified preview and sent content, including removed URL query/fragment.

The declared minimum is Chrome 120; the observed browser was Chromium 153.0.8010.12 on macOS. Other versions and browsers remain unverified. There is no Chrome Web Store listing. Unknown protocols fail closed. Custom desktop appearance must be selected/imported because that choice is local to T3's own device.

The optional provider interruption exercise on 0.0.44 returned an accepted command receipt without establishing completed interruption. It was not repeated on 0.0.45. The extension sends the stop request and relies on upstream state; this record does not claim that every provider stops immediately.

## Reproduce

```sh
npm ci
npx playwright install chromium
npm run check
npm run package
npm audit --audit-level=high
```

The three material findings from the final adversarial pass were newer-draft deletion across views, response uncertainty lost on reload, and a stale connected state after dispatch 401/403. Revision-checked draft writes, persisted response delivery state, and explicit authorization-expiry transitions address them. A loaded-session key guard also closes the identified transition race. Regression tests accompany these changes. This is bounded evidence, not a promise of zero bugs.
