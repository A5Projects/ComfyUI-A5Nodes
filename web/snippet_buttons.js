import { api } from "../../scripts/api.js";

const ENDPOINT = "/a5_text_prompt/snippets";
const subscribers = new Set();
let slots = Array.from({ length: 8 }, () => ({ label: "", text: "" }));
let libraryError = "";
let ready = false;
let loading;

function notify() {
    for (const update of subscribers) update();
}

async function request(options) {
    const response = await api.fetchApi(ENDPOINT, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load snippet library.");
    if (!Array.isArray(body.slots) || body.slots.length !== 8) throw new Error("Invalid snippet library.");
    slots = body.slots;
    ready = true;
    libraryError = "";
    notify();
}

async function refresh() {
    if (!loading) {
        loading = request().catch((error) => {
            libraryError = error.message;
            notify();
        }).finally(() => { loading = null; });
    }
    return loading;
}

function button(label, title, callback) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.title = title;
    element.setAttribute("aria-label", title);
    element.style.cssText = "min-width:0;height:24px;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border-color, #666);border-radius:4px;background:var(--comfy-input-bg, #222);color:var(--input-text, #ddd);font:12px sans-serif;cursor:pointer;";
    element.addEventListener("click", callback);
    return element;
}

export function createSnippetExtras(node, actions) {
    const mounts = new Set();

    function mount(parent, onHeightChanged = () => {}) {
        const root = document.createElement("div");
        root.className = "a5-snippet-library";
        root.style.cssText = "flex:none;width:100%;box-sizing:border-box;padding:6px 10px;overflow:auto;max-height:240px;color:var(--input-text, #ddd);font:12px sans-serif;";
        if (parent.className === "a5-text-prompt-editor") root.style.maxHeight = "min(240px, 50%)";
        root.addEventListener("pointerdown", (event) => event.stopPropagation());
        root.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") event.stopPropagation();
        });
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;";
        const buttons = Array.from({ length: 8 }, (_, index) => {
            const item = button("", `Insert snippet ${index + 1}`, () => {
                if (slots[index].text) actions.insert(slots[index].text);
            });
            // Preserve the text selection when a snippet is clicked.
            item.addEventListener("pointerdown", (event) => event.preventDefault());
            grid.append(item);
            return item;
        });
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Edit snippets";
        summary.style.cssText = "cursor:pointer;padding:5px 0;";
        const form = document.createElement("div");
        form.style.cssText = "display:grid;grid-template-columns:70px minmax(0,1fr) 32px 32px;gap:5px;";
        const selector = document.createElement("select");
        selector.setAttribute("aria-label", "Snippet slot");
        for (let i = 0; i < 8; i++) {
            const option = document.createElement("option");
            option.value = String(i);
            option.textContent = `Slot ${i + 1}`;
            selector.append(option);
        }
        const label = document.createElement("input");
        label.placeholder = "Button label";
        label.maxLength = 40;
        label.setAttribute("aria-label", "Snippet label");
        const text = document.createElement("textarea");
        text.setAttribute("aria-label", "Snippet text");
        text.placeholder = "Snippet text";
        text.maxLength = 16000;
        text.style.cssText = "grid-column:1/-1;height:64px;resize:vertical;max-height:96px;";
        const status = document.createElement("span");
        status.setAttribute("role", "status");
        status.style.cssText = "grid-column:1/-1;min-height:16px;overflow-wrap:anywhere;";
        for (const field of [selector, label, text]) {
            field.style.cssText += ";min-width:0;box-sizing:border-box;border:1px solid var(--border-color, #666);border-radius:3px;background:var(--comfy-input-bg, #181818);color:var(--input-text, #ddd);font:12px sans-serif;padding:3px;";
        }
        let dirty = false;
        let saving = false;
        let alive = true;
        selector.value = "0";
        const fill = () => {
            const slot = slots[Number(selector.value)];
            label.value = slot.label;
            text.value = slot.text;
            dirty = false;
        };
        const save = async (clear = false) => {
            saving = true;
            update();
            status.textContent = "Saving...";
            try {
                await request({
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ index: Number(selector.value), label: clear ? "" : label.value, text: clear ? "" : text.value }),
                });
                if (!alive) return;
                fill();
                status.textContent = clear ? "Slot cleared" : "Saved";
            } catch (error) {
                if (alive) status.textContent = error.message;
            } finally {
                saving = false;
                if (alive) update();
            }
        };
        const saveButton = button("", "Save snippet", () => save());
        const saveIcon = document.createElement("i");
        saveIcon.className = "pi pi-save";
        saveButton.append(saveIcon);
        const clearButton = button("", "Clear snippet slot", () => save(true));
        const clearIcon = document.createElement("i");
        clearIcon.className = "pi pi-trash";
        clearButton.append(clearIcon);
        form.append(selector, label, saveButton, clearButton, text, status);
        details.append(summary, form);
        root.append(grid, details);
        parent.append(root);

        function update() {
            buttons.forEach((item, index) => {
                const slot = slots[index];
                item.textContent = slot.label || slot.text.replace(/\s+/g, " ").slice(0, 22) || `${index + 1}: empty`;
                item.title = slot.text || `Empty slot ${index + 1}`;
                item.disabled = !ready || !slot.text;
            });
            selector.disabled = label.disabled = text.disabled = saving;
            saveButton.disabled = clearButton.disabled = saving || !ready;
            if (!dirty && !saving) fill();
            if (libraryError) status.textContent = libraryError;
        }
        selector.addEventListener("change", fill);
        label.addEventListener("input", () => { dirty = true; });
        text.addEventListener("input", () => { dirty = true; });
        details.addEventListener("toggle", () => {
            onHeightChanged(details.open ? 238 : 92);
            if (details.open) refresh();
        });
        subscribers.add(update);
        update();
        refresh();
        const cleanup = () => {
            alive = false;
            subscribers.delete(update);
            mounts.delete(cleanup);
            root.remove();
        };
        mounts.add(cleanup);
        return cleanup;
    }

    return {
        mount,
        attach() {
            let height = 92;
            const container = document.createElement("div");
            container.style.cssText = "height:100%;overflow:auto;";
            const initial = [...node.size];
            mount(container, (newHeight) => {
                height = newHeight;
                const minimum = node.computeSize?.();
                if (minimum) node.setSize?.([
                    Math.max(node.size[0], minimum[0]),
                    Math.max(node.size[1], minimum[1]),
                ]);
                node.arrange?.();
                node.setDirtyCanvas?.(true, true);
            });
            const widget = node.addDOMWidget("a5_snippet_buttons", "a5SnippetButtons", container, {
                serialize: false, hideOnZoom: false,
                getMinHeight: () => height, getMaxHeight: () => height, getHeight: () => height,
            });
            widget.serialize = false;
            node.setSize?.([initial[0], Math.max(node.size[1], initial[1] + height)]);
        },
        destroy() {
            for (const cleanup of [...mounts]) cleanup();
        },
    };
}
