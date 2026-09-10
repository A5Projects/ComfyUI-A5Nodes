import assert from "node:assert/strict";
import fs from "node:fs/promises";


const listeners = new Map();
let extension;

const app = {
  graph: {
    _nodes: [],
    getNodeById(nodeId) {
      return this._nodes.find((node) => Number(node.id) === Number(nodeId));
    },
    setDirtyCanvas() {},
  },
  api: {
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
  },
  registerExtension(value) {
    extension = value;
  },
};

globalThis.__a5HistoryTestApp = app;
globalThis.LiteGraph = { vueNodesMode: false };
const appendedStyles = [];
globalThis.document = {
  head: {
    appendChild(element) {
      appendedStyles.push(element);
    },
  },
  createElement() {
    return { id: "", style: {}, textContent: "" };
  },
  getElementById(id) {
    return appendedStyles.find((element) => element.id === id) ?? null;
  },
  querySelectorAll() {
    return [];
  },
};

const sourcePath = new URL("../web/lmstudio_prompt_enhancer.js", import.meta.url);
let source = await fs.readFile(sourcePath, "utf8");
source = source.replace(
  'import { app } from "../../scripts/app.js";',
  "const app = globalThis.__a5HistoryTestApp;",
);
source += `
export {
  addPromptEditorButton,
  bindLastPromptWidgetBlur,
  captureCurrentNodePrompt,
  getPromptHistory,
  markManualPrompt,
  recordGeneratedPrompt,
  restoreNamedWidgetValues,
  setupCombinedModelManagementRow,
  setupPromptTextDividers,
  setupServerEjectRow,
};
`;

const historyModule = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const namedRestoreNode = {
  widgets: [
    { name: "input_prompt", value: "shifted" },
    { name: "prompt_height_divider_1", value: "", serialize: false },
    { name: "run_mode", value: "shifted mode" },
  ],
};
historyModule.restoreNamedWidgetValues(namedRestoreNode, {
  widgets_values_named: {
    input_prompt: "restored prompt",
    run_mode: "Auto bypass if unchanged",
  },
});
assert.equal(namedRestoreNode.widgets[0].value, "restored prompt");
assert.equal(namedRestoreNode.widgets[1].value, "", "layout dividers ignore named restore");
assert.equal(namedRestoreNode.widgets[2].value, "Auto bypass if unchanged");

function makeNode(id, initialPrompt) {
  return {
    id,
    comfyClass: "A5lmstudio_prompt_enhancer",
    widgets: [
      {
        name: "last_generated_prompt",
        value: initialPrompt,
      },
    ],
  };
}

function promptWidget(node) {
  return node.widgets[0];
}

class FakeTextElement {
  constructor(value) {
    this.value = value;
    this.listeners = new Map();
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
      callback({ type: name, target: this });
    }
  }
}

assert.ok(extension, "LM Studio frontend extension registered");
extension.setup();

const node = makeNode(1, "generated one");
app.graph._nodes.push(node);
const history = historyModule.getPromptHistory(node);
assert.deepEqual(history.entries, ["generated one"]);

promptWidget(node).value = "manual edit";
historyModule.markManualPrompt(node, "manual edit");
assert.equal(history.entries.length, 1, "typing does not create per-keystroke entries");
historyModule.captureCurrentNodePrompt(node);
assert.deepEqual(
  history.entries,
  ["generated one", "manual edit"],
  "committing a manual edit appends a new prompt",
);
historyModule.captureCurrentNodePrompt(node);
assert.equal(history.entries.length, 2, "duplicate commits are suppressed");

historyModule.recordGeneratedPrompt(node, "generated two");
assert.deepEqual(history.entries, ["generated one", "manual edit", "generated two"]);

history.index = 0;
promptWidget(node).value = "manual branch";
historyModule.markManualPrompt(node, "manual branch");
historyModule.captureCurrentNodePrompt(node);
assert.deepEqual(
  history.entries,
  ["generated one", "manual branch"],
  "manual edits after navigating backward truncate forward history",
);

