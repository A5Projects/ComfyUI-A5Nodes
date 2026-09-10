import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CLASS_NAME = "A5PromptDatabase";
const API_BASE = "/a5prompt_database";
const DEFAULT_NODE_SIZE = [700, 650];
const MIN_NODE_SIZE = [360, 360];
const CATEGORIES = ["System", "Image", "Video"];
const DEFAULT_CATEGORY = CATEGORIES[0];
const SIZE_INITIALIZED_PROPERTY = "a5prompt_database_size_initialized";
const RECENT_PROMPT_LIMIT = 6;
const EDITOR_STYLE_ID = "a5prompt-database-editor-styles";
const openEditors = new WeakMap();
let editorZIndex = 10000;

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(node, widgetName, value) {
  const widget = findWidget(node, widgetName);
  if (!widget) {
    return;
  }
  widget.value = value;
  widget.callback?.(value);
  node.setDirtyCanvas(true, true);
}

function dirtyCanvas(node) {
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function getWidgetValue(node, widgetName) {
  const widget = findWidget(node, widgetName);
  return typeof widget?.value === "string" ? widget.value : "";
}

async function fetchJson(path, options = {}) {
  const response = await api.fetchApi(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

function filenameFromContentDisposition(headerValue, fallbackFilename) {
  const header = String(headerValue || "");
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  const filenameMatch = header.match(/filename="?([^";]+)"?/i);
  const rawFilename = utf8Match?.[1] || filenameMatch?.[1] || fallbackFilename;

  try {
    return decodeURIComponent(rawFilename);
  } catch {
    return rawFilename;
  }
}

async function downloadApiFile(path, fallbackFilename) {
  const response = await api.fetchApi(path);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Export failed with status ${response.status}`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filenameFromContentDisposition(
    response.headers.get("Content-Disposition"),
    fallbackFilename,
  );
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function categoryParam(category) {
  return `category=${encodeURIComponent(category || DEFAULT_CATEGORY)}`;
}

function getSelectedCategory(node) {
  return node.properties?.a5prompt_database_category || DEFAULT_CATEGORY;
}

function setSelectedCategory(node, category) {
  node.properties = node.properties || {};
  const nextCategory = category || DEFAULT_CATEGORY;
  if (node.properties.a5prompt_database_category !== nextCategory) {
    node.properties.a5prompt_database_category = nextCategory;
    node.setDirtyCanvas(true, true);
  }
}

function buildStyles(root) {
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "6px";
  root.style.width = "100%";
  root.style.boxSizing = "border-box";
  root.style.padding = "2px 8px 8px";
  root.style.color = "#cfd3df";
  root.style.font = "12px Arial, sans-serif";
}

function makeButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.border = "1px solid #4a4d60";
  button.style.borderRadius = "4px";
  button.style.background = "#2d3040";
  button.style.color = "#d8def4";
  button.style.cursor = "pointer";
  button.style.padding = "3px 7px";
  button.style.font = "12px Arial, sans-serif";
  button.style.lineHeight = "16px";
  return button;
}

function ensureEditorStyles() {
  if (document.getElementById(EDITOR_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = EDITOR_STYLE_ID;
  style.textContent = `
    .a5prompt-db-editor {
      position: fixed;
      display: flex;
      flex-direction: column;
      min-width: 420px;
      min-height: 300px;
      background: var(--comfy-menu-bg, #242424);
      color: var(--input-text, #ddd);
      border: 1px solid var(--border-color, #666);
      border-radius: 6px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      resize: both;
    }
    .a5prompt-db-editor__header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 36px;
      padding: 5px 6px 5px 10px;
      background: var(--comfy-input-bg, #333);
      border-bottom: 1px solid var(--border-color, #555);
      cursor: move;
      user-select: none;
    }
    .a5prompt-db-editor__title {
      flex: 0 0 auto;
      font: 13px Arial, sans-serif;
      color: inherit;
    }
    .a5prompt-db-editor__name,
    .a5prompt-db-editor__category {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      border-radius: 4px;
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      font: 12px Arial, sans-serif;
    }
    .a5prompt-db-editor__name {
      flex: 1;
      min-width: 120px;
      padding: 0 8px;
    }
    .a5prompt-db-editor__category {
      flex: 0 0 88px;
      padding: 0 6px;
    }
    .a5prompt-db-editor__button,
    .a5prompt-db-editor__close {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      border-radius: 4px;
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      cursor: pointer;
      font: 12px Arial, sans-serif;
    }
    .a5prompt-db-editor__button {
      flex: 0 0 auto;
      padding: 0 8px;
    }
    .a5prompt-db-editor__close {
      width: 28px;
      padding: 0;
      font-size: 16px;
      border: 0;
      background: transparent;
    }
    .a5prompt-db-editor__button:hover,
    .a5prompt-db-editor__close:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .a5prompt-db-editor__textarea {
      flex: 1;
      min-height: 0;
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      border: 0;
      outline: 0;
      resize: none;
      background: var(--comfy-input-bg, #1f1f1f);
      color: var(--input-text, #eee);
      font: 14px/1.45 monospace;
      letter-spacing: 0;
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(style);
}

function makeCategorySelect(node) {
  const select = document.createElement("select");
  select.title = "Saved prompt category";
  select.style.border = "1px solid #4a4d60";
  select.style.borderRadius = "4px";
  select.style.background = "#191c28";
  select.style.color = "#d8def4";
  select.style.cursor = "pointer";
  select.style.padding = "3px 6px";
  select.style.font = "12px Arial, sans-serif";
  select.style.lineHeight = "16px";
  select.style.maxWidth = "90px";

  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  }

  select.value = CATEGORIES.includes(getSelectedCategory(node))
    ? getSelectedCategory(node)
    : DEFAULT_CATEGORY;
  setSelectedCategory(node, select.value);
  return select;
}

function makePromptSelect() {
  const select = document.createElement("select");
  select.title = "All saved prompts in this category";
  select.style.flex = "1";
  select.style.minWidth = "0";
  select.style.border = "1px solid #4a4d60";
  select.style.borderRadius = "4px";
  select.style.background = "#191c28";
  select.style.color = "#d8def4";
  select.style.cursor = "pointer";
  select.style.padding = "3px 6px";
  select.style.font = "12px Arial, sans-serif";
  select.style.lineHeight = "16px";
  return select;
}

function createStatus() {
  const status = document.createElement("div");
  status.style.minHeight = "14px";
  status.style.fontSize = "11px";
  status.style.color = "#8f96aa";
  status.style.whiteSpace = "nowrap";
  status.style.overflow = "hidden";
  status.style.textOverflow = "ellipsis";
  return status;
}

function setStatus(status, message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#ff8fa3" : "#8f96aa";
}

function ensureNodeSize(node, targetSize = MIN_NODE_SIZE) {
  const width = Math.max(node.size?.[0] || 0, targetSize[0]);
  const height = Math.max(node.size?.[1] || 0, targetSize[1]);

  if (node.size?.[0] >= width && node.size?.[1] >= height) {
    return;
  }

  const size = [width, height];
  if (typeof node.setSize === "function") {
    node.setSize(size);
  } else {
    node.size = size;
  }
  node.setDirtyCanvas(true, true);
}

function ensureInitialNodeSize(node) {
  node.properties = node.properties || {};
  if (node.properties[SIZE_INITIALIZED_PROPERTY]) {
    return;
  }
  ensureNodeSize(node, DEFAULT_NODE_SIZE);
  node.properties[SIZE_INITIALIZED_PROPERTY] = true;
  node.setDirtyCanvas(true, true);
}

function bringEditorToFront(editor) {
  editorZIndex += 1;
  editor.panel.style.zIndex = String(editorZIndex);
}

function positionEditorPanel(panel) {
  panel.style.width = `${Math.min(780, Math.max(420, window.innerWidth - 32))}px`;
  panel.style.height = `${Math.min(560, Math.max(300, window.innerHeight - 32))}px`;

  const offset = (editorZIndex - 10000) % 6 * 18;
  const width = parseInt(panel.style.width, 10);
  const height = parseInt(panel.style.height, 10);
  panel.style.left = `${Math.max(16, (window.innerWidth - width) / 2 + offset)}px`;
  panel.style.top = `${Math.max(16, (window.innerHeight - height) / 2 + offset)}px`;
}

function makeEditorDraggable(editor) {
  editor.header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, input, select, textarea")) {
      return;
    }

    event.preventDefault();
    bringEditorToFront(editor);
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = editor.panel.offsetLeft;
    const startTop = editor.panel.offsetTop;

    const move = (moveEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - editor.panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - editor.header.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, startLeft + moveEvent.clientX - startX));
      const top = Math.min(maxTop, Math.max(0, startTop + moveEvent.clientY - startY));
      editor.panel.style.left = `${left}px`;
      editor.panel.style.top = `${top}px`;
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  });
}

function closeEditor(node) {
  const editor = openEditors.get(node);
  if (!editor) {
    return;
  }
  editor.panel.remove();
  openEditors.delete(node);
}

function syncOpenEditor(node) {
  const editor = openEditors.get(node);
  if (!editor) {
    return;
  }
  editor.nameInput.value = getWidgetValue(node, "name");
  editor.textarea.value = getWidgetValue(node, "prompt");
}

function openPromptEditor(node, categorySelect, refresh, saveCurrent) {
  const existing = openEditors.get(node);
  if (existing) {
    existing.nameInput.value = getWidgetValue(node, "name");
    existing.categorySelect.value = categorySelect.value || DEFAULT_CATEGORY;
    existing.textarea.value = getWidgetValue(node, "prompt");
    bringEditorToFront(existing);
    existing.textarea.focus();
    return;
  }

  ensureEditorStyles();

  const panel = document.createElement("section");
  panel.className = "a5prompt-db-editor";
  positionEditorPanel(panel);

  const header = document.createElement("header");
  header.className = "a5prompt-db-editor__header";

  const title = document.createElement("div");
  title.className = "a5prompt-db-editor__title";
  title.textContent = "A5Prompt";

  const nameInput = document.createElement("input");
  nameInput.className = "a5prompt-db-editor__name";
  nameInput.placeholder = "name";
  nameInput.value = getWidgetValue(node, "name");

  const editorCategorySelect = document.createElement("select");
  editorCategorySelect.className = "a5prompt-db-editor__category";
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    editorCategorySelect.appendChild(option);
  }
  editorCategorySelect.value = categorySelect.value || DEFAULT_CATEGORY;

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "a5prompt-db-editor__button";
  saveButton.textContent = "Save/Update";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "a5prompt-db-editor__close";
  closeButton.textContent = "X";
  closeButton.title = "Close editor";

  const textarea = document.createElement("textarea");
  textarea.className = "a5prompt-db-editor__textarea";
  textarea.value = getWidgetValue(node, "prompt");
  textarea.spellcheck = true;

  header.append(title, nameInput, editorCategorySelect, saveButton, closeButton);
  panel.append(header, textarea);
  document.body.appendChild(panel);

  const editor = { panel, header, nameInput, categorySelect: editorCategorySelect, textarea };
  openEditors.set(node, editor);
  bringEditorToFront(editor);
  makeEditorDraggable(editor);

  panel.addEventListener("pointerdown", () => bringEditorToFront(editor));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEditor(node);
    }
  });
  closeButton.addEventListener("click", () => closeEditor(node));
  nameInput.addEventListener("input", () => setWidgetValue(node, "name", nameInput.value));
  textarea.addEventListener("input", () => setWidgetValue(node, "prompt", textarea.value));
  editorCategorySelect.addEventListener("change", () => {
    categorySelect.value = editorCategorySelect.value;
    setSelectedCategory(node, editorCategorySelect.value);
    refresh();
  });
  saveButton.addEventListener("click", async () => {
    setWidgetValue(node, "name", nameInput.value);
    setWidgetValue(node, "prompt", textarea.value);
    categorySelect.value = editorCategorySelect.value;
    setSelectedCategory(node, editorCategorySelect.value);
    await saveCurrent();
  });

  textarea.focus();
}

