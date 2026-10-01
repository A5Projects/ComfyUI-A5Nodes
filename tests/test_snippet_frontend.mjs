import assert from "node:assert/strict";
import fs from "node:fs/promises";

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.listeners = new Map();
        this.style = { cssText: "" };
        this.value = "";
        this.open = false;
    }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    dispatch(name) { this.listeners.get(name)?.({ stopPropagation() {}, preventDefault() {} }); }
    click() { if (!this.disabled) this.dispatch("click"); }
    remove() { this.removed = true; }
}

globalThis.document = { createElement: tag => new Element(tag) };
let savedSlots = Array.from({ length: 8 }, () => ({ label: "", text: "" }));
savedSlots[0] = { label: "Image", text: " <image 1> " };
let posts = 0;
globalThis.testApi = {
    async fetchApi(url, options) {
        assert.equal(url, "/a5_text_prompt/snippets");
        if (options?.method === "POST") {
            const { index, label, text } = JSON.parse(options.body);
            savedSlots[index] = { label, text };
            posts++;
        }
        return { ok: true, json: async () => ({ slots: structuredClone(savedSlots) }) };
    },
};
const source = (await fs.readFile(new URL("../web/snippet_buttons.js", import.meta.url), "utf8"))
    .replace('import { api } from "../../scripts/api.js";', "const api = globalThis.testApi;");
const { createSnippetExtras } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const flush = () => new Promise(resolve => setImmediate(resolve));
const inserted = [];
const node = {
    size: [360, 280],
    addDOMWidget(name, type, element, options) {
        this.widget = { name, type, element, options };
        return this.widget;
    },
    computeSize() { return [320, 220 + this.widget.options.getHeight()]; },
    setSize(size) { this.size = size; },
    setDirtyCanvas() {},
    arrange() { this.arranged = true; },
};
const extras = createSnippetExtras(node, { insert: value => inserted.push(value) });
extras.attach();
const popup = new Element("section");
const unmount = extras.mount(popup);
await flush();
assert.equal(node.widget.serialize, false);
assert.equal(node.widget.options.getHeight(), 92);

function controls(parent) {
    const root = parent.children[0];
    const [grid, details] = root.children;
    const [selector, label, save, clear, text, status] = details.children[1].children;
    return { root, buttons: grid.children, details, selector, label, save, clear, text, status };
}
const main = controls(node.widget.element);
const editor = controls(popup);
assert.equal(main.buttons.length, 8);
assert.equal(main.details.open, false);
assert.equal(main.buttons[0].title, " <image 1> ");
assert.equal(main.buttons[7].disabled, true);
main.buttons[0].click();
assert.deepEqual(inserted, [" <image 1> "], "inserted text is exact, including spacing");

editor.selector.value = "7";
editor.selector.dispatch("change");
editor.label.value = "Ref";
editor.label.dispatch("input");
editor.text.value = "Reference image 8\n";
editor.text.dispatch("input");
editor.save.click();
await flush();
assert.equal(posts, 1);
assert.equal(editor.status.textContent, "Saved");
assert.equal(main.buttons[7].textContent, "Ref", "save updates the other editor immediately");
assert.equal(main.buttons[7].title, "Reference image 8\n");
main.buttons[7].click();
assert.equal(inserted.at(-1), "Reference image 8\n");

main.details.open = true;
main.details.dispatch("toggle");
const expandedSize = [...node.size];
assert.equal(node.widget.options.getHeight(), 238);
assert.equal(node.arranged, true);
main.details.open = false;
main.details.dispatch("toggle");
main.details.open = true;
main.details.dispatch("toggle");
assert.deepEqual(node.size, expandedSize, "reopening settings does not repeatedly grow the node");
await flush();

unmount();
assert.equal(editor.root.removed, true);
main.selector.value = "7";
main.selector.dispatch("change");
main.clear.click();
await flush();
assert.equal(main.buttons[7].disabled, true);
assert.equal(editor.buttons[7].disabled, false, "closed editor unsubscribes from shared updates");
extras.destroy();
assert.equal(main.root.removed, true);
console.log("Snippet controls, exact insertion, shared saves, clearing, sizing and cleanup passed.");
