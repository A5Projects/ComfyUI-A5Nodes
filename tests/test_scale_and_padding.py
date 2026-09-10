import sys
import types
import unittest
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
        output, width, height, size_text = self.execute()
        self.assertEqual(tuple(output.shape), (2, 4, 8, 3))
        self.assertEqual((width, height, size_text), (8, 4, "8x4"))
        self.assertTrue(torch.allclose(output[:, :, :4, 0], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(output[:, :, 4:, :], torch.zeros((2, 4, 4, 3))))

    def test_padding_placement_and_color(self):
        left, _, _, _ = self.execute(
            padding_side="left / top",
            padding_color="#00ff00",
        )
        self.assertTrue(torch.allclose(left[:, :, :4, 1], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(left[:, :, 4:, 0], torch.ones((2, 4, 4))))

        center, _, _, _ = self.execute(padding_side="center")
        self.assertTrue(torch.allclose(center[:, :, :2, :], torch.zeros((2, 4, 2, 3))))
        self.assertTrue(torch.allclose(center[:, :, 2:6, 0], torch.ones((2, 4, 4))))
        self.assertTrue(torch.allclose(center[:, :, 6:, :], torch.zeros((2, 4, 2, 3))))

    def test_stretch_img_and_legacy_stretch_resize_directly(self):
        for handling in ("stretch img", "stretch"):
            with self.subTest(handling=handling):
                output, width, height, _ = self.execute(aspect_handling=handling)
                self.assertEqual((width, height), (8, 4))
                self.assertTrue(torch.allclose(output[..., 0], torch.ones((2, 4, 8))))

    def test_selected_ratio_activates_padding_without_override(self):
        output, width, height, _ = self.execute(
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


if __name__ == "__main__":
    unittest.main()