function sortPrompts(prompts) {
  return [...prompts].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function timestampValue(prompt) {
  return Date.parse(prompt.last_used_at || prompt.updated_at || prompt.created_at || "") || 0;
}

function recentPrompts(prompts) {
  return [...prompts]
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .slice(0, RECENT_PROMPT_LIMIT);
}

function findPromptById(prompts, promptId) {
  return prompts.find((prompt) => String(prompt.id) === String(promptId));
}

function promptLabel(prompt) {
  const normalized = String(prompt.text || "").replace(/\s+/g, " ").trim();
  return `${prompt.name}: ${normalized}`;
}

async function markPromptUsed(promptId) {
  return await fetchJson(`${API_BASE}/prompts/${encodeURIComponent(promptId)}/touch`, {
    method: "POST",
  });
}

async function loadPrompt(node, prompt, status, refresh) {
  if (!prompt) {
    return;
  }

  setWidgetValue(node, "name", prompt.name);
  setWidgetValue(node, "prompt", prompt.text);
  syncOpenEditor(node);

  try {
    await markPromptUsed(prompt.id);
    await refresh();
    setStatus(status, `Loaded ${prompt.name}`);
  } catch (error) {
    setStatus(status, `Loaded ${prompt.name}; recent update failed`, true);
  }
}

function renderPromptSelect(select, prompts) {
  const previousValue = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = prompts.length ? "All prompts..." : "No saved prompts";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const prompt of sortPrompts(prompts)) {
    const option = document.createElement("option");
    option.value = prompt.id;
    option.textContent = prompt.name;
    option.title = promptLabel(prompt);
    select.appendChild(option);
  }

  if (findPromptById(prompts, previousValue)) {
    select.value = previousValue;
  }
  select.disabled = prompts.length === 0;
}

