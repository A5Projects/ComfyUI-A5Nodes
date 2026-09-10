import math

import torch
import torch.nn.functional as F

import comfy.utils


UPSCALE_METHODS = ["lanczos", "bicubic", "bilinear", "nearest-exact", "area"]

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

OVERRIDE_TOOLTIP = (
    "Set to 0 to disable. One value sets that dimension; odd values round up "
    "to even. The other follows the preset, input aspect, or input size. Both "
    "values set the canvas and disable automatic sizing."
)


def common_required_inputs():
    return {
        "image": ("IMAGE",),
        "target_total_pixels": (
            "INT",
            {
                "default": 786432,
                "min": 4096,
                "max": 268435456,
                "step": 1,
                "tooltip": "Total pixels, 1000000=1 Megapixel",
            },
        ),
        "dimension_rule": (
            ["even", "Multi4", "Multi8", "Multi16", "Multi32", "any"],
            {"default": "Multi16"},
        ),
        "aspect_ratio": (
            list(ASPECT_RATIO_OPTIONS),
            {"default": "disabled", "tooltip": "Enabling activates padding"},
        ),
        "scale_policy": (
            ["both", "only_downscale", "only_upscale", "none"],
            {"default": "both"},
        ),
        "upscale_method": (list(UPSCALE_METHODS), {"default": "lanczos"}),
        "width_override": (
            "INT",
            {
                "default": 0,
                "min": 0,
                "max": 16384,
                "step": 1,
                "tooltip": OVERRIDE_TOOLTIP,
            },
        ),
        "height_override": (
            "INT",
            {
                "default": 0,
                "min": 0,
                "max": 16384,
                "step": 1,
                "tooltip": OVERRIDE_TOOLTIP,
            },
        ),
        "keep_aspect": (
            ["on", "off"],
            {
                "default": "on",
                "tooltip": "Disabling+overrides activates padding",
            },
        ),
    }


