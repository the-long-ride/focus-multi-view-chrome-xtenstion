const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const js = fs.readFileSync('grid.js', 'utf8');

test('workspace state refresh does not reparent already-live iframe panes', () => {
  const match = js.match(/function applyWorkspaceState\([\s\S]*?\n}\n\nfunction handleGridPortMessage/);
  assert.ok(match, 'applyWorkspaceState function found');
  const body = match[0];

  assert.match(body, /if \(!pane\) \{[\s\S]*?container\.appendChild\(pane\.wrapper\);/);
  assert.doesNotMatch(
    body,
    /panes\s*=\s*desired;\s*for \(const pane of panes\) container\.appendChild\(pane\.wrapper\);/s,
    'state-only updates must not move live iframe wrappers because reparenting reloads their browsing contexts',
  );
});
