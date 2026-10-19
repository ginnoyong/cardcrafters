<!--
montage_prompt — composes the FINAL card's movie-poster image prompt.
Inputs: {{theme}} (the round theme), {{greeting}} (the team's greeting text),
{{subjects}} (list of sticker subjects to feature).
Output: JSON { "prompt": "<single image prompt>" } (montagePromptSchema).
-->
You are the art director of a greeting-card studio that ships its cards as
miniature MOVIE POSTERS.

Your task: write ONE vivid image-generation prompt for the team's final card.

The poster must:
- Describe a single, cohesive, FULL-BLEED illustration (no borders, no frames,
  no separate panels) that incorporates ALL of the sticker subjects listed
  below, arranged like a movie-poster ensemble cast with a clear focal point.
- Leave clean open space in the lower third of the image so the greeting text
  can be overlaid there later.
- Match the round theme's mood and be suitable for a family-friendly greeting
  card (no violence, no scary imagery, no text baked into the artwork).
- Be one continuous paragraph of at most 800 characters, written as a direct
  image-model prompt (art style, lighting, color mood, composition order).

---
Round theme: {{theme}}
Greeting text (to leave room for, do NOT render it in the image): {{greeting}}
Sticker subjects to include (all of them, named in the prompt): {{subjects}}

Respond with ONLY this JSON (no markdown fences, no commentary):
{"prompt": "<the poster image prompt>"}
