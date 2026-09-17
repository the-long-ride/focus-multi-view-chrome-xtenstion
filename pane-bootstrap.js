'use strict';

const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspace') || '';
const paneId = params.get('pane') || '';

parent.postMessage({ type: 'mpv:pane-bootstrap-ready', workspaceId, paneId }, location.origin);

function receiveTarget(event) {
  if (event.source !== parent || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.type !== 'mpv:pane-bootstrap-target') return;
  if (message.workspaceId !== workspaceId || message.paneId !== paneId) return;
  const targetUrl = String(message.targetUrl || '');
  if (!/^https?:\/\//i.test(targetUrl)) return;
  window.removeEventListener('message', receiveTarget);
  location.replace(targetUrl);
}

window.addEventListener('message', receiveTarget);
