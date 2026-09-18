import { app } from "../../scripts/app.js";
import { createPromptHistorySession } from "./prompt_history_session.js";

const NODE_NAME = "A5TextPrompt";
const TEXT_UPDATE_EVENT = "a5_text_prompt.text_updated";
const HISTORY_LIMIT = 20;
const TOOLBAR_NAME = "a5_text_prompt_history";
const TOOLBAR_HEIGHT = 34;

const histories = new WeakMap();
const historySession = createPromptHistorySession();

function textWidget(node) {
    return node.widgets?.find((widget) => widget.name === "text");
}

function widgetText(node) {
    return String(textWidget(node)?.value ?? "");
}

function dirtyCanvas(node) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function newState(node) {
    const initial = widgetText(node);
    return {
        entries: [initial],
        index: 0,
        dirty: false,
        applying: false,
        initialized: false,
        boundElements: new WeakSet(),
        bindTimers: [],
    };
}

function historyState(node) {
    let state = histories.get(node);
    if (!state) {
        state = newState(node);
        histories.set(node, state);
    }
    return state;
}

function restoreHistory(node) {
    clearNodeTimers(node);
    const state = historyState(node);
    if (!historySession.restore(node, state, widgetText(node)) && !state.initialized) {
        state.entries = [widgetText(node)];
        state.index = 0;
    }
    state.initialized = true;
    bindTextEditor(node);
    scheduleEditorBinding(node);
    syncHistoryToolbar(node);
    dirtyCanvas(node);
}

function markTextDirty(node) {
    const state = historyState(node);
    if (!state.applying) {
        state.dirty = true;
        dirtyCanvas(node);
    }
}

function commitValue(node, value, { allowEmpty = false } = {}) {
    const state = historyState(node);
    if (state.applying) {
        return false;
    }

    const prompt = String(value ?? "");
    state.initialized = true;
    if (!allowEmpty && !prompt && state.entries.length === 0) {
        state.dirty = false;
        return false;
    }

    const existingIndex = state.entries.indexOf(prompt);
    if (existingIndex >= 0) {
        state.index = existingIndex;
        state.dirty = false;
        historySession.save(node, state);
        syncHistoryToolbar(node);
        dirtyCanvas(node);
        return false;
    }

    state.entries.push(prompt);
    if (state.entries.length > HISTORY_LIMIT) {
        state.entries.splice(0, state.entries.length - HISTORY_LIMIT);
    }
    state.index = state.entries.length - 1;
    state.dirty = false;
    historySession.save(node, state);
    syncHistoryToolbar(node);
    dirtyCanvas(node);
    return true;
}

function commitCurrentText(node, options = {}) {
    const state = historyState(node);
    const current = widgetText(node);
    const selected = state.index >= 0 ? state.entries[state.index] : undefined;
    if (!state.dirty && selected === current) {
        return false;
    }
    return commitValue(node, current, {
        allowEmpty: options.allowEmpty ?? state.entries.length > 0,
    });
}

function applyText(node, value) {
    const widget = textWidget(node);
    if (!widget) {
        return;
    }

    const prompt = String(value ?? "");
    const state = historyState(node);
    state.applying = true;
    try {
        widget.value = prompt;
        if (widget.inputEl && "value" in widget.inputEl) {
            widget.inputEl.value = prompt;
        }
        widget.callback?.(prompt, app.canvas, node, [0, 0]);
    } finally {
        state.applying = false;
    }
    dirtyCanvas(node);
}

function navigateHistory(node, direction) {
    commitCurrentText(node);
    const state = historyState(node);
    const target = state.index + direction;
    if (target < 0 || target >= state.entries.length) {
        return;
    }
    state.index = target;
    state.dirty = false;
    historySession.save(node, state);
    applyText(node, state.entries[target]);
    syncHistoryToolbar(node);
}

