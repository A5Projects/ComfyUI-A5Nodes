# A5 Custom Nodes

A collection of nine custom nodes for ComfyUI covering prompt enhancement,
prompt and note storage, text input, latent presets, image scaling, and
outpainting utilities.

Existing A5 node IDs are preserved so workflows created with the standalone
versions remain compatible.

## Installation

Clone or extract this repository into `ComfyUI/custom_nodes`, then restart
ComfyUI and refresh the browser. Disable any standalone copies of these nodes
to avoid duplicate registrations.
Now also on github and in ComfyUI manager (don't select Nightly version but the numbered one)

## No additional Python packages are required. Detailed node documentation and screenshots below.

<hr>

NOTE: This readme was copied from the slightly messy HF repo, despite some editing, formatting and layout may not be perfect. But it says what it should.

little youtube video on most of these nodes. https://youtu.be/Hhowg7dzk-0
--

### A5lmstudio_prompt_enhancer: Comfyui Prompt enhancer node, using a local model (localhost server, Lm Studio and others) Including INTELLIGENT loading/unloading and (Auto) bypass modes.
this image shows the current/recent ui version. As does the Youtube video. All other guides/images further down  show the old one, which is functionally exactly the same!
<img src="https://cdn-uploads.huggingface.co/production/uploads/67786db89328893864293f2c/8zta4RY4DvzZL0EcWEdYB.png" width="650" alt="Thumbnail"> 
<br>

Firefox warning: There are currently unsolved issues in ComfyUI's nodes 2.0 with Firefox. I HIGHLY recommend using classic nodes with Firefox
---
(in general tbh, 2.0 is ...) These nodes work fully as intended in classic node mode in both browsers. If you have to switch to nodes 2.0 and it messes stuff up, reload the node (context menu, not just R) , when back in classic node mode! Chromium works fine in both modes.

### In nodes 2.0 both nodes work functionally, even in firefox.
But resizing nodes smaller seem to be broken (i tried fixing this node a LOT before realizing it being Comfy+firefox issue.


### The dynamic Duo at work, quickly explained:
![newllmnodes1](https://cdn-uploads.huggingface.co/production/uploads/67786db89328893864293f2c/7Wsq1nYjEnQamtyda-9mL.jpeg)
They, and all others, can be used individually of course.

First the big one:
### LMStudio Prompt Enhancer (Also other localhost openai api servers (partly?). 
Screenshots may show the previous UI, function is identical. 

### Send any system prompt to a localhost server (Example LMStudio) and/or a user prompt (to improve) and/or a image.
Then get the llm's enhanced prompt back, exportable as string for any text input in Comfyui. 

### Intelligent (or manual) bypassing: 
- Three modes "Always run LLM", "Bypass - send last/manual prompt" (full bypass)  and "Bypass if unchanged" (auto)
- "Manual Bypass", runs last extended prompt (whatever is in the lowest text field)  again, which can be manually edited!).
- "Aways run LLM", you guessed, it always runs the llm. (get a new enhanced prompt every time, may have its uses)
### - "Bypass if unchanged", the "intelligence":
- It also sends the last enhanced prompt, IF input image and/or prompts and/or selected LLM model  have NOT changed.
- IF input prompt, selected LLM or image has changed, it runs the LLM again, creating a new enhanced prompt, overwriting the old one.
- Last prompts remains in the 20 step history (see below)
  
### Editing Box, Bypass switches and 20 prompt history:
- Manual Edits in the lower field or the editing box do NOT trigger another llm run. You can use this essentially as the default text prompt box. That field and the box are linked. 
- The lowest button in the node ("Edit last Prompt") Opens a separate text box. This is a direct instance of that lowest text field (the enhanced prompt).
- it has switches for "Bypass" (=manual bypass)  and "auto" These are instances of the main nodes bypass options. (Exception: If the main node is set to "Always run LLM" these bypass switches are ignored.
- it has a 20 step history. The last 20 prompts in this field can be selected back and forth. This is updated after changes once you click outside the editing box, OR when the workflow runs.
- It  opens as a resizable always-on-top window for comfortable editing, however small and far away the main node is. 

This functionality (to edit the enhanced prompt) is the main reason, i made my own. So i don't have to copy and paste stuff between prompt and clip textfields to use an already anhanced prompt again AND be able to make edits to it myself. . 
 manual edits to the enhanced prompt are ignored in the bypass check! 

### Server options:  dropdown list. Load/unload LLM before run. unload Comfy models before LLM run. 

- More Options: Api token, max tokens, (it auto removes thinking blocks but they still count for the limit!)
- LLM select dropdown.  For more compatibility for openai api servers other than LMStudio, we use a more generic server get list instead of th neat LMStudio specific one. Combined with little algorithm to mark likely vision capable models.
### switches: 
- Unload ComfyUi models from Vram (ONLY) if LLM is run.  It will ONLY do that if the LLM is actually run. Respecting  all bypass options.
- - So IF lmstudio loads the llm to do your prommpt, it does not crash with a big Comfyui image model still in your vram.
- Load LLM / Unload LLM: If both on, it automatically loads the LMStudio LLM, ONLY if needed, runs the prompt enhancing, then unloads the LLM again
- I recommend leaving all three switches on, so LLM and Comfy models never crash in Vram or system ram.


###Important caveats on these:
- ### LM Studio (not me) requires authentication with token for the loading/unloading options. If you set the dropdown to "Use loaded / Default model", the top entry, you do not need a token but load/unload will not work.  
- - It also will return an error if NO model is loaded in LM Studio.
- Image below:  You need those settings in LMStudio (left) set, for those features in the Node (Right) to work!- - Including a token set in LMStudio and entered in the node!
![a5settings](https://cdn-uploads.huggingface.co/production/uploads/67786db89328893864293f2c/-Qxge2kUXUmLEi75EIpSu.jpeg)
- Vision for images: Sending a image with your prompt requires a vision model to be loaded of course. The list shows an educated guess, but no precise pull. 
- NON LM Studio server: This should work with any openai compatible server, but it was made and tested using LM; Studio. Especially the model loading/unloading may not work with other servers.
- Also keep in mind this was made for local use with a local llm, on a single computer. So it deliberately balances convenience and complexity with safety. The server token is never displayed in the node (XXX) BUT is saved in plain text in that json file. 

## Prompt Database Node:
Save multiple prompts (or whatever) with names, in three different categories (three separate sets of saved prompts). It's stored in the node's folder, in json file. so all saved prompts are available in any workflow in your comfy installation. Should be simple to understand.
### save/updae: if name (title, top field)  for an entry is not changed, it updates the entry. If name is changed a new entry is created. 

Of course it doesn't have to be prompts. You can use it as simple database for whatever, any name and any text. Keep in mind it is saved in plain text in the nodes local folder! (a5prompt_database.json)  

# quick look at the smaller nodes:
### Scale to total pixels safe (now with Image padding).
- Scale to pixel number, multi 8/16/32, scale only up, only down or both, select resacle method.
- exports the rescaled image. Exports the width and height as int. Displays the output resolution. Allows manual width and height override. With or without preserving Aspect.

Image padding:
--
Padding mode enabled 
- IF manually width and height are entered as override and "Keep Aspect" is OFF
- OR you select a aspect ratio from the dropdown
- you can select the options: stretch (image). Or Padding.
  
Padding opens up the padding section. Fill the resized part of the image that is NOT the image (Letterbox) with a selectable and pickable color. Padding left/top or right/bottom of the image. select color from elsewhere on the comfy canvas, example from the background color of your input image edge to match it for the padding.
This was a mess because of browsers and ndoes2.0. The dedicated "Pick color" button works in every combiantion (click the cursor on the needed color. 
<img width="750" height="300" alt="image" src="https://github.com/user-attachments/assets/3a6067f7-7f1a-452e-af83-db6e22ced40d" />

A5 Pad Image for Outpaint
--
Similar to the above but as dedicated padding only node.
<img width="700" height="200" alt="image" src="https://github.com/user-attachments/assets/f3614b28-4498-4f38-8c16-ba13f8cddc72" />

The node A5_only scale to total pixels
--
is the rescale only node, without the padding stuff. Unlocking aspect simple stretches the image. 
(btw the "safe" in the name is ancient and means the multiples-math. that was the og motivation for it.) 

A5 Universal latent presets
--
Set latent format to Flux.2 OR Flux.1, SD3... the Main one, or hidreamo1.  Presets for 1, 2, 3 and 4 Mpx, All the usual aspect ratios, invert button to switch to portrait (vertical mode). There was a similar node for (only) Flux.2, but it outputted the wrong size (latent was twice what you selected). 

![image](https://cdn-uploads.huggingface.co/production/uploads/67786db89328893864293f2c/45yxBxbOJ-UY_OiZwoqcT.png)

A5 Text Prompt 
--
A text prompt node. BUT the text inside is shown AND remains editable! A switch to allow or block a external inout overwriting the text currently in your box. Text outputted as string.
Aim: Not to have to disconnect and copy and paste around if i want to edit what was last sent to this box. 
stores up to 20 last, saves when one is sent in externally OR you type and then click outside of the node. They are NOT persistent over Comfy retarts and stored per workflow. But can be exported.  Connect external stings to the External Input connector, NOT to the textbox.
<img width="344" height="220" alt="image" src="https://github.com/user-attachments/assets/4d81f115-230a-4a63-8f76-006b49bdbd2c" />

It is basically the simpler, text only, undo capable text editing part of my PromptEnhancer node

A5 Note database
--
Say goodby to separate notes-workflow or 20 markdown notes in different workflows: Very similar to my prompt database. Only it handles notes. Save with name, new name=new entry, same name=upated existing note. 
Dropdown with all notes in the category, three categories, 6 buttons for the most recernt entires directly in the node.  Tooltip of note names in drop down and buttons shows full one.
Future updates will be backwards compatible.  Notes are saved locally in the nodes Custom_nodes folder.

This is WiP i'm not happy with the display of the notes yet. The database and storage works very well. The display as Markdown is WiP.
---

![image](https://cdn-uploads.huggingface.co/production/uploads/67786db89328893864293f2c/FYUtuQjsU6gUMe2CGNGwE.png)

