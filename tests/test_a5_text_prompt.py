import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from comfyui_A5TextPrompt import a5_text_prompt


class FakePromptServerInstance:
    def __init__(self):
        self.events = []

    def send_sync(self, name, detail):
        self.events.append((name, detail))


class A5TextPromptTests(unittest.TestCase):
    def setUp(self):
        self.prompt_server = FakePromptServerInstance()
        self.previous_server = sys.modules.get("server")
        sys.modules["server"] = types.SimpleNamespace(
            PromptServer=types.SimpleNamespace(instance=self.prompt_server)
        )
        self.node = a5_text_prompt.A5TextPrompt()

    def tearDown(self):
        if self.previous_server is None:
            sys.modules.pop("server", None)
        else:
            sys.modules["server"] = self.previous_server

    def test_interface_keeps_widget_and_external_socket_separate(self):
        inputs = self.node.INPUT_TYPES()

        self.assertEqual(
            list(inputs["required"]),
            ["allow_external_text_replace", "text"],
        )
        self.assertTrue(inputs["required"]["text"][1]["multiline"])
        self.assertTrue(inputs["optional"]["external_text"][1]["forceInput"])
        self.assertEqual(inputs["hidden"], {"unique_id": "UNIQUE_ID"})
        self.assertEqual(self.node.RETURN_TYPES, ("STRING",))
        self.assertEqual(self.node.CATEGORY, "utils/Text")

    def test_manual_text_is_returned_when_external_is_disconnected(self):
        self.assertEqual(self.node.select_text(True, "manual", None, "7"), ("manual",))
        self.assertEqual(self.prompt_server.events, [])

    def test_blocked_external_text_is_ignored(self):
        self.assertEqual(
            self.node.select_text(False, "manual", "external", "7"),
            ("manual",),
        )
        self.assertEqual(self.prompt_server.events, [])

    def test_allowed_external_text_is_returned_and_sent_to_frontend(self):
        self.assertEqual(
            self.node.select_text(True, "manual", "external", "7"),
            ("external",),
        )
        self.assertEqual(
            self.prompt_server.events,
            [
                (
                    a5_text_prompt.TEXT_UPDATE_EVENT,
                    {"node_id": "7", "text": "external"},
                )
            ],
        )

    def test_empty_external_text_is_an_accepted_value(self):
        self.assertEqual(self.node.select_text(True, "manual", "", "7"), ("",))
        self.assertEqual(self.prompt_server.events[0][1]["text"], "")


if __name__ == "__main__":
    unittest.main()
