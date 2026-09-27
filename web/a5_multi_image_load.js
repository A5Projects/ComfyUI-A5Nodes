import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { defaultState, parseState, placeFiles, collectionFiles, referenceSize, imageLocation, annotatedFile } from "./multi_image_state.js";

const NODE_CLASS = "A5MultiImageLoad";
const WIDGET_TYPE = "A5_MULTI_IMAGE_STATE";
const editors = new WeakMap();
const MIN_WIDGET_HEIGHT = 230;

function ensureStyle() {
    if (document.getElementById("a5-multi-image-style")) return;
    const link = document.createElement("link");
    link.id = "a5-multi-image-style";
    link.rel = "stylesheet";
    link.href = new URL("./a5_multi_image_load.css", import.meta.url).href;
    document.head.append(link);
}

function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
}

function button(className, text, label, action) {
    const item = element("button", className, text);
    item.type = "button";
    item.title = label;
    item.setAttribute("aria-label", label);
    item.addEventListener("click", action);
    return item;
}

function isImage(file) {
    return file?.type?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif|jxl)$/i.test(file?.name ?? "");
}

function viewURL(file, revision) {
    const query = new URLSearchParams({ ...imageLocation(file), a5: String(revision) });
    return api.apiURL(`/view?${query}`);
}

