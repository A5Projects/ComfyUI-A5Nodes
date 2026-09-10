from __future__ import annotations

import asyncio
import base64
import gc
import hashlib
import io
import json
import re
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from PIL import Image


DEFAULT_SERVER_URL = "http://localhost:1234/v1"
DEFAULT_SYSTEM_PROMPT = (
    "Enhance the user's image-generation prompt. Keep the core idea, add useful "
    "visual details, and return only the improved prompt."
)
CONFIG_PATH = Path(__file__).with_name("lmstudio_prompt_enhancer_config.json")
CREDENTIALS_DIRECTORY = "A5-Nodes"
CREDENTIALS_FILENAME = "lmstudio_credentials.json"
MAX_RECENT_MODELS = 5
CHAT_COMPLETION_TIMEOUT_SECONDS = 3600
DEFAULT_MAX_TOKENS = 12000
MAX_IMAGE_LONG_SIDE = 3072
MASKED_API_TOKEN = "XXXXXXXX"
RUN_MODE_ALWAYS = "Always run LLM"
RUN_MODE_BYPASS = "Bypass - send last/manual prompt"
RUN_MODE_AUTO = "Auto bypass if unchanged"
RUN_MODE_CHOICES = [RUN_MODE_ALWAYS, RUN_MODE_BYPASS, RUN_MODE_AUTO]
PROMPT_UPDATE_EVENT = "a5lmstudio_prompt_enhancer.prompt_updated"
DEFAULT_MODEL_LABEL = "Use loaded default model"
LEGACY_DEFAULT_MODEL_LABEL = "Use loaded/default model"
VISION_LABEL_SUFFIX = " [vision?]"


def _normalize_server_url(server_url: str) -> str:
    url = (server_url or DEFAULT_SERVER_URL).strip()
    if not url:
        url = DEFAULT_SERVER_URL
    if "://" not in url:
        url = f"http://{url}"

    parsed = parse.urlparse(url)
    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1"
    elif path.endswith("/chat/completions"):
        path = path[: -len("/chat/completions")] or "/v1"

    return parse.urlunparse(
        (parsed.scheme, parsed.netloc, path, "", "", "")
    ).rstrip("/")


def _native_api_base_url(server_url: str) -> str:
    openai_base = _normalize_server_url(server_url)
    parsed = parse.urlparse(openai_base)
    path = parsed.path.rstrip("/")

    if path == "/api/v1" or path.endswith("/api/v1"):
        native_path = path
    elif path == "/v1" or path.endswith("/v1"):
        native_path = f"{path[: -len('/v1')]}/api/v1"
    else:
        native_path = f"{path}/api/v1"

    return parse.urlunparse(
        (parsed.scheme, parsed.netloc, native_path, "", "", "")
    ).rstrip("/")


def _build_headers(api_token: str = "") -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"
    return headers


