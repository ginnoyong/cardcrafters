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
- Weave the subjects into ONE SHARED SCENE: a common ground plane, ONE lighting
  setup, ONE color palette, ONE art style across the whole frame. It must NOT
  read as a collage, a grid, a lineup, or separate floating objects on a plain
  background — overlap the subjects, echo their colors, and connect them with
  shared scenery so the image looks painted in a single pass.
- NOT be a subject list. Name each subject only through its ROLE in the scene
  (e.g. "a paper crane banking over the festival square"), never as a flat
  comma-separated inventory; never use sticker, die-cut, or
  transparent-background wording in the prompt.
- Compose for a TALL PORTRAIT poster (5:7 aspect): arrange the artwork for a
  vertical page, not a wide landscape frame.
- Render the greeting text AS PART OF THE ARTWORK, in the lower third of the
  image, styled like a movie-poster title treatment: integrated into the
  composition, clearly legible, and matching the scene's palette and mood.
  The greeting's phrasing must be kept VERBATIM — do not reword, translate,
  or omit any part of it.
- The greeting/title text must fit within the CENTRAL 60% of the image width
  (portrait 5:7 composition — compose for a tall poster; leave the outer 20%
  margins on each side free of text). Never run the title full-bleed edge to
  edge: a tighter portrait crop must never cut the text's first or last
  letters.
- Match the round theme's mood and be suitable for a family-friendly greeting
  card (no violence, no scary imagery; the ONLY text in the artwork is the
  greeting, rendered exactly as given).
- Be one continuous paragraph of at most 800 characters, written as a direct
  image-model prompt (art style, lighting, color mood, composition order).

---
Round theme: {{theme}}
Greeting text (render this verbatim as the poster's title treatment in the lower third, sized to fit the CENTRAL 60% of the image width): {{greeting}}
Sticker subjects to include (all of them, named in the prompt): {{subjects}}

Respond with ONLY this JSON (no markdown fences, no commentary):
{"prompt": "<the poster image prompt>"}
