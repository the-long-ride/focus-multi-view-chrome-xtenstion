const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

test('manifest packages enhanced same-host runtime without making host access mandatory', () => {
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal('host_permissions' in manifest, false);
});

test('workspace restore adds no sessions or unlimitedStorage permissions', () => {
  assert.equal(manifest.permissions.includes('sessions'), false);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
