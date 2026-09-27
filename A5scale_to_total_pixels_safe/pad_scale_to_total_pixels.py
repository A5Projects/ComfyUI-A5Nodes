import re

import torch
import comfy.model_management

from .scale_core import (
    common_required_inputs,
    ensure_bhwc,
    resize_bhwc,
    resolve_dimensions,
    resolve_blank_dimensions,
    result_with_size,
)


HEX_COLOR_PATTERN = re.compile(r"^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$")


def parse_hex_color(color: str):
    match = HEX_COLOR_PATTERN.fullmatch(str(color).strip())
    if match is None:
        raise ValueError(
            f"padding_color must be a #RRGGBB or #RRGGBBAA hex color; got {color!r}"
        )
    value = match.group(1)
    return tuple(int(value[index : index + 2], 16) / 255.0 for index in (0, 2, 4))


def contain_dimensions(
    source_width: int,
    source_height: int,
    canvas_width: int,
    canvas_height: int,
):
    source_ratio = source_width / source_height
    canvas_ratio = canvas_width / canvas_height

    if source_ratio >= canvas_ratio:
        fitted_width = canvas_width
        fitted_height = max(1, min(canvas_height, round(canvas_width / source_ratio)))
    else:
        fitted_height = canvas_height
        fitted_width = max(1, min(canvas_width, round(canvas_height * source_ratio)))

    return int(fitted_width), int(fitted_height)


def padding_fill_values(color, channels: int, device, dtype):
    rgb = torch.tensor(color, device=device, dtype=dtype)
    if channels == 1:
        luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        return luminance.reshape(1)
    if channels == 2:
        luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        return torch.stack((luminance, torch.ones_like(luminance)))

    values = torch.ones(channels, device=device, dtype=dtype)
    values[:3] = rgb
    return values


def resize_with_one_sided_padding(
    image: torch.Tensor,
    canvas_width: int,
    canvas_height: int,
    upscale_method: str,
    padding_side: str,
    padding_color: str,
):
    batch, source_height, source_width, channels = image.shape
    fitted_width, fitted_height = contain_dimensions(
        source_width,
        source_height,
        canvas_width,
        canvas_height,
    )
    fitted = resize_bhwc(image, fitted_width, fitted_height, upscale_method)

    fill_values = padding_fill_values(
        parse_hex_color(padding_color),
        channels,
        image.device,
        image.dtype,
    )
    canvas = fill_values.view(1, 1, 1, channels).expand(
        batch,
        canvas_height,
        canvas_width,
        channels,
    ).clone()

    spare_width = canvas_width - fitted_width
    spare_height = canvas_height - fitted_height
    offset_x = spare_width // 2
    offset_y = spare_height // 2

    if padding_side == "right / bottom":
        offset_x = 0
        offset_y = 0
    elif padding_side == "left / top":
        offset_x = spare_width
        offset_y = spare_height

    canvas[
        :,
        offset_y : offset_y + fitted_height,
        offset_x : offset_x + fitted_width,
        :,
    ] = fitted
    return canvas.clamp(0.0, 1.0)


class A5PadScaleToTotalPixels:
    """
    Scale to a target total pixel count or manual canvas size.
    Manual aspect mismatches can stretch the image or preserve it with a
    single padding strip on the selected side.
    """

    DESCRIPTION = (
        "Resize or pad an image, or generate a solid-color canvas without an "
        "image using an aspect preset or manual dimensions. Always outputs an "
        "empty latent; its dimensions round up independently to multiples of 8."
    )

    @classmethod
    def INPUT_TYPES(cls):
        required = common_required_inputs()
        required.pop("image")
        required.update(
            {
                "aspect_handling": (
                    ["padding", "stretch img"],
                    {"default": "padding"},
                ),
                "padding_side": (
                    ["right / bottom", "center", "left / top"],
                    {"default": "right / bottom"},
                ),
                "padding_color": (
                    "COLOR",
                    {"default": "#808080", "socketless": True},
                ),
            }
        )
        return {
            "required": required,
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "Optional. Without an image, an aspect preset or "
                        "manual dimension creates a canvas filled with padding_color.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING", "LATENT")
    RETURN_NAMES = ("image", "width", "height", "size_text", "latent")
    OUTPUT_TOOLTIPS = (
        "Resized/padded image, or a solid-color canvas when no image is supplied.",
        "Actual output image width in pixels.",
        "Actual output image height in pixels.",
        "Actual output image dimensions.",
        "Empty latent, never an image encoding. Each dimension rounds up to a "
        "multiple of 8 independently of the image. The sampler may adapt it "
        "further for the model.",
    )
    FUNCTION = "execute"
    CATEGORY = "A5/image/transform"

    def execute(
        self,
        target_total_pixels,
        dimension_rule,
        aspect_ratio,
        scale_policy,
        upscale_method,
        width_override,
        height_override,
        keep_aspect,
        aspect_handling,
        padding_side,
        padding_color,
        image=None,
    ):
        if image is None:
            width, height = resolve_blank_dimensions(
                target_total_pixels, dimension_rule, aspect_ratio,
                width_override, height_override,
            )
            color = torch.tensor(parse_hex_color(padding_color), dtype=torch.float32)
            output = color.view(1, 1, 1, 3).expand(1, height, width, 3).clone()
            return self.result_with_latent(output, width, height, blank=True)

        image = ensure_bhwc(image)
        _, source_height, source_width, _ = image.shape
        width, height, has_manual_override = resolve_dimensions(
            source_width,
            source_height,
            target_total_pixels,
            dimension_rule,
            aspect_ratio,
            scale_policy,
            width_override,
            height_override,
            keep_aspect == "on",
        )

        width_active = int(width_override or 0) > 0
        height_active = int(height_override or 0) > 0
        both_overrides = width_active and height_active
        preset_active = aspect_ratio != "disabled"
        aspect_mismatch_active = (
            preset_active
            or both_overrides
            or (has_manual_override and keep_aspect == "off")
        )
        use_padding = aspect_mismatch_active and aspect_handling == "padding"
        if use_padding:
            output = resize_with_one_sided_padding(
                image,
                width,
                height,
                upscale_method,
                padding_side,
                padding_color,
            )
        else:
            output = resize_bhwc(image, width, height, upscale_method)

        return self.result_with_latent(output, width, height, blank=False)

    @staticmethod
    def result_with_latent(output, width, height, blank):
        latent_width = ((width + 7) // 8) * 8
        latent_height = ((height + 7) // 8) * 8
        latent = {
            "samples": torch.zeros(
                (output.shape[0], 4, latent_height // 8, latent_width // 8),
                device=comfy.model_management.intermediate_device(),
                dtype=comfy.model_management.intermediate_dtype(),
            ),
            "downscale_ratio_spacial": 8,
        }
        result = result_with_size(output, width, height)
        result["result"] += (latent,)
        result["ui"].update({
            "blank_image": [blank],
            "latent_width": [latent_width],
            "latent_height": [latent_height],
        })
        return result
