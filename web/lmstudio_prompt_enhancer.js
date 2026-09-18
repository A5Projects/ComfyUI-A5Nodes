import { app } from "../../scripts/app.js";
import { createPromptHistorySession } from "./prompt_history_session.js";

const MASKED_TOKEN = "XXXXXXXX";
const DEFAULT_MODEL_LABEL = "Use loaded default model";
const LEGACY_DEFAULT_MODEL_LABEL = "Use loaded/default model";
const RUN_MODE_BYPASS = "Bypass - send last/manual prompt";
const RUN_MODE_AUTO = "Auto bypass if unchanged";
const PROMPT_HISTORY_LIMIT = 20;
const ABORT_BUTTON_LABEL = "Eject LLM (stop run)";
const PROMPT_TEXT_WIDGET_NAMES = ["system_prompt", "input_prompt", "last_generated_prompt"];
const PROMPT_TEXT_MIN_HEIGHT = 40;
const PROMPT_DIVIDER_HEIGHT = 8;
const PROMPT_EDITOR_STYLE_ID = "a5lmstudio-prompt-editor-styles";
const promptEditors = new WeakMap();
const promptHistories = new WeakMap();
const promptHistorySession = createPromptHistorySession();
const promptTextLayouts = new WeakMap();
let promptEditorZIndex = 10000;

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function isVueNodesMode() {
  return globalThis.LiteGraph?.vueNodesMode === true;
}

function restoreNamedWidgetValues(node, info) {
  const namedValues = info?.widgets_values_named;
  if (!namedValues || !node.widgets) {
    return;
  }
  for (const widget of node.widgets) {
    if (widget.serialize === false || !(widget.name in namedValues)) {
      continue;
    }
    widget.value = namedValues[widget.name];
  }
}

