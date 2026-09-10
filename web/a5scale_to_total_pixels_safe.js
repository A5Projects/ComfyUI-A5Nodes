import { app } from "../../scripts/app.js";

const NODE_ID = "A5scale_to_total_pixels_safe";
const COLOR_PICK_BUTTON = "pick_padding_color";
const DISABLED_ASPECT_RATIO = "disabled";
const ASPECT_RATIO_VALUES = new Set([
    DISABLED_ASPECT_RATIO,
    "1:1 (Square)",
    "2:3 (Portrait Photo)",
    "3:2 (Photo)",
    "3:4 (Portrait Standard)",
    "4:3 (Standard)",
    "9:16 (Portrait Widescreen)",
    "16:9 (Widescreen)",
    "21:9 (Ultrawide)",
]);

let pendingNativeColorSession = null;
let activeNativeColorSession = null;
let nativeColorBridgeInstalled = false;
let activeCanvasPickCleanup = null;
let activeCanvasPickNode = null;

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
        if (!session || event.target !== session.input) {
            return;
        }

        const value = event.target.value;
        if (typeof value !== "string" || !value) {
            return;
        }

        if (typeof session.widget.setValue === "function") {
            session.widget.setValue(value, session.context);
        } else {
            session.widget.value = value;
            session.widget.callback?.(value, session.node, session.widget);
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

function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function getReadout(message) {
    const width = firstValue(message?.width);
    const height = firstValue(message?.height);
    const sizeText = firstValue(message?.size_text) ?? firstValue(message?.text);

    if (width !== undefined && height !== undefined) {
        return {
            width,
            height,
            text: `${width}x${height}`,
        };
    }

    if (typeof sizeText === "string") {
        const match = sizeText.match(/(\d+)\s*x\s*(\d+)/i);
        return {
            width: match?.[1],
            height: match?.[2],
            text: sizeText,
        };
    }

    return {
        width: undefined,
        height: undefined,
        text: "not run yet",
    };
}

function setOutputLabels(node, width, height, sizeText) {
    if (!node.outputs) {
        return;
    }

    const valuesByName = {
        width,
        height,
        size_text: sizeText,
    };

    for (const output of node.outputs) {
        if (!output) {
            continue;
        }

        const baseName = output.name ?? output.label;
        const value = valuesByName[baseName];
        output.label = value !== undefined ? `${value} ${baseName}` : baseName;
    }
}

function findWidget(node, name) {
    return node.widgets?.find((item) => item.name === name);
}

function byteToHex(value) {
    return Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0");
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

    const sourceX = Math.min(sourceWidth - 1, Math.floor(localX * sourceWidth / contentWidth));
    const sourceY = Math.min(sourceHeight - 1, Math.floor(localY * sourceHeight / contentHeight));
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;

    try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            return null;
        }
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
        if (event.key !== "Escape") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        cleanup();
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

function hasLinkedInput(node, name) {
    return Boolean(node.inputs?.some((input) => input.name === name && input.link != null));
}

function migrateDimensionRule(value) {
    return {
        mul4: "Multi4",
        mul8: "Multi8",
        mul16: "Multi16",
        mul32: "Multi32",
    }[value] ?? value;
}

function enforceMul16Default(node) {
    const widget = findWidget(node, "dimension_rule");
    const shouldUpdate = widget && (
        widget.value === undefined ||
        widget.value === null ||
        widget.value === "" ||
        widget.value === "even"
    );

    if (!shouldUpdate) {
        return;
    }

    widget.value = "Multi16";
    widget.callback?.("Multi16", node, widget);
}

function migrateBasicWidgetLayout(config) {
    const values = config?.widgets_values;
    if (!Array.isArray(values)) {
        return config;
    }

    const withValues = (widgetsValues) => {
        const named = config.widgets_values_named;
        const widgetsValuesNamed = named && typeof named === "object"
            ? {
                ...named,
                dimension_rule: migrateDimensionRule(named.dimension_rule),
                aspect_ratio: named.aspect_ratio ?? DISABLED_ASPECT_RATIO,
                aspect_handling: named.aspect_handling === "stretch"
                    ? "stretch img"
                    : named.aspect_handling,
            }
            : named;
        return {
            ...config,
            widgets_values: widgetsValues.map((value, index) => (
                index === 1 ? migrateDimensionRule(value) : value
            )),
            ...(widgetsValuesNamed ? { widgets_values_named: widgetsValuesNamed } : {}),
        };
    };
    const completeLayout = ({
        targetTotalPixels,
        dimensionRule,
        scalePolicy,
        upscaleMethod,
        widthOverride,
        heightOverride,
        keepAspect,
        aspectHandling = "padding",
        paddingSide = "right / bottom",
        paddingColor = "#808080",
    }) => [
        targetTotalPixels,
        dimensionRule,
        DISABLED_ASPECT_RATIO,
        scalePolicy,
        upscaleMethod,
        "a5_manual_override_divider",
        widthOverride,
        heightOverride,
        keepAspect,
        "a5_aspect_mismatch_divider",
        aspectHandling === "stretch" ? "stretch img" : aspectHandling,
        paddingSide,
        paddingColor,
    ];

    if (values.length === 13 && ASPECT_RATIO_VALUES.has(values[2])) {
        const migrated = [...values];
        if (migrated[10] === "stretch") {
            migrated[10] = "stretch img";
        }
        return withValues(migrated);
    }

    if (values.length === 12) {
        const migrated = [
            values[0],
            values[1],
            DISABLED_ASPECT_RATIO,
            ...values.slice(2),
        ];
        if (migrated[10] === "stretch") {
            migrated[10] = "stretch img";
        }
        return withValues(migrated);
    }

    const oldSnapValues = new Set(["nearest", "down", "up", "round", "floor", "ceil"]);
    if (values.length === 8 && oldSnapValues.has(values[2])) {
        return withValues(completeLayout({
            targetTotalPixels: values[0],
            dimensionRule: values[1],
            scalePolicy: values[7],
            upscaleMethod: values[3],
            widthOverride: values[4],
            heightOverride: values[5],
            keepAspect: values[6],
        }));
    }

    if (values.length === 8) {
        return withValues(completeLayout({
            targetTotalPixels: values[0],
            dimensionRule: values[1],
            scalePolicy: values[2],
            upscaleMethod: values[3],
            widthOverride: values[5],
            heightOverride: values[6],
            keepAspect: values[7],
        }));
    }

    if (values.length === 7) {
        return withValues(completeLayout({
            targetTotalPixels: values[0],
            dimensionRule: values[1],
            scalePolicy: values[2],
            upscaleMethod: values[3],
            widthOverride: values[4],
            heightOverride: values[5],
            keepAspect: values[6],
        }));
    }

    return config;
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

function addSectionDivider(node, { name, label, beforeWidget }) {
    const existing = findWidget(node, name);
    if (existing) {
        return existing;
    }

    const widget = {
        name,
        type: "A5_SECTION_DIVIDER",
        value: name,
        inactive: false,
        serialize: true,
        options: { serialize: false },
        computeSize(width) {
            return [width, 24];
        },
        draw(ctx, _node, width, y, height) {
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
    const targetIndex = node.widgets.findIndex((item) => item.name === beforeWidget);
    node.widgets.splice(targetIndex >= 0 ? targetIndex : node.widgets.length, 0, widget);
    ensureNodeFitsWidgets(node);
    return widget;
}

function setWidgetDisabled(widget, disabled) {
    if (!widget) {
        return;
    }

    widget.disabled = disabled;
    widget.options = widget.options || {};
    widget.options.disabled = disabled;
}

function updatePaddingControlState(node) {
    const targetTotalPixels = findWidget(node, "target_total_pixels");
    const dimensionRule = findWidget(node, "dimension_rule");
    const aspectRatio = findWidget(node, "aspect_ratio");
    const scalePolicy = findWidget(node, "scale_policy");
    const widthOverride = findWidget(node, "width_override");
    const heightOverride = findWidget(node, "height_override");
    const keepAspect = findWidget(node, "keep_aspect");
    const aspectHandling = findWidget(node, "aspect_handling");
    const paddingSide = findWidget(node, "padding_side");
    const paddingColor = findWidget(node, "padding_color");
    const colorPickButton = findWidget(node, COLOR_PICK_BUTTON);

    const widthOverrideActive = Number(widthOverride?.value) > 0
        || hasLinkedInput(node, "width_override");
    const heightOverrideActive = Number(heightOverride?.value) > 0
        || hasLinkedInput(node, "height_override");
    const manualOverrideActive = widthOverrideActive || heightOverrideActive;
    const bothOverridesActive = widthOverrideActive && heightOverrideActive;
    const presetActive = (
        Boolean(aspectRatio) && aspectRatio.value !== DISABLED_ASPECT_RATIO
    ) || hasLinkedInput(node, "aspect_ratio");
    const keepAspectBypassed = presetActive || bothOverridesActive;
    const keepAspectCanBeOff = (
        keepAspect?.value === "off" || hasLinkedInput(node, "keep_aspect")
    );
    const aspectControlsActive = presetActive
        || bothOverridesActive
        || (manualOverrideActive && keepAspectCanBeOff);
    const paddingCanBeSelected = (
        aspectHandling?.value === "padding" || hasLinkedInput(node, "aspect_handling")
    );
    const paddingControlsActive = aspectControlsActive && paddingCanBeSelected;

    setWidgetDisabled(targetTotalPixels, manualOverrideActive);
    setWidgetDisabled(dimensionRule, manualOverrideActive);
    setWidgetDisabled(scalePolicy, manualOverrideActive);
    setWidgetDisabled(aspectRatio, bothOverridesActive);
    setWidgetDisabled(keepAspect, keepAspectBypassed);
    setWidgetDisabled(aspectHandling, !aspectControlsActive);
    setWidgetDisabled(paddingSide, !paddingControlsActive);
    setWidgetDisabled(paddingColor, !paddingControlsActive);
    setWidgetDisabled(colorPickButton, !paddingControlsActive);

    const divider = findWidget(node, "a5_aspect_mismatch_divider");
    if (divider) {
        divider.inactive = !aspectControlsActive;
    }
    node.setDirtyCanvas?.(true, true);
}

function chainAspectRatioCallback(node) {
    const widget = findWidget(node, "aspect_ratio");
    if (!widget || widget.__a5AspectRatioCallback) {
        return;
    }

    const originalCallback = widget.callback;
    widget.callback = function (...args) {
        const result = originalCallback?.apply(this, args);
        if (!node.__a5RestoringConfig && widget.value !== DISABLED_ASPECT_RATIO) {
            const aspectHandling = findWidget(node, "aspect_handling");
            if (aspectHandling && aspectHandling.value !== "padding") {
                aspectHandling.value = "padding";
                aspectHandling.callback?.("padding", node, aspectHandling);
            }
        }
        updatePaddingControlState(node);
        return result;
    };
    widget.__a5AspectRatioCallback = true;
}

function chainPaddingStateCallback(node, widgetName) {
    const widget = findWidget(node, widgetName);
    if (!widget || widget.__a5PaddingStateCallback) {
        return;
    }

    const originalCallback = widget.callback;
    widget.callback = function (...args) {
        const result = originalCallback?.apply(this, args);
        updatePaddingControlState(node);
        return result;
    };
    widget.__a5PaddingStateCallback = true;
}

function enableEscapeColorCommit(node) {
    const widget = findWidget(node, "padding_color");
    if (!widget || widget.__a5EscapeColorCommit || typeof widget.onClick !== "function") {
        return;
    }

    installNativeColorBridge();
    const originalOnClick = widget.onClick;
    widget.onClick = function (context, ...args) {
        pendingNativeColorSession = {
            widget: this,
            node,
            context,
        };
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
    const existing = findWidget(node, COLOR_PICK_BUTTON);
    if (existing) {
        return existing;
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
    ensureNodeFitsWidgets(node);
    return widget;
}

function initializePaddingUi(node) {
    addSectionDivider(node, {
        name: "a5_aspect_mismatch_divider",
        label: "ASPECT MISMATCH",
        beforeWidget: "aspect_handling",
    });

    for (const widgetName of [
        "width_override",
        "height_override",
        "keep_aspect",
        "aspect_handling",
    ]) {
        chainPaddingStateCallback(node, widgetName);
    }
    chainAspectRatioCallback(node);
    enableEscapeColorCommit(node);
    addPaddingColorPickerButton(node);
    updatePaddingControlState(node);
}

function updateResolutionReadout(node, message) {
    const { width, height, text } = getReadout(message);
    setOutputLabels(node, width, height, text);
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "A5.scale_to_total_pixels.readout_and_layout",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            originalOnNodeCreated?.apply(this, args);
            enforceMul16Default(this);
            addSectionDivider(this, {
                name: "a5_manual_override_divider",
                label: "MANUAL OVERRIDE",
                beforeWidget: "width_override",
            });
            initializePaddingUi(this);
            ensureNodeFitsWidgets(this);
        };

        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (config, ...args) {
            const migratedConfig = migrateBasicWidgetLayout(config);
            this.__a5RestoringConfig = true;
            let result;
            try {
                result = originalConfigure?.apply(this, [migratedConfig, ...args]);
            } finally {
                this.__a5RestoringConfig = false;
            }
            enforceMul16Default(this);
            initializePaddingUi(this);
            ensureNodeFitsWidgets(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message, ...args) {
            originalOnExecuted?.apply(this, [message, ...args]);
            updateResolutionReadout(this, message);
        };

        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = originalOnConnectionsChange?.apply(this, args);
            updatePaddingControlState(this);
            return result;
        };
    },
});
