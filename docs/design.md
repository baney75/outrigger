# Design decisions

Outrigger keeps a T3 Code conversation available beside a web page. The existing session is the destination: the extension does not start a parallel agent or change its provider, model, or workspace.

Claude Opus 5.5 produced the design direction through native Cursor. The implemented interface uses a compact header, visible project and branch context, a pinned indication when input is needed, and a composer that stays available while history scrolls. In short windows, a waiting request takes priority and the composer can be expanded explicitly. Rendered checks cover 380 × 760 and 320 × 500 panels in light and dark appearances.

Color comes from T3's own semantic palette tokens, including published and imported custom variants. Appearance selection is explicit because T3's desktop choice belongs to that device. Custom colors are treated as data; imported code and CSS are never executed.

Attention is opt-in per session. Silent mode is the starting state, and desktop notifications reveal no conversation text. Requests show their actual question choices or command context before an action is enabled.

Drafts belong to a server and session. Disconnection preserves them; an uncertain receipt blocks automatic resending. Multiple extension views share revisioned drafts so a late send receipt cannot erase a newer edit. Page context has a preview and a remove action, and travels only with an explicit message send.

The name describes the role: a small companion alongside the main workspace. The mark is original vector geometry. This project is independent of T3 Code.
