import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Exercise the real event/upload handlers without a running ComfyUI server.
class Element {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.listeners = new Map();
        this.attributes = {}; this.dataset = {}; this.className = "";
        this.value = ""; this.naturalWidth = 0; this.hidden = false;
        this.classList = {
            contains: name => this.className.split(" ").includes(name),
            toggle: (name, enabled) => {
                const names = new Set(this.className.split(" ").filter(Boolean));
                if (enabled ?? !names.has(name)) names.add(name); else names.delete(name);
                this.className = [...names].join(" ");
            },
            add: name => this.classList.toggle(name, true),
            remove: name => this.classList.toggle(name, false),
        };
    }
    append(...children) { children.forEach(c => { c.parent = this; this.children.push(c); }); }
    replaceChildren(...children) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) ?? [];
        callbacks.push(callback); this.listeners.set(name, callbacks);
    }
    dispatch(name, detail = {}) {
        const event = { target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...detail };
        for (const callback of this.listeners.get(name) ?? []) callback(event);
    }
    click() { if (!this.disabled) this.dispatch("click"); }
    focus() { this.dispatch("focusin"); }
    closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(c => [ ...(c.classList.contains(selector.slice(1)) ? [c] : []), ...c.querySelectorAll(selector)]); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    get isConnected() { return !!this.parent; }
    showModal() {}
    close() { this.dispatch("close"); }
}
globalThis.Element = Element;
globalThis.document = { head: new Element("head"), body: new Element("body"),
    createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element("text"), { textContent: text }),
    getElementById: id => document.head.children.find(c => c.id === id),
};
globalThis.location = { origin: "http://localhost:8188", href: "http://localhost:8188/" };
let extension, failName, holdUpload;
const requests = [];
globalThis.__multiApp = { registerExtension: value => { extension = value; } };
globalThis.__multiApi = {
    apiURL: path => path,
    async fetchApi(path, options) {
        assert.equal(path, "/upload/image");
        const file = options.body.get("image");
        requests.push(file.name);
        if (holdUpload) await holdUpload;
        return { ok: file.name !== failName, status: 500,
            json: async () => ({ name: file.name, type: "input", subfolder: "uploads" }) };
    },
};
const stateSource = await readFile(new URL("../web/multi_image_state.js", import.meta.url), "utf8");
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const stateURL = dataURL(stateSource);
const { defaultState } = await import(stateURL);
const sourceURL = new URL("../web/a5_multi_image_load.js", import.meta.url);
let source = await readFile(sourceURL, "utf8");
source = source.replace('import { app } from "../../scripts/app.js";', 'const app = globalThis.__multiApp;')
    .replace('import { api } from "../../scripts/api.js";', 'const api = globalThis.__multiApi;')
    .replace('"./multi_image_state.js"', JSON.stringify(stateURL))
    .replaceAll("import.meta.url", JSON.stringify(sourceURL.href));
await import(dataURL(source));

function makeNode(state = defaultState()) {
    const node = { outputs: Array.from({ length: 7 }, () => ({ links: [42] })),
        graph: { beforeChange() {}, afterChange() {} },
        addDOMWidget(name, type, root, options) {
            this.root = root;
            const widget = { name, type, options };
            Object.defineProperty(widget, "value", { get: options.getValue, set: options.setValue });
            return widget;
        },
    };
    const { widget } = extension.getCustomWidgets().A5_MULTI_IMAGE_STATE(node, "state", ["STRING", { default: JSON.stringify(state) }]);
    node.widget = widget;
    return node;
}
const read = node => JSON.parse(node.widget.value);
const tiles = node => node.root.querySelectorAll(".a5-multi-tile");
const extras = node => node.root.querySelectorAll(".a5-multi-extras")[0];
const file = name => new File(["image"], name, { type: "image/png" });
const dropEvent = (target, files) => ({ target, dataTransfer: { files, types: ["Files"], getData: () => "" } });
const settle = async node => {
    for (let i = 0; i < 100 && node.root.attributes["aria-busy"] === "true"; i++) await new Promise(setImmediate);
    assert.equal(node.root.attributes["aria-busy"], "false");
};

const unrelated = { name: "LoadImage", input: { required: { state: ["STRING"] } } };
extension.beforeRegisterNodeDef(null, unrelated);
assert.equal(unrelated.input.required.state[0], "STRING");
const node = makeNode();
await node.onDragDrop(dropEvent(tiles(node)[4], [file("a.png"), file("b.png"), file("c.png")]));
assert.deepEqual(read(node).slots.map(s => s.file), ["uploads/c.png", "", "", "", "uploads/a.png", "uploads/b.png"]);

// A delayed multi-drop must not replace an occupied slot if another upload fails.
failName = "bad.png";
await node.onDragDrop(dropEvent(tiles(node)[4], [file("survives.png"), file("bad.png")]));
assert.equal(read(node).slots[4].file, "uploads/a.png");
assert.equal(read(node).slots[1].file, "uploads/survives.png");
assert.match(node.root.querySelectorAll(".a5-multi-status")[0].textContent, /bad.png/);
failName = undefined;

// Clipboard dispatch captures the selected destination before async upload.
tiles(node)[2].dispatch("focusin");
assert.equal(node.pasteFiles([file("pasted.png")]), true);
extras(node).dispatch("focusin");
await settle(node);
assert.equal(read(node).slots[2].file, "uploads/pasted.png");
node.root.dispatch("paste", { clipboardData: { files: [file("duplicate.png"), file("duplicate.png")] } });
await settle(node);
assert.deepEqual(read(node).extras, ["uploads/duplicate.png", "uploads/duplicate.png"]);
assert.equal(node.pasteFiles([new File(["text"], "note.txt", { type: "text/plain" })]), false);

// Enqueue is blocked while uploads are in flight, then serialization resumes.
let release;
holdUpload = new Promise(resolve => { release = resolve; });
node.pasteFiles([file("pending.png")]);
assert.throws(() => node.widget.serializeValue(), /uploads to finish/);
release(); await settle(node); holdUpload = undefined;
assert.equal(read(node).extras.at(-1), "uploads/pending.png");
assert.equal(node.widget.serializeValue(), node.widget.value);

const duplicate = makeNode(read(node));
extras(duplicate).children.at(-1).click();
assert.equal(read(duplicate).extras.length, 0);
assert.equal(read(node).extras.length, 3);
const checkbox = tiles(duplicate)[0].children[1].children[0];
checkbox.checked = false; checkbox.dispatch("change");
assert.equal(read(duplicate).slots[0].enabled, false);
assert.equal(read(node).slots[0].enabled, true);
assert.deepEqual(duplicate.outputs[0].links, [42]);

const before = requests.length;
await node.onDragDrop({ target: extras(node), dataTransfer: { files: [], getData: () =>
    "http://localhost:8188/view?filename=existing.png&type=output&subfolder=test" } });
assert.equal(read(node).extras.at(-1), "test/existing.png [output]");
assert.equal(requests.length, before, "server-side preview drops reuse the existing file");
assert.equal(await node.onDragDrop({ target: extras(node), dataTransfer: { files: [], getData: () =>
    "https://unrelated.example/image.png" } }), false);

const snapshot = node.widget.value;
node.widget.value = "invalid state";
assert.equal(node.widget.value, "invalid state", "malformed workflow data is retained for recovery");
node.widget.value = snapshot;
assert.equal(node.widget.value, snapshot);
node.onRemoved();
console.log("Multi-image frontend: targeted drops, partial failures, paste routing, upload gating, duplicate isolation, clearing, wiring and saved state passed.");
