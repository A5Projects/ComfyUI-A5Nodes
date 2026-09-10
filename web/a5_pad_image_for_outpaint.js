import { app } from "../../scripts/app.js";

const NODE_ID = "A5Pad_Image_for_Outpaint";
const COLOR_PICK_BUTTON = "pick_padding_color";
const DISABLED_ASPECT_RATIO = "disabled";

function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

let pendingNativeColorSession = null;
let activeNativeColorSession = null;
let nativeColorBridgeInstalled = false;
let activeCanvasPickCleanup = null;
let activeCanvasPickNode = null;

function findWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function ensureNodeFitsWidgets(node) {
    const requiredSize = node.computeSize?.();
    if (!requiredSize || !node.size) {
        return;
    }
    node.setSize?.([
        Math.max(node.size[0], requiredSize[0]),
        Math.max(node.size[1], requiredSize[1]),
    ]);
}

function isNativeColorInput(target) {
    return target?.tagName === "INPUT" && target.type === "color";
}

function installNativeColorBridge() {
    if (nativeColorBridgeInstalled || typeof document === "undefined") {
        return;
    }

    document.addEventListener("click", (event) => {
        if (!isNativeColorInput(event.target)) {
            return;
        }
        activeNativeColorSession = pendingNativeColorSession
            ? { ...pendingNativeColorSession, input: event.target }
            : null;
        pendingNativeColorSession = null;
    }, true);

    document.addEventListener("input", (event) => {
        const session = activeNativeColorSession;
        if (!session || event.target !== session.input || !event.target.value) {
            return;
        }
        if (typeof session.widget.setValue === "function") {
            session.widget.setValue(event.target.value, session.context);
        } else {
            session.widget.value = event.target.value;
            session.widget.callback?.(event.target.value, session.node, session.widget);
        }
        session.context?.canvas?.setDirty?.(true);
        session.node.setDirtyCanvas?.(true, true);
    }, true);

    document.addEventListener("change", (event) => {
        if (activeNativeColorSession?.input === event.target) {
            activeNativeColorSession = null;
        }
    }, true);
    nativeColorBridgeInstalled = true;
}

function byteToHex(value) {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function pixelToHex(pixel) {
    return `#${byteToHex(pixel[0])}${byteToHex(pixel[1])}${byteToHex(pixel[2])}`;
}

function sampleCanvasPixel(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
        return null;
    }
    const x = Math.floor((clientX - rect.left) * canvas.width / rect.width);
    const y = Math.floor((clientY - rect.top) * canvas.height / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
        return null;
    }
    try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        return context ? pixelToHex(context.getImageData(x, y, 1, 1).data) : null;
    } catch {
        return null;
    }
}

function objectPositionOffset(token, freeSpace) {
    if (!token || token === "center") {
        return freeSpace / 2;
    }
    if (token === "left" || token === "top") {
        return 0;
    }
    if (token === "right" || token === "bottom") {
        return freeSpace;
    }
    if (token.endsWith("%")) {
        return freeSpace * Number.parseFloat(token) / 100;
    }
    if (token.endsWith("px")) {
        return Number.parseFloat(token);
    }
    return freeSpace / 2;
}

function sampleMediaPixel(element, clientX, clientY) {
    const sourceWidth = element.naturalWidth ?? element.videoWidth;
    const sourceHeight = element.naturalHeight ?? element.videoHeight;
    const rect = element.getBoundingClientRect();
    if (!sourceWidth || !sourceHeight || !rect.width || !rect.height) {
        return null;
    }

    const style = getComputedStyle(element);
    const fit = style.objectFit || "fill";
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    if (fit === "contain" || fit === "cover" || fit === "scale-down" || fit === "none") {
        let scale = fit === "cover"
            ? Math.max(rect.width / sourceWidth, rect.height / sourceHeight)
            : Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
        if (fit === "none") {
            scale = 1;
        } else if (fit === "scale-down") {
            scale = Math.min(1, scale);
        }
        contentWidth = sourceWidth * scale;
        contentHeight = sourceHeight * scale;
    }

    const position = (style.objectPosition || "50% 50%").trim().split(/\s+/);
    const offsetX = objectPositionOffset(position[0], rect.width - contentWidth);
    const offsetY = objectPositionOffset(position[1] ?? position[0], rect.height - contentHeight);
    const localX = clientX - rect.left - offsetX;
    const localY = clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX >= contentWidth || localY >= contentHeight) {
        return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            return null;
        }
        const sourceX = Math.min(sourceWidth - 1, Math.floor(localX * sourceWidth / contentWidth));
        const sourceY = Math.min(sourceHeight - 1, Math.floor(localY * sourceHeight / contentHeight));
        context.drawImage(element, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
        return pixelToHex(context.getImageData(0, 0, 1, 1).data);
    } catch {
        return null;
    }
}

