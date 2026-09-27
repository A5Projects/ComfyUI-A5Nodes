import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

import torch
import torch.nn.functional as F

try:
    import comfy.utils  # noqa: F401
except ModuleNotFoundError:
    comfy_module = types.ModuleType("comfy")
    comfy_utils_module = types.ModuleType("comfy.utils")

    def _lanczos(samples, width, height):
        return F.interpolate(samples, size=(height, width), mode="bicubic", align_corners=False)

    comfy_utils_module.lanczos = _lanczos
    comfy_module.utils = comfy_utils_module
    sys.modules["comfy"] = comfy_module
    sys.modules["comfy.utils"] = comfy_utils_module

# CPU-only substitutes for ComfyUI's latent allocation helpers.
if "comfy.model_management" not in sys.modules:
    management = types.ModuleType("comfy.model_management")
    sys.modules["comfy.model_management"] = management
    sys.modules["comfy"].model_management = management
management = sys.modules["comfy.model_management"]
if not hasattr(management, "intermediate_device"):
    management.intermediate_device = lambda: torch.device("cpu")
if not hasattr(management, "intermediate_dtype"):
    management.intermediate_dtype = lambda: torch.float32

import A5scale_to_total_pixels_safe as package
from A5only_scale_to_total_pixels.scale_core import (
    resolve_dimensions as resolve_only_scale_dimensions,
)
from A5scale_to_total_pixels_safe.pad_scale_to_total_pixels import (
    A5PadScaleToTotalPixels,
)
from A5scale_to_total_pixels_safe.scale_core import (
    ASPECT_RATIOS,
    common_required_inputs,
    resolve_dimensions,
    preset_dimensions_for_total,
)


class ResolutionTests(unittest.TestCase):
    def resolve(self, **overrides):
        values = {
            "source_width": 800,
            "source_height": 600,
            "target_total_pixels": 786432,
            "dimension_rule": "mul16",
            "aspect_ratio": "disabled",
            "scale_policy": "both",
            "width_override": 0,
            "height_override": 0,
            "keep_aspect": True,
        }
        values.update(overrides)
        return resolve_dimensions(**values)

    def test_automatic_source_ratio_matches_only_scale_node(self):
        for rule in ("mul16", "mul32"):
            expected = resolve_only_scale_dimensions(
                800,
                600,
                786432,
                rule,
                "both",
                0,
                0,
                True,
            )
            actual = self.resolve(dimension_rule=rule)
            self.assertEqual(actual, expected)

    def test_all_presets_obey_automatic_dimension_rules(self):
        for label, ratio_parts in ASPECT_RATIOS.items():
            expected_ratio = ratio_parts[0] / ratio_parts[1]
            for rule, multiple in (("any", 2), ("mul16", 16), ("mul32", 32)):
                with self.subTest(label=label, rule=rule):
                    width, height, manual = self.resolve(
                        aspect_ratio=label,
                        dimension_rule=rule,
                    )
                    self.assertFalse(manual)
                    self.assertEqual(width % multiple, 0)
                    self.assertEqual(height % multiple, 0)
                    self.assertLess(abs(width / height - expected_ratio), 0.05)

    def test_scale_policy_still_applies_to_automatic_preset(self):
        source_total = 800 * 600
        width, height, manual = self.resolve(
            target_total_pixels=2_000_000,
            aspect_ratio="16:9 (Widescreen)",
            scale_policy="only_downscale",
        )
        self.assertFalse(manual)
        self.assertLess(abs(width * height - source_total), 25_000)

    def test_single_width_override_and_preset_ignore_multiplier(self):
        width, height, manual = self.resolve(
            width_override=1025,
            aspect_ratio="16:9 (Widescreen)",
            dimension_rule="mul32",
        )
        self.assertTrue(manual)
        self.assertEqual((width, height), (1026, 578))

    def test_single_height_override_and_preset_ignore_multiplier(self):
        width, height, manual = self.resolve(
            height_override=577,
            aspect_ratio="16:9 (Widescreen)",
            dimension_rule="mul32",
        )
        self.assertTrue(manual)
        self.assertEqual((width, height), (1028, 578))

    def test_single_override_uses_input_aspect_or_input_size(self):
        self.assertEqual(
            self.resolve(width_override=1025, keep_aspect=True)[:2],
            (1026, 770),
        )
        self.assertEqual(
            self.resolve(
                source_height=601,
                width_override=1025,
                keep_aspect=False,
            )[:2],
            (1026, 602),
        )

    def test_both_overrides_define_even_canvas(self):
        width, height, manual = self.resolve(
            width_override=1025,
            height_override=641,
            aspect_ratio="1:1 (Square)",
            keep_aspect=True,
            dimension_rule="mul32",
        )
        self.assertTrue(manual)
        self.assertEqual((width, height), (1026, 642))

    def test_interface_order_defaults_and_tooltips(self):
        inputs = common_required_inputs()
        self.assertEqual(
            list(inputs),
            [
                "image",
                "target_total_pixels",
                "dimension_rule",
                "aspect_ratio",
                "scale_policy",
                "upscale_method",
                "width_override",
                "height_override",
                "keep_aspect",
            ],
        )
        self.assertEqual(inputs["aspect_ratio"][1]["default"], "disabled")
        self.assertEqual(inputs["dimension_rule"][1]["default"], "Multi16")
        self.assertIn("1000000=1 Megapixel", inputs["target_total_pixels"][1]["tooltip"])
        self.assertIn("odd values round up", inputs["width_override"][1]["tooltip"])


