import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Exercise the real event/upload handlers without a running ComfyUI server.
class Element {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.listeners = new Map();
        this.attributes = {}; this.dataset = {}; this.style = {}; this.className = "";
        this.offsetWidth = 172; this.offsetHeight = 120;
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
    addEventListener(name, callback, options = {}) {
        const callbacks = this.listeners.get(name) ?? [];
        callbacks.push(callback); this.listeners.set(name, callbacks);
        options.signal?.addEventListener("abort", () => this.listeners.set(name,
            (this.listeners.get(name) ?? []).filter(listener => listener !== callback)), { once: true });
    }
    dispatch(name, detail = {}) {
        const event = { target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...detail };
        for (const callback of this.listeners.get(name) ?? []) callback(event);
        return event;
    }
    click() { if (!this.disabled) this.dispatch("click"); }
    focus() { document.activeElement = this; this.dispatch("focusin"); }
    closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(c => [ ...((selector.startsWith(".") ? c.classList.contains(selector.slice(1)) : c.tagName === selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
    contains(item) { return item === this || this.children.some(child => child.contains(item)); }
    getBoundingClientRect() { return { left: 20, top: 30 }; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    get isConnected() { return !!this.parent; }
    showModal() {}
    close() { this.dispatch("close"); }
}
globalThis.Element = Element;
globalThis.document = Object.assign(new Element("document"), { head: new Element("head"), body: new Element("body"),
    createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element("text"), { textContent: text }),
    getElementById: id => document.head.children.find(c => c.id === id),
});
globalThis.window = Object.assign(new Element("window"), { innerWidth: 800, innerHeight: 600 });
globalThis.Image = class extends Element { constructor() { super("img"); } };
let clipboardItems = [], clipboardReadError, clipboardWriteError, clipboardReadGate;
const clipboardWrites = [], viewRequests = [];
Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: {
    async read() { if (clipboardReadGate) await clipboardReadGate; if (clipboardReadError) throw clipboardReadError; return clipboardItems; },
    async write(items) { if (clipboardWriteError) throw clipboardWriteError; clipboardWrites.push(await items[0].data["image/png"]); },
} });
globalThis.ClipboardItem = class { constructor(data) { this.data = data; } };
globalThis.__multiComfyApp = { copyToClipspace() {}, clipspace_invalidate_handler() {} };
globalThis.location = { origin: "http://localhost:8188", href: "http://localhost:8188/" };
let extension, failName, holdUpload;
let choices = ["A.png", "Z.png", "a.png"], failChoices = false, choiceRequests = 0;
const requests = [];
globalThis.__multiApp = { registerExtension: value => { extension = value; } };
globalThis.__multiApi = {
    apiURL: path => path,
    async fetchApi(path, options) {
        if (path.startsWith("/view?")) {
            viewRequests.push(path);
            return { ok: true, blob: async () => new Blob(["original PNG pixels"], { type: "image/png" }) };
        }
        if (path === "/object_info/LoadImage") {
            choiceRequests++;
            return { ok: !failChoices, status: 503,
                json: async () => ({ LoadImage: { input: { required: { image: [choices] } } } }) };
        }
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
source = source.replace('import { app, ComfyApp } from "../../scripts/app.js";', 'const app = globalThis.__multiApp; const ComfyApp = globalThis.__multiComfyApp;')
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

// Navigation works directly from the filename row, without opening a dialog.
const navigationState = defaultState();
navigationState.slots[0] = { file: "A.png", enabled: false };
const navigation = makeNode(navigationState);
const arrows = tiles(navigation)[0].querySelectorAll(".a5-multi-step");
const nextImage = async () => { arrows[1].click(); await new Promise(setImmediate); };
const previousImage = async () => { arrows[0].click(); await new Promise(setImmediate); };
const dialogsBefore = document.body.children.length;
await nextImage();
assert.equal(read(navigation).slots[0].file, "Z.png", "retain normal loader order rather than locale sorting");
assert.equal(read(navigation).slots[0].enabled, false);
assert.deepEqual(navigation.outputs[0].links, [42]);
assert.deepEqual(read(navigation).slots.slice(1), navigationState.slots.slice(1));
await previousImage();
assert.equal(read(navigation).slots[0].file, "A.png");
await previousImage();
assert.equal(read(navigation).slots[0].file, "A.png", "stop at the beginning of the list");
const callsBefore = choiceRequests;
arrows[1].click(); arrows[1].click();
await new Promise(setImmediate);
assert.equal(choiceRequests, callsBefore + 1, "rapid clicks share the in-flight request");
assert.equal(read(navigation).slots[0].file, "a.png", "rapid clicks each advance the selection");
await nextImage();
assert.equal(read(navigation).slots[0].file, "a.png", "stop at the end without emptying the slot");
choices.push("new-upload.png");
await nextImage();
assert.equal(read(navigation).slots[0].file, "new-upload.png", "refresh choices to include new uploads");
assert.equal(document.body.children.length, dialogsBefore);
assert.match(tiles(navigation)[0].children[0].children[0].src, /new-upload.png/);
failChoices = true;
await previousImage();
assert.equal(read(navigation).slots[0].file, "new-upload.png");
assert.match(navigation.root.querySelectorAll(".a5-multi-status")[0].textContent, /503/);
failChoices = false;
choices = [];
const emptyNavigation = makeNode();
emptyNavigation.root.querySelectorAll(".a5-multi-step")[1].click();
await new Promise(setImmediate);
assert.deepEqual(read(emptyNavigation), defaultState(), "an empty server list is a safe no-op");

// Empty and populated slots have their own menu, with no native menu/dialog.
const contextNode = makeNode();
const menu = () => document.body.querySelectorAll(".a5-multi-image-menu")[0];
const menuItem = label => menu().children.find(item => item.textContent === label);
let prevented = false, stopped = false;
tiles(contextNode)[3].dispatch("contextmenu", { clientX: 790, clientY: 590,
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
assert.ok(prevented && stopped);
assert.equal(menu().attributes["aria-label"], "Image 4 actions");
assert.equal(menu().style.left, "624px", "menu stays inside the viewport at any node zoom");
assert.equal(menuItem("Paste image").disabled, false);
assert.equal(menuItem("Copy image").disabled, true);
assert.equal(menuItem("Copy (Clipspace)").disabled, true);
assert.equal(document.body.querySelectorAll("dialog").length, 0);
clipboardItems = [{ types: ["text/html", "image/png"], getType: async () => file("clipboard.png") }];
let releaseRead;
clipboardReadGate = new Promise(resolve => { releaseRead = resolve; });
menuItem("Paste image").click();
assert.equal(menu(), undefined);
tiles(contextNode)[0].focus();
releaseRead(); await new Promise(setImmediate); await settle(contextNode); clipboardReadGate = null;
assert.equal(read(contextNode).slots[3].file, "uploads/pasted-image.png", "capture the clicked slot before clipboard permission/read awaits");
assert.equal(read(contextNode).slots[0].file, "");
assert.deepEqual(contextNode.outputs[3].links, [42]);

const beforeCopy = contextNode.widget.value;
tiles(contextNode)[3].dispatch("contextmenu");
menuItem("Copy image").click();
await new Promise(setImmediate);
assert.equal(await clipboardWrites.at(-1).text(), "original PNG pixels");
assert.match(viewRequests.at(-1), /filename=pasted-image.png.*subfolder=uploads/);
tiles(contextNode)[3].dispatch("contextmenu");
menuItem("Copy (Clipspace)").click();
assert.equal(__multiComfyApp.clipspace.imgs.length, 1);
assert.deepEqual(__multiComfyApp.clipspace.images, [{ filename: "pasted-image.png", subfolder: "uploads", type: "input" }]);
assert.equal(__multiComfyApp.clipspace.widgets[0].value, "uploads/pasted-image.png");
assert.equal(contextNode.widget.value, beforeCopy, "copy actions leave workflow state intact");

// Escape restores slot focus for native Ctrl+V even when that slot is empty.
tiles(contextNode)[2].dispatch("contextmenu");
menu().dispatch("keydown", { key: "Escape" });
assert.equal(document.activeElement, tiles(contextNode)[2]);
contextNode.root.dispatch("paste", { clipboardData: { files: [file("empty-slot.png")] } });
await settle(contextNode);
assert.equal(read(contextNode).slots[2].file, "uploads/empty-slot.png");
clipboardReadError = new Error("Permission denied");
tiles(contextNode)[1].dispatch("contextmenu");
menuItem("Paste image").click(); await new Promise(setImmediate);
assert.equal(document.activeElement, tiles(contextNode)[1]);
assert.match(contextNode.root.querySelectorAll(".a5-multi-status")[0].textContent, /Permission denied.*Ctrl\+V/);
assert.equal(read(contextNode).slots[1].file, "");
clipboardReadError = null; clipboardItems = [];
tiles(contextNode)[1].dispatch("contextmenu");
menuItem("Paste image").click(); await new Promise(setImmediate);
assert.match(contextNode.root.querySelectorAll(".a5-multi-status")[0].textContent, /No image found/);

tiles(contextNode)[3].dispatch("contextmenu");
tiles(navigation)[0].dispatch("contextmenu");
assert.equal(document.body.querySelectorAll(".a5-multi-image-menu").length, 1);
document.dispatch("pointerdown", { target: document.body });
assert.equal(menu(), undefined);
const savedCopy = __multiComfyApp.copyToClipspace;
delete __multiComfyApp.copyToClipspace;
tiles(contextNode)[3].dispatch("contextmenu");
assert.equal(menuItem("Copy (Clipspace)"), undefined, "omit Clipspace on frontends without its API");
__multiComfyApp.copyToClipspace = savedCopy;
contextNode.onRemoved();
assert.equal(menu(), undefined, "node removal cleans up menu and global event listeners");
assert.equal(document.listeners.get("pointerdown").length, 0);

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
