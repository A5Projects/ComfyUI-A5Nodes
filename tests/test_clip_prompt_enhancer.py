from __future__ import annotations

import tempfile
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


try:
    import comfy_api.latest  # noqa: F401
except ModuleNotFoundError:
    class _ComfyNode:
        hidden = None

    class _ComfyExtension:
        pass

    class _NodeOutput:
        def __init__(self, *values, **_kwargs):
            self.result = values

    comfy_api_module = types.ModuleType("comfy_api")
    comfy_api_latest_module = types.ModuleType("comfy_api.latest")
    comfy_api_latest_module.ComfyExtension = _ComfyExtension
    comfy_api_latest_module.io = SimpleNamespace(
        ComfyNode=_ComfyNode,
        NodeOutput=_NodeOutput,
    )
    comfy_api_module.latest = comfy_api_latest_module
    sys.modules["comfy_api"] = comfy_api_module
    sys.modules["comfy_api.latest"] = comfy_api_latest_module

from comfyui_A5clip_prompt_enhancer import clip_prompt_enhancer as enhancer


def make_graph(*, model_name: str = "qwen3.5", with_image: bool = False):
    inputs = {"clip": ["clip_loader", 0]}
    graph = {
        "enhancer": {
            "class_type": "A5ClipPromptEnhancer",
            "inputs": inputs,
        },
        "clip_loader": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": model_name, "type": "qwen_image"},
        },
    }
    if with_image:
        inputs["image"] = ["image_loader", 0]
        graph["image_loader"] = {
            "class_type": "LoadImage",
            "inputs": {"image": "reference.png"},
        }
    return graph


def lazy_kwargs(**overrides):
    values = {
        "clip": None,
        "image": None,
        "system_prompt": "Enhance it",
        "input_prompt": "A city at night",
        "run_mode": enhancer.RUN_MODE_AUTO,
        "unload_clip_after_generation": False,
        "last_generated_prompt": "cached result",
        "max_length": 512,
        "sampling_mode": {"sampling_mode": "off"},
        "thinking": False,
        "use_default_template": True,
    }
    values.update(overrides)
    return values


def execute_kwargs(**overrides):
    values = lazy_kwargs(**overrides)
    return values


class StubClip:
    def __init__(self):
        self.calls = []
        self.patcher = object()
        self.cond_stage_model = SimpleNamespace(generate=lambda: None)

    def tokenize(self, prompt, **kwargs):
        self.calls.append(("tokenize", prompt, kwargs))
        return [1, 2, 3]

    def generate(self, tokens, **kwargs):
        self.calls.append(("generate", tokens, kwargs))
        return [4, 5, 6]

    def decode(self, token_ids):
        self.calls.append(("decode", token_ids))
        return "<think>hidden</think>Improved prompt"


class ClipPromptEnhancerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_config_path = enhancer.CONFIG_PATH
        enhancer.CONFIG_PATH = Path(self.temp_dir.name) / "config.json"
        enhancer.A5ClipPromptEnhancer.hidden = SimpleNamespace(
            unique_id="enhancer",
            prompt=make_graph(),
            dynprompt=None,
        )

    def tearDown(self):
        enhancer.CONFIG_PATH = self.old_config_path
        enhancer.A5ClipPromptEnhancer.hidden = None
        self.temp_dir.cleanup()

    def test_manual_bypass_requests_no_lazy_inputs(self):
        needed = enhancer.A5ClipPromptEnhancer.check_lazy_status(
            **lazy_kwargs(run_mode=enhancer.RUN_MODE_BYPASS),
        )
        self.assertEqual(needed, [])

        with mock.patch.object(enhancer, "_unload_clip_from_vram") as unload:
            output = enhancer.A5ClipPromptEnhancer.execute(
                **execute_kwargs(
                    run_mode=enhancer.RUN_MODE_BYPASS,
                    unload_clip_after_generation=True,
                    last_generated_prompt="manual prompt",
                ),
            )
        self.assertEqual(output.result, ("manual prompt",))
        unload.assert_not_called()

    def test_always_run_requests_connected_lazy_inputs(self):
        enhancer.A5ClipPromptEnhancer.hidden.prompt = make_graph(with_image=True)
        needed = enhancer.A5ClipPromptEnhancer.check_lazy_status(
            **lazy_kwargs(run_mode=enhancer.RUN_MODE_ALWAYS),
        )
        self.assertEqual(needed, ["image", "clip"])

    def test_auto_cache_hit_does_not_request_clip(self):
        clip_fingerprint = enhancer._clip_source_fingerprint(
            enhancer.A5ClipPromptEnhancer.hidden,
        )
        input_fingerprint = enhancer._build_input_fingerprint(
            "Enhance it",
            "A city at night",
            None,
            clip_fingerprint,
        )
        enhancer._save_last_enhanced_prompt("cached result", input_fingerprint)

        needed = enhancer.A5ClipPromptEnhancer.check_lazy_status(**lazy_kwargs())
        self.assertEqual(needed, [])
        output = enhancer.A5ClipPromptEnhancer.execute(**execute_kwargs())
        self.assertEqual(output.result, ("cached result",))

    def test_upstream_clip_change_invalidates_auto_cache(self):
        clip_fingerprint = enhancer._clip_source_fingerprint(
            enhancer.A5ClipPromptEnhancer.hidden,
        )
        input_fingerprint = enhancer._build_input_fingerprint(
            "Enhance it",
            "A city at night",
            None,
            clip_fingerprint,
        )
        enhancer._save_last_enhanced_prompt("cached result", input_fingerprint)
        enhancer.A5ClipPromptEnhancer.hidden.prompt = make_graph(model_name="gemma4")

        needed = enhancer.A5ClipPromptEnhancer.check_lazy_status(**lazy_kwargs())
        self.assertEqual(needed, ["clip"])

    def test_image_is_evaluated_before_auto_cache_decision(self):
        enhancer.A5ClipPromptEnhancer.hidden.prompt = make_graph(with_image=True)
        needed = enhancer.A5ClipPromptEnhancer.check_lazy_status(**lazy_kwargs())
        self.assertEqual(needed, ["image"])

    def test_real_generation_can_unload_only_after_generation(self):
        clip = StubClip()
        with (
            mock.patch.object(enhancer, "_unload_clip_from_vram") as unload,
            mock.patch.object(enhancer, "_send_prompt_update"),
        ):
            output = enhancer.A5ClipPromptEnhancer.execute(
                **execute_kwargs(
                    clip=clip,
                    run_mode=enhancer.RUN_MODE_ALWAYS,
                    unload_clip_after_generation=True,
                ),
            )

        self.assertEqual(output.result, ("Improved prompt",))
        self.assertEqual([call[0] for call in clip.calls], ["tokenize", "generate", "decode"])
        unload.assert_called_once_with(clip)

    def test_selective_unload_leaves_other_models_loaded(self):
        target_patcher = object()
        other_patcher = object()
        target = SimpleNamespace(model=target_patcher, model_unload=mock.Mock(return_value=True))
        other = SimpleNamespace(model=other_patcher, model_unload=mock.Mock(return_value=True))
        clip = SimpleNamespace(patcher=target_patcher)

        loaded_models = [other, target]
        model_management = types.ModuleType("comfy.model_management")
        model_management.current_loaded_models = loaded_models
        model_management.soft_empty_cache = mock.Mock()
        with mock.patch.dict(sys.modules, {"comfy.model_management": model_management}):
            enhancer._unload_clip_from_vram(clip)

        self.assertEqual(loaded_models, [other])
        target.model_unload.assert_called_once_with()
        other.model_unload.assert_not_called()
        model_management.soft_empty_cache.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
