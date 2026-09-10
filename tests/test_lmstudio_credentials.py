import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PACK_ROOT = Path(__file__).resolve().parents[1]
if str(PACK_ROOT) not in sys.path:
    sys.path.insert(0, str(PACK_ROOT))

from comfyui_A5lmstudio_prompt_enhancer import lmstudio_prompt_enhancer as enhancer


class LMStudioCredentialTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_directory.name)
        self.config_path = self.root / "lmstudio_prompt_enhancer_config.json"
        self.credentials_path = self.root / "user" / "A5-Nodes" / "lmstudio_credentials.json"
        self.config_patch = mock.patch.object(enhancer, "CONFIG_PATH", self.config_path)
        self.credentials_patch = mock.patch.object(
            enhancer,
            "_credentials_path",
            return_value=self.credentials_path,
        )
        self.config_patch.start()
        self.credentials_patch.start()

    def tearDown(self):
        self.credentials_patch.stop()
        self.config_patch.stop()
        self.temp_directory.cleanup()

    def test_new_token_is_written_only_to_user_credentials(self):
        enhancer._save_config({"recent_models": ["local/model"]})

        enhancer._save_api_token("secret-token")

        credentials = json.loads(self.credentials_path.read_text(encoding="utf-8"))
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(credentials, {"api_token": "secret-token"})
        self.assertNotIn("api_token", config)
        self.assertEqual(config["recent_models"], ["local/model"])

    def test_legacy_token_is_migrated_and_source_config_is_sanitized(self):
        enhancer._save_config(
            {
                "api_token": "legacy-secret",
                "last_enhanced_prompt": "kept prompt",
            }
        )

        token = enhancer._load_saved_api_token()

        self.assertEqual(token, "legacy-secret")
        credentials = json.loads(self.credentials_path.read_text(encoding="utf-8"))
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(credentials, {"api_token": "legacy-secret"})
        self.assertNotIn("api_token", config)
        self.assertEqual(config["last_enhanced_prompt"], "kept prompt")


if __name__ == "__main__":
    unittest.main()