for (let index = 0; index < 25; index += 1) {
  historyModule.recordGeneratedPrompt(node, `generated rollover ${index}`);
}
assert.equal(history.entries.length, 20, "history remains capped at 20 prompts");
assert.equal(history.entries.at(-1), "generated rollover 24");

const blurNode = makeNode(2, "before blur");
const blurElement = new FakeTextElement("before blur");
promptWidget(blurNode).inputEl = blurElement;
historyModule.bindLastPromptWidgetBlur(blurNode, promptWidget(blurNode));
blurElement.value = "after blur";
blurElement.dispatch("input");
assert.equal(historyModule.getPromptHistory(blurNode).entries.length, 1);
blurElement.dispatch("blur");
assert.deepEqual(
  historyModule.getPromptHistory(blurNode).entries,
  ["before blur", "after blur"],
  "leaving the in-node editor commits the edit",
);

const executingNode = makeNode(3, "before run");
app.graph._nodes.push(executingNode);
historyModule.getPromptHistory(executingNode);
promptWidget(executingNode).value = "used by run";
listeners.get("executing")({ detail: { node: 3 } });
assert.deepEqual(
  historyModule.getPromptHistory(executingNode).entries,
  ["before run", "used by run"],
  "execution commits a pending manual prompt",
);

promptWidget(executingNode).value = "direct event shape";
listeners.get("executing")({ detail: 3 });
assert.equal(
  historyModule.getPromptHistory(executingNode).entries.at(-1),
  "direct event shape",
  "execution supports both current Comfy event detail shapes",
);

function makeCanvasContext() {
  const fills = [];
  return {
    fills,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    fill() {
      fills.push(this.fillStyle);
    },
    stroke() {},
    rect() {},
    clip() {},
    fillText() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
  };
}

const toggleCallbacks = [];
const layoutNode = {
  id: 4,
  comfyClass: "A5lmstudio_prompt_enhancer",
  pos: [120, 80],
  size: [500, 800],
  widgets: [
    { name: "last_generated_prompt", value: "editable prompt" },
    {
      name: "load_model_before_generation",
      value: true,
      callback(value) {
        toggleCallbacks.push(["load", value]);
      },
    },
    {
      name: "unload_model_after_generation",
      value: true,
      callback(value) {
        toggleCallbacks.push(["unload", value]);
      },
    },
    {
      name: "server_url",
      value: "http://localhost:1234/v1",
      callback(value) {
        this.lastCallbackValue = value;
      },
    },
  ],
  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  },
  computeSize() {
    return [500, 810];
  },
  setSize(size) {
    this.size = size;
  },
};

historyModule.setupCombinedModelManagementRow(layoutNode);
historyModule.setupServerEjectRow(layoutNode);
historyModule.addPromptEditorButton(layoutNode);

const loadWidget = layoutNode.widgets.find(
  (widget) => widget.name === "load_model_before_generation",
);
const unloadWidget = layoutNode.widgets.find(
  (widget) => widget.name === "unload_model_after_generation",
);
const serverWidget = layoutNode.widgets.find((widget) => widget.name === "server_url");

assert.equal(loadWidget.type, "custom");
assert.equal(unloadWidget.type, "hidden");
assert.notEqual(unloadWidget.serialize, false, "hidden unload value remains serialized");

const toggleCanvas = makeCanvasContext();
loadWidget.width = 720;
loadWidget.draw(toggleCanvas, layoutNode, loadWidget.width, 100);
assert.equal(
  loadWidget.__a5UnloadRect.x + loadWidget.__a5UnloadRect.width,
  layoutNode.size[0] - 10,
  "classic Load/Unload row ignores a stale Nodes 2.0 widget width",
);
const loadPointer = {
  eDown: { canvasX: layoutNode.pos[0] + loadWidget.__a5LoadRect.x + 2 },
};
assert.equal(loadWidget.onPointerDown(loadPointer, layoutNode), true);
loadPointer.onClick({ canvasX: layoutNode.pos[0] + loadWidget.__a5LoadRect.x + 2 });
const unloadPointer = {
  eDown: { canvasX: layoutNode.pos[0] + loadWidget.__a5UnloadRect.x + 2 },
};
assert.equal(loadWidget.onPointerDown(unloadPointer, layoutNode), true);
unloadPointer.onClick({ canvasX: layoutNode.pos[0] + loadWidget.__a5UnloadRect.x + 2 });
assert.equal(loadWidget.value, false, "Load LLM half toggles the load value");
assert.equal(unloadWidget.value, false, "Unload LLM half toggles the unload value");
assert.deepEqual(toggleCallbacks, [["load", false], ["unload", false]]);

