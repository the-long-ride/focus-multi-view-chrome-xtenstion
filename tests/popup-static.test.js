const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('popup.html', 'utf8');
const js = fs.readFileSync('popup.js', 'utf8');
const css = fs.existsSync('popup.css') ? fs.readFileSync('popup.css', 'utf8') : '';
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

test('popup exposes themed shell, custom selector, template table, and modal', () => {
  for (const token of [
    'popup.css',
    'common.js',
    'id="extensionVersion"',
    'id="paneCountButton"',
    'id="paneCountList"',
    'id="templatesTable"',
    'id="templateModal"',
  ]) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('popup CSS uses the xAI dark-only visual system', () => {
  assert.match(css, /--canvas:\s*#0a0a0a/i);
  assert.match(css, /--canvas-card:\s*#191919/i);
  assert.match(css, /--hairline:\s*#212327/i);
  assert.match(css, /border-radius:\s*9999px/);
  assert.match(css, /\.select-list/);
  assert.match(css, /\.template-table/);
  assert.equal(css.includes('[data-theme="dark"]'), false);
});

test('popup script reads real extension version and persists templates and launch URLs', () => {
  assert.match(js, /getManifest\(\)\.version/);
  assert.match(js, /templates/);
  assert.match(js, /launchUrls/);
  assert.match(js, /chrome\.storage\.local/);
  assert.match(js, /chrome\.storage\.session/);
});

test('popup copy and template counter reflect the 9-pane limit', () => {
  assert.match(html, /Open up to 9 sites in one resizable tab\./);
  assert.match(html, /id="templateUrlCount">2 \/ 9</);
  assert.match(manifest.description, /up to 9/i);
});

test('popup is dark-only and no longer exposes theme state or a theme toggle', () => {
  assert.equal(html.includes('id="themeToggle"'), false);
  assert.equal(js.includes('setTheme'), false);
  assert.equal(js.includes('changes.theme'), false);
  assert.equal(js.includes('MPV.loadTheme'), false);
});
