# Native browser check

The automated suite loads the actual extension bundle, but a web-page test cannot prove that Chrome's toolbar grants temporary tab access. Repeat this check after changing the action handler, permissions, or attachment flow.

1. Build or extract the release into a fresh folder. In a disposable Chrome profile, load that folder unpacked from `chrome://extensions`. Reload the extension after replacing its files; an existing profile can retain an older worker.
2. Pair through the visible input with an isolated T3 server. Allow access to that server origin. Verify that the session list appears and that a message continues the chosen session.
3. Open a harmless test web page whose URL includes a query and fragment. Select one paragraph. Click Outrigger in the browser's extension menu or pinned toolbar, then open a session in the side panel.
4. Press **Attach page**. The preview must contain the page title, URL without the query or fragment, and only the selected text. Remove it once and verify the preview disappears; attach it again and send a harmless message. Check the resulting message in the isolated server.
5. Watch a session and turn off silent mode. Chrome should ask for notification permission. Enable silent mode again and verify that existing notifications clear. A rejected permission prompt must leave silent mode on.
6. Visit a different origin. Click Outrigger's toolbar action on that tab before attaching it. A browser settings page must produce an actionable error rather than sending its content.

Observed on macOS with Chromium 153.0.8010.12 for 0.1.0: native pairing and notification permission prompts, a continuation send, the actual toolbar-opened side panel, selection preview, and sent content with query/fragment removed passed against a synthetic server. The action now uses `chrome.action.onClicked` to open the panel; automatic `openPanelOnActionClick` had opened the panel without granting `activeTab` in the observed browser. The packaged first-run test checks that this explicit handler remains installed.

This is distinct from the live T3 adapter checks in [live testing](live-testing.md). No user browsing content belongs in public screenshots or test fixtures.
