#!/usr/bin/env node
/** Gemini self-test (owner tool). Run via Actions: "Run workflow" → tick
 *  "gemini-test". Calls Google Gemini with the EXACT persona prompt + validation
 *  the agent uses for Ladies of Destiny captions (one English post and one
 *  Swahili post), so a green result here guarantees the posting-time captions
 *  will work. Posts nothing, changes no state. Prints only success/validation
 *  info — the API key is never logged. */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const STATE = path.join(ROOT, 'data', 'state.json')

const key = String(process.env.GEMINI_API_KEY ?? '').trim()
if (!key) {
  console.log('❌ GEMINI_API_KEY is not set on this run.')
  console.log('   → Repo Settings → Secrets and variables → Actions → New repository secret')
  console.log('     Name: GEMINI_API_KEY   Secret: <your key from aistudio.google.com/apikey>')
  process.exit(1)
}
const model = String(process.env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim() || 'gemini-2.5-flash'
const state = JSON.parse(fs.readFileSync(STATE, 'utf-8'))

// same persona-prompt builder as the agent (kept in sync)
function buildPersonaPrompt(lang, avoidList) {
  const avoid = avoidList.length > 0 ? avoidList.join(' | ') : 'none yet (this is your first post)'
  if (lang === 'sw') {
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
      'Chagua mada moja kutoka: kumpenda Mungu, urembo wa ndani, lenzo, maombi, imani, usafi, hatima, ujasiri, kujithamini, ' +
      'utumishi, uongozi, wema, msamaha, kutembea kwa Roho.\n\n' +
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
    'Choose one theme from: love for God, inner beauty, purpose, prayer, faith, purity, destiny, courage, self-worth, ' +
    'ministry, leadership, kindness, forgiveness, walking in the Spirit.\n\n' +
    'LANGUAGE: Write the ENTIRE post in English — heading, message, scripture, and all hashtags.\n\n' +
    `Recent headings/themes (do NOT repeat them): ${avoid}\n\n` +
    'Output ONLY the post text — no explanations before or after, no markdown, no asterisks, plain text only.'
  )
}

function recentHeadings(state, n = 6) {
  const out = []
  for (const dk of Object.keys(state.days ?? {}).sort().reverse()) {
    for (const rec of Object.values(state.days[dk] ?? {})) {
      const first = String(rec?.caption ?? '').split('\n').find((l) => l.trim())
      if (first) out.push(first.trim().slice(0, 80))
      if (out.length >= n) return out
    }
  }
  return out
}

async function test(lang) {
  const prompt = buildPersonaPrompt(lang, recentHeadings(state))
  console.log(`\n── Testing Google Gemini (${model}) — ${lang === 'sw' ? 'Swahili' : 'English'} post ──`)
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(60000),
    }
  )
  const json = await res.json().catch(() => ({}))
  const text = String(json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim()
  if (!res.ok || !text) {
    console.log(`❌ Gemini API error: ${json?.error?.message ?? `HTTP ${res.status}`}`)
    console.log('   → the key may be wrong/expired, or the model name (repo variable GEMINI_MODEL) is invalid')
    return false
  }
  const newlines = (text.match(/\n/g) ?? []).length
  const valid = text.includes('#LadiesOfDestiny') && text.includes('#MabintiWenyeHatima') && text.length >= 250 && text.length <= 2000 && newlines >= 4
  console.log(valid ? '✅ valid — passed the agent validation (hashtags, length, structure)' : '⚠ output failed validation (agent will use the fallback pool for this language)')
  console.log('--- Gemini output ---')
  console.log(text)
  console.log('--- end ---')
  return valid
}

const en = await test('en')
const sw = await test('sw')
console.log(`\nRESULT: ${en && sw ? '✅ GEMINI OK — key works for both languages' : en || sw ? '⚠ partial — one language failed' : '❌ both languages failed'}`)
process.exit(en && sw ? 0 : 2)
