import assert from "node:assert/strict";
import fs from "node:fs/promises";


class FakeElement {
    constructor(value = "", tagName = "div") {
        this.value = value;
        this.tagName = tagName;
        this.listeners = new Map();
        this.children = [];
        this.style = {};
        this.textContent = "";
        this.disabled = false;
        this.clickCalled = false;
    }

    matches() {
        return true;
    }

    querySelectorAll() {
        return [];
    }

    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) ?? [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
    }

    dispatch(name) {
        for (const callback of this.listeners.get(name) ?? []) {
            callback({ type: name, target: this, stopPropagation() {} });
        }
    }

    append(...elements) {
        this.children.push(...elements);
    }

    appendChild(element) {
        this.children.push(element);
    }

    click() {
        if (this.disabled) {
            return;
        }
        this.clickCalled = true;
        this.dispatch("click");
    }

    remove() {}
}

const eventListeners = new Map();
let extension;
let exportedBlob;
let exportedAnchor;

const app = {
    canvas: {},
    graph: {
        _nodes: [],
        setDirtyCanvas() {},
    },
    api: {
        addEventListener(name, callback) {
            eventListeners.set(name, callback);
        },
    },
    registerExtension(value) {
        extension = value;
    },
};

globalThis.__a5TestApp = app;
globalThis.document = {
    body: {
        appendChild() {},
    },
    createElement(tagName) {
        const element = new FakeElement("", tagName);
        if (tagName === "a") {
            exportedAnchor = element;
        }
        return element;
    },
};
globalThis.URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:a5-text-prompt-test";
};
globalThis.URL.revokeObjectURL = () => {};

const sourcePath = new URL("../web/a5_text_prompt.js", import.meta.url);
let source = await fs.readFile(sourcePath, "utf8");
source = source.replace(
    'import { app } from "../../scripts/app.js";',
    "const app = globalThis.__a5TestApp;",
);
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

assert.ok(extension, "frontend extension registered");

class FakeNode {
    constructor(id, initialText = "") {
        this.id = id;
        this.comfyClass = "A5TextPrompt";
        this.title = "A5TextPrompt";
        this.size = [320, 220];
        this.textInput = new FakeElement(initialText);
        this.widgets = [
            { name: "allow_external_text_replace", value: true },
            {
                name: "text",
                value: initialText,
                inputEl: this.textInput,
                callback(value) {
                    this.value = String(value ?? "");
                    this.inputEl.value = this.value;
                },
            },
        ];
        this.onNodeCreated?.();
    }

    addWidget(type, name, value, callback, options) {
        const widget = { type, name, value, callback, options };
        this.widgets.push(widget);
        return widget;
    }

    addDOMWidget(name, type, element, options) {
        const widget = { name, type, element, options, serialize: options?.serialize };
        this.widgets.push(widget);
        return widget;
    }

    computeSize() {
        return [320, 254];
    }

    setSize(size) {
        this.size = size;
    }

    setDirtyCanvas() {}
}

await extension.beforeRegisterNodeDef(FakeNode, { name: "A5TextPrompt" });
extension.setup();

function toolbar(node) {
    return node.widgets.find((widget) => widget.name === "a5_text_prompt_history");
}

function textWidget(node) {
    return node.widgets.find((widget) => widget.name === "text");
}

function position(node) {
    return toolbar(node)._controls.indicator.textContent;
}

function clickToolbar(node, name) {
    toolbar(node)._controls[name].click();
}

function editAndBlur(node, value) {
    node.textInput.value = value;
    node.textInput.dispatch("input");
    node.textInput.dispatch("blur");
}

const first = new FakeNode(1, "initial");
app.graph._nodes.push(first);

assert.equal(position(first), "1/1", "history is seeded from saved text");
assert.equal(toolbar(first).serialize, false, "toolbar is not serialized");
assert.equal(toolbar(first).options.getHeight(), 34, "toolbar reserves one fixed-height row");
assert.equal(toolbar(first).element.children.length, 5, "toolbar renders all inline controls");
assert.equal(textWidget(first).value, "initial", "text widget stays present");

editAndBlur(first, "manual one");
assert.equal(position(first), "2/2", "blur commits a manual edit");
editAndBlur(first, "manual one");
assert.equal(position(first), "2/2", "consecutive duplicates are suppressed");

textWidget(first).value = "execution fallback";
eventListeners.get("executing")({ detail: 1 });
assert.equal(position(first), "3/3", "execution commits edits missed by callbacks");

for (let index = 1; index <= 21; index += 1) {
    editAndBlur(first, `rollover ${index}`);
}
assert.equal(position(first), "20/20", "history is capped at 20 entries");

clickToolbar(first, "previous");
clickToolbar(first, "previous");
assert.equal(textWidget(first).value, "rollover 19", "previous navigation applies stored text");
editAndBlur(first, "branched prompt");
assert.equal(position(first), "19/19", "editing after navigation truncates forward history");
clickToolbar(first, "next");
assert.equal(textWidget(first).value, "branched prompt", "next is disabled at branch end");

eventListeners.get("a5_text_prompt.text_updated")({
    detail: { node_id: "1", text: "" },
});
assert.equal(textWidget(first).value, "", "accepted empty external text updates the widget");
assert.equal(position(first), "20/20", "external values become history entries");

clickToolbar(first, "export");
assert.ok(exportedAnchor.clickCalled, "export starts a browser download");
const exported = await exportedBlob.text();
assert.match(exported, /A5TextPrompt History/);
assert.match(exported, /===== Prompt 20 of 20 \[current\] =====/);
assert.ok(
    exported.indexOf("===== Prompt 1 of 20") < exported.indexOf("===== Prompt 20 of 20"),
    "export is oldest to newest",
);

const second = new FakeNode(2, "separate");
app.graph._nodes.push(second);
assert.equal(position(second), "1/1", "node instances have isolated histories");
assert.equal(textWidget(second).value, "separate");

editAndBlur(second, "second edit");
assert.equal(position(second), "2/2");
second.configure?.({});
assert.equal(position(second), "1/1", "workflow configure resets session history");

assert.equal(
    first.widgets.filter((widget) => widget.name === "text").length,
    1,
    "external update never removes or replaces the editable widget",
);

console.log("A5TextPrompt frontend tests passed");
