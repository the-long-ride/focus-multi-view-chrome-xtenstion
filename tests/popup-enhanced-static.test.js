const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('popup.js', 'utf8');

test('same-host launch requests only narrowed optional origins and still launches on denial', () => {
  assert.match(js, /requestEnhancedPermissionForLaunch/);
  assert.match(js, /MPV\.sameHostPermissionOrigins/);
  assert.match(js, /chrome\.permissions\.contains/);
  assert.match(js, /chrome\.permissions\.request/);
  assert.match(js, /chrome\.tabs\.create/);
  assert.equal(js.includes("origins: ['http://*/*', 'https://*/*']"), false);
});

test('same-host launch persists an explicit enhanced opt-in hostname separately from host permission', () => {
  assert.match(js, /launchEnhancedHostname/);
  assert.match(js, /MPV\.analyzeSameHostUrls/);
});
