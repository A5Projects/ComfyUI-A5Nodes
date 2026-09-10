"""Standalone editable text node with optional external replacement."""

from typing import Any


TEXT_UPDATE_EVENT = "a5_text_prompt.text_updated"


def _send_text_update(node_id: Any, text: str) -> None:
    """Tell the browser to mirror an accepted external value into the widget."""
    if node_id is None:
        return

    try:
        from server import PromptServer
    except (ImportError, AttributeError):
        return

    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is not None:
        prompt_server.send_sync(
            TEXT_UPDATE_EVENT,
            {"node_id": str(node_id), "text": text},
        )


class A5TextPrompt:
    """Keep editable text visible while optionally accepting a separate input."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "allow_external_text_replace": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "allow",
                        "label_off": "block",
                        "tooltip": (
                            "Allow a connected external_text value to replace the "
                            "visible text when this node runs."
                        ),
                    },
                ),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Editable text returned by the node.",
                    },
                ),
            },
            "optional": {
                "external_text": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": (
                            "Optional text source. It replaces the visible text only "
                            "when external replacement is allowed."
                        ),
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "select_text"
    CATEGORY = "utils/Text"

    def select_text(
        self,
        allow_external_text_replace: bool = True,
        text: str = "",
        external_text: str | None = None,
        unique_id: Any = None,
    ):
        if allow_external_text_replace and external_text is not None:
            result = str(external_text)
            _send_text_update(unique_id, result)
        else:
            result = str(text or "")

        return (result,)


NODE_CLASS_MAPPINGS = {"A5TextPrompt": A5TextPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"A5TextPrompt": "A5TextPrompt"}
