#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Ladies of Destiny — Devotional Auto-Posting Agent (GitHub Actions)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Posts ONE image + ONE caption to the Facebook page "Ladies Of Destiny" and
 *  its connected Instagram account every day at 10:00 EAT — caption language
 *  alternating daily: English one day, Kiswahili the next (owner rule
 *  2026-09-22: "if today is english tomorrow will be in swahili").
 *
 *  CAPTIONS are written by Google Gemini at booking time, following the
 *  "Lady of Destiny" (Binti Mwenye Hatima ya Kimungu) persona — a Christian
 *  content-creator ministry inspiring and empowering ladies and girls to love
 *  God deeply, live in purity, and fulfill their divine purpose. Every post:
 *    - HEADING: catchy, motivational, ALL CAPS, bold (converted to real bold
 *      characters for Facebook/Instagram)
 *    - MAIN MESSAGE: 2–3 short paragraphs, biblical + practical, talking
 *      directly to ladies and girls
 *    - SCRIPTURE: one relevant verse with its reference
 *    - HASHTAGS: three topic hashtags + #LadiesOfDestiny + #MabintiWenyeHatima
 *  Needs the GEMINI_API_KEY secret. Without it (or if Gemini fails), a
 *  pre-written fallback pool in data/fallback-captions.json keeps the page
 *  alive — posting never depends on Gemini being reachable.
 *
 *  TOPIC QUEUE (owner directive 2026-09-23): the SYSTEM assigns one topic per
 *  day from data/topics.json (the owner's 100-topic list, 8 categories) —
 *  topic #1 on day 1, #2 on day 2, … cycling every 100 days. Gemini must write
 *  about exactly that day's topic (SW days get the Swahili title, EN days the
 *  English one). If data/topics.json is missing, the agent gracefully falls
 *  back to Gemini's free theme choice.
 *
 *  IMAGES: the owner uploads her own images to data/photos/ — the agent uses
 *  one per day in SHUFFLED order (owner rule 2026-09-29: NOT alphabetical,
 *  NOT upload order — random). No image repeats until EVERY image has been
 *  used once, then the deck is reshuffled and a fresh random cycle begins,
 *  forever. While the folder is empty: Facebook gets the caption as a
 *  text-only post and Instagram waits (IG cannot post without an image).
 *
 *  RELIABILITY MODEL: GitHub silently drops most scheduled runs on young
 *  accounts. The agent therefore does NOT rely on firing at slot time. Every
 *  landed run PRE-SCHEDULES the next `scheduleDays` days with META'S OWN
 *  scheduled publishing (FB posts with scheduled_publish_time = exactly
 *  10:00 EAT, punctual by construction). Instagram halves are posted directly
 *  by landed runs SHORTLY AFTER slot time — the first landed fire after the
 *  slot publishes IG (~10:15 EAT with the :13/:43 fires) — and retries stay
 *  bounded to a BIBLIA-SIZED window (graceMinutes 240 = 10:00–14:00 EAT — the
 *  exact catch-up window Biblia Tafsiri Mbalimbali posts reliably with every
 *  single day; owner rule 2026-09-23 "not at any moment of the same day"
 *  still holds, the window is hard-bounded; IG's own API scheduling is
 *  dead — scheduled_publish_time is whitelist-gated "(#3) User must be on
 *  whitelist", re-verified live 2026-09-23). Past the window the day's IG
 *  half is SKIPPED (slot closes 'partial', event log records it — the force
 *  button can still rescue it manually); IG is never posted at arbitrary
 *  times of day. An IG attempt that FAILS mid-window (network
 *  blip, container timeout) leaves the slot OPEN ('scheduled', IG pending) so
 *  every later landed run retries it; before retrying, the live IG feed is
 *  scanned for a post already carrying the slot's caption (phantom publish or
 *  manual post) and adopted instead of double-posted. Reconcile records
 *  permalinks once posts go live.
 *
 *  MUTUAL RESCUE (owner rule 2026-09-24, "post like Biblia Tafsiri
 *  Mbalimbali"): every landed run also checks the sibling pages ("siblings"
 *  in data/config.json) through the GitHub API and dispatches a sibling's
 *  workflow when that sibling has an IG half due but no landed run of its
 *  own — API workflow_dispatches are 100% reliable, unlike cron schedules.
 *  Needs the dispatch token (data/config.json "dispatchToken", fine-grained PAT
 *  with contents:read + actions:write on the sibling repos; a DISPATCH_TOKEN
 *  repo secret would override it). A dispatched run (input rescuedBy)
 *  skips its own sibling check — one hop, no ping-pong.
 *
 *  FIRST-RUN TOKEN SETUP (one paste, no JSON editing): drop a fresh Graph API
 *  Explorer user token into data/meta-token.txt and push — the next landed
 *  run finds the "Ladies Of Destiny" page by name, mints its PERMANENT page
 *  token, auto-fills pageId / pageName / igUserId / igUsername in
 *  data/config.json, and clears the file. --dry-run works even before any
 *  token exists (it prints the content plan only).
 *
 *  State lives in data/state.json (per-day slot records + rotation counters +
 *  event log) and is committed back to the repo by the workflow.
 *
 *  Flags:  --dry-run   pick content, print the plan, publish nothing
 *          --force     post the most recent unposted slot right now (manual)
 *  Exit:   0 = ok / nothing to do, 1 = failure (red run in the Actions tab)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json')
const STATE_FILE = path.join(ROOT, 'data', 'state.json')
const PHOTOS_DIR = path.join(ROOT, 'data', 'photos')
const FALLBACK_FILE = path.join(ROOT, 'data', 'fallback-captions.json')
const TOKEN_FILE = path.join(ROOT, 'data', 'meta-token.txt')
const TOPICS_FILE = path.join(ROOT, 'data', 'topics.json')

const GRAPH = 'https://graph.facebook.com/v21.0'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash'

const ARG_DRY = process.argv.includes('--dry-run')
const ARG_FORCE = process.argv.includes('--force')
const ARG_CAPTION_TEST = process.argv.includes('--caption-test')

const log = (msg) => console.log(msg)

// ── Graph API helpers (same proven shape as the sister repos) ───────────────
async function graphGet(pathname, params) {
  const url = new URL(`${GRAPH}/${pathname}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method: 'GET' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

async function graphPost(pathname, params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) body.set(k, String(v))
  const res = await fetch(`${GRAPH}/${pathname}`, { method: 'POST', body })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

async function graphDelete(pathname, params) {
  const url = new URL(`${GRAPH}/${pathname}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method: 'DELETE' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

/** POST /{page}/photos with a binary file (multipart "source" field) */
async function fbUploadPhoto(pageId, pageToken, filePath, { caption = '', published = true } = {}) {
  const buf = await fs.readFile(filePath)
  const form = new FormData()
  if (caption) form.append('caption', caption)
  form.append('published', published ? 'true' : 'false')
  form.append('access_token', pageToken)
  form.append('source', new Blob([buf], { type: 'image/jpeg' }), path.basename(filePath))
  const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

/** POST /{page}/feed — text-only post (used when data/photos/ is empty) */
async function fbPostText(page, caption) {
  const json = await graphPost(`${page.pageId}/feed`, {
    message: caption.slice(0, 5000),
    access_token: page.pageToken,
  })
  return String(json.id ?? '')
}

/** POST /{page}/feed — text-only SCHEDULED post (Meta publishes at the exact time) */
async function fbScheduleText(page, caption, publishTimeUnixSec) {
  const json = await graphPost(`${page.pageId}/feed`, {
    message: caption.slice(0, 5000),
    published: 'false',
    scheduled_publish_time: String(publishTimeUnixSec),
    access_token: page.pageToken,
  })
  return String(json.id ?? '')
}

// ── Connect: page-token first, user-token exchange (with page auto-discovery)
// as fallback. The owner pastes a fresh Graph API Explorer token into
// data/meta-token.txt; the page is found by its NAME ("Ladies Of Destiny")
// so no manual id lookup is ever needed. ────────────────────────────────────
async function connect(cfg) {
  const enableIG = String(cfg.platforms ?? 'facebook,instagram').toLowerCase().includes('instagram')
  // 1) permanent page token from config
  if (cfg.pageAccessToken && cfg.pageId) {
    try {
      const me = await graphGet(cfg.pageId, {
        fields: enableIG ? 'name,username,instagram_business_account{id,username}' : 'name',
        access_token: cfg.pageAccessToken,
      })
      const ig = me.instagram_business_account ?? {}
      log(`[connect] page token (permanent): valid → ${me.name}${enableIG ? ` | IG: @${ig.username ?? 'none'}` : ' | FB-only'}`)
      return {
        via: 'page-token',
        page: {
          pageId: cfg.pageId,
          pageName: String(me.name ?? ''),
          pageUsername: String(me.username ?? ''),
          pageToken: cfg.pageAccessToken,
          igUserId: enableIG ? String(ig.id ?? cfg.igUserId ?? '') : '',
          igUsername: enableIG ? String(ig.username ?? '') : '',
        },
      }
    } catch (e) {
      log(`[connect] permanent page token failed (${e.message}) — trying user-token exchange`)
    }
  }
  // 2) rotation path: exchange user token → pages → page token.
  let token = String(cfg.metaUserToken || '').trim()
  let tokenFromFile = false
  if (!token) {
    token = (await fs.readFile(TOKEN_FILE, 'utf-8').catch(() => '')).trim()
    if (token) {
      tokenFromFile = true
      log('[connect] found user token in data/meta-token.txt — minting the permanent page token')
    }
  }
  if (!token) {
    throw new Error('No working token yet: paste a fresh Graph API Explorer token into data/meta-token.txt and push (the agent finds the Ladies Of Destiny page, mints the permanent page token and clears the file on its next run) — or put it in metaUserToken in data/config.json')
  }
  if (cfg.appId && cfg.appSecret) {
    try {
      const ex = await graphGet('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: token,
      })
      if (ex.access_token) token = String(ex.access_token)
    } catch { /* keep raw token */ }
  }
  try {
    const pages = await graphGet('me/accounts', {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      access_token: token,
      limit: '50',
    })
    const list = (pages.data ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      accessToken: String(p.access_token),
      igUserId: p.instagram_business_account ? String(p.instagram_business_account.id) : '',
      igUsername: p.instagram_business_account ? String(p.instagram_business_account.username) : '',
    }))
    // page selection: exact id → name hint ("ladies of destiny") → IG username → the only page
    const hintWords = String(cfg.pageNameHint ?? 'Ladies Of Destiny').toLowerCase().split(/\s+/).filter(Boolean)
    const page =
      list.find((p) => cfg.pageId && p.id === cfg.pageId) ??
      list.find((p) => hintWords.length > 0 && hintWords.every((w) => p.name.toLowerCase().includes(w))) ??
      list.find((p) => cfg.igUsername && p.igUsername === cfg.igUsername) ??
      (list.length === 1 ? list[0] : null)
    if (!page) {
      const names = list.map((p) => `"${p.name}" (${p.id})`).join(', ')
      throw new Error(`No page matching "${cfg.pageNameHint ?? 'Ladies Of Destiny'}" is visible to this token (found: ${names || 'none'}). Paste a token that can manage the Ladies Of Destiny page, or put its page id in data/config.json → pageId.`)
    }
    log(`[connect] user-token path → ${page.name} (${page.id})${page.igUserId ? ` | IG: @${page.igUsername}` : ' | no IG linked to this page'}`)
    return {
      via: 'exchange',
      tokenFromFile,
      userToken: true,
      sourceToken: token,
      page: {
        pageId: page.id,
        pageName: page.name,
        pageUsername: '',
        pageToken: page.accessToken,
        igUserId: enableIG ? page.igUserId : '',
        igUsername: enableIG ? page.igUsername : '',
      },
    }
  } catch (e) {
    // 3) the pasted token might already BE a page token (not a user token)
    if (cfg.pageId) {
      const me = await graphGet(cfg.pageId, { fields: 'name', access_token: token }).catch(() => null)
      if (me && me.name) {
        log(`[connect] token works directly as the page token → ${me.name}`)
        return {
          via: 'exchange',
          tokenFromFile,
          userToken: false,
          sourceToken: token,
          page: { pageId: cfg.pageId, pageName: String(me.name), pageUsername: '', pageToken: token, igUserId: '', igUsername: '' },
        }
      }
    }
    throw new Error(`${e.message} — and the token does not work as a page token either. Generate a fresh token in the Graph API Explorer (with pages_show_list + pages_manage_posts + pages_read_engagement + instagram_content_publish) and paste it into data/meta-token.txt`)
  }
}

