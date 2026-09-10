import { app } from "../../scripts/app.js";

const NODE_CLASS = "A5ClipPromptEnhancer";
const RUN_MODE_BYPASS = "Bypass - send last/manual prompt";
const RUN_MODE_AUTO = "Auto bypass if unchanged";
const PROMPT_HISTORY_LIMIT = 20;
const PROMPT_TEXT_WIDGET_NAMES = ["system_prompt", "input_prompt", "last_generated_prompt"];
const PROMPT_TEXT_MIN_HEIGHT = 40;
const PROMPT_DIVIDER_HEIGHT = 8;
const PROMPT_EDITOR_STYLE_ID = "a5clip-prompt-editor-styles";
const promptEditors = new WeakMap();
const promptHistories = new WeakMap();
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
    .a5clip-prompt-editor {
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

    .a5clip-prompt-editor__header {
      display: flex;
      align-items: center;
      min-height: 34px;
      padding: 0 6px 0 10px;
      background: var(--comfy-input-bg, #333);
      border-bottom: 1px solid var(--border-color, #555);
      cursor: move;
      user-select: none;
    }

    .a5clip-prompt-editor__title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 13px Arial, sans-serif;
    }

    .a5clip-prompt-editor__controls,
    .a5clip-prompt-editor__history,
    .a5clip-prompt-editor__modes {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .a5clip-prompt-editor__controls {
      gap: 6px;
      margin-left: 8px;
    }

    .a5clip-prompt-editor__history {
      gap: 2px;
    }

    .a5clip-prompt-editor__history-button,
    .a5clip-prompt-editor__mode-button,
    .a5clip-prompt-editor__export-button {
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, #666);
      background: var(--comfy-menu-bg, #242424);
      color: inherit;
      cursor: pointer;
      font: 12px Arial, sans-serif;
    }

    .a5clip-prompt-editor__history-button {
      width: 28px;
      padding: 0;
      border-radius: 4px;
      font-size: 16px;
    }

    .a5clip-prompt-editor__history-button:hover:not(:disabled),
    .a5clip-prompt-editor__mode-button:hover,
    .a5clip-prompt-editor__export-button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.12);
    }

    .a5clip-prompt-editor__history-button:disabled,
    .a5clip-prompt-editor__export-button:disabled {
      cursor: default;
      opacity: 0.35;
    }

    .a5clip-prompt-editor__history-position {
      min-width: 34px;
      text-align: center;
      font: 11px Arial, sans-serif;
      color: var(--descrip-text, #aaa);
    }

    .a5clip-prompt-editor__modes {
      border-radius: 4px;
      overflow: hidden;
    }

    .a5clip-prompt-editor__mode-button {
      padding: 0 7px;
      border-radius: 0;
    }

    .a5clip-prompt-editor__mode-button + .a5clip-prompt-editor__mode-button {
      border-left: 0;
    }

    .a5clip-prompt-editor__mode-button.is-active {
      background: var(--comfy-input-bg, #555);
      color: var(--input-text, #fff);
      box-shadow: inset 0 -2px 0 var(--error-text, #6ca0dc);
    }

    .a5clip-prompt-editor__export-button {
      padding: 0 7px;
      border-radius: 4px;
    }

    .a5clip-prompt-editor__close {
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

    .a5clip-prompt-editor__close:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .a5clip-prompt-editor__textarea {
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
  if (history.index >= 0 && history.entries[history.index] === prompt) {
    history.dirty = false;
    syncPromptHistoryControls(node);
    return false;
  }

  if (history.index < history.entries.length - 1) {
    history.entries = history.entries.slice(0, history.index + 1);
  }
  history.entries.push(prompt);
  if (history.entries.length > PROMPT_HISTORY_LIMIT) {
    history.entries.splice(0, history.entries.length - PROMPT_HISTORY_LIMIT);
  }
  history.index = history.entries.length - 1;
  history.dirty = false;
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
  const history = getPromptHistory(node);
  const prompt = promptValue(value);

  if (history.index < history.entries.length - 1) {
    history.entries = history.entries.slice(0, history.index + 1);
  }
  if (history.entries[history.entries.length - 1] !== prompt) {
    history.entries.push(prompt);
    if (history.entries.length > PROMPT_HISTORY_LIMIT) {
      history.entries.splice(0, history.entries.length - PROMPT_HISTORY_LIMIT);
    }
  }
  history.index = history.entries.length - 1;
  history.dirty = false;
  syncPromptHistoryControls(node);
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
    "A5 CLIP Prompt History",
    `Node: ${node.title || "A5 CLIP Prompt Enhancer"} #${node.id}`,
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
  link.download = `a5clip_prompt_history_node-${node.id}_${timestamp}.txt`;
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
  panel.className = "a5clip-prompt-editor";
  panel.style.width = `${Math.min(720, Math.max(360, window.innerWidth - 32))}px`;
  panel.style.height = `${Math.min(520, Math.max(260, window.innerHeight - 32))}px`;

  const offset = (promptEditorZIndex - 10000) % 6 * 18;
  const panelWidth = parseInt(panel.style.width, 10);
  const panelHeight = parseInt(panel.style.height, 10);
  panel.style.left = `${Math.max(16, (window.innerWidth - panelWidth) / 2 + offset)}px`;
  panel.style.top = `${Math.max(16, (window.innerHeight - panelHeight) / 2 + offset)}px`;

  const header = document.createElement("header");
  header.className = "a5clip-prompt-editor__header";
  const title = document.createElement("div");
  title.className = "a5clip-prompt-editor__title";
  title.textContent = `Last generated prompt - ${node.title || "A5 CLIP"} #${node.id}`;
  const controls = document.createElement("div");
  controls.className = "a5clip-prompt-editor__controls";
  const historyControls = document.createElement("div");
  historyControls.className = "a5clip-prompt-editor__history";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "a5clip-prompt-editor__history-button";
  previousButton.textContent = "\u2190";
  previousButton.title = "Previous prompt";
  previousButton.setAttribute("aria-label", "Previous prompt");
  const historyPosition = document.createElement("span");
  historyPosition.className = "a5clip-prompt-editor__history-position";
  historyPosition.setAttribute("aria-live", "polite");
  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "a5clip-prompt-editor__history-button";
  nextButton.textContent = "\u2192";
  nextButton.title = "Next prompt";
  nextButton.setAttribute("aria-label", "Next prompt");
  historyControls.append(previousButton, historyPosition, nextButton);

  const modeControls = document.createElement("div");
  modeControls.className = "a5clip-prompt-editor__modes";
  const bypassButton = document.createElement("button");
  bypassButton.type = "button";
  bypassButton.className = "a5clip-prompt-editor__mode-button";
  bypassButton.textContent = "Bypass";
  bypassButton.title = "Bypass the LLM and send the last or manually edited prompt";
  const autoButton = document.createElement("button");
  autoButton.type = "button";
  autoButton.className = "a5clip-prompt-editor__mode-button";
  autoButton.textContent = "Auto";
  autoButton.title = "Auto bypass when the source prompts, image, and connected CLIP are unchanged";
  modeControls.append(bypassButton, autoButton);

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "a5clip-prompt-editor__export-button";
  exportButton.textContent = "Export";
  exportButton.title = "Export all prompts in this node's session history";
  controls.append(historyControls, modeControls, exportButton);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "a5clip-prompt-editor__close";
  closeButton.textContent = "X";
  closeButton.title = "Close editor";
  closeButton.setAttribute("aria-label", "Close editor");
  const textarea = document.createElement("textarea");
  textarea.className = "a5clip-prompt-editor__textarea";
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
    captureCurrentNodePrompt(node);
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
  if (!findWidget(node, "last_generated_prompt")) {
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

async function loadSavedConfig() {
  try {
    const response = await fetch("/a5clip_prompt_enhancer/config");
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("A5 CLIP Prompt Enhancer could not load saved config", error);
    return null;
  }
}

async function hydrateNodeFromSavedConfig(node) {
  if (node.__a5ClipEnhancerHydrated) {
    return;
  }
  node.__a5ClipEnhancerHydrated = true;

  const config = await loadSavedConfig();
  const widget = findWidget(node, "last_generated_prompt");
  const prompt = promptValue(config?.last_generated_prompt);
  if (widget && !widget.value && prompt) {
    recordGeneratedPrompt(node, prompt);
    setLastPromptValue(node, prompt, { recordManual: false });
  }
}

function findEnhancerNode(nodeId) {
  if (nodeId === null || nodeId === undefined) {
    return null;
  }
  const node = app.graph?.getNodeById?.(Number(nodeId))
    ?? app.graph?._nodes?.find((candidate) => String(candidate.id) === String(nodeId));
  const comfyClass = node?.comfyClass ?? node?.ComfyClass;
  if (!node || comfyClass !== NODE_CLASS) {
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

function setupNode(node) {
  patchLastPromptWidget(node);
  setupPromptTextDividers(node);
  patchRunModeWidget(node);
  addPromptEditorButton(node);
  hydrateNodeFromSavedConfig(node);
}

app.registerExtension({
  name: "comfyui_A5clip_prompt_enhancer.editable_output",
  async setup() {
    app.api?.addEventListener("a5clip_prompt_enhancer.prompt_updated", (event) => {
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
    if (comfyClass !== NODE_CLASS) {
      return;
    }

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      restoreNamedWidgetValues(this, info);
      return onConfigure?.apply(this, arguments);
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      setupNode(this);
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
      return onRemoved?.apply(this, arguments);
    };
  },
  async nodeCreated(node) {
    const comfyClass = node.comfyClass ?? node.ComfyClass;
    if (comfyClass === NODE_CLASS) {
      setupNode(node);
    }
  },
});
