import { registerTextPromptEditor } from "./text_prompt_editor.js";
import { createSnippetExtras } from "./snippet_buttons.js";

if (!document.getElementById("a5-text-prompt-snippet-layout")) {
    const link = document.createElement("link");
    link.id = "a5-text-prompt-snippet-layout";
    link.rel = "stylesheet";
    link.href = new URL("./snippet_layout.css", import.meta.url).href;
    document.head.append(link);
}

registerTextPromptEditor({ extrasFactory: createSnippetExtras });
