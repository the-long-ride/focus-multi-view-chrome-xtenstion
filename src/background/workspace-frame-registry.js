(function initWorkspaceFrameRegistry(global) {
  'use strict';

  function cleanId(value) {
    const id = String(value || '').trim();
    return id && id.length <= 256 ? id : '';
  }

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'chrome-extension:' ? url.href : '';
    } catch {
      return '';
    }
  }

  class WorkspaceFrameRegistry {
    constructor() {
      this.workspaces = new Map();
    }

    registerWorkspace({ tabId, workspaceId, paneIds }) {
      const id = cleanId(workspaceId);
      if (!Number.isInteger(tabId) || tabId < 0 || !id) return false;
      const panes = new Set(Array.from(paneIds || []).map(cleanId).filter(Boolean));
      if (!panes.size) return false;
      const current = this.workspaces.get(tabId);
      const preserve = current?.workspaceId === id;
      const next = {
        tabId,
        workspaceId: id,
        paneIds: panes,
        byPane: preserve ? current.byPane : new Map(),
        paneByFrame: preserve ? current.paneByFrame : new Map(),
      };
      this.workspaces.set(tabId, next);
      this.replacePaneIds(tabId, id, panes);
      return true;
    }

    replacePaneIds(tabId, workspaceId, paneIds) {
      const workspace = this.workspaces.get(tabId);
      if (!workspace || workspace.workspaceId !== cleanId(workspaceId)) return false;
      workspace.paneIds = new Set(Array.from(paneIds || []).map(cleanId).filter(Boolean));
      for (const [paneId, record] of [...workspace.byPane.entries()]) {
        if (!workspace.paneIds.has(paneId)) {
          workspace.byPane.delete(paneId);
          workspace.paneByFrame.delete(record.frameId);
        }
      }
      return workspace.paneIds.size > 0;
    }

    bindBootstrap({ tabId, frameId, documentId, workspaceId, paneId }) {
      const workspace = this.workspaces.get(tabId);
      const cleanWorkspaceId = cleanId(workspaceId);
      const cleanPaneId = cleanId(paneId);
      const cleanDocumentId = cleanId(documentId);
      if (!workspace || workspace.workspaceId !== cleanWorkspaceId || !workspace.paneIds.has(cleanPaneId)) return null;
      if (!Number.isInteger(frameId) || frameId <= 0 || !cleanDocumentId) return null;

      const frameOwner = workspace.paneByFrame.get(frameId);
      if (frameOwner && frameOwner !== cleanPaneId) return null;
      const existing = workspace.byPane.get(cleanPaneId);
      if (existing && existing.frameId !== frameId) workspace.paneByFrame.delete(existing.frameId);

      const record = {
        tabId,
        workspaceId: cleanWorkspaceId,
        paneId: cleanPaneId,
        frameId,
        documentId: cleanDocumentId,
        url: '',
      };
      workspace.byPane.set(cleanPaneId, record);
      workspace.paneByFrame.set(frameId, cleanPaneId);
      return { ...record };
    }

    updateDocument({ tabId, frameId, documentId, url }) {
      const workspace = this.workspaces.get(tabId);
      const paneId = workspace?.paneByFrame.get(frameId);
      const record = paneId ? workspace.byPane.get(paneId) : null;
      const cleanDocumentId = cleanId(documentId);
      const cleanDocumentUrl = cleanUrl(url);
      if (!record || !cleanDocumentId || !cleanDocumentUrl) return null;
      const next = { ...record, documentId: cleanDocumentId, url: cleanDocumentUrl };
      workspace.byPane.set(paneId, next);
      return { ...next };
    }

    findPaneByFrame(tabId, frameId) {
      const workspace = this.workspaces.get(tabId);
      const paneId = workspace?.paneByFrame.get(frameId);
      const record = paneId ? workspace.byPane.get(paneId) : null;
      return record ? { ...record } : null;
    }

    getPane(tabId, paneId) {
      const record = this.workspaces.get(tabId)?.byPane.get(cleanId(paneId));
      return record ? { ...record } : null;
    }

    getWorkspace(tabId) {
      const workspace = this.workspaces.get(tabId);
      if (!workspace) return null;
      return {
        tabId: workspace.tabId,
        workspaceId: workspace.workspaceId,
        paneIds: [...workspace.paneIds],
      };
    }

    removeFrame(tabId, frameId) {
      const workspace = this.workspaces.get(tabId);
      const paneId = workspace?.paneByFrame.get(frameId);
      if (!paneId) return;
      workspace.paneByFrame.delete(frameId);
      workspace.byPane.delete(paneId);
    }

    removeWorkspace(tabId) {
      this.workspaces.delete(tabId);
    }

    serialize() {
      return {
        version: 1,
        workspaces: [...this.workspaces.values()].map((workspace) => ({
          tabId: workspace.tabId,
          workspaceId: workspace.workspaceId,
          paneIds: [...workspace.paneIds],
          frames: [...workspace.byPane.values()].map((record) => ({ ...record })),
        })),
      };
    }

    restore(snapshot) {
      this.workspaces.clear();
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.workspaces)) return;
      for (const rawWorkspace of snapshot.workspaces) {
        if (!this.registerWorkspace(rawWorkspace)) continue;
        for (const rawRecord of Array.isArray(rawWorkspace.frames) ? rawWorkspace.frames : []) {
          const bound = this.bindBootstrap(rawRecord);
          if (!bound) continue;
          if (rawRecord.url) this.updateDocument(rawRecord);
        }
      }
    }
  }

  const api = { WorkspaceFrameRegistry };
  global.MPVWorkspaceFrameRegistry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
