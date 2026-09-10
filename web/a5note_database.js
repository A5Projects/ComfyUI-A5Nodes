import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CLASS_NAME = "A5NoteDatabase";
const API_BASE = "/a5note_database";
const DEFAULT_NODE_SIZE = [760, 720];
const MIN_NODE_SIZE = [460, 460];
const CATEGORIES = ["General", "Workflow", "Reference"];
const DEFAULT_CATEGORY = CATEGORIES[0];
const SIZE_INITIALIZED_PROPERTY = "a5note_database_size_initialized";
const RECENT_NOTE_LIMIT = 6;
const EDITOR_STYLE_ID = "a5note-database-editor-styles";
const INLINE_NOTE_HEIGHT = 390;
const openEditors = new WeakMap();
let editorZIndex = 10000;

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function dirtyCanvas(node) {
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function setWidgetValue(node, widgetName, value) {
  const widget = findWidget(node, widgetName);
  if (!widget) {
    return;
  }
  widget.value = value;
  widget.callback?.(value);
  dirtyCanvas(node);
}

function getWidgetValue(node, widgetName) {
  const widget = findWidget(node, widgetName);
  return typeof widget?.value === "string" ? widget.value : "";
}

function hideBackingWidget(widget) {
  if (!widget) {
    return;
  }

  for (const element of [widget.inputEl, widget.element]) {
    if (element?.style) {
      element.style.display = "none";
    }
  }

  if (widget.__a5NoteBackingHidden) {
    return;
  }

  widget.__a5NoteBackingHidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  widget.computedHeight = 0;
  widget.draw = () => {};
  widget.mouse = () => false;
}

function hideNoteBackingWidget(node) {
  hideBackingWidget(findWidget(node, "note"));
  for (const delay of [0, 250, 1000]) {
    setTimeout(() => hideBackingWidget(findWidget(node, "note")), delay);
  }
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
  return node.properties?.a5note_database_category || DEFAULT_CATEGORY;
}

function setSelectedCategory(node, category) {
  node.properties = node.properties || {};
  const nextCategory = category || DEFAULT_CATEGORY;
  if (node.properties.a5note_database_category !== nextCategory) {
    node.properties.a5note_database_category = nextCategory;
    dirtyCanvas(node);
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

function makeCategorySelect(node) {
  const select = document.createElement("select");
  select.title = "Saved note category";
  select.style.border = "1px solid #4a4d60";
  select.style.borderRadius = "4px";
  select.style.background = "#191c28";
  select.style.color = "#d8def4";
  select.style.cursor = "pointer";
  select.style.padding = "3px 6px";
  select.style.font = "12px Arial, sans-serif";
  select.style.lineHeight = "16px";
  select.style.maxWidth = "100px";

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

function makeNoteSelect() {
  const select = document.createElement("select");
  select.title = "All saved notes in this category";
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

  if (typeof node.setSize === "function") {
    node.setSize([width, height]);
  } else {
    node.size = [width, height];
  }
  dirtyCanvas(node);
}

function ensureInitialNodeSize(node) {
  node.properties = node.properties || {};
  if (node.properties[SIZE_INITIALIZED_PROPERTY]) {
    return;
  }
  ensureNodeSize(node, DEFAULT_NODE_SIZE);
  node.properties[SIZE_INITIALIZED_PROPERTY] = true;
  dirtyCanvas(node);
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function timestampValue(note) {
  return Date.parse(note.last_used_at || note.updated_at || note.created_at || "") || 0;
}

function recentNotes(notes) {
  return [...notes]
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .slice(0, RECENT_NOTE_LIMIT);
}

function findNoteById(notes, noteId) {
  return notes.find((note) => String(note.id) === String(noteId));
}

function noteLabel(note) {
  const normalized = String(note.text || "").replace(/\s+/g, " ").trim();
  return `${note.name}: ${normalized}`;
}

async function markNoteUsed(noteId) {
  return await fetchJson(`${API_BASE}/notes/${encodeURIComponent(noteId)}/touch`, {
    method: "POST",
  });
}

async function loadNote(node, note, status, refresh) {
  if (!note) {
    return;
  }

  setWidgetValue(node, "name", note.name);
  setWidgetValue(node, "note", note.text);
  syncInlineNote(node);
  syncOpenEditor(node);

  try {
    await markNoteUsed(note.id);
    await refresh();
    setStatus(status, `Loaded ${note.name}`);
  } catch (error) {
    setStatus(status, `Loaded ${note.name}; recent update failed`, true);
  }
}

function renderNoteSelect(select, notes) {
  const previousValue = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = notes.length ? "All notes..." : "No saved notes";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const note of sortNotes(notes)) {
    const option = document.createElement("option");
    option.value = note.id;
    option.textContent = note.name;
    option.title = noteLabel(note);
    select.appendChild(option);
  }

  if (findNoteById(notes, previousValue)) {
    select.value = previousValue;
  }
  select.disabled = notes.length === 0;
}

function renderRecentNoteButtons(node, list, notes, status, refresh) {
  list.replaceChildren();

  if (!notes.length) {
    const empty = document.createElement("div");
    empty.textContent = "No recent notes";
    empty.style.color = "#777d90";
    empty.style.fontStyle = "italic";
    empty.style.padding = "4px 2px";
    list.appendChild(empty);
    return;
  }

  for (const note of recentNotes(notes)) {
    const row = document.createElement("div");
    row.title = noteLabel(note);
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.minWidth = "0";
    row.style.border = "1px solid #3c4054";
    row.style.borderRadius = "4px";
    row.style.background = "#191c28";
    row.style.overflow = "hidden";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.title = note.text;
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
    name.textContent = note.name;
    name.style.color = "#83aaff";
    name.style.display = "block";
    name.style.width = "100%";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";

    loadButton.appendChild(name);
    loadButton.addEventListener("click", async () => {
      await loadNote(node, note, status, refresh);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "x";
    deleteButton.title = `Delete ${note.name}`;
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
        await fetchJson(`${API_BASE}/notes/${encodeURIComponent(note.id)}`, {
          method: "DELETE",
        });
        await refresh();
        setStatus(status, `Deleted ${note.name}`);
      } catch (error) {
        setStatus(status, error.message, true);
      }
    });

    row.append(loadButton, deleteButton);
    list.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseInlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^) \t]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return html;
}

function isBlockStart(line) {
  return /^(#{1,6})\s+/.test(line)
    || /^(```|~~~)/.test(line)
    || /^\s*([-*+]|\d+\.)\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function appendHtmlBlock(container, tagName, html) {
  const element = document.createElement(tagName);
  element.innerHTML = html;
  container.appendChild(element);
}

function renderMarkdown(markdown, container) {
  container.replaceChildren();
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) {
    const placeholder = document.createElement("div");
    placeholder.className = "a5note-db-empty";
    placeholder.textContent = "Click to edit note";
    container.appendChild(placeholder);
    return;
  }

  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (
      index + 1 < lines.length
      && !isBlockStart(line)
      && /^\s*(=+|-{2,})\s*$/.test(lines[index + 1])
    ) {
      const level = lines[index + 1].trim().startsWith("=") ? "h1" : "h2";
      appendHtmlBlock(container, level, parseInlineMarkdown(trimmed));
      index += 2;
      continue;
    }

    if (/^(```|~~~)/.test(trimmed)) {
      const fence = trimmed.slice(0, 3);
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      appendHtmlBlock(container, `h${heading[1].length}`, parseInlineMarkdown(heading[2]));
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      const list = document.createElement("ul");
      while (index < lines.length && /^\s*([-*+])\s+/.test(lines[index])) {
        appendHtmlBlock(list, "li", parseInlineMarkdown(lines[index].replace(/^\s*([-*+])\s+/, "")));
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement("ol");
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        appendHtmlBlock(list, "li", parseInlineMarkdown(lines[index].replace(/^\s*\d+\.\s+/, "")));
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      appendHtmlBlock(container, "blockquote", parseInlineMarkdown(quoteLines.join("<br>")));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    appendHtmlBlock(container, "p", parseInlineMarkdown(paragraphLines.join(" ")));
  }
}

function ensureEditorStyles() {
  if (document.getElementById(EDITOR_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = EDITOR_STYLE_ID;
  style.textContent = `
    .a5note-db-inline {
      height: ${INLINE_NOTE_HEIGHT}px;
      min-height: 160px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #555);
      border-radius: 4px;
      overflow: hidden;
      background: var(--comfy-input-bg, #1f1f1f);
    }
    .a5note-db-inline__preview,
    .a5note-db-inline__textarea {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      padding: 12px;
      border: 0;
      outline: 0;
      background: var(--comfy-input-bg, #1f1f1f);
      color: var(--input-text, #eee);
      letter-spacing: 0;
      overflow: auto;
    }
    .a5note-db-inline__preview {
      cursor: text;
      font: 18px/1.45 Arial, sans-serif;
    }
    .a5note-db-inline__textarea {
      display: none;
      resize: none;
      font: 15px/1.45 monospace;
      white-space: pre-wrap;
    }
    .a5note-db-editor {
      position: fixed;
      display: flex;
      flex-direction: column;
      min-width: 460px;
      min-height: 340px;
      background: var(--comfy-menu-bg, #242424);
      color: var(--input-text, #ddd);
      border: 1px solid var(--border-color, #666);
      border-radius: 6px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      resize: both;
    }
    .a5note-db-editor__header {
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
    .a5note-db-editor__title {
      flex: 0 0 auto;
      font: 13px Arial, sans-serif;
      color: inherit;
    }
    .a5note-db-editor__name,
    .a5note-db-editor__category {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      border-radius: 4px;
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      font: 12px Arial, sans-serif;
    }
    .a5note-db-editor__name {
      flex: 1;
      min-width: 120px;
      padding: 0 8px;
    }
    .a5note-db-editor__category {
      flex: 0 0 96px;
      padding: 0 6px;
    }
    .a5note-db-editor__button,
    .a5note-db-editor__close {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      border-radius: 4px;
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      cursor: pointer;
      font: 12px Arial, sans-serif;
    }
    .a5note-db-editor__button {
      flex: 0 0 auto;
      padding: 0 8px;
    }
    .a5note-db-editor__close {
      width: 28px;
      padding: 0;
      font-size: 16px;
      border: 0;
      background: transparent;
    }
    .a5note-db-editor__button:hover,
    .a5note-db-editor__close:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .a5note-db-editor__textarea,
    .a5note-db-editor__preview {
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
      letter-spacing: 0;
      overflow: auto;
    }
    .a5note-db-editor__textarea {
      font: 14px/1.45 monospace;
      white-space: pre-wrap;
    }
    .a5note-db-editor__preview {
      font: 14px/1.5 Arial, sans-serif;
      display: none;
    }
    .a5note-db-editor__preview h1,
    .a5note-db-editor__preview h2,
    .a5note-db-editor__preview h3,
    .a5note-db-inline__preview h1,
    .a5note-db-inline__preview h2,
    .a5note-db-inline__preview h3 {
      margin: 0.45em 0 0.25em;
      line-height: 1.2;
    }
    .a5note-db-editor__preview h1,
    .a5note-db-inline__preview h1 {
      font-size: 1.7em;
    }
    .a5note-db-editor__preview h2,
    .a5note-db-inline__preview h2 {
      font-size: 1.45em;
    }
    .a5note-db-editor__preview p,
    .a5note-db-inline__preview p {
      margin: 0 0 0.7em;
    }
    .a5note-db-editor__preview ul,
    .a5note-db-editor__preview ol,
    .a5note-db-inline__preview ul,
    .a5note-db-inline__preview ol {
      margin: 0 0 0.75em 1.4em;
      padding: 0;
    }
    .a5note-db-editor__preview li,
    .a5note-db-inline__preview li {
      margin: 0.12em 0;
    }
    .a5note-db-editor__preview code,
    .a5note-db-inline__preview code {
      background: rgba(255, 255, 255, 0.1);
      padding: 0.08em 0.25em;
      border-radius: 3px;
      font-family: monospace;
    }
    .a5note-db-editor__preview pre,
    .a5note-db-inline__preview pre {
      background: rgba(0, 0, 0, 0.25);
      padding: 8px;
      overflow: auto;
      border-radius: 4px;
    }
    .a5note-db-editor__preview blockquote,
    .a5note-db-inline__preview blockquote {
      margin: 0 0 0.7em;
      padding-left: 10px;
      border-left: 3px solid #69708a;
      color: #c4cad8;
    }
    .a5note-db-editor__preview hr,
    .a5note-db-inline__preview hr {
      border: 0;
      border-top: 1px solid #69708a;
      margin: 0.9em 0;
    }
    .a5note-db-empty {
      color: #777d90;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

function bringEditorToFront(editor) {
  editorZIndex += 1;
  editor.panel.style.zIndex = String(editorZIndex);
}

function positionEditorPanel(panel) {
  panel.style.width = `${Math.min(820, Math.max(460, window.innerWidth - 32))}px`;
  panel.style.height = `${Math.min(620, Math.max(340, window.innerHeight - 32))}px`;

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

function syncOpenEditor(node) {
  const editor = openEditors.get(node);
  if (!editor) {
    return;
  }
  editor.nameInput.value = getWidgetValue(node, "name");
  editor.textarea.value = getWidgetValue(node, "note");
  renderMarkdown(editor.textarea.value, editor.preview);
}

function syncInlineNote(node) {
  node.__a5NoteInlineView?.sync?.();
}

function closeEditor(node) {
  const editor = openEditors.get(node);
  if (!editor) {
    return;
  }
  editor.panel.remove();
  openEditors.delete(node);
}

function setEditorPreviewMode(editor, enabled) {
  editor.previewMode = enabled;
  editor.toggleButton.textContent = enabled ? "Edit" : "Preview";
  editor.textarea.style.display = enabled ? "none" : "block";
  editor.preview.style.display = enabled ? "block" : "none";
  if (enabled) {
    renderMarkdown(editor.textarea.value, editor.preview);
  }
}

function createInlineNoteView(node) {
  const wrapper = document.createElement("div");
  wrapper.className = "a5note-db-inline";

  const preview = document.createElement("div");
  preview.className = "a5note-db-inline__preview";
  preview.title = "Click to edit this note";

  const textarea = document.createElement("textarea");
  textarea.className = "a5note-db-inline__textarea";
  textarea.spellcheck = true;

  wrapper.append(preview, textarea);

  let editing = false;

  const sync = () => {
    const text = getWidgetValue(node, "note");
    if (!editing) {
      renderMarkdown(text, preview);
    }
    if (document.activeElement !== textarea) {
      textarea.value = text;
    }
  };

  const setEditing = (enabled) => {
    if (editing === enabled) {
      return;
    }
    editing = enabled;

    if (editing) {
      textarea.value = getWidgetValue(node, "note");
      preview.style.display = "none";
      textarea.style.display = "block";
      setTimeout(() => textarea.focus(), 0);
      return;
    }

    setWidgetValue(node, "note", textarea.value);
    preview.style.display = "block";
    textarea.style.display = "none";
    renderMarkdown(textarea.value, preview);
    syncOpenEditor(node);
  };

  preview.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  preview.addEventListener("click", () => setEditing(true));
  textarea.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  textarea.addEventListener("input", () => {
    setWidgetValue(node, "note", textarea.value);
    syncOpenEditor(node);
  });
  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      if (!wrapper.contains(document.activeElement)) {
        setEditing(false);
      }
    }, 0);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
    }
  });

  sync();
  return {
    element: wrapper,
    sync,
    edit: () => setEditing(true),
    preview: () => setEditing(false),
  };
}

function openNoteEditor(node, categorySelect, refresh, saveCurrent, startPreview = false) {
  const existing = openEditors.get(node);
  if (existing) {
    syncOpenEditor(node);
    existing.categorySelect.value = categorySelect.value || DEFAULT_CATEGORY;
    setEditorPreviewMode(existing, startPreview || existing.previewMode);
    bringEditorToFront(existing);
    if (!existing.previewMode) {
      existing.textarea.focus();
    }
    return;
  }

  ensureEditorStyles();

  const panel = document.createElement("section");
  panel.className = "a5note-db-editor";
  positionEditorPanel(panel);

  const header = document.createElement("header");
  header.className = "a5note-db-editor__header";

  const title = document.createElement("div");
  title.className = "a5note-db-editor__title";
  title.textContent = "A5Note";

  const nameInput = document.createElement("input");
  nameInput.className = "a5note-db-editor__name";
  nameInput.placeholder = "name";
  nameInput.value = getWidgetValue(node, "name");

  const editorCategorySelect = document.createElement("select");
  editorCategorySelect.className = "a5note-db-editor__category";
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    editorCategorySelect.appendChild(option);
  }
  editorCategorySelect.value = categorySelect.value || DEFAULT_CATEGORY;

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "a5note-db-editor__button";
  saveButton.textContent = "Save/Update";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "a5note-db-editor__button";
  toggleButton.textContent = "Preview";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "a5note-db-editor__close";
  closeButton.textContent = "X";
  closeButton.title = "Close editor";

  const textarea = document.createElement("textarea");
  textarea.className = "a5note-db-editor__textarea";
  textarea.value = getWidgetValue(node, "note");
  textarea.spellcheck = true;

  const preview = document.createElement("div");
  preview.className = "a5note-db-editor__preview";

  header.append(title, nameInput, editorCategorySelect, saveButton, toggleButton, closeButton);
  panel.append(header, textarea, preview);
  document.body.appendChild(panel);

  const editor = {
    panel,
    header,
    nameInput,
    categorySelect: editorCategorySelect,
    textarea,
    preview,
    toggleButton,
    previewMode: false,
  };
  openEditors.set(node, editor);
  bringEditorToFront(editor);
  makeEditorDraggable(editor);
  setEditorPreviewMode(editor, startPreview);

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
  textarea.addEventListener("input", () => {
    setWidgetValue(node, "note", textarea.value);
    syncInlineNote(node);
    if (editor.previewMode) {
      renderMarkdown(textarea.value, preview);
    }
  });
  editorCategorySelect.addEventListener("change", () => {
    categorySelect.value = editorCategorySelect.value;
    setSelectedCategory(node, editorCategorySelect.value);
    refresh();
  });
  saveButton.addEventListener("click", async () => {
    setWidgetValue(node, "name", nameInput.value);
    setWidgetValue(node, "note", textarea.value);
    categorySelect.value = editorCategorySelect.value;
    setSelectedCategory(node, editorCategorySelect.value);
    await saveCurrent();
  });
  toggleButton.addEventListener("click", () => {
    setEditorPreviewMode(editor, !editor.previewMode);
  });

  if (!startPreview) {
    textarea.focus();
  }
}

function attachNoteDatabaseUi(node) {
  if (node.__a5NoteDatabaseUi) {
    return;
  }
  node.__a5NoteDatabaseUi = true;
  hideNoteBackingWidget(node);
  ensureEditorStyles();

  const root = document.createElement("div");
  buildStyles(root);

  const inlineNoteView = createInlineNoteView(node);
  node.__a5NoteInlineView = inlineNoteView;

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "6px";
  actions.style.alignItems = "center";
  actions.style.flexWrap = "wrap";

  const saveButton = makeButton("Save/Update", "Save or update the current note by name");
  const categorySelect = makeCategorySelect(node);
  const editorButton = makeButton("Editor", "Open a larger markdown editor");
  const previewButton = makeButton("Preview", "Open markdown preview");
  const exportButton = makeButton("Export MD", "Export saved notes as Markdown");
  const deleteAllButton = makeButton("Delete All", "Delete all saved notes");
  deleteAllButton.style.color = "#ff9daf";

  actions.append(saveButton, categorySelect, editorButton, previewButton, exportButton, deleteAllButton);

  const allNoteRow = document.createElement("div");
  allNoteRow.style.display = "flex";
  allNoteRow.style.gap = "6px";
  allNoteRow.style.alignItems = "center";
  allNoteRow.style.minWidth = "0";

  const noteSelect = makeNoteSelect();
  const loadSelectedButton = makeButton("Load", "Load the selected saved note");
  const deleteSelectedButton = makeButton("Delete", "Delete the selected saved note");
  deleteSelectedButton.style.color = "#ff9daf";
  allNoteRow.append(noteSelect, loadSelectedButton, deleteSelectedButton);

  const header = document.createElement("div");
  header.textContent = "Recent Notes";
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
  root.append(inlineNoteView.element, actions, allNoteRow, header, list, status);

  let currentNotes = [];

  const refresh = async () => {
    try {
      const category = categorySelect.value || DEFAULT_CATEGORY;
      const data = await fetchJson(`${API_BASE}/notes?${categoryParam(category)}`);
      const notes = data.notes || [];
      currentNotes = notes;
      renderNoteSelect(noteSelect, notes);
      renderRecentNoteButtons(node, list, notes, status, refresh);
      exportButton.style.display = notes.length ? "" : "none";
      deleteAllButton.style.display = notes.length ? "" : "none";
      loadSelectedButton.style.display = notes.length ? "" : "none";
      deleteSelectedButton.style.display = notes.length ? "" : "none";
      setStatus(status, notes.length ? `${notes.length} saved in ${category}` : "");
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

  noteSelect.addEventListener("change", async () => {
    const note = findNoteById(currentNotes, noteSelect.value);
    await loadNote(node, note, status, refresh);
  });

  loadSelectedButton.addEventListener("click", async () => {
    const note = findNoteById(currentNotes, noteSelect.value);
    if (!note) {
      setStatus(status, "Choose a note first", true);
      return;
    }
    await loadNote(node, note, status, refresh);
  });

  deleteSelectedButton.addEventListener("click", async () => {
    const note = findNoteById(currentNotes, noteSelect.value);
    if (!note) {
      setStatus(status, "Choose a note first", true);
      return;
    }
    if (!confirm(`Delete saved note "${note.name}"?`)) {
      return;
    }
    try {
      await fetchJson(`${API_BASE}/notes/${encodeURIComponent(note.id)}`, {
        method: "DELETE",
      });
      await refresh();
      setStatus(status, `Deleted ${note.name}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  const saveCurrent = async () => {
    try {
      const category = categorySelect.value || DEFAULT_CATEGORY;
      const name = getWidgetValue(node, "name");
      const text = getWidgetValue(node, "note");
      const data = await fetchJson(`${API_BASE}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name, text }),
      });
      currentNotes = data.database?.notes || [];
      renderNoteSelect(noteSelect, currentNotes);
      renderRecentNoteButtons(node, list, currentNotes, status, refresh);
      syncInlineNote(node);
      setStatus(status, `Saved ${data.note?.name || name} in ${category}`);
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
    openNoteEditor(node, categorySelect, refresh, saveCurrent, false);
  });

  previewButton.addEventListener("click", () => {
    openNoteEditor(node, categorySelect, refresh, saveCurrent, true);
  });

  exportButton.addEventListener("click", async () => {
    const category = categorySelect.value || DEFAULT_CATEGORY;
    const path = `${API_BASE}/export?${categoryParam(category)}`;
    try {
      await downloadApiFile(path, "a5note_database_notes.md");
      setStatus(status, `Exported ${category}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  deleteAllButton.addEventListener("click", async () => {
    const category = categorySelect.value || DEFAULT_CATEGORY;
    if (!confirm(`Delete all saved A5Note_Database notes in ${category}?`)) {
      return;
    }
    try {
      await fetchJson(`${API_BASE}/notes?${categoryParam(category)}`, { method: "DELETE" });
      currentNotes = [];
      renderNoteSelect(noteSelect, []);
      renderRecentNoteButtons(node, list, [], status, refresh);
      exportButton.style.display = "none";
      deleteAllButton.style.display = "none";
      loadSelectedButton.style.display = "none";
      deleteSelectedButton.style.display = "none";
      setStatus(status, `Deleted all notes in ${category}`);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });

  node.addDOMWidget("a5note_database_ui", "A5Note_Database", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });

  const baseComputeSize = node.computeSize;
  node.computeSize = function () {
    const size = baseComputeSize ? baseComputeSize.apply(this, arguments) : [460, 460];
    size[0] = Math.max(size[0], MIN_NODE_SIZE[0]);
    size[1] = Math.max(size[1], MIN_NODE_SIZE[1]);
    return size;
  };

  ensureInitialNodeSize(node);
  setTimeout(() => ensureInitialNodeSize(node), 0);
  setTimeout(refresh, 0);
}

app.registerExtension({
  name: "comfyui_A5Note_Database.ui",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const comfyClass = nodeType.comfyClass ?? nodeType.ComfyClass ?? nodeData.name;
    if (comfyClass !== CLASS_NAME) {
      return;
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      attachNoteDatabaseUi(this);
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
      attachNoteDatabaseUi(node);
    }
  },
});
