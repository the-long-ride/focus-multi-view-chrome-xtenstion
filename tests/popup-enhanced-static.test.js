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

test('same-host launch persists explicit enhanced opt-in in the durable workspace', () => {
  assert.match(js, /launchEnhancedHostname/);
  assert.match(js, /MPV\.analyzeSameHostUrls/);
  assert.match(js, /ui:\s*\{\s*enhancedOptInHostname:\s*launchEnhancedHostname\s*\}/s);
  assert.doesNotMatch(js, /chrome\.storage\.session\.set\(\{[\s\S]*launchEnhancedHostname/);
});
