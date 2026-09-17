'use strict';

const { MAX_PANES, MAX_TEMPLATES } = MPV;

const versionEl = document.getElementById('extensionVersion');
const paneCountSelect = document.getElementById('paneCountSelect');
const paneCountButton = document.getElementById('paneCountButton');
const paneCountValue = document.getElementById('paneCountValue');
const paneCountList = document.getElementById('paneCountList');
const urlInputs = document.getElementById('urlInputs');
const launchBtn = document.getElementById('launch');
const launchError = document.getElementById('launchError');
const createTemplateBtn = document.getElementById('createTemplate');
const templateCount = document.getElementById('templateCount');
const templatesBody = document.getElementById('templatesBody');
const templatesEmpty = document.getElementById('templatesEmpty');
const templateModal = document.getElementById('templateModal');
const templateForm = document.getElementById('templateForm');
const templateModalEyebrow = document.getElementById('templateModalEyebrow');
const templateModalTitle = document.getElementById('templateModalTitle');
const closeTemplateModalBtn = document.getElementById('closeTemplateModal');
const cancelTemplateBtn = document.getElementById('cancelTemplate');
const saveTemplateBtn = document.getElementById('saveTemplate');
const templateName = document.getElementById('templateName');
const templateUrlInputs = document.getElementById('templateUrlInputs');
const templateUrlCount = document.getElementById('templateUrlCount');
const addTemplateUrlBtn = document.getElementById('addTemplateUrl');
const templateError = document.getElementById('templateError');

let paneCount = 2;
let templates = [];
let modalMode = 'create';
let editingTemplateId = null;
let activeSelectIndex = 0;

function setError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function getMainUrlValues() {
  return [...urlInputs.querySelectorAll('.url-input')].map((input) => input.value.trim());
}

function renderMainUrlInputs(count, existingValues = getMainUrlValues()) {
  urlInputs.innerHTML = '';
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement('div');
    row.className = 'url-row';

    const badge = document.createElement('span');
    badge.className = 'url-index';
    badge.textContent = String(index + 1);
    badge.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.className = 'url-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = `Pane ${index + 1} URL`;
    input.setAttribute('aria-label', `Pane ${index + 1} URL`);
    input.value = existingValues[index] || '';

    row.append(badge, input);
    urlInputs.appendChild(row);
  }
}

function setPaneCount(count, options = {}) {
  const next = Math.min(MAX_PANES, Math.max(2, Number(count) || 2));
  const previousValues = getMainUrlValues();
  paneCount = next;
  paneCountValue.textContent = `${next} panes`;
  activeSelectIndex = next - 2;
  [...paneCountList.querySelectorAll('.select-option')].forEach((option) => {
    const selected = Number(option.dataset.value) === next;
    option.setAttribute('aria-selected', String(selected));
    option.classList.toggle('active', selected);
  });
  if (options.renderInputs !== false) renderMainUrlInputs(next, options.values || previousValues);
}

function closePaneCountList({ focusButton = false } = {}) {
  paneCountList.hidden = true;
  paneCountButton.setAttribute('aria-expanded', 'false');
  if (focusButton) paneCountButton.focus();
}

function focusSelectOption(index) {
  const options = [...paneCountList.querySelectorAll('.select-option')];
  if (!options.length) return;
  activeSelectIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => option.classList.toggle('active', optionIndex === activeSelectIndex));
  options[activeSelectIndex].focus();
}

function openPaneCountList() {
  paneCountList.hidden = false;
  paneCountButton.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => focusSelectOption(paneCount - 2));
}

function buildPaneCountList() {
  paneCountList.innerHTML = '';
  for (let count = 2; count <= MAX_PANES; count += 1) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'select-option';
    option.dataset.value = String(count);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(count === paneCount));
    option.textContent = `${count} panes`;
    option.addEventListener('click', () => {
      setPaneCount(count);
      closePaneCountList({ focusButton: true });
    });
    option.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusSelectOption(activeSelectIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusSelectOption(activeSelectIndex - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusSelectOption(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusSelectOption(MAX_PANES - 2);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePaneCountList({ focusButton: true });
      }
    });
    paneCountList.appendChild(option);
  }
}

