const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('grid.html', 'utf8');
const js = fs.readFileSync('grid.js', 'utf8');
const css = fs.readFileSync('grid.css', 'utf8');

test('grid uses floating trigger and controls instead of a fixed top bar', () => {
  assert.equal(html.includes('id="topbar"'), false);
  for (const token of ['id="controlTrigger"', 'id="floatingPanel"', 'common.js']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('grid panes occupy the full viewport and floating controls are fixed and themed', () => {
  assert.match(css, /#panesContainer\s*\{[^}]*height:\s*100vh/s);
  assert.match(css, /#controlTrigger\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /#floatingPanel\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\[data-theme="dark"\]/);
});

test('grid script persists drag position and clamps the floating panel to the viewport', () => {
  assert.match(js, /pointerdown/);
  assert.match(js, /floatingTriggerPosition/);
  assert.match(js, /computeFloatingPanelPosition/);
  assert.match(js, /clampFloatingPosition/);
});

test('grid script synchronizes theme changes from local storage', () => {
  assert.match(js, /MPV\.loadTheme/);
  assert.match(js, /changes\.theme/);
  assert.match(js, /MPV\.applyTheme/);
});

test('pane toolbar overlays content and only appears on hover or keyboard focus', () => {
  assert.match(css, /\.pane-toolbar\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.pane-toolbar\s*\{[^}]*opacity:\s*0/s);
  assert.match(css, /\.pane:hover\s+\.pane-toolbar/);
  assert.match(css, /\.pane:focus-within\s+\.pane-toolbar/);
  assert.match(css, /\.pane-iframe\s*\{[^}]*height:\s*100%/s);
});

test('pane toolbar has separate address navigation, refresh, and close behavior', () => {
  assert.match(js, /urlInput\.addEventListener\('keydown'/);
  assert.match(js, /reloadBtn\.addEventListener\('click',\s*\(\)\s*=>\s*reloadIframe\(iframe\)\)/s);
  assert.match(js, /closeBtn\.addEventListener\('click',\s*\(\)\s*=>\s*removePane\(wrapper\)\)/s);
  assert.match(js, /reloadBtn\.title\s*=\s*'Refresh pane'/);
});
