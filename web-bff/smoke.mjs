/**
 * Headless end-to-end smoke for the web<->adapter separated link.
 *
 * Proves, with no browser: start the BFF -> open both downlink WebSockets
 * (/api/events.mux, /api/events.host) -> POST session.create -> POST
 * session.prompt -> receive the final assistant reply on the mux stream, with
 * the reply text sourced from the adapter (DSH -> Bedrock).
 *
 * Preconditions: the AgentCore Runtime adapter is already running on
 * ADAPTER_URL (default http://127.0.0.1:8080). This script starts the BFF
 * itself. Uses only Node built-ins (global fetch + WebSocket) plus the BFF.
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BFF_PORT = Number(process.env.BFF_PORT ?? 3091)
const BFF_BASE = `http://127.0.0.1:${BFF_PORT}`
const ADAPTER_URL = process.env.ADAPTER_URL ?? 'http://127.0.0.1:8080'
const PROMPT = process.env.SMOKE_PROMPT ?? 'Reply with exactly the single word: pong'
const here = dirname(fileURLToPath(import.meta.url))

function fail(msg) { console.error(`SMOKE FAIL: ${msg}`); process.exitCode = 1 }

async function rpc(method, payload) {
  const res = await fetch(`${BFF_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  const body = await res.json()
  if (!body.result?.ok) throw new Error(`${method} -> ${JSON.stringify(body.result?.error)}`)
  return body.result.value
}

function openStream(path, onFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BFF_PORT}${path}`)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(new Error(`${path} ws error: ${e.message ?? e}`)))
    ws.addEventListener('message', (ev) => {
      const full = JSON.parse(ev.data)
      if (full.type !== 'server-request') throw new Error(`unexpected frame envelope: ${full.type}`)
      onFrame(full.method, full.payload)
    })
  })
}

async function waitAdapter() {
  const res = await fetch(`${ADAPTER_URL}/ping`).catch(() => undefined)
  if (!res || !res.ok) throw new Error(`adapter not reachable at ${ADAPTER_URL}/ping; start it first (see README)`)
  console.log(`[smoke] adapter /ping ok: ${(await res.json()).status}`)
}

async function main() {
  await waitAdapter()

  const bff = spawn('node', [join(here, 'server.mjs')], {
    env: { ...process.env, BFF_PORT: String(BFF_PORT), ADAPTER_URL },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  bff.stdout.on('data', d => process.stdout.write(`[bff] ${d}`))
  await sleep(700)

  const muxTypes = []
  const hostTypes = []
  let assistantText
  const cleanup = []

  try {
    const muxWs = await openStream('/api/events.mux', (method, payload) => {
      if (method === 'session/event') {
        muxTypes.push(payload.event.type)
        if (payload.event.type === 'assistant/message') {
          assistantText = payload.event.data.message.content.map(c => c.text).join('')
        }
      } else {
        muxTypes.push(method)
      }
    })
    cleanup.push(() => muxWs.close())
    const hostWs = await openStream('/api/events.host', (method) => hostTypes.push(method))
    cleanup.push(() => hostWs.close())
    console.log('[smoke] both downlink WebSockets open (mux + host)')

    const { sessionId } = await rpc('session.create', {})
    console.log(`[smoke] session.create -> ${sessionId}`)

    const accepted = await rpc('session.prompt', {
      sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }],
    })
    console.log(`[smoke] session.prompt accepted=${accepted.accepted}; prompt=${JSON.stringify(PROMPT)}`)

    const deadline = Date.now() + 240_000
    while (assistantText === undefined && Date.now() < deadline) await sleep(200)
    if (assistantText === undefined) throw new Error('no assistant/message received on mux within 240s')

    console.log('\n================ RESULT ================')
    console.log(`mux frames:  [${muxTypes.join(', ')}]`)
    console.log(`host frames: [${hostTypes.join(', ')}]`)
    console.log(`assistant reply (from adapter -> Bedrock): ${JSON.stringify(assistantText)}`)
    if (assistantText.trim().length === 0) fail('assistant reply was empty')
    else console.log('SMOKE PASS: browser-shaped session.prompt produced an assistant reply on the mux stream, sourced from the adapter.')
    console.log('========================================')
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    for (const fn of cleanup) try { fn() } catch {}
    bff.kill('SIGTERM')
    await sleep(200)
  }
}

main()
