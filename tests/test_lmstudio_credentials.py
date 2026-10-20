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

    def test_source_legacy_token_is_discarded_not_migrated(self):
        enhancer._save_config(
            {
                "api_token": "legacy-secret",
                "last_enhanced_prompt": "kept prompt",
            }
        )

        status = enhancer._credential_status("http://localhost:1234")

        self.assertNotIn("legacy_token_pending", status)
        self.assertFalse(status["has_api_token"])
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "")
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertFalse(self.credentials_path.exists())
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

    def test_both_legacy_locations_are_removed_and_bound_tokens_preserved(self):
        bound = {"http://localhost:1234/v1": "bound-one",
                 "https://other.example/v1": "bound-two"}
        enhancer._save_credentials({"api_token": "old-user-secret", "version": 2,
                                    "server_tokens": bound, "unrelated": "keep"})
        enhancer._save_config({"api_token": "old-source-secret", "server_url": "http://localhost:1234",
                              "last_enhanced_prompt": "keep prompt", "recent_models": ["keep model"]})
        self.assertEqual(enhancer._load_saved_api_token("http://untrusted.example"), "")
        self.assertEqual(enhancer._load_credentials(),
                         {"version": 2, "server_tokens": bound, "unrelated": "keep"})
        self.assertEqual(enhancer._load_config(), {
            "server_url": "http://localhost:1234", "last_enhanced_prompt": "keep prompt",
            "recent_models": ["keep model"]})
        for server, token in bound.items():
            self.assertEqual(enhancer._load_saved_api_token(server), token)

    def test_reentering_token_saves_only_the_supplied_value_for_that_server(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        enhancer._save_config({"api_token": "older-secret"})
        enhancer._save_api_token("new-secret", "http://localhost:1234")
        self.assertEqual(enhancer._load_credentials(), {"version": 2, "server_tokens": {
            "http://localhost:1234/v1": "new-secret"}})
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "new-secret")
        self.assertEqual(enhancer._load_saved_api_token("http://other.example"), "")
        self.assertNotIn("api_token", enhancer._load_config())

    def test_legacy_cleanup_is_idempotent_and_does_not_rewrite_clean_files(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        enhancer._save_config({"api_token": "older-secret", "last_enhanced_prompt": "keep"})
        enhancer._credential_status("http://localhost:1234")
        with mock.patch.object(enhancer, "_save_credentials") as save_credentials, \
                mock.patch.object(enhancer, "_save_config") as save_config:
            enhancer._credential_status("http://localhost:1234")
            enhancer._load_saved_api_token("http://other.example")
            save_credentials.assert_not_called()
            save_config.assert_not_called()

    def test_cleanup_failure_blocks_network_and_never_uses_unbound_token(self):
        handlers = self.routes()
        req = types.SimpleNamespace(query={"server_url": "http://untrusted.example"})
        for writer in ("_save_credentials", "_save_config"):
            with self.subTest(writer=writer):
                enhancer._save_credentials({"api_token": "old-user-secret"})
                enhancer._save_config({"api_token": "old-source-secret"})
                with mock.patch.object(enhancer, writer, side_effect=OSError("disk full")), \
                        mock.patch.object(enhancer, "_open_request") as network:
                    data, status = asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/models"](req))
                    self.assertEqual(status, 200)
                    self.assertIn("disk full", data["error"])
                    network.assert_not_called()
                    data, status = asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/config"](req))
                    self.assertEqual(status, 400)
                    self.assertNotIn("secret", json.dumps(data))

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

    def test_save_route_requires_server_and_actual_token_value(self):
        enhancer._save_credentials({"api_token": "old-secret"})
        handler = self.routes()["POST", "/a5lmstudio_prompt_enhancer/api_token"]
        payloads = [{"api_token": "new"}, [], {"server_url": "http://localhost:1234"}]
        payloads += [{"server_url": "http://localhost:1234", "api_token": value}
                     for value in ("", "  ", enhancer.MASKED_API_TOKEN, None, 123)]
        for payload in payloads:
            req = types.SimpleNamespace(json=mock.AsyncMock(return_value=payload))
            self.assertEqual(asyncio.run(handler(req))[1], 400)
        req = types.SimpleNamespace(json=mock.AsyncMock(return_value={
            "server_url": "http://localhost:1234", "api_token": "reentered-secret"}))
        self.assertEqual(asyncio.run(handler(req))[1], 200)
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "reentered-secret")
        self.assertNotIn("old-secret", json.dumps(enhancer._load_credentials()))

    def test_reported_confirm_then_models_attack_cannot_send_legacy_token(self):
        handlers = self.routes()
        destination = "http://untrusted.example:9876"
        for location in ("source", "user", "both"):
            for status_first in (False, True):
                with self.subTest(location=location, status_first=status_first):
                    enhancer._save_config({"api_token": "source-secret"} if location != "user" else {})
                    enhancer._save_credentials({"api_token": "user-secret"} if location != "source" else {})
                    req = types.SimpleNamespace(
                        query={"server_url": destination},
                        json=mock.AsyncMock(return_value={"server_url": destination, "confirm_legacy": True}))
                    if status_first:
                        data, status = asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/config"](req))
                        self.assertFalse(data["has_api_token"])
                    data, status = asyncio.run(handlers["POST", "/a5lmstudio_prompt_enhancer/api_token"](req))
                    self.assertEqual(status, 400)
                    self.assertIn("Enter the token again", data["error"])
                    # Exercise the actual model lookup and HTTP-header construction;
                    # only the network boundary is mocked. Never contact a server.
                    with mock.patch.object(enhancer, "_open_request") as network:
                        network.return_value.__enter__.return_value.read.return_value = b'{"data": []}'
                        data, status = asyncio.run(handlers["GET", "/a5lmstudio_prompt_enhancer/models"](req))
                        self.assertEqual(status, 200)
                        outbound = network.call_args.args[0]
                        self.assertEqual(outbound.full_url, destination + "/v1/models")
                        self.assertIsNone(outbound.get_header("Authorization"))
                    self.assertNotIn("api_token", enhancer._load_credentials())
                    self.assertNotIn("api_token", enhancer._load_config())
                    self.assertFalse(enhancer._load_credentials().get("server_tokens"))

    def test_legacy_binding_requests_cannot_overwrite_or_copy_bound_credentials(self):
        enhancer._save_api_token("bound-secret", "http://localhost:1234")
        enhancer._save_credentials({**enhancer._load_credentials(), "api_token": "old-secret"})
        handler = self.routes()["POST", "/a5lmstudio_prompt_enhancer/api_token"]
        for server in ("http://localhost:1234", "http://untrusted.example"):
            for flag in (True, "true", 1):
                req = types.SimpleNamespace(json=mock.AsyncMock(return_value={
                    "server_url": server, "confirm_legacy": flag, "api_token": "replacement"}))
                self.assertEqual(asyncio.run(handler(req))[1], 400)
        self.assertEqual(enhancer._load_saved_api_token("http://localhost:1234"), "bound-secret")
        self.assertEqual(enhancer._load_saved_api_token("http://untrusted.example"), "")

    def test_generation_and_abort_ignore_and_discard_legacy_tokens(self):
        destination = "http://untrusted.example"
        handlers = self.routes()
        for operation in ("generation", "abort"):
            with self.subTest(operation=operation):
                enhancer._save_credentials({"api_token": "old-user-secret"})
                enhancer._save_config({"api_token": "old-source-secret"})
                if operation == "generation":
                    with mock.patch.object(enhancer, "_post_json", return_value={
                            "choices": [{"message": {"content": "result"}}]}) as post:
                        enhancer.A5lmstudio_prompt_enhancer().enhance_prompt(
                            "system", "input", run_mode=enhancer.RUN_MODE_ALWAYS,
                            server_url=destination, api_token=enhancer.MASKED_API_TOKEN,
                            unload_comfy_models_before_llm_run=False,
                            load_model_before_generation=False, unload_model_after_generation=False)
                        self.assertEqual(post.call_args.args[2], "")
                else:
                    req = types.SimpleNamespace(json=mock.AsyncMock(return_value={"server_url": destination}))
                    with mock.patch.object(enhancer, "_unload_lmstudio_models") as unload:
                        asyncio.run(handlers["POST", "/a5lmstudio_prompt_enhancer/abort"](req))
                        unload.assert_called_once_with(destination, "", "")
                self.assertNotIn("api_token", enhancer._load_credentials())
                self.assertNotIn("api_token", enhancer._load_config())

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
