import base64
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from comfyui_A5lmstudio_prompt_enhancer import lmstudio_prompt_enhancer as enhancer


def attachments(content):
    if isinstance(content, str):
        return []
    result = []
    for item in content:
        if item['type'] == 'image_url':
            prefix, encoded = item['image_url']['url'].split(',', 1)
            assert prefix == 'data:image/png;base64'
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
                result.append(image.copy())
    return result


class LMStudioImageTests(unittest.TestCase):
    def setUp(self):
        self.red = Image.new('RGB', (80, 60), 'red')
        self.green = Image.new('RGB', (60, 80), 'green')
        self.blue = Image.new('RGB', (50, 50), 'blue')

    def test_text_and_original_single_image_payload_unchanged(self):
        self.assertEqual(enhancer._build_user_content('request', None), 'request')
        content = enhancer._build_user_content('request', self.red)
        self.assertEqual([item['type'] for item in content], ['text', 'image_url'])
        self.assertEqual(content[0]['text'], 'request')
        self.assertEqual(attachments(content)[0].tobytes(), self.red.tobytes())

    def test_three_images_arrive_in_order_in_one_message(self):
        content = enhancer._build_user_content('edit these people', self.red, self.green, self.blue)
        images = attachments(content)
        self.assertEqual([im.getpixel((0, 0)) for im in images], [(255, 0, 0), (0, 128, 0), (0, 0, 255)])
        self.assertEqual([item['text'] for item in content if item['type'] == 'text'], [
            'edit these people', 'Reference image 1 (from image input):',
            'Reference image 2 (from image_2 input):', 'Reference image 3 (from image_3 input):'])

    def test_empty_sockets_are_skipped_without_reordering(self):
        for refs, expected in (((None, None, self.blue), [self.blue]),
                               ((self.red, None, self.blue), [self.red, self.blue]),
                               ((None, self.green, self.blue), [self.green, self.blue])):
            content = enhancer._build_user_content('request', *refs)
            self.assertEqual([im.getpixel((0, 0)) for im in attachments(content)],
                             [im.getpixel((0, 0)) for im in expected])
            labels = [item['text'] for item in content if item['type'] == 'text'][1:]
            for ordinal, label in enumerate(labels, 1):
                self.assertTrue(label.startswith(f'Reference image {ordinal} '))

    def test_extra_images_have_one_megapixel_cap_but_primary_does_not(self):
        primary = Image.new('RGB', (4000, 2000), 'red')
        second = Image.new('RGB', (2000, 1000), 'green')
        third = Image.new('RGB', (1000, 2000), 'blue')
        content = enhancer._build_user_content('request', primary, second, third)
        first, extra2, extra3 = attachments(content)
        self.assertEqual(first.size, (3072, 1536))
        for extra, original in ((extra2, second), (extra3, third)):
            self.assertLessEqual(extra.width * extra.height, 1_000_000)
            self.assertGreater(extra.width * extra.height, 995_000)
            self.assertAlmostEqual(extra.width / extra.height, original.width / original.height, places=2)
        self.assertEqual(primary.size, (4000, 2000), 'upstream images are not modified')
        self.assertEqual(second.size, (2000, 1000))

    def test_small_and_exact_budget_images_not_upscaled(self):
        for size in ((640, 480), (1000, 1000), (2000, 500)):
            image = Image.new('RGB', size)
            self.assertEqual(enhancer._image_to_pil(image, 1_000_000).size, size)
        content = enhancer._build_user_content('request', Image.new('RGB', (2000, 1000)))
        self.assertEqual(attachments(content)[0].size, (2000, 1000))

    def test_extreme_aspect_ratio_remains_nonzero_and_within_budget(self):
        for size in ((2000, 1), (1, 2000)):
            output = enhancer._image_to_pil(Image.new('RGB', size), 100)
            self.assertGreaterEqual(min(output.size), 1)
            self.assertLessEqual(output.width * output.height, 100)

    def test_each_input_still_uses_first_batch_image(self):
        batches = []
        for rgb in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
            batch = np.zeros((2, 8, 8, 3), dtype=np.float32)
            batch[0] = rgb
            batch[1] = 1
            batches.append(batch)
        content = enhancer._build_user_content('request', *batches)
        self.assertEqual([im.getpixel((0, 0)) for im in attachments(content)],
                         [(255, 0, 0), (0, 255, 0), (0, 0, 255)])

    def test_single_image_fingerprint_compatible_with_existing_cache(self):
        payload = dict(system_prompt='system', input_prompt='request',
                       image_sha256=hashlib.sha256(enhancer._image_to_png_bytes(self.red)).hexdigest(), model='model')
        expected = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(enhancer._build_input_fingerprint('system', 'request', self.red, 'model'), expected)

    def test_fingerprint_tracks_every_reference_and_order(self):
        def fingerprint(*refs):
            return enhancer._build_input_fingerprint('system', 'request', refs[0], 'model', *refs[1:])
        cases = [(self.red, None, None), (self.red, self.green, None),
                 (self.red, self.green, self.blue), (self.red, self.blue, self.green),
                 (self.red, None, self.blue), (self.blue, self.green, self.red)]
        values = [fingerprint(*refs) for refs in cases]
        self.assertEqual(len(set(values)), len(values))
        self.assertEqual(fingerprint(self.red, self.green, self.blue), fingerprint(self.red.copy(), self.green.copy(), self.blue.copy()))

    def test_schema_preserves_original_socket_and_appends_two_optional_inputs(self):
        with mock.patch.object(enhancer, '_load_config', return_value={}):
            optional = enhancer.A5lmstudio_prompt_enhancer.INPUT_TYPES()['optional']
        self.assertEqual(list(optional), ['image', 'image_2', 'image_3'])
        self.assertTrue(all(value[0] == 'IMAGE' for value in optional.values()))

    def test_generation_and_auto_bypass_with_three_references(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(enhancer, 'CONFIG_PATH', Path(directory) / 'config.json'), \
             mock.patch.object(enhancer, '_load_saved_api_token', return_value=''), \
             mock.patch.object(enhancer, '_post_json', return_value={'choices': [{'message': {'content': 'enhanced'}}]}) as post:
            node = enhancer.A5lmstudio_prompt_enhancer()
            kwargs = dict(system_prompt='system', input_prompt='request', image=self.red,
                          image_2=self.green, image_3=self.blue,
                          unload_comfy_models_before_llm_run=False,
                          load_model_before_generation=False, unload_model_after_generation=False)
            self.assertEqual(node.enhance_prompt(**kwargs), ('enhanced',))
            self.assertEqual(len(attachments(post.call_args.args[1]['messages'][1]['content'])), 3)
            node.enhance_prompt(**kwargs)
            self.assertEqual(post.call_count, 1, 'identical references auto-bypass')
            kwargs['image_2'], kwargs['image_3'] = self.blue, self.green
            node.enhance_prompt(**kwargs)
            self.assertEqual(post.call_count, 2, 'swapping references re-runs')
            kwargs['image_3'] = None
            node.enhance_prompt(**kwargs)
            self.assertEqual(post.call_count, 3, 'removing a reference re-runs')
            kwargs['image_2'] = self.red
            node.enhance_prompt(**kwargs)
            self.assertEqual(post.call_count, 4, 'changing a reference re-runs')
            kwargs['run_mode'] = enhancer.RUN_MODE_BYPASS
            with mock.patch.object(enhancer, '_image_to_png_bytes', side_effect=AssertionError('must not encode')):
                node.enhance_prompt(**kwargs)
            self.assertEqual(post.call_count, 4, 'explicit bypass makes no request')


if __name__ == '__main__':
    unittest.main()
