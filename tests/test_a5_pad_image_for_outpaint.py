import sys
import unittest
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

import torch

from A5Pad_Image_for_Outpaint.a5_pad_image_for_outpaint import (
    A5PadImageForOutpaint,
    ASPECT_RATIOS,
    aspect_padding,
)


class A5PadImageForOutpaintTests(unittest.TestCase):
    def setUp(self):
        self.node = A5PadImageForOutpaint()

    def pad(self, image, **overrides):
        values = {
            "left": 0,
            "top": 0,
            "right": 0,
            "bottom": 0,
            "feathering": 0,
            "feather_mode": "fade img to color",
            "padding_color": "#808080",
            "aspect_ratio": "disabled",
            "image_placement": "center",
        }
        values.update(overrides)
        return self.node.pad_image(image, **values)["result"]

    def test_registration_and_defaults(self):
        inputs = self.node.INPUT_TYPES()["required"]
        self.assertEqual(list(inputs), [
            "image", "left", "top", "right", "bottom", "feathering",
            "feather_mode", "padding_color", "aspect_ratio", "image_placement",
        ])
        self.assertEqual(inputs["aspect_ratio"][1]["default"], "disabled")
        self.assertEqual(inputs["image_placement"][1]["default"], "center")
        self.assertEqual(inputs["feather_mode"][1]["default"], "fade img to color")
        self.assertEqual(self.node.RETURN_TYPES, ("IMAGE", "MASK", "INT", "INT"))

    def test_pixel_padding_uses_selected_color_and_batch_mask(self):
        image = torch.zeros((2, 3, 4, 3), dtype=torch.float32)
        padded, mask, width, height = self.pad(
            image,
            left=2,
            top=1,
            right=3,
            bottom=4,
            padding_color="#ff0000",
        )
        self.assertEqual(tuple(padded.shape), (2, 8, 9, 3))
        self.assertEqual(tuple(mask.shape), (2, 8, 9))
        self.assertEqual((width, height), (9, 8))
        self.assertTrue(torch.allclose(padded[:, 0, 0], torch.tensor([1.0, 0.0, 0.0])))
        self.assertTrue(torch.allclose(padded[:, 1:4, 2:6], image))
        self.assertTrue(torch.all(mask[:, 1:4, 2:6] == 0))
        self.assertTrue(torch.all(mask[:, 0, :] == 1))

    def test_zero_padding_preserves_image_and_returns_zero_mask(self):
        image = torch.rand((2, 5, 7, 3), dtype=torch.float32)
        padded, mask, width, height = self.pad(image)
        self.assertTrue(torch.equal(padded, image))
        self.assertEqual(tuple(mask.shape), (2, 5, 7))
        self.assertEqual((width, height), (7, 5))
        self.assertTrue(torch.all(mask == 0))

    def test_every_aspect_ratio_contains_the_source_without_resizing(self):
        image = torch.rand((1, 6, 4, 3), dtype=torch.float32)
        for label, (ratio_width, ratio_height) in ASPECT_RATIOS.items():
            with self.subTest(label=label):
                padded, _, _, _ = self.pad(image, aspect_ratio=label)
                source_comparison = image.shape[2] * ratio_height
                target_comparison = image.shape[1] * ratio_width
                if source_comparison < target_comparison:
                    self.assertEqual(padded.shape[1], image.shape[1])
                    self.assertEqual(
                        padded.shape[2],
                        (image.shape[1] * ratio_width + ratio_height - 1) // ratio_height,
                    )
                elif source_comparison > target_comparison:
                    self.assertEqual(padded.shape[2], image.shape[2])
                    self.assertEqual(
                        padded.shape[1],
                        (image.shape[2] * ratio_height + ratio_width - 1) // ratio_width,
                    )
                else:
                    self.assertEqual(tuple(padded.shape[1:3]), tuple(image.shape[1:3]))

    def test_horizontal_placement_and_invalid_axis_fallback(self):
        image = torch.ones((1, 4, 2, 1), dtype=torch.float32)
        left, _, _, _ = self.pad(image, aspect_ratio="16:9 (Widescreen)", image_placement="fit left")
        right, _, _, _ = self.pad(image, aspect_ratio="16:9 (Widescreen)", image_placement="fit right")
        invalid, _, _, _ = self.pad(image, aspect_ratio="16:9 (Widescreen)", image_placement="fit top")
        self.assertTrue(torch.all(left[:, :, :2] == 1))
        self.assertTrue(torch.all(right[:, :, -2:] == 1))
        self.assertTrue(torch.all(invalid[:, :, 3:5] == 1))

    def test_vertical_placement_and_invalid_axis_fallback(self):
        image = torch.ones((1, 2, 4, 1), dtype=torch.float32)
        top, _, _, _ = self.pad(image, aspect_ratio="1:1 (Square)", image_placement="fit top")
        bottom, _, _, _ = self.pad(image, aspect_ratio="1:1 (Square)", image_placement="fit bottom")
        invalid, _, _, _ = self.pad(image, aspect_ratio="1:1 (Square)", image_placement="fit left")
        self.assertTrue(torch.all(top[:, :2, :] == 1))
        self.assertTrue(torch.all(bottom[:, -2:, :] == 1))
        self.assertTrue(torch.all(invalid[:, 1:3, :] == 1))

    def test_manual_padding_is_added_after_aspect_canvas(self):
        image = torch.ones((1, 6, 4, 1), dtype=torch.float32)
        padded, mask, _, _ = self.pad(
            image,
            top=4,
            aspect_ratio="16:9 (Widescreen)",
            image_placement="fit left",
        )
        self.assertEqual(tuple(padded.shape), (1, 10, 11, 1))
        self.assertTrue(torch.all(padded[:, 4:10, :4] == 1))
        self.assertTrue(torch.all(mask[:, :4, :] == 1))

    def test_feathering_matches_standard_outpaint_mask_shape(self):
        image = torch.zeros((1, 10, 10, 3), dtype=torch.float32)
        _, mask, _, _ = self.pad(image, top=2, feathering=4)
        self.assertEqual(mask[0, 2, 5].item(), 1.0)
        self.assertAlmostEqual(mask[0, 3, 5].item(), 0.5625)
        self.assertEqual(mask[0, 6, 5].item(), 0.0)

    def test_default_mode_fades_image_edge_to_padding_color(self):
        image = torch.zeros((1, 10, 10, 3), dtype=torch.float32)
        result = self.node.pad_image(
            image,
            left=0,
            top=2,
            right=0,
            bottom=0,
            feathering=4,
            feather_mode="fade img to color",
            padding_color="#ff0000",
            aspect_ratio="disabled",
            image_placement="center",
        )
        padded, _, width, height = result["result"]
        self.assertEqual((width, height), (10, 12))
        self.assertTrue(torch.allclose(padded[0, 2, 5], torch.tensor([1.0, 0.0, 0.0])))
        self.assertTrue(torch.allclose(padded[0, 6, 5], torch.zeros(3)))
        self.assertEqual(result["ui"]["text"], ["10x12"])

    def test_mask_only_mode_preserves_source_image(self):
        image = torch.ones((1, 10, 10, 3), dtype=torch.float32)
        padded, _, _, _ = self.pad(
            image,
            top=2,
            feathering=4,
            feather_mode="mask only",
            padding_color="#ff0000",
        )
        self.assertTrue(torch.allclose(padded[0, 2:12], image[0]))

    def test_aspect_padding_exact_ratio_is_empty(self):
        self.assertEqual(aspect_padding(16, 9, "16:9 (Widescreen)", "center"), (0, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
