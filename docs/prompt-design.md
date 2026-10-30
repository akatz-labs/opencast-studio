# MOSS character caption design, v2

The visible selection is the source of truth. The deterministic compiler translates it into ordinary English descriptions of a finished studio photograph. It adds concrete wardrobe construction, colors, fabrics, pose and lighting to make the combination visually specific. The complete caption and every resolved slot are inspectable before rendering.

The template is `{medium_and_framing} {character_type} {age} {gender} {ethnicity} {skin_or_surface} {build} {height} {proportions} {head_and_neck} {eyes_and_features} {hairstyle} {hair_color} {facial_hair} {wardrobe_from_style} {accessories} {pose} {lighting_and_texture} {additional_direction}`. Some tightly related slots are combined into sentences. No unsupported trait is silently accepted by the API.

## Findings from the competitor examples

On 2026-10-17, the live Higgsfield AI Influencer gallery's first Recreate button loaded the strongman attributes into the sidebar: male, adult, tall, ultra muscular, olive complexion and additional facial/hair/styling details. The public preset payload also supplied a substantial free-text brief containing a specific outfit, expression, photographic treatment and two-view sheet composition. Other presets had empty briefs. Thus public choices alone do not explain every curated image; the art-direction layer is material.

The CAST approach uses our own versioned prose, explicit visible traits and a single-image composition. The strongman and afro starting points express the user's examples with new captions. CAST does not call the Higgsfield generation API or bundle its images. Local observation receipts are retained in the experiment folder as `higgsfield-feed.json`, `higgsfield-recreate.txt` and `higgsfield-recreate.png`.

Sources: https://higgsfield.ai/ai-influencer-studio and https://cms.higgsfield.ai/ai-influencer-presets?lang=en&size=20&cursor=1 .

## Precedence

- Explicit Hair color beats Silver/Blue/etc. in legacy Hairstyle labels. Bald retains color as recorded metadata with a visible no-effect note.
- Explicit Height beats the legacy Tall build label.
- Selected proportions and anatomy take priority over general intensity styling.
- Trans identity is retained as selected metadata; no stereotypical anatomy is invented.
- Animal species stays anatomical. Selected ethnicity describes cultural identity rather than changing species or inventing cultural costume. Skin tone describes exposed skin, not the animal's fur color.
- Unspecified traits are filled by the template; that inferred content is visible in the caption.
- Art direction is appended as user-authored text. A complete manual caption override is sent as written, with an explicit override label.

## Evaluate and tune

Use the saved strongman, sculptural afro, fox and natural portrait cases to review silhouette, full hair/foot framing, species preservation, selected traits, material texture and anatomy. Compare an edited prompt at the same seed, steps, CFG and resolution. A new seed explores variation. No template can guarantee exceptional quality for every combination; inspect the output rather than equating a successful render with aesthetic acceptance.

The compiled caption is the actual CLIP input. The optional MOSS/Qwen rewrite remains disabled; this avoids an unrecorded second prompt. A future LLM enhancer must return its rewritten caption before submission and preserve both versions.

## Matched refinement

Version 2 strengthens the explicit Surreal + Long neck combination and restricts portrait wardrobe to visible upper-body garments. The initial portrait caption described trousers and boots and produced a full-body image despite its portrait framing sentence. Version 2 removes those conflicting details and defines the lower crop at the upper chest. Original v1 outputs remain in History. Reusing an existing image freezes its exact caption even after a compiler update.

## Krea character compiler v3 — October 28

The current compiler and runtime are Krea, replacing the historical MOSS recipe above. Natural, Bold and Extreme replace the old human intensity names. Expressive and Surreal are migrated to Bold and Extreme at the input boundary.

Concrete facial dimensions carry the caricature: jaw width relative to the cheekbones, cleft depth, paired chin lobes, mouth placement, nose length, projecting ears and brow shape. Bold supplies square jaw, short cleft and lean cheeks when unspecified; Extreme supplies a projecting jaw shelf, large split chin, lean cheeks and small mouth. Any explicit field wins, including Natural for that field. Animal types inherit no human facial defaults. Body build applies to shoulders/torso/limbs, preventing Strongman or Broad from diluting the facial instructions into uniformly inflated cheeks.

Portrait wardrobe is limited to necklines and shoulders. Full-body prompts specify the complete hairstyle and shoes. The presets exercise split chin, elongated head/neck, broad jaw and animal identity. Prompt text remains inspectable and is saved with each output. Model compliance varies: the validated split-chin headshot exaggerated the jaw and cleft but cropped some hair; the full-body long-face case retained shoes and hairstyle; the fox retained species, with ear tips cropped. These observations are not a guarantee for arbitrary combinations.

Current graph: `workflows/krea-api.json`; 4000-step LoRA at 1.0, 8 Euler/simple steps, CFG 1. No hosted inference or caption rewrite.
