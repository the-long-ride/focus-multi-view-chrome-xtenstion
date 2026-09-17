# Focus Multi View Chrome Extension

A dependency-free Manifest V3 extension that opens up to 9 resizable website panes in one browser tab.

## Development

Run the built-in tests and syntax checks:

```bash
node --test tests/*.test.js
node --check common.js
node --check grid.js
node --check popup.js
```

Load the repository folder as an unpacked extension from `chrome://extensions` with Developer mode enabled.