let comfyPromptCalls = 0;
let browserPromptCalls = 0;
app.canvas = {
  prompt(title, value, callback) {
    comfyPromptCalls += 1;
    assert.equal(title, "LM Studio server URL");
    assert.equal(value, "http://localhost:1234/v1");
    callback("http://127.0.0.1:1234/v1");
  },
};
globalThis.window = {
  prompt() {
    browserPromptCalls += 1;
    return "http://127.0.0.1:1234/v1";
  },
};
let abortRequest = null;
globalThis.fetch = async (url, options) => {
  abortRequest = { url, options };
  return {
    ok: true,
    async json() {
      return { ok: true };
    },
  };
};

const serverCanvas = makeCanvasContext();
serverWidget.width = 720;
serverWidget.draw(serverCanvas, layoutNode, serverWidget.width, 150);
assert.ok(serverCanvas.fills.includes("#8f2d2d"), "eject control is rendered red");
assert.equal(
  serverWidget.__a5EjectRect.x + serverWidget.__a5EjectRect.width,
  layoutNode.size[0] - 10,
  "classic eject ignores a stale Nodes 2.0 widget width",
);
const serverPointer = {
  eDown: { canvasX: layoutNode.pos[0] + serverWidget.__a5ServerRect.x + 2 },
};
assert.equal(serverWidget.onPointerDown(serverPointer, layoutNode), true);
serverPointer.onClick({ canvasX: layoutNode.pos[0] + serverWidget.__a5ServerRect.x + 2 });
assert.equal(serverWidget.value, "http://127.0.0.1:1234/v1");
assert.equal(serverWidget.lastCallbackValue, serverWidget.value);
assert.equal(comfyPromptCalls, 1, "server URL uses Comfy's in-canvas value prompt");
assert.equal(browserPromptCalls, 0, "browser prompt remains only as a compatibility fallback");

