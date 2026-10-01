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
        this.isConnected = true;
        this.selectionStart = this.selectionEnd = 0;
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

    dispatch(name, detail = {}) {
        for (const callback of this.listeners.get(name) ?? []) {
            callback({ type: name, target: this, stopPropagation() {}, preventDefault() {}, ...detail });
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

    remove() { this.isConnected = false; }
    setAttribute(name, value) { this[name] = value; }
    focus() { this.dispatch("focus"); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
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
        children: [],
        appendChild(element) { this.children.push(element); },
    },
    createElement(tagName) {
        const element = new FakeElement("", tagName);
        if (tagName === "a") {
            exportedAnchor = element;
        }
        return element;
    },
};
globalThis.window = { innerWidth: 1200, innerHeight: 800 };
globalThis.URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:a5-text-prompt-test";
};
globalThis.URL.revokeObjectURL = () => {};

const sourcePath = new URL("../web/text_prompt_editor.js", import.meta.url);
let source = await fs.readFile(sourcePath, "utf8");
source = source.replace(
    'import { app } from "../../scripts/app.js";',
    "const app = globalThis.__a5TestApp;",
);
source = source.replace('"./prompt_history_session.js"', JSON.stringify(
    new URL("../web/prompt_history_session.js", import.meta.url).href,
));
const { registerTextPromptEditor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
registerTextPromptEditor({
    extrasFactory(node, actions) {
        node.insertSnippet = actions.insert;
        return {};
    },
});

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
assert.equal(toolbar(first).element.children.length, 6, "toolbar includes the popout editor control");
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
assert.equal(position(first), "20/20", "editing after navigation retains newer entries up to the limit");
clickToolbar(first, "next");
assert.equal(textWidget(first).value, "branched prompt", "next is disabled at branch end");
clickToolbar(first, "previous");
assert.equal(textWidget(first).value, "rollover 21", "newer history survives editing an older prompt");
textWidget(first).beforeQueued();
assert.equal(position(first), "19/20", "running an old entry does not duplicate it");
editAndBlur(first, "rollover 19");
assert.equal(position(first), "17/20", "nonconsecutive duplicate selects its original position");

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

const editorNode = new FakeNode(8, "original");
app.graph._nodes.push(editorNode);
const originalSize = [...editorNode.size];
clickToolbar(editorNode, "edit");
const panel = document.body.children.at(-1);
const popupText = panel.children[1];
popupText.value = "edited in popout";
popupText.dispatch("input");
assert.equal(editorNode.textInput.value, "edited in popout", "popout updates inline field immediately");
assert.equal(position(editorNode), "1/1", "typing waits for blur");
popupText.dispatch("blur");
assert.equal(position(editorNode), "2/2");
editAndBlur(editorNode, "edited in node");
assert.equal(popupText.value, "edited in node", "inline field updates popout immediately");
eventListeners.get("a5_text_prompt.text_updated")({ detail: { node_id: 8, text: "external" } });
assert.equal(popupText.value, "external", "external result updates the open popout");
assert.equal(panel.isConnected, true, "execution does not close the popout");
clickToolbar(editorNode, "previous");
assert.equal(popupText.value, "edited in node", "history is shared across both editors");
assert.deepEqual(editorNode.size, originalSize, "editing and navigation never resize the node");
popupText.setSelectionRange(0, 6);
popupText.dispatch("select");
editorNode.insertSnippet("<image 1>");
assert.equal(popupText.value, "<image 1> in node", "snippet replaces only the selected span");
assert.equal(editorNode.textInput.value, popupText.value);
assert.equal(popupText.selectionStart, "<image 1>".length, "insertion leaves caret after the snippet");
panel.dispatch("keydown", { key: "Escape" });
assert.equal(panel.isConnected, false, "Escape closes the focused popout");
editorNode.insertSnippet(" append");
assert.equal(editorNode.textInput.value, "<image 1> in node append", "closed editor selection is discarded");
clickToolbar(editorNode, "edit");
const reopened = document.body.children.at(-1);
assert.equal(reopened.children[1].value, editorNode.textInput.value, "reopening shows the live value");
clickToolbar(editorNode, "edit");
assert.equal(document.body.children.at(-1), reopened, "opening twice reuses the same popout");
editorNode.onRemoved();
assert.equal(reopened.isConnected, false, "node removal closes the editor");

editAndBlur(second, "second edit");
assert.equal(position(second), "2/2");
second.configure?.({});
assert.equal(position(second), "2/2", "reconfiguring a live node preserves session history");
second.textInput.value = "queued edit";
second.textInput.dispatch("input");
assert.equal(position(second), "2/2", "typing is not committed until blur or run");
textWidget(second).beforeQueued();
assert.equal(position(second), "3/3", "queue hook saves edits even when execution is cached");

const workflowA = { id: "workflow-A" };
second.graph = workflowA;
editAndBlur(second, "workflow A saved");
second.onRemoved();
const otherWorkflow = new FakeNode(2, "workflow B text");
otherWorkflow.graph = { id: "workflow-B" };
otherWorkflow.configure({});
assert.equal(position(otherWorkflow), "1/1", "same node ID in another workflow is isolated");
const returned = new FakeNode(2, "workflow A saved");
returned.graph = { id: "workflow-A" };
returned.configure({});
assert.equal(position(returned), "4/4", "workflow-tab return restores history to a recreated node");
clickToolbar(returned, "previous");
assert.equal(textWidget(returned).value, "queued edit");
const subgraphNode = new FakeNode(2, "subgraph text");
subgraphNode.graph = { id: "subgraph", rootGraph: workflowA };
subgraphNode.configure({});
assert.equal(position(subgraphNode), "1/1", "subgraph node IDs do not collide with root nodes");
editAndBlur(subgraphNode, "subgraph edit");
const otherSubgraph = new FakeNode(2, "other workflow subgraph");
otherSubgraph.graph = { id: "subgraph", rootGraph: { id: "workflow-B" } };
otherSubgraph.configure({});
assert.equal(position(otherSubgraph), "1/1", "subgraph history is scoped to its root workflow");
for (const item of [first, second, otherWorkflow, returned, subgraphNode, otherSubgraph]) {
    item.onRemoved();
}

assert.equal(
    first.widgets.filter((widget) => widget.name === "text").length,
    1,
    "external update never removes or replaces the editable widget",
);

console.log("A5TextPrompt frontend tests passed");
