import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / "comfyui_A5TextPrompt"
spec = importlib.util.spec_from_file_location("a5_snippet_store_test", ROOT / "snippets.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)
text_spec = importlib.util.spec_from_file_location("a5_snippet_text_test", ROOT / "a5_text_prompt.py")
text_node = importlib.util.module_from_spec(text_spec)
text_spec.loader.exec_module(text_node)


class TextNodeTests(unittest.TestCase):
    def test_independent_registration_and_replacement(self):
        self.assertEqual(list(text_node.NODE_CLASS_MAPPINGS), ["A5TextPrompt"])
        node = text_node.A5TextPrompt()
        self.assertEqual(node.select_text(text="manual"), ("manual",))
        self.assertEqual(node.select_text(False, "manual", "external"), ("manual",))
        self.assertEqual(node.select_text(True, "manual", None), ("manual",))
        events = []
        fake = types.SimpleNamespace(PromptServer=types.SimpleNamespace(
            instance=types.SimpleNamespace(send_sync=lambda *event: events.append(event))))
        with patch.dict(sys.modules, {"server": fake}):
            for incoming in ("external", ""):
                self.assertEqual(node.select_text(True, "manual", incoming, 42), (incoming,))
                self.assertEqual(events[-1], (
                    "a5_text_prompt.text_updated", {"node_id": "42", "text": incoming}))


class SnippetStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = store.DB_PATH
        store.DB_PATH = Path(self.temp.name) / "snippets.json"

    def tearDown(self):
        store.DB_PATH = self.previous
        self.temp.cleanup()

    def test_slots_round_trip_exact_whitespace_and_unicode(self):
        self.assertEqual(len(store.load_library()["slots"]), 8)
        store.save_slot(6, {"label": "Ref", "text": " \n<image 7> \u00e9 "})
        store.save_slot(2, {"label": "Other", "text": "Reference image 3"})
        self.assertEqual(store.load_library()["slots"][6]["text"], " \n<image 7> \u00e9 ")
        store.save_slot(6, {"label": "", "text": ""})
        self.assertEqual(store.load_library()["slots"][6]["text"], "")
        self.assertEqual(store.load_library()["slots"][2]["text"], "Reference image 3")

    def test_invalid_slot_does_not_write(self):
        for index in (-1, 8, True, "1"):
            with self.assertRaises(ValueError):
                store.save_slot(index, {"label": "x", "text": "x"})
        self.assertFalse(store.DB_PATH.exists())

    def test_corrupt_existing_database_is_not_overwritten(self):
        store.DB_PATH.write_text("not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            store.save_slot(1, {"label": "x", "text": "x"})
        self.assertEqual(store.DB_PATH.read_text(encoding="utf-8"), "not json")

    def test_routes_use_pack_namespace(self):
        registered = {}

        def route(method):
            def register(path):
                def decorate(handler):
                    registered[(method, path)] = handler
                    return handler
                return decorate
            return register

        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(
            instance=types.SimpleNamespace(routes=types.SimpleNamespace(
                get=route("GET"), post=route("POST")))))
        with patch.dict(sys.modules, {"server": server, "aiohttp": types.SimpleNamespace(web=object())}):
            store.register_routes()
        self.assertEqual(set(registered), {
            ("GET", "/a5_text_prompt/snippets"),
            ("POST", "/a5_text_prompt/snippets"),
        })


if __name__ == "__main__":
    unittest.main()
