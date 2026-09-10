# ComfyUI A5 Nodes

A single installable pack containing the A5 custom nodes for ComfyUI.

## Included nodes

### Prompt and text

- **A5 CLIP Prompt Enhancer** — enhances prompts with a generative ComfyUI CLIP text encoder.
- **A5 LM Studio Prompt Enhancer** — enhances prompts through a local LM Studio OpenAI-compatible server.
- **A5TextPrompt** — editable prompt box with optional external-text replacement and session history.
- **A5Prompt Database** — stores and recalls reusable prompts.
- **A5Note Database** — stores and previews reusable Markdown notes.

### Image and latent utilities

- **A5 Universal Latent Presets** — creates preset latent sizes for supported latent formats.
- **A5 Scale to Total Pixels Safe** — scales to a target pixel count or canvas size with safe aspect handling.
- **A5 Pad Image for Outpaint** — pads an image and creates an outpainting mask.
- **A5 Only Scale to Total Pixels** — reduced scale-only version of the total-pixels node.

Existing node IDs are preserved so workflows made with the standalone versions remain compatible.

## Installation

Clone or extract the repository as one directory inside `ComfyUI/custom_nodes`:

```text
ComfyUI/custom_nodes/ComfyUI-A5-Nodes
```

Restart ComfyUI and hard-refresh the browser. Do not keep the standalone copies enabled at the same time; duplicate node IDs and duplicate frontend extensions can produce unpredictable results.

No additional pip packages are required beyond a current ComfyUI installation. The CLIP prompt enhancer requires a recent ComfyUI version with the V3 custom-node API and core text-generation support. The LM Studio enhancer requires a running LM Studio server only when that node is used.

## Local data and credentials

The database files deliberately live beside their corresponding Python source files:

```text
comfyui_A5Prompt_database/a5prompt_database.json
comfyui_A5Note_Database/a5note_database.json
```

They are created when needed and are excluded from Git and Registry release archives so personal prompts and notes cannot be published accidentally.

When replacing standalone installations, copy any existing database JSON files into the matching directories above before removing the old folders.

The optional LM Studio API token is stored separately at:

```text
ComfyUI/user/A5-Nodes/lmstudio_credentials.json
```

If an older `lmstudio_prompt_enhancer_config.json` contains a token, the node migrates it to the user directory and removes the token from the source-side config after the new credentials file has been written successfully. Non-secret LM Studio state and the CLIP enhancer cache remain beside their respective node source files and are ignored by Git.

## Updating

Pull or replace the complete pack, restart ComfyUI, and hard-refresh the browser. Back up the two database JSON files before replacing the directory manually.

## License

MIT. See [LICENSE](LICENSE).
