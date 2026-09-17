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

test('popup reads the real extension version, persists templates, and launches durable workspaces', () => {
  assert.match(js, /getManifest\(\)\.version/);
  assert.match(js, /templates/);
  assert.match(js, /new MPVWorkspaceStore\.WorkspaceStore/);
  assert.match(js, /workspaceStore\.create/);
  assert.match(js, /searchParams\.set\(['"]workspace['"]/);
  assert.match(js, /chrome\.storage\.local/);
  assert.doesNotMatch(js, /chrome\.storage\.session\.set\(\{\s*launchUrls/);
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

test('manifest has version 1.0.0 and registered icon assets', () => {
  assert.equal(manifest.version, '1.0.0');
  assert.ok(manifest.icons);
  assert.equal(manifest.icons['16'], 'icons/icon-16.png');
  assert.equal(manifest.icons['32'], 'icons/icon-32.png');
  assert.equal(manifest.icons['48'], 'icons/icon-48.png');
  assert.equal(manifest.icons['128'], 'icons/icon-128.png');

  for (const size of [16, 32, 48, 128]) {
    assert.ok(fs.existsSync(`icons/icon-${size}.png`), `icons/icon-${size}.png must exist`);
  }
  assert.ok(fs.existsSync('icons/icon.svg'), 'icons/icon.svg must exist');
});

test('popup header is structured in 1 line with brand logo and right-aligned version', () => {
  assert.match(html, /<header class="app-header">[\s\S]*?<div class="header-brand">[\s\S]*?<img[^>]*class="header-logo"[\s\S]*?<span id="extensionVersion" class="version-badge">/);
  assert.match(css, /\.app-header\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.version-badge\s*\{[^}]*margin-left:\s*auto/);
});