function safeFilePart(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function exportHistory(node) {
    commitCurrentText(node);
    const state = historyState(node);
    const timestamp = new Date();
    const lines = [
        "A5TextPrompt History",
        `Node: ${node.title || NODE_NAME} (${node.id ?? "unassigned"})`,
        `Exported: ${timestamp.toISOString()}`,
        "",
    ];

    if (state.entries.length === 0) {
        lines.push("(No stored prompts)");
    } else {
        state.entries.forEach((entry, index) => {
            const current = index === state.index ? " [current]" : "";
            lines.push(`===== Prompt ${index + 1} of ${state.entries.length}${current} =====`);
            lines.push(entry);
            lines.push("");
        });
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const fileStamp = timestamp.toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = `A5TextPrompt_${safeFilePart(node.id ?? "node")}_${fileStamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawButton(ctx, rect, label, enabled = true) {
    ctx.save();
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 5);
    ctx.fillStyle = enabled ? "#303030" : "#242424";
    ctx.fill();
    ctx.strokeStyle = enabled ? "#777" : "#444";
    ctx.stroke();
    ctx.fillStyle = enabled ? "#e6e6e6" : "#777";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();
}

function pointInRect(pos, rect) {
    return Boolean(rect) && pos[0] >= rect.x && pos[0] <= rect.x + rect.w
        && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

function syncHistoryToolbar(node) {
    const controls = node.__a5TextPromptHistoryControls;
    if (!controls) {
        return;
    }
    const state = historyState(node);
    const hasEntries = state.entries.length > 0 && state.index >= 0;
    controls.indicator.textContent = hasEntries
        ? `${state.index + 1}/${state.entries.length}`
        : "0/0";
    controls.previous.disabled = !hasEntries || state.index <= 0;
    controls.next.disabled = !hasEntries || state.index >= state.entries.length - 1;
    controls.export.disabled = !hasEntries;
}

function growNodeForToolbar(node, addSpace = false) {
    const current = Array.isArray(node.size) ? [...node.size] : null;
    const computed = node.computeSize?.();
    if (!current || !computed) {
        return;
    }
    node.setSize?.([
        Math.max(current[0], computed[0]),
        Math.max(current[1] + (addSpace ? TOOLBAR_HEIGHT : 0), computed[1]),
    ]);
}

function makeToolbarButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.style.cssText = [
        "height:24px",
        "min-width:30px",
        "padding:0 7px",
        "border:1px solid var(--border-color, #666)",
        "border-radius:5px",
        "background:var(--comfy-input-bg, #222)",
        "color:var(--input-text, #ddd)",
        "font:12px sans-serif",
        "cursor:pointer",
    ].join(";");
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function addDOMHistoryToolbar(node) {
    const row = document.createElement("div");
    row.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "width:100%",
        `height:${TOOLBAR_HEIGHT}px`,
        "padding:4px 10px",
        "box-sizing:border-box",
        "pointer-events:auto",
    ].join(";");
    row.addEventListener("pointerdown", (event) => event.stopPropagation());

    const previous = makeToolbarButton("<", "Previous prompt", () => navigateHistory(node, -1));
    const indicator = document.createElement("span");
    indicator.style.cssText = "min-width:48px;text-align:center;color:var(--input-text, #ddd);font:12px sans-serif;";
    const next = makeToolbarButton(">", "Next prompt", () => navigateHistory(node, 1));
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    const exportButton = makeToolbarButton("Export", "Export all stored prompts", () => exportHistory(node));
    exportButton.style.minWidth = "68px";
    row.append(previous, indicator, next, spacer, exportButton);

    const toolbar = node.addDOMWidget(TOOLBAR_NAME, "a5TextPromptHistory", row, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => TOOLBAR_HEIGHT,
        getMaxHeight: () => TOOLBAR_HEIGHT,
        getHeight: () => TOOLBAR_HEIGHT,
    });
    toolbar.serialize = false;
    toolbar._controls = { previous, indicator, next, export: exportButton };
    node.__a5TextPromptHistoryControls = toolbar._controls;
    syncHistoryToolbar(node);
    growNodeForToolbar(node, true);
}

function addHistoryToolbar(node) {
    if (node.widgets?.some((widget) => widget.name === TOOLBAR_NAME)) {
        return;
    }

    if (typeof node.addDOMWidget === "function"
        && typeof document !== "undefined"
        && typeof document.createElement === "function") {
        addDOMHistoryToolbar(node);
        return;
    }

    const toolbar = node.addWidget(
        "custom",
        TOOLBAR_NAME,
        null,
        function draw(ctx, currentNode, width, y, height) {
            const state = historyState(currentNode);
            const widgetHeight = Number.isFinite(height) ? height : TOOLBAR_HEIGHT;
            const rowHeight = Math.min(26, Math.max(22, widgetHeight - 8));
            const top = y + Math.max(2, (widgetHeight - rowHeight) / 2);
            const buttonWidth = 30;
            const exportWidth = 68;

            this._rects = {
                previous: { x: 10, y: top, w: buttonWidth, h: rowHeight },
                next: { x: 104, y: top, w: buttonWidth, h: rowHeight },
                export: { x: Math.max(142, width - exportWidth - 10), y: top, w: exportWidth, h: rowHeight },
            };

            drawButton(ctx, this._rects.previous, "<", state.index > 0);
            drawButton(ctx, this._rects.next, ">", state.index >= 0 && state.index < state.entries.length - 1);
            drawButton(ctx, this._rects.export, "Export", true);

            ctx.save();
            ctx.fillStyle = "#c7c7c7";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const position = state.entries.length ? `${state.index + 1}/${state.entries.length}` : "0/0";
            ctx.fillText(position, 72, top + rowHeight / 2);
            ctx.restore();

            this._tooltips = {
                previous: "Previous prompt",
                next: "Next prompt",
                export: "Export all stored prompts",
            };
        },
        { serialize: false },
    );

    toolbar.serialize = false;
    toolbar.computeSize = (width) => [width, TOOLBAR_HEIGHT];
    toolbar.mouse = function mouse(event, pos, currentNode) {
        if (event.type !== "pointerdown" && event.type !== "mousedown") {
            return false;
        }
        if (pointInRect(pos, this._rects?.previous)) {
            navigateHistory(currentNode, -1);
            return true;
        }
        if (pointInRect(pos, this._rects?.next)) {
            navigateHistory(currentNode, 1);
            return true;
        }
        if (pointInRect(pos, this._rects?.export)) {
            exportHistory(currentNode);
            return true;
        }
        return false;
    };
    growNodeForToolbar(node, true);
}

function candidateTextElements(widget) {
    const result = [];
    const roots = [widget?.inputEl, widget?.element].filter(Boolean);
    for (const root of roots) {
        if (root.matches?.("textarea, input, [contenteditable='true']")) {
            result.push(root);
        }
        root.querySelectorAll?.("textarea, input, [contenteditable='true']").forEach((item) => result.push(item));
    }
    return [...new Set(result)];
}

function syncElementValue(widget, element) {
    if (element && "value" in element) {
        widget.value = String(element.value ?? "");
    }
}

function bindTextEditor(node) {
    const widget = textWidget(node);
    if (!widget) {
        return;
    }
    const state = historyState(node);
    for (const element of candidateTextElements(widget)) {
        if (state.boundElements.has(element)) {
            continue;
        }
        state.boundElements.add(element);
        element.addEventListener("input", () => {
            syncElementValue(widget, element);
            markTextDirty(node);
        });
        element.addEventListener("change", () => {
            syncElementValue(widget, element);
            markTextDirty(node);
        });
        element.addEventListener("blur", () => {
            syncElementValue(widget, element);
            commitCurrentText(node);
        });
    }
}

function patchTextWidget(node) {
    const widget = textWidget(node);
    if (!widget || widget.__a5TextPromptPatched) {
        return;
    }
    widget.__a5TextPromptPatched = true;
    const beforeQueued = widget.beforeQueued;
    widget.beforeQueued = function (...args) {
        const result = beforeQueued?.apply(this, args);
        commitCurrentText(node);
        return result;
    };
    const originalCallback = widget.callback;
    widget.callback = function callback(value, ...args) {
        const result = originalCallback?.call(this, value, ...args);
        const state = historyState(node);
        if (!state.applying) {
            markTextDirty(node);
        }
        return result;
    };
}

function scheduleEditorBinding(node) {
    const state = historyState(node);
    for (const delay of [0, 250, 1000]) {
        const timer = setTimeout(() => bindTextEditor(node), delay);
        state.bindTimers.push(timer);
    }
}

function clearNodeTimers(node) {
    const state = histories.get(node);
    if (!state) {
        return;
    }
    state.bindTimers.forEach((timer) => clearTimeout(timer));
    state.bindTimers.length = 0;
}

function setupNode(node) {
    if (node.__a5TextPromptSetup) {
        return;
    }
    node.__a5TextPromptSetup = true;
    historyState(node);
    patchTextWidget(node);
    addHistoryToolbar(node);
    bindTextEditor(node);
    scheduleEditorBinding(node);
}

function findNode(nodeId) {
    const target = String(nodeId);
    return app.graph?._nodes?.find((node) => String(node.id) === target && node.comfyClass === NODE_NAME);
}

app.registerExtension({
    name: "A5TextPrompt.EditorHistory",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) {
            return;
        }

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function onNodeCreated(...args) {
            const result = originalCreated?.apply(this, args);
            setupNode(this);
            return result;
        };

        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function configure(...args) {
            const result = originalConfigure?.apply(this, args);
            restoreHistory(this);
            setupNode(this);
            growNodeForToolbar(this);
            return result;
        };

        const originalRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function onRemoved(...args) {
            clearNodeTimers(this);
            histories.delete(this);
            return originalRemoved?.apply(this, args);
        };
    },

    nodeCreated(node) {
        if (node.comfyClass === NODE_NAME) {
            setupNode(node);
        }
    },

    setup() {
        app.api?.addEventListener(TEXT_UPDATE_EVENT, (event) => {
            const node = findNode(event.detail?.node_id);
            if (!node) {
                return;
            }
            commitCurrentText(node);
            const incoming = String(event.detail?.text ?? "");
            commitValue(node, incoming, { allowEmpty: true });
            applyText(node, incoming);
        });

        app.api?.addEventListener("executing", (event) => {
            const node = findNode(event.detail?.node ?? event.detail);
            if (node) {
                commitCurrentText(node);
            }
        });
    },
});
