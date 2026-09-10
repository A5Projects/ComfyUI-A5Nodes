import math

import torch
import torch.nn.functional as F

import comfy.utils


UPSCALE_METHODS = ["lanczos", "bicubic", "bilinear", "nearest-exact", "area"]


def common_required_inputs():
    return {
        "image": ("IMAGE",),
        "target_total_pixels": (
            "INT",
            {"default": 786432, "min": 4096, "max": 268435456, "step": 1},
        ),
        "dimension_rule": (
            ["even", "mul4", "mul8", "mul16", "mul32", "any"],
            {"default": "mul16"},
        ),
        "scale_policy": (
            ["both", "only_downscale", "only_upscale", "none"],
            {"default": "both"},
        ),
        "upscale_method": (list(UPSCALE_METHODS), {"default": "lanczos"}),
        "width_override": (
            "INT",
            {"default": 0, "min": 0, "max": 16384, "step": 1},
        ),
        "height_override": (
            "INT",
            {"default": 0, "min": 0, "max": 16384, "step": 1},
        ),
        "keep_aspect": (["on", "off"], {"default": "on"}),
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
        "mul8": 8,
        "mul16": 16,
        "mul32": 32,
    }.get(rule, 1)


def round_dimension(value: float) -> int:
    return max(2, int(round(value)))


def enforce_multiple(value: int, rule: str) -> int:
    step = divisor(rule)
    if step <= 1:
        return max(2, value)
    snapped = round(value / step) * step
    return max(step, int(snapped))


def best_dimensions_for_total(
    width: int,
    height: int,
    target_total: int,
    rule: str,
):
    ratio = width / height
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


def apply_overrides(
    source_width: int,
    source_height: int,
    width_override: int,
    height_override: int,
    keep_aspect: bool,
    rule: str,
):
    width_override = int(width_override) if width_override is not None else 0
    height_override = int(height_override) if height_override is not None else 0
    if width_override <= 0 and height_override <= 0:
        return None

    ratio = source_width / source_height
    if keep_aspect:
        if width_override > 0 and height_override <= 0:
            width = width_override
            height = round_dimension(width / ratio)
        elif height_override > 0 and width_override <= 0:
            height = height_override
            width = round_dimension(height * ratio)
        else:
            width = width_override
            height = round_dimension(width / ratio)
    else:
        width = width_override if width_override > 0 else source_width
        height = height_override if height_override > 0 else source_height

    width = enforce_multiple(int(width), rule)
    height = enforce_multiple(int(height), rule)
    return max(2, int(width)), max(2, int(height))


def resolve_dimensions(
    source_width: int,
    source_height: int,
    target_total_pixels: int,
    dimension_rule: str,
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
        dimension_rule,
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