const ejectPointer = {
  eDown: { canvasX: layoutNode.pos[0] + serverWidget.__a5EjectRect.x + 2 },
};
assert.equal(serverWidget.onPointerDown(ejectPointer, layoutNode), true);
ejectPointer.onClick({ canvasX: layoutNode.pos[0] + serverWidget.__a5EjectRect.x + 2 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(abortRequest.url, "/a5lmstudio_prompt_enhancer/abort");
assert.deepEqual(JSON.parse(abortRequest.options.body), { server_url: serverWidget.value });
assert.equal(comfyPromptCalls, 1, "classic eject does not open the server editor");
assert.equal(layoutNode.widgets.at(-1).name, "Edit last prompt...");
assert.equal(
  layoutNode.widgets.some((widget) => widget.name === "Eject LLM (stop run)"),
  false,
  "eject is not a separate bottom button",
);
clearTimeout(layoutNode.__a5AbortResetTimer);

abortRequest = null;
globalThis.LiteGraph.vueNodesMode = true;
const vueToggleCallbacks = [];
const vueLayoutNode = {
  id: 6,
  comfyClass: "A5lmstudio_prompt_enhancer",
  pos: [300, 120],
  size: [500, 800],
  widgets: [
    {
      type: "toggle",
      name: "load_model_before_generation",
      value: false,
      callback(value) {
        vueToggleCallbacks.push(["load", value]);
      },
    },
    {
      type: "toggle",
      name: "unload_model_after_generation",
      value: false,
      callback(value) {
        vueToggleCallbacks.push(["unload", value]);
      },
    },
    {
      type: "string",
      name: "server_url",
      value: "http://localhost:1234/v1",
    },
    { type: "string", name: "api_token", value: "" },
  ],
  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  },
};

historyModule.setupCombinedModelManagementRow(vueLayoutNode);
historyModule.setupServerEjectRow(vueLayoutNode);

const vueLoadWidget = vueLayoutNode.widgets.find(
  (widget) => widget.name === "load_model_before_generation",
);
const vueUnloadWidget = vueLayoutNode.widgets.find(
  (widget) => widget.name === "unload_model_after_generation",
);
const vueServerWidget = vueLayoutNode.widgets.find((widget) => widget.name === "server_url");

assert.equal(vueLoadWidget.type, "toggle", "Nodes 2.0 keeps the native Load LLM control");
assert.equal(vueUnloadWidget.type, "toggle", "Nodes 2.0 keeps the native Unload LLM control");
assert.equal(
  vueServerWidget.type,
  "custom",
  "Nodes 2.0 keeps server and eject on the existing serializable server row",
);
assert.equal(
  vueLayoutNode.widgets.some((widget) => widget.name === "Eject LLM (stop run)"),
  false,
  "Nodes 2.0 does not depend on a dynamically added custom row",
);

vueLoadWidget.value = true;
vueLoadWidget.callback(vueLoadWidget.value);
vueUnloadWidget.value = true;
vueUnloadWidget.callback(vueUnloadWidget.value);
assert.equal(vueLoadWidget.value, true, "Nodes 2.0 Load LLM remains independently enabled");
assert.equal(vueUnloadWidget.value, true, "Nodes 2.0 Unload LLM remains independently enabled");
assert.deepEqual(vueToggleCallbacks, [["load", true], ["unload", true]]);

const vueEjectCanvas = makeCanvasContext();
vueServerWidget.draw(vueEjectCanvas, vueLayoutNode, 500, 150);
assert.ok(vueEjectCanvas.fills.includes("#8f2d2d"), "Nodes 2.0 eject is rendered red");
const vueEjectPointer = {
  eDown: {
    offsetX: vueServerWidget.__a5EjectRect.x + 2,
    canvasX: vueLayoutNode.pos[0] + vueServerWidget.__a5ServerRect.x + 2,
  },
};
assert.equal(vueServerWidget.onPointerDown(vueEjectPointer, vueLayoutNode), true);
vueEjectPointer.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(abortRequest.url, "/a5lmstudio_prompt_enhancer/abort");
assert.equal(comfyPromptCalls, 1, "Nodes 2.0 eject does not open the server URL field");
clearTimeout(vueLayoutNode.__a5AbortResetTimer);
globalThis.LiteGraph.vueNodesMode = false;

unloadWidget.value = false;
loadWidget.mouse(
  { type: "mousedown", canvasX: layoutNode.pos[0] + loadWidget.__a5UnloadRect.x + 2 },
  [0, -999],
  layoutNode,
);
assert.equal(unloadWidget.value, true, "legacy mouse fallback uses event canvas coordinates");

function makeTextWidget(name, computedHeight) {
  return {
    name,
    value: `${name} value`,
    computedHeight,
    options: {},
    triggerDraw() {},
    computeLayoutSize() {
      return { minHeight: 50, minWidth: 0 };
    },
  };
}

const textWidgets = [
  makeTextWidget("system_prompt", 180),
  makeTextWidget("input_prompt", 220),
  makeTextWidget("last_generated_prompt", 260),
];
const dividerNode = {
  id: 5,
  pos: [40, 60],
  size: [500, 800],
  widgets: [...textWidgets, { name: "run_mode", value: "Auto bypass if unchanged" }],
  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  },
  onResize(size) {
    this.size = size;
  },
};
const originalSerializableWidgetNames = dividerNode.widgets.map((widget) => widget.name);
historyModule.setupPromptTextDividers(dividerNode);

assert.ok(
  textWidgets.every((widget) => widget.options.rows === 1),
  "classic prompt widgets use a one-row intrinsic minimum",
);

