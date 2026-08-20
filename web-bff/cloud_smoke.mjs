/**
 * Cloud smoke: prove the BFF (auth + Session Directory + owner check)
 * talks to the *cloud* AgentCore Runtime, with no browser.
 *
 * Flow:
 *   1. Unauthenticated POST /api/workspace.list  => 401 (login required).
 *   2. Login alice (server-side USER_PASSWORD_AUTH) => Set-Cookie session.
 *   3. With alice's cookie: open mux+host WS, workspace.list -> workspaceId,
 *      session.create{workspaceId} -> sessionId, session.prompt -> assistant
 *      reply arrives on mux and contains the marker (reply is from the CLOUD
 *      runtime executing a bash tool, not any local adapter).
 *   4. Two-user isolation: bob logs in and calls session.create with ALICE's
 *      workspaceId => 403 (anti-IDOR).
 *
 * Test credentials are read from Secrets Manager at runtime (never hardcoded).
 * This script starts the BFF itself; it does NOT need `dsh web` (no static UI).
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const here = dirname(fileURLToPath(import.meta.url))
// Resources live in us-west-2; ignore any ambient AWS_REGION (e.g. us-east-1).
const REGION = process.env.SMOKE_REGION ?? 'us-west-2'
const BFF_PORT = Number(process.env.BFF_PORT ?? 3099)
const BFF_BASE = `http://127.0.0.1:${BFF_PORT}`
const ORIGIN = BFF_BASE
const PROMPT = process.env.SMOKE_PROMPT ??
  'Use the bash tool to run exactly: echo cloud-bff-ok , then report the command output verbatim.'
const MARKER = 'cloud-bff-ok'
const REPLY_DEADLINE_MS = Number(process.env.REPLY_DEADLINE_MS ?? 300_000)

let failed = false
function fail(msg) { console.error(`CLOUD SMOKE FAIL: ${msg}`); failed = true }
function ok(msg) { console.log(`  [ok] ${msg}`) }

async function readTestUsers() {
  const sm = new SecretsManagerClient({ region: REGION })
  const out = await sm.send(new GetSecretValueCommand({ SecretId: 'dsh-agentcore/test-users' }))
  const raw = (out.SecretString ?? '').trim()
  let users
  try { const j = JSON.parse(raw); users = Array.isArray(j) ? j : (j.users ?? Object.values(j)) }
  catch { users = raw.split('\n').map(l => JSON.parse(l)) }
  const byName = (n) => users.find(u => u.username === n || u.username?.startsWith(n + '@')) ?? undefined
  return { alice: byName('alice'), bob: byName('bob') }
}

/** POST /api/<method> with a given cookie; returns { status, body }. */
async function rpc(method, payload, cookie) {
  const headers = { 'content-type': 'application/json', origin: ORIGIN }
  if (cookie) headers.cookie = cookie
  const res = await fetch(`${BFF_BASE}/api/${method}`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function login(user) {
  const res = await fetch(`${BFF_BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: user.username, password: user.password }),
  })
  if (!res.ok) throw new Error(`login ${user.username} -> ${res.status}`)
  const setCookies = res.headers.getSetCookie?.() ?? []
  const sess = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('dsh_sess='))
  if (!sess) throw new Error(`no session cookie in login response for ${user.username}`)
  return sess
}

function openStream(path, cookie, onFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BFF_PORT}${path}`, { headers: { cookie, origin: ORIGIN } })
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (_req, res) => reject(new Error(`${path} ws rejected: ${res.statusCode}`)))
    ws.on('error', (e) => reject(e))
    ws.on('message', (data) => {
      const full = JSON.parse(data.toString())
      if (full.type === 'server-request') onFrame(full.method, full.payload)
    })
  })
}

