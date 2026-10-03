# Security

## Report a vulnerability

Please use this repository's **Report a vulnerability** link under its GitHub **Security** tab when available. If private reporting is not enabled, open an issue asking for a private contact route **without** posting an exploit, credential, pairing link, or private conversation. Include the affected Outrigger and T3 Code versions, a minimal reproduction, and the impact in the private report.

## Trust boundaries

Outrigger is an independent client for a T3 Code server you choose. Pairing grants access to that server's sessions. Keep pairing links private, use a trusted server, and revoke a connection in T3 Code if a credential may be exposed. Outrigger requests host access for the paired origin at connection time. Non-loopback HTTP is refused; HTTPS is required for remote hosts.

The bearer credential lives in `chrome.storage.local`, restricted to trusted extension contexts. Browser local storage is **not an encrypted credential vault**. Anyone with access to your browser profile or machine may be able to obtain its contents. **Disconnect and clear local drafts** removes the saved connection and local drafts from the extension; revoke the server-side session separately if needed.

Page context is captured only when you press **Attach page**. Review the preview: a URL path or selected text may still be sensitive after URL credentials, query parameters, and fragments are stripped. Outrigger does not collect browsing history, execute imported theme CSS, render remote message images, or load a remote UI. No telemetry or vendor backend is included. See [privacy](docs/privacy.md) for the data inventory.

Supported compatibility is T3 Code 0.0.44 and 0.0.45 with orchestration protocol 1. Both were checked against isolated official servers. Unknown or missing protocols are rejected; see [verification](docs/verification.md) for the evidence and limits.
