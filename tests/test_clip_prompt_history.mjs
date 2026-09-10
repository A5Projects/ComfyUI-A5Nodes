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
globalThis.__a5ClipHistoryTestApp = app;
globalThis.LiteGraph = { vueNodesMode: false };

const sourcePath = new URL("../web/clip_prompt_enhancer.js", import.meta.url);
let source = await fs.readFile(sourcePath, "utf8");
source = source.replace(
  'import { app } from "../../scripts/app.js";',
  "const app = globalThis.__a5ClipHistoryTestApp;",
);
source += `
export {
  bindLastPromptWidgetBlur,
  captureCurrentNodePrompt,
  getPromptHistory,
  markManualPrompt,
  recordGeneratedPrompt,
  restoreNamedWidgetValues,
  setupPromptTextDividers,
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
    comfyClass: "A5ClipPromptEnhancer",
    widgets: [{ name: "last_generated_prompt", value: initialPrompt }],
  };
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

assert.ok(extension, "CLIP frontend extension registered");
extension.setup();

const node = makeNode(1, "generated one");
app.graph._nodes.push(node);
const history = historyModule.getPromptHistory(node);
node.widgets[0].value = "manual edit";
historyModule.markManualPrompt(node, "manual edit");
assert.equal(history.entries.length, 1, "typing does not create per-keystroke entries");
historyModule.captureCurrentNodePrompt(node);
assert.deepEqual(history.entries, ["generated one", "manual edit"]);

historyModule.recordGeneratedPrompt(node, "generated two");
history.index = 0;
node.widgets[0].value = "manual branch";
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

const blurNode = makeNode(2, "before blur");
const blurElement = new FakeTextElement("before blur");
blurNode.widgets[0].inputEl = blurElement;
historyModule.bindLastPromptWidgetBlur(blurNode, blurNode.widgets[0]);
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
executingNode.widgets[0].value = "used by run";
listeners.get("executing")({ detail: { node: 3 } });
assert.deepEqual(
  historyModule.getPromptHistory(executingNode).entries,
  ["before run", "used by run"],
  "execution commits a pending manual prompt",
);

function makeCanvasContext() {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    save() {},
    restore() {},
    beginPath() {},
    stroke() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
  };
}

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
  "dividers do not alter serialized widget order",
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

console.log("A5 CLIP prompt history tests passed");
