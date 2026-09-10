import torch
import comfy.model_management


LATENT_TYPE_FLUX2 = "Flux 2"
LATENT_TYPE_SD3 = "SD3 / Flux.1 / Qwen / Chroma"
LATENT_TYPE_HIDREAM = "HiDream-O1"

LATENT_TYPES = (
    LATENT_TYPE_FLUX2,
    LATENT_TYPE_SD3,
    LATENT_TYPE_HIDREAM,
)

PRESETS = (
    ("1MP", "1:1", 1024, 1024),
    ("1MP", "16:9", 1344, 768),
    ("1MP", "21:9", 1536, 640),
    ("1MP", "3:2", 1216, 832),
    ("1MP", "4:3", 1152, 864),
    ("1MP", "5:4", 1120, 896),
    ("2MP", "1:1", 1440, 1440),
    ("2MP", "16:9", 1792, 1024),
    ("2MP", "21:9", 2176, 928),
    ("2MP", "3:2", 1728, 1152),
    ("2MP", "4:3", 1664, 1248),
    ("2MP", "5:4", 1600, 1280),
    ("4MP", "1:1", 2048, 2048),
    ("4MP", "16:9", 2688, 1536),
    ("4MP", "21:9", 3072, 1312),
    ("4MP", "3:2", 2432, 1632),
    ("4MP", "4:3", 2304, 1728),
    ("4MP", "5:4", 2240, 1792),
)

PRESET_LABELS = tuple(
    f"{tier} | {aspect} | {width} x {height}"
    for tier, aspect, width, height in PRESETS
)
PRESET_SIZES = {
    f"{tier} | {aspect} | {width} x {height}": (width, height)
    for tier, aspect, width, height in PRESETS
}


def resolve_dimension(value, preset_value, name):
    if value is None:
        return preset_value

    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return preset_value

    try:
        value = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be empty, 0, or a positive integer.") from exc

    return value if value > 0 else preset_value


class A5Universal_latent_presets:
    """
    A5Universal_latent_presets
    """

    DESCRIPTION = (
        "Creates an empty latent from shared resolution presets, with a "
        "latent type selector for Flux 2, SD3-compatible models, and "
        "HiDream-O1 pixel-space workflows. Width and height values above "
        "0 override the selected preset."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent_type": (LATENT_TYPES, {"default": LATENT_TYPE_FLUX2}),
                "preset": (PRESET_LABELS, {"default": "1MP | 1:1 | 1024 x 1024"}),
                "width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "invert": ("BOOLEAN", {"default": False}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    FUNCTION = "generate"
    CATEGORY = "Flux 2/Latents"

    def generate(self, latent_type, preset, width, height, invert, batch_size):
        preset_width, preset_height = PRESET_SIZES[preset]
        width = resolve_dimension(width, preset_width, "Width")
        height = resolve_dimension(height, preset_height, "Height")

        if invert:
            width, height = height, width

        if latent_type == LATENT_TYPE_FLUX2:
            latent = torch.zeros(
                [batch_size, 128, height // 16, width // 16],
                device=comfy.model_management.intermediate_device(),
            )
            return ({"samples": latent}, width, height)

        if latent_type == LATENT_TYPE_SD3:
            latent = torch.zeros(
                [batch_size, 16, height // 8, width // 8],
                device=comfy.model_management.intermediate_device(),
                dtype=comfy.model_management.intermediate_dtype(),
            )
            return ({"samples": latent, "downscale_ratio_spacial": 8}, width, height)

        latent = torch.zeros(
            [batch_size, 3, height, width],
            device=comfy.model_management.intermediate_device(),
        )
        return ({"samples": latent}, width, height)


NODE_CLASS_MAPPINGS = {
    "A5Universal_latent_presets": A5Universal_latent_presets,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "A5Universal_latent_presets": "A5Universal_latent_presets",
}