def _post_json(
    url: str,
    payload: dict[str, Any],
    api_token: str = "",
    timeout: int = 180,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers=_build_headers(api_token),
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LM Studio HTTP {exc.code}: {detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"Could not connect to LM Studio at {url}: {exc.reason}") from exc

    if not response_body.strip():
        return {}
    return json.loads(response_body)


def _get_json(url: str, api_token: str = "", timeout: int = 60) -> dict[str, Any]:
    req = request.Request(
        url,
        headers=_build_headers(api_token),
        method="GET",
    )

    try:
        with request.urlopen(req, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LM Studio HTTP {exc.code}: {detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"Could not connect to LM Studio at {url}: {exc.reason}") from exc

    if not response_body.strip():
        return {}
    return json.loads(response_body)


def _strip_thinking_blocks(text: str) -> str:
    text = re.sub(r"<thinking[^>]*>[\s\S]*?</thinking>", "", text, flags=re.I)
    text = re.sub(r"<think[^>]*>[\s\S]*?</think>", "", text, flags=re.I)
    text = text.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "")
    return text.strip()


def _extract_message_content(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("LM Studio returned no choices.")

    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)

    text = choices[0].get("text")
    if isinstance(text, str):
        return text

    raise RuntimeError("LM Studio response did not contain text content.")


def _load_config() -> dict[str, Any]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_config(data: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )


def _credentials_path() -> Path:
    """Return a credentials path outside the custom-node source tree."""
    try:
        import folder_paths

        get_user_directory = getattr(folder_paths, "get_user_directory", None)
        if callable(get_user_directory):
            user_directory = Path(get_user_directory())
        else:
            raise AttributeError("ComfyUI does not expose get_user_directory")
    except (ImportError, AttributeError, TypeError):
        # This fallback mainly supports importing the module outside ComfyUI for
        # development. Current ComfyUI versions use the branch above.
        user_directory = Path.home() / ".comfyui" / "user"

    return user_directory / CREDENTIALS_DIRECTORY / CREDENTIALS_FILENAME


def _load_credentials() -> dict[str, Any]:
    try:
        data = json.loads(_credentials_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_credentials(data: dict[str, Any]) -> None:
    credentials_path = _credentials_path()
    credentials_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = credentials_path.with_suffix(f"{credentials_path.suffix}.tmp")
    temporary_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary_path.replace(credentials_path)
    try:
        credentials_path.chmod(0o600)
    except OSError:
        pass


def _remove_legacy_api_token(config: dict[str, Any]) -> None:
    if "api_token" not in config:
        return
    sanitized_config = dict(config)
    sanitized_config.pop("api_token", None)
    _save_config(sanitized_config)


def _load_saved_api_token() -> str:
    credentials = _load_credentials()
    token = credentials.get("api_token")
    if isinstance(token, str) and token:
        _remove_legacy_api_token(_load_config())
        return token

    # Migrate tokens written by the former standalone node. The source-side
    # value is removed only after the new credentials file succeeds.
    legacy_config = _load_config()
    legacy_token = legacy_config.get("api_token")
    if not isinstance(legacy_token, str) or not legacy_token:
        return ""

    try:
        _save_credentials({"api_token": legacy_token})
    except OSError:
        return legacy_token
    _remove_legacy_api_token(legacy_config)
    return legacy_token


def _save_api_token(api_token: str) -> None:
    token = api_token.strip()
    if not token:
        return

    _save_credentials({"api_token": token})
    _remove_legacy_api_token(_load_config())


def _load_last_enhanced_prompt() -> str:
    data = _load_config()
    prompt = data.get("last_enhanced_prompt")
    return prompt if isinstance(prompt, str) else ""


def _save_last_enhanced_prompt(prompt: str, input_fingerprint: str | None = None) -> None:
    if not prompt:
        return

    data = _load_config()
    data["last_enhanced_prompt"] = prompt
    if input_fingerprint is not None:
        data["last_input_fingerprint"] = input_fingerprint
    _save_config(data)


def _load_last_input_fingerprint() -> str:
    data = _load_config()
    fingerprint = data.get("last_input_fingerprint")
    return fingerprint if isinstance(fingerprint, str) else ""


def _load_recent_models() -> list[str]:
    data = _load_config()
    models = data.get("recent_models")
    if not isinstance(models, list):
        return []

    recent_models: list[str] = []
    for model in models:
        if isinstance(model, str):
            model = model.strip()
            if model and model not in recent_models:
                recent_models.append(model)
        if len(recent_models) >= MAX_RECENT_MODELS:
            break
    return recent_models


def _is_likely_vision_model(model_id: str) -> bool:
    model_id = str(model_id or "").lower()
    return (
        re.search(
            r"\b(vl|vision|visual|multimodal|mm|llava|moondream|minicpm-v|pixtral|internvl)\b",
            model_id,
        )
        is not None
        or "qwen2-vl" in model_id
        or "qwen2.5-vl" in model_id
        or "qwen-vl" in model_id
        or "qwen3.5" in model_id
        or "qwen3.6" in model_id
        or "gemma-3" in model_id
        or "gemma-4" in model_id
    )


def _model_path_parts(model_id: str) -> list[str]:
    return [part.strip() for part in str(model_id or "").replace("\\", "/").split("/") if part.strip()]


def _sanitize_model_label(label: str) -> str:
    return re.sub(r"\s+", " ", str(label or "").replace("/", " ").replace("\\", " ")).strip()


def _looks_like_model_file(name: str) -> bool:
    return re.search(r"\.(gguf|safetensors|bin|pt|pth|onnx|mlx)$", name, re.IGNORECASE) is not None


def _model_display_name(model_id: str) -> str:
    model_id = str(model_id or "").strip()
    parts = _model_path_parts(model_id)
    if not parts:
        return model_id
    if len(parts) == 1:
        return _sanitize_model_label(parts[0])
    if _looks_like_model_file(parts[-1]):
        return _sanitize_model_label(parts[-2])
    return _sanitize_model_label(parts[-1])


def _model_disambiguator(model_id: str) -> str:
    parts = _model_path_parts(model_id)
    if len(parts) < 2:
        return ""
    if _looks_like_model_file(parts[-1]):
        context_parts = parts[:-2] + parts[-1:]
    else:
        context_parts = parts[:-1]
    return _sanitize_model_label(" ".join(context_parts))


def _model_label_base(model_id: str) -> str:
    model_id = str(model_id or "")
    label = _model_display_name(model_id)
    return f"{label}{VISION_LABEL_SUFFIX}" if _is_likely_vision_model(model_id) else label


def _model_label_with_context(model_id: str) -> str:
    model_id = str(model_id or "")
    label = _model_display_name(model_id)
    context = _model_disambiguator(model_id)
    if context:
        label = f"{label} ({context})"
    return f"{label}{VISION_LABEL_SUFFIX}" if _is_likely_vision_model(model_id) else label


def _model_choices_for_values(values: list[str]) -> list[dict[str, str]]:
    base_labels = {value: _model_label_base(value) for value in values}
    duplicate_bases = {
        label
        for label in base_labels.values()
        if list(base_labels.values()).count(label) > 1
    }

    choices: list[dict[str, str]] = []
    used_labels: set[str] = set()
    for index, value in enumerate(values):
        if value == "":
            label = DEFAULT_MODEL_LABEL
        elif base_labels[value] in duplicate_bases:
            label = _model_label_with_context(value)
        else:
            label = base_labels[value]

        unique_label = label
        suffix = 2
        while unique_label in used_labels:
            unique_label = f"{label} ({suffix})"
            suffix += 1
        used_labels.add(unique_label)
        choices.append({"value": value, "label": unique_label})

    return choices


def _model_value_from_label(model: str, server_url: str = "", api_token: str = "") -> str:
    model = str(model or "").strip()
    if model in (DEFAULT_MODEL_LABEL, LEGACY_DEFAULT_MODEL_LABEL):
        return ""

    recent_models = _load_recent_models()
    for choice in _combine_model_choices(recent_models, []):
        if model in (choice["label"], choice["value"]):
            return choice["value"]

    if server_url:
        try:
            for choice in _combine_model_choices(recent_models, _server_models(server_url, api_token)):
                if model in (choice["label"], choice["value"]):
                    return choice["value"]
        except Exception:
            pass

    if model.endswith(VISION_LABEL_SUFFIX):
        return model[: -len(VISION_LABEL_SUFFIX)].strip()
    return model


def _choice(value: str) -> dict[str, str]:
    return _model_choices_for_values([value])[0]


def _combine_model_choices(recent_models: list[str], server_models: list[str]) -> list[dict[str, str]]:
    values = [""]
    seen = {""}

    for model in recent_models + server_models:
        model = str(model or "").strip()
        if not model or model in seen:
            continue
        values.append(model)
        seen.add(model)

    return _model_choices_for_values(values)


def _server_models(server_url: str, api_token: str) -> list[str]:
    data = _get_json(f"{_normalize_server_url(server_url)}/models", api_token, timeout=20)
    models = data.get("data")
    if not isinstance(models, list):
        return []

    model_ids: list[str] = []
    for model in models:
        if isinstance(model, dict):
            model_id = model.get("id")
        else:
            model_id = model
        if isinstance(model_id, str) and model_id.strip() and model_id not in model_ids:
            model_ids.append(model_id.strip())
    return model_ids


def _remember_model(model: str) -> None:
    model = model.strip()
    if not model:
        return

    data = _load_config()
    recent_models = [model]
    for recent_model in _load_recent_models():
        if recent_model != model:
            recent_models.append(recent_model)
        if len(recent_models) >= MAX_RECENT_MODELS:
            break

    data["recent_models"] = recent_models
    _save_config(data)


def _model_choices() -> list[str]:
    return [choice["label"] for choice in _combine_model_choices(_load_recent_models(), [])]


def _default_model_choice() -> str:
    recent_models = _load_recent_models()
    return _combine_model_choices(recent_models[:1], [])[1]["label"] if recent_models else DEFAULT_MODEL_LABEL


def _image_to_pil(image: Any) -> Image.Image:
    if hasattr(image, "detach"):
        image = image.detach().cpu().numpy()

    if hasattr(image, "ndim"):
        if image.ndim == 4:
            image = image[0]
        if (
            image.ndim == 3
            and image.shape[0] in (1, 3, 4)
            and image.shape[-1] not in (1, 3, 4)
        ):
            image = image.transpose(1, 2, 0)
        if image.dtype.kind == "f":
            image = (image.clip(0, 1) * 255).astype("uint8")
        elif image.dtype != "uint8":
            image = image.clip(0, 255).astype("uint8")

    if isinstance(image, Image.Image):
        pil_image = image
    else:
        pil_image = Image.fromarray(image)

    if pil_image.mode not in ("RGB", "RGBA"):
        pil_image = pil_image.convert("RGB")

    width, height = pil_image.size
    longest_side = max(width, height)
    if longest_side > MAX_IMAGE_LONG_SIDE:
        scale = MAX_IMAGE_LONG_SIDE / longest_side
        pil_image = pil_image.resize(
            (round(width * scale), round(height * scale)),
            Image.Resampling.LANCZOS,
        )

    return pil_image


def _image_to_png_bytes(image: Any) -> bytes:
    pil_image = _image_to_pil(image)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return buffer.getvalue()


def _image_to_data_url(image: Any) -> str:
    encoded = base64.b64encode(_image_to_png_bytes(image)).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _build_input_fingerprint(
    system_prompt: str,
    input_prompt: str,
    image: Any | None,
    model: str = "",
) -> str:
    if image is None:
        image_hash = "no-image"
    else:
        image_hash = hashlib.sha256(_image_to_png_bytes(image)).hexdigest()

    payload = {
        "system_prompt": system_prompt,
        "input_prompt": input_prompt,
        "image_sha256": image_hash,
        "model": model,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _build_user_content(input_prompt: str, image: Any | None) -> str | list[dict[str, Any]]:
    if image is None:
        return input_prompt

    return [
        {"type": "text", "text": input_prompt},
        {"type": "image_url", "image_url": {"url": _image_to_data_url(image)}},
    ]


def _load_lmstudio_model(base_url: str, model: str, api_token: str) -> str:
    data = _post_json(
        f"{_native_api_base_url(base_url)}/models/load",
        {"model": model, "echo_load_config": False},
        api_token,
        timeout=600,
    )
    instance_id = data.get("instance_id")
    return instance_id if isinstance(instance_id, str) and instance_id.strip() else model


def _unload_lmstudio_model(base_url: str, instance_id: str, api_token: str) -> None:
    _post_json(
        f"{_native_api_base_url(base_url)}/models/unload",
        {"instance_id": instance_id},
        api_token,
        timeout=120,
    )


def _loaded_lmstudio_instance_ids(base_url: str, model: str, api_token: str) -> list[str]:
    data = _get_json(f"{_native_api_base_url(base_url)}/models", api_token)
    models = data.get("models")
    if not isinstance(models, list):
        return []

    instance_ids: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "llm":
            continue
        model_key = item.get("key")
        loaded_instances = item.get("loaded_instances")
        if not isinstance(loaded_instances, list):
            continue

        for instance in loaded_instances:
            if not isinstance(instance, dict):
                continue
            instance_id = instance.get("id")
            if not isinstance(instance_id, str) or not instance_id.strip():
                continue
            if not model or model in (model_key, instance_id):
                instance_ids.append(instance_id)

    return instance_ids


def _unload_lmstudio_models(base_url: str, model: str, api_token: str) -> None:
    instance_ids = _loaded_lmstudio_instance_ids(base_url, model, api_token)
    if not instance_ids and model:
        instance_ids = [model]

    for instance_id in instance_ids:
        _unload_lmstudio_model(base_url, instance_id, api_token)


def _unload_comfy_models() -> None:
    try:
        import comfy.model_management as model_management
    except Exception as exc:
        raise RuntimeError(
            "Could not import ComfyUI model management; cannot unload ComfyUI "
            "models before the LLM run."
        ) from exc

    unload_all_models = getattr(model_management, "unload_all_models", None)
    soft_empty_cache = getattr(model_management, "soft_empty_cache", None)
    if not callable(unload_all_models) or not callable(soft_empty_cache):
        raise RuntimeError(
            "ComfyUI model management API does not provide unload_all_models() "
            "and soft_empty_cache()."
        )

    unload_all_models()
    gc.collect()
    soft_empty_cache()


def _send_prompt_update(node_id: Any, prompt: str) -> None:
    if node_id is None or not prompt:
        return

    try:
        from server import PromptServer
    except Exception:
        return

    PromptServer.instance.send_sync(
        PROMPT_UPDATE_EVENT,
        {
            "node_id": str(node_id),
            "prompt": prompt,
        },
    )


class A5lmstudio_prompt_enhancer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "system_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_SYSTEM_PROMPT,
                        "multiline": True,
                    },
                ),
                "input_prompt": (
                    "STRING",
                    {
                        "default": "A cinematic portrait of a fox in a rainy neon city",
                        "multiline": True,
                    },
                ),
                "run_mode": (
                    RUN_MODE_CHOICES,
                    {
                        "default": RUN_MODE_AUTO,
                    },
                ),
                "unload_comfy_models_before_llm_run": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Unload ComfyUI models from VRAM before a real LLM request. Bypass modes skip this.",
                    },
                ),
                "last_generated_prompt": (
                    "STRING",
                    {
                        "default": _load_last_enhanced_prompt(),
                        "multiline": True,
                        "tooltip": "Prompt returned by bypass modes; normal LLM runs overwrite it.",
                    },
                ),
                "model": (
                    _model_choices(),
                    {
                        "default": _default_model_choice(),
                        "tooltip": "Recent models listed first - For loading of models, except Loaded Default, LMStudio requires authentication with API token",
                    },
                ),
                "load_model_before_generation": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Load the selected LM Studio model before generation. Requires API token. Ignored when Use loaded default model is selected.",
                    },
                ),
                "unload_model_after_generation": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Unload the selected LM Studio model after generation. Requires API token. Ignored when Use loaded default model is selected.",
                    },
                ),
                "server_url": (
                    "STRING",
                    {
                        "default": DEFAULT_SERVER_URL,
                        "multiline": False,
                    },
                ),
                "api_token": (
                    "STRING",
                    {
                        "default": MASKED_API_TOKEN if _load_saved_api_token() else "",
                        "multiline": False,
                        "password": True,
                        "tooltip": "Only needed when LMStudio/Server is set to require it",
                    },
                ),
                "max_tokens": (
                    "INT",
                    {
                        "default": DEFAULT_MAX_TOKENS,
                        "min": 1,
                        "max": 32768,
                        "step": 1,
                        "tooltip": "Set higher for thinking models -thinking is cut but still counts",
                    },
                ),
            },
            "optional": {
                "image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("enhanced_prompt",)
    FUNCTION = "enhance_prompt"
    CATEGORY = "utils/LM Studio"
    DESCRIPTION = "Enhance text prompts through a local LM Studio OpenAI-compatible server."

    @classmethod
    def VALIDATE_INPUTS(cls, model: str = ""):
        return True

    def enhance_prompt(
        self,
        system_prompt: str,
        input_prompt: str,
        run_mode: str = RUN_MODE_AUTO,
        unload_comfy_models_before_llm_run: bool = True,
        last_generated_prompt: str = "",
        model: str = "",
        load_model_before_generation: bool = True,
        unload_model_after_generation: bool = True,
        server_url: str = DEFAULT_SERVER_URL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        api_token: str = "",
        image: Any | None = None,
        unique_id: Any | None = None,
    ):
        manual_prompt = last_generated_prompt.strip()
        cached_prompt = _load_last_enhanced_prompt()

        if run_mode == RUN_MODE_BYPASS:
            result = manual_prompt or cached_prompt or input_prompt
            _save_last_enhanced_prompt(result)
            return (result,)

        base_url = _normalize_server_url(server_url)
        api_token = api_token.strip()
        if api_token and api_token != MASKED_API_TOKEN:
            _save_api_token(api_token)
        else:
            api_token = _load_saved_api_token()

        model = _model_value_from_label(model, base_url, api_token)

        input_fingerprint = _build_input_fingerprint(
            system_prompt,
            input_prompt,
            image,
            model,
        )
        if run_mode == RUN_MODE_AUTO and input_fingerprint == _load_last_input_fingerprint():
            result = manual_prompt or cached_prompt
            if result:
                _save_last_enhanced_prompt(result, input_fingerprint)
                return (result,)

        if model:
            _remember_model(model)

        if unload_comfy_models_before_llm_run:
            _unload_comfy_models()

        loaded_instance_id = ""
        model_for_request = model
        if load_model_before_generation and model:
            loaded_instance_id = _load_lmstudio_model(base_url, model, api_token)
            model_for_request = loaded_instance_id

        payload: dict[str, Any] = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": _build_user_content(input_prompt, image)},
            ],
            "max_tokens": max_tokens,
            "stream": False,
        }
        if model_for_request:
            payload["model"] = model_for_request

        unload_target = loaded_instance_id or model
        chat_error: Exception | None = None
        try:
            data = _post_json(
                f"{base_url}/chat/completions",
                payload,
                api_token,
                timeout=CHAT_COMPLETION_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            chat_error = exc
            raise
        finally:
            if unload_model_after_generation and unload_target:
                try:
                    _unload_lmstudio_models(base_url, unload_target, api_token)
                except Exception as exc:
                    if chat_error is None:
                        raise RuntimeError(
                            "LM Studio generated a response, but failed to unload "
                            f"{unload_target}: {exc}"
                        ) from exc

        result = _strip_thinking_blocks(_extract_message_content(data))
        _save_last_enhanced_prompt(result, input_fingerprint)
        _send_prompt_update(unique_id, result)
        return (result,)


NODE_CLASS_MAPPINGS = {
    "A5lmstudio_prompt_enhancer": A5lmstudio_prompt_enhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "A5lmstudio_prompt_enhancer": "A5lmstudio_prompt_enhancer",
}


def _register_api_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.post("/a5lmstudio_prompt_enhancer/api_token")
    async def save_api_token(request):
        data = await request.json()
        api_token = data.get("api_token")
        if not isinstance(api_token, str):
            return web.json_response({"ok": False}, status=400)

        api_token = api_token.strip()
        if not api_token or api_token == MASKED_API_TOKEN:
            return web.json_response({"ok": False}, status=400)

        _save_api_token(api_token)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/a5lmstudio_prompt_enhancer/config")
    async def get_config(request):
        recent_models = _load_recent_models()
        choices = _combine_model_choices(recent_models, [])
        return web.json_response(
            {
                "has_api_token": bool(_load_saved_api_token()),
                "api_token_placeholder": MASKED_API_TOKEN,
                "recent_models": recent_models,
                "default_model": recent_models[0] if recent_models else "",
                "default_model_label": _default_model_choice(),
                "model_choices": choices,
                "last_generated_prompt": _load_last_enhanced_prompt(),
            }
        )

    @PromptServer.instance.routes.post("/a5lmstudio_prompt_enhancer/abort")
    async def abort_lmstudio(request):
        try:
            data = await request.json()
        except Exception:
            data = {}

        server_url = data.get("server_url")
        if not isinstance(server_url, str) or not server_url.strip():
            server_url = DEFAULT_SERVER_URL

        try:
            await asyncio.to_thread(
                _unload_lmstudio_models,
                server_url,
                "",
                _load_saved_api_token(),
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)},
                status=500,
            )

        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/a5lmstudio_prompt_enhancer/models")
    async def get_models(request):
        server_url = request.query.get("server_url") or DEFAULT_SERVER_URL
        recent_models = _load_recent_models()
        server_models: list[str] = []
        error_message = ""

        try:
            server_models = _server_models(server_url, _load_saved_api_token())
        except Exception as exc:
            error_message = str(exc)

        choices = _combine_model_choices(recent_models, server_models)
        return web.json_response(
            {
                "choices": choices,
                "recent_models": recent_models,
                "server_models": server_models,
                "default_model": recent_models[0] if recent_models else "",
                "default_model_label": _default_model_choice(),
                "error": error_message,
            }
        )


try:
    _register_api_routes()
except Exception:
    pass