function renderRecentPromptButtons(node, list, prompts, status, refresh) {
  list.replaceChildren();

  if (!prompts.length) {
    const empty = document.createElement("div");
    empty.textContent = "No recent prompts";
    empty.style.color = "#777d90";
    empty.style.fontStyle = "italic";
    empty.style.padding = "4px 2px";
    list.appendChild(empty);
    return;
  }

  for (const prompt of recentPrompts(prompts)) {
    const row = document.createElement("div");
    row.title = promptLabel(prompt);
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.minWidth = "0";
    row.style.border = "1px solid #3c4054";
    row.style.borderRadius = "4px";
    row.style.background = "#191c28";
    row.style.overflow = "hidden";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.title = prompt.text;
    loadButton.style.flex = "1";
    loadButton.style.minWidth = "0";
    loadButton.style.display = "block";
    loadButton.style.border = "0";
    loadButton.style.background = "transparent";
    loadButton.style.color = "#d8def4";
    loadButton.style.cursor = "pointer";
    loadButton.style.padding = "4px 6px";
    loadButton.style.font = "12px Arial, sans-serif";

    const name = document.createElement("span");
    name.textContent = prompt.name;
    name.style.color = "#83aaff";
    name.style.display = "block";
    name.style.width = "100%";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";

    loadButton.appendChild(name);
    loadButton.addEventListener("click", async () => {
      await loadPrompt(node, prompt, status, refresh);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "x";
    deleteButton.title = `Delete ${prompt.name}`;
    deleteButton.style.flex = "0 0 24px";
    deleteButton.style.border = "0";
    deleteButton.style.borderLeft = "1px solid #3c4054";
    deleteButton.style.background = "transparent";
    deleteButton.style.color = "#b8bed0";
    deleteButton.style.cursor = "pointer";
    deleteButton.style.padding = "4px 0";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await fetchJson(`${API_BASE}/prompts/${encodeURIComponent(prompt.id)}`, {
          method: "DELETE",
        });
        await refresh();
        setStatus(status, `Deleted ${prompt.name}`);
      } catch (error) {
        setStatus(status, error.message, true);
      }
    });

    row.append(loadButton, deleteButton);
    list.appendChild(row);
  }
}

