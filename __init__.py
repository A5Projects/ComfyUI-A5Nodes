"""Combined loader for the A5 ComfyUI node pack."""

from .A5Pad_Image_for_Outpaint import (
    NODE_CLASS_MAPPINGS as OUTPAINT_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as OUTPAINT_DISPLAY_MAPPINGS,
)
from .A5Universal_latent_presets import (
    NODE_CLASS_MAPPINGS as LATENT_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as LATENT_DISPLAY_MAPPINGS,
)
from .A5only_scale_to_total_pixels import (
    NODE_CLASS_MAPPINGS as ONLY_SCALE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as ONLY_SCALE_DISPLAY_MAPPINGS,
)
from .A5scale_to_total_pixels_safe import (
    NODE_CLASS_MAPPINGS as SAFE_SCALE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as SAFE_SCALE_DISPLAY_MAPPINGS,
)
from .comfyui_A5Note_Database import (
    NODE_CLASS_MAPPINGS as NOTE_DATABASE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOTE_DATABASE_DISPLAY_MAPPINGS,
)
from .comfyui_A5Prompt_database import (
    NODE_CLASS_MAPPINGS as PROMPT_DATABASE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PROMPT_DATABASE_DISPLAY_MAPPINGS,
)
from .comfyui_A5TextPrompt import (
    NODE_CLASS_MAPPINGS as TEXT_PROMPT_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as TEXT_PROMPT_DISPLAY_MAPPINGS,
)
from .comfyui_A5clip_prompt_enhancer.clip_prompt_enhancer import A5ClipPromptEnhancer
from .comfyui_A5lmstudio_prompt_enhancer import (
    NODE_CLASS_MAPPINGS as LM_STUDIO_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as LM_STUDIO_DISPLAY_MAPPINGS,
)


# ComfyUI gives NODE_CLASS_MAPPINGS priority over comfy_entrypoint when both are
# exported. Registering the V3 CLIP node in this combined mapping lets it coexist
# with the pack's legacy nodes; current ComfyUI detects V3 node classes at schema
# and execution time.
NODE_CLASS_MAPPINGS = {
    "A5ClipPromptEnhancer": A5ClipPromptEnhancer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A5ClipPromptEnhancer": "A5 CLIP Prompt Enhancer",
}

_MAPPING_PAIRS = (
    (LM_STUDIO_CLASS_MAPPINGS, LM_STUDIO_DISPLAY_MAPPINGS),
    (TEXT_PROMPT_CLASS_MAPPINGS, TEXT_PROMPT_DISPLAY_MAPPINGS),
    (PROMPT_DATABASE_CLASS_MAPPINGS, PROMPT_DATABASE_DISPLAY_MAPPINGS),
    (NOTE_DATABASE_CLASS_MAPPINGS, NOTE_DATABASE_DISPLAY_MAPPINGS),
    (LATENT_CLASS_MAPPINGS, LATENT_DISPLAY_MAPPINGS),
    (SAFE_SCALE_CLASS_MAPPINGS, SAFE_SCALE_DISPLAY_MAPPINGS),
    (OUTPAINT_CLASS_MAPPINGS, OUTPAINT_DISPLAY_MAPPINGS),
    (ONLY_SCALE_CLASS_MAPPINGS, ONLY_SCALE_DISPLAY_MAPPINGS),
)

for class_mappings, display_mappings in _MAPPING_PAIRS:
    duplicate_ids = NODE_CLASS_MAPPINGS.keys() & class_mappings.keys()
    if duplicate_ids:
        duplicates = ", ".join(sorted(duplicate_ids))
        raise RuntimeError(f"Duplicate A5 node id(s): {duplicates}")
    NODE_CLASS_MAPPINGS.update(class_mappings)
    NODE_DISPLAY_NAME_MAPPINGS.update(display_mappings)


WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
