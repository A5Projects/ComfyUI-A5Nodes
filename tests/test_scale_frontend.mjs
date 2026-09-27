import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../web/a5scale_to_total_pixels_safe.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "");
const defaults = {
    target_total_pixels: 786432, dimension_rule: "Multi16", aspect_ratio: "disabled",
    scale_policy: "both", upscale_method: "lanczos", width_override: 0, height_override: 0,
    keep_aspect: "on", aspect_handling: "padding", padding_side: "right / bottom",
    padding_color: "#808080",
};

function harness() {
    let extension;
    const events = new Map();
    const nodes = new Map();
    const graph = { links: {}, getNodeById: (id) => nodes.get(id) };
    const context = vm.createContext({
        app: { registerExtension(value) { extension = value; } },
        api: { addEventListener(name, callback) { events.set(name, callback); } },
        console,
    });
    vm.runInContext(source, context);
    class Node {
        constructor(id = 1) {
            this.id = id;
            this.mode = 0;
            this.graph = graph;
            this.size = [320, 400];
            this.inputs = [{ name: "image", type: "IMAGE", link: null }];
            this.outputs = ["image", "width", "height", "size_text", "latent"].map((name, i) => ({
                name, type: ["IMAGE", "INT", "INT", "STRING", "LATENT"][i], links: null,
            }));
            this.widgets = Object.entries(defaults).map(([name, value]) => ({ name, value, options: {} }));
            nodes.set(id, this);
            this.onNodeCreated();
        }
        addOutput(name, type) { this.outputs.push({ name, type, links: null }); }
        addCustomWidget(widget) { this.widgets.push(widget); }
        addWidget(type, name, value, callback, options) {
            const widget = { type, name, value, callback, options };
            this.widgets.push(widget);
            return widget;
        }
        computeSize() { return [320, 400]; }
        setSize(size) { this.size = size; }
        setDirtyCanvas() {}
        configure(config) {
            if (config.outputs) this.outputs = structuredClone(config.outputs);
            if (config.inputs) this.inputs = structuredClone(config.inputs);
            config.widgets_values?.forEach((value, index) => {
                if (this.widgets[index]) this.widgets[index].value = value;
            });
        }
    }
    extension.beforeRegisterNodeDef(Node, { name: "A5scale_to_total_pixels_safe" });
    extension.setup();
    const node = new Node();
    const widget = (name) => node.widgets.find((item) => item.name === name);
    const set = (name, value) => { widget(name).value = value; widget(name).callback?.(value); };
    const changed = () => events.get("graphChanged")();
    const connect = (sourceNode) => {
        nodes.set(sourceNode.id, sourceNode);
        sourceNode.graph = graph;
        graph.links[10] = { origin_id: sourceNode.id, origin_slot: 0 };
        node.inputs[0].link = 10;
        node.onConnectionsChange();
    };
    return { node, Node, nodes, graph, widget, set, changed, connect };
}

const message = (blank) => ({
    width: [1026], height: [578], size_text: ["1026x578"],
    blank_image: [blank], latent_width: [1032], latent_height: [584],
});

test("blank mode enables its color picker, including saved stretch", () => {
    const { set, widget } = harness();
    set("width_override", 1025);
    set("aspect_handling", "stretch img");
    assert.equal(widget("target_total_pixels").disabled, false);
    for (const name of ["dimension_rule", "keep_aspect", "scale_policy", "upscale_method", "aspect_handling", "padding_side"]) {
        assert.equal(widget(name).disabled, true, name);
    }
    assert.equal(widget("padding_color").disabled, false);
    assert.equal(widget("pick_padding_color").disabled, false);
    set("aspect_ratio", "16:9 (Widescreen)");
    assert.equal(widget("target_total_pixels").disabled, true);
    assert.equal(widget("aspect_ratio").disabled, false);
    set("height_override", 577);
    assert.equal(widget("aspect_ratio").disabled, true);
});

test("preset-only blank generation keeps automatic size settings", () => {
    const { set, widget } = harness();
    set("aspect_ratio", "1:1 (Square)");
    assert.equal(widget("target_total_pixels").disabled, false);
    assert.equal(widget("dimension_rule").disabled, false);
    assert.equal(widget("scale_policy").disabled, true);
});

test("live image restores original control states", () => {
    const { connect, set, widget } = harness();
    connect({ id: 2, mode: 0, inputs: [], outputs: [{ type: "IMAGE" }] });
    assert.equal(widget("upscale_method").disabled, false);
    assert.equal(widget("scale_policy").disabled, false);
    assert.equal(widget("keep_aspect").disabled, false);
    set("width_override", 1025);
    assert.equal(widget("target_total_pixels").disabled, true);
    assert.equal(widget("padding_color").disabled, true);
    set("keep_aspect", "off");
    assert.equal(widget("padding_color").disabled, false);
});