async function requestEnhancedPermissionForLaunch(urls) {
  const origins = MPV.sameHostPermissionOrigins(urls);
  if (!origins.length) return false;
  const request = { origins };
  try {
    if (await chrome.permissions.contains(request)) return true;
    return await chrome.permissions.request(request);
  } catch {
    return false;
  }
}

async function launchUrls(urls, rememberMainForm = false) {
  const cleanUrls = urls.map((url) => url.trim()).filter(Boolean).slice(0, MAX_PANES);
  if (cleanUrls.length < 2) {
    setError(launchError, 'Enter at least 2 URLs.');
    return;
  }

  const analysis = MPV.analyzeSameHostUrls(cleanUrls);
  const enhancedGranted = await requestEnhancedPermissionForLaunch(cleanUrls);
  const launchEnhancedHostname = enhancedGranted && analysis.eligible ? analysis.hostname : '';

  if (rememberMainForm) {
    await chrome.storage.local.set({ paneCount, paneUrls: cleanUrls });
  }
  await chrome.storage.session.set({ launchUrls: cleanUrls, launchEnhancedHostname });
  await chrome.tabs.create({ url: chrome.runtime.getURL('grid.html') });
}

function createActionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `table-action ${className || ''}`.trim();
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderTemplates() {
  templatesBody.innerHTML = '';
  templateCount.textContent = `${templates.length} of ${MAX_TEMPLATES} saved`;
  createTemplateBtn.disabled = templates.length >= MAX_TEMPLATES;
  templatesEmpty.hidden = templates.length > 0;
  document.getElementById('templatesTable').hidden = templates.length === 0;

  templates.forEach((template) => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'template-name';
    name.textContent = template.name;
    name.title = template.name;
    nameCell.appendChild(name);

    const countCell = document.createElement('td');
    countCell.textContent = String(template.urls.length);

    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'table-actions';
    actions.append(
      createActionButton('Open', 'open', () => launchUrls(template.urls)),
      createActionButton('View', '', () => openTemplateModal('view', template)),
      createActionButton('Edit', '', () => openTemplateModal('edit', template)),
      createActionButton('Delete', 'delete', () => deleteTemplate(template)),
    );
    actionsCell.appendChild(actions);

    row.append(nameCell, countCell, actionsCell);
    templatesBody.appendChild(row);
  });
}

async function persistTemplates() {
  templates = MPV.normalizeTemplates(templates);
  await chrome.storage.local.set({ templates });
  renderTemplates();
}

function getTemplateUrlValues() {
  return [...templateUrlInputs.querySelectorAll('.url-input')].map((input) => input.value);
}

function renderTemplateUrlInputs(values, readOnly = false) {
  const safeValues = Array.isArray(values) && values.length ? values.slice(0, MAX_PANES) : ['', ''];
  while (safeValues.length < 2) safeValues.push('');
  templateUrlInputs.innerHTML = '';

  safeValues.forEach((value, index) => {
    const row = document.createElement('div');
    row.className = 'template-url-row';

    const badge = document.createElement('span');
    badge.className = 'url-index';
    badge.textContent = String(index + 1);
    badge.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.className = 'url-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = `Pane ${index + 1} URL`;
    input.setAttribute('aria-label', `Template pane ${index + 1} URL`);
    input.value = value;
    input.disabled = readOnly;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-url-button';
    remove.textContent = '−';
    remove.title = 'Remove URL';
    remove.setAttribute('aria-label', `Remove URL ${index + 1}`);
    remove.disabled = readOnly || safeValues.length <= 2;
    remove.addEventListener('click', () => {
      const current = getTemplateUrlValues();
      current.splice(index, 1);
      renderTemplateUrlInputs(current, false);
    });

    row.append(badge, input, remove);
    templateUrlInputs.appendChild(row);
  });

  templateUrlCount.textContent = `${safeValues.length} / ${MAX_PANES}`;
  addTemplateUrlBtn.disabled = readOnly || safeValues.length >= MAX_PANES;
  addTemplateUrlBtn.hidden = readOnly;
}

