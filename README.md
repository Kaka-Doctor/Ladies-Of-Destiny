# Ladies Of Destiny — Daily Devotional Auto-Poster

Posts **one devotional per day at 10:00 EAT** to the **Ladies Of Destiny** Facebook page **and** its Instagram account, with captions written by **Google Gemini** in the *Lady of Destiny (Binti Mwenye Hatima ya Kimungu)* persona — languages alternating daily: **English today → Kiswahili tomorrow**, forever.

The images are **yours**: upload them to `data/photos/` and the agent uses one per day, in alphabetical order, cycling back to the first when the last is used.

---

## One-time setup (3 steps)

| # | Step | How |
|---|------|-----|
| 1 | **Connect the page** | Graph API Explorer → generate a token with `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish` → paste it into [`data/meta-token.txt`](data/meta-token.txt) → commit. The next run finds the Ladies Of Destiny page **by name**, mints its permanent (never-expiring) page token, auto-fills `data/config.json` and clears the file. |
| 2 | **Enable Gemini captions** | Repo **Settings → Secrets and variables → Actions → New repository secret** → name `GEMINI_API_KEY`, value = your key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| 3 | **Upload images** | [`data/photos/`](data/photos/README.md) → *Add file → Upload files* → drag & drop your JPG/PNG images → commit. |

After step 1, open **Actions → Ladies of Destiny Agent → Run workflow** once (any options) — the first run books the page and pre-schedules the coming days. Everything is automatic from then on.

> No token pasted yet? Everything still runs in `dryRun` to show you the plan.

---

## What a post looks like

```
𝗬𝗢𝗨 𝗔𝗥𝗘 𝗖𝗛𝗢𝗦𝗘𝗡 𝗙𝗢𝗥 𝗦𝗨𝗖𝗛 𝗔 𝗧𝗜𝗠𝗘 𝗔𝗦 𝗧𝗛𝗜𝗦          ← bold, CAPS (auto-generated)

Esther was an ordinary young woman, yet God positioned
her in the palace for a divine moment…              ← 2–3 short paragraphs,
                                                        speaking directly to ladies & girls
"…for such a time as this?" — Esther 4:14            ← one Bible verse + reference

You are chosen, daughter of the King.                ← short encouragement

#Chosen #Purpose #Courage #LadiesOfDestiny #MabintiWenyeHatima
```

Same structure in Kiswahili on Swahili days (Gemini writes both). While `data/photos/` is empty, Facebook receives the caption as a text-only post and Instagram waits for images (IG cannot post without an image) — upload at any time and the IG half joins automatically.

---

## How it stays reliable (copied from the proven sister repos)

GitHub silently drops most scheduled runs on young accounts — this agent **never depends on GitHub firing at 10:00**:

1. **Facebook — punctual by construction.** Every landed run pre-schedules the next 3 days on **Meta's own scheduler** (`scheduled_publish_time`), which publishes exactly at 10:00 EAT. One landed run every ~2 days is enough.
2. **Instagram — catch-up.** IG's API cannot schedule posts (verified live on the sister repos), so the first landed run after 10:00 publishes the IG half with the slot's pinned image + caption (usually within minutes; the retry window is 4 hours).
3. **Heartbeat.** The workflow fires every 30 min (`:13`/`:43`, off-peak minutes), so drops cost nothing — only landed runs do work.

## Daily buttons (Actions tab → "Ladies of Destiny Agent" → Run workflow)

- **dryRun** — print today's plan (language, image, caption source), publish nothing.
- **force** — post the most recent unposted slot **right now**; also the rescue button for a missed slot (same day).
- **gemini-test** — verify the `GEMINI_API_KEY` secret by writing one English + one Swahili test caption (posts nothing, changes no state).

## Controls

| Want | Do |
|------|----|
| Change posting time | `data/config.json` → `"slots": "10:00"` (EAT) |
| Pause posting | `data/config.json` → `"autoPost": false` (pending Meta posts are cancelled too) |
| Add / replace images | Upload to `data/photos/` — new ones join the rotation automatically |
| Check what is live | `node scripts/check-live-posts.mjs` locally (or read the latest run log) |
| Different Gemini model | Repo **variable** `GEMINI_MODEL` (default `gemini-2.5-flash`) |

## Repo map

```
data/config.json              ← the switch file (slots, timezone, pause, token — auto-filled)
data/state.json               ← what was posted/scheduled each day (auto-committed)
data/photos/                  ← YOUR images (one per day, alphabetical, cycling)
data/fallback-captions.json   ← 10 EN + 10 SW stored posts (used only if Gemini is unreachable)
data/meta-token.txt           ← one-paste token setup (cleared after first use)
scripts/gh-agent.mjs          ← the agent
scripts/normalize-photos.js   ← auto-crops/converts any uploaded image to IG-safe JPEG
scripts/gemini-selftest.mjs   ← the gemini-test button
scripts/check-live-posts.mjs  ← read-only live check
.github/workflows/social-agent.yml
```