test("bypassed load image and bypass chains resolve without an image", () => {
    const { node, connect, set, widget, changed, graph, nodes } = harness();
    const loader = { id: 2, mode: 0, inputs: [], outputs: [{ type: "IMAGE" }] };
    connect(loader);
    set("width_override", 100);
    loader.mode = 4;
    changed();
    assert.equal(widget("target_total_pixels").disabled, false);
    assert.equal(widget("padding_color").disabled, false);
    const bypass = { id: 3, mode: 4, graph, inputs: [{ name: "image", type: "IMAGE", link: 20 }], outputs: [{ type: "IMAGE" }] };
    nodes.set(2, loader);
    graph.links[20] = { origin_id: 2, origin_slot: 0 };
    connect(bypass);
    assert.equal(widget("upscale_method").disabled, true);
    loader.mode = 0;
    changed();
    assert.equal(widget("upscale_method").disabled, false);
    assert.equal(widget("target_total_pixels").disabled, true);
    node.inputs[0].link = null;
    node.onConnectionsChange();
    assert.equal(widget("target_total_pixels").disabled, false);
});

test("execution and cached execution restore authoritative labels", () => {
    const { node, set, connect, widget } = harness();
    connect({ id: 2, mode: 0, inputs: [], outputs: [{ type: "IMAGE" }] });
    set("width_override", 1025);
    node.onExecuted(message(true));
    assert.equal(node.outputs[0].label, "image (blank: no input)");
    assert.equal(node.outputs[1].label, "1026 width");
    assert.equal(node.outputs[4].label, "1032x584 latent");
    assert.equal(widget("target_total_pixels").disabled, false);
    set("padding_color", "#00ff00");
    assert.equal(node.outputs[0].label, "image");
    assert.equal(node.outputs[4].label, "latent");
    node.onExecuted(message(true));
    assert.equal(node.outputs[0].label, "image (blank: no input)");
    node.onExecuted(message(false));
    assert.equal(node.outputs[0].label, "image");
    assert.equal(widget("target_total_pixels").disabled, true);
});

test("upstream changes clear stale labels but unrelated changes retain them", () => {
    const { node, connect, changed } = harness();
    const loader = { id: 2, mode: 0, inputs: [], widgets: [{ name: "image", value: "one.png" }] };
    connect(loader);
    node.onExecuted(message(false));
    changed();
    assert.equal(node.outputs[1].label, "1026 width");
    loader.widgets[0].value = "two.png";
    changed();
    assert.equal(node.outputs[1].label, "width");
});

test("old workflows append latent without moving existing output links", () => {
    const { node, widget } = harness();
    const originalOutputs = node.outputs.slice(0, 4).map((output, index) => ({ ...output, links: [50 + index] }));
    const config = {
        outputs: originalOutputs,
        inputs: [{ name: "image", type: "IMAGE", link: 99 }],
        widgets_values: [786432, "mul32", "16:9 (Widescreen)", "both", "lanczos",
            "a5_manual_override_divider", 1025, 0, "on", "a5_aspect_mismatch_divider",
            "stretch", "center", "#010203"],
    };
    node.configure(config);
    assert.equal(node.outputs.length, 5);
    originalOutputs.forEach((output, index) => assert.deepEqual(node.outputs[index].links, output.links));
    assert.equal(node.inputs[0].link, 99);
    assert.equal(widget("aspect_handling").value, "stretch img");
    assert.equal(widget("dimension_rule").value, "Multi32");
    assert.equal(widget("padding_color").value, "#010203");
    const saved = { ...config, outputs: structuredClone(node.outputs),
        widgets_values: node.widgets.filter((item) => item.serialize !== false).map((item) => item.value) };
    node.configure(saved);
    assert.equal(node.outputs.length, 5);
    assert.equal(widget("padding_color").value, "#010203");
    assert.equal(widget("aspect_handling").value, "stretch img");
});

test("legacy 7, 8 and 12 widget layouts still migrate", () => {
    const cases = [
        [786432, "mul16", "both", "lanczos", 1024, 768, "off"],
        [786432, "mul16", "round", "lanczos", 1024, 768, "off", "both"],
        [786432, "mul16", "both", "lanczos", "a5_manual_override_divider", 1024, 768,
            "off", "a5_aspect_mismatch_divider", "stretch", "center", "#123456"],
    ];
    for (const values of cases) {
        const { node, widget } = harness();
        node.configure({ widgets_values: values });
        assert.equal(widget("aspect_ratio").value, "disabled");
        assert.equal(widget("dimension_rule").value, "Multi16");
        assert.equal(widget("width_override").value, 1024);
        assert.equal(widget("height_override").value, 768);
        assert.equal(node.outputs.length, 5);
    }
});

test("removed nodes are no longer tracked", () => {
    const { node, connect, changed } = harness();
    const loader = { id: 2, mode: 0, inputs: [] };
    connect(loader);
    node.onExecuted(message(false));
    node.onRemoved();
    loader.mode = 4;
    changed();
    assert.equal(node.outputs[1].label, "1026 width");
});
