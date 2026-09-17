# Focus Multi View Chrome Extension

A dependency-free Manifest V3 extension that opens up to 9 resizable website panes in one browser tab.

## Closed-tab workspace restore

Focus gives every split-view tab an opaque workspace ID. When the tab is closed, Chrome's normal **Ctrl + Shift + T** reopen restores that outer workspace URL, and Focus rebuilds the saved split-view state.

The restored workspace includes every pane and its current URL, retained Back/Forward URL history, pane order and grid sizing, pane-control positions, active pane, floating controls, and supported Compatibility/Enhanced mode intent when the required permission is still available.

History and snapshots are deliberately bounded so storage cannot grow indefinitely:

- up to **50 history entries per pane**;
- up to **20 closed workspaces**;
- a **6 MiB soft budget** across Focus workspace records.

Reopening the same closed workspace reuses its workspace record instead of creating another copy. Focus stores URL/navigation metadata and its own UI state only. It does not serialize page bodies, credentials, cookies, form contents, JavaScript heap state, or arbitrary cross-origin DOM/media state, so those site-owned details may not survive closing the tab.

## Enhanced same-host panes

When every pane uses the same exact hostname, Focus Multi View can request permission for that host and enable native-like Back, Forward, Reload, popup-to-pane routing, and Open in native tab controls. Permission is optional; denying it leaves the normal iframe grid unchanged. Mixed-host workspaces fall back to basic pane mode.

The enhanced runtime keeps each pane as a logical tab inside the grid. It does not make other extensions' top-frame-only content scripts execute inside pane iframes. Use **Open in native tab** when a page needs normal Chrome-tab extension behavior.

## Development

Run the built-in tests and syntax checks:

```bash
node --test tests/*.test.js
node --check common.js
node --check popup.js
node --check grid.js
node --check pane-bootstrap.js
node --check src/workspace/workspace-store.js
node --check src/background/workspace-frame-registry.js
node --check src/background/frame-registry.js
node --check src/background/popup-router.js
node --check src/background/service-worker.js
node --check src/pane/bridge.js
```

Load the repository folder as an unpacked extension from `chrome://extensions` with Developer mode enabled.

For deterministic enhanced-mode testing, serve `tests/fixtures` locally, for example with `python -m http.server 8765 --directory tests/fixtures`, then open at least two `http://localhost:8765/same-host.html` panes. The fixture includes SPA navigation, same-host popup, and cross-host popup actions.
