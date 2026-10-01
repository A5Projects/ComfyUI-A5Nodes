"""Eight shared snippet slots; no dependency on the prompt database."""

import json
import threading
from pathlib import Path

DB_PATH = Path(__file__).with_name("snippets.json")
LOCK = threading.Lock()
SLOT_COUNT = 8


def defaults():
    return {"version": 1, "slots": [
        {"label": "Image 1", "text": "<image 1>"},
        {"label": "Image 2", "text": "<image 2>"},
        {"label": "Ref 1", "text": "Reference image 1"},
        {"label": "Ref 2", "text": "Reference image 2"},
        *({"label": "", "text": ""} for _ in range(4)),
    ]}


def load_library():
    if not DB_PATH.exists():
        return defaults()
    data = json.loads(DB_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("Unsupported snippet file format.")
    slots = data.get("slots")
    if not isinstance(slots, list) or len(slots) != SLOT_COUNT:
        raise ValueError("Snippet file must contain eight slots.")
    for slot in slots:
        validate_slot(slot)
    return data


def validate_slot(slot):
    if not isinstance(slot, dict):
        raise ValueError("A snippet must contain a label and text.")
    if not isinstance(slot.get("label"), str) or len(slot["label"]) > 40:
        raise ValueError("Snippet label must be text, at most 40 characters.")
    if not isinstance(slot.get("text"), str) or len(slot["text"]) > 16000:
        raise ValueError("Snippet text must be text, at most 16000 characters.")


def save_slot(index, slot):
    if type(index) is not int or not 0 <= index < SLOT_COUNT:
        raise ValueError("Choose a snippet slot from 1 to 8.")
    validate_slot(slot)
    with LOCK:
        data = load_library()
        data["slots"][index] = {"label": slot["label"], "text": slot["text"]}
        temporary = DB_PATH.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(DB_PATH)
        return data


def register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    if getattr(PromptServer, "instance", None) is None:
        return

    @PromptServer.instance.routes.get("/a5_text_prompt/snippets")
    async def get_slots(request):
        try:
            return web.json_response(load_library())
        except (OSError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/a5_text_prompt/snippets")
    async def put_slot(request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("Expected a snippet object.")
            return web.json_response(save_slot(data.get("index"), data))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