def ensure_bhwc(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        image = torch.tensor(image)
    image = image.float()
    if image.dim() == 3:
        image = image.unsqueeze(0)
    if image.dim() != 4:
        raise ValueError(f"Expected IMAGE as BHWC or HWC; got {tuple(image.shape)}")
    return image.clamp(0.0, 1.0)


def divisor(rule: str) -> int:
    return {
        "any": 1,
        "even": 2,
        "mul4": 4,
        "Multi4": 4,
        "mul8": 8,
        "Multi8": 8,
        "mul16": 16,
        "Multi16": 16,
        "mul32": 32,
        "Multi32": 32,
    }.get(rule, 1)


def round_dimension(value: float) -> int:
    return max(2, int(round(value)))


def ensure_even(value: int) -> int:
    value = max(2, int(value))
    return value if value % 2 == 0 else value + 1


def round_even_dimension(value: float) -> int:
    return ensure_even(round_dimension(value))


def enforce_multiple(value: int, rule: str) -> int:
    step = divisor(rule)
    if step <= 2:
        return ensure_even(value)
    snapped = round(value / step) * step
    return max(step, int(snapped))


def aspect_ratio_value(aspect_ratio: str):
    ratio = ASPECT_RATIOS.get(aspect_ratio)
    if ratio is None:
        return None
    return ratio[0] / ratio[1]


def best_dimensions_for_ratio(ratio: float, target_total: int, rule: str):
    ideal_width = math.sqrt(max(1, target_total) * ratio)
    base_width = round_dimension(ideal_width)
    best = None  # (area_error, ratio_error, width, height)

    for delta_width in range(-64, 65):
        candidate_width = max(2, base_width + delta_width)
        candidate_width = enforce_multiple(candidate_width, rule)
        candidate_height = round_dimension(candidate_width / ratio)
        candidate_height = enforce_multiple(candidate_height, rule)
        area = candidate_width * candidate_height
        area_error = abs(area - target_total)
        ratio_error = abs((candidate_width / candidate_height) - ratio)

        if best is None or (area_error, ratio_error) < (best[0], best[1]):
            best = (
                area_error,
                ratio_error,
                candidate_width,
                candidate_height,
            )
        if best[0] == 0:
            break

    return best[2], best[3]


def preset_dimensions_for_total(ratio: float, target_total: int, rule: str):
    ideal_height = math.sqrt(max(1, target_total) / ratio)
    ideal_width = ideal_height * ratio
    width = enforce_multiple(round_dimension(ideal_width), rule)
    height = enforce_multiple(round_dimension(ideal_height), rule)
    return width, height


def best_dimensions_for_total(
    width: int,
    height: int,
    target_total: int,
    rule: str,
):
    return best_dimensions_for_ratio(width / height, target_total, rule)


def apply_overrides(
    source_width: int,
    source_height: int,
    width_override: int,
    height_override: int,
    keep_aspect: bool,
    aspect_ratio: str,
):
    width_override = int(width_override) if width_override is not None else 0
    height_override = int(height_override) if height_override is not None else 0
    if width_override <= 0 and height_override <= 0:
        return None

    width_active = width_override > 0
    height_active = height_override > 0
    width = ensure_even(width_override) if width_active else 0
    height = ensure_even(height_override) if height_active else 0

    if width_active and height_active:
        return width, height

    selected_ratio = aspect_ratio_value(aspect_ratio)
    ratio = selected_ratio
    if ratio is None and keep_aspect:
        ratio = source_width / source_height

    if width_active:
        height = (
            round_even_dimension(width / ratio)
            if ratio is not None
            else ensure_even(source_height)
        )
    else:
        width = (
            round_even_dimension(height * ratio)
            if ratio is not None
            else ensure_even(source_width)
        )

    return width, height


def resolve_dimensions(
    source_width: int,
    source_height: int,
    target_total_pixels: int,
    dimension_rule: str,
    aspect_ratio: str,
    scale_policy: str,
    width_override: int,
    height_override: int,
    keep_aspect: bool,
):
    override_dimensions = apply_overrides(
        source_width,
        source_height,
        width_override,
        height_override,
        keep_aspect,
        aspect_ratio,
    )
    if override_dimensions is not None:
        return override_dimensions[0], override_dimensions[1], True

    allow_upscale = scale_policy in ("both", "only_upscale")
    allow_downscale = scale_policy in ("both", "only_downscale")
    current_total = source_width * source_height
    target_total = target_total_pixels

    if not allow_upscale and target_total > current_total:
        target_total = current_total
    if not allow_downscale and target_total < current_total:
        target_total = current_total

    selected_ratio = aspect_ratio_value(aspect_ratio)
    if selected_ratio is not None:
        width, height = preset_dimensions_for_total(
            selected_ratio,
            target_total,
            dimension_rule,
        )
    else:
        width, height = best_dimensions_for_total(
            source_width,
            source_height,
            target_total,
            dimension_rule,
        )
    return width, height, False


def resize_bhwc(
    image: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
) -> torch.Tensor:
    nchw = image.permute(0, 3, 1, 2).contiguous()
    if upscale_method == "lanczos":
        resized = comfy.utils.lanczos(nchw, int(width), int(height))
    else:
        mode = "nearest" if upscale_method == "nearest-exact" else upscale_method
        resized = F.interpolate(
            nchw,
            size=(int(height), int(width)),
            mode=mode,
            align_corners=False if mode in ("bilinear", "bicubic") else None,
        )
    return resized.permute(0, 2, 3, 1).contiguous().clamp(0.0, 1.0)


def result_with_size(image: torch.Tensor, width: int, height: int):
    size_text = f"{int(width)}x{int(height)}"
    return {
        "ui": {
            "text": [size_text],
            "width": [int(width)],
            "height": [int(height)],
            "size_text": [size_text],
        },
        "result": (image, int(width), int(height), size_text),
    }
