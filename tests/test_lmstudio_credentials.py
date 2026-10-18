import json
import asyncio
import types
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

        enhancer._save_api_token("secret-token", "http://localhost:1234")

        credentials = json.loads(self.credentials_path.read_text(encoding="utf-8"))
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(credentials, {"version": 2, "server_tokens": {
            "http://localhost:1234/v1": "secret-token"}})
        self.assertNotIn("api_token", config)
        self.assertEqual(config["recent_models"], ["local/model"])

    def test_legacy_token_is_migrated_and_source_config_is_sanitized(self):
        enhancer._save_config(
            {
                "api_token": "legacy-secret",
                "last_enhanced_prompt": "kept prompt",
            }
        )

        status = enhancer._credential_status("http://localhost:1234")

        self.assertTrue(status["legacy_token_pending"])
        self.assertFalse(status["has_api_token"])
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "")
        credentials = json.loads(self.credentials_path.read_text(encoding="utf-8"))
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(credentials, {"api_token": "legacy-secret"})
        self.assertNotIn("api_token", config)
        self.assertEqual(config["last_enhanced_prompt"], "kept prompt")

    def test_url_normalization_and_isolation(self):
        enhancer._save_api_token("one", "HTTP://LOCALHOST:1234/v1/")
        for url in ("localhost:1234", "http://localhost:1234/", "http://localhost:1234/v1",
                    "http://LOCALHOST:1234/v1/chat/completions/"):
            self.assertEqual(enhancer._load_saved_api_token(url), "one")
        for url in ("https://localhost:1234", "http://localhost:9999", "http://127.0.0.1:1234",
                    "http://evil.example:1234", "http://localhost:1234/other/v1"):
            self.assertEqual(enhancer._load_saved_api_token(url), "")
        enhancer._save_api_token("two", "http://other.example:1234")
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "one")
        self.assertEqual(enhancer._load_saved_api_token("http://other.example:1234"), "two")
        self.assertEqual(enhancer._normalize_server_url("https://EXAMPLE.com:443"), "https://example.com/v1")
        self.assertEqual(enhancer._normalize_server_url("http://[::1]:1234"), "http://[::1]:1234/v1")

    def test_unsafe_urls_rejected_before_saving(self):
        for url in ("file:///tmp/a", "ftp://host", "http://user:pass@host", "http://host?x=1",
                    "http://host#fragment", "http://host:bad", "http://host/a b", "http://host\\other"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                enhancer._save_api_token("secret", url)
        self.assertFalse(self.credentials_path.exists())

    def test_legacy_confirmation_binds_only_once(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        for server in ("http://localhost:1234", "http://other.example"):
            self.assertEqual(enhancer._load_saved_api_token(server), "")
        enhancer._bind_legacy_api_token("http://localhost:1234")
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234/v1"), "old-secret")
        self.assertEqual(enhancer._load_saved_api_token("http://other.example"), "")
        self.assertFalse(enhancer._credential_status("http://localhost:1234")["legacy_token_pending"])
        with self.assertRaises(ValueError):
            enhancer._bind_legacy_api_token("http://other.example")

    def test_legacy_confirmation_does_not_replace_existing_token(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        enhancer._save_api_token("new-secret", "http://localhost:1234")
        with self.assertRaises(ValueError):
            enhancer._bind_legacy_api_token("http://localhost:1234")
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "new-secret")

    def test_failed_migration_preserves_source_and_never_uses_unbound_token(self):
        enhancer._save_config({"api_token": "old-secret"})
        with mock.patch.object(enhancer, "_save_credentials", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                enhancer._credential_status("http://localhost:1234")
        self.assertEqual(enhancer._load_config()["api_token"], "old-secret")
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "")

    def test_redirects_are_rejected(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaises(ValueError):
                enhancer._NoRedirect().redirect_request(None, None, code, "redirect", {}, "http://other.example")
        for method, args in ((enhancer._get_json, ("http://localhost:1234/v1/models", "secret")),
                             (enhancer._post_json, ("http://localhost:1234/v1/chat/completions", {}, "secret"))):
            with mock.patch.object(enhancer.request, "build_opener") as opener:
                opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{}'
                method(*args)
                self.assertIsInstance(opener.call_args.args[0], enhancer._NoRedirect)
                self.assertEqual(opener.return_value.open.call_args.args[0].get_header("Authorization"), "Bearer secret")

    def routes(self):
        handlers = {}
        class Routes:
            def get(self, path):
                return lambda fn: handlers.setdefault(("GET", path), fn)
            def post(self, path):
                return lambda fn: handlers.setdefault(("POST", path), fn)
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes())))
        web = types.SimpleNamespace(json_response=lambda data, status=200: (data, status))
        with mock.patch.dict(sys.modules, {"server": server, "aiohttp": types.SimpleNamespace(web=web)}):
            enhancer._register_api_routes()
        return handlers

    def test_routes_use_selected_server_and_do_not_expose_tokens(self):
        enhancer._save_api_token("secret-one", "http://localhost:1234")
        handlers = self.routes()
        for server, expected in (("http://localhost:1234", "secret-one"), ("http://other.example", "")):
            req = types.SimpleNamespace(query={"server_url": server}, json=mock.AsyncMock(return_value={"server_url": server}))
            with mock.patch.object(enhancer, "_server_models", return_value=[]) as models:
                asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/models"](req))
                models.assert_called_once_with(server, expected)
            with mock.patch.object(enhancer, "_unload_lmstudio_models") as unload:
                asyncio.run(handlers["POST", "/a5lmstudio_prompt_enhancer/abort"](req))
                unload.assert_called_once_with(server, "", expected)
            data, status = asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/config"](req))
            self.assertEqual(status, 200)
            self.assertEqual(data["has_api_token"], bool(expected))
            self.assertNotIn("secret-one", json.dumps(data))

    def test_save_route_requires_server_and_explicit_legacy_confirmation(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        handler = self.routes()["POST", "/a5lmstudio_prompt_enhancer/api_token"]
        for payload in ({"api_token": "new"}, [], {"server_url": "http://localhost:1234", "confirm_legacy": "true"}):
            req = types.SimpleNamespace(json=mock.AsyncMock(return_value=payload))
            self.assertEqual(asyncio.run(handler(req))[1], 400)
        req = types.SimpleNamespace(json=mock.AsyncMock(return_value={"server_url": "http://localhost:1234", "confirm_legacy": True}))
        self.assertEqual(asyncio.run(handler(req))[1], 200)
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "old-secret")

    def test_generation_uses_only_matching_saved_token(self):
        enhancer._save_api_token("secret-one", "http://localhost:1234")
        for server, expected in (("http://localhost:1234", "secret-one"), ("http://other.example", "")):
            with mock.patch.object(enhancer, "_post_json", return_value={"choices": [{"message": {"content": "result"}}]}) as post:
                enhancer.A5lmstudio_prompt_enhancer().enhance_prompt(
                    "system", "input", run_mode=enhancer.RUN_MODE_ALWAYS,
                    server_url=server, api_token=enhancer.MASKED_API_TOKEN,
                    unload_comfy_models_before_llm_run=False,
                    load_model_before_generation=False, unload_model_after_generation=False)
                self.assertEqual(post.call_args.args[2], expected)


if __name__ == "__main__":
    unittest.main()
