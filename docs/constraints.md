# Human constraints and their knobs

Every setting in the persona file, and whether code acts on it yet. "Validated" means the value is checked when the file loads but nothing uses it so far.

| Knob | Controls | Status |
|---|---|---|
| `name`, `aliases` | Who counts as being addressed | Active |
| `timezone` | Local time shown to the model, as an IANA zone so daylight saving is automatic. `AKANEBOT_TIMEZONE` in `.env` overrides it | Active |
| `talkativeness` | How likely it joins a conversation it wasn't pulled into | Active |
| `ignoreDirectAsks` | Chance of leaving a direct question on read | Active |
| `maxCharsRead` | Messages longer than this are cut off before the model sees them | Active |
| `skills` | Competence per subject, compared with each question's difficulty | Active |
| `slipRate` | Chance of a mistake when working something out, never on high-stakes topics | Active |
| `maxCodeLines` | Code longer than this is never sent | Active |
| `stubbornness` | How rarely it concedes on matters of taste | Prompt only |
| `schedule` | Sleep and busy hours. While busy it only checks its phone now and then | Active |
| `schedule.busy[].mentionUrgency` | Share of the wait for the next phone check that each direct mention takes off, so repeated mentions get a reply sooner. Never wakes it from sleep | Active |
| `forgetfulness` | How strong a memory must be to come to mind. Higher recalls less | Active |
| `socialBattery` | Messages per day before it gets short with people, then stops joining in | Active |
| `dailyLife` | One is picked each morning and colours the whole day | Active |
| `search` | How curious it is about unfamiliar topics, and how many searches a day | Active |
| `lowEffort` | Chance of reacting with an emoji instead of writing something | Active |
| `repeatRate` | Chance of joining in each time it reads people repeating the same line word for word | Active |
| `savedImages.taste` | What it likes enough to keep, shown only to the model judging pictures | Prompt only |
| `savedImages.pickiness` | How much it has to like a reaction image before saving it | Active |
| `savedImages.useRate` | Chance a casual reply has its saved pictures to choose from, on an ordinary day with someone it's neutral about. A good mood and liking the person raise it, a bad mood, a grudge or a low battery lower it. It still sends one only if one fits | Active |
| `savedImages.requestRate` | The same chance when someone asks it for a picture, moved by the same things. A request skips the wait between pictures | Active |
| `savedImages.maxKept` | How many it holds at most. Past this, what it has never sent and likes least is deleted | Active |
| `reactions` | The only reactions it uses, per platform. `discord` lists emoji; `qq` maps each name to a QQ `emoji_id`, either a face ID or a decimal code point | Active |