function ensurePromptEditorStyles() {
  if (document.getElementById(PROMPT_EDITOR_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = PROMPT_EDITOR_STYLE_ID;
  style.textContent = `
    .a5lmstudio-prompt-editor {
      position: fixed;
      display: flex;
      flex-direction: column;
      min-width: 360px;
      min-height: 260px;
      background: var(--comfy-menu-bg, #242424);
      color: var(--input-text, #ddd);
      border: 1px solid var(--border-color, #666);
      border-radius: 6px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      resize: both;
    }

    .a5lmstudio-prompt-editor__header {
      display: flex;
      align-items: center;
      min-height: 34px;
      padding: 0 6px 0 10px;
      background: var(--comfy-input-bg, #333);
      border-bottom: 1px solid var(--border-color, #555);
      cursor: move;
      user-select: none;
    }

    .a5lmstudio-prompt-editor__title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 13px Arial, sans-serif;
    }

    .a5lmstudio-prompt-editor__controls,
    .a5lmstudio-prompt-editor__history,
    .a5lmstudio-prompt-editor__modes {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .a5lmstudio-prompt-editor__controls {
      gap: 6px;
      margin-left: 8px;
    }

    .a5lmstudio-prompt-editor__history {
      gap: 2px;
    }

    .a5lmstudio-prompt-editor__history-button,
    .a5lmstudio-prompt-editor__mode-button,
    .a5lmstudio-prompt-editor__export-button {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      cursor: pointer;
      font: 12px Arial, sans-serif;
    }

    .a5lmstudio-prompt-editor__history-button {
      width: 28px;
      padding: 0;
      border-radius: 4px;
      font-size: 16px;
    }

    .a5lmstudio-prompt-editor__history-button:hover:not(:disabled),
    .a5lmstudio-prompt-editor__mode-button:hover,
    .a5lmstudio-prompt-editor__export-button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.12);
    }

    .a5lmstudio-prompt-editor__history-button:disabled {
      cursor: default;
      opacity: 0.35;
    }

    .a5lmstudio-prompt-editor__history-position {
      min-width: 34px;
      text-align: center;
      font: 11px Arial, sans-serif;
      color: var(--descrip-text, #aaa);
    }

    .a5lmstudio-prompt-editor__modes {
      border-radius: 4px;
      overflow: hidden;
    }

    .a5lmstudio-prompt-editor__mode-button {
      padding: 0 7px;
      border-radius: 0;
    }

    .a5lmstudio-prompt-editor__mode-button + .a5lmstudio-prompt-editor__mode-button {
      border-left: 0;
    }

    .a5lmstudio-prompt-editor__mode-button.is-active {
      background: var(--comfy-input-bg, #555);
      color: var(--input-text, #fff);
      box-shadow: inset 0 -2px 0 var(--error-text, #6ca0dc);
    }

    .a5lmstudio-prompt-editor__export-button {
      padding: 0 7px;
      border-radius: 4px;
    }

    .a5lmstudio-prompt-editor__export-button:disabled {
      cursor: default;
      opacity: 0.35;
    }

    .a5lmstudio-prompt-editor__close {
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: 16px Arial, sans-serif;
    }

    .a5lmstudio-prompt-editor__close:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .a5lmstudio-prompt-editor__textarea {
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

function bringPromptEditorToFront(editor) {
  promptEditorZIndex += 1;
  editor.panel.style.zIndex = String(promptEditorZIndex);
}

function promptValue(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function getPromptHistory(node) {
  let history = promptHistories.get(node);
  if (history) {
    return history;
  }

  const currentPrompt = promptValue(findWidget(node, "last_generated_prompt")?.value);
  history = {
    entries: currentPrompt ? [currentPrompt] : [],
    index: currentPrompt ? 0 : -1,
    applying: false,
    dirty: false,
    initialized: false,
  };
  promptHistories.set(node, history);
  return history;
}

function syncPromptHistoryControls(node) {
  const editor = promptEditors.get(node);
  if (!editor) {
    return;
  }

  const history = getPromptHistory(node);
  const hasEntries = history.entries.length > 0 && history.index >= 0;
  editor.historyPosition.textContent = hasEntries
    ? `${history.index + 1}/${history.entries.length}`
    : "0/0";
  editor.previousButton.disabled = !hasEntries || history.index === 0;
  editor.nextButton.disabled = !hasEntries || history.index >= history.entries.length - 1;
  editor.exportButton.disabled = !hasEntries;
}

function markManualPrompt(node, value) {
  const history = getPromptHistory(node);
  if (history.applying) {
    return;
  }

  const prompt = promptValue(value);
  history.dirty = history.index < 0 || history.entries[history.index] !== prompt;
  syncPromptHistoryControls(node);
}

function commitManualPrompt(node, value) {
  const history = getPromptHistory(node);
  if (history.applying) {
    return false;
  }

  const prompt = promptValue(value);
  history.initialized = true;
  const existingIndex = history.entries.indexOf(prompt);
  if (existingIndex >= 0) {
    history.index = existingIndex;
    history.dirty = false;
    promptHistorySession.save(node, history);
    syncPromptHistoryControls(node);
    return false;
  }

  history.entries.push(prompt);
  if (history.entries.length > PROMPT_HISTORY_LIMIT) {
    history.entries.splice(0, history.entries.length - PROMPT_HISTORY_LIMIT);
  }
  history.index = history.entries.length - 1;
  history.dirty = false;
  promptHistorySession.save(node, history);
  syncPromptHistoryControls(node);
  return true;
}

function captureCurrentNodePrompt(node) {
  const widget = findWidget(node, "last_generated_prompt");
  if (!widget) {
    return;
  }

  const prompt = promptValue(widget.value);
  const history = getPromptHistory(node);
  if (prompt || history.entries.length) {
    commitManualPrompt(node, prompt);
  }
  syncPromptEditor(node, prompt);
  syncPromptHistoryControls(node);
}

function recordGeneratedPrompt(node, value) {
  commitManualPrompt(node, value);
}

function syncPromptEditor(node, value) {
  const editor = promptEditors.get(node);
  const prompt = value ?? "";
  if (editor && editor.textarea.value !== prompt) {
    editor.textarea.value = prompt;
  }
}

function setLastPromptValue(node, value, { recordManual = true } = {}) {
  const widget = findWidget(node, "last_generated_prompt");
  if (!widget) {
    return;
  }

  const history = getPromptHistory(node);
  if (!recordManual) {
    history.applying = true;
  }
  try {
    widget.value = promptValue(value);
    widget.callback?.call(widget, widget.value);
    syncPromptEditor(node, widget.value);
  } finally {
    history.applying = false;
  }
  syncPromptHistoryControls(node);
  app.graph?.setDirtyCanvas(true, true);
}

function navigatePromptHistory(node, direction) {
  captureCurrentNodePrompt(node);
  const history = getPromptHistory(node);
  const nextIndex = history.index + direction;
  if (nextIndex < 0 || nextIndex >= history.entries.length) {
    return;
  }

  history.index = nextIndex;
  promptHistorySession.save(node, history);
  setLastPromptValue(node, history.entries[nextIndex], { recordManual: false });
}

function exportPromptHistory(node) {
  captureCurrentNodePrompt(node);
  const history = getPromptHistory(node);
  if (!history.entries.length) {
    return;
  }

  const exportedAt = new Date().toISOString();
  const sections = history.entries.map((prompt, index) => {
    const currentMarker = index === history.index ? " [current]" : "";
    return `===== Prompt ${index + 1} of ${history.entries.length}${currentMarker} =====\n${prompt}`;
  });
  const contents = [
    "A5 LM Studio Prompt History",
    `Node: ${node.title || "A5lmstudio_prompt_enhancer"} #${node.id}`,
    `Exported: ${exportedAt}`,
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");

  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = exportedAt.replace(/[:.]/g, "-");
  link.href = objectUrl;
  link.download = `a5lmstudio_prompt_history_node-${node.id}_${timestamp}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function syncPromptEditorMode(node) {
  const editor = promptEditors.get(node);
  if (!editor) {
    return;
  }

  const runMode = findWidget(node, "run_mode")?.value;
  const bypassActive = runMode === RUN_MODE_BYPASS;
  const autoActive = runMode === RUN_MODE_AUTO;
  editor.bypassButton.classList.toggle("is-active", bypassActive);
  editor.autoButton.classList.toggle("is-active", autoActive);
  editor.bypassButton.setAttribute("aria-pressed", String(bypassActive));
  editor.autoButton.setAttribute("aria-pressed", String(autoActive));
}

function setRunMode(node, runMode) {
  const widget = findWidget(node, "run_mode");
  if (!widget) {
    return;
  }

  widget.value = runMode;
  widget.callback?.call(widget, runMode);
  syncPromptEditorMode(node);
  app.graph?.setDirtyCanvas(true, true);
}

function closePromptEditor(node) {
  const editor = promptEditors.get(node);
  if (!editor) {
    return;
  }
  captureCurrentNodePrompt(node);
  editor.panel.remove();
  promptEditors.delete(node);
}

function makePromptEditorDraggable(editor) {
  editor.header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) {
      return;
    }

    event.preventDefault();
    bringPromptEditorToFront(editor);
    const startLeft = editor.panel.offsetLeft;
    const startTop = editor.panel.offsetTop;
    const startX = event.clientX;
    const startY = event.clientY;

    const onPointerMove = (moveEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - editor.panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - editor.header.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, startLeft + moveEvent.clientX - startX));
      const top = Math.min(maxTop, Math.max(0, startTop + moveEvent.clientY - startY));
      editor.panel.style.left = `${left}px`;
      editor.panel.style.top = `${top}px`;
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}

function openPromptEditor(node) {
  const widget = findWidget(node, "last_generated_prompt");
  if (!widget) {
    return;
  }
  captureCurrentNodePrompt(node);

  const existing = promptEditors.get(node);
  if (existing) {
    syncPromptEditor(node, widget.value);
    syncPromptHistoryControls(node);
    syncPromptEditorMode(node);
    bringPromptEditorToFront(existing);
    existing.textarea.focus();
    return;
  }

  ensurePromptEditorStyles();
  const panel = document.createElement("section");
  panel.className = "a5lmstudio-prompt-editor";
  panel.style.width = `${Math.min(720, Math.max(360, window.innerWidth - 32))}px`;
  panel.style.height = `${Math.min(520, Math.max(260, window.innerHeight - 32))}px`;

  const offset = (promptEditorZIndex - 10000) % 6 * 18;
  const panelWidth = parseInt(panel.style.width, 10);
  const panelHeight = parseInt(panel.style.height, 10);
  panel.style.left = `${Math.max(16, (window.innerWidth - panelWidth) / 2 + offset)}px`;
  panel.style.top = `${Math.max(16, (window.innerHeight - panelHeight) / 2 + offset)}px`;

  const header = document.createElement("header");
  header.className = "a5lmstudio-prompt-editor__header";

  const title = document.createElement("div");
  title.className = "a5lmstudio-prompt-editor__title";
  title.textContent = `Last generated prompt - ${node.title || "A5 LM Studio"} #${node.id}`;

  const controls = document.createElement("div");
  controls.className = "a5lmstudio-prompt-editor__controls";

  const historyControls = document.createElement("div");
  historyControls.className = "a5lmstudio-prompt-editor__history";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "a5lmstudio-prompt-editor__history-button";
  previousButton.textContent = "\u2190";
  previousButton.title = "Previous prompt";
  previousButton.setAttribute("aria-label", "Previous prompt");

  const historyPosition = document.createElement("span");
  historyPosition.className = "a5lmstudio-prompt-editor__history-position";
  historyPosition.setAttribute("aria-live", "polite");

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "a5lmstudio-prompt-editor__history-button";
  nextButton.textContent = "\u2192";
  nextButton.title = "Next prompt";
  nextButton.setAttribute("aria-label", "Next prompt");

  historyControls.append(previousButton, historyPosition, nextButton);

  const modeControls = document.createElement("div");
  modeControls.className = "a5lmstudio-prompt-editor__modes";

  const bypassButton = document.createElement("button");
  bypassButton.type = "button";
  bypassButton.className = "a5lmstudio-prompt-editor__mode-button";
  bypassButton.textContent = "Bypass";
  bypassButton.title = "Bypass LLM and send the last or manually edited prompt";

  const autoButton = document.createElement("button");
  autoButton.type = "button";
  autoButton.className = "a5lmstudio-prompt-editor__mode-button";
  autoButton.textContent = "Auto";
  autoButton.title = "Auto bypass when the source inputs and selected model are unchanged";

  modeControls.append(bypassButton, autoButton);

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "a5lmstudio-prompt-editor__export-button";
  exportButton.textContent = "Export";
  exportButton.title = "Export all prompts in this node's session history";

  controls.append(historyControls, modeControls, exportButton);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "a5lmstudio-prompt-editor__close";
  closeButton.textContent = "X";
  closeButton.title = "Close editor";
  closeButton.setAttribute("aria-label", "Close editor");

  const textarea = document.createElement("textarea");
  textarea.className = "a5lmstudio-prompt-editor__textarea";
  textarea.value = widget.value ?? "";
  textarea.spellcheck = true;

  header.append(title, controls, closeButton);
  panel.append(header, textarea);
  document.body.appendChild(panel);

  const editor = {
    panel,
    header,
    textarea,
    previousButton,
    historyPosition,
    nextButton,
    bypassButton,
    autoButton,
    exportButton,
  };
  promptEditors.set(node, editor);
  bringPromptEditorToFront(editor);
  makePromptEditorDraggable(editor);
  syncPromptHistoryControls(node);
  syncPromptEditorMode(node);

  panel.addEventListener("pointerdown", () => {
    bringPromptEditorToFront(editor);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closePromptEditor(node);
  });
  closeButton.addEventListener("click", () => closePromptEditor(node));
  previousButton.addEventListener("click", () => navigatePromptHistory(node, -1));
  nextButton.addEventListener("click", () => navigatePromptHistory(node, 1));
  bypassButton.addEventListener("click", () => setRunMode(node, RUN_MODE_BYPASS));
  autoButton.addEventListener("click", () => setRunMode(node, RUN_MODE_AUTO));
  exportButton.addEventListener("click", () => exportPromptHistory(node));
  textarea.addEventListener("input", () => setLastPromptValue(node, textarea.value));
  textarea.addEventListener("blur", () => captureCurrentNodePrompt(node));
  textarea.focus();
}

function bindLastPromptWidgetBlur(node, widget) {
  // Seed from the pre-edit widget value before any DOM input event can replace it.
  getPromptHistory(node);
  widget.__a5PromptEditorBoundElements ??= new WeakSet();
  const roots = widget.element ? [widget.element] : [widget.inputEl].filter(Boolean);
  const elements = [];
  for (const root of roots) {
    if (root.matches?.("textarea, input, [contenteditable='true']")) {
      elements.push(root);
    }
    root.querySelectorAll?.("textarea, input, [contenteditable='true']")
      .forEach((element) => elements.push(element));
  }

  for (const element of new Set(elements)) {
    if (widget.__a5PromptEditorBoundElements.has(element)) {
      continue;
    }
    widget.__a5PromptEditorBoundElements.add(element);
    const syncFromElement = () => {
      if ("value" in element) {
        widget.value = promptValue(element.value);
      }
      markManualPrompt(node, widget.value);
      syncPromptEditor(node, widget.value);
    };
    element.addEventListener("input", syncFromElement);
    element.addEventListener("change", syncFromElement);
    element.addEventListener("blur", () => {
      syncFromElement();
      captureCurrentNodePrompt(node);
    });
  }
}

function patchLastPromptWidget(node) {
  const widget = findWidget(node, "last_generated_prompt");
  if (!widget || widget.__a5PromptEditorPatched) {
    return;
  }

  widget.__a5PromptEditorPatched = true;
  const beforeQueued = widget.beforeQueued;
  widget.beforeQueued = function (...args) {
    const result = beforeQueued?.apply(this, args);
    captureCurrentNodePrompt(node);
    return result;
  };
  const callback = widget.callback;
  widget.callback = function (value) {
    const result = callback?.call(this, value);
    const currentValue = this.value ?? value;
    markManualPrompt(node, currentValue);
    syncPromptEditor(node, currentValue);
    return result;
  };

  node.__a5PromptEditorBindTimers ??= [];
  for (const delay of [0, 250, 1000]) {
    node.__a5PromptEditorBindTimers.push(
      setTimeout(() => bindLastPromptWidgetBlur(node, widget), delay),
    );
  }
}

function patchRunModeWidget(node) {
  const widget = findWidget(node, "run_mode");
  if (!widget || widget.__a5PromptEditorModePatched) {
    return;
  }

  widget.__a5PromptEditorModePatched = true;
  const callback = widget.callback;
  widget.callback = function (value) {
    const result = callback?.call(this, value);
    syncPromptEditorMode(node);
    return result;
  };
}

function addPromptEditorButton(node) {
  if (node.__a5PromptEditorButton || !node.addWidget) {
    return;
  }

  const promptWidget = findWidget(node, "last_generated_prompt");
  if (!promptWidget) {
    return;
  }

  node.__a5PromptEditorButton = node.addWidget(
    "button",
    "Edit last prompt...",
    null,
    () => openPromptEditor(node),
    { serialize: false, canvasOnly: true },
  );
  node.__a5PromptEditorButton.serialize = false;

  growNodeToFit(node);
}

function growNodeToFit(node) {
  const currentSize = Array.isArray(node.size) ? [...node.size] : null;
  const computedSize = node.computeSize?.();
  if (currentSize && computedSize) {
    node.setSize?.([
      Math.max(currentSize[0], computedSize[0]),
      Math.max(currentSize[1], computedSize[1]),
    ]);
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function resizeEventNodeHeight(node, size) {
  if (Array.isArray(size) && Number.isFinite(size[1])) {
    return size[1];
  }
  if (Number.isFinite(size?.height)) {
    return size.height;
  }
  if (Number.isFinite(size?.size?.height)) {
    return size.size.height;
  }
  return Number(node.size?.[1]);
}

function distributePromptTextHeight(totalHeight, previousHeights) {
  const minimumTotal = PROMPT_TEXT_MIN_HEIGHT * previousHeights.length;
  const targetTotal = Math.max(minimumTotal, totalHeight);
  const availableExtra = targetTotal - minimumTotal;
  const previousExtra = previousHeights.map((height) => {
    return Math.max(0, height - PROMPT_TEXT_MIN_HEIGHT);
  });
  const previousExtraTotal = previousExtra.reduce((sum, height) => sum + height, 0);
  const weights = previousExtraTotal > 0
    ? previousExtra.map((height) => height / previousExtraTotal)
    : previousHeights.map(() => 1 / previousHeights.length);
  return weights.map((weight) => PROMPT_TEXT_MIN_HEIGHT + availableExtra * weight);
}

function seedPromptTextLayout(node, state) {
  if (state.heights) {
    return true;
  }
  const heights = state.widgets.map((widget) => Number(widget.computedHeight));
  if (!heights.every((height) => Number.isFinite(height) && height > 0)) {
    return false;
  }
  state.heights = distributePromptTextHeight(
    heights.reduce((sum, height) => sum + height, 0),
    heights,
  );
  state.lastNodeHeight = Number(node.size?.[1]);
  return true;
}

function applyPromptTextHeights(node, state, heights) {
  state.heights = heights.map((height) => Math.max(PROMPT_TEXT_MIN_HEIGHT, height));
  state.lastNodeHeight = Number(node.size?.[1]);
  for (const widget of state.widgets) {
    widget.triggerDraw?.();
  }
  app.graph?.setDirtyCanvas(true, true);
}

function drawPromptDivider(ctx, width, posY, height) {
  const centerY = posY + (height || PROMPT_DIVIDER_HEIGHT) / 2;
  ctx.save();
  ctx.strokeStyle = "#555";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, centerY);
  ctx.lineTo(width - 16, centerY);
  ctx.stroke();
  ctx.fillStyle = "#999";
  ctx.fillRect(width / 2 - 18, centerY - 1, 36, 3);
  ctx.restore();
}

function addPromptTextDivider(node, state, upperIndex) {
  const upperWidget = state.widgets[upperIndex];
  const lowerWidget = state.widgets[upperIndex + 1];
  const divider = node.addWidget(
    "custom",
    `prompt_height_divider_${upperIndex + 1}`,
    "",
    () => {},
    {
      serialize: false,
      canvasOnly: true,
      tooltip: `Drag to resize ${upperWidget.name} and ${lowerWidget.name}`,
    },
  );
  divider.serialize = false;
  divider.computeSize = (width) => [width, PROMPT_DIVIDER_HEIGHT];
  divider.draw = function (ctx, _drawNode, width, posY, height) {
    seedPromptTextLayout(node, state);
    drawPromptDivider(ctx, width, posY, height);
  };
  divider.onPointerDown = function (pointer, pointerNode, canvas) {
    if (!seedPromptTextLayout(node, state)) {
      return true;
    }

    const activeNode = pointerNode ?? node;
    const startY = Number(pointer?.eDown?.canvasY);
    const startHeights = [...state.heights];
    const pairTotal = startHeights[upperIndex] + startHeights[upperIndex + 1];
    const canvasElement = canvas?.canvas;
    const previousCursor = canvasElement?.style?.cursor ?? "";

    pointer.onClick = () => {};
    pointer.onDragStart = () => {
      if (canvasElement?.style) {
        canvasElement.style.cursor = "ns-resize";
      }
    };
    pointer.onDrag = (moveEvent) => {
      const moveY = Number(moveEvent?.canvasY);
      if (!Number.isFinite(startY) || !Number.isFinite(moveY)) {
        return;
      }
      const nextHeights = [...startHeights];
      nextHeights[upperIndex] = clamp(
        startHeights[upperIndex] + moveY - startY,
        PROMPT_TEXT_MIN_HEIGHT,
        pairTotal - PROMPT_TEXT_MIN_HEIGHT,
      );
      nextHeights[upperIndex + 1] = pairTotal - nextHeights[upperIndex];
      applyPromptTextHeights(activeNode, state, nextHeights);
    };
    pointer.finally = () => {
      if (canvasElement?.style) {
        canvasElement.style.cursor = previousCursor;
      }
    };
    return true;
  };

  return divider;
}

function setupPromptTextDividers(node) {
  if (promptTextLayouts.has(node) || !node.addWidget) {
    return;
  }

  const widgets = PROMPT_TEXT_WIDGET_NAMES.map((name) => findWidget(node, name));
  if (widgets.some((widget) => !widget?.computeLayoutSize)) {
    return;
  }

  for (const widget of widgets) {
    widget.options = { ...(widget.options ?? {}), rows: 1 };
  }

  const state = {
    widgets,
    heights: null,
    lastNodeHeight: Number(node.size?.[1]),
    dividers: [],
  };
  promptTextLayouts.set(node, state);

  widgets.forEach((widget, index) => {
    const computeLayoutSize = widget.computeLayoutSize;
    widget.computeLayoutSize = function (layoutNode) {
      const baseLayout = computeLayoutSize.call(this, layoutNode);
      if (isVueNodesMode()) {
        return baseLayout;
      }
      const explicitHeight = state.heights?.[index];
      if (!Number.isFinite(explicitHeight)) {
        return baseLayout;
      }
      return {
        ...baseLayout,
        minHeight: PROMPT_TEXT_MIN_HEIGHT,
        maxHeight: explicitHeight,
      };
    };
  });

  state.dividers.push(addPromptTextDivider(node, state, 0));
  state.dividers.push(addPromptTextDivider(node, state, 1));

  const getLayoutWidgets = node.getLayoutWidgets;
  node.getLayoutWidgets = function () {
    const baseWidgets = getLayoutWidgets?.call(this)
      ?? this.widgets?.filter((widget) => !widget.hidden)
      ?? [];
    const orderedWidgets = baseWidgets.filter((widget) => !state.dividers.includes(widget));
    state.dividers.forEach((divider, index) => {
      const upperWidgetIndex = orderedWidgets.indexOf(state.widgets[index]);
      if (upperWidgetIndex >= 0) {
        orderedWidgets.splice(upperWidgetIndex + 1, 0, divider);
      }
    });
    return orderedWidgets;
  };

  const onResize = node.onResize;
  node.onResize = function (size) {
    const previousNodeHeight = state.lastNodeHeight;
    const result = onResize?.apply(this, arguments);
    const nextNodeHeight = resizeEventNodeHeight(this, size);
    if (isVueNodesMode()) {
      state.heights = null;
      state.lastNodeHeight = nextNodeHeight;
      return result;
    }
    if (
      state.heights
      && Number.isFinite(previousNodeHeight)
      && Number.isFinite(nextNodeHeight)
      && nextNodeHeight !== previousNodeHeight
    ) {
      const currentTotal = state.heights.reduce((sum, height) => sum + height, 0);
      state.heights = distributePromptTextHeight(
        currentTotal + nextNodeHeight - previousNodeHeight,
        state.heights,
      );
      app.graph?.setDirtyCanvas(true, true);
    }
    state.lastNodeHeight = nextNodeHeight;
    return result;
  };
}

function setAbortButtonState(node, label, disabled) {
  node.__a5AbortLabel = label;
  node.__a5AbortDisabled = disabled;
  app.graph?.setDirtyCanvas(true, true);
}

async function abortLmStudio(node) {
  if (node.__a5AbortInFlight) {
    return;
  }

  node.__a5AbortInFlight = true;
  clearTimeout(node.__a5AbortResetTimer);
  setAbortButtonState(node, "Ejecting LLM...", true);
  try {
    const response = await fetch("/a5lmstudio_prompt_enhancer/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_url: currentServerUrl(node) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || `HTTP ${response.status}`);
    }
    setAbortButtonState(node, "LLM ejected", true);
  } catch (error) {
    console.error("A5lmstudio_prompt_enhancer could not eject LM Studio", error);
    setAbortButtonState(node, "Eject failed", true);
  } finally {
    node.__a5AbortInFlight = false;
    node.__a5AbortResetTimer = setTimeout(() => {
      setAbortButtonState(node, ABORT_BUTTON_LABEL, false);
    }, 1800);
  }
}

function pointInsideHorizontalRect(pos, rect) {
  return Boolean(
    rect
    && Number.isFinite(pos?.[0])
    && pos[0] >= rect.x
    && pos[0] <= rect.x + rect.width
  );
}

function splitRowDrawWidth(node, width) {
  const nodeWidth = Number(node?.size?.[0]);
  return !isVueNodesMode() && Number.isFinite(nodeWidth) ? nodeWidth : width;
}

function pointerXInNode(event, node, fallbackPos) {
  if (isVueNodesMode()) {
    const offsetX = Number(event?.offsetX);
    if (Number.isFinite(offsetX)) {
      return offsetX;
    }
  }
  const canvasX = Number(event?.canvasX);
  const nodeX = Number(node?.pos?.[0]);
  if (Number.isFinite(canvasX) && Number.isFinite(nodeX)) {
    return canvasX - nodeX;
  }
  return Number.isFinite(fallbackPos?.[0]) ? fallbackPos[0] : Number.NaN;
}

function bindSplitRowPointer(widget, node, activateAtX) {
  widget.onPointerDown = function (pointer, pointerNode) {
    const activeNode = pointerNode ?? node;
    const downX = pointerXInNode(pointer?.eDown, activeNode);
    if (pointer) {
      pointer.onClick = (event) => {
        activateAtX(downX, event ?? pointer.eDown);
      };
    }
    // Cancel the original Boolean/String widget click handler for this row.
    return true;
  };

  // Compatibility fallback for Comfy frontends predating onPointerDown.
  widget.mouse = function (event, pos, mouseNode) {
    if (event.type !== "mousedown" && event.type !== "pointerdown") {
      return false;
    }
    activateAtX(pointerXInNode(event, mouseNode ?? node, pos), event);
    return true;
  };
}

function hideCombinedBackingWidget(widget) {
  if (!widget || widget.__a5CombinedHidden) {
    return;
  }
  widget.__a5CombinedHidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  widget.computedHeight = 0;
  widget.draw = () => {};
  widget.mouse = () => false;
}

function drawToggleControl(ctx, rect, label, enabled) {
  ctx.save();
  ctx.fillStyle = enabled ? "#34495e" : "#292929";
  ctx.strokeStyle = enabled ? "#7895ad" : "#666";
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 6);

  ctx.fillStyle = "#ddd";
  ctx.font = "12px Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + 9, rect.y + rect.height / 2);

  const trackWidth = 34;
  const trackHeight = 16;
  const trackX = rect.x + rect.width - trackWidth - 8;
  const trackY = rect.y + (rect.height - trackHeight) / 2;
  ctx.fillStyle = enabled ? "#7e9bb4" : "#555";
  ctx.strokeStyle = enabled ? "#9eb4c7" : "#777";
  drawRoundedRect(ctx, trackX, trackY, trackWidth, trackHeight, trackHeight / 2);

  ctx.beginPath();
  ctx.fillStyle = enabled ? "#e8eef3" : "#bbb";
  ctx.arc(
    enabled ? trackX + trackWidth - trackHeight / 2 : trackX + trackHeight / 2,
    trackY + trackHeight / 2,
    trackHeight / 2 - 2,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

function setupCombinedModelManagementRow(node) {
  if (node.__a5CombinedModelManagementRow) {
    return;
  }

  const loadWidget = findWidget(node, "load_model_before_generation");
  const unloadWidget = findWidget(node, "unload_model_after_generation");
  if (!loadWidget || !unloadWidget) {
    return;
  }

  node.__a5CombinedModelManagementRow = true;
  const combinedTooltip = "Load and unload the specifically selected LM Studio LLM. Both controls are ignored for Use loaded default model.";
  loadWidget.options = {
    ...(loadWidget.options ?? {}),
    tooltip: combinedTooltip,
  };
  unloadWidget.options = {
    ...(unloadWidget.options ?? {}),
    tooltip: combinedTooltip,
  };

  // Nodes 2.0 renders each legacy widget through a separate Vue canvas. Keep
  // both native Boolean rows there so their values remain independently owned.
  if (isVueNodesMode()) {
    return;
  }

  hideCombinedBackingWidget(unloadWidget);
  loadWidget.type = "custom";
  loadWidget.computeSize = (width) => [width, 30];
  loadWidget.draw = function (ctx, drawNode, width, posY) {
    const margin = 10;
    const gap = 6;
    const drawWidth = splitRowDrawWidth(drawNode, width);
    const availableWidth = drawWidth - margin * 2;
    const halfWidth = (availableWidth - gap) / 2;
    const rowY = posY + 2;
    const rowHeight = 26;
    this.__a5LoadRect = { x: margin, y: rowY, width: halfWidth, height: rowHeight };
    this.__a5UnloadRect = {
      x: margin + halfWidth + gap,
      y: rowY,
      width: halfWidth,
      height: rowHeight,
    };
    drawToggleControl(ctx, this.__a5LoadRect, "Load LLM", Boolean(this.value));
    drawToggleControl(ctx, this.__a5UnloadRect, "Unload LLM", Boolean(unloadWidget.value));
  };
  const activateModelManagementAtX = (pointerX) => {
    let target = null;
    if (pointInsideHorizontalRect([pointerX], loadWidget.__a5LoadRect)) {
      target = loadWidget;
    } else if (pointInsideHorizontalRect([pointerX], loadWidget.__a5UnloadRect)) {
      target = unloadWidget;
    }
    if (!target) {
      return true;
    }

    target.value = !Boolean(target.value);
    target.callback?.call(target, target.value);
    app.graph?.setDirtyCanvas(true, true);
    return true;
  };
  bindSplitRowPointer(loadWidget, node, activateModelManagementAtX);
}

function drawServerEjectRow(ctx, widget, node, width, posY) {
  const margin = 10;
  const gap = 8;
  const availableWidth = width - margin * 2;
  const serverWidth = (availableWidth - gap) / 2;
  const rowY = posY + 2;
  const rowHeight = 26;
  widget.__a5ServerRect = { x: margin, y: rowY, width: serverWidth, height: rowHeight };
  widget.__a5EjectRect = {
    x: margin + serverWidth + gap,
    y: rowY,
    width: serverWidth,
    height: rowHeight,
  };

  ctx.save();
  ctx.fillStyle = "#252525";
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1;
  drawRoundedRect(
    ctx,
    widget.__a5ServerRect.x,
    widget.__a5ServerRect.y,
    widget.__a5ServerRect.width,
    widget.__a5ServerRect.height,
    6,
  );
  ctx.beginPath();
  ctx.rect(
    widget.__a5ServerRect.x + 7,
    widget.__a5ServerRect.y,
    widget.__a5ServerRect.width - 14,
    widget.__a5ServerRect.height,
  );
  ctx.clip();
  ctx.fillStyle = "#aaa";
  ctx.font = "12px Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `Server  ${promptValue(widget.value)}`,
    widget.__a5ServerRect.x + 8,
    widget.__a5ServerRect.y + widget.__a5ServerRect.height / 2,
  );
  ctx.restore();

  ctx.save();
  ctx.fillStyle = node.__a5AbortDisabled ? "#5f3333" : "#8f2d2d";
  ctx.strokeStyle = node.__a5AbortDisabled ? "#875858" : "#cf6a6a";
  ctx.lineWidth = 1;
  drawRoundedRect(
    ctx,
    widget.__a5EjectRect.x,
    widget.__a5EjectRect.y,
    widget.__a5EjectRect.width,
    widget.__a5EjectRect.height,
    6,
  );
  ctx.fillStyle = "#fff";
  ctx.font = "bold 12px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    node.__a5AbortLabel ?? ABORT_BUTTON_LABEL,
    widget.__a5EjectRect.x + widget.__a5EjectRect.width / 2,
    widget.__a5EjectRect.y + widget.__a5EjectRect.height / 2,
  );
  ctx.restore();
}

function setupServerEjectRow(node) {
  if (node.__a5ServerEjectRow) {
    return;
  }

  const serverWidget = findWidget(node, "server_url");
  if (!serverWidget) {
    return;
  }

  node.__a5ServerEjectRow = true;
  node.__a5AbortLabel = ABORT_BUTTON_LABEL;
  node.__a5AbortDisabled = false;
  serverWidget.type = "custom";
  serverWidget.options = {
    ...(serverWidget.options ?? {}),
    tooltip: "Click the server field to edit its full URL. Eject LLM immediately unloads all LM Studio LLMs and stops an active request.",
  };
  serverWidget.computeSize = (width) => [width, 30];
  serverWidget.draw = function (ctx, drawNode, width, posY) {
    drawServerEjectRow(ctx, this, drawNode, splitRowDrawWidth(drawNode, width), posY);
  };
  const activateServerRowAtX = (pointerX, event) => {
    if (pointInsideHorizontalRect([pointerX], serverWidget.__a5EjectRect)) {
      if (!node.__a5AbortDisabled) {
        abortLmStudio(node);
      }
      return true;
    }

    if (pointInsideHorizontalRect([pointerX], serverWidget.__a5ServerRect)) {
      const updateServerUrl = (value) => {
        if (value == null) {
          return;
        }
        serverWidget.value = value.trim();
        serverWidget.callback?.call(serverWidget, serverWidget.value);
        app.graph?.setDirtyCanvas(true, true);
      };
      if (typeof app.canvas?.prompt === "function") {
        app.canvas.prompt(
          "LM Studio server URL",
          promptValue(serverWidget.value),
          updateServerUrl,
          event,
        );
      } else {
        updateServerUrl(window.prompt("LM Studio server URL", promptValue(serverWidget.value)));
      }
      return true;
    }

    // The canvas has already routed this event to this widget row. Consume clicks
    // in the visual gap so LiteGraph cannot fall back to the original text widget.
    return true;
  };
  bindSplitRowPointer(serverWidget, node, activateServerRowAtX);
}

function setInputPasswordType(element) {
  if (!element) {
    return;
  }
  if (element.tagName === "INPUT") {
    element.type = "password";
    element.autocomplete = "off";
    return;
  }
  for (const input of element.querySelectorAll?.("input") ?? []) {
    input.type = "password";
    input.autocomplete = "off";
  }
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.fill();
  ctx.stroke();
}

function drawMaskedStringWidget(ctx, widget, width, posY, height) {
  const margin = 15;
  const y = posY + 1;
  const fieldHeight = Math.max(20, height - 2);
  const mask = typeof widget.value === "string" && widget.value.length ? MASKED_TOKEN : "";

  ctx.save();
  ctx.fillStyle = "#1f1f1f";
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, margin, y, width - margin * 2, fieldHeight, fieldHeight * 0.5);

  ctx.font = `${Math.max(12, fieldHeight * 0.62)}px Arial`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#aaa";
  ctx.textAlign = "left";
  ctx.fillText(widget.name, margin + 10, y + fieldHeight * 0.5);

  ctx.fillStyle = "#ddd";
  ctx.textAlign = "right";
  ctx.fillText(mask, width - margin - 10, y + fieldHeight * 0.5);
  ctx.restore();
}

function isRealToken(value) {
  return typeof value === "string" && value.length > 0 && value !== MASKED_TOKEN;
}

async function saveApiToken(apiToken) {
  try {
    const response = await fetch("/a5lmstudio_prompt_enhancer/api_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken }),
    });
    return response.ok;
  } catch (error) {
    console.warn("A5lmstudio_prompt_enhancer could not save API token", error);
    return false;
  }
}

