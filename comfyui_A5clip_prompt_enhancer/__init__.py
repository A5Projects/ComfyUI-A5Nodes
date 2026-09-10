from .clip_prompt_enhancer import A5ClipPromptEnhancerExtension


WEB_DIRECTORY = "./js"


async def comfy_entrypoint() -> A5ClipPromptEnhancerExtension:
    return A5ClipPromptEnhancerExtension()


__all__ = ["A5ClipPromptEnhancerExtension", "WEB_DIRECTORY", "comfy_entrypoint"]
