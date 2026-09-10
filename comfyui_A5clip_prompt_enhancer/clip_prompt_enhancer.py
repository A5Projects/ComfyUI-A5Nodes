from __future__ import annotations

import hashlib
import inspect
import io as bytes_io
import json
import logging
import re
import sys
import threading
from pathlib import Path
from typing import Any

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override


DEFAULT_SYSTEM_PROMPT = (
    "Enhance the user's image-generation prompt. Keep the core idea, add useful "
    "visual details, and return only the improved prompt."
)
DEFAULT_INPUT_PROMPT = "A cinematic portrait of a fox in a rainy neon city"
RUN_MODE_ALWAYS = "Always run LLM"
RUN_MODE_BYPASS = "Bypass - send last/manual prompt"
RUN_MODE_AUTO = "Auto bypass if unchanged"
RUN_MODE_CHOICES = [RUN_MODE_ALWAYS, RUN_MODE_BYPASS, RUN_MODE_AUTO]
CONFIG_PATH = Path(__file__).with_name("clip_prompt_enhancer_config.json")
PROMPT_UPDATE_EVENT = "a5clip_prompt_enhancer.prompt_updated"

_CONFIG_LOCK = threading.Lock()


def _load_config() -> dict[str, Any]:
    with _CONFIG_LOCK:
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return data if isinstance(data, dict) else {}


def _save_config(data: dict[str, Any]) -> None:
    with _CONFIG_LOCK:
        CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _load_last_enhanced_prompt() -> str:
    prompt = _load_config().get("last_enhanced_prompt")
    return prompt if isinstance(prompt, str) else ""


def _load_last_input_fingerprint() -> str:
    fingerprint = _load_config().get("last_input_fingerprint")
    return fingerprint if isinstance(fingerprint, str) else ""


def _save_last_enhanced_prompt(prompt: str, input_fingerprint: str | None = None) -> None:
    if not prompt:
        return

    data = _load_config()
    data["last_enhanced_prompt"] = prompt
    if input_fingerprint is not None:
        data["last_input_fingerprint"] = input_fingerprint
    _save_config(data)


def _strip_thinking_blocks(text: str) -> str:
    text = re.sub(r"<thinking[^>]*>[\s\S]*?</thinking>", "", text, flags=re.I)
    text = re.sub(r"<think[^>]*>[\s\S]*?</think>", "", text, flags=re.I)
    text = text.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "")
    return text.strip()


def _compose_generation_prompt(system_prompt: str, input_prompt: str) -> str:
    system_prompt = system_prompt.strip()
    input_prompt = input_prompt.strip()
    if system_prompt and input_prompt:
        return f"System instruction:\n{system_prompt}\n\nUser prompt:\n{input_prompt}"
    return system_prompt or input_prompt


def _update_hash_with_image(hasher: Any, image: Any) -> None:
    if image is None:
        hasher.update(b"no-image")
        return

    if hasattr(image, "detach") and hasattr(image, "shape"):
        tensor = image.detach().cpu().contiguous()
        hasher.update(str(tuple(tensor.shape)).encode("ascii"))
        hasher.update(str(tensor.dtype).encode("ascii"))
        try:
            image_bytes = tensor.numpy().tobytes()
        except (TypeError, RuntimeError):
            image_bytes = tensor.float().numpy().tobytes()
        hasher.update(image_bytes)
        return

    if isinstance(image, (list, tuple)):
        hasher.update(f"sequence:{len(image)}".encode("ascii"))
        for item in image:
            _update_hash_with_image(hasher, item)
        return

    if hasattr(image, "save"):
        buffer = bytes_io.BytesIO()
        image.save(buffer, format="PNG")
        hasher.update(buffer.getvalue())
        return

    hasher.update(repr(image).encode("utf-8", errors="replace"))


def _clip_identity(clip: Any) -> str:
    cond_stage_model = getattr(clip, "cond_stage_model", None)
    patcher = getattr(clip, "patcher", None)
    patcher_model = getattr(patcher, "model", None)
    model_type = type(cond_stage_model if cond_stage_model is not None else clip)
    return "|".join(
        (
            f"{model_type.__module__}.{model_type.__qualname__}",
            str(id(clip)),
            str(id(cond_stage_model)),
            str(id(patcher_model)),
        )
    )


def _get_prompt_node(graph: Any, node_id: Any) -> dict[str, Any] | None:
    if graph is None or node_id is None:
        return None

    if hasattr(graph, "get_node"):
        try:
            node = graph.get_node(str(node_id))
        except Exception:
            try:
                node = graph.get_node(node_id)
            except Exception:
                node = None
        return node if isinstance(node, dict) else None

    if isinstance(graph, dict):
        node = graph.get(str(node_id), graph.get(node_id))
        return node if isinstance(node, dict) else None
    return None