function createEditor(node, inputName, inputData) {
    ensureStyle();
    if (editors.has(node)) return { widget: editors.get(node).widget };
    let state = parseState(inputData[1]?.default || defaultState());
    let serialized = JSON.stringify(state);
    let invalidState = false;
    let selectedTarget = 0;
    let revision = Date.now();
    let uploadChain = Promise.resolve();
    let pendingUploads = 0;
    let removed = false;
    let dialog = null;
    let collectionDialog = null;
    const root = element("div", "a5-multi");
    root.setAttribute("aria-label", "A5 Multi Image Load controls");
    const grid = element("div", "a5-multi-grid");
    const settings = element("div", "a5-multi-settings");
    const extras = element("div", "a5-multi-extras");
    const status = element("div", "a5-multi-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const tiles = [];

    function message(text = "", error = false) {
        status.textContent = text;
        status.classList.toggle("is-error", error);
    }

    function closeDialog() {
        dialog?.close();
        dialog?.remove();
        dialog = null;
        collectionDialog = null;
    }

    function openDialog(title) {
        closeDialog();
        dialog = element("dialog", "a5-multi-dialog");
        const header = element("header");
        header.append(element("h3", "", title), button("", "×", "Close", closeDialog));
        const body = element("div", "a5-multi-dialog-body");
        dialog.append(header, body);
        dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(); });
        const openedDialog = dialog;
        dialog.addEventListener("close", () => {
            openedDialog.remove();
            if (dialog === openedDialog) { dialog = null; collectionDialog = null; }
        });
        document.body.append(dialog);
        dialog.showModal();
        return body;
    }

    function selectTarget(target) {
        selectedTarget = target;
        tiles.forEach((tile, index) => tile.root.classList.toggle("is-selected", target === index));
        extras.classList.toggle("is-selected", target === "extras");
    }

    function commit(next) {
        if (invalidState || removed) return;
        const previous = serialized;
        node.graph?.beforeChange?.();
        state = parseState(next);
        serialized = JSON.stringify(state);
        render();
        node.onWidgetChanged?.(inputName, serialized, previous, widget);
        node.graph?.afterChange?.();
        node.setDirtyCanvas?.(true, true);
    }

    function mutate(change) {
        const next = parseState(state);
        change(next);
        commit(next);
    }

    function refreshTooltip(index) {
        const slot = state.slots[index], tile = tiles[index];
        let text = slot.file || `Image ${index + 1}: drop or upload an image`;
        if (tile.image.naturalWidth) {
            const w = tile.image.naturalWidth, h = tile.image.naturalHeight;
            const [ow, oh] = referenceSize(w, h, state);
            text += `\nOriginal: ${w} × ${h}\nReference: ${slot.enabled ? `${ow} × ${oh}` : "bypassed"}`;
        }
        tile.preview.title = text;
        tile.filename.title = text;
    }

    function render() {
        state.slots.forEach((slot, index) => {
            const tile = tiles[index];
            tile.enable.checked = slot.enabled;
            tile.root.classList.toggle("is-bypassed", !slot.enabled);
            tile.enable.title = slot.enabled ? `Bypass image ${index + 1}` : `Enable image ${index + 1}`;
            tile.filename.textContent = slot.file ? `${slot.file} ▾` : "Choose image ▾";
            if (tile.file !== slot.file || tile.revision !== revision) {
                tile.file = slot.file;
                tile.revision = revision;
                tile.placeholder.hidden = !!slot.file;
                tile.placeholder.textContent = "Drop image";
                tile.image.hidden = !slot.file;
                if (slot.file) tile.image.src = viewURL(slot.file, revision);
                else tile.image.removeAttribute("src");
            }
            refreshTooltip(index);
            const output = node.outputs?.[index];
            if (output) output.label = `${index + 1}${slot.file && !slot.enabled ? " · bypass" : ""}`;
        });
        resize.checked = state.resize;
        mp.value = String(state.megapixels);
        mpLabel.hidden = !state.resize;
        resizeLabel.title = state.downscale_only ? "Resize references · downscale only" : "Resize references · originals in list stay unchanged";
        const active = state.slots.filter(s => s.enabled && s.file).length;
        count.textContent = `${state.extras.length} extras`;
        count.title = `${active} active references + ${state.extras.length} extras = ${collectionFiles(state).length} original images. Drop or paste here; click to manage extras.`;
        clear.disabled = !state.extras.length || pendingUploads > 0;
        if (collectionDialog?.isConnected) renderCollection(collectionDialog);
        root.setAttribute("aria-busy", String(pendingUploads > 0));
    }

    async function upload(files, target) {
        const images = Array.from(files).filter(isImage);
        if (!images.length) { message("No supported image files found.", true); return; }
        pendingUploads++;
        render();
        // Serialize uploads per node; destination is captured before awaiting.
        uploadChain = uploadChain.then(async () => {
            const loaded = [], errors = [];
            for (const [index, file] of images.entries()) {
                if (removed) break;
                message(`Uploading ${index + 1} / ${images.length}…`);
                try {
                    const body = new FormData();
                    body.append("image", file, file.name || "pasted-image.png");
                    body.append("type", "input");
                    const response = await api.fetchApi("/upload/image", { method: "POST", body });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const result = await response.json();
                    if (!result.name) throw new Error("Upload returned no filename");
                    loaded.push(annotatedFile({ ...result, filename: result.name }));
                } catch (error) { errors.push(`${file.name}: ${error.message}`); }
            }
            if (!removed && loaded.length) {
                revision = Date.now();
                // Keep a multi-file drop non-destructive even if only one upload succeeds.
                commit(placeFiles(state, loaded, target, images.length > 1));
            }
            if (!removed) message(errors.length ? errors.join("; ") : "", errors.length > 0);
        }).catch(error => { if (!removed) message(error.message, true); }).finally(() => {
            pendingUploads--;
            if (!removed) render();
        });
        return uploadChain;
    }

    function pickFiles(target) {
        selectTarget(target);
        fileInput.value = "";
        fileInput.onchange = () => { void upload(fileInput.files, target); };
        fileInput.click();
    }

    async function chooseExisting(index) {
        selectTarget(index);
        const body = openDialog(`Image ${index + 1} · input files`);
        const search = element("input");
        search.type = "search";
        search.placeholder = "Filter filenames";
        search.setAttribute("aria-label", "Filter image filenames");
        const list = element("select");
        list.size = 12;
        list.setAttribute("aria-label", `Existing images for slot ${index + 1}`);
        const note = element("div", "", "Loading files…");
        let filenames = [];
        function filter() {
            const selected = list.value || state.slots[index].file;
            list.replaceChildren();
            const empty = element("option", "", "— Empty slot —");
            empty.value = "";
            list.append(empty);
            for (const filename of filenames.filter(name => name.toLowerCase().includes(search.value.toLowerCase()))) {
                const option = element("option", "", filename);
                option.value = filename;
                list.append(option);
            }
            list.value = selected;
        }
        function useSelection() {
            if (list.selectedIndex < 0) return;
            mutate(next => { next.slots[index].file = list.value; });
            closeDialog();
        }
        search.addEventListener("input", filter);
        list.addEventListener("dblclick", useSelection);
        list.addEventListener("keydown", event => { if (event.key === "Enter") useSelection(); });
        body.append(search, list, note, button("", "Use selected image", "Use selected image", useSelection));
        search.focus();
        try {
            // Exactly the normal Load Image node's input list, refreshed on open.
            const response = await api.fetchApi("/object_info/LoadImage");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const defs = await response.json();
            const spec = defs.LoadImage?.input?.required?.image;
            const choices = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options ?? [];
            filenames = [...new Set([...choices.filter(name => typeof name === "string"),
                ...state.slots.map(s => s.file).filter(Boolean), ...state.extras])].sort((a, b) => a.localeCompare(b));
            if (!body.isConnected) return;
            note.textContent = `${filenames.length} files`;
            filter();
        } catch (error) { if (body.isConnected) note.textContent = `Could not load image choices: ${error.message}`; }
    }

    function showPreview(index) {
        selectTarget(index);
        const slot = state.slots[index];
        if (!slot.file) { pickFiles(index); return; }
        const body = openDialog(`Image ${index + 1} · ${slot.file}`);
        const image = element("img", "a5-multi-large-image");
        image.src = viewURL(slot.file, revision);
        image.alt = slot.file;
        body.append(image, element("div", "", tiles[index].preview.title));
    }

    function renderCollection(body) {
        body.replaceChildren();
        const active = state.slots.filter(s => s.enabled && s.file).length;
        body.append(element("div", "", `${active} original preview images + ${state.extras.length} extras. Preview images come first.`));
        state.extras.forEach((file, index) => {
            const row = element("div", "a5-multi-extra-row");
            row.append(element("span", "", `${index + 1}. ${file}`));
            const move = direction => mutate(next => {
                const item = next.extras.splice(index, 1)[0];
                next.extras.splice(index + direction, 0, item);
            });
            const up = button("", "↑", `Move extra ${index + 1} up`, () => move(-1));
            const down = button("", "↓", `Move extra ${index + 1} down`, () => move(1));
            up.disabled = index === 0;
            down.disabled = index === state.extras.length - 1;
            row.append(up, down, button("", "×", `Remove extra ${index + 1}`, () => mutate(next => next.extras.splice(index, 1))));
            body.append(row);
        });
        body.append(button("", "Add images…", "Add extra images", () => pickFiles("extras")));
    }

    function showCollection() {
        selectTarget("extras");
        collectionDialog = openDialog("Extra images · original-size list");
        renderCollection(collectionDialog);
    }

    function showOptions() {
        const body = openDialog("Reference resize options");
        const label = element("label");
        const check = element("input");
        check.type = "checkbox";
        check.checked = state.downscale_only;
        check.addEventListener("change", () => mutate(next => { next.downscale_only = check.checked; }));
        label.append(check, document.createTextNode("Downscale only"));
        body.append(label, element("div", "", "The image-list output always keeps original dimensions."));
    }

    function targetFromEvent(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".a5-multi-extras")) return "extras";
        const tile = target?.closest(".a5-multi-tile");
        return tile ? Number(tile.dataset.slot) : selectedTarget;
    }

    async function drop(event, target = targetFromEvent(event)) {
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        const files = Array.from(transfer.files ?? []).filter(isImage);
        if (files.length) { await upload(files, target); return true; }
        const uri = transfer.getData("text/uri-list").split(/\r?\n/).find(line => line && !line.startsWith("#"));
        if (!uri) return false;
        try {
            const url = new URL(uri, location.href);
            // Reuse existing Comfy previews without copying files or fetching external URLs.
            if (url.origin !== location.origin || !url.pathname.endsWith("/view")) return false;
            const filename = url.searchParams.get("filename");
            if (!filename) return false;
            commit(placeFiles(state, [annotatedFile({ filename,
                subfolder: url.searchParams.get("subfolder") ?? "", type: url.searchParams.get("type") ?? "input" })], target));
            return true;
        } catch (error) { message(error.message, true); return false; }
    }

    for (let index = 0; index < 6; index++) {
        const tile = element("div", "a5-multi-tile");
        tile.dataset.slot = String(index);
        const enableLabel = element("label", "a5-multi-enable");
        const enable = element("input");
        enable.type = "checkbox";
        enable.setAttribute("aria-label", `Enable image ${index + 1}`);
        enable.addEventListener("change", () => mutate(next => { next.slots[index].enabled = enable.checked; }));
        enableLabel.append(enable, document.createTextNode(String(index + 1)));
        const preview = button("a5-multi-preview", "", `Preview image ${index + 1}`, () => showPreview(index));
        const image = element("img");
        image.alt = `Reference ${index + 1}`;
        image.draggable = false;
        const placeholder = element("span", "a5-multi-placeholder", "Drop image");
        preview.append(image, placeholder);
        const fileRow = element("div", "a5-multi-file");
        const filename = button("a5-multi-filename", "Choose image ▾", `Choose existing image ${index + 1}`, () => { void chooseExisting(index); });
        fileRow.append(filename, button("a5-multi-upload", "↑", `Upload image ${index + 1}`, () => pickFiles(index)));
        tile.append(preview, enableLabel, fileRow);
        tile.addEventListener("pointerdown", () => selectTarget(index));
        tile.addEventListener("focusin", () => selectTarget(index));
        image.addEventListener("load", () => refreshTooltip(index));
        image.addEventListener("error", () => { image.hidden = true; placeholder.hidden = false; placeholder.textContent = "Unavailable"; });
        tiles.push({ root: tile, enable, preview, image, placeholder, filename, file: undefined });
        grid.append(tile);
    }

    const resizeLabel = element("label");
    const resize = element("input");
    resize.type = "checkbox";
    resize.setAttribute("aria-label", "Resize reference images");
    resize.addEventListener("change", () => mutate(next => { next.resize = resize.checked; }));
    resizeLabel.append(resize, document.createTextNode("Resize"));
    const mpLabel = element("label");
    const mp = element("input");
    mp.type = "number"; mp.min = "0.01"; mp.max = "100"; mp.step = "0.1";
    mp.setAttribute("aria-label", "Reference megapixels");
    mp.addEventListener("change", () => {
        const value = Number(mp.value);
        if (!Number.isFinite(value) || value < 0.01 || value > 100) { mp.value = String(state.megapixels); return; }
        mutate(next => { next.megapixels = value; });
    });
    mpLabel.append(mp, document.createTextNode("MP"));
    settings.append(resizeLabel, mpLabel, button("a5-multi-options", "⋯", "Reference resize options", showOptions));
    const count = button("a5-multi-count", "", "Manage extra images", showCollection);
    const clear = button("", "Clear extras", "Clear extras; keep all preview images", () => mutate(next => { next.extras = []; }));
    extras.append(count, button("a5-multi-upload", "+", "Upload extra images", () => pickFiles("extras")), clear);
    extras.addEventListener("pointerdown", () => selectTarget("extras"));
    extras.addEventListener("focusin", () => selectTarget("extras"));
    // Keep the input attached for browser file pickers and frontend test tooling.
    const fileInput = element("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;
    root.append(grid, settings, extras, status, fileInput);

    root.addEventListener("pointerdown", event => event.stopPropagation());
    root.addEventListener("keydown", event => event.stopPropagation());
    root.addEventListener("dragover", event => {
        if (![...(event.dataTransfer?.types ?? [])].some(type => ["Files", "text/uri-list"].includes(type))) return;
        event.preventDefault(); event.stopPropagation();
        const target = targetFromEvent(event);
        selectTarget(target);
        (target === "extras" ? extras : tiles[target].root).classList.add("is-dragging");
    });
    root.addEventListener("dragleave", () => root.querySelectorAll(".is-dragging").forEach(el => el.classList.remove("is-dragging")));
    root.addEventListener("drop", event => {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        root.querySelectorAll(".is-dragging").forEach(el => el.classList.remove("is-dragging"));
        void drop(event);
    });
    root.addEventListener("paste", event => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImage);
        if (!files.length) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        void upload(files, selectedTarget);
    }, true);

    const widget = node.addDOMWidget(inputName, WIDGET_TYPE, root, {
        hideOnZoom: false,
        getMinHeight: () => MIN_WIDGET_HEIGHT,
        getHeight: () => MIN_WIDGET_HEIGHT,
        getValue: () => serialized,
        setValue: value => {
            // Save a malformed value intact rather than silently destroying workflow data.
            serialized = typeof value === "string" ? value : JSON.stringify(value);
            try { state = parseState(value); invalidState = false; render(); message(); }
            catch (error) { invalidState = true; message(error.message, true); }
        },
    });
    widget.serializeValue = () => {
        if (pendingUploads) throw new Error("A5 Multi Image Load: wait for image uploads to finish before queuing.");
        return serialized;
    };
    widget.options.minNodeSize = [230, 390];
    const editor = { widget, root, getState: () => parseState(state), mutate,
        refresh() { revision = Date.now(); render(); },
        destroy() { removed = true; closeDialog(); },
        upload, drop, selectTarget,
    };
    editors.set(node, editor);
    const previousRemoved = node.onRemoved;
    node.onRemoved = function () { editor.destroy(); return previousRemoved?.apply(this, arguments); };
    // The same hooks are used by the core uploader, including paste on a selected node.
    node.pasteFiles = files => {
        if (!Array.from(files).some(isImage)) return false;
        void upload(files, selectedTarget);
        return true;
    };
    node.onDragOver = event => [...(event?.dataTransfer?.types ?? [])].some(type => ["Files", "text/uri-list"].includes(type));
    node.onDragDrop = event => drop(event);
    render(); selectTarget(0);
    return { widget, minWidth: 230, minHeight: 390 };
}

app.registerExtension({
    name: "A5.MultiImageLoad",
    getCustomWidgets() { return { [WIDGET_TYPE]: createEditor }; },
    beforeRegisterNodeDef(_nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        // Only the browser definition changes; the backend/API input remains STRING.
        nodeData.input.required.state[0] = WIDGET_TYPE;
    },
    loadedGraphNode(node) { editors.get(node)?.refresh(); },
    nodeCreated(node) {
        if (node.comfyClass !== NODE_CLASS) return;
        for (let index = 0; index < 6; index++) if (node.outputs?.[index]) node.outputs[index].label = String(index + 1);
    },
    getNodeMenuItems(node) {
        const editor = editors.get(node);
        if (!editor) return [];
        return [{ content: `${editor.getState().downscale_only ? "✓ " : ""}Downscale only (references)`,
            callback: () => editor.mutate(next => { next.downscale_only = !next.downscale_only; }) },
        { content: "Refresh image previews", callback: () => editor.refresh() }];
    },
});