// ── Time / slots ─────────────────────────────────────────────────────────────
function localNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '0'
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + minute,
  }
}

function parseSlots(str) {
  return String(str || '10:00')
    .split(',')
    .map((s) => s.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter(Boolean)
    .map((m) => ({
      minutes: Number(m[1]) * 60 + Number(m[2]),
      label: `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`,
    }))
    .sort((a, b) => a.minutes - b.minutes)
}

// ── Images: data/photos/ SHUFFLED-DECK rotation (one per day) ───────────────
// Owner rule (2026-09-29): images must NOT run in name/upload order. Each
// day's image is drawn from a shuffled deck: RANDOM order, and NO image
// repeats until EVERY image has been used once — then the deck is reshuffled
// and a new random cycle begins, forever (like cards: shuffle, deal them
// all, reshuffle, repeat). The deck records the WHOLE cycle order with a deal
// position, so a used photo can never be re-dealt within the same cycle.
// New uploads join the UNDEALT part of the current cycle at a random
// position (so they don't wait a full cycle); deleted files drop out
// automatically (the deal position self-adjusts).
// State: rotation.deck = full shuffled order of the current cycle,
// rotation.deckPos = how many have been dealt so far,
// rotation.deckEpoch = current cycle number (log line only). The legacy
// rotation.photo counter is ignored — the first run with this code starts a
// brand-new shuffled cycle.
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function getPhotos() {
  const all = await fs.readdir(PHOTOS_DIR).catch(() => [])
  const jpgs = all.filter((f) => /\.jpe?g$/i.test(f)).sort()
  const pending = all.filter((f) => /\.(png|webp)$/i.test(f))
  return { jpgs, pending }
}

function ensureDeck(state, jpgs) {
  const have = new Set(jpgs ?? [])
  const oldDeck = Array.isArray(state.rotation.deck) ? state.rotation.deck : []
  let pos = Number(state.rotation.deckPos ?? 0)
  if (!Number.isFinite(pos) || pos < 0) pos = 0
  if (pos > oldDeck.length) pos = oldDeck.length
  // 1) drop files that no longer exist; a deletion BEFORE the deal position
  //    shifts the frontier left so already-dealt photos stay dealt
  const deck = []
  oldDeck.forEach((f, i) => {
    if (have.has(f)) deck.push(f)
    else if (i < pos) pos--
  })
  // 2) cycle exhausted (or fresh/empty) → deal a full new shuffled cycle
  if (pos >= deck.length && have.size > 0) {
    deck.length = 0
    deck.push(...shuffle([...have]))
    pos = 0
    state.rotation.deckEpoch = Number(state.rotation.deckEpoch ?? 0) + 1
  }
  // 3) newly uploaded photos join the UNDEALT part of the current cycle
  for (const f of shuffle([...have])) {
    if (!deck.includes(f)) {
      const at = pos + Math.floor(Math.random() * (deck.length - pos + 1))
      deck.splice(at, 0, f)
    }
  }
  state.rotation.deck = deck
  state.rotation.deckPos = pos
  return deck
}

function peekPhoto(state, jpgs) {
  if (!jpgs || jpgs.length === 0) return null
  const deck = ensureDeck(state, jpgs)
  return deck[Number(state.rotation.deckPos ?? 0)] ?? null
}

function advancePhoto(state, jpgs) {
  if (!jpgs || jpgs.length === 0) return
  ensureDeck(state, jpgs)
  state.rotation.deckPos = Number(state.rotation.deckPos ?? 0) + 1
  ensureDeck(state, jpgs) // cycle exhausted → reshuffle, new cycle begins
}

// ── Daily topic queue (data/topics.json — the owner's 100-topic list) ────────
// One topic per day in file order, cycling every `topics.length` days.
// SW days use the Swahili title, EN days the English one. Missing/empty file
// → null → the persona falls back to free theme choice (graceful degrade).
async function loadTopics() {
  try {
    const d = JSON.parse(await fs.readFile(TOPICS_FILE, 'utf-8'))
    const list = Array.isArray(d) ? d : d.topics ?? []
    return list
      .filter((t) => t && t.en && t.sw)
      .map((t, i) => ({
        n: Number(t.n) || i + 1,
        cat: String(t.cat ?? ''),
        en: String(t.en),
        sw: String(t.sw),
      }))
  } catch {
    return []
  }
}

function peekTopic(state, topics) {
  return topics.length > 0 ? topics[Number(state.rotation.topic ?? 0) % topics.length] : null
}

function advanceTopic(state, topics) {
  if (topics.length > 0) state.rotation.topic = (Number(state.rotation.topic ?? 0) + 1) % topics.length
}

// ── Fallback caption pool (used only without GEMINI_API_KEY / on Gemini failure)
async function loadFallbacks() {
  try {
    const d = JSON.parse(await fs.readFile(FALLBACK_FILE, 'utf-8'))
    return { posts: (d.posts ?? []).filter((p) => p && p.lang && p.text) }
  } catch {
    return { posts: [] }
  }
}

function fallbackKey(lang) { return lang === 'sw' ? 'fallbackSw' : 'fallbackEn' }

function pickFallback(state, fallbacks, lang) {
  const pool = fallbacks.posts.filter((p) => p.lang === lang)
  if (pool.length === 0) return null
  const idx = Number(state.rotation[fallbackKey(lang)] ?? 0) % pool.length
  return { text: pool[idx].text, idx, poolSize: pool.length }
}

function advanceFallback(state, fallbacks, lang) {
  const pool = fallbacks.posts.filter((p) => p.lang === lang)
  if (pool.length === 0) return
  state.rotation[fallbackKey(lang)] = (Number(state.rotation[fallbackKey(lang)] ?? 0) + 1) % pool.length
}

// ── Bold heading for social media (Unicode bold — renders bold on FB & IG) ──
function toBoldLine(line) {
  const CAP = 0x1d5d4, LOW = 0x1d5ee, DIG = 0x1d7ec
  let out = ''
  for (const ch of line) {
    const c = ch.codePointAt(0)
    if (c >= 65 && c <= 90) out += String.fromCodePoint(CAP + c - 65)
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(LOW + c - 97)
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(DIG + c - 48)
    else out += ch
  }
  return out
}

function boldFirstHeading(caption, enabled) {
  if (!enabled) return caption
  const lines = caption.split('\n')
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (lines[i].trim()) { lines[i] = toBoldLine(lines[i]); break }
  }
  return lines.join('\n')
}

// ── Language alternation (owner rule: English today, Kiswahili tomorrow) ────
function lastPostedLang(state) {
  const dayKeys = Object.keys(state.days ?? {}).sort().reverse()
  for (const dk of dayKeys) {
    const slots = Object.entries(state.days[dk]).sort((a, b) => b[0].localeCompare(a[0]))
    for (const [, rec] of slots) {
      if (rec?.lang === 'en' || rec?.lang === 'sw') return rec.lang
    }
  }
  return null
}
function oppositeLang(lang) { return lang === 'sw' ? 'en' : 'sw' }

/** Language of the most recent posted/booked slot STRICTLY BEFORE (dateKey, slotLabel).
 *  Chronological — a force-rescue of an older missed slot still gets the right
 *  language even when newer slots are already booked. */
function langBefore(state, dateKey, slotLabel) {
  const dayKeys = Object.keys(state.days ?? {}).sort().reverse()
  for (const dk of dayKeys) {
    if (dk > dateKey) continue
    const entries = Object.entries(state.days[dk] ?? {}).sort((a, b) => b[0].localeCompare(a[0]))
    for (const [label, rec] of entries) {
      if (dk === dateKey && label >= slotLabel) continue
      if (rec?.lang === 'en' || rec?.lang === 'sw') return rec.lang
    }
  }
  return null
}

