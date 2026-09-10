from .pad_scale_to_total_pixels import A5PadScaleToTotalPixels


class A5ScaleToTotalPixelsSafe(A5PadScaleToTotalPixels):
    """
    Scale to a requested total pixel count or manual canvas size.
    Manual aspect mismatches can stretch the image or preserve it with a
    single padding strip on the selected side.
    """


NODE_CLASS_MAPPINGS = {
    "A5scale_to_total_pixels_safe": A5ScaleToTotalPixelsSafe,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A5scale_to_total_pixels_safe": "A5scale_to_total_pixels_safe",
}
