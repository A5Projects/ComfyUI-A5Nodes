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


DB_PATH = Path(__file__).with_name("a5prompt_database.json")
NAME_MAX_LENGTH = 40
CATEGORY_MAX_LENGTH = 40
DEFAULT_CATEGORY = "System"
RESERVED_NAMES = {"__proto__", "prototype", "constructor"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_database() -> dict[str, Any]:
    return {"version": 2, "prompts": []}


def _load_database() -> dict[str, Any]:
    try:
        data = json.loads(DB_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_database()

    if not isinstance(data, dict):
        return _empty_database()

    prompts = data.get("prompts")
    if not isinstance(prompts, list):
        prompts = []

    clean_prompts: list[dict[str, str]] = []
    for item in prompts:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        text = item.get("text")
        prompt_id = item.get("id")
        category = item.get("category")
        if not isinstance(name, str) or not isinstance(text, str):
            continue
        if not isinstance(category, str) or not category.strip():
            category = DEFAULT_CATEGORY
        if not isinstance(prompt_id, str) or not prompt_id.strip():
            prompt_id = uuid.uuid4().hex
        created_at = item.get("created_at")
        updated_at = item.get("updated_at")
        last_used_at = item.get("last_used_at")
        created_at = created_at if isinstance(created_at, str) else _now_iso()
        updated_at = updated_at if isinstance(updated_at, str) else created_at
        last_used_at = last_used_at if isinstance(last_used_at, str) else updated_at
        clean_prompts.append(
            {
                "id": prompt_id,
                "category": category,
                "name": name,
                "text": text,
                "created_at": created_at,
                "updated_at": updated_at,
                "last_used_at": last_used_at,
            }
        )

    return {"version": 2, "prompts": clean_prompts}


def _save_database(data: dict[str, Any]) -> None:
    tmp_path = DB_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(DB_PATH)


def _validate_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Prompt name must be text.")

    name = " ".join(value.strip().split())
    if not name:
        raise ValueError("Prompt name is required.")
    if len(name) > NAME_MAX_LENGTH:
        raise ValueError(f"Prompt name must be {NAME_MAX_LENGTH} characters or less.")
    if name.lower() in RESERVED_NAMES:
        raise ValueError("Use a different prompt name.")
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
        raise ValueError("Prompt text must be text.")
    if not value.strip():
        raise ValueError("Prompt text is required.")
    return value


def _sort_prompts(prompts: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(prompts, key=lambda item: item.get("name", "").casefold())


def _database_response(category: str | None = None) -> dict[str, Any]:
    data = _load_database()
    if category:
        data["prompts"] = [
            prompt for prompt in data["prompts"] if prompt.get("category") == category
        ]
    data["prompts"] = _sort_prompts(data["prompts"])
    return data


def _export_text(category: str) -> str:
    data = _database_response(category)
    lines = [
        f"A5Prompt Database saved prompts: {category}",
        f"Exported: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}",
        "",
    ]
    for prompt in data["prompts"]:
        lines.extend([f"[{prompt['name']}]", prompt["text"], ""])
    return "\n".join(lines)


def _register_routes() -> None:
    if PromptServer is None or web is None:
        return

    routes = PromptServer.instance.routes

    @routes.get("/a5prompt_database/prompts")
    async def get_prompts(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(_database_response(category))

    @routes.post("/a5prompt_database/prompts")
    async def save_prompt(request):
        try:
            body = await request.json()
            category = _validate_category(body.get("category"))
            name = _validate_name(body.get("name"))
            text = _validate_text(body.get("text"))
        except (json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

        data = _load_database()
        now = _now_iso()
        saved_prompt: dict[str, str] | None = None
        for prompt in data["prompts"]:
            if prompt.get("category") == category and prompt.get("name") == name:
                prompt["text"] = text
                prompt["updated_at"] = now
                prompt["last_used_at"] = now
                saved_prompt = prompt
                break

        if saved_prompt is None:
            saved_prompt = {
                "id": uuid.uuid4().hex,
                "category": category,
                "name": name,
                "text": text,
                "created_at": now,
                "updated_at": now,
                "last_used_at": now,
            }
            data["prompts"].append(saved_prompt)

        _save_database(data)
        return web.json_response(
            {"prompt": saved_prompt, "database": _database_response(category)}
        )

    @routes.post("/a5prompt_database/prompts/{prompt_id}/touch")
    async def touch_prompt(request):
        prompt_id = request.match_info["prompt_id"]
        data = _load_database()
        now = _now_iso()
        touched_prompt = None
        for prompt in data["prompts"]:
            if prompt.get("id") == prompt_id:
                prompt["last_used_at"] = now
                touched_prompt = prompt
                break
        if touched_prompt is None:
            return web.json_response({"error": "Prompt not found."}, status=404)
        _save_database(data)
        return web.json_response(
            {
                "prompt": touched_prompt,
                "database": _database_response(touched_prompt.get("category") or DEFAULT_CATEGORY),
            }
        )

    @routes.delete("/a5prompt_database/prompts/{prompt_id}")
    async def delete_prompt(request):
        prompt_id = request.match_info["prompt_id"]
        data = _load_database()
        deleted_category = None
        for prompt in data["prompts"]:
            if prompt.get("id") == prompt_id:
                deleted_category = prompt.get("category")
                break
        original_count = len(data["prompts"])
        data["prompts"] = [prompt for prompt in data["prompts"] if prompt.get("id") != prompt_id]
        if len(data["prompts"]) == original_count:
            return web.json_response({"error": "Prompt not found."}, status=404)
        _save_database(data)
        return web.json_response(_database_response(deleted_category or DEFAULT_CATEGORY))

    @routes.delete("/a5prompt_database/prompts")
    async def delete_all_prompts(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        data = _load_database()
        data["prompts"] = [
            prompt for prompt in data["prompts"] if prompt.get("category") != category
        ]
        _save_database(data)
        return web.json_response(_database_response(category))

    @routes.get("/a5prompt_database/export")
    async def export_prompts(request):
        try:
            category = _validate_category(request.query.get("category"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.Response(
            text=_export_text(category),
            content_type="text/plain",
            headers={"Content-Disposition": 'attachment; filename="a5prompt_database_prompts.txt"'},
        )


class A5PromptDatabase:
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
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "get_prompt"
    CATEGORY = "utils/text"
    DESCRIPTION = "Store, reload, and output reusable local text prompts."

    def get_prompt(self, name: str, prompt: str):
        return (prompt,)


_register_routes()


NODE_CLASS_MAPPINGS = {
    "A5PromptDatabase": A5PromptDatabase,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "A5PromptDatabase": "A5Prompt Database",
}
