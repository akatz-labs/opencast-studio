# Character Swap LoRA

The Character Swap LoRA replaces the main subject in a guide video with the character shown in a
reference image. It aims to carry over the guide's scene, framing, motion, pose, and performance
while applying the reference character's appearance.

## Which checkpoint to try

- **[v1.1](../loras/minimax_h3_character_swap_v1.1_ref2va_fro.safetensors) — recommended.** v1.1 is
  about **likeness**: the generated character stays closer to the reference image (face, hair, body
  and clothing) than with v1.0, while still following the guide's scene and performance. It is an
  80 MB SVD extraction with a dynamic rank per layer, chosen by Frobenius-norm energy analysis (each
  layer keeps the smallest rank that holds 95% of its energy: ranks 4 to 34, median 7, over 208
  layers), so it is about eight times smaller than v1.0's rank-64 file. Strength `1.0`.
- [v1.0](../loras/minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors) — the previous release,
  rank 64. Keep it for side-by-side comparisons.

## Workflows (v1.1)

| Workflow | What it uses |
|---|---|
| [`minimax_h3_character_swap_workflow_v1.1.json`](../workflows/minimax_h3_character_swap_workflow_v1.1.json) | The [BFS Shot Planner](https://github.com/alisson-anjos/ComfyUI-BFSNodes) (ComfyUI-BFSNodes **1.113.0 or newer**): long videos split into shots, every shot rendered and joined, references and `{details}` described in the planner, side-by-side comparison. |
| [`minimax_h3_character_swap_workflow_native_nodes_v1.1.json`](../workflows/minimax_h3_character_swap_workflow_native_nodes_v1.1.json) | Native ComfyUI nodes only: `Generate Text` looks at the reference image and writes the complete prompt, `MiniMax H3 Reference to Video` + `Add Guide` render one clip. |

Both run in 8 steps with a DMD turbo LoRA and have an optional second pass (the
[LMS LoRA](lms.md) and the [latent upscaler](latent-upscaler.md), 1280×704). Each workflow has a note
with the download link of every model it loads. The model loaders keep the folder names they were
saved with (e.g. `Downloads/`, `minimax/`): reselect each model in its loader if yours live elsewhere.

| Model | Role |
|---|---|
| `minimax_h3_ref2va_pruned_int8_convrot` | MiniMax H3 `ref2va` diffusion model |
| `qwen3vl_32b_minimax_h3_nvfp4_awq` ([Comfy-Org](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/text_encoders)) | H3 text encoder (the `int8_convrot` and `bf16` versions also work) |
| `minimax_h3_video_vae_fp16`, `minimax_h3_audio_vae_fp32` | H3 video and audio VAEs |
| `minimax_h3_dmd_ref2va_8step_turbo_pruned` | 8-step turbo LoRA (download link in the workflow note) |
| `qwen3.5_9b_w4a8_gptq` | Vision-language model that describes the reference (`{details}`); any Qwen3-VL / Qwen3.5 model supported by `Generate Text` works |
| `minimax_h3_lms_v1.0_r64`, `h3_upscaler_lms_v0.1` | Optional second pass |

## Quick setup

1. Place the LoRA in `ComfyUI/models/loras/` and load one of the v1.1 workflows.
2. Send the original video to `MiniMaxH3AddGuide` at `frame_idx = 0`. The LoRA was trained for
   guide-latent conditioning; this is the recommended video input.
3. Send the character image through H3's native image-reference path as `<Picture 1>`.
4. Use the v1.1 prompt template below, with `{details}` replaced by a description of the reference
   character. If several people appear, say which guide subject to replace; the most visually
   prominent subject may otherwise be selected.
5. Keep the output aspect ratio and frame count aligned with the guide (`17n + 5` frames). Start with
   a short test clip before processing a longer range.

With the Shot Planner, `Use video audio` selects the output soundtrack; audio conditioning also
requires `with_audio = true` on `BFS Shot H3 Conditioning`.

## Prompt template (v1.1)

Use this template as it is, on one line, and replace only `{details}`:

```text
body_swap: subject_definitions: <Subject 1> is the {details} shown in <Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions and clothing define the character in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only the main subject of the guide video is replaced: its face, hair, body and clothing become <Subject 1>.  summary: [video generation + reference] Replace the guide subject with <Subject 1>, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of the guide subject and moves with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions, while keeping the complete identity from <Picture 1>: facial structure, hair or fur, skin, body shape and clothing stay stable in every frame. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker.
```

`{details}` is a comma-separated description of the reference character, from head to toe. It
starts with the gender, with no article before it and no full stop after it, so the sentence reads
"`<Subject 1> is the` … `shown in <Picture 1>`". Example:

```text
body_swap: subject_definitions: <Subject 1> is the Male, average height, slender build, narrow shoulders, thin waist, oval face, deep wrinkles, sun-weathered skin, blue eyes, long white beard, mustache, gray cap, dark jacket shown in <Picture 1>, whose identity, ...
```

**Filling `{details}`:**

- **Shot Planner workflow:** the template goes in the planner's `prompt` input with `{details}` as it
  is. In the panel's **Prompts & refs** tab, **📝 Describe refs** writes the description of each
  reference (or the VLM writes it when the workflow runs); a *custom* describe instruction such as
  the one below gives the head-to-toe list.
- **Native workflow:** `Generate Text` receives the reference image and the instruction below, and
  returns the finished prompt. Set `max_length` to about 768 so the end of the prompt is not cut.

<details>
<summary>Vision-language instruction that writes the complete prompt (native workflow)</summary>

```text
Analyze the character in the provided reference image (<Picture 1>) and generate the complete body_swap prompt below.

**CRITICAL INSTRUCTION:**

You MUST visually analyze the actual character in <Picture 1> and replace the entire `{details}` placeholder with a real, detailed physical description of that character.

Do NOT write "details", "{details}", "the character", "the person in the image", or any other generic placeholder in place of the actual description.

**CHARACTER DESCRIPTION REQUIREMENTS:**

Describe the character's complete visible appearance from head to toe using a single, detailed, comma-separated attribute list.

Include, in this exact order:

1. Gender, apparent height, body type, physique, shoulder width, waist, and body proportions.
2. Head and face shape, jawline, facial structure, skin tone, eye color, and distinctive facial characteristics.
3. Hair color, hairstyle, length, texture, beard, mustache, and other visible facial hair.
4. Upper-body clothing, including garment types, exact colors, fit, fabric appearance, textures, collars, sleeves, buttons, zippers, pockets, logos, patterns, and clothing layers.
5. Lower-body clothing, including pants, jeans, shorts, or other garments, with colors, materials, fit, and visible design details.
6. Footwear, including shoes, boots, or sneakers, with colors, materials, style, and visible details.
7. All visible accessories, including hats, caps, glasses, sunglasses, earrings, necklaces, chains, watches, bracelets, rings, belts, bags, scarves, and piercings.
8. Distinctive features, including tattoos, scars, wrinkles, makeup, and other identifying characteristics.

**IMPORTANT RULES:**

- Extract the character's actual visual characteristics directly from <Picture 1>.
- Pay special attention to clothing, accessories, colors, materials, textures, patterns, and small identifying details.
- Describe only what is visually identifiable.
- Never invent unseen body parts, clothing, accessories, or physical characteristics.
- Omit characteristics that cannot be determined from the image.
- Use concise, visually specific, comma-separated English attributes.
- Start the description with the gender ("Male, ..." or "Female, ..."): no article before it and no full stop after it, so it reads naturally between "is the" and "shown in <Picture 1>".
- Do not describe the background, camera, lighting, or image composition.
- Do not copy example descriptions from other characters.
- Do not modify any part of the body_swap template except the `{details}` placeholder.

**MANDATORY REPLACEMENT EXAMPLE:**

INCORRECT:
<Subject 1> is the details shown in <Picture 1>

CORRECT:
<Subject 1> is the Male, average height, sturdy build, broad shoulders, oval face, light brown skin, blue eyes, grayish-white tousled hair, long thick beard, dark gray flat cap, dark jacket, black inner shirt, silver wristwatch shown in <Picture 1>

The correct example demonstrates the required formatting ONLY. You must describe the actual character in the provided image, not the example character.

**FINAL OUTPUT INSTRUCTIONS:**

First, internally identify all visible physical attributes, clothing items, and accessories.

Second, create one complete comma-separated description containing those actual attributes.

Third, insert that description into the exact position occupied by `{details}` in the template.

Finally, output the complete body_swap prompt with the placeholder fully replaced, on ONE single line, exactly like the template: same words, same order, two spaces before "summary:" and before "detailed_description:".

Your final output MUST contain the actual character description directly after "is the" and immediately before "shown in <Picture 1>".

Never output the literal word "details" in that position.

If the reference image is unavailable or cannot be visually inspected, do not generate a generic body_swap prompt. State that the reference image is required.

**BODY_SWAP TEMPLATE:**

body_swap: subject_definitions: <Subject 1> is the {details} shown in <Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions and clothing define the character in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only the main subject of the guide video is replaced: its face, hair, body and clothing become <Subject 1>.  summary: [video generation + reference] Replace the guide subject with <Subject 1>, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of the guide subject and moves with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions, while keeping the complete identity from <Picture 1>: facial structure, hair or fur, skin, body shape and clothing stay stable in every frame. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker.

**OUTPUT ONLY THE COMPLETED BODY_SWAP PROMPT, ON ONE LINE. NO EXPLANATIONS. NO PLACEHOLDERS. NO MARKDOWN.**
```

</details>

<details>
<summary>Describe instruction for the Shot Planner (custom preset: only the description)</summary>

```text
Describe the character in this reference picture as one comma-separated English attribute list, from head to toe, in this order: gender, apparent height, body type, physique, shoulders, waist and proportions; head and face shape, jawline, skin tone, eye color, distinctive facial features; hair color, style, length, texture and facial hair; upper-body clothing (garments, exact colors, fit, fabric, collars, sleeves, buttons, zippers, pockets, logos, patterns, layers); lower-body clothing (garments, colors, materials, fit, details); footwear (type, colors, materials, style); visible accessories (hats, glasses, earrings, necklaces, chains, watches, bracelets, rings, belts, bags, scarves, piercings); tattoos, scars, wrinkles, makeup. Only what is clearly visible; skip what cannot be seen. Never the background, camera, lighting or pose. Start with the gender ("Male, ..." or "Female, ..."), no article, no full stop. Only the list.
```

</details>

## Combining with Head Swap

The Character Swap and [Head Swap](head-swap.md) LoRAs were both trained with guide latents and use
a similar conditioning approach, so you can experiment with combining them in one workflow. This
might improve lip-sync in some cases, but the combination still needs more testing; results are not
guaranteed and may vary by clip and settings.

## Examples

These previews were made with v1.0 and are embedded below so you can watch them directly on the model page.
Results vary with the clip, reference, prompt, and generation settings.

### Example 01
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_1.mp4"></video>

### Example 02
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_2.mp4"></video>

### Example 03
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_3.mp4"></video>

### Example 04
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_4.mp4"></video>

### Example 05
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_5.mp4"></video>

### Example 06
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_6.mp4"></video>

### Example 08
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_8.mp4"></video>

### Example 09
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_9.mp4"></video>

### Example 10
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_10.mp4"></video>

### Example 11
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_11.mp4"></video>

### Example 12
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_12.mp4"></video>

### Example 13
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_13.mp4"></video>

### Example 14
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_14.mp4"></video>

### Example 15
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_15.mp4"></video>

### Example 16
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_16.mp4"></video>

### Example 17
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_17.mp4"></video>

### Example 18
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_18.mp4"></video>

### Example 19
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_19.mp4"></video>

### Example 20
<video controls width="480" src="https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/resolve/main/examples/character_swap_v1.0_20.mp4"></video>

## Limitations

This is an experimental LoRA, not a guaranteed identity-transfer system. Results can drift with
small faces, occlusion, fast motion, difficult angles, lighting changes, or long clips. It is aimed
primarily at people and human-like characters; animal references are less tested. The model may
also invent details that are not visible in a partial reference image.

Use the model only with appropriate rights and consent for the reference images and guide videos.
Do not use it for impersonation, fraud, harassment, or other unlawful or harmful purposes.

The custom [BFS Character Swap License](../LICENSE_CHARACTER_SWAP.md) applies only to the
Character Swap weight files and their derivative weight files. See [license scope](../LICENSES.md).
Use in commercial videos and films is allowed without prior permission. Organizations above the
license's US $1,000,000 annual gross-revenue threshold must credit the LoRA's origin; hosted API,
SaaS, and other remote model-service use is not allowed. Read the license for all conditions.

[Back to the repository index](../README.md)