def _is_prompt_link(value: Any, graph: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[1], int)
        and _get_prompt_node(graph, value[0]) is not None
    )


def _normalize_prompt_value(value: Any, graph: Any, visiting: set[str]) -> Any:
    if _is_prompt_link(value, graph):
        source_id, output_index = value
        return {
            "link": {
                "source_id": str(source_id),
                "output_index": output_index,
                "source": _normalize_prompt_node(graph, source_id, visiting),
            }
        }
    if isinstance(value, dict):
        return {
            str(key): _normalize_prompt_value(item, graph, visiting)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_normalize_prompt_value(item, graph, visiting) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def _normalize_prompt_node(graph: Any, node_id: Any, visiting: set[str]) -> Any:
    node_key = str(node_id)
    if node_key in visiting:
        return {"source_id": node_key, "cycle": True}

    node = _get_prompt_node(graph, node_id)
    if node is None:
        return {"source_id": node_key, "missing": True}

    visiting.add(node_key)
    try:
        return {
            "source_id": node_key,
            "class_type": node.get("class_type"),
            "inputs": _normalize_prompt_value(node.get("inputs", {}), graph, visiting),
        }
    finally:
        visiting.remove(node_key)


def _hidden_graph(hidden: Any) -> Any:
    return getattr(hidden, "dynprompt", None) or getattr(hidden, "prompt", None)


def _raw_node_input(name: str, hidden: Any) -> tuple[Any, Any]:
    graph = _hidden_graph(hidden)
    node = _get_prompt_node(graph, getattr(hidden, "unique_id", None))
    if node is None:
        return None, graph
    return node.get("inputs", {}).get(name), graph


def _input_has_link(name: str, hidden: Any) -> bool:
    value, graph = _raw_node_input(name, hidden)
    return _is_prompt_link(value, graph)


def _clip_source_fingerprint(hidden: Any) -> str | None:
    value, graph = _raw_node_input("clip", hidden)
    if not _is_prompt_link(value, graph):
        return None

    normalized = _normalize_prompt_value(value, graph, set())
    raw = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _build_input_fingerprint(
    system_prompt: str,
    input_prompt: str,
    image: Any,
    clip_fingerprint: str,
) -> str:
    image_hasher = hashlib.sha256()
    _update_hash_with_image(image_hasher, image)
    payload = {
        "system_prompt": system_prompt,
        "input_prompt": input_prompt,
        "image_sha256": image_hasher.hexdigest(),
        "clip_fingerprint": clip_fingerprint,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _ensure_generative_clip(clip: Any) -> None:
    if not callable(getattr(clip, "tokenize", None)):
        raise RuntimeError(
            "The connected CLIP does not provide tokenize(). Use a text encoder "
            "compatible with ComfyUI's core Generate Text node."
        )
    if not callable(getattr(clip, "generate", None)):
        raise RuntimeError(
            "The connected CLIP does not provide generate(). Use a text encoder "
            "compatible with ComfyUI's core Generate Text node."
        )
    if not callable(getattr(clip, "decode", None)):
        raise RuntimeError(
            "The connected CLIP does not provide decode(). Use a text encoder "
            "compatible with ComfyUI's core Generate Text node."
        )

    cond_stage_model = getattr(clip, "cond_stage_model", None)
    if cond_stage_model is not None and not callable(getattr(cond_stage_model, "generate", None)):
        raise RuntimeError(
            "The connected CLIP is a conditioning encoder, not a generative text "
            "encoder. Use a CLIP accepted by ComfyUI's core Generate Text node."
        )


def _unload_clip_from_vram(clip: Any) -> None:
    patcher = getattr(clip, "patcher", None)
    if patcher is None:
        raise RuntimeError(
            "The connected CLIP does not expose a ComfyUI model patcher, so it "
            "cannot be unloaded selectively."
        )

    try:
        import comfy.model_management as model_management
    except Exception as exc:
        raise RuntimeError("ComfyUI model management is unavailable.") from exc

    loaded_models = getattr(model_management, "current_loaded_models", None)
    if not isinstance(loaded_models, list):
        raise RuntimeError(
            "This ComfyUI version does not expose the loaded-model registry needed "
            "to unload only the enhancer CLIP."
        )

    unloaded = False
    for index in range(len(loaded_models) - 1, -1, -1):
        loaded_model = loaded_models[index]
        if getattr(loaded_model, "model", None) is not patcher:
            continue
        if loaded_model.model_unload():
            loaded_models.pop(index)
            unloaded = True

    if unloaded:
        model_management.soft_empty_cache()


def _send_prompt_update(node_id: Any, prompt: str) -> None:
    if node_id is None or not prompt:
        return

    try:
        from server import PromptServer
    except Exception:
        return

    PromptServer.instance.send_sync(
        PROMPT_UPDATE_EVENT,
        {"node_id": str(node_id), "prompt": prompt},
    )


def _default_template_input():
    options = {
        "optional": True,
        "default": True,
        "tooltip": "Use the connected model's built-in prompt template.",
    }
    try:
        return io.Boolean.Input("use_default_template", advanced=True, **options)
    except TypeError:
        return io.Boolean.Input("use_default_template", **options)


class A5ClipPromptEnhancer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        sampling_options = [
            io.DynamicCombo.Option(
                key="on",
                inputs=[
                    io.Float.Input("temperature", default=0.7, min=0.01, max=2.0, step=0.000001),
                    io.Int.Input("top_k", default=64, min=0, max=1000),
                    io.Float.Input("top_p", default=0.95, min=0.0, max=1.0, step=0.01),
                    io.Float.Input("min_p", default=0.05, min=0.0, max=1.0, step=0.01),
                    io.Float.Input("repetition_penalty", default=1.05, min=0.0, max=5.0, step=0.01),
                    io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
                    io.Float.Input("presence_penalty", default=0.0, min=0.0, max=5.0, step=0.01),
                ],
            ),
            io.DynamicCombo.Option(key="off", inputs=[]),
        ]
        schema_options = {
            "node_id": "A5ClipPromptEnhancer",
            "display_name": "A5 CLIP Prompt Enhancer",
            "category": "utils/Prompt Enhancers",
            "description": "Enhance prompts with a generative ComfyUI CLIP text encoder.",
            "not_idempotent": True,
            "inputs": [
                io.Clip.Input("clip", lazy=True),
                io.Image.Input("image", optional=True, lazy=True),
                io.String.Input(
                    "system_prompt",
                    multiline=True,
                    dynamic_prompts=True,
                    default=DEFAULT_SYSTEM_PROMPT,
                ),
                io.String.Input(
                    "input_prompt",
                    multiline=True,
                    dynamic_prompts=True,
                    default=DEFAULT_INPUT_PROMPT,
                ),
                io.Combo.Input("run_mode", options=RUN_MODE_CHOICES, default=RUN_MODE_ALWAYS),
                io.String.Input(
                    "last_generated_prompt",
                    multiline=True,
                    default=_load_last_enhanced_prompt(),
                    tooltip="Prompt returned by bypass modes; real LLM runs overwrite it.",
                ),
                io.Int.Input("max_length", default=512, min=1, max=32768),
                io.DynamicCombo.Input(
                    "sampling_mode",
                    options=sampling_options,
                    display_name="Sampling Mode",
                ),
                io.Boolean.Input(
                    "thinking",
                    optional=True,
                    default=False,
                    tooltip="Operate in thinking mode if the model supports it.",
                ),
                _default_template_input(),
                io.Boolean.Input(
                    "unload_clip_after_generation",
                    default=False,
                    tooltip=(
                        "Unload only the connected enhancer CLIP from VRAM after a "
                        "real generation. Bypass modes skip this; later uses reload it."
                    ),
                ),
            ],
            "hidden": [io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.dynprompt],
            "outputs": [io.String.Output(display_name="enhanced_prompt")],
        }
        if "search_aliases" in inspect.signature(io.Schema).parameters:
            schema_options["search_aliases"] = [
                "prompt enhancer",
                "LLM",
                "CLIP generate",
                "Qwen",
                "Gemma",
            ]
        return io.Schema(**schema_options)

    @classmethod
    def check_lazy_status(
        cls,
        system_prompt: str,
        input_prompt: str,
        run_mode: str,
        last_generated_prompt: str,
        max_length: int,
        sampling_mode: dict[str, Any],
        unload_clip_after_generation: bool = False,
        clip: Any = None,
        image: Any = None,
        thinking: bool = False,
        use_default_template: bool = True,
    ) -> list[str]:
        del max_length, sampling_mode, unload_clip_after_generation, thinking, use_default_template

        if run_mode == RUN_MODE_BYPASS:
            return []

        needed = []
        if _input_has_link("image", cls.hidden) and image is None:
            needed.append("image")

        if run_mode == RUN_MODE_ALWAYS:
            if clip is None:
                needed.append("clip")
            return needed

        if needed:
            return needed

        clip_fingerprint = _clip_source_fingerprint(cls.hidden)
        cached_prompt = last_generated_prompt.strip() or _load_last_enhanced_prompt()
        if clip_fingerprint is not None:
            input_fingerprint = _build_input_fingerprint(
                system_prompt,
                input_prompt,
                image,
                clip_fingerprint,
            )
            if input_fingerprint == _load_last_input_fingerprint() and cached_prompt:
                return []

        if clip is None:
            return ["clip"]
        return []

    @classmethod
    def execute(
        cls,
        system_prompt: str,
        input_prompt: str,
        run_mode: str,
        unload_clip_after_generation: bool,
        last_generated_prompt: str,
        max_length: int,
        sampling_mode: dict[str, Any],
        clip: Any = None,
        image: Any = None,
        thinking: bool = False,
        use_default_template: bool = True,
    ) -> io.NodeOutput:
        manual_prompt = last_generated_prompt.strip()
        cached_prompt = _load_last_enhanced_prompt()

        if run_mode == RUN_MODE_BYPASS:
            result = manual_prompt or cached_prompt or input_prompt
            _save_last_enhanced_prompt(result)
            return io.NodeOutput(result)

        clip_fingerprint = _clip_source_fingerprint(cls.hidden)
        if clip_fingerprint is None and clip is not None:
            clip_fingerprint = _clip_identity(clip)

        input_fingerprint = _build_input_fingerprint(
            system_prompt,
            input_prompt,
            image,
            clip_fingerprint or "clip-source-unavailable",
        )
        if run_mode == RUN_MODE_AUTO and input_fingerprint == _load_last_input_fingerprint():
            result = manual_prompt or cached_prompt
            if result:
                _save_last_enhanced_prompt(result, input_fingerprint)
                return io.NodeOutput(result)

        if clip is None:
            raise RuntimeError(
                "The connected CLIP was not evaluated for a real generation. Update "
                "ComfyUI if this persists; this node requires lazy-input support."
            )
        _ensure_generative_clip(clip)
        prompt = _compose_generation_prompt(system_prompt, input_prompt)
        try:
            tokens = clip.tokenize(
                prompt,
                image=image,
                skip_template=not use_default_template,
                min_length=1,
                thinking=thinking,
            )
        except Exception as exc:
            if image is not None:
                raise RuntimeError(
                    "The connected CLIP could not tokenize the image. It may not "
                    f"support vision through ComfyUI's Generate Text interface: {exc}"
                ) from exc
            raise RuntimeError(f"The connected CLIP could not tokenize the prompt: {exc}") from exc

        do_sample = sampling_mode.get("sampling_mode") == "on"
        generation_started = False
        try:
            try:
                generation_started = True
                generated_ids = clip.generate(
                    tokens,
                    do_sample=do_sample,
                    max_length=max_length,
                    temperature=sampling_mode.get("temperature", 1.0),
                    top_k=sampling_mode.get("top_k", 50),
                    top_p=sampling_mode.get("top_p", 1.0),
                    min_p=sampling_mode.get("min_p", 0.0),
                    repetition_penalty=sampling_mode.get("repetition_penalty", 1.0),
                    presence_penalty=sampling_mode.get("presence_penalty", 0.0),
                    seed=sampling_mode.get("seed"),
                )
                result = _strip_thinking_blocks(clip.decode(generated_ids))
            except (AttributeError, TypeError, NotImplementedError) as exc:
                vision_hint = " The connected encoder may not support vision." if image is not None else ""
                raise RuntimeError(
                    "The connected CLIP could not generate text. Use a text encoder "
                    f"compatible with ComfyUI's core Generate Text node.{vision_hint} "
                    f"Original error: {exc}"
                ) from exc
        finally:
            if unload_clip_after_generation and generation_started:
                active_exception = sys.exc_info()[0] is not None
                try:
                    _unload_clip_from_vram(clip)
                except Exception:
                    if active_exception:
                        logging.exception(
                            "Failed to unload the A5 enhancer CLIP after a generation error."
                        )
                    else:
                        raise

        if not result:
            raise RuntimeError("The connected CLIP generated an empty prompt.")

        _save_last_enhanced_prompt(result, input_fingerprint)
        _send_prompt_update(cls.hidden.unique_id, result)
        return io.NodeOutput(result)


class A5ClipPromptEnhancerExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [A5ClipPromptEnhancer]


def _register_api_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.get("/a5clip_prompt_enhancer/config")
    async def get_config(_request):
        return web.json_response({"last_generated_prompt": _load_last_enhanced_prompt()})


try:
    _register_api_routes()
except Exception:
    pass
