import { app } from "../../scripts/app.js";
import { createPromptHistorySession } from "./prompt_history_session.js";

export function registerTextPromptEditor({
    nodeName = "A5TextPrompt",
    textUpdateEvent = "a5_text_prompt.text_updated",
    extrasFactory = null,
} = {}) {
    const NODE_NAME = nodeName;
    const TEXT_UPDATE_EVENT = textUpdateEvent;
    const HISTORY_LIMIT = 20;
    const TOOLBAR_NAME = "a5_text_prompt_history";
    const TOOLBAR_HEIGHT = 34;

    const histories = new WeakMap();
    const historySession = createPromptHistorySession();
    const editors = new WeakMap();
    const extras = new WeakMap();
    const selections = new WeakMap();
    let editorZIndex = 10000;

    function textWidget(node) {
        return node.widgets?.find((widget) => widget.name === "text");
    }

    function widgetText(node) {
        return String(textWidget(node)?.value ?? "");
    }

    function dirtyCanvas(node) {
        syncEditor(node);
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
            for (const element of [...candidateTextElements(widget), selections.get(node)?.element].filter(Boolean)) {
                if ("value" in element && element.value !== prompt) element.value = prompt;
            }
            widget.callback?.call(widget, prompt, app.canvas, node, [0, 0]);
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

    function syncEditor(node) {
        const editor = editors.get(node);
        if (editor && editor.textarea.value !== widgetText(node)) {
            editor.textarea.value = widgetText(node);
        }
    }

    function rememberSelection(node, element) {
        if (typeof element.selectionStart === "number") {
            selections.set(node, { element, start: element.selectionStart, end: element.selectionEnd });
        }
    }

    function insertText(node, text) {
        const current = widgetText(node);
        const selection = selections.get(node);
        const start = Math.min(selection?.start ?? current.length, current.length);
        const end = Math.max(start, Math.min(selection?.end ?? start, current.length));
        const value = current.slice(0, start) + text + current.slice(end);
        applyText(node, value);
        // Insertion is part of the current edit; blur/queue commits it once.
        markTextDirty(node);
        const element = selection?.element?.isConnected
            ? selection.element : editors.get(node)?.textarea ?? candidateTextElements(textWidget(node))[0];
        element?.focus();
        element?.setSelectionRange?.(start + text.length, start + text.length);
        if (element) rememberSelection(node, element);
    }

    function closeEditor(node) {
        const editor = editors.get(node);
        if (!editor) return;
        commitCurrentText(node);
        editor.stopDrag?.();
        editor.unmountExtras?.();
        editor.panel.remove();
        editors.delete(node);
        // A closed popout must not remain the target for future insertions.
        if (selections.get(node)?.element === editor.textarea) selections.delete(node);
    }

    function openEditor(node) {
        commitCurrentText(node);
        const existing = editors.get(node);
        if (existing) {
            existing.panel.style.zIndex = String(++editorZIndex);
            existing.textarea.focus();
            return;
        }
        const panel = document.createElement("section");
        panel.className = "a5-text-prompt-editor";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", `${node.title || NODE_NAME} text editor`);
        panel.style.cssText = [
            "position:fixed", "display:flex", "flex-direction:column", "resize:both", "overflow:hidden",
            "min-width:min(320px, calc(100vw - 24px))", "min-height:260px",
            "max-width:calc(100vw - 24px)", "max-height:calc(100vh - 24px)",
            "border:1px solid var(--border-color, #666)", "border-radius:6px",
            "background:var(--comfy-menu-bg, #222)", "color:var(--input-text, #ddd)",
            "box-shadow:0 10px 36px #0008", "box-sizing:border-box", "font:13px sans-serif",
        ].join(";");
        const width = Math.min(740, window.innerWidth - 32);
        const height = Math.min(540, window.innerHeight - 32);
        Object.assign(panel.style, {
            width: `${width}px`, height: `${height}px`,
            left: `${Math.max(12, (window.innerWidth - width) / 2)}px`,
            top: `${Math.max(12, (window.innerHeight - height) / 2)}px`,
            zIndex: String(++editorZIndex),
        });
        const header = document.createElement("header");
        header.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px;cursor:move;flex:none;border-bottom:1px solid var(--border-color, #555);";
        const title = document.createElement("span");
        title.textContent = `${node.title || NODE_NAME} #${node.id}`;
        title.style.cssText = "flex:1;min-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        const previous = makeToolbarButton("<", "Previous prompt", () => navigateHistory(node, -1));
        const indicator = document.createElement("span");
        indicator.style.cssText = "min-width:42px;text-align:center;";
        indicator.setAttribute("aria-live", "polite");
        const next = makeToolbarButton(">", "Next prompt", () => navigateHistory(node, 1));
        const exportButton = makeToolbarButton("Export", "Export all stored prompts", () => exportHistory(node));
        const close = makeToolbarButton("X", "Close editor (Esc)", () => closeEditor(node));
        header.append(title, previous, indicator, next, exportButton, close);
        const textarea = document.createElement("textarea");
        textarea.setAttribute("aria-label", "Prompt text");
        textarea.spellcheck = true;
        textarea.value = widgetText(node);
        textarea.style.cssText = "display:block;flex:1;min-height:80px;width:100%;box-sizing:border-box;resize:none;border:0;padding:12px;background:var(--comfy-input-bg, #181818);color:var(--input-text, #ddd);font:14px/1.5 monospace;letter-spacing:0;outline:none;";
        panel.append(header, textarea);
        const editor = { panel, textarea, controls: { previous, indicator, next, export: exportButton } };
        editors.set(node, editor);
        editor.unmountExtras = extras.get(node)?.mount?.(panel);
        document.body.appendChild(panel);
        syncHistoryToolbar(node);
        panel.addEventListener("pointerdown", () => { panel.style.zIndex = String(++editorZIndex); });
        panel.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                closeEditor(node);
            }
        });
        textarea.addEventListener("input", () => {
            applyText(node, textarea.value);
            markTextDirty(node);
            rememberSelection(node, textarea);
        });
        textarea.addEventListener("blur", () => commitCurrentText(node));
        for (const name of ["focus", "select", "keyup", "pointerup", "blur"]) {
            textarea.addEventListener(name, () => rememberSelection(node, textarea));
        }
        header.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || event.target.closest("button")) return;
            event.preventDefault();
            editor.stopDrag?.();
            const bounds = panel.getBoundingClientRect();
            const offsetX = event.clientX - bounds.left;
            const offsetY = event.clientY - bounds.top;
            const move = (e) => {
                panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - offsetX))}px`;
                panel.style.top = `${Math.max(0, Math.min(window.innerHeight - header.offsetHeight, e.clientY - offsetY))}px`;
            };
            const stop = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", stop);
                window.removeEventListener("pointercancel", stop);
                editor.stopDrag = null;
            };
            editor.stopDrag = stop;
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", stop);
            window.addEventListener("pointercancel", stop);
        });
        textarea.focus();
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
        const state = historyState(node);
        const hasEntries = state.entries.length > 0 && state.index >= 0;
        for (const controls of [node.__a5TextPromptHistoryControls, editors.get(node)?.controls]) {
            if (!controls) continue;
            controls.indicator.textContent = hasEntries
                ? `${state.index + 1}/${state.entries.length}`
                : "0/0";
            controls.previous.disabled = !hasEntries || state.index <= 0;
            controls.next.disabled = !hasEntries || state.index >= state.entries.length - 1;
            controls.export.disabled = !hasEntries;
        }
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
        const iconName = {
            "Previous prompt": "pi-chevron-left",
            "Next prompt": "pi-chevron-right",
            "Export all stored prompts": "pi-download",
            "Close editor (Esc)": "pi-times",
        }[title];
        if (iconName) {
            const icon = document.createElement("i");
            icon.className = `pi ${iconName}`;
            button.append(icon);
        } else {
            button.textContent = label;
        }
        button.title = title;
        button.setAttribute("aria-label", title);
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
        const editButton = makeToolbarButton("", "Open text editor", () => openEditor(node));
        const editIcon = document.createElement("i");
        editIcon.className = "pi pi-external-link";
        editButton.append(editIcon);
        row.append(previous, indicator, next, spacer, exportButton, editButton);

        const toolbar = node.addDOMWidget(TOOLBAR_NAME, "a5TextPromptHistory", row, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => TOOLBAR_HEIGHT,
            getMaxHeight: () => TOOLBAR_HEIGHT,
            getHeight: () => TOOLBAR_HEIGHT,
        });
        toolbar.serialize = false;
        toolbar._controls = { previous, indicator, next, export: exportButton, edit: editButton };
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
        const roots = [widget?.element ?? widget?.inputEl].filter(Boolean);
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

    function bindTextEditor(node, visibleElement = null) {
        const widget = textWidget(node);
        if (!widget) {
            return;
        }
        const state = historyState(node);
        for (const element of [...candidateTextElements(widget), visibleElement].filter(Boolean)) {
            if (state.boundElements.has(element)) {
                continue;
            }
            state.boundElements.add(element);
            for (const eventName of ["focus", "select", "keyup", "pointerup", "blur"]) {
                element.addEventListener(eventName, () => rememberSelection(node, element));
            }
            element.addEventListener("input", () => {
                syncElementValue(widget, element);
                rememberSelection(node, element);
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
            syncEditor(node);
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
        if (extrasFactory) {
            const extension = extrasFactory(node, {
                insert: (text) => insertText(node, text),
                commit: () => commitCurrentText(node),
            });
            extras.set(node, extension);
            extension.attach?.();
        }
        bindTextEditor(node);
        scheduleEditorBinding(node);
    }

    function findNode(nodeId) {
        const target = String(nodeId);
        return app.graph?._nodes?.find((node) => String(node.id) === target && node.comfyClass === NODE_NAME);
    }

    app.registerExtension({
        name: `${NODE_NAME}.EditorHistory`,

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
                closeEditor(this);
                extras.get(this)?.destroy?.();
                extras.delete(this);
                selections.delete(this);
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
            // Nodes 2.0 mounts its own textarea instead of widget.element.
            document.addEventListener?.("focusin", (event) => {
                const element = event.target;
                if (!element.matches?.("textarea") || element.closest(".a5-snippet-library")) return;
                const owner = element.closest("[node-type][node-id]");
                if (owner?.getAttribute("node-type") !== NODE_NAME) return;
                const node = findNode(owner.getAttribute("node-id"));
                if (!node) return;
                bindTextEditor(node, element);
                rememberSelection(node, element);
            });

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
}
