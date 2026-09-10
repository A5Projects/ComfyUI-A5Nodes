import re

import torch


MAX_PADDING = 16384
ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}
ASPECT_RATIO_OPTIONS = ["disabled", *ASPECT_RATIOS]
IMAGE_PLACEMENTS = ["fit left", "fit right", "fit top", "fit bottom", "center"]
FEATHER_MODES = ["fade img to color", "mask only"]
HEX_COLOR_PATTERN = re.compile(r"^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$")


def parse_hex_color(color: str):
    match = HEX_COLOR_PATTERN.fullmatch(str(color).strip())
    if match is None:
        raise ValueError(
            f"padding_color must be a #RRGGBB or #RRGGBBAA hex color; got {color!r}"
        )
    value = match.group(1)
    return tuple(int(value[index : index + 2], 16) / 255.0 for index in (0, 2, 4))


def ensure_bhwc(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        image = torch.as_tensor(image)
    if image.dim() == 3:
        image = image.unsqueeze(0)
    if image.dim() != 4:
        raise ValueError(f"Expected IMAGE as BHWC or HWC; got {tuple(image.shape)}")
    return image


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


def ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def aspect_padding(
    source_width: int,
    source_height: int,
    aspect_ratio: str,
    image_placement: str,
):
    ratio = ASPECT_RATIOS.get(aspect_ratio)
    if ratio is None:
        return 0, 0, 0, 0

    ratio_width, ratio_height = ratio
    source_ratio_numerator = source_width * ratio_height
    target_ratio_numerator = source_height * ratio_width

    if source_ratio_numerator < target_ratio_numerator:
        extra_width = ceil_div(source_height * ratio_width, ratio_height) - source_width
        if image_placement == "fit left":
            return 0, 0, extra_width, 0
        if image_placement == "fit right":
            return extra_width, 0, 0, 0
        left = extra_width // 2
        return left, 0, extra_width - left, 0

    if source_ratio_numerator > target_ratio_numerator:
        extra_height = ceil_div(source_width * ratio_height, ratio_width) - source_height
        if image_placement == "fit top":
            return 0, 0, 0, extra_height
        if image_placement == "fit bottom":
            return 0, extra_height, 0, 0
        top = extra_height // 2
        return 0, top, 0, extra_height - top

    return 0, 0, 0, 0


def feathered_source_mask(
    source_width: int,
    source_height: int,
    left: int,
    top: int,
    right: int,
    bottom: int,
    feathering: int,
    device,
):
    mask = torch.zeros((source_height, source_width), device=device, dtype=torch.float32)
    if (
        feathering <= 0
        or feathering * 2 >= source_height
        or feathering * 2 >= source_width
        or not any((left, top, right, bottom))
    ):
        return mask

    rows = torch.arange(source_height, device=device, dtype=torch.float32).unsqueeze(1)
    columns = torch.arange(source_width, device=device, dtype=torch.float32).unsqueeze(0)
    distance_top = rows if top else torch.full_like(rows, source_height)
    distance_bottom = source_height - rows if bottom else torch.full_like(rows, source_height)
    distance_left = columns if left else torch.full_like(columns, source_width)
    distance_right = source_width - columns if right else torch.full_like(columns, source_width)
    distance = torch.minimum(
        torch.minimum(distance_top, distance_bottom),
        torch.minimum(distance_left, distance_right),
    )
    feather = float(feathering)
    return torch.where(distance < feather, ((feather - distance) / feather).square(), mask)


class A5PadImageForOutpaint:
    """Extend an image canvas for outpainting without resizing the input image."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "left": ("INT", {"default": 0, "min": 0, "max": MAX_PADDING, "step": 8}),
                "top": ("INT", {"default": 0, "min": 0, "max": MAX_PADDING, "step": 8}),
                "right": ("INT", {"default": 0, "min": 0, "max": MAX_PADDING, "step": 8}),
                "bottom": ("INT", {"default": 0, "min": 0, "max": MAX_PADDING, "step": 8}),
                "feathering": (
                    "INT",
                    {"default": 40, "min": 0, "max": MAX_PADDING, "step": 1},
                ),
                "feather_mode": (
                    list(FEATHER_MODES),
                    {
                        "default": "fade img to color",
                        "tooltip": "Fade the image edge into the padding color, or feather only the mask.",
                    },
                ),
                "padding_color": (
                    "COLOR",
                    {"default": "#808080", "socketless": True},
                ),
                "aspect_ratio": (
                    list(ASPECT_RATIO_OPTIONS),
                    {
                        "default": "disabled",
                        "tooltip": "Expands the canvas without resizing the image.",
                    },
                ),
                "image_placement": (
                    list(IMAGE_PLACEMENTS),
                    {
                        "default": "center",
                        "tooltip": "Positions the image within aspect-ratio padding.",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "pad_image"
    CATEGORY = "A5/image/transform"

    def pad_image(
        self,
        image,
        left,
        top,
        right,
        bottom,
        feathering,
        feather_mode,
        padding_color,
        aspect_ratio,
        image_placement,
    ):
        image = ensure_bhwc(image)
        batch, source_height, source_width, channels = image.shape
        aspect_left, aspect_top, aspect_right, aspect_bottom = aspect_padding(
            source_width,
            source_height,
            aspect_ratio,
            image_placement,
        )

        total_left = aspect_left + max(0, int(left))
        total_top = aspect_top + max(0, int(top))
        total_right = aspect_right + max(0, int(right))
        total_bottom = aspect_bottom + max(0, int(bottom))
        canvas_width = source_width + total_left + total_right
        canvas_height = source_height + total_top + total_bottom

        fill = padding_fill_values(
            parse_hex_color(padding_color),
            channels,
            image.device,
            image.dtype,
        )
        canvas = fill.view(1, 1, 1, channels).expand(
            batch,
            canvas_height,
            canvas_width,
            channels,
        ).clone()
        source_mask = feathered_source_mask(
            source_width,
            source_height,
            total_left,
            total_top,
            total_right,
            total_bottom,
            max(0, int(feathering)),
            image.device,
        )
        source_image = image
        if feather_mode == "fade img to color":
            fade = source_mask.to(dtype=image.dtype).unsqueeze(0).unsqueeze(-1)
            source_image = image * (1.0 - fade) + fill.view(1, 1, 1, channels) * fade
        canvas[
            :,
            total_top : total_top + source_height,
            total_left : total_left + source_width,
            :,
        ] = source_image

        mask = torch.ones(
            (batch, canvas_height, canvas_width),
            device=image.device,
            dtype=torch.float32,
        )
        mask[
            :,
            total_top : total_top + source_height,
            total_left : total_left + source_width,
        ] = source_mask
        return {
            "ui": {
                "width": [canvas_width],
                "height": [canvas_height],
                "text": [f"{canvas_width}x{canvas_height}"],
            },
            "result": (canvas, mask, canvas_width, canvas_height),
        }


NODE_CLASS_MAPPINGS = {
    "A5Pad_Image_for_Outpaint": A5PadImageForOutpaint,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A5Pad_Image_for_Outpaint": "A5Pad Image for Outpaint",
}
