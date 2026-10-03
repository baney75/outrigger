# Browser companion

Keep the browser extension independent of T3 Code's private machine state.
Use the documented pairing flow and validate every remote payload. Do not read
the user's T3 database, credentials, or session files.

Preserve conversation identity, drafts, and pending delivery state across
disconnects. Never silently replay a send whose acknowledgement was lost.
Page context is explicitly attached by the user, never collected in the background.
Never render remote HTML, load remote message images, or execute theme CSS.

Tests must cover real packaged extension behavior in Chromium as well as
protocol and state boundaries. Record upstream compatibility precisely.
Public examples and screenshots contain synthetic data only.
