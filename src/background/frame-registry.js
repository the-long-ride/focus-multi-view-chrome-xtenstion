(function initFrameRegistry(global) {
  'use strict';

  function safeHostname(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
  }

  class FrameRegistry {
    constructor() {
      this.sessions = new Map();
      this.committed = new Map();
    }

    documentKey(tabId, frameId) {
      return `${tabId}:${frameId}`;
    }

    clearCommittedForTab(tabId) {
      for (const key of [...this.committed.keys()]) {
        if (key.startsWith(`${tabId}:`)) this.committed.delete(key);
      }
    }

    snapshotSession(session) {
      return session ? {
        tabId: session.tabId,
        sessionId: session.sessionId,
        hostname: session.hostname,
        paneIds: [...session.paneIds],
      } : null;
    }

    registerSession({ tabId, sessionId, hostname, paneIds }) {
      if (!Number.isInteger(tabId) || !sessionId || !hostname) return null;
      const normalizedHostname = String(hostname).toLowerCase();
      const panes = new Set(Array.from(paneIds || []).filter(Boolean));
      const current = this.sessions.get(tabId);
      const preserve = current?.sessionId === sessionId && current?.hostname === normalizedHostname;

      if (!preserve) this.clearCommittedForTab(tabId);

      const session = {
        tabId,
        sessionId,
        hostname: normalizedHostname,
        paneIds: panes,
        paneById: preserve ? current.paneById : new Map(),
        paneIdByFrame: preserve ? current.paneIdByFrame : new Map(),
      };
      this.sessions.set(tabId, session);
      this.updateSessionPanes(tabId, sessionId, panes);
      return this.snapshotSession(session);
    }

    detachFrameMapping(tabId, frameId) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      if (paneId) session.paneById.delete(paneId);
      session?.paneIdByFrame.delete(frameId);
    }

    recordCommittedDocument({ tabId, frameId, documentId, url }) {
      const session = this.sessions.get(tabId);
      if (!session || !Number.isInteger(frameId) || frameId <= 0 || !documentId) return false;
      if (safeHostname(url) !== session.hostname) return false;
      this.detachFrameMapping(tabId, frameId);
      this.committed.set(this.documentKey(tabId, frameId), { documentId, url });
      return true;
    }

    registerPaneFrame(input) {
      const { tabId, frameId, documentId, paneId, url } = input;
      const session = this.sessions.get(tabId);
      const committed = this.committed.get(this.documentKey(tabId, frameId));
      if (!session || !session.paneIds.has(paneId) || !committed || committed.documentId !== documentId) return null;
      if (safeHostname(url) !== session.hostname) return null;

      const claimedPaneId = session.paneIdByFrame.get(frameId);
      if (claimedPaneId && claimedPaneId !== paneId) return null;

      const previous = session.paneById.get(paneId);
      if (previous && previous.frameId !== frameId) session.paneIdByFrame.delete(previous.frameId);

      const record = {
        tabId,
        frameId,
        documentId,
        paneId,
        url,
        title: String(input.title || ''),
        focused: input.focused === true,
        loading: input.loading === true,
      };
      session.paneById.set(paneId, record);
      session.paneIdByFrame.set(frameId, paneId);
      return { ...record };
    }

    updatePaneFrame(input) {
      const session = this.sessions.get(input.tabId);
      const current = session?.paneById.get(input.paneId);
      if (!current || current.frameId !== input.frameId || current.documentId !== input.documentId) return null;
      if (input.url && safeHostname(input.url) !== session.hostname) return null;
      const next = {
        ...current,
        ...(input.url ? { url: input.url } : {}),
        ...(input.title !== undefined ? { title: String(input.title || '') } : {}),
        ...(input.focused !== undefined ? { focused: input.focused === true } : {}),
        ...(input.loading !== undefined ? { loading: input.loading === true } : {}),
      };
      session.paneById.set(input.paneId, next);
      return { ...next };
    }

    getPane(tabId, paneId) {
      const record = this.sessions.get(tabId)?.paneById.get(paneId);
      return record ? { ...record } : null;
    }

    findPaneByFrame(tabId, frameId) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      return paneId ? this.getPane(tabId, paneId) : null;
    }

    getSession(tabId) {
      return this.snapshotSession(this.sessions.get(tabId));
    }

    updateSessionPanes(tabId, sessionId, paneIds) {
      const session = this.sessions.get(tabId);
      if (!session || session.sessionId !== sessionId) return false;
      session.paneIds = new Set(Array.from(paneIds || []).filter(Boolean));
      for (const [paneId, record] of [...session.paneById.entries()]) {
        if (!session.paneIds.has(paneId)) {
          session.paneById.delete(paneId);
          session.paneIdByFrame.delete(record.frameId);
        }
      }
      return true;
    }

    setFrameLoading(tabId, frameId, loading) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      if (!paneId) return null;
      const record = session.paneById.get(paneId);
      if (!record) return null;
      record.loading = Boolean(loading);
      return { ...record };
    }

    removeFrame(tabId, frameId) {
      this.detachFrameMapping(tabId, frameId);
      this.committed.delete(this.documentKey(tabId, frameId));
    }

    removeSession(tabId) {
      this.sessions.delete(tabId);
      this.clearCommittedForTab(tabId);
    }
  }

  const api = { FrameRegistry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MPVFrameRegistry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