function sampleVisiblePixel(clientX, clientY) {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        if (element instanceof HTMLCanvasElement) {
            const color = sampleCanvasPixel(element, clientX, clientY);
            if (color) {
                return color;
            }
        }
        if (element instanceof HTMLImageElement || element instanceof HTMLVideoElement) {
            const color = sampleMediaPixel(element, clientX, clientY);
            if (color) {
                return color;
            }
        }
    }
    return null;
}

function setPaddingColor(node, color) {
    const widget = findWidget(node, "padding_color");
    const canvas = app.canvas;
    if (!widget || !/^#[0-9a-f]{6}$/i.test(color)) {
        return;
    }
    if (typeof widget.setValue === "function" && canvas) {
        widget.setValue(color.toLowerCase(), { e: null, node, canvas });
    } else {
        widget.value = color.toLowerCase();
        widget.callback?.(widget.value, canvas, node);
    }
    widget.triggerDraw?.();
    canvas?.setDirty?.(true, true);
    node.setDirtyCanvas?.(true, true);
}

function startCanvasColorPick(node) {
    activeCanvasPickCleanup?.();
    activeCanvasPickNode = node;
    const status = document.createElement("div");
    status.textContent = "Pick an image or canvas pixel | Esc cancels";
    Object.assign(status.style, {
        position: "fixed",
        top: "72px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "100000",
        padding: "8px 12px",
        border: "1px solid #777",
        borderRadius: "6px",
        color: "#f2f2f2",
        background: "#252525",
        boxShadow: "0 3px 12px #0008",
        font: "13px sans-serif",
        pointerEvents: "none",
    });
    const cursorStyle = document.createElement("style");
    cursorStyle.textContent = "* { cursor: crosshair !important; }";
    document.body.append(status, cursorStyle);

    const cleanup = () => {
        window.removeEventListener("pointerdown", handlePointerDown, true);
        window.removeEventListener("keydown", handleKeyDown, true);
        status.remove();
        cursorStyle.remove();
        if (activeCanvasPickCleanup === cleanup) {
            activeCanvasPickCleanup = null;
            activeCanvasPickNode = null;
        }
    };
    const handlePointerDown = (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const color = sampleVisiblePixel(event.clientX, event.clientY);
        if (!color) {
            status.textContent = "That pixel cannot be read; try an image or the workflow canvas | Esc cancels";
            return;
        }
        setPaddingColor(node, color);
        cleanup();
    };
    const handleKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cleanup();
        }
    };
    activeCanvasPickCleanup = cleanup;
    requestAnimationFrame(() => {
        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("keydown", handleKeyDown, true);
    });
}

async function pickPaddingColor(node) {
    if (typeof window.EyeDropper === "function") {
        try {
            const result = await new window.EyeDropper().open();
            setPaddingColor(node, result.sRGBHex);
            return;
        } catch (error) {
            if (error?.name === "AbortError") {
                return;
            }
        }
    }
    startCanvasColorPick(node);
}

function addSectionDivider(node) {
    const name = "a5_aspect_ratio_canvas_divider";
    if (findWidget(node, name)) {
        return;
    }
    const widget = {
        name,
        type: "A5_SECTION_DIVIDER",
        value: name,
        inactive: true,
        serialize: false,
        options: { serialize: false },
        computeSize(width) {
            return [width, 24];
        },
        draw(ctx, _node, width, y, height) {
            const label = "ASPECT RATIO CANVAS";
            const centerY = y + height / 2;
            const margin = 14;
            ctx.save();
            ctx.font = "10px Arial";
            ctx.fillStyle = widget.inactive ? "#666" : "#8a8a8a";
            ctx.strokeStyle = widget.inactive ? "#3f3f3f" : "#555";
            ctx.lineWidth = 1;
            const labelWidth = ctx.measureText(label).width;
            const gap = 7;
            const lineEnd = Math.max(margin, (width - labelWidth) / 2 - gap);
            const lineStart = Math.min(width - margin, (width + labelWidth) / 2 + gap);
            ctx.beginPath();
            ctx.moveTo(margin, centerY);
            ctx.lineTo(lineEnd, centerY);
            ctx.moveTo(lineStart, centerY);
            ctx.lineTo(width - margin, centerY);
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, width / 2, centerY);
            ctx.restore();
        },
        mouse() {
            return false;
        },
    };
    node.addCustomWidget(widget);
    const appendedIndex = node.widgets.indexOf(widget);
    node.widgets.splice(appendedIndex, 1);
    const aspectIndex = node.widgets.findIndex((item) => item.name === "aspect_ratio");
    node.widgets.splice(aspectIndex >= 0 ? aspectIndex : node.widgets.length, 0, widget);
}

