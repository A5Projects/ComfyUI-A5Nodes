import copy
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from A5MultiImageLoad import multi_image_load as module


class Blocker:
    def __init__(self, message):
        self.message = message


class MultiImageLoadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("input", "output", "temp"):
            (self.root / name).mkdir()

        def annotated(filename):
            for kind in ("input", "output", "temp"):
                if filename.endswith(f" [{kind}]"):
                    return str(self.root / kind / filename[:-(len(kind) + 3)])
            return str(self.root / "input" / filename)

        folder_paths = types.SimpleNamespace(
            get_annotated_filepath=annotated,
            get_input_directory=lambda: str(self.root / "input"),
            get_output_directory=lambda: str(self.root / "output"),
            get_temp_directory=lambda: str(self.root / "temp"),
        )
        self.originals = {}
        self.load_calls = []

        def load(filename):
            self.load_calls.append(filename)
            if filename == "broken.png":
                raise ValueError("cannot decode image")
            return self.originals[filename]

        def scale(samples, width, height, method, crop):
            self.assertEqual((method, crop), ("lanczos", "disabled"))
            return F.interpolate(samples, (height, width), mode="bicubic", align_corners=False)

        comfy = types.ModuleType("comfy")
        comfy.utils = types.SimpleNamespace(common_upscale=scale)
        context = patch.dict(sys.modules, {
            "folder_paths": folder_paths, "comfy": comfy, "comfy.utils": comfy.utils,
            "comfy_execution.graph": types.SimpleNamespace(ExecutionBlocker=Blocker),
        })
        context.start()
        self.addCleanup(context.stop)
        loader_patch = patch.object(module, "load_original", side_effect=load)
        loader_patch.start()
        self.addCleanup(loader_patch.stop)
        self.state = module.default_state()
        self.node = module.A5MultiImageLoad()

    def add_image(self, filename, width=60, height=40, channels=3):
        path = Path(sys.modules["folder_paths"].get_annotated_filepath(filename))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(filename.encode())
        self.originals[filename] = torch.rand(1, height, width, channels)
        return filename

    def run_node(self):
        return self.node.load_images(json.dumps(self.state))["result"]

    def test_public_outputs(self):
        self.assertEqual(self.node.RETURN_TYPES, ("IMAGE",) * 7)
        self.assertEqual(self.node.OUTPUT_IS_LIST, (False,) * 6 + (True,))
        self.assertEqual(self.node.RETURN_NAMES[-1], "image_list")

    def test_mixed_sizes_order_and_pixel_preservation(self):
        names = [self.add_image("portrait.png", 40, 80), self.add_image("landscape.png", 80, 40),
                 self.add_image("square.png", 60, 60)]
        self.state["slots"][0]["file"] = names[0]
        self.state["slots"][4]["file"] = names[1]
        self.state["extras"] = [names[2], names[0]]
        result = self.run_node()
        self.assertIsNone(result[1])
        self.assertIsNone(result[3])
        for image, name in zip(result[-1], [*names, names[0]]):
            self.assertTrue(torch.equal(image, self.originals[name]))
        self.assertEqual(len(result[-1]), 4)
        self.assertTrue(torch.equal(result[4], self.originals[names[1]]))
        self.assertEqual(self.load_calls, names)

    def test_disabled_missing_file_is_ignored_without_shifting_outputs(self):
        self.state["slots"][1] = {"file": "missing.png", "enabled": False}
        self.state["slots"][2]["file"] = self.add_image("third.png")
        self.assertIs(self.node.VALIDATE_INPUTS(json.dumps(self.state)), True)
        self.assertIsInstance(self.node.IS_CHANGED(json.dumps(self.state)), str)
        result = self.run_node()
        self.assertIsNone(result[1])
        self.assertIs(result[2], self.originals["third.png"])
        self.assertEqual(len(result[-1]), 1)

    def test_reference_resize_leaves_all_list_images_untouched(self):
        name = self.add_image("ref.png", 120, 60)
        self.state["slots"][0]["file"] = name
        self.state.update(resize=True, megapixels=0.02)
        result = self.run_node()
        self.assertEqual(tuple(result[0].shape[1:3]), (100, 200))
        self.assertEqual(tuple(result[-1][0].shape[1:3]), (60, 120))
        self.assertTrue(torch.equal(result[-1][0], self.originals[name]))

    def test_downscale_only_preserves_small_images_exactly(self):
        name = self.add_image("small.png", 32, 20)
        self.state["slots"][0]["file"] = name
        self.state.update(resize=True, downscale_only=True)
        self.assertIs(self.run_node()[0], self.originals[name])

    def test_downscale_preserves_portrait_ratio_with_pixel_rounding(self):
        width, height = module.reference_dimensions(999, 2000, 0.1, True)
        self.assertLess(abs(width / height - 999 / 2000), 1 / height)
        self.assertLess(width, 999)
        self.assertLess(height, 2000)

    def test_clear_extras_keeps_references_and_their_originals(self):
        self.state["slots"][0]["file"] = self.add_image("ref.png")
        self.state["extras"] = [self.add_image("extra.png")]
        before = copy.deepcopy(self.state["slots"])
        self.state["extras"] = []
        result = self.run_node()
        self.assertEqual(self.state["slots"], before)
        self.assertEqual(len(result[-1]), 1)
        self.assertIs(result[0], result[-1][0])

    def test_duplicates_are_not_removed(self):
        name = self.add_image("same.png")
        self.state["extras"] = [name, name, name]
        self.assertEqual(len(self.run_node()[-1]), 3)
        self.assertEqual(self.load_calls, [name])

    def test_empty_list_blocks_only_collection_branch(self):
        result = self.run_node()
        self.assertEqual(result[:6], (None,) * 6)
        self.assertIsInstance(result[-1][0], Blocker)
        self.assertIsNone(result[-1][0].message)

    def test_missing_active_file_has_slot_label(self):
        self.state["slots"][3]["file"] = "missing.png"
        self.assertIn("Image 4", self.node.VALIDATE_INPUTS(json.dumps(self.state)))
        with self.assertRaisesRegex(ValueError, "Image 4.*missing.png"):
            self.run_node()

    def test_unreadable_extra_reports_filename(self):
        self.state["extras"] = [self.add_image("broken.png")]
        with self.assertRaisesRegex(ValueError, "Extra image 1.*broken.png.*cannot decode"):
            self.run_node()

    def test_output_and_temp_annotated_paths(self):
        self.state["extras"] = [self.add_image("sub/output.png [output]"), self.add_image("preview.png [temp]")]
        self.assertEqual(len(self.run_node()[-1]), 2)

    def test_outside_storage_path_is_rejected(self):
        (self.root / "outside.png").write_bytes(b"image")
        self.state["extras"] = ["../outside.png"]
        self.assertIn("input, output or temp", self.node.VALIDATE_INPUTS(json.dumps(self.state)))

    def test_same_name_content_changes_invalidate_cache(self):
        self.state["extras"] = [self.add_image("edit.png")]
        value = json.dumps(self.state)
        first = self.node.IS_CHANGED(value)
        (self.root / "input/edit.png").write_bytes(b"changed!")
        self.assertNotEqual(first, self.node.IS_CHANGED(value))

    def test_invalid_state_and_megapixels(self):
        for value in ("bad json", "[]", '{"version":2}'):
            self.assertIsInstance(self.node.VALIDATE_INPUTS(value), str)
        for value in (0, True, float("nan"), float("inf"), 101, "1"):
            self.state["megapixels"] = value
            self.assertIn("megapixels", self.node.VALIDATE_INPUTS(json.dumps(self.state)))

    def test_defaults_have_independent_slot_state(self):
        first, second = module.default_state(), module.default_state()
        first["slots"][0]["file"] = "changed"
        self.assertEqual(first["slots"][1]["file"], "")
        self.assertEqual(second["slots"][0]["file"], "")


class CoreDecoderDelegationTests(unittest.TestCase):
    def test_core_decoding_is_reused_and_only_first_frame_is_returned(self):
        images = torch.rand(3, 10, 20, 4)
        class CoreLoader:
            def load_image(self, filename):
                self.filename = filename
                return images, torch.zeros(3, 10, 20)
        with patch.dict(sys.modules, {"nodes": types.SimpleNamespace(LoadImage=CoreLoader)}):
            actual = module.load_original("animated.webp")
        self.assertTrue(torch.equal(actual, images[:1]))
        self.assertEqual(tuple(actual.shape), (1, 10, 20, 4))


if __name__ == "__main__":
    unittest.main()
