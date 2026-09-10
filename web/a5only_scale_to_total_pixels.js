import { app } from "../../scripts/app.js";

const NODE_ID = "A5only_scale_to_total_pixels";


function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
}


function updateResolutionReadout(node, message) {
    const width = firstValue(message?.width);
    const height = firstValue(message?.height);
    const sizeText = firstValue(message?.size_text) ?? firstValue(message?.text);
    const text = width !== undefined && height !== undefined
        ? `${width}x${height}`
        : sizeText;
    const valuesByName = {
        width,
        height,
        size_text: text,
    };

    for (const output of node.outputs ?? []) {
        const baseName = output?.name ?? output?.label;
        if (!baseName) {
            continue;
        }
        const value = valuesByName[baseName];
        output.label = value !== undefined ? `${value} ${baseName}` : baseName;
    }
    node.setDirtyCanvas?.(true, true);
}


function findWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
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

    widget.value = "mul16";
    widget.callback?.("mul16", node, widget);
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


function addManualOverrideDivider(node) {
    if (findWidget(node, "a5_manual_override_divider")) {
        return;
    }

    const label = "MANUAL OVERRIDE";
    const widget = {
        name: "a5_manual_override_divider",
        type: "A5_SECTION_DIVIDER",
        value: "a5_manual_override_divider",
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
            ctx.fillStyle = "#8a8a8a";
            ctx.strokeStyle = "#555";
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
    const widthIndex = node.widgets.findIndex((item) => item.name === "width_override");
    node.widgets.splice(widthIndex >= 0 ? widthIndex : node.widgets.length, 0, widget);
    ensureNodeFitsWidgets(node);
}


app.registerExtension({
    name: "A5.only_scale_to_total_pixels.readout_and_layout",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            originalOnNodeCreated?.apply(this, args);
            enforceMul16Default(this);
            addManualOverrideDivider(this);
            ensureNodeFitsWidgets(this);
        };

        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (...args) {
            const result = originalConfigure?.apply(this, args);
            enforceMul16Default(this);
            ensureNodeFitsWidgets(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message, ...args) {
            originalOnExecuted?.apply(this, [message, ...args]);
            updateResolutionReadout(this, message);
        };
    },
});