function openTemplateModal(mode, template = null) {
  modalMode = mode;
  editingTemplateId = template ? template.id : null;
  setError(templateError);

  const isView = mode === 'view';
  const isEdit = mode === 'edit';
  templateModalEyebrow.textContent = isView ? 'Saved template' : isEdit ? 'Edit template' : 'New template';
  templateModalTitle.textContent = isView ? (template?.name || 'Template') : isEdit ? 'Edit template' : 'Create template';
  templateName.value = template?.name || '';
  templateName.disabled = isView;
  renderTemplateUrlInputs(template?.urls || getMainUrlValues().filter(Boolean).slice(0, MAX_PANES), isView);

  if (!templateUrlInputs.children.length) renderTemplateUrlInputs(['', ''], isView);

  saveTemplateBtn.hidden = isView;
  cancelTemplateBtn.textContent = isView ? 'Close' : 'Cancel';
  templateModal.showModal();
  requestAnimationFrame(() => {
    if (isView) cancelTemplateBtn.focus();
    else templateName.focus();
  });
}

function closeTemplateModal() {
  if (templateModal.open) templateModal.close();
  editingTemplateId = null;
  modalMode = 'create';
  setError(templateError);
}

async function deleteTemplate(template) {
  if (!confirm(`Delete template “${template.name}”?`)) return;
  templates = templates.filter((item) => item.id !== template.id);
  await persistTemplates();
}

async function saveTemplateFromModal(event) {
  event.preventDefault();
  if (modalMode === 'view') {
    closeTemplateModal();
    return;
  }

  const result = MPV.validateTemplateDraft(
    templateName.value,
    getTemplateUrlValues(),
    templates,
    editingTemplateId,
  );
  if (!result.valid) {
    setError(templateError, result.error);
    return;
  }

  if (modalMode === 'edit') {
    templates = templates.map((template) => (
      template.id === editingTemplateId
        ? { ...template, name: result.name, urls: result.urls }
        : template
    ));
  } else {
    templates = [...templates, {
      id: crypto.randomUUID(),
      name: result.name,
      urls: result.urls,
    }];
  }

  await persistTemplates();
  closeTemplateModal();
}

paneCountButton.addEventListener('click', () => {
  if (paneCountList.hidden) openPaneCountList();
  else closePaneCountList();
});

paneCountButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openPaneCountList();
  }
});

document.addEventListener('click', (event) => {
  if (!paneCountSelect.contains(event.target)) closePaneCountList();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !paneCountList.hidden) closePaneCountList({ focusButton: true });
});

launchBtn.addEventListener('click', async () => {
  setError(launchError);
  await launchUrls(getMainUrlValues(), true);
});

createTemplateBtn.addEventListener('click', () => openTemplateModal('create'));
closeTemplateModalBtn.addEventListener('click', closeTemplateModal);
cancelTemplateBtn.addEventListener('click', closeTemplateModal);
addTemplateUrlBtn.addEventListener('click', () => {
  const values = getTemplateUrlValues();
  if (values.length < MAX_PANES) renderTemplateUrlInputs([...values, ''], false);
});
templateForm.addEventListener('submit', saveTemplateFromModal);

templateModal.addEventListener('click', (event) => {
  if (event.target === templateModal) closeTemplateModal();
});

templateModal.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTemplateModal();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.templates) {
    templates = MPV.normalizeTemplates(changes.templates.newValue);
    renderTemplates();
  }
});

async function init() {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
  buildPaneCountList();

  const result = await chrome.storage.local.get(['paneCount', 'paneUrls', 'templates']);
  paneCount = Math.min(MAX_PANES, Math.max(2, Number(result.paneCount) || 2));
  setPaneCount(paneCount, { values: Array.isArray(result.paneUrls) ? result.paneUrls : [] });
  templates = MPV.normalizeTemplates(result.templates);
  renderTemplates();
}

init().catch((error) => {
  console.error('Popup initialization failed:', error);
  setError(launchError, 'Could not load extension settings.');
});
