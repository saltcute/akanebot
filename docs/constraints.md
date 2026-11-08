# Human constraints and their knobs

Every setting in the persona file, and whether code acts on it yet. "Validated" means the value is checked when the file loads but nothing uses it so far.

| Knob | Controls | Status |
|---|---|---|
| `name`, `aliases` | Who counts as being addressed | Active |
| `timezone` | Local time shown to the model, as an IANA zone so daylight saving is automatic. `GABRIEL_TIMEZONE` in `.env` overrides it | Active |
| `talkativeness` | How likely it joins a conversation it wasn't pulled into | Active |
| `ignoreDirectAsks` | Chance of leaving a direct question on read | Active |
| `maxCharsRead` | Messages longer than this are cut off before the model sees them | Active |
| `skills` | Competence per subject, compared with each question's difficulty | Active |
| `slipRate` | Chance of a mistake when working something out, never on high-stakes topics | Active |
| `maxCodeLines` | Code longer than this is never sent | Active |
| `stubbornness` | How rarely it concedes on matters of taste | Prompt only |
| `schedule` | Sleep and busy hours | Validated, milestone 5 |
| `forgetfulness` | How strong a memory must be to come to mind. Higher recalls less | Active |
| `socialBattery` | Messages per day before it gets short | Validated, milestone 5 |
| `search` | Curiosity and daily search cap | Validated, milestone 6 |
