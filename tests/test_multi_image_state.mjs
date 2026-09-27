import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/multi_image_state.js", import.meta.url), "utf8");
const { defaultState, parseState, placeFiles, collectionFiles, referenceSize, imageLocation, annotatedFile } =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const original = defaultState();
original.slots[1] = { file: "keep.png", enabled: false };
original.slots[4].file = "also-keep.png";
const placed = placeFiles(original, ["a.png", "b.png", "c.png", "d.png", "e.png"], 3);
assert.deepEqual(placed.slots.map(s => s.file), ["c.png", "keep.png", "d.png", "a.png", "also-keep.png", "b.png"]);
assert.deepEqual(placed.extras, ["e.png"]);
assert.equal(placed.slots[1].enabled, false);
assert.equal(original.slots[3].file, "", "operations do not mutate input or another node");
const partial = placeFiles(original, ["survived.png"], 1, true);
assert.equal(partial.slots[1].file, "keep.png", "partial multi-file failures never replace occupied slots");
assert.equal(partial.slots[2].file, "survived.png");
assert.deepEqual(placeFiles(placed, ["overflow.png"], 0, true).extras, ["e.png", "overflow.png"]);

const replaced = placeFiles(placed, ["replacement.png"], 1);
assert.equal(replaced.slots[1].file, "replacement.png");
assert.equal(replaced.slots[1].enabled, false, "replacement preserves bypass");
assert.deepEqual(collectionFiles(replaced), ["c.png", "d.png", "a.png", "also-keep.png", "b.png", "e.png"]);
const appended = placeFiles(replaced, ["e.png", "f.png"], "extras");
assert.deepEqual(appended.extras, ["e.png", "e.png", "f.png"], "duplicate entries survive");
const cleared = parseState(appended);
cleared.extras = [];
assert.deepEqual(cleared.slots, appended.slots);
assert.equal(collectionFiles(cleared).length, 5);

assert.deepEqual(parseState(JSON.stringify(appended)), appended, "workflow serialization round-trips");
const clone = parseState(appended);
clone.slots[0].enabled = false;
clone.extras.reverse();
assert.equal(appended.slots[0].enabled, true);
assert.deepEqual(appended.extras, ["e.png", "e.png", "f.png"]);
assert.deepEqual(referenceSize(120, 60, { resize: true, megapixels: .02, downscale_only: false }), [200, 100]);
assert.deepEqual(referenceSize(120, 60, { resize: true, megapixels: 1, downscale_only: true }), [120, 60]);
assert.deepEqual(referenceSize(120, 60, defaultState()), [120, 60]);
assert.deepEqual(imageLocation("sub/a b.png [output]"), { filename: "a b.png", subfolder: "sub", type: "output" });
assert.deepEqual(imageLocation("sub\\image.png"), { filename: "image.png", subfolder: "sub", type: "input" });
assert.equal(annotatedFile({ filename: "test.png", subfolder: "clipspace", type: "input" }), "clipspace/test.png");
assert.equal(annotatedFile({ filename: "test.png", type: "temp" }), "test.png [temp]");
for (const value of ["{}", "[]", "invalid", JSON.stringify({ ...defaultState(), megapixels: 0 }),
    JSON.stringify({ ...defaultState(), extras: [null] })]) assert.throws(() => parseState(value));
assert.throws(() => placeFiles(defaultState(), ["a.png"], 6));
assert.equal(defaultState().slots[0].file, "");
console.log("Multi-image state: placement, overflow, bypass, originals order, clearing, duplicates, persistence, dimensions and file references passed.");
