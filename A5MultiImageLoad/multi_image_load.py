"""Independent reference outputs and an untouched, heterogeneous image list."""

import hashlib
import json
import math
from pathlib import Path


SLOT_COUNT = 6


def default_state():
    return {
        "version": 1,
        "slots": [{"file": "", "enabled": True} for _ in range(SLOT_COUNT)],
        "extras": [],
        "resize": False,
        "megapixels": 1.0,
        "downscale_only": False,
    }


def parse_state(state):
    try:
        value = json.loads(state)
    except (TypeError, ValueError) as exc:
        raise ValueError("A5 Multi Image Load: invalid saved image state.") from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("A5 Multi Image Load: unsupported image state version.")
    slots = value.get("slots")
    if not isinstance(slots, list) or len(slots) != SLOT_COUNT:
        raise ValueError("A5 Multi Image Load: expected six image slots.")
    for slot in slots:
        if (not isinstance(slot, dict) or not isinstance(slot.get("file"), str)
                or not isinstance(slot.get("enabled"), bool)):
            raise ValueError("A5 Multi Image Load: invalid image slot.")
    extras = value.get("extras")
    if not isinstance(extras, list) or any(not isinstance(f, str) or not f for f in extras):
        raise ValueError("A5 Multi Image Load: invalid extra image list.")
    if not isinstance(value.get("resize"), bool) or not isinstance(value.get("downscale_only"), bool):
        raise ValueError("A5 Multi Image Load: invalid resize settings.")
    mp = value.get("megapixels")
    if (isinstance(mp, bool) or not isinstance(mp, (int, float))
            or not math.isfinite(mp) or not 0.01 <= mp <= 100):
        raise ValueError("A5 Multi Image Load: megapixels must be between 0.01 and 100.")
    return value


def active_files(state):
    for index, slot in enumerate(state["slots"]):
        if slot["enabled"] and slot["file"]:
            yield f"Image {index + 1}", slot["file"]
    for index, filename in enumerate(state["extras"]):
        yield f"Extra image {index + 1}", filename


def resolve_file(filename):
    import folder_paths

    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    roots = (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
             folder_paths.get_temp_directory())
    if not any(path.is_relative_to(Path(root).resolve()) for root in roots):
        raise ValueError("image must be in ComfyUI's input, output or temp directory")
    if not path.is_file():
        raise ValueError(f"file not found: {filename}")
    return path


def reference_dimensions(width, height, megapixels, downscale_only=False):
    target = megapixels * 1_000_000
    if downscale_only and width * height <= target:
        return width, height
    scale = math.sqrt(target / (width * height))
    # Round only to whole pixels. No aspect-ratio-changing multiple/crop policy.
    return max(1, int(width * scale + 0.5)), max(1, int(height * scale + 0.5))


def load_original(filename):
    # Reuse the installed core decoder, including EXIF/color/alpha handling.
    # This is a still-image loader: animated inputs contribute their first frame.
    from nodes import LoadImage

    images, _mask = LoadImage().load_image(filename)
    if images.ndim != 4 or images.shape[0] == 0:
        raise ValueError("the file contains no image")
    return images[:1]


def resize_reference(image, megapixels, downscale_only):
    import comfy.utils

    height, width = image.shape[1:3]
    target_width, target_height = reference_dimensions(width, height, megapixels, downscale_only)
    if (target_width, target_height) == (width, height):
        return image
    return comfy.utils.common_upscale(
        image.movedim(-1, 1), target_width, target_height, "lanczos", "disabled"
    ).movedim(1, -1)


class A5MultiImageLoad:
    CATEGORY = "A5/image"
    FUNCTION = "load_images"
    RETURN_TYPES = ("IMAGE",) * 7
    RETURN_NAMES = ("image_1", "image_2", "image_3", "image_4", "image_5", "image_6", "image_list")
    OUTPUT_IS_LIST = (False,) * 6 + (True,)
    OUTPUT_TOOLTIPS = tuple(
        f"Reference {i}: optionally resized; None when empty or bypassed."
        for i in range(1, 7)
    ) + ("Original images, one per list item: active slots then extras. Never resized.",)
    DESCRIPTION = (
        "Six compact image loaders with independent bypass and optional reference resizing. "
        "The image list contains the original active images and extras for per-image processing. "
        "No mask or batch output. Animated files use their first frame."
    )
    SEARCH_ALIASES = ["multi image", "reference images", "image list", "load images"]

    @classmethod
    def INPUT_TYPES(cls):
        # A single serialized STRING keeps the API independent of the custom UI.
        # The frontend replaces only this node's state widget with the DOM grid.
        return {"required": {"state": ("STRING", {
            "default": json.dumps(default_state(), separators=(",", ":")),
        })}}

    @classmethod
    def VALIDATE_INPUTS(cls, state):
        try:
            parsed = parse_state(state)
            for label, filename in active_files(parsed):
                try:
                    resolve_file(filename)
                except (ValueError, OSError) as exc:
                    return f"A5 Multi Image Load — {label}: {exc}"
        except ValueError as exc:
            return str(exc)
        return True

    @classmethod
    def IS_CHANGED(cls, state):
        parsed = parse_state(state)
        digest = hashlib.sha256(state.encode("utf-8"))
        seen = set()
        for _label, filename in active_files(parsed):
            if filename in seen:
                continue
            seen.add(filename)
            try:
                with resolve_file(filename).open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
            except (ValueError, OSError):
                # Validation/execution produces the useful filename error.
                # Never reuse a cached result for a now-missing active file.
                return float("nan")
        return digest.hexdigest()

    def load_images(self, state):
        from comfy_execution.graph import ExecutionBlocker

        parsed = parse_state(state)
        originals = {}
        for label, filename in active_files(parsed):
            if filename in originals:
                continue
            try:
                resolve_file(filename)
                originals[filename] = load_original(filename)
            except Exception as exc:
                raise ValueError(f"A5 Multi Image Load — {label} ({filename}): {exc}") from exc

        references = []
        collection = []
        sizes = []
        for slot in parsed["slots"]:
            if not slot["enabled"] or not slot["file"]:
                references.append(None)
                sizes.append(None)
                continue
            original = originals[slot["file"]]
            collection.append(original)
            reference = (resize_reference(original, parsed["megapixels"], parsed["downscale_only"])
                         if parsed["resize"] else original)
            references.append(reference)
            sizes.append({"original": [original.shape[2], original.shape[1]],
                          "output": [reference.shape[2], reference.shape[1]]})
        collection.extend(originals[filename] for filename in parsed["extras"])
        count = len(collection)
        # [] is unsafe with normal list mapping when another input has one item.
        # A blocker skips only the empty processing branch, never references.
        list_result = collection if collection else [ExecutionBlocker(None)]
        return {"ui": {"a5_sizes": sizes, "a5_count": [count]},
                "result": (*references, list_result)}
