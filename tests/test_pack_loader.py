import importlib.util
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


PACK_ROOT = Path(__file__).resolve().parents[1]


def _install_import_stubs() -> None:
    if "comfy" not in sys.modules:
        comfy_module = types.ModuleType("comfy")
        sys.modules["comfy"] = comfy_module
    else:
        comfy_module = sys.modules["comfy"]

    if "comfy.utils" not in sys.modules:
        comfy_utils_module = types.ModuleType("comfy.utils")
        comfy_module.utils = comfy_utils_module
        sys.modules["comfy.utils"] = comfy_utils_module

    if "comfy.model_management" not in sys.modules:
        comfy_model_management_module = types.ModuleType("comfy.model_management")
        comfy_module.model_management = comfy_model_management_module
        sys.modules["comfy.model_management"] = comfy_model_management_module

    if "comfy_api.latest" not in sys.modules:
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


class PackLoaderTests(unittest.TestCase):
    def test_pack_exports_all_nine_node_ids(self):
        _install_import_stubs()
        package_name = "a5_pack_loader_test"
        spec = importlib.util.spec_from_file_location(
            package_name,
            PACK_ROOT / "__init__.py",
            submodule_search_locations=[str(PACK_ROOT)],
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[package_name] = module
        spec.loader.exec_module(module)

        self.assertEqual(
            set(module.NODE_CLASS_MAPPINGS),
            {
                "A5ClipPromptEnhancer",
                "A5lmstudio_prompt_enhancer",
                "A5TextPrompt",
                "A5PromptDatabase",
                "A5NoteDatabase",
                "A5Universal_latent_presets",
                "A5scale_to_total_pixels_safe",
                "A5Pad_Image_for_Outpaint",
                "A5only_scale_to_total_pixels",
            },
        )
        self.assertEqual(module.WEB_DIRECTORY, "./web")


if __name__ == "__main__":
    unittest.main()
