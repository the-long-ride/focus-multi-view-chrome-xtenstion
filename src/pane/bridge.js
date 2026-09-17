(() => {
  'use strict';
  if (globalThis.__mpvPaneBridgeInstalled) return;
  globalThis.__mpvPaneBridgeInstalled = true;

  const prefix = 'focus-pane:';
  const paneId = String(window.name || '').startsWith(prefix) ? String(window.name).slice(prefix.length) : '';
  if (!paneId) return;

  function snapshot(focused = document.hasFocus()) {
    return { paneId, url: location.href, title: document.title || '', focused: Boolean(focused) };
  }

  function send(type, focused) {
    try { chrome.runtime.sendMessage({ type, ...snapshot(focused) }); } catch { /* basic iframe mode remains usable */ }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'mpv:bridge-command' || message.paneId !== paneId) return undefined;
    if (message.command === 'back') history.back();
    else if (message.command === 'forward') history.forward();
    return undefined;
  });

  let lastTitle = document.title;
  const observer = new MutationObserver(() => {
    if (document.title === lastTitle) return;
    lastTitle = document.title;
    send('mpv:bridge-state');
  });
  const title = document.querySelector('title');
  if (title) observer.observe(title, { childList: true, subtree: true, characterData: true });
  else if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('popstate', () => send('mpv:bridge-state'), { passive: true });
  window.addEventListener('hashchange', () => send('mpv:bridge-state'), { passive: true });
  window.addEventListener('focus', () => send('mpv:bridge-state', true), { passive: true });
  document.addEventListener('pointerdown', () => send('mpv:bridge-state', true), { capture: true, passive: true });
  send('mpv:bridge-register');
})();
