// Pure state operations, shared by the widget and its regression tests.
export const SLOT_COUNT = 6;

export function defaultState() {
    return { version: 1, slots: Array.from({ length: SLOT_COUNT }, () => ({ file: "", enabled: true })),
        extras: [], resize: false, megapixels: 1, downscale_only: false };
}

export function parseState(value) {
    const state = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
    if (!state || state.version !== 1 || !Array.isArray(state.slots) || state.slots.length !== SLOT_COUNT
        || state.slots.some(s => !s || typeof s.file !== "string" || typeof s.enabled !== "boolean")
        || !Array.isArray(state.extras) || state.extras.some(f => typeof f !== "string" || !f)
        || typeof state.resize !== "boolean" || typeof state.downscale_only !== "boolean"
        || !Number.isFinite(state.megapixels) || state.megapixels < 0.01 || state.megapixels > 100) {
        throw new Error("Invalid A5 Multi Image Load state. Reload the saved workflow.");
    }
    return state;
}

export function placeFiles(state, files, target = "extras", fillEmpty = files.length > 1) {
    const next = parseState(state);
    if (target === "extras") next.extras.push(...files);
    else if (Number.isInteger(target) && target >= 0 && target < SLOT_COUNT) {
        if (files.length === 1 && !fillEmpty) next.slots[target].file = files[0];
        else {
            const available = Array.from({ length: SLOT_COUNT }, (_, i) => (target + i) % SLOT_COUNT)
                .filter(i => !next.slots[i].file);
            files.forEach((file, i) => {
                if (i < available.length) next.slots[available[i]].file = file;
                else next.extras.push(file);
            });
        }
    } else throw new Error("Invalid image target");
    return next;
}

export function collectionFiles(state) {
    return [...state.slots.filter(s => s.enabled && s.file).map(s => s.file), ...state.extras];
}

export function referenceSize(width, height, state) {
    if (!state.resize || (state.downscale_only && width * height <= state.megapixels * 1_000_000)) {
        return [width, height];
    }
    const scale = Math.sqrt(state.megapixels * 1_000_000 / (width * height));
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function imageLocation(file) {
    const match = file.match(/ \[(input|output|temp)\]$/);
    const path = (match ? file.slice(0, match.index) : file).replaceAll("\\", "/");
    const slash = path.lastIndexOf("/");
    return { filename: path.slice(slash + 1), subfolder: slash < 0 ? "" : path.slice(0, slash),
        type: match?.[1] ?? "input" };
}

export function annotatedFile(item) {
    if (!item || typeof item.filename !== "string") return null;
    const prefix = typeof item.subfolder === "string" && item.subfolder ? `${item.subfolder}/` : "";
    const type = ["input", "output", "temp"].includes(item.type) ? item.type : "input";
    return `${prefix}${item.filename}${type === "input" ? "" : ` [${type}]`}`;
}