class PaddingTests(unittest.TestCase):
    def setUp(self):
        self.node = A5PadScaleToTotalPixels()
        self.image = torch.zeros((2, 2, 2, 3), dtype=torch.float32)
        self.image[..., 0] = 1.0

    def execute(self, **overrides):
        values = {
            "image": self.image,
            "target_total_pixels": 786432,
            "dimension_rule": "mul32",
            "aspect_ratio": "disabled",
            "scale_policy": "both",
            "upscale_method": "bilinear",
            "width_override": 7,
            "height_override": 3,
            "keep_aspect": "on",
            "aspect_handling": "padding",
            "padding_side": "right / bottom",
            "padding_color": "#000000",
        }
        values.update(overrides)
        return self.node.execute(**values)["result"]

    def test_both_overrides_activate_padding_and_preserve_batch(self):
        output, width, height, size_text, latent = self.execute()
        self.assertEqual(tuple(output.shape), (2, 4, 8, 3))
        self.assertEqual((width, height, size_text), (8, 4, "8x4"))
        self.assertEqual(tuple(latent["samples"].shape), (2, 4, 1, 1))
        self.assertEqual(torch.count_nonzero(latent["samples"]).item(), 0)
        self.assertTrue(torch.allclose(output[:, :, :4, 0], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(output[:, :, 4:, :], torch.zeros((2, 4, 4, 3))))

    def test_padding_placement_and_color(self):
        left, _, _, _, _ = self.execute(
            padding_side="left / top",
            padding_color="#00ff00",
        )
        self.assertTrue(torch.allclose(left[:, :, :4, 1], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(left[:, :, 4:, 0], torch.ones((2, 4, 4))))

        center, _, _, _, _ = self.execute(padding_side="center")
        self.assertTrue(torch.allclose(center[:, :, :2, :], torch.zeros((2, 4, 2, 3))))
        self.assertTrue(torch.allclose(center[:, :, 2:6, 0], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(center[:, :, 6:, :], torch.zeros((2, 4, 2, 3))))

    def test_stretch_img_and_legacy_stretch_resize_directly(self):
        for handling in ("stretch img", "stretch"):
            with self.subTest(handling=handling):
                output, width, height, _, _ = self.execute(aspect_handling=handling)
                self.assertEqual((width, height), (8, 4))
                self.assertTrue(torch.allclose(output[..., 0], torch.ones((2, 4, 8))))

    def test_selected_ratio_activates_padding_without_override(self):
        output, width, height, _, _ = self.execute(
            target_total_pixels=4096,
            dimension_rule="mul16",
            aspect_ratio="16:9 (Widescreen)",
            width_override=0,
            height_override=0,
            padding_color="#0000ff",
        )
        self.assertEqual(width % 16, 0)
        self.assertEqual(height % 16, 0)
        self.assertEqual(tuple(output.shape), (2, height, width, 3))
        self.assertGreater(output[..., 2].sum().item(), 0)


class BlankCanvasTests(unittest.TestCase):
    def execute(self, **overrides):
        values = {
            "target_total_pixels": 4096,
            "dimension_rule": "Multi16",
            "aspect_ratio": "disabled",
            "scale_policy": "both",
            "upscale_method": "bilinear",
            "width_override": 0,
            "height_override": 0,
            "keep_aspect": "on",
            "aspect_handling": "padding",
            "padding_side": "right / bottom",
            "padding_color": "#808080",
        }
        values.update(overrides)
        return A5PadScaleToTotalPixels().execute(**values)

    def test_all_presets_rules_and_policies_without_image(self):
        for preset, (rw, rh) in ASPECT_RATIOS.items():
            for rule, multiple in (("any", 2), ("even", 2), ("Multi4", 4),
                                   ("Multi8", 8), ("Multi16", 16), ("Multi32", 32)):
                for policy in ("both", "only_downscale", "only_upscale", "none"):
                    with self.subTest(preset=preset, rule=rule, policy=policy):
                        response = self.execute(aspect_ratio=preset,
                                                dimension_rule=rule, scale_policy=policy)
                        image, width, height, text, latent = response["result"]
                        self.assertEqual((width, height),
                                         preset_dimensions_for_total(rw / rh, 4096, rule))
                        self.assertEqual(width % multiple, 0)
                        self.assertEqual(height % multiple, 0)
                        self.assertEqual(tuple(image.shape), (1, height, width, 3))
                        self.assertEqual(text, f"{width}x{height}")
                        self.assertEqual(response["ui"]["blank_image"], [True])
                        self.assertEqual(latent["downscale_ratio_spacial"], 8)

    def test_single_overrides_normalize_before_deriving(self):
        cases = [
            ({"width_override": 1025, "aspect_ratio": "16:9 (Widescreen)"}, (1026, 578)),
            ({"height_override": 577, "aspect_ratio": "16:9 (Widescreen)"}, (1028, 578)),
            ({"width_override": 1024, "aspect_ratio": "1:1 (Square)"}, (1024, 1024)),
            ({"width_override": 1025, "target_total_pixels": 786432}, (1026, 768)),
            ({"height_override": 1025, "target_total_pixels": 786432}, (768, 1026)),
            ({"width_override": 64}, (64, 64)),
            ({"height_override": 64}, (64, 64)),
        ]
        for settings, expected in cases:
            for keep in ("on", "off"):
                with self.subTest(settings=settings, keep=keep):
                    result = self.execute(**settings, keep_aspect=keep,
                                          dimension_rule="Multi32")["result"]
                    self.assertEqual(result[1:3], expected)

    def test_dual_overrides_bypass_preset_and_automatics(self):
        for preset in ("disabled", "21:9 (Ultrawide)"):
            result = self.execute(width_override=1025, height_override=577,
                                  aspect_ratio=preset, dimension_rule="Multi32",
                                  scale_policy="none")["result"]
            self.assertEqual(result[1:3], (1026, 578))

    def test_blank_colors_ignore_stretch_and_placement(self):
        for color, rgb in (("#808080", (128, 128, 128)), ("#00ff00", (0, 255, 0)),
                           ("#0000ffff", (0, 0, 255)), ("#ffffff", (255, 255, 255)),
                           ("#000000", (0, 0, 0))):
            for handling in ("padding", "stretch img"):
                for side in ("right / bottom", "left / top", "center"):
                    image = self.execute(width_override=7, height_override=3,
                                         padding_color=color, aspect_handling=handling,
                                         padding_side=side)["result"][0]
                    expected = torch.tensor(rgb, dtype=torch.float32) / 255
                    self.assertEqual(tuple(image.shape), (1, 4, 8, 3))
                    self.assertTrue(torch.allclose(image, expected.expand_as(image)))

    def test_missing_dimensions_and_invalid_color_are_clear_errors(self):
        with self.assertRaisesRegex(ValueError, "No input image: select an aspect ratio"):
            self.execute()
        with self.assertRaisesRegex(ValueError, "padding_color must be"):
            self.execute(aspect_ratio="1:1 (Square)", padding_color="invalid")

    def test_none_and_omitted_image_are_equivalent(self):
        omitted = self.execute(width_override=64)
        explicit = self.execute(image=None, width_override=64)
        self.assertTrue(torch.equal(omitted["result"][0], explicit["result"][0]))
        self.assertEqual(omitted["ui"], explicit["ui"])

    def test_latent_rounding_metadata_and_intermediate_dtype(self):
        with patch("comfy.model_management.intermediate_device", return_value=torch.device("cpu")), \
             patch("comfy.model_management.intermediate_dtype", return_value=torch.float16):
            response = self.execute(width_override=1025, height_override=577)
        image, width, height, text, latent = response["result"]
        self.assertEqual((width, height, text), (1026, 578, "1026x578"))
        self.assertEqual(tuple(image.shape), (1, 578, 1026, 3))
        self.assertEqual(tuple(latent["samples"].shape), (1, 4, 73, 129))
        self.assertEqual(latent["samples"].dtype, torch.float16)
        self.assertEqual(latent["samples"].device.type, "cpu")
        self.assertEqual(torch.count_nonzero(latent["samples"]).item(), 0)
        self.assertEqual(response["ui"]["latent_width"], [1032])
        self.assertEqual(response["ui"]["latent_height"], [584])

    def test_small_canvas_still_has_nonzero_latent_grid(self):
        result = self.execute(width_override=1, height_override=1)["result"]
        self.assertEqual(result[1:3], (2, 2))
        self.assertEqual(tuple(result[4]["samples"].shape), (1, 4, 1, 1))

    def test_image_batch_and_feedback(self):
        image = torch.rand((3, 8, 8, 3))
        response = self.execute(image=image, width_override=8, height_override=8)
        self.assertTrue(torch.equal(response["result"][0], image))
        self.assertEqual(tuple(response["result"][4]["samples"].shape), (3, 4, 1, 1))
        self.assertEqual(response["ui"]["blank_image"], [False])

    def test_optional_input_and_append_only_output_schema(self):
        node_class = package.NODE_CLASS_MAPPINGS["A5scale_to_total_pixels_safe"]
        schema = node_class.INPUT_TYPES()
        self.assertNotIn("image", schema["required"])
        self.assertEqual(schema["optional"]["image"][0], "IMAGE")
        self.assertEqual(node_class.RETURN_TYPES, ("IMAGE", "INT", "INT", "STRING", "LATENT"))
        self.assertEqual(node_class.RETURN_NAMES, ("image", "width", "height", "size_text", "latent"))
        self.assertEqual(list(schema["required"]), [
            "target_total_pixels", "dimension_rule", "aspect_ratio", "scale_policy",
            "upscale_method", "width_override", "height_override", "keep_aspect",
            "aspect_handling", "padding_side", "padding_color",
        ])


if __name__ == "__main__":
    unittest.main()