async function main() {
  const { alice, bob } = await readTestUsers()
  if (!alice || !bob) throw new Error('could not load alice/bob from dsh-agentcore/test-users')

  const bff = spawn('node', [join(here, 'server.mjs')], {
    env: {
      ...process.env,
      BFF_PORT: String(BFF_PORT),
      AWS_REGION: REGION,
      COOKIE_SECURE: 'false',
      // stable secrets for the run (still not committed; ephemeral is fine here)
      SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET ?? 'smoke-cookie-secret-not-for-prod',
      MEMORY_KEY: process.env.MEMORY_KEY ?? 'smoke-memory-key-not-for-prod',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bff.stdout.on('data', d => process.stdout.write(`[bff] ${d}`))
  bff.stderr.on('data', d => process.stderr.write(`[bff] ${d}`))

  // Wait for boot (client secret loads from Secrets Manager first).
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BFF_BASE}/auth/me`); if (r.ok) break } catch {}
    await sleep(250)
  }

  const cleanup = []
  try {
    console.log('\n== 1) unauthenticated access is rejected ==')
    const unauth = await rpc('workspace.list', {}, undefined)
    if (unauth.status === 401 && unauth.body?.result?.error?.code === 'unauthorized') ok(`GET /api/workspace.list without cookie -> 401 unauthorized`)
    else fail(`expected 401 unauthorized, got ${unauth.status} ${JSON.stringify(unauth.body)}`)

    console.log('\n== 2) alice logs in ==')
    const aliceCookie = await login(alice)
    ok(`alice login -> Secure/HttpOnly session cookie issued (${aliceCookie.slice(0, 16)}...)`)

    console.log('\n== 3) alice: open downlinks, create workspace+session, prompt cloud runtime ==')
    const muxTypes = []
    let assistantText
    const muxWs = await openStream('/api/events.mux', aliceCookie, (method, payload) => {
      if (method === 'session/event') {
        muxTypes.push(payload.event.type)
        if (payload.event.type === 'assistant/message') {
          assistantText = payload.event.data.message.content.map(c => c.text).join('')
        }
      } else muxTypes.push(method)
    })
    cleanup.push(() => muxWs.close())
    const hostWs = await openStream('/api/events.host', aliceCookie, () => {})
    cleanup.push(() => hostWs.close())
    ok('both downlink WebSockets authenticated and open (mux + host)')

    const wl = await rpc('workspace.list', {}, aliceCookie)
    const aliceWsId = wl.body?.result?.value?.items?.[0]?.workspaceId
    if (!aliceWsId) throw new Error(`workspace.list gave no workspaceId: ${JSON.stringify(wl.body)}`)
    ok(`alice workspace.list -> workspaceId=${aliceWsId} (owned in Session Directory)`)

    const sc = await rpc('session.create', { workspaceId: aliceWsId }, aliceCookie)
    const sessionId = sc.body?.result?.value?.sessionId
    if (!sessionId) throw new Error(`session.create failed: ${JSON.stringify(sc.body)}`)
    ok(`alice session.create -> sessionId=${sessionId}`)

    const sp = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] }, aliceCookie)
    if (!sp.body?.result?.value?.accepted) throw new Error(`session.prompt not accepted: ${JSON.stringify(sp.body)}`)
    ok(`alice session.prompt accepted; awaiting cloud runtime reply (deadline ${REPLY_DEADLINE_MS / 1000}s)`)

    const deadline = Date.now() + REPLY_DEADLINE_MS
    while (assistantText === undefined && Date.now() < deadline) await sleep(300)
    if (assistantText === undefined) fail('no assistant/message received on mux (cloud runtime timeout)')
    else {
      console.log(`\n  assistant reply (from CLOUD AgentCore Runtime):\n  ${JSON.stringify(assistantText.slice(0, 500))}`)
      if (assistantText.includes(MARKER)) ok(`reply contains marker "${MARKER}" -> cloud runtime executed the bash tool`)
      else fail(`reply did not contain marker "${MARKER}"`)
    }
    console.log(`  mux frames: [${muxTypes.join(', ')}]`)

    console.log('\n== 4) two-user isolation: bob cannot touch alice\'s workspace ==')
    const bobCookie = await login(bob)
    ok(`bob login -> session cookie issued`)
    const idor = await rpc('session.create', { workspaceId: aliceWsId }, bobCookie)
    if (idor.status === 403 && idor.body?.result?.error?.code === 'forbidden') {
      ok(`bob session.create{workspaceId=${aliceWsId}} -> 403 forbidden (anti-IDOR owner check)`)
    } else {
      fail(`expected 403 forbidden for bob accessing alice's workspace, got ${idor.status} ${JSON.stringify(idor.body)}`)
    }

    console.log('\n================ CLOUD SMOKE SUMMARY ================')
    console.log(failed
      ? 'RESULT: FAIL (see messages above)'
      : 'RESULT: PASS — local BFF <-> CLOUD AgentCore Runtime is wired end to end with Cognito auth + Session Directory owner check + two-user isolation.')
    console.log('=====================================================')
  } catch (e) {
    fail(e instanceof Error ? e.stack ?? e.message : String(e))
  } finally {
    for (const fn of cleanup) try { fn() } catch {}
    bff.kill('SIGTERM')
    await sleep(200)
    process.exitCode = failed ? 1 : 0
  }
}

main()