/** Language for a given slot: opposite of whatever came right before it.
 *  A fresh repo starts with English. */
function slotLang(state, dateKey, slotLabel) {
  return oppositeLang(langBefore(state, dateKey, slotLabel) ?? 'sw')
}

/** Next slot's language: opposite of the most recent slot's language.
 *  A fresh repo starts with English. */
function nextSlotLang(state) {
  return oppositeLang(lastPostedLang(state) ?? 'sw')
}

/** Last few posted headings, so Gemini does not repeat itself. */
function recentHeadings(state, n = 6) {
  const out = []
  const dayKeys = Object.keys(state.days ?? {}).sort().reverse()
  for (const dk of dayKeys) {
    for (const [, rec] of Object.entries(state.days[dk])) {
      const first = String(rec?.caption ?? '').split('\n').find((l) => l.trim())
      if (first) out.push(first.trim().slice(0, 80))
      if (out.length >= n) return out
    }
  }
  return out
}

// ── Google Gemini — the "Lady of Destiny" caption writer ────────────────────
/** Build the persona prompt in the requested language. The persona is the
 *  owner's ministry brief (2026-09-22), applied verbatim to structure, tone,
 *  audience and hashtags. When `topic` is given (data/topics.json queue), the
 *  post MUST be about that exact topic — the free-choice menu is only the
 *  graceful fallback when no topics file exists. */
function buildPersonaPrompt(lang, avoidList, topic) {
  const avoid = avoidList.length > 0 ? avoidList.join(' | ') : 'none yet (this is your first post)'
  if (lang === 'sw') {
    const topicLine = topic
      ? `MADA YA LEO (andika kuhusu mada hii hasa, usibadilishe): "${topic.sw}".`
      : 'Chagua mada moja kutoka: kumpenda Mungu, urembo wa ndani, lenzo, maombi, imani, usafi, hatima, ujasiri, kujithamini, utumishi, uongozi, wema, msamaha, kutembea kwa Roho.'
    return (
      'Wewe ni "Lady of Destiny" (Binti Mwenye Hatima ya Kimungu) — huduma ya Kikristo ya kuandika maudhui, inayojitolea ' +
      'kuhamasisha na kuwezesha binti (wanawake wachanga) na wasichana kumpenda Mungu kwa dhati, kuishi maisha ya usafi, ' +
      'na kutimiza wajibu wao wa kimungu. Unaandika machapisho ya kiroho na ya kuhamasisha kwa Facebook na Instagram ' +
      'ili kuwasaidia binti kukua katika imani, tabia, kujiamini, na utumishi kwa utukufu wa Mungu.\n\n' +
      'Andika chapisho MOJA kamili la leo, tayari kutumiwa mitandaoni, kwa MUUNDO HUU KABISA:\n' +
      '1. KICHWA — mstari mmoja, unaovutia na kuhamasisha, HERUFI KUBWA ZOTE, unaohusiana na ujumbe.\n' +
      '2. UJUMBE MKUU — aya 2-3 fupi (sentensi 2-3 kila moja) zinazoeleza mada kwa Neno la Mungu na kwa maisha ya kila siku. ' +
      'Zungumza moja kwa moja na binti na wasichana — wafikilie, wahamasishe, waulize kama dada yao; wajue unazungumza nao.\n' +
      '3. ANDIKO — andiko moja la Biblia linalounga mkono mada; nukuu kwa usahihi pamoja na rejea yake (mfano: Zaburi 139:14).\n' +
      '4. HASHTAG — hashtag TATU zinazohusiana na mada, zikifatiwa na #LadiesOfDestiny na #MabintiWenyeHatima.\n\n' +
      'Sauti: mpole, unaohamasisha, wa udugu (kama dada), wenye imani — jaa upendo, uchangamfu na uhamasishaji. ' +
      'Tumia lugha rahisi inayogusa moyo. Ongeza hima fupi kama "Umekaguliwa", "Endelea kuang\'aa", au "Mungu ana mpango wako". ' +
      'Epuka maelezo marefu ya teolojia — iwe mahudumio, ya karibu, yenye kiongozwa na Roho.\n\n' +
      `${topicLine}\n\n` +
      'LUGHA: Andika chapisho NZIMA kwa Kiswahili sanifu — kichwa, ujumbe, andiko (toleo la Kiswahili la Biblia) na hashtag zote.\n\n' +
      `Mada/vichwa vya hivi karibuni (USIRUDIE): ${avoid}\n\n` +
      'Jibu na maandishi ya chapisho PEKEE — bila maelezo mengine kabla au baada, bila markdown, bila nyota, maandishi wazi tu.'
    )
  }
  return (
    'You are a "Lady of Destiny" (Binti Mwenye Hatima ya Kimungu) — a Christian content-creator ministry dedicated to inspiring ' +
    'and empowering ladies (young women) and girls to love God deeply, live in purity, and fulfill their divine purpose. ' +
    'You write motivational and biblical posts for Facebook and Instagram that help girls grow in faith, character, ' +
    'confidence, and service for God\'s glory.\n\n' +
    'Write ONE complete post for today, ready for social media, with EXACTLY this structure:\n' +
    '1. HEADING — one line, catchy and motivational, ALL IN CAPITAL LETTERS, related to the message below.\n' +
    '2. MAIN MESSAGE — 2-3 short paragraphs (2-3 sentences each) explaining the theme biblically and practically. ' +
    'Speak directly to ladies and girls — talk TO them, encourage them, address them as your sisters; make sure they know you are talking to them.\n' +
    '3. SCRIPTURE — one relevant Bible verse that supports the theme, quoted clearly with its reference.\n' +
    '4. HASHTAGS — exactly three hashtags related to the topic, followed by #LadiesOfDestiny and #MabintiWenyeHatima.\n\n' +
    'Tone: gentle, encouraging, sisterly, and faith-filled — speak with love, warmth, and inspiration. ' +
    'Use simple language that touches the heart. Add one short encouragement such as "You are chosen", "Keep shining", ' +
    'or "God has a plan for you". Avoid long theological explanations — make it devotional and relatable, personal and Spirit-led.\n\n' +
    (topic
      ? `TODAY'S ASSIGNED TOPIC (write about exactly this topic, do not swap it for another): "${topic.en}". Category: ${topic.cat || 'general'}.`
      : 'Choose one theme from: love for God, inner beauty, purpose, prayer, faith, purity, destiny, courage, self-worth, ministry, leadership, kindness, forgiveness, walking in the Spirit.') +
    '\n\n' +
    'LANGUAGE: Write the ENTIRE post in English — heading, message, scripture, and all hashtags.\n\n' +
    `Recent headings/themes (do NOT repeat them): ${avoid}\n\n` +
    'Output ONLY the post text — no explanations before or after, no markdown, no asterisks, plain text only.'
  )
}

/** Ask Gemini for today's post in `lang`. Returns null (→ fallback) on any
 *  failure so posting never depends on Gemini being reachable.
 *  Retries once (8s apart): gemini-2.5-flash occasionally returns HTTP 200
 *  with an empty body (thinking budget quirk / transient throttle) — seen
 *  live 2026-09-22 during 3-in-a-row horizon bookings. */
