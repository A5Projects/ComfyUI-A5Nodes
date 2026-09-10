from .scale_core import (
    common_required_inputs,
    ensure_bhwc,
    resize_bhwc,
    resolve_dimensions,
    result_with_size,
)


class A5OnlyScaleToTotalPixels:
    """
    Scale to a requested total pixel count while preserving aspect ratio.
    Optional width/height overrides with keep-aspect control.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": common_required_inputs()}

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING")
    RETURN_NAMES = ("image", "width", "height", "size_text")
    FUNCTION = "execute"
    CATEGORY = "A5/image/transform"

    def execute(
        self,
        image,
        target_total_pixels,
        dimension_rule,
        scale_policy,
        upscale_method,
        width_override,
        height_override,
        keep_aspect,
    ):
        image = ensure_bhwc(image)
        _, source_height, source_width, _ = image.shape
        width, height, _ = resolve_dimensions(
            source_width,
            source_height,
            target_total_pixels,
            dimension_rule,
            scale_policy,
            width_override,
            height_override,
            keep_aspect == "on",
        )
        output = resize_bhwc(image, width, height, upscale_method)
        return result_with_size(output, width, height)


NODE_CLASS_MAPPINGS = {
    "A5only_scale_to_total_pixels": A5OnlyScaleToTotalPixels,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A5only_scale_to_total_pixels": "A5only_scale_to_total_pixels",
}
