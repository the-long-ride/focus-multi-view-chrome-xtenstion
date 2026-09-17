(function initPopupRouter(global) {
  'use strict';

  function targetHostname(targetUrl) {
    try {
      const url = new URL(targetUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function decidePopupRoute({ sourceRegistered, sessionHostname, targetUrl, paneCount, maxPanes = 9 }) {
    if (!sourceRegistered) return { action: 'ignore' };
    const hostname = targetHostname(targetUrl);
    if (!hostname) return { action: 'native', reason: 'invalid-target' };
    if (hostname !== String(sessionHostname || '').toLowerCase()) return { action: 'native', reason: 'cross-host' };
    if (paneCount >= maxPanes) return { action: 'native', reason: 'pane-limit' };
    return { action: 'pane', targetUrl };
  }

  const api = { decidePopupRoute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MPVPopupRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