function attachPromptDatabaseUi(node) {
  if (node.__a5PromptDatabaseUi) {
    return;
  }
  node.__a5PromptDatabaseUi = true;

  const root = document.createElement("div");
  buildStyles(root);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "6px";
  actions.style.alignItems = "center";
  actions.style.flexWrap = "wrap";

  const saveButton = makeButton("Save/Update", "Save or update the current prompt by name");
  const categorySelect = makeCategorySelect(node);
  const editorButton = makeButton("Editor", "Open a larger prompt editor");
  const exportButton = makeButton("Export TXT", "Export saved prompts as a text file");
  const deleteAllButton = makeButton("Delete All", "Delete all saved prompts");
  deleteAllButton.style.color = "#ff9daf";

  actions.append(saveButton, categorySelect, editorButton, exportButton, deleteAllButton);

  const allPromptRow = document.createElement("div");
  allPromptRow.style.display = "flex";
  allPromptRow.style.gap = "6px";
  allPromptRow.style.alignItems = "center";
  allPromptRow.style.minWidth = "0";

  const promptSelect = makePromptSelect();
  const loadSelectedButton = makeButton("Load", "Load the selected saved prompt");
  const deleteSelectedButton = makeButton("Delete", "Delete the selected saved prompt");
  deleteSelectedButton.style.color = "#ff9daf";
  allPromptRow.append(promptSelect, loadSelectedButton, deleteSelectedButton);

  const header = document.createElement("div");
  header.textContent = "Recent Prompts";
  header.style.color = "#aeb5ca";
  header.style.marginTop = "2px";

  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
  list.style.gap = "4px";
  list.style.maxHeight = "112px";
  list.style.overflowY = "auto";
  list.style.paddingRight = "2px";

  const status = createStatus();
  root.append(actions, allPromptRow, header, list, status);

  let currentPrompts = [];

  const refresh = async () => {
    try {
      const category = categorySelect.value || DEFAULT_CATEGORY;
      const data = await fetchJson(`${API_BASE}/prompts?${categoryParam(category)}`);
      const prompts = data.prompts || [];
      currentPrompts = prompts;
      renderPromptSelect(promptSelect, prompts);
      renderRecentPromptButtons(node, list, prompts, status, refresh);
      exportButton.style.display = prompts.length ? "" : "none";
      deleteAllButton.style.display = prompts.length ? "" : "none";
      loadSelectedButton.style.display = prompts.length ? "" : "none";
      deleteSelectedButton.style.display = prompts.length ? "" : "none";
      setStatus(status, prompts.length ? `${prompts.length} saved in ${category}` : "");
    } catch (error) {
      setStatus(status, error.message, true);
    }
  };

  categorySelect.addEventListener("change", () => {
    setSelectedCategory(node, categorySelect.value);
    const editor = openEditors.get(node);
    if (editor) {
      editor.categorySelect.value = categorySelect.value;
    }
    refresh();
  });

  promptSelect.addEventListener("change", async () => {
    const prompt = findPromptById(currentPrompts, promptSelect.value);
    await loadPrompt(node, prompt, status, refresh);
  });

  loadSelectedButton.addEventListener("click", async () => {
    const prompt = findPromptById(currentPrompts, promptSelect.value);
    if (!prompt) {
      setStatus(status, "Choose a prompt first", true);
      return;
    }
    await loadPrompt(node, prompt, status, refresh);
  });

  deleteSelectedButton.addEventListener("click", async () => {
    const prompt = findPromptById(currentPrompts, promptSelect.value);
    if (!prompt) {
      setStatus(status, "Choose a prompt first", true);
      return;
    }
    if (!confirm(`Delete saved prompt "${prompt.name}"?`)) {
      return;
    }
    try {
      await fetchJson(`${API_BASE}/prompts/${encodeURIComponent(prompt.id)}`, {
        method: "DELETE",
      });
      await refresh();
      setStatus(status, `Deleted ${prompt.name}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  const saveCurrent = async () => {
    try {
      const category = categorySelect.value || DEFAULT_CATEGORY;
      const name = getWidgetValue(node, "name");
      const text = getWidgetValue(node, "prompt");
      const data = await fetchJson(`${API_BASE}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name, text }),
      });
      currentPrompts = data.database?.prompts || [];
      renderPromptSelect(promptSelect, currentPrompts);
      renderRecentPromptButtons(node, list, currentPrompts, status, refresh);
      syncOpenEditor(node);
      setStatus(status, `Saved ${data.prompt?.name || name} in ${category}`);
      exportButton.style.display = "";
      deleteAllButton.style.display = "";
      loadSelectedButton.style.display = "";
      deleteSelectedButton.style.display = "";
    } catch (error) {
      setStatus(status, error.message, true);
    }
  };

  saveButton.addEventListener("click", async () => {
    await saveCurrent();
  });

  editorButton.addEventListener("click", () => {
    openPromptEditor(node, categorySelect, refresh, saveCurrent);
  });

  exportButton.addEventListener("click", async () => {
    const category = categorySelect.value || DEFAULT_CATEGORY;
    const path = `${API_BASE}/export?${categoryParam(category)}`;
    try {
      await downloadApiFile(path, "a5prompt_database_prompts.txt");
      setStatus(status, `Exported ${category}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  deleteAllButton.addEventListener("click", async () => {
    const category = categorySelect.value || DEFAULT_CATEGORY;
    if (!confirm(`Delete all saved A5Prompt Database prompts in ${category}?`)) {
      return;
    }
    try {
      await fetchJson(`${API_BASE}/prompts?${categoryParam(category)}`, { method: "DELETE" });
      currentPrompts = [];
      renderPromptSelect(promptSelect, []);
      renderRecentPromptButtons(node, list, [], status, refresh);
      exportButton.style.display = "none";
      deleteAllButton.style.display = "none";
      loadSelectedButton.style.display = "none";
      deleteSelectedButton.style.display = "none";
      setStatus(status, `Deleted all prompts in ${category}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  node.addDOMWidget("a5prompt_database_ui", "A5Prompt Database", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });

  const baseComputeSize = node.computeSize;
  node.computeSize = function () {
    const size = baseComputeSize ? baseComputeSize.apply(this, arguments) : [300, 200];
    size[0] = Math.max(size[0], MIN_NODE_SIZE[0]);
    size[1] = Math.max(size[1], MIN_NODE_SIZE[1]);
    return size;
  };

  ensureInitialNodeSize(node);
  setTimeout(() => ensureInitialNodeSize(node), 0);
  setTimeout(refresh, 0);
}

app.registerExtension({
  name: "comfyui_A5Prompt_database.ui",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const comfyClass = nodeType.comfyClass ?? nodeType.ComfyClass ?? nodeData.name;
    if (comfyClass !== CLASS_NAME) {
      return;
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      attachPromptDatabaseUi(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      closeEditor(this);
      return onRemoved?.apply(this, arguments);
    };
  },
  async nodeCreated(node) {
    const comfyClass = node.comfyClass ?? node.ComfyClass;
    if (comfyClass === CLASS_NAME) {
      attachPromptDatabaseUi(node);
    }
  },
});
