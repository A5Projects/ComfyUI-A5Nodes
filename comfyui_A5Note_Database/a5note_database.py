from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


DB_PATH = Path(__file__).with_name("a5note_database.json")
NAME_MAX_LENGTH = 40
CATEGORY_MAX_LENGTH = 40
DEFAULT_CATEGORY = "General"
RESERVED_NAMES = {"__proto__", "prototype", "constructor"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_database() -> dict[str, Any]:
    return {"version": 1, "notes": []}


def _load_database() -> dict[str, Any]:
    try:
        data = json.loads(DB_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_database()

    if not isinstance(data, dict):
        return _empty_database()

    notes = data.get("notes")
    if not isinstance(notes, list):
        notes = []

    clean_notes: list[dict[str, str]] = []
    for item in notes:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        text = item.get("text")
        note_id = item.get("id")
        category = item.get("category")
        if not isinstance(name, str) or not isinstance(text, str):
            continue
        if not isinstance(category, str) or not category.strip():
            category = DEFAULT_CATEGORY
        if not isinstance(note_id, str) or not note_id.strip():
            note_id = uuid.uuid4().hex
        created_at = item.get("created_at")
        updated_at = item.get("updated_at")
        last_used_at = item.get("last_used_at")
        created_at = created_at if isinstance(created_at, str) else _now_iso()
        updated_at = updated_at if isinstance(updated_at, str) else created_at
        last_used_at = last_used_at if isinstance(last_used_at, str) else updated_at
        clean_notes.append(
            {
                "id": note_id,
                "category": category,
                "name": name,
                "text": text,
                "created_at": created_at,
                "updated_at": updated_at,
                "last_used_at": last_used_at,
            }
        )

    return {"version": 1, "notes": clean_notes}


def _save_database(data: dict[str, Any]) -> None:
    tmp_path = DB_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(DB_PATH)


def _validate_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Note name must be text.")

    name = " ".join(value.strip().split())
    if not name:
        raise ValueError("Note name is required.")
    if len(name) > NAME_MAX_LENGTH:
        raise ValueError(f"Note name must be {NAME_MAX_LENGTH} characters or less.")
    if name.lower() in RESERVED_NAMES:
        raise ValueError("Use a different note name.")
    return name


def _validate_category(value: Any) -> str:
    if value is None:
        return DEFAULT_CATEGORY
    if not isinstance(value, str):
        raise ValueError("Category must be text.")

    category = " ".join(value.strip().split())
    if not category:
        return DEFAULT_CATEGORY
    if len(category) > CATEGORY_MAX_LENGTH:
        raise ValueError(f"Category must be {CATEGORY_MAX_LENGTH} characters or less.")
    if category.lower() in RESERVED_NAMES:
        raise ValueError("Use a different category name.")
    return category


def _validate_text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Note text must be text.")
    if not value.strip():
        raise ValueError("Note text is required.")
    return value


def _sort_notes(notes: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(notes, key=lambda item: item.get("name", "").casefold())


def _database_response(category: str | None = None) -> dict[str, Any]:
    data = _load_database()
    if category:
        data["notes"] = [
            note for note in data["notes"] if note.get("category") == category
        ]
    data["notes"] = _sort_notes(data["notes"])
    return data


def _export_text(category: str) -> str:
    data = _database_response(category)
    lines = [
        f"# A5Note_Database saved notes: {category}",
        "",
        f"Exported: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}",
        "",
    ]
    for note in data["notes"]:
        lines.extend([f"## {note['name']}", "", note["text"], ""])
    return "\n".join(lines)


def _register_routes() -> None:
    if PromptServer is None or web is None:
        return

    routes = PromptServer.instance.routes

    @routes.get("/a5note_database/notes")
    async def get_notes(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(_database_response(category))

    @routes.post("/a5note_database/notes")
    async def save_note(request):
        try:
            body = await request.json()
            category = _validate_category(body.get("category"))
            name = _validate_name(body.get("name"))
            text = _validate_text(body.get("text"))
        except (json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

        data = _load_database()
        now = _now_iso()
        saved_note: dict[str, str] | None = None
        for note in data["notes"]:
            if note.get("category") == category and note.get("name") == name:
                note["text"] = text
                note["updated_at"] = now
                note["last_used_at"] = now
                saved_note = note
                break

        if saved_note is None:
            saved_note = {
                "id": uuid.uuid4().hex,
                "category": category,
                "name": name,
                "text": text,
                "created_at": now,
                "updated_at": now,
                "last_used_at": now,
            }
            data["notes"].append(saved_note)

        _save_database(data)
        return web.json_response(
            {"note": saved_note, "database": _database_response(category)}
        )

    @routes.post("/a5note_database/notes/{note_id}/touch")
    async def touch_note(request):
        note_id = request.match_info["note_id"]
        data = _load_database()
        now = _now_iso()
        touched_note = None
        for note in data["notes"]:
            if note.get("id") == note_id:
                note["last_used_at"] = now
                touched_note = note
                break
        if touched_note is None:
            return web.json_response({"error": "Note not found."}, status=404)
        _save_database(data)
        return web.json_response(
            {
                "note": touched_note,
                "database": _database_response(touched_note.get("category") or DEFAULT_CATEGORY),
            }
        )

    @routes.delete("/a5note_database/notes/{note_id}")
    async def delete_note(request):
        note_id = request.match_info["note_id"]
        data = _load_database()
        deleted_category = None
        for note in data["notes"]:
            if note.get("id") == note_id:
                deleted_category = note.get("category")
                break
        original_count = len(data["notes"])
        data["notes"] = [note for note in data["notes"] if note.get("id") != note_id]
        if len(data["notes"]) == original_count:
            return web.json_response({"error": "Note not found."}, status=404)
        _save_database(data)
        return web.json_response(_database_response(deleted_category or DEFAULT_CATEGORY))

    @routes.delete("/a5note_database/notes")
    async def delete_all_notes(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        data = _load_database()
        data["notes"] = [
            note for note in data["notes"] if note.get("category") != category
        ]
        _save_database(data)
        return web.json_response(_database_response(category))

    @routes.get("/a5note_database/export")
    async def export_notes(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.Response(
            text=_export_text(category),
            content_type="text/markdown",
            headers={"Content-Disposition": 'attachment; filename="a5note_database_notes.md"'},
        )


class A5NoteDatabase:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "name": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                    },
                ),
                "note": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "keep_note"
    CATEGORY = "utils/notes"
    DESCRIPTION = "Store, reload, and preview reusable local markdown notes."

    def keep_note(self, name: str, note: str):
        return ()


_register_routes()


NODE_CLASS_MAPPINGS = {
    "A5NoteDatabase": A5NoteDatabase,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "A5NoteDatabase": "A5Note_Database",
}
