import { app, ComfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { defaultState, parseState, placeFiles, collectionFiles, referenceSize, imageLocation, annotatedFile } from "./multi_image_state.js";

const NODE_CLASS = "A5MultiImageLoad";
const WIDGET_TYPE = "A5_MULTI_IMAGE_STATE";
const editors = new WeakMap();
const MIN_WIDGET_HEIGHT = 230;
let dismissImageMenu = null;

async function clipboardPNG(file, revision) {
    const response = await api.fetchApi(`/view?${new URLSearchParams({ ...imageLocation(file), a5: String(revision) })}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;
    // Clipboard image writes use PNG, including for JPEG/WebP sources. Decode at
    // original size, never from the shrunken tile or the resized reference output.
    const image = new Image();
    const url = URL.createObjectURL(blob);
    try {
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(
            png => png ? resolve(png) : reject(new Error("Could not encode image as PNG")), "image/png"));
    } finally { URL.revokeObjectURL(url); }
}

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
    let imageChoicesRequest = null;
    let pendingUploads = 0;
    let removed = false;
    let dialog = null;
    let collectionDialog = null;
    let closeImageMenu = null;
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

    async function imageChoices() {
        // Refresh on interaction; concurrent arrow clicks share the same request.
        if (!imageChoicesRequest) {
            imageChoicesRequest = (async () => {
                const response = await api.fetchApi("/object_info/LoadImage");
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const defs = await response.json();
                const spec = defs.LoadImage?.input?.required?.image;
                return Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options ?? [];
            })().finally(() => { imageChoicesRequest = null; });
        }
        const choices = await imageChoicesRequest;
        // Keep the normal loader's order, then include saved subfolder/output files.
        return [...new Set([...choices.filter(name => typeof name === "string" && name),
            ...state.slots.map(s => s.file).filter(Boolean), ...state.extras])];
    }

    async function stepImage(index, direction) {
        selectTarget(index);
        try {
            const filenames = await imageChoices();
            if (removed || invalidState) return;
            if (!filenames.length) { message("No images available. Upload an image first."); return; }
            const current = filenames.indexOf(state.slots[index].file);
            const next = current < 0 ? (direction > 0 ? 0 : filenames.length - 1)
                : Math.max(0, Math.min(filenames.length - 1, current + direction));
            mutate(value => { value.slots[index].file = filenames[next]; });
            message();
        } catch (error) { if (!removed) message(`Could not load image choices: ${error.message}`, true); }
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
            filenames = await imageChoices();
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

    function focusSlot(index) {
        selectTarget(index);
        tiles[index].root.focus({ preventScroll: true });
    }

    async function pasteClipboard(index) {
        focusSlot(index);
        try {
            if (!navigator.clipboard?.read) throw new Error("Clipboard reading is unavailable in this browser");
            const items = await navigator.clipboard.read();
            const files = [];
            for (const item of items) {
                const type = item.types.find(type => type.startsWith("image/"));
                if (!type) continue;
                const blob = await item.getType(type);
                const extension = type.split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
                files.push(new File([blob], `pasted-image.${extension || "png"}`, { type }));
            }
            if (removed) return;
            if (!files.length) { message("No image found on the clipboard.", true); return; }
            await upload(files, index);
        } catch (error) {
            if (!removed) message(`Could not read clipboard: ${error.message}. Image ${index + 1} is selected; press Ctrl+V (Cmd+V on Mac) to paste.`, true);
        }
    }

    async function copyClipboard(index) {
        const file = state.slots[index].file;
        if (!file) return;
        try {
            if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
                throw new Error("Clipboard image copying is unavailable in this browser");
            }
            // Start the write during the menu click, preserving browser user activation.
            await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardPNG(file, revision) })]);
            if (!removed) message(`Image ${index + 1} copied to clipboard.`);
        } catch (error) { if (!removed) message(`Could not copy image: ${error.message}`, true); }
    }

    function copyClipspace(index) {
        const file = state.slots[index].file;
        if (!file || typeof ComfyApp?.copyToClipspace !== "function") return;
        // Use the public Clipspace payload for a single image, without passing
        // this node's multi-image state widget or changing its preview/output data.
        const image = new Image();
        image.src = viewURL(file, revision);
        ComfyApp.clipspace = {
            widgets: [{ name: "image", type: "combo", value: file }],
            imgs: [image], original_imgs: [image], images: [imageLocation(file)],
            selectedIndex: 0, img_paste_mode: "selected", paintedIndex: 2, combinedIndex: 3,
        };
        ComfyApp.clipspace_return_node = null;
        ComfyApp.clipspace_invalidate_handler?.();
        message(`Image ${index + 1} copied to Clipspace.`);
    }

    function showImageMenu(event, index) {
        event.preventDefault(); event.stopPropagation();
        dismissImageMenu?.();
        focusSlot(index);
        const menu = element("div", "a5-multi-image-menu");
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", `Image ${index + 1} actions`);
        menu.append(element("div", "a5-multi-menu-title", `Image ${index + 1}`));
        const listeners = new AbortController();
        const close = (restoreFocus = false) => {
            listeners.abort(); menu.remove();
            if (dismissImageMenu === close) dismissImageMenu = null;
            closeImageMenu = null;
            if (restoreFocus && !removed) focusSlot(index);
        };
        closeImageMenu = dismissImageMenu = close;
        const add = (label, action, disabled = false) => {
            const item = button("", label, label, () => { close(true); action(index); });
            item.setAttribute("role", "menuitem");
            item.disabled = disabled;
            menu.append(item);
            return item;
        };
        const paste = add("Paste image", pasteClipboard);
        add("Copy image", copyClipboard, !state.slots[index].file);
        if (typeof ComfyApp?.copyToClipspace === "function") {
            add("Copy (Clipspace)", copyClipspace, !state.slots[index].file);
        }
        menu.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
        menu.addEventListener("pointerdown", e => e.stopPropagation());
        menu.addEventListener("keydown", e => {
            e.stopPropagation();
            const items = [...menu.querySelectorAll("button")].filter(item => !item.disabled);
            const current = items.indexOf(document.activeElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
                    : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
            } else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(true); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") close(true);
        });
        document.body.append(menu);
        const bounds = tiles[index].root.getBoundingClientRect();
        const x = event.clientX || bounds.left, y = event.clientY || bounds.top;
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
        document.addEventListener("pointerdown", e => { if (!menu.contains(e.target)) close(); }, { capture: true, signal: listeners.signal });
        window.addEventListener("resize", () => close(), { signal: listeners.signal });
        document.addEventListener("wheel", () => close(), { capture: true, passive: true, signal: listeners.signal });
        paste.focus();
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
        tile.tabIndex = 0;
        tile.setAttribute("aria-label", `Image ${index + 1} slot`);
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
        const selector = element("div", "a5-multi-selector");
        const filename = button("a5-multi-filename", "Choose image ▾", `Choose existing image ${index + 1}`, () => { void chooseExisting(index); });
        selector.append(
            button("a5-multi-step", "◀", `Previous image for slot ${index + 1}`, () => { void stepImage(index, -1); }),
            filename,
            button("a5-multi-step", "▶", `Next image for slot ${index + 1}`, () => { void stepImage(index, 1); }),
        );
        fileRow.append(selector, button("a5-multi-upload", "↑", `Upload image ${index + 1}`, () => pickFiles(index)));
        tile.append(preview, enableLabel, fileRow);
        tile.addEventListener("pointerdown", () => selectTarget(index));
        tile.addEventListener("focusin", () => selectTarget(index));
        tile.addEventListener("contextmenu", event => showImageMenu(event, index));
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
        destroy() { removed = true; closeImageMenu?.(); closeDialog(); },
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
