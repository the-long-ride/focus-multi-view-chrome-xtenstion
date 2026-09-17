const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('grid.html', 'utf8');
const js = fs.readFileSync('grid.js', 'utf8');
const css = fs.readFileSync('grid.css', 'utf8');

test('grid exposes explicit enhanced same-host mode control', () => {
  assert.ok(html.includes('id="enhancedToggle"'));
  assert.match(js, /MPV\.analyzeSameHostUrls/);
  assert.match(js, /enableEnhancedFromGesture/);
  assert.match(js, /chrome\.permissions\.request/);
});

test('panes have stable logical ids, frame names, and popup sandbox escape', () => {
  assert.match(js, /const paneId = crypto\.randomUUID\(\)/);
  assert.match(js, /focus-pane:\$\{paneId\}/);
  assert.match(js, /allow-popups-to-escape-sandbox/);
});

test('grid uses a dedicated per-session runtime Port', () => {
  assert.match(js, /chrome\.runtime\.connect\(\{\s*name:\s*`mpv-grid:\$\{sessionId\}`\s*\}\)/);
  assert.match(js, /port\.postMessage/);
  assert.match(js, /mpv:session-start/);
  assert.match(js, /mpv:session-update/);
  assert.match(js, /mpv:session-stop/);
  assert.doesNotMatch(js, /chrome\.runtime\.sendMessage\(\{\s*type:\s*'mpv:session-/);
});

test('native-like pane controls include back forward and open-native actions', () => {
  assert.match(js, /title = 'Back'/);
  assert.match(js, /title = 'Forward'/);
  assert.match(js, /title = 'Open in native tab'/);
  assert.match(js, /mpv:pane-command/);
  assert.match(js, /chrome\.tabs\.create/);
});

test('popup candidates are acknowledged over the owning Port only after pane creation', () => {
  assert.match(js, /mpv:popup-candidate/);
  assert.match(js, /mpv:popup-result/);
  assert.match(js, /candidateId/);
  assert.match(js, /accepted:\s*Boolean\(pane\)/);
});

test('enhanced mode styles stay inside existing xAI controls', () => {
  assert.match(css, /\.enhanced-button\.active\s+\.enhanced-dot/);
  assert.match(css, /\.pane-control-action\.enhanced-only\[hidden\]/);
});

test('enhanced synchronization requires explicit same-host opt-in, not host permission alone', () => {
  assert.match(js, /enhancedOptInHostname/);
  assert.match(js, /analysis\.hostname !== enhancedOptInHostname/);
  assert.match(js, /launchEnhancedHostname/);
});