async function geminiGeneratePost(lang, state, topic) {
  const key = String(process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return null
  const model = String(process.env.GEMINI_MODEL ?? GEMINI_MODEL_DEFAULT).trim() || GEMINI_MODEL_DEFAULT
  const prompt = buildPersonaPrompt(lang, recentHeadings(state), topic)
  const callOnce = async () => {
    const res = await fetch(
      `${GEMINI_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // generous budget: 2.5-flash counts thinking tokens against it
          generationConfig: { maxOutputTokens: 8192, temperature: 1 },
        }),
        signal: AbortSignal.timeout(60000),
      }
    )
    const json = await res.json().catch(() => ({}))
    const text = String(json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim()
    if (!res.ok || !text) {
      const reason = json?.candidates?.[0]?.finishReason
      throw new Error(json?.error?.message ?? (reason ? `empty output (finishReason ${reason})` : `HTTP ${res.status}`))
    }
    // validation: both brand hashtags, a sane length, multi-block structure
    const newlines = (text.match(/\n/g) ?? []).length
    if (!text.includes('#LadiesOfDestiny') || !text.includes('#MabintiWenyeHatima') || text.length < 250 || text.length > 2000 || newlines < 4) {
      throw new Error('output failed validation (hashtags/length/structure)')
    }
    return text
  }
  try {
    let text = ''
    try {
      text = await callOnce()
    } catch (first) {
      log(`[gemini] first attempt failed (${first.message}) — retrying once in 8s`)
      await new Promise((r) => setTimeout(r, 8000))
      text = await callOnce()
    }
    log(`[gemini] caption written with Google Gemini (${model}, ${lang === 'sw' ? 'Kiswahili' : 'English'})`)
    return text
  } catch (e) {
    log(`[gemini] caption generation failed (${e.message}) — using the fallback pool`)
    return null
  }
}

/** Final caption for a slot: Gemini (persona, on the day's assigned topic) →
 *  fallback pool → built-in. The fallback pool stays topic-agnostic (used only
 *  when Gemini is unavailable, so a down API never stops the page). */
async function captionForSlot(lang, state, fallbacks, boldEnabled, topic) {
  const gen = await geminiGeneratePost(lang, state, topic)
  if (gen) return { text: boldFirstHeading(gen, boldEnabled), source: 'gemini' }
  const fb = pickFallback(state, fallbacks, lang)
  if (fb) {
    advanceFallback(state, fallbacks, lang)
    log(`[caption] fallback post ${fb.idx + 1}/${fb.poolSize} from data/fallback-captions.json (${lang === 'sw' ? 'Kiswahili' : 'English'}) — add the GEMINI_API_KEY secret to switch to live Gemini captions`)
    return { text: boldFirstHeading(fb.text, boldEnabled), source: 'fallback' }
  }
  const builtin =
    lang === 'sw'
      ? 'BINTI WA MFALME, UNAANG\'AA\n\nMungu anakupenda na ana mpango mwema kwa ajili yako. Usiogope kumtegemea kwa moyo wako wote — Yeye anakuona, anakujua, na anakutanguliza.\n\n"Kwa maana mimi najua mawazo ninayo kwa habari zenu, asema BWANA, mawazo ya amani, si ya mabaya, ili kuwapa tumaini na mwisho mwema." — Yeremia 29:11\n\nEndelea kuang\'aa, binti wa Mungu.\n\n#Tumaini #Imani #Hatima #LadiesOfDestiny #MabintiWenyeHatima'
      : 'DAUGHTER OF THE KING, KEEP SHINING\n\nGod loves you and He has a good plan for your life. Trust Him with all your heart — He sees you, He knows you, and He goes before you.\n\n"\'For I know the plans I have for you,\' declares the LORD, \'plans to prosper you and not to harm you, plans to give you hope and a future.\'" — Jeremiah 29:11\n\nYou are chosen. Keep shining.\n\n#Hope #Faith #Destiny #LadiesOfDestiny #MabintiWenyeHatima'
  return { text: boldFirstHeading(builtin, boldEnabled), source: 'builtin' }
}

// ── State (data/state.json, committed back by the workflow) ─────────────────
const EMPTY_STATE = { version: 1, days: {}, rotation: { photo: 0, topic: 0, fallbackEn: 0, fallbackSw: 0, deck: [], deckPos: 0, deckEpoch: 0 }, events: [] }
async function readState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'))
    const rotation = { ...EMPTY_STATE.rotation }
    for (const k of Object.keys(rotation)) {
      if (k === 'deck') continue // array of filenames — copied below, not a counter
      const v = Number(s.rotation?.[k])
      if (Number.isFinite(v) && v >= 0) rotation[k] = Math.floor(v)
    }
    // the shuffled-deck order survives restarts verbatim (validated against
    // the actual photos folder by ensureDeck on every use)
    if (Array.isArray(s.rotation?.deck)) rotation.deck = s.rotation.deck.filter((f) => typeof f === 'string')
    return { ...EMPTY_STATE, ...s, rotation }
  } catch {
    return JSON.parse(JSON.stringify(EMPTY_STATE))
  }
}
async function writeState(state) {
  state.events = state.events.slice(-100)
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}
function recordEvent(state, ev) {
  state.events.push({ ts: new Date().toISOString(), ...ev })
}

// ── Duplicate guard (cross-runtime safety net) ──────────────────────────────
// ⚠ IG /media lists SCHEDULED-but-unpublished containers too, with timestamp =
// CREATION time — the guard would misread our own horizon booking as "a post
// just went out". Fix: ignore IG media ids that state.json itself recorded.
async function minutesSinceLastPost(page, state) {
  const cutoff = Date.now() - 7 * 86400000
  const future = Date.now() + 60000 // ignore future timestamps (scheduled posts)
  const scheduledIgIds = new Set()
  for (const day of Object.values(state?.days ?? {})) {
    for (const rec of Object.values(day ?? {})) {
      if (rec?.status === 'scheduled' && rec?.ig?.id) scheduledIgIds.add(String(rec.ig.id))
    }
  }
  try {
    if (page.igUserId) {
      const json = await graphGet(`${page.igUserId}/media`, { fields: 'id,timestamp', limit: '10', access_token: page.pageToken })
      const ts = (json.data ?? [])
        .filter((m) => !scheduledIgIds.has(String(m.id)))
        .map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).filter((t) => t < future)
      const latest = Math.max(...ts, 0)
      if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
      return null
    }
  } catch { /* fall through */ }
  try {
    const json = await graphGet(`${page.pageId}/posts`, { fields: 'created_time', limit: '3', access_token: page.pageToken })
    const ts = (json.data ?? []).map((p) => (p.created_time ? new Date(p.created_time).getTime() : 0)).filter(Boolean).filter((t) => t < future)
    const latest = Math.max(...ts, 0)
    if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
  } catch { /* unknown — do not block */ }
  return null
}

/** IG-only guard variant (FB twin publishes via Meta at slot time and would
 *  false-positive a whole-page guard check). State-recorded IG ids excluded. */
async function minutesSinceLastIgPost(page, state) {
  const cutoff = Date.now() - 7 * 86400000
  const future = Date.now() + 60000
  const knownIgIds = new Set()
  for (const day of Object.values(state?.days ?? {})) {
    for (const rec of Object.values(day ?? {})) {
      if (rec?.ig?.id) knownIgIds.add(String(rec.ig.id))
    }
  }
  try {
    const json = await graphGet(`${page.igUserId}/media`, { fields: 'id,timestamp', limit: '10', access_token: page.pageToken })
    const ts = (json.data ?? [])
      .filter((m) => !knownIgIds.has(String(m.id)))
      .map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).filter((t) => t < future)
    const latest = Math.max(...ts, 0)
    if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
  } catch { /* unknown — do not block */ }
  return null
}

/** Robustness (owner rule 2026-09-23: "if it's time for posting it must post to
 *  both fb and IG"): look for THIS slot's caption already live on the IG feed
 *  before (re)publishing the IG half. Covers a media_publish timeout that
 *  actually succeeded server-side (phantom post — a blind retry would
 *  DOUBLE-post), and a manual post of the same content. Matches the first 100
 *  caption chars (the bold heading line makes each slot's caption unique) and
 *  only media newer than sinceMs. Returns { id, permalink } or null. */
async function findMatchingIgPost(page, caption, sinceMs) {
  if (!page.igUserId) return null
  const key = String(caption ?? '').slice(0, 100).trim()
  if (!key) return null
  try {
    const json = await graphGet(`${page.igUserId}/media`, { fields: 'id,timestamp,caption,permalink', limit: '10', access_token: page.pageToken })
    for (const m of json.data ?? []) {
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
      if (sinceMs && ts && ts < sinceMs) continue
      if (String(m.caption ?? '').slice(0, 100).trim() === key) {
        return { id: String(m.id), permalink: String(m.permalink ?? '') }
      }
    }
  } catch { /* unknown — do not block */ }
  return null
}

// ── Publish (IG via Meta CDN, FB via binary upload or text-only feed post) ──
async function publishInstagram(page, photoPath, caption) {
  const steps = []
  let helperPhotoId = ''
  try {
    // 1) hidden FB photo → public CDN URL
    const up = await fbUploadPhoto(page.pageId, page.pageToken, photoPath, { published: false })
    helperPhotoId = String(up.id ?? '')
    steps.push(`helper photo ${helperPhotoId} uploaded (unpublished)`)
    const info = await graphGet(helperPhotoId, { fields: 'images', access_token: page.pageToken })
    const images = (info.images ?? []).slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    const cdnUrl = String(images[0]?.source ?? '')
    if (!cdnUrl) throw new Error('no CDN URL on the helper photo')
    steps.push(`CDN url ok (${images[0].width}px)`)

    // 2) IG container → poll → publish
    const container = await graphPost(`${page.igUserId}/media`, {
      image_url: cdnUrl,
      caption: caption.slice(0, 2200),
      access_token: page.pageToken,
    })
    const creationId = String(container.id ?? '')
    if (!creationId) throw new Error('no container id returned')
    steps.push(`container ${creationId}`)
    let ready = false
    for (let i = 0; i < 10; i++) {
      const status = await graphGet(creationId, { fields: 'status_code', access_token: page.pageToken })
      const code = String(status.status_code ?? '')
      if (code === 'FINISHED') { ready = true; break }
      if (code === 'ERROR') throw new Error('Instagram could not process the image')
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (!ready) throw new Error('image processing timed out (try a smaller JPEG)')
    steps.push('container FINISHED')

    const published = await graphPost(`${page.igUserId}/media_publish`, { creation_id: creationId, access_token: page.pageToken })
    const postId = String(published.id ?? '')
    let permalink = ''
    try {
      const info2 = await graphGet(postId, { fields: 'permalink', access_token: page.pageToken })
      permalink = String(info2.permalink ?? '')
    } catch { /* best-effort */ }
    steps.push(`published ${postId}`)
    return { ok: true, postId, permalink, error: '', steps }
  } catch (e) {
    return { ok: false, postId: '', permalink: '', error: e.message, steps }
  } finally {
    if (helperPhotoId) {
      try { await graphDelete(helperPhotoId, { access_token: page.pageToken }) } catch { /* best-effort cleanup */ }
    }
  }
}

async function publishFacebook(page, photoPath, caption) {
  try {
    let postId = ''
    if (photoPath) {
      const json = await fbUploadPhoto(page.pageId, page.pageToken, photoPath, {
        caption: caption.slice(0, 5000),
        published: true,
      })
      postId = String(json.post_id ?? json.id ?? '')
    } else {
      postId = await fbPostText(page, caption)
    }
    let permalink = ''
    try {
      const info = await graphGet(postId, { fields: 'permalink_url', access_token: page.pageToken })
      permalink = String(info.permalink_url ?? '')
    } catch { /* best-effort */ }
    return { ok: true, postId, permalink, error: '' }
  } catch (e) {
    return { ok: false, postId: '', permalink: '', error: e.message }
  }
}

// ── Meta-scheduled publishing (the reliability core) ────────────────────────
// FB ONLY: post with published=false + scheduled_publish_time — Meta publishes
// exactly at 10:00 EAT; GitHub's schedule drops become irrelevant for FB.
// IG has NO API scheduling (publish_time is SILENTLY IGNORED, verified live on
// the sister repos; scheduled_publish_time is whitelist-gated). IG halves are
// posted directly by landed runs in each slot's catch-up window instead.
async function scheduleFacebookPost(page, photoPath, caption, publishTimeUnixSec) {
  try {
    let postId = ''
    if (photoPath) {
      const buf = await fs.readFile(photoPath)
      const form = new FormData()
      if (caption) form.append('caption', caption.slice(0, 5000))
      form.append('published', 'false')
      form.append('scheduled_publish_time', String(publishTimeUnixSec))
      form.append('access_token', page.pageToken)
      form.append('source', new Blob([buf], { type: 'image/jpeg' }), path.basename(photoPath))
      const res = await fetch(`${GRAPH}/${page.pageId}/photos`, { method: 'POST', body: form })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      postId = String(json.id ?? '')
    } else {
      postId = await fbScheduleText(page, caption, publishTimeUnixSec)
    }
    return { ok: true, postId, error: '' }
  } catch (e) {
    return { ok: false, postId: '', error: e.message }
  }
}

/** Confirm Meta-scheduled FB posts that went live → record permalinks.
 *  Slots whose IG half was deliberately skipped (no image yet) close as
 *  FB-only days; slots whose IG catch-up window lapsed close as 'partial'. */
async function reconcileScheduled(page, state, graceMinutes) {
  let changed = false
  for (const [dk, day] of Object.entries(state.days ?? {})) {
    for (const [label, rec] of Object.entries(day ?? {})) {
      if (rec?.status !== 'scheduled' || !rec.publishTime) continue
      const due = new Date(rec.publishTime).getTime()
      if (Date.now() < due + 5 * 60000) continue // not due yet
      // (a) FB confirmation: scheduled post flips to a feed post with a permalink
      if (rec.fb?.id && !rec.fb.permalink) {
        for (const cid of [String(rec.fb.id), `${page.pageId}_${String(rec.fb.id)}`]) {
          try {
            const p = await graphGet(cid, { fields: 'permalink_url,created_time', access_token: page.pageToken })
            if (p.permalink_url && p.created_time && new Date(p.created_time).getTime() <= Date.now() + 60000) {
              rec.fb = { id: cid, permalink: String(p.permalink_url) }
              changed = true
              break
            }
          } catch { /* not confirmable via this id yet */ }
        }
      }
      const igDone = Boolean(rec.ig?.id)
      const igSkipped = Boolean(rec.ig?.skipped)
      if (igDone || igSkipped) {
        rec.status = 'published'
        rec.at = rec.publishTime
        recordEvent(state, {
          level: 'success',
          date: dk,
          slot: label,
          message: igSkipped
            ? `${label} completed — FB live${rec.ig?.skipped ? ` (IG skipped: ${rec.ig.skipped})` : ''}`
            : `${label} completed — FB (Meta) + IG (catch-up) both live`,
        })
        changed = true
      } else if (Date.now() > due + graceMinutes * 60000) {
        rec.status = 'partial'
        rec.at = rec.publishTime
        recordEvent(state, { level: 'error', date: dk, slot: label, message: `${label} partial — FB published by Meta on time, but no landed run caught up the IG half within ${graceMinutes} min` })
        changed = true
      }
    }
  }
  return changed
}

/** Pause switch: delete pending scheduled posts from Meta so autoPost:false stops everything. */
async function cancelPendingScheduled(page, state) {
  let cancelled = 0
  for (const [dk, day] of Object.entries(state.days ?? {})) {
    for (const [label, rec] of Object.entries(day ?? {})) {
      if (rec?.status !== 'scheduled' || !rec.publishTime) continue
      if (new Date(rec.publishTime).getTime() < Date.now()) continue
      const removed = []
      if (rec.ig?.id) { try { await graphDelete(String(rec.ig.id), { access_token: page.pageToken }); removed.push('IG') } catch { /* already gone */ } }
      if (rec.fb?.id) { try { await graphDelete(String(rec.fb.id), { access_token: page.pageToken }); removed.push('FB') } catch { /* already gone */ } }
      if (removed.length > 0) {
        rec.status = 'cancelled'
        rec.at = new Date().toISOString()
        recordEvent(state, { level: 'info', date: dk, slot: label, message: `${label} cancelled (autoPost=false) — removed from Meta: ${removed.join(' + ')}` })
        cancelled++
      }
    }
  }
  return cancelled
}

/** Wall-clock (dateKey + minutesOfDay) in `timeZone` → UTC epoch ms. 2-pass Intl convergence. */
function zonedToUtc(dateKey, minutesOfDay, timeZone) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const wallMs = Date.UTC(y, mo - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  let ts = wallMs
  for (let i = 0; i < 3; i++) {
    const parts = fmt.formatToParts(new Date(ts))
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
    if (asUTC === wallMs) break
    ts += wallMs - asUTC
  }
  return ts
}

/** Upcoming slots across `scheduleDays` days that have no state entry yet. */
function buildHorizon(state, slots, now, tz, scheduleDays) {
  const plan = []
  const minUnix = Date.now() + 20 * 60000 // Meta needs ≥ 10 min lead; use 20 for safety
  for (let d = 0; d < scheduleDays; d++) {
    const dk = d === 0 ? now.date : addDaysKey(now.date, d)
    for (const s of slots) {
      if (state.days[dk]?.[s.label]) continue
      const slotUnix = zonedToUtc(dk, s.minutes, tz)
      if (slotUnix < minUnix) continue
      plan.push({ dk, slot: s, slotUnix })
    }
  }
  return plan
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))

  // ── Actions-secrets override (public-repo secret hygiene, owner rule
  // 2026-10-17): the four Meta credentials below can live in ENCRYPTED
  // GitHub Actions repo secrets (Settings → Secrets and variables → Actions)
  // instead of this file — critical now that the repo is PUBLIC (free
  // unlimited Actions runtime). The workflow passes them as env vars; an
  // unset secret arrives as an EMPTY string — so a truthiness check, not ??
  // (the 2026-09-24 empty-env bug). A non-empty env value WINS over the file.
  // When any env secret is used, the minted-token write-back below never
  // writes secrets into the (public) config.json.
  let envSecretsUsed = false
  for (const [cfgKey, envName] of [
    ['metaUserToken', 'META_USER_TOKEN'],
    ['pageAccessToken', 'PAGE_ACCESS_TOKEN'],
    ['appId', 'META_APP_ID'],
    ['appSecret', 'META_APP_SECRET'],
  ]) {
    const v = String(process.env[envName] ?? '').trim()
    if (v) { cfg[cfgKey] = v; envSecretsUsed = true }
  }

  // Local test mode: print one caption per language (Gemini if the key is set,
  // else the fallback pool) without posting anything or touching state.
  if (ARG_CAPTION_TEST) {
    const state = await readState()
    const fallbacks = await loadFallbacks()
    const topics = await loadTopics()
    const boldEnabled = cfg.boldHeading !== false
    for (const lang of ['en', 'sw']) {
      const topic = peekTopic(state, topics)
      const cap = await captionForSlot(lang, state, fallbacks, boldEnabled, topic)
      log(`\n=== ${lang === 'sw' ? 'Kiswahili' : 'English'} caption (source: ${cap.source}${topic ? ` | topic #${topic.n}: ${lang === 'sw' ? topic.sw : topic.en}` : ''}) ===\n${cap.text}\n`)
    }
    log('[caption-test] nothing published, state unchanged')
    return
  }

  // Connect to the page. In dry-run mode a missing token is not fatal — the
  // plan (slots, photos, caption source, horizon) is still printed so the repo
  // can be previewed before the one-time token paste.
  let page = { pageId: String(cfg.pageId ?? ''), pageName: String(cfg.pageName ?? ''), pageToken: '', igUserId: '', igUsername: '' }
  let via = 'none'
  let tokenFromFile = false
  let userToken = false
  let sourceToken = ''
  try {
    ;({ page, via, tokenFromFile, userToken, sourceToken } = await connect(cfg))
  } catch (e) {
    if (!ARG_DRY) {
      if (String(e.message).startsWith('No working token yet')) {
        // expected pre-setup state — stay GREEN so the heartbeat doesn't paint
        // the Actions tab red while waiting for the one-time token paste
        log(`[connect] ${e.message}`)
        log('[connect] heartbeat keeps checking every 30 min — paste the token, push, and the next landed run connects, books the page and starts posting automatically. Use the dryRun button anytime to preview the plan.')
        return
      }
      throw e
    }
    log(`[connect] ${e.message}`)
    log('[dry-run] no Meta token yet — printing the content plan only (posting needs the one-time token paste)')
  }

  // If we minted a page token through the user-token path, persist it back into
  // data/config.json — future runs then work from the permanent token. A pasted
  // data/meta-token.txt is cleared after use.
  if (via === 'exchange') {
    let changed = false
    // Secret hygiene (2026-10-17): when credentials came from Actions
    // secrets, NEVER write them into the (public) config.json — non-secret
    // page details below still persist. If the permanent page token rotated,
    // update the PAGE_ACCESS_TOKEN secret in the repo settings instead.
    if (envSecretsUsed) {
      log('[connect] credentials came from Actions secrets — minted token NOT written to the public config.json (update the PAGE_ACCESS_TOKEN secret if it rotated)')
    }
    if (!envSecretsUsed) {
      if (cfg.pageAccessToken !== page.pageToken) { cfg.pageAccessToken = page.pageToken; changed = true }
      if (userToken && sourceToken && cfg.metaUserToken !== sourceToken) { cfg.metaUserToken = sourceToken; changed = true }
    }
    if (cfg.pageName !== page.pageName) { cfg.pageName = page.pageName; changed = true }
    if (cfg.pageId !== page.pageId) { cfg.pageId = page.pageId; changed = true }
    if (page.igUserId && cfg.igUserId !== page.igUserId) { cfg.igUserId = page.igUserId; changed = true }
    if (page.igUsername && cfg.igUsername !== page.igUsername) { cfg.igUsername = page.igUsername; changed = true }
    if (tokenFromFile) {
      await fs.writeFile(TOKEN_FILE, '')
      log('[connect] data/meta-token.txt cleared (permanent page token saved to data/config.json)')
      changed = true
    }
    if (changed) {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
      log('[connect] minted page token + page details saved → data/config.json (committed back with the state)')
    }
  }

  const state = await readState()
  const tz = cfg.timezone || 'Africa/Dar_es_Salaam'
  const slots = parseSlots(cfg.slots)
  const grace = Number(cfg.graceMinutes ?? 60)
  const scheduleDays = Math.max(1, Math.min(7, Number(cfg.scheduleDays ?? 3)))
  const boldEnabled = cfg.boldHeading !== false
  const now = localNow(tz)
  const nowClock = `${String(Math.floor(now.minutesOfDay / 60)).padStart(2, '0')}:${String(now.minutesOfDay % 60).padStart(2, '0')}`

  log(`[clock] ${now.date} ${nowClock} (${tz}) | slots: ${slots.map((s) => s.label).join(', ')} | grace ${grace}m | horizon ${scheduleDays}d | mode: ${ARG_DRY ? 'DRY-RUN' : ARG_FORCE ? 'FORCED' : 'auto'}`)

  // Emergency pause switch — set "autoPost": false in data/config.json.
  if (cfg.autoPost === false && !ARG_FORCE && !ARG_DRY) {
    log('[paused] autoPost is false in data/config.json — automatic posting paused (manual force still works)')
    const n = await cancelPendingScheduled(page, state)
    if (n > 0) { await writeState(state); log(`[paused] cancelled ${n} pending Meta-scheduled post(s)`) }
    return
  }

  const { jpgs: photos, pending } = await getPhotos()
  const fallbacks = await loadFallbacks()
  const topics = await loadTopics()
  const geminiReady = Boolean(String(process.env.GEMINI_API_KEY ?? '').trim())
  log(`[library] ${photos.length} image(s) in data/photos/ (one per day in SHUFFLED order — no repeats until all are used, then reshuffled forever)${pending.length > 0 ? `; ${pending.length} PNG/WebP will be converted to JPEG by the workflow's normalize step` : ''}`)
  log(`[library] captions: ${geminiReady ? 'Google Gemini live (GEMINI_API_KEY set) — the Lady of Destiny persona writes each post' : 'FALLBACK pool (GEMINI_API_KEY secret not set — add it in repo Settings → Secrets → Actions for live Gemini captions)'}, ${fallbacks.posts.filter((p) => p.lang === 'en').length} EN + ${fallbacks.posts.filter((p) => p.lang === 'sw').length} SW stored`)
  log(`[library] next slot language: ${nextSlotLang(state) === 'sw' ? 'Kiswahili' : 'English'} (daily alternation; a fresh repo starts with English)`)
  const nextTopic = peekTopic(state, topics)
  log(`[library] topics: ${nextTopic ? `${topics.length} assigned topics in data/topics.json — next: #${nextTopic.n} "${nextTopic.en}" / "${nextTopic.sw}" (${nextTopic.cat}); one per day, cycling every ${topics.length} days` : 'free theme choice (no data/topics.json — add the queue file to assign one topic per day)'}`)
  if (photos.length === 0) {
    log('[library] ⚠ data/photos/ is EMPTY — Facebook gets the caption as a text-only post; Instagram waits until images are uploaded (IG cannot post without an image)')
  }
  if (!page.igUserId && via !== 'none') {
    log('[library] ⚠ no Instagram business account is linked to this page yet — link IG in Page Settings → Linked Accounts to enable the IG half automatically')
  }

  // ---- reconcile: confirm Meta-scheduled slots that have gone live ----
  if (!ARG_DRY) {
    const changed = await reconcileScheduled(page, state, grace)
    if (changed) { await writeState(state); log('[reconcile] recorded live permalinks for scheduled slots') }
  }

  // ---- slot decision ----
  if (slots.length === 0) throw new Error('No valid slots in data/config.json ("slots" field)')
  let target = null
  let missed = []
  const doneToday = state.days[now.date] ?? {}

  if (ARG_FORCE || ARG_DRY) {
    // manual runs: first rescue the slot that is due RIGHT NOW — the most
    // recent past slot without BOTH halves done. A 'scheduled' slot (FB booked
    // on Meta) whose IG half is missing IS rescuable: force posts just the IG
    // half right now (FB is already in Meta's hands).
    for (const s of [...slots].reverse()) {
      if (s.minutes > now.minutesOfDay) continue
      const done = state.days[now.date]?.[s.label]
      if (done && ['published', 'guarded', 'cancelled'].includes(done.status)) continue
      if (done && done.ig?.id) continue // IG half already live/adopted
      // Force also rescues slots the auto path already closed (owner rule
      // 2026-09-24): 'partial' = FB live via Meta but the IG half never went
      // out (window lapsed) → force posts JUST the IG half with the slot's
      // pinned photo+caption; 'missed' = nothing was booked at all → both
      // halves fresh. This is what the rescue button always promised.
      const igOnly = Boolean(done && done.fb?.id && ['scheduled', 'partial'].includes(done.status))
      target = { ...s, date: now.date, igOnly }
      break
    }
    // otherwise the next future slot (today, else tomorrow)
    if (!target) {
      for (const dayOffset of [0, 1]) {
        const dk = dayOffset === 0 ? now.date : addDaysKey(now.date, 1)
        for (const s of slots) {
          if (dayOffset === 0 && s.minutes <= now.minutesOfDay) continue
          const done = state.days[dk]?.[s.label]
          if (done && ['published', 'partial', 'scheduled'].includes(done.status)) continue
          target = { ...s, date: dk }
          break
        }
        if (target) break
      }
    }
  } else {
    for (const s of slots) {
      const rec = doneToday[s.label]
      const since = now.minutesOfDay - s.minutes
      if (rec && rec.status === 'scheduled') {
        // FB is booked on Meta and will publish on time; the IG half is ours.
        if (!rec.ig?.id && since >= 0 && since <= grace) target = { ...s, igOnly: true }
        continue
      }
      if (rec) continue
      if (since >= 0 && since <= grace) target = s
      else if (since > grace) missed.push(s)
    }
    // mark permanently-missed slots once (so they are not retried)
    for (const s of missed) {
      doneToday[s.label] = { status: 'missed', at: new Date().toISOString() }
      recordEvent(state, { level: 'info', date: now.date, slot: s.label, message: `Slot ${s.label} missed (outside ${grace}-min catch-up window) — use force to rescue it` })
    }
    if (missed.length > 0) state.days[now.date] = doneToday
  }

  if (!target && missed.length > 0) await writeState(state)

  // ---- horizon: upcoming slots to pre-schedule with Meta's own scheduler ----
  const horizon = scheduleDays >= 2 ? buildHorizon(state, slots, now, tz, scheduleDays) : []

  if (ARG_DRY) {
    if (target) {
      const rec = state.days[target.date ?? now.date]?.[target.label]
      if (target.igOnly) {
        log(`[pick] slot ${target.label} on ${target.date ?? now.date} → IG half only (FB already booked on Meta${rec?.photo ? `, photo "${rec.photo}"` : ', no photo yet'}, lang ${rec?.lang ?? '?'})`)
        if (page.igUserId) {
          if (photos.length > 0) log('[dry-run] would publish the Instagram half right now (hidden FB photo → CDN url → container → media_publish)')
          else log('[dry-run] IG half waits — no image in data/photos/ yet (later runs retry until the catch-up window closes)')
        }
      } else {
        const photo = peekPhoto(state, photos)
        const tLang = slotLang(state, target.date ?? now.date, target.label)
        const tTopic = peekTopic(state, topics)
        log(`[pick] slot ${target.label} on ${target.date ?? now.date} → language: ${tLang === 'sw' ? 'Kiswahili' : 'English'} → topic: ${tTopic ? `#${tTopic.n} "${tLang === 'sw' ? tTopic.sw : tTopic.en}" (${tTopic.cat})` : 'free theme'} → photo: ${photo ?? '(none — text-only FB post + IG skipped until images are uploaded)'} (shuffled deck: ${Math.max(0, (state.rotation.deck?.length ?? 0) - Number(state.rotation.deckPos ?? 0))}/${photos.length} left this cycle, cycle #${Number(state.rotation.deckEpoch ?? 0)})`)
        log(`[pick] caption: ${geminiReady ? 'to be written by Google Gemini (Lady of Destiny persona)' : 'fallback pool post (GEMINI_API_KEY not set)'} — heading auto-bolded for social media`)
        log('[dry-run] would publish now:')
        log(`  Facebook (${page.pageName || 'Ladies Of Destiny'}): ${photo ? 'photo upload with caption' : 'text-only feed post with caption'}`)
        if (page.igUserId) log(`  Instagram (@${page.igUsername || '?'}): ${photo ? 'hidden FB photo → CDN url → container → media_publish' : 'SKIPPED (no image yet)'}`)
      }
    }
    if (horizon.length > 0) {
      log(`[dry-run] would pre-schedule ${horizon.length} slot(s) — FB via Meta exactly on time; IG posted later by landed catch-up runs${geminiReady ? ' (captions written by Gemini at booking time)' : ''}`)
      let simPrevLang = null // dry-run writes no state — simulate the alternation chain
      for (const h of horizon) {
        const lang = simPrevLang ?? slotLang(state, h.dk, h.slot.label)
        const photo = peekPhoto(state, photos)
        const topic = peekTopic(state, topics)
        log(`  ${h.dk} ${h.slot.label} → ${lang === 'sw' ? 'Kiswahili' : 'English'} → topic: ${topic ? `#${topic.n} "${lang === 'sw' ? topic.sw : topic.en}"` : 'free theme'} → ${photo ? `"${photo}"` : 'text-only'} → FB at ${new Date(h.slotUnix).toISOString()} + IG on the next landed run after that`)
        if (photo) advancePhoto(state, photos)
        advanceTopic(state, topics)
        simPrevLang = oppositeLang(lang)
      }
    }
    log('[dry-run] nothing published or scheduled, state unchanged')
    return
  }

  if (target) {
    const dateKey = target.date ?? now.date
    const slotLabel = `${target.label} Auto`
    const existing = state.days[dateKey]?.[target.label] // set when this slot was pre-booked on Meta

    // ---- pick content ----
    // IG-catch-up (slot was pre-booked on Meta): reuse the slot's OWN photo and
    // caption recorded at booking time — the FB half is already live/live-soon
    // with exactly this content; IG must match it, not advance the rotation.
    // If the slot was booked without a photo (photos folder was empty), re-check
    // the folder NOW — the owner may have uploaded images since.
    let photoFile, captionText, postLang, slotTopic = null
    if (target.igOnly) {
      photoFile = existing?.photo ?? null
      captionText = existing?.caption
      postLang = existing?.lang ?? 'en'
      if (!photoFile) {
        const fresh = await getPhotos()
        if (fresh.jpgs.length > 0) {
          photoFile = peekPhoto(state, fresh.jpgs)
          advancePhoto(state, fresh.jpgs)
          log(`[pick] slot ${slotLabel} on ${dateKey} was booked without a photo — ${fresh.jpgs.length} image(s) found now, using "${photoFile}" for the IG half`)
        }
      }
      if (!photoFile) {
        // IG cannot post without an image; the slot stays 'scheduled' so later
        // landed runs keep retrying within the catch-up window (then reconcile
        // closes it as FB-only 'partial'). Not an error — just waiting.
        log(`[pick] slot ${slotLabel} on ${dateKey} → IG half waiting: data/photos/ is still empty (upload images; the FB half is already in Meta's hands)`)
        recordEvent(state, { level: 'info', date: dateKey, slot: target.label, message: `${slotLabel}: IG half postponed — no image in data/photos/ yet; retrying on later runs until the ${grace}-min window closes` })
        await writeState(state)
        target = null
      } else {
        log(`[pick] slot ${slotLabel} on ${dateKey} → IG half of pre-booked slot (photo "${photoFile}", lang ${postLang} — pinned at booking time)`)
      }
    } else {
      const pickLang = slotLang(state, dateKey, target.label)
      postLang = pickLang
      photoFile = peekPhoto(state, photos)
      slotTopic = peekTopic(state, topics)
      const cap = await captionForSlot(pickLang, state, fallbacks, boldEnabled, slotTopic)
      captionText = cap.text
      log(`[pick] slot ${slotLabel} on ${dateKey} → language: ${postLang === 'sw' ? 'Kiswahili' : 'English'} (daily alternation) → topic: ${slotTopic ? `#${slotTopic.n} "${postLang === 'sw' ? slotTopic.sw : slotTopic.en}" (${slotTopic.cat})` : 'free theme (no data/topics.json)'} → photo: ${photoFile ?? '(none — text-only FB post)'} → caption source: ${cap.source}`)
    }

    if (target) {
      const photoPath = photoFile ? path.join(PHOTOS_DIR, photoFile) : null
      log(`[pick] caption: "${captionText.slice(0, 70).replace(/\n/g, ' ')}…" (${captionText.length} chars)`)

      // ---- adopt an already-live IG twin BEFORE (re)publishing (robustness) ----
      // a previous catch-up attempt may have timed out AFTER the post actually
      // went out server-side (phantom) — or someone published this content
      // manually. A blind retry would double-post; adopting closes the slot.
      if (target.igOnly) {
        const sinceMs = existing?.publishTime ? new Date(existing.publishTime).getTime() - 2 * 3600000 : Date.now() - 26 * 3600000
        const adopt = await findMatchingIgPost(page, captionText, sinceMs)
        if (adopt) {
          const aday = state.days[dateKey] ?? {}
          aday[target.label] = {
            ...existing,
            status: 'published',
            at: existing?.publishTime ?? new Date().toISOString(),
            ig: { id: adopt.id, permalink: adopt.permalink, adopted: true },
          }
          state.days[dateKey] = aday
          recordEvent(state, { level: 'success', date: dateKey, slot: target.label, message: `${slotLabel}: IG half adopted from the live feed (caption match) — ${adopt.permalink || adopt.id}` })
          await writeState(state)
          log(`[adopt] this slot's caption is already live on IG (${adopt.permalink || adopt.id}) — adopted as the IG half, no new post`)
          target = null
        }
      }

      // ---- duplicate guard (cross-runtime safety net) ----
      const guardMinutes = ARG_FORCE ? 3 : 30
      const lastAgo = target
        ? (target.igOnly ? await minutesSinceLastIgPost(page, state) : await minutesSinceLastPost(page, state))
        : null
      if (!target) {
        // the slot was closed via adoption above — nothing left to publish
      } else if (lastAgo !== null && lastAgo < guardMinutes) {
        log(`[guard] a post went out ${lastAgo} min ago (< ${guardMinutes} min guard) — skipping to avoid double-posting`)
        const gday = state.days[dateKey] ?? {}
        gday[target.label] = target.igOnly
          ? { ...existing, guard: new Date().toISOString() } // keep the booking; a later run retries the IG half
          : { status: 'guarded', at: new Date().toISOString() }
        state.days[dateKey] = gday
        recordEvent(state, { level: 'info', date: dateKey, slot: target.label, message: `Skipped by duplicate guard — last post ${lastAgo} min ago` })
        await writeState(state)
        target = null
      } else {
        // ---- publish ----
        log(`[post] publishing slot ${slotLabel} ${target.igOnly ? '(Instagram half; Facebook is in Meta\u2019s hands)' : ''} …`)
        const igResult = (page.igUserId && photoPath)
          ? await publishInstagram(page, photoPath, captionText)
          : {
              ok: true,
              postId: '',
              permalink: '',
              error: '',
              steps: [!page.igUserId ? 'IG: not linked to this page' : 'IG: skipped — no image in data/photos/ yet (uploads enable it automatically)'],
            }
        igResult.steps?.forEach((s) => log(`  ${s}`))
        const fbResult = target.igOnly
          ? { ok: true, postId: existing?.fb?.id ?? '', permalink: existing?.fb?.permalink ?? '', error: '' }
          : await publishFacebook(page, photoPath, captionText)
        if (target.igOnly) log('  FB: pre-booked on Meta (publishes/published at slot time — no action)')

        const igOk = igResult.ok
        const fbOk = fbResult.ok
        const status = igOk && fbOk ? 'published' : igOk || fbOk ? 'partial' : 'failed'
        log(`[post] IG: ${igOk ? (photoPath ? `✓ ${igResult.permalink || igResult.postId}` : 'SKIPPED (no image yet — not an error)') : `✗ ${igResult.error}`}`)
        if (!target.igOnly) log(`[post] FB: ${fbOk ? `✓ ${fbResult.permalink || fbResult.postId}` : `✗ ${fbResult.error}`}`)

        // ---- state update ----
        // Robustness (owner rule 2026-09-23): an IG failure while the FB half is
        // live (or in Meta's hands) must NOT close the slot. The record stays
        // 'scheduled' with the pinned photo/caption and no ig.id — every later
        // landed run retries the IG half until the grace window lapses
        // (reconcile then closes it as 'partial'). One transient API failure
        // (network blip, container timeout) never costs a slot.
        const day = state.days[dateKey] ?? {}
        if (!igOk && fbOk) {
          day[target.label] = {
            status: 'scheduled', // stays open: IG pending, FB fine
            at: existing?.at ?? new Date().toISOString(),
            publishTime: existing?.publishTime ?? new Date().toISOString(),
            photo: photoFile ?? (existing?.photo ?? null),
            caption: captionText,
            lang: postLang,
            topic: slotTopic ?? (existing?.topic ?? null),
            ig: { error: igResult.error, retries: (existing?.ig?.retries ?? 0) + 1 },
            fb: target.igOnly
              ? (existing?.fb ?? { error: 'booking lost' })
              : { id: fbResult.postId, permalink: fbResult.permalink },
          }
          state.days[dateKey] = day
          // the live FB post consumed this content (non-igOnly case) — advance the
          // rotation so the next slot does not reuse the same photo/topic
          if (photoFile && !target.igOnly) advancePhoto(state, photos)
          if (!target.igOnly && slotTopic) advanceTopic(state, topics)
          recordEvent(state, { level: 'error', date: dateKey, slot: target.label, message: `${slotLabel}: IG half failed (${igResult.error}) — slot stays OPEN, later landed runs retry the IG half until the ${grace}-min window closes` })
          await writeState(state)
          log(`[state] saved — ${dateKey} ${target.label} = IG pending (retry ${existing?.ig?.retries ? existing.ig.retries + 1 : 1}; FB ${target.igOnly ? 'in Meta\u2019s hands' : 'live'})`)
        } else {
          day[target.label] = {
            status,
            at: new Date().toISOString(),
            publishTime: existing?.publishTime,
            photo: photoFile ?? (existing?.photo ?? null),
            caption: captionText,
            lang: postLang,
            topic: slotTopic ?? (existing?.topic ?? null),
            ig: !photoPath
              ? { skipped: !page.igUserId ? 'IG not linked' : 'no image yet' }
              : igOk ? { id: igResult.postId, permalink: igResult.permalink } : { error: igResult.error },
            fb: target.igOnly
              ? (existing?.fb ?? { error: 'booking lost' })
              : fbOk ? { id: fbResult.postId, permalink: fbResult.permalink } : { error: fbResult.error },
          }
          state.days[dateKey] = day
          if (status !== 'failed' && photoFile && !target.igOnly) {
            advancePhoto(state, photos) // one image per day; cycles when over
          }
          if (status !== 'failed' && !target.igOnly && slotTopic) {
            advanceTopic(state, topics) // one topic per day; cycles every topics.length days
          }
          recordEvent(state, {
            level: status === 'published' ? 'success' : 'error',
            date: dateKey,
            slot: target.label,
            message: `${slotLabel}: ${status} — ${photoFile ? `"${photoFile}"` : 'text-only'} | ${postLang} | ${slotTopic ? `topic #${slotTopic.n} "${postLang === 'sw' ? slotTopic.sw : slotTopic.en}"` : 'no topic'} | IG ${igOk ? (photoPath ? '✓' : 'skipped (no image)') : `✗ ${igResult.error}`} | FB ${fbOk ? '✓' : `✗ ${fbResult.error}`}`,
          })
          await writeState(state)
          log(`[state] saved — ${dateKey} ${target.label} = ${status}`)

          if (status === 'failed') {
            throw new Error(`Slot ${slotLabel} ended as "${status}" — IG: ${igResult.error || 'ok'} | FB: ${fbResult.error || 'ok'}`)
          }
        }
      }
    }
  }

  if (!target) {
    log(`[done] no slot due right now — today: ${Object.keys(doneToday).map((k) => `${k}=${doneToday[k].status}`).join(', ') || 'nothing posted yet'}`)
  }

  // ---- pre-schedule the horizon: FB only, Meta publishes exactly on time ----
  // (IG cannot be pre-scheduled — API dead. Landed runs post the IG half of
  // each slot in its catch-up window; see the igOnly logic above.)
  if (horizon.length > 0) log(`[schedule] pre-scheduling ${horizon.length} upcoming slot(s) on Facebook via Meta …`)
  let scheduledCount = 0
  for (const h of horizon) {
    const hLang = slotLang(state, h.dk, h.slot.label)
    const hPhoto = peekPhoto(state, photos)
    const hTopic = peekTopic(state, topics)
    const cap = await captionForSlot(hLang, state, fallbacks, boldEnabled, hTopic)
    const hCaption = cap.text
    const hPhotoPath = hPhoto ? path.join(PHOTOS_DIR, hPhoto) : null
    const hISO = new Date(h.slotUnix).toISOString()
    log(`[schedule] ${h.dk} ${h.slot.label} → language: ${hLang === 'sw' ? 'Kiswahili' : 'English'} → topic: ${hTopic ? `#${hTopic.n} "${hLang === 'sw' ? hTopic.sw : hTopic.en}" (${hTopic.cat})` : 'free theme (no data/topics.json)'} → ${hPhoto ? `"${hPhoto}"` : 'text-only post'} → FB publishes at ${hISO}; IG half on the next landed run after that`)
    const fbS = await scheduleFacebookPost(page, hPhotoPath, hCaption, Math.floor(h.slotUnix / 1000))
    if (fbS.ok) {
      const day = state.days[h.dk] ?? {}
      day[h.slot.label] = {
        status: 'scheduled',
        publishTime: hISO,
        at: new Date().toISOString(),
        photo: hPhoto,
        caption: hCaption,
        lang: hLang,
        topic: hTopic ?? null,
        fb: { id: fbS.postId },
      }
      state.days[h.dk] = day
      if (hPhoto) advancePhoto(state, photos)
      advanceTopic(state, topics) // one topic per booked day, cycling every topics.length days
      recordEvent(state, { level: 'info', date: h.dk, slot: h.slot.label, message: `${h.slot.label} FB half pre-scheduled via Meta (publishes ${hISO}, ${hLang === 'sw' ? 'Kiswahili' : 'English'}) — topic ${hTopic ? `#${hTopic.n} "${hTopic.en}" / "${hTopic.sw}" (${hTopic.cat})` : '(free choice)'}; ${hPhoto ? `"${hPhoto}"` : 'text-only'}; IG half to be posted by a landed run in the catch-up window` })
      scheduledCount++
    } else {
      recordEvent(state, { level: 'error', date: h.dk, slot: h.slot.label, message: `${h.slot.label} FB scheduling FAILED — ${fbS.error} (next run retries)` })
      log(`  ✗ FB scheduling failed: ${fbS.error} — next run retries`)
    }
  }
  if (scheduledCount > 0) {
    await writeState(state)
    log(`[state] saved — ${scheduledCount} upcoming slot(s): FB pre-scheduled with Meta`)
  }
}

function addDaysKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
//  MUTUAL RESCUE — the "post like Biblia Tafsiri Mbalimbali" backstop (owner
//  rule 2026-09-24). GitHub drops most scheduled fires; landed runs arrive in
//  bursts with multi-hour gaps, so a page waiting for "the next landed run"
//  to publish its IG half can starve for a whole day even with a 4-hour
//  window. Fix: whenever this agent lands a run, it ALSO checks the sibling
//  pages (config "siblings", full "owner/repo" names) through the GitHub API
//  and dispatches a sibling's workflow directly when that sibling has
//  unfinished business — an API workflow_dispatch is 100% reliable, unlike
//  cron schedules. The dispatched run receives input rescuedBy=<this repo>
//  and skips its own sibling check (one hop, no dispatch ping-pong). Needs
//  a dispatch token (fine-grained PAT, contents:read + actions:write on the
//  sibling repos) — stored in data/config.json "dispatchToken"; the
//  DISPATCH_TOKEN repo secret overrides it if ever set; silently disabled
//  when it or the "siblings" config is absent. Never dispatches on dry-runs and never
//  fails the run it lives in.
// ─────────────────────────────────────────────────────────────────────────────
function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'social-agent-mutual-rescue',
  }
}

async function fetchRepoText(full, filePath, token) {
  const parts = filePath.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`https://api.github.com/repos/${full}/contents/${parts}?ref=main`, { headers: ghHeaders(token) })
  if (!res.ok) return null
  const j = await res.json().catch(() => null)
  if (!j || j.encoding !== 'base64' || !j.content) return null
  return Buffer.from(j.content, 'base64').toString('utf8')
}

async function dispatchSiblingWorkflow(full, token, rescuedBy, force = false) {
  const inputs = { rescuedBy }
  if (force) inputs.force = 'true' // boolean-typed workflow input: API takes the string "true"
  const res = await fetch(`https://api.github.com/repos/${full}/actions/workflows/social-agent.yml/dispatches`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  })
  if (res.ok) return { ok: true }
  const detail = await res.text().catch(() => '')
  return { ok: false, detail: `HTTP ${res.status} ${detail.slice(0, 140)}` }
}

async function mutualRescue() {
  if (ARG_DRY) return // never trigger dispatches from a dry run
  const rescuedBy = String(process.env.INPUT_RESCUED_BY ?? '').trim()
  if (rescuedBy) {
    log(`[rescue] this run was dispatched by "${rescuedBy}" — sibling check skipped (one hop)`)
    return
  }
  let cfg
  try { cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) } catch { return }
  const token = String(process.env.DISPATCH_TOKEN || cfg.dispatchToken || '').trim()
  const self = String(process.env.GITHUB_REPOSITORY ?? 'local-run')
  const siblings = String(cfg.siblings ?? '')
    .split(',').map((x) => x.trim()).filter((x) => x && x.includes('/') && x !== self)
  if (!token || siblings.length === 0) return // not configured — silently off
  for (const full of siblings) {
    try {
      const [cfgTxt, stateTxt] = await Promise.all([
        fetchRepoText(full, 'data/config.json', token),
        fetchRepoText(full, 'data/state.json', token),
      ])
      if (!cfgTxt || !stateTxt) { log(`[rescue] ${full}: state/config unreadable — skipped`); continue }
      const cfgS = JSON.parse(cfgTxt)
      const stateS = JSON.parse(stateTxt)
      const tzS = cfgS.timezone || 'Africa/Dar_es_Salaam'
      const slotsS = parseSlots(String(cfgS.slots ?? ''))
      const graceS = Number(cfgS.graceMinutes ?? 60)
      const nowS = localNow(tzS)
      const days = stateS.days ?? {}
      let why = null
      let forceRescue = false
      // (a) a slot that is due RIGHT NOW (inside the sibling's own catch-up
      //     window) whose IG half is still missing — the dispatched run will
      //     publish it immediately
      for (const s of slotsS) {
        const since = nowS.minutesOfDay - s.minutes
        if (since < 0 || since > graceS) continue
        const rec = days[nowS.date]?.[s.label]
        if (!rec) { why = `today's ${s.label} slot never booked (catch-up due)`; break }
        if (rec.status === 'scheduled' && !rec.ig?.id) { why = `today's ${s.label} IG half still missing (${since} min after slot time)`; break }
      }
      // (b) FB horizon empty — no Meta-scheduled slot at all for the next 2
      //     days (the sibling's own runs have not landed for ~2 days)
      if (!why && slotsS.length > 0) {
        const booked = [addDaysKey(nowS.date, 1), addDaysKey(nowS.date, 2)]
          .some((dk) => Object.values(days[dk] ?? {}).some((r) => r && r.status === 'scheduled'))
        if (!booked) why = 'no Meta-scheduled slots for the next 2 days (FB horizon empty)'
      }
      // (c) TODAY's slot already closed 'partial' (FB live via Meta, IG half
      //     missing — the sibling's catch-up window lapsed before ANY run
      //     landed; exactly the 2026-09-29 TLP failure: earliest slot of the
      //     three pages + GitHub's 03:00-07:00 UTC dead zone) or 'missed'
      //     (nothing booked at all). Still within the RESCUE EXTENSION
      //     (slot + grace + 120 min, same calendar afternoon in the sibling's
      //     timezone): dispatch with force=true — the sibling's force path
      //     posts JUST the missing IG half right now (both halves for
      //     'missed'). Past the extension the day stays skipped (manual force
      //     button only) — IG still never posts at arbitrary times of day.
      if (!why) {
        for (const s of slotsS) {
          const rec = days[nowS.date]?.[s.label]
          if (!rec || rec.ig?.id || !['partial', 'missed'].includes(rec.status)) continue
          const since = nowS.minutesOfDay - s.minutes
          if (since < 0 || since > graceS + 120) continue
          why = `today's ${s.label} slot is ${rec.status} with the IG half missing (${Math.max(since - graceS, 0)} min past its window) — force rescue`
          forceRescue = true
          break
        }
      }
      if (why) {
        const res = await dispatchSiblingWorkflow(full, token, self, forceRescue)
        log(res.ok
          ? `[rescue] dispatched ${full}${forceRescue ? ' (FORCE)' : ''} — ${why}`
          : `[rescue] could NOT dispatch ${full} (${res.detail}) — ${why}`)
      } else {
        log(`[rescue] ${full} healthy — no dispatch needed`)
      }
    } catch (e) {
      log(`[rescue] ${full}: check failed (${e.message}) — skipped`)
    }
  }
}

main()
  .catch((e) => { console.error(`[agent] FAILED: ${e.message}`); process.exitCode = 1 })
  .finally(() => mutualRescue().catch((e) => console.error(`[rescue] FAILED: ${e.message}`)))