async function loadModelChoices(serverUrl) {
  try {
    const params = new URLSearchParams({ server_url: serverUrl || "" });
    const response = await fetch(`/a5lmstudio_prompt_enhancer/models?${params.toString()}`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("A5lmstudio_prompt_enhancer could not load server models", error);
    return null;
  }
}

function currentServerUrl(node) {
  return findWidget(node, "server_url")?.value ?? "";
}

function updateAllModelDropdowns() {
  for (const node of app.graph?._nodes ?? []) {
    const comfyClass = node?.comfyClass ?? node?.ComfyClass;
    if (comfyClass === "A5lmstudio_prompt_enhancer") {
      refreshModelChoices(node, { preserveCurrent: true });
    }
  }
}

function saveApiTokenAndRefresh(apiToken) {
  saveApiToken(apiToken).then((ok) => {
    if (ok) {
      updateAllModelDropdowns();
    }
  });
}

async function loadSavedConfig() {
  try {
    const response = await fetch("/a5lmstudio_prompt_enhancer/config");
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("A5lmstudio_prompt_enhancer could not load saved config", error);
    return null;
  }
}

function sanitizeTokenValue(widget) {
  if (!isRealToken(widget.value)) {
    return;
  }
  saveApiTokenAndRefresh(widget.value);
  widget.value = MASKED_TOKEN;
}

function maskTokenWidget(node) {
  const widget = findWidget(node, "api_token");
  if (!widget || widget.__lmstudioMasked) {
    return;
  }
  widget.__lmstudioMasked = true;
  widget.options = { ...(widget.options ?? {}), password: true };
  sanitizeTokenValue(widget);

  const draw = widget.draw;
  widget.draw = function (ctx, node, width, posY, height) {
    const realValue = this.value;
    if (typeof realValue === "string" && realValue.length) {
      this.value = MASKED_TOKEN;
    }
    try {
      if (typeof draw === "function") {
        return draw.apply(this, arguments);
      }
      drawMaskedStringWidget(ctx, this, width, posY, height);
      return true;
    } finally {
      this.value = realValue;
    }
  };

  const callback = widget.callback;
  widget.callback = function (value) {
    if (isRealToken(value)) {
      saveApiTokenAndRefresh(value);
      this.value = MASKED_TOKEN;
      value = MASKED_TOKEN;
    }
    return callback?.call(this, value);
  };

  const applyMask = () => {
    sanitizeTokenValue(widget);
    setInputPasswordType(widget.inputEl);
    setInputPasswordType(widget.element);
  };

  applyMask();
  setTimeout(applyMask, 0);
  setTimeout(applyMask, 250);
}

function setWidgetValue(node, name, value, { onlyIfBlank = true } = {}) {
  const widget = findWidget(node, name);
  if (!widget) {
    return;
  }
  if (onlyIfBlank && widget.value) {
    return;
  }
  if (name === "last_generated_prompt") {
    setLastPromptValue(node, value);
  } else {
    widget.value = value ?? "";
    widget.callback?.call(widget, widget.value);
  }
}

function updateComboOptions(widget, labels) {
  if (!widget || !Array.isArray(labels)) {
    return;
  }
  const uniqueValues = [...new Set(labels.filter((value) => typeof value === "string" && value.length))];

  if (Array.isArray(widget.options?.values)) {
    widget.options.values = uniqueValues;
  }
  if (Array.isArray(widget.options?.combo)) {
    widget.options.combo = uniqueValues;
  }
  if (Array.isArray(widget.values)) {
    widget.values = uniqueValues;
  }
}

async function refreshModelChoices(node, { preserveCurrent = true } = {}) {
  const modelWidget = findWidget(node, "model");
  if (!modelWidget) {
    return;
  }

  const previousValue = modelWidget.value;
  const modelData = await loadModelChoices(currentServerUrl(node));
  const choices = Array.isArray(modelData?.choices) && modelData.choices.length
    ? modelData.choices
    : [{ value: "", label: DEFAULT_MODEL_LABEL }];
  const labels = choices.map((choice) => choice.label).filter(Boolean);

  updateComboOptions(modelWidget, labels);

  const preservedChoice = choices.find((choice) => {
    return choice.label === previousValue
      || choice.value === previousValue
      || (choice.value === "" && previousValue === LEGACY_DEFAULT_MODEL_LABEL);
  });

  if (preserveCurrent && preservedChoice) {
    modelWidget.value = preservedChoice.label;
  } else if (modelData?.default_model_label && labels.includes(modelData.default_model_label)) {
    modelWidget.value = modelData.default_model_label;
  } else {
    modelWidget.value = labels[0] ?? DEFAULT_MODEL_LABEL;
  }

  modelWidget.callback?.call(modelWidget, modelWidget.value);
  if (modelData?.error) {
    console.warn("A5lmstudio_prompt_enhancer model list used recents only:", modelData.error);
  }
  app.graph?.setDirtyCanvas(true, true);
}

async function hydrateNodeFromSavedConfig(node) {
  if (node.__lmstudioHydrated) {
    return;
  }
  node.__lmstudioHydrated = true;

  const config = await loadSavedConfig();
  if (!config) {
    return;
  }

  const tokenWidget = findWidget(node, "api_token");
  if (config.has_api_token && tokenWidget && !tokenWidget.value) {
    tokenWidget.value = config.api_token_placeholder ?? MASKED_TOKEN;
    tokenWidget.callback?.call(tokenWidget, tokenWidget.value);
    maskTokenWidget(node);
  }

  await refreshModelChoices(node, { preserveCurrent: true });

  setWidgetValue(node, "last_generated_prompt", config.last_generated_prompt);
  app.graph?.setDirtyCanvas(true, true);
}

function patchServerUrlRefresh(node) {
  const widget = findWidget(node, "server_url");
  if (!widget || widget.__lmstudioRefreshPatched) {
    return;
  }
  widget.__lmstudioRefreshPatched = true;
  const callback = widget.callback;
  widget.callback = function (value) {
    const result = callback?.call(this, value);
    refreshModelChoices(node, { preserveCurrent: false });
    return result;
  };
}

function findEnhancerNode(nodeId) {
  if (nodeId === null || nodeId === undefined) {
    return null;
  }
  const node = app.graph?.getNodeById?.(Number(nodeId))
    ?? app.graph?._nodes?.find((candidate) => String(candidate.id) === String(nodeId));
  const comfyClass = node?.comfyClass ?? node?.ComfyClass;
  if (!node || comfyClass !== "A5lmstudio_prompt_enhancer") {
    return null;
  }
  return node;
}

function updateLastPromptWidget(nodeId, prompt) {
  const node = findEnhancerNode(nodeId);
  if (!node) {
    return;
  }

  captureCurrentNodePrompt(node);
  recordGeneratedPrompt(node, prompt);
  setLastPromptValue(node, prompt, { recordManual: false });
}

app.registerExtension({
  name: "comfyui_A5lmstudio_prompt_enhancer.mask_api_token",
  async setup() {
    app.api?.addEventListener("a5lmstudio_prompt_enhancer.prompt_updated", (event) => {
      updateLastPromptWidget(event.detail?.node_id, event.detail?.prompt);
    });
    app.api?.addEventListener("executing", (event) => {
      const node = findEnhancerNode(event.detail?.node ?? event.detail);
      if (node) {
        captureCurrentNodePrompt(node);
      }
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const comfyClass = nodeType.comfyClass ?? nodeType.ComfyClass ?? nodeData.name;
    if (comfyClass !== "A5lmstudio_prompt_enhancer") {
      return;
    }

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      restoreNamedWidgetValues(this, info);
      const result = onConfigure?.apply(this, arguments);
      const history = getPromptHistory(this);
      const prompt = promptValue(findWidget(this, "last_generated_prompt")?.value);
      if (!promptHistorySession.restore(this, history, prompt) && !history.initialized) {
        history.entries = prompt ? [prompt] : [];
        history.index = history.entries.length - 1;
      }
      history.initialized = true;
      syncPromptHistoryControls(this);
      syncPromptEditor(this, findWidget(this, "last_generated_prompt")?.value);
      return result;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      patchLastPromptWidget(this);
      setupPromptTextDividers(this);
      patchRunModeWidget(this);
      maskTokenWidget(this);
      patchServerUrlRefresh(this);
      setupCombinedModelManagementRow(this);
      setupServerEjectRow(this);
      addPromptEditorButton(this);
      hydrateNodeFromSavedConfig(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      closePromptEditor(this);
      promptHistories.delete(this);
      promptTextLayouts.delete(this);
      for (const timer of this.__a5PromptEditorBindTimers ?? []) {
        clearTimeout(timer);
      }
      this.__a5PromptEditorBindTimers = [];
      clearTimeout(this.__a5AbortResetTimer);
      return onRemoved?.apply(this, arguments);
    };
  },
  async nodeCreated(node) {
    const comfyClass = node.comfyClass ?? node.ComfyClass;
    if (comfyClass === "A5lmstudio_prompt_enhancer") {
      patchLastPromptWidget(node);
      setupPromptTextDividers(node);
      patchRunModeWidget(node);
      maskTokenWidget(node);
      patchServerUrlRefresh(node);
      setupCombinedModelManagementRow(node);
      setupServerEjectRow(node);
      addPromptEditorButton(node);
      hydrateNodeFromSavedConfig(node);
    }
  },
});
