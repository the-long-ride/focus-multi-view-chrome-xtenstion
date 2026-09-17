const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('grid.html', 'utf8');
const js = fs.readFileSync('grid.js', 'utf8');
const css = fs.readFileSync('grid.css', 'utf8');

test('grid uses floating global controls and full viewport panes', () => {
  assert.equal(html.includes('id="topbar"'), false);
  for (const token of ['id="controlTrigger"', 'id="floatingPanel"', 'common.js']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
  assert.match(css, /#panesContainer\s*\{[^}]*height:\s*100vh/s);
  assert.match(css, /#controlTrigger\s*\{[^}]*position:\s*fixed/s);
});

test('global controls persist per-workspace position and keep the panel in viewport', () => {
  assert.match(js, /floatingTriggerPosition/);
  assert.match(js, /sendWorkspaceUiPatch\(\{\s*ui:\s*\{\s*floatingTriggerPosition/s);
  assert.match(js, /computeFloatingPanelPosition/);
  assert.match(js, /clampFloatingPosition/);
  assert.match(js, /beginTriggerDrag/);
});

test('each pane uses a draggable compact control pill instead of a full-width hover toolbar', () => {
  assert.match(js, /pane-control/);
  assert.match(js, /pane-control-grip/);
  assert.match(js, /beginPaneControlDrag/);
  assert.match(js, /clampPaneControl/);
  assert.match(js, /mpv:workspace-pane-patch/);
  assert.match(css, /\.pane-control\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.pane-control-grip\s*\{/s);
  assert.equal(css.includes('.pane:hover .pane-toolbar'), false);
});

test('pane controls preserve address navigation, refresh, close, and retained history', () => {
  assert.match(js, /urlInput\.addEventListener\('keydown'/);
  assert.match(js, /reloadBtn\.addEventListener\('click',\s*\(\)\s*=>\s*reloadPane\(pane\)\)/s);
  assert.match(js, /closeBtn\.addEventListener\('click'/);
  assert.match(js, /mpv:workspace-pane-remove/);
  assert.match(js, /mpv:history-traverse/);
  assert.match(js, /backBtn\.addEventListener/);
  assert.match(js, /forwardBtn\.addEventListener/);
  assert.match(js, /reloadBtn\.title\s*=\s*'Refresh pane'/);
  assert.match(css, /\.pane-iframe\s*\{[^}]*height:\s*100%/s);
});

test('grid restores stable pane ids through extension bootstrap URLs', () => {
  assert.match(js, /options\.paneId \|\| crypto\.randomUUID\(\)/);
  assert.match(js, /focus-pane:\$\{paneId\}/);
  assert.match(js, /bootstrapUrlForPane/);
  assert.match(js, /mpv:pane-bootstrap-ready/);
  assert.match(js, /mpv:pane-bootstrap-target/);
});

test('splitter resize previews with transforms and persists only at pointer release', () => {
  assert.match(js, /resizeDragState/);
  assert.match(js, /function beginResize/);
  assert.match(js, /function moveResize/);
  assert.match(js, /function finishResize/);
  assert.match(js, /requestAnimationFrame\(renderResizePreview\)/);
  assert.match(js, /style\.transform/);
  assert.match(js, /sendWorkspaceUiPatch\(\{\s*layout:/s);
  assert.match(js, /container\.addEventListener\('pointerdown'/);
  assert.match(js, /window\.addEventListener\('pointermove'/);
  assert.match(js, /window\.addEventListener\('pointerup'/);
  assert.match(css, /body\.resizing\s+\.pane-iframe\s*\{[^}]*pointer-events:\s*none/s);
});

test('grid uses xAI dark-only tokens without theme switching', () => {
  assert.match(css, /--canvas:\s*#0a0a0a/i);
  assert.match(css, /--canvas-card:\s*#191919/i);
  assert.match(css, /--hairline:\s*#212327/i);
  assert.match(css, /border-radius:\s*9999px/);
  assert.equal(css.includes('[data-theme="dark"]'), false);
  assert.equal(js.includes('changes.theme'), false);
  assert.equal(js.includes('MPV.loadTheme'), false);
});

test('splitter gutter width is slimmed down for expansive pane viewing', () => {
  const match = js.match(/const GUTTER = (\d+);/);
  assert.ok(match, 'GUTTER constant found');
  const gutterVal = Number(match[1]);
  assert.ok(gutterVal <= 3, `GUTTER (${gutterVal}) should be reduced (<= 3px)`);
});

test('grid re-registers workspace and enhanced session when worker port becomes ready', () => {
  assert.match(js, /chrome\.runtime\.connect\(\{\s*name:\s*`mpv-grid:\$\{sessionId\}`\s*\}\)/);
  assert.match(js, /message\.type === 'mpv:background-ready'/);
  assert.match(js, /registerWorkspace\(\).*syncEnhancedSession/s);
});
