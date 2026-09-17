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
    'id="themeToggle"',
    'id="paneCountButton"',
    'id="paneCountList"',
    'id="templatesTable"',
    'id="templateModal"',
  ]) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('popup CSS defines Claude-inspired light and dark theme variables', () => {
  assert.match(css, /--bg:/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /\.select-list/);
  assert.match(css, /\.template-table/);
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
