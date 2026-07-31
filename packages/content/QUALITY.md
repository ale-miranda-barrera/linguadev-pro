# LinguaDev Pro — Quality standard for level packs

Gold-standard reference: `packages/content/src/packs/levels/a2/01-greetings-introductions.json`

Every level pack (A2 → B2+) must meet this bar. Improvement subagents rewrite anything that falls below.

## Overall shape (non-negotiable)

- **Exactly 15 questions**, mixed across 5 types (typical mix: 6 MC · 3 T/F · 2 dictation · 2 match · 2 speaking).
- Every question has `explanation` (Spanish) + `examples` (exactly 2 English sentences).
- Question ids `q1`..`q15`. Pack id `{band}-{order:02d}-{slug}`.
- `passThreshold`: 0.8 (approve at 80%+).

## The gold-standard rules for content

### Rule 1 — Contextual prompt on every situation-based question

Add a `prompt` field with the real-world SITUATION when it makes the question stick.
```
❌ Bad: "Complete: 'She ___ up at 7.'"
✅ Good: prompt = "Situación: describes la rutina de tu compañera de cuarto." | question = "Complete: 'She ___ up at 7 every day.'"
```
Not every question needs a prompt, but when the situation makes the grammar meaningful, add it.

### Rule 2 — Examples are REAL sentences someone would say today

Two examples per question, and they must:
- Feel like something a real person would say in real life (work call, coffee shop, chat with friend, email).
- Include a **short scene marker** with `→` when it clarifies the register or context.

```
❌ Weak:
  "She always eats breakfast."
  "He always drinks coffee."

✅ Strong:
  "My coworker Sarah always arrives 10 minutes late — every single day.",
  "Ana always has a green smoothie for breakfast, even on weekends. → habit expressed with time detail"
```

### Rule 3 — Explanations must teach the RULE + the WHY + the common mistake

Structure the Spanish explanation like this (in prose, not bullets):
1. **The rule** in one line.
2. **The contrast** or exception — where hispanohablantes trip.
3. Optional: the natural/native version vs. the textbook version.

```
❌ Weak: "En presente simple con he/she/it añadimos -s."
✅ Strong: "En presente simple con he/she/it añadimos -s al verbo (works, plays, goes). OJO: los verbos terminados en -ch, -sh, -x, -s, -o añaden -es (watches, washes, does). Error típico de hispanohablante: olvidar la -s porque en español el verbo cambia por otras razones."
```

### Rule 4 — Multiple-choice distractors must be WRONG for a meaningful reason

Each wrong option should represent a real mistake a learner might make, not random text.

```
❌ Random distractors: ["cat", "gets", "banana", "runs"]
✅ Meaningful distractors: ["get", "gets", "getting", "got"]  → each represents a real confusion (base form / -s / -ing / past)
```

### Rule 5 — Dictation texts must sound spoken, not written

- 8–14 words for A2, 10–18 for A2+/B1, 12–22 for B2, 14–28 for B2+.
- Use contractions (I'm, don't, we've) and connected phrases people actually say.
- In `explanation`, point out ONE pronunciation feature: linking, weak form, elision, or a common phonetic trap.

```
✅ Text: "I'll be there in ten minutes, I'm just leaving now."
   Explanation: "'I'll' es la contracción de 'I will'. En hablado 'ten minutes' suena como 'ten-min-uts' con schwa. 'I'm just leaving' — nota la fluidez, no se pausa entre palabras."
```

### Rule 6 — Match pairs must be COHERENT (single micro-topic)

All 3–6 pairs in a match question should share ONE clear pattern — collocations, phrasal verbs, question↔answer, term↔translation, cause↔effect.

```
❌ Mixed: [work↔trabajo, apple↔manzana, run↔correr]  (random)
✅ Coherent: [get up↔levantarse, have breakfast↔desayunar, brush my teeth↔cepillarme los dientes]  (all daily-routine verbs)
```

### Rule 7 — Speaking targets must feel like real speech

- Include a natural situation in the explanation: where would a native say this?
- Add rhythm markers: contractions, discourse markers ('actually', 'you know'), or short pauses ('...').

```
❌ Robotic: "I like to eat food in restaurants."
✅ Natural: "Honestly, I usually just grab something on the way to work — I'm not much of a breakfast person."
```

### Rule 8 — True/False statements target a REAL misconception

The statement should encode a common mistake or a nuance most learners get wrong. Explanation must reveal the myth and the truth.

```
✅ "'How do you do?' is a casual greeting between friends."  → false, teaches formality
✅ "'I'm boring' means the same as 'I'm bored'."             → false, teaches -ed vs -ing adjective
```

### Rule 9 — Progressive difficulty within the pack

- Q1–Q4: warmup (core concept, easy).
- Q5–Q10: main practice (variations, contrast).
- Q11–Q15: challenge (edge cases, natural speech, integration).

### Rule 10 — Register awareness in every band

- A2: label formal/informal when it matters ("Formal: ...", "With friends: ...").
- A2+/B1: introduce hedging and register choices explicitly.
- B2/B2+: nuance every register decision. Distinguish spoken vs. written, US vs. UK where relevant.

## What to AVOID

- Generic textbook sentences ("The cat sits on the mat.").
- Explanations that just translate the answer.
- Examples that repeat the exact question sentence.
- Distractors that are obviously wrong (e.g., wrong part of speech when the question is about tense).
- Overusing exclamation marks, emojis, or theatrical Spanish.
- Long-winded explanations — 2–4 sentences maximum.

## The polish-pass checklist

When rewriting an existing pack, apply this checklist to every question:

1. Is the `prompt` (situation) present when it would help? Add one if it improves grounding.
2. Are the 2 examples DIFFERENT enough to teach something new (not just repeat the same pattern)?
3. Does at least one example include a scene marker or context?
4. Does the explanation include the WHY and a common mistake?
5. Are distractors (MC) each targeting a real confusion?
6. Does the dictation explanation call out a pronunciation feature?
7. Do match pairs share ONE clear pattern?
8. Does the speaking target sound like real speech (contractions, discourse markers)?

If any answer is "no", rewrite that field. Keep the same `id`, `type`, `correctIndex`/`correct`, and `text`/`target` unless correctness demands change.