const dividers = dividerNode.widgets.filter((widget) => {
  return widget.name.startsWith("prompt_height_divider_");
});
assert.equal(dividers.length, 2, "two prompt height dividers are inserted");
assert.deepEqual(
  dividerNode.widgets.slice(-2),
  dividers,
  "non-serialized dividers remain after every serialized widget",
);
const visualWidgets = dividerNode.getLayoutWidgets();
assert.equal(visualWidgets[1], dividers[0], "first divider visually follows system prompt");
assert.equal(visualWidgets[3], dividers[1], "second divider visually follows input prompt");
assert.deepEqual(
  dividerNode.widgets
    .filter((widget) => widget.serialize !== false)
    .map((widget) => widget.name),
  originalSerializableWidgetNames,
  "divider widgets do not change workflow widget serialization order",
);

const dividerCanvas = makeCanvasContext();
dividers[0].draw(dividerCanvas, dividerNode, 500, 100, 8);
const resizeCanvas = { canvas: { style: { cursor: "default" } } };
const firstDividerPointer = { eDown: { canvasY: 300 } };
assert.equal(
  dividers[0].onPointerDown(firstDividerPointer, dividerNode, resizeCanvas),
  true,
);
firstDividerPointer.onDragStart();
assert.equal(resizeCanvas.canvas.style.cursor, "ns-resize");
firstDividerPointer.onDrag({ canvasY: -1000 });
firstDividerPointer.finally();
assert.equal(resizeCanvas.canvas.style.cursor, "default");

function promptHeightPreferences() {
  return textWidgets.map((widget) => {
    const layout = widget.computeLayoutSize(dividerNode);
    assert.equal(
      layout.minHeight,
      40,
      `${widget.name} keeps a shrinkable minimum height`,
    );
    return layout.maxHeight;
  });
}

let allocatedHeights = promptHeightPreferences();
assert.deepEqual(
  allocatedHeights,
  [40, 360, 260],
  "system prompt collapses to one line and gives its space to input prompt",
);

const secondDividerPointer = { eDown: { canvasY: 500 } };
dividers[1].onPointerDown(secondDividerPointer, dividerNode, resizeCanvas);
secondDividerPointer.onDrag({ canvasY: 560 });
allocatedHeights = promptHeightPreferences();
assert.deepEqual(
  allocatedHeights,
  [40, 420, 200],
  "second divider independently trades input prompt space with generated prompt",
);
assert.equal(
  allocatedHeights.reduce((sum, height) => sum + height, 0),
  660,
  "dragging dividers preserves total text area height",
);

dividerNode.onResize([500, 920]);
allocatedHeights = promptHeightPreferences();
assert.equal(Math.round(allocatedHeights.reduce((sum, height) => sum + height, 0)), 780);
assert.equal(allocatedHeights[0], 40, "collapsed system prompt stays collapsed on node resize");
assert.ok(allocatedHeights[1] > allocatedHeights[2], "remaining proportions survive node resize");

dividerNode.onResize([500, 620]);
allocatedHeights = promptHeightPreferences();
assert.equal(
  Math.round(allocatedHeights.reduce((sum, height) => sum + height, 0)),
  480,
  "shrinking the node reduces the preferred prompt area instead of raising its minimum height",
);
assert.equal(allocatedHeights[0], 40, "collapsed system prompt remains at its true minimum");
assert.ok(
  allocatedHeights.every((height) => height >= 40),
  "all prompt preferences remain above the shrinkable minimum",
);

globalThis.LiteGraph.vueNodesMode = true;
dividerNode.onResize([500, 1000]);
for (const widget of textWidgets) {
  const layout = widget.computeLayoutSize(dividerNode);
  assert.equal(layout.minHeight, 50, "Nodes 2.0 keeps Comfy's native textarea minimum");
  assert.equal(
    Object.hasOwn(layout, "maxHeight"),
    false,
    "Nodes 2.0 ignores classic divider height constraints",
  );
}
assert.deepEqual(dividerNode.size, [500, 1000], "Nodes 2.0 resize passes through unchanged");
globalThis.LiteGraph.vueNodesMode = false;

console.log("LM Studio prompt history tests passed");
