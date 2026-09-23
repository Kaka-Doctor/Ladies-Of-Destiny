#!/usr/bin/env node
/**
 * One-off surgery (2026-09-23): clean queue start for the topic-queue rollout.
 *
 * 1. Deletes the 3 pending Meta-scheduled FB posts booked by the OLD
 *    free-choice persona (2026-09-23 / 09-24 / 09-25, 10:00 EAT each).
 * 2. Removes those three day entries from data/state.json (09-22 stays —
 *    already published, photo 0, English).
 * 3. Resets rotation: photo → 1 (photo 0 was used 09-22), topic → 0
 *    (fresh queue → next landed run books 09-23 = topic #1, 09-24 = #2,
 *    09-25 = #3).
 *
 * Safe to re-run: scheduled posts already deleted / days already removed are
 * skipped. Run BEFORE pushing the topic-queue code so the next landed
 * heartbeat re-books the horizon with assigned topics.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json')
const STATE_FILE = path.join(ROOT, 'data', 'state.json')
const GRAPH = 'https://graph.facebook.com/v21.0'

const DAYS_TO_CLEAR = ['2026-09-23', '2026-09-24', '2026-09-25']

async function graphDelete(pathname, params) {
  const url = new URL(`${GRAPH}/${pathname}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method: 'DELETE' })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok && !json.error, detail: json?.error?.message ?? JSON.stringify(json) }
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
  const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'))
  if (!cfg.pageAccessToken || !cfg.pageId) throw new Error('pageAccessToken/pageId missing in data/config.json')

  for (const dk of DAYS_TO_CLEAR) {
    const day = state.days?.[dk] ?? {}
    for (const [label, rec] of Object.entries(day)) {
      if (rec?.status !== 'scheduled' || !rec.publishTime) continue
      if (new Date(rec.publishTime).getTime() < Date.now()) continue // already live — leave it
      // remove from Meta: FB scheduled photo post (+ IG id if any was pinned)
      if (rec.fb?.id) {
        const r = await graphDelete(String(rec.fb.id), { access_token: cfg.pageAccessToken })
        console.log(`[surgery] ${dk} ${label}: FB ${rec.fb.id} delete → ${r.ok ? 'OK' : `FAILED (${r.detail})`}`)
        if (!r.ok) throw new Error(`could not delete FB post ${rec.fb.id} — ABORT (state left untouched)`)
      }
      if (rec.ig?.id) {
        const r = await graphDelete(String(rec.ig.id), { access_token: cfg.pageAccessToken })
        console.log(`[surgery] ${dk} ${label}: IG ${rec.ig.id} delete → ${r.ok ? 'OK' : `FAILED (${r.detail})`}`)
      }
    }
    delete state.days[dk]
    console.log(`[surgery] removed state.days["${dk}"]`)
  }

  const before = JSON.stringify({ photo: state.rotation?.photo, topic: state.rotation?.topic })
  state.rotation = { ...state.rotation, photo: 1, topic: 0 }
  state.events = (state.events ?? []).slice(-100)
  state.events.push({
    ts: new Date().toISOString(),
    level: 'info',
    message: 'Topic queue surgery (2026-09-23): 3 free-choice bookings removed from Meta + state (09-23/24/25); rotation photo 4→1, topic →0 — next landed run re-books the horizon with assigned topics #1/#2/#3',
  })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
  console.log(`[surgery] rotation: ${before} → photo 1, topic 0 — state written`)
}

main().catch((e) => { console.error(`[surgery] FAILED: ${e.message}`); process.exit(1) })
