# Focus Multi View Chrome Extension

A dependency-free Manifest V3 extension that opens up to 9 resizable website panes in one browser tab.

## Enhanced same-host panes

When every pane uses the same exact hostname, Focus Multi View can request permission for that host and enable native-like Back, Forward, Reload, popup-to-pane routing, and Open in native tab controls. Permission is optional; denying it leaves the normal iframe grid unchanged. Mixed-host workspaces fall back to basic pane mode.

The enhanced runtime keeps each pane as a logical tab inside the grid. It does not make other extensions' top-frame-only content scripts execute inside pane iframes. Use **Open in native tab** when a page needs normal Chrome-tab extension behavior.

## Development

Run the built-in tests and syntax checks:

```bash
node --test tests/*.test.js
node --check common.js
node --check grid.js
node --check popup.js
node --check src/background/frame-registry.js
node --check src/background/popup-router.js
node --check src/background/service-worker.js
node --check src/pane/bridge.js
```

Load the repository folder as an unpacked extension from `chrome://extensions` with Developer mode enabled.

For deterministic enhanced-mode testing, serve `tests/fixtures` locally, for example with `python -m http.server 8765 --directory tests/fixtures`, then open at least two `http://localhost:8765/same-host.html` panes. The fixture includes SPA navigation, same-host popup, and cross-host popup actions.