function setWidgetDisabled(widget, disabled) {
    if (!widget) {
        return;
    }
    widget.disabled = disabled;
    widget.options = widget.options || {};
    widget.options.disabled = disabled;
}

function updateAspectPlacementState(node) {
    const aspectRatio = findWidget(node, "aspect_ratio");
    const placement = findWidget(node, "image_placement");
    const active = aspectRatio?.value !== DISABLED_ASPECT_RATIO;
    setWidgetDisabled(placement, !active);
    const divider = findWidget(node, "a5_aspect_ratio_canvas_divider");
    if (divider) {
        divider.inactive = !active;
    }
    node.setDirtyCanvas?.(true, true);
}

function updateResolutionReadout(node, message) {
    const width = firstValue(message?.width);
    const height = firstValue(message?.height);
    if (width === undefined || height === undefined || !node.outputs) {
        return;
    }
    for (const output of node.outputs) {
        const name = output?.name ?? output?.label;
        if (name === "width") {
            output.label = `${width} width`;
        } else if (name === "height") {
            output.label = `${height} height`;
        }
    }
    node.setDirtyCanvas?.(true, true);
}

function chainAspectRatioCallback(node) {
    const widget = findWidget(node, "aspect_ratio");
    if (!widget || widget.__a5AspectPlacementCallback) {
        return;
    }
    const originalCallback = widget.callback;
    widget.callback = function (...args) {
        const result = originalCallback?.apply(this, args);
        updateAspectPlacementState(node);
        return result;
    };
    widget.__a5AspectPlacementCallback = true;
}

function enableEscapeColorCommit(node) {
    const widget = findWidget(node, "padding_color");
    if (!widget || widget.__a5EscapeColorCommit || typeof widget.onClick !== "function") {
        return;
    }
    installNativeColorBridge();
    const originalOnClick = widget.onClick;
    widget.onClick = function (context, ...args) {
        pendingNativeColorSession = { widget: this, node, context };
        return originalOnClick.apply(this, [context, ...args]);
    };
    widget.__a5EscapeColorCommit = true;

    if (!node.__a5NativeColorCleanup) {
        const originalOnRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            if (pendingNativeColorSession?.node === this) {
                pendingNativeColorSession = null;
            }
            if (activeNativeColorSession?.node === this) {
                activeNativeColorSession = null;
            }
            if (activeCanvasPickNode === this) {
                activeCanvasPickCleanup?.();
            }
            return originalOnRemoved?.apply(this, args);
        };
        node.__a5NativeColorCleanup = true;
    }
}

function addPaddingColorPickerButton(node) {
    if (findWidget(node, COLOR_PICK_BUTTON)) {
        return;
    }
    const widget = node.addWidget(
        "button",
        COLOR_PICK_BUTTON,
        null,
        () => void pickPaddingColor(node),
        { serialize: false },
    );
    widget.label = "Pick padding color";
    widget.serialize = false;
    widget.options = widget.options || {};
    widget.options.serialize = false;
    const appendedIndex = node.widgets.indexOf(widget);
    node.widgets.splice(appendedIndex, 1);
    const colorIndex = node.widgets.findIndex((item) => item.name === "padding_color");
    node.widgets.splice(colorIndex >= 0 ? colorIndex + 1 : node.widgets.length, 0, widget);
}

function initializeNodeUi(node) {
    addSectionDivider(node);
    chainAspectRatioCallback(node);
    enableEscapeColorCommit(node);
    addPaddingColorPickerButton(node);
    updateAspectPlacementState(node);
    ensureNodeFitsWidgets(node);
}

app.registerExtension({
    name: "A5.pad_image_for_outpaint.color_and_layout",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) {
            return;
        }
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            originalOnNodeCreated?.apply(this, args);
            initializeNodeUi(this);
        };

        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (config, ...args) {
            const result = originalConfigure?.apply(this, [config, ...args]);
            initializeNodeUi(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message, ...args) {
            originalOnExecuted?.apply(this, [message, ...args]);
            updateResolutionReadout(this, message);
        };
    },
});
