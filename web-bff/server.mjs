/**
 * Local BFF for the DeepSeek Harness (DSH) Web UI, fronting a
 * *cloud* AgentCore Runtime.
 *
 * Separation of concerns (unchanged from the earlier local bridge):
 *   - The agent does NOT run in this process. Every prompt is executed by the
 *     cloud AgentCore Runtime (SigV4 InvokeAgentRuntime), and this BFF only
 *     speaks the browser-facing DSH Web protocol.
 *   - This BFF is the sole `/api/*` + downlink-WebSocket authority. Session
 *     lifecycle and the ordered event surface are owned here (per-user seq
 *     counters), so injected assistant events never collide with a real
 *     dsh-web session store.
 *   - Static UI assets (GET /, /plugins/*, /assets/*) are reverse-proxied from a
 *     running `dsh web` so a real browser can load the shell.
 *
 * What this version adds (Phase 2, ref docs/auth-design.md):
 *   1. Cognito login (server-side USER_PASSWORD_AUTH + SECRET_HASH); browser
 *      never holds a JWT — only a Secure+HttpOnly+SameSite=Lax session cookie.
 *      Unauthenticated /api/* and WS => 401 / redirect. Origin checked (CSRF).
 *   2. Identity + Session Directory (DynamoDB): actorId = HMAC(memoryKey,
 *      tenant:sub); runtimeSessionId server-generated (>=33 chars), stored in
 *      DDB (PK=TENANT#{t}#USER#{u}, SK=WORKSPACE#{wsid}). Every request does an
 *      owner lookup (authed user + workspaceId) before touching a workspace —
 *      no reverse lookup by runtimeSessionId; browser never sees it (anti-IDOR).
 *   3. session.prompt => SigV4 InvokeAgentRuntime against the cloud Runtime
 *      (same runtimeSessionId => sticky microVM) => reply pushed back as a mux
 *      `assistant/message` frame (surfaceOp:'append' at the event top level).
 *
 * Wire protocol (reverse-engineered; evidence in docs/LOCAL-WEB-evidence.md):
 *   - Upstream RPC: POST /api/<method>  body {type:'client-request',rpcId,method,payload}
 *                   response body       {type:'server-response',rpcId,result:{ok,value|error}}
 *   - Downlinks:    WS /api/events.mux and /api/events.host, server->browser only.
 *                   Each frame is {type:'server-request',rpcId,method,payload}
 *                   where method === payload.type and payload is a Mux/Host frame.
 */

import { createServer } from 'node:http'
import { randomUUID, createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import JSZip from 'jszip'

// ---- config (env / Secrets Manager; nothing sensitive hardcoded) -----------

const REGION = process.env.AWS_REGION ?? process.env.REGION ?? 'us-west-2'
const BFF_PORT = Number(process.env.BFF_PORT ?? 3090)
const BFF_HOST = process.env.BFF_HOST ?? '127.0.0.1'

// Prebuilt DSH Web UI baked into the image (index.html carries the injected
// window.__DSH_BOOT__ manifest; /assets/* and /plugins/<id>/client.js are the
// captured static closure). Served directly by this BFF — no co-located
// `dsh web` process. See README "static capture".
const STATIC_DIR = process.env.STATIC_DIR ?? new URL('./static/', import.meta.url).pathname

// CloudFront -> ALB shared secret. When set, every request except /healthz must
// carry `x-origin-verify: <secret>`; a request reaching the ALB directly (not
// through CloudFront) lacks it and is rejected. Defense in depth on top of the
// ALB security group that only admits the CloudFront prefix list.
const ORIGIN_VERIFY = process.env.ORIGIN_VERIFY_SECRET

const COGNITO_POOL_ID = process.env.COGNITO_POOL_ID ?? '<COGNITO_POOL_ID>'
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '<COGNITO_CLIENT_ID>'
const COGNITO_SECRET_ARN = process.env.COGNITO_SECRET_ARN ?? 'dsh-agentcore/cognito-client-secret'
const RUNTIME_ARN = process.env.RUNTIME_ARN ?? 'arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/<RUNTIME_ID>'
const RUNTIME_QUALIFIER = process.env.RUNTIME_QUALIFIER ?? 'DEFAULT'
const DDB_TABLE = process.env.DDB_TABLE ?? 'dsh-session-directory'
const TENANT_ID = process.env.TENANT_ID ?? 'default'

const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'true') !== 'false'
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 8 * 3600)
const COOKIE_NAME = 'dsh_sess'

// Secrets not provided via env fall back to a per-boot random value. That is
// acceptable for a single-process local run (sessions reset on restart), but
// production MUST supply stable values (see README) so actorId/cookies survive
// restarts and multiple replicas agree.
const SESSION_COOKIE_SECRET = process.env.SESSION_COOKIE_SECRET ?? randomBytes(32).toString('hex')
const MEMORY_KEY = process.env.MEMORY_KEY ?? randomBytes(32).toString('hex')
if (!process.env.SESSION_COOKIE_SECRET) console.warn('[bff] SESSION_COOKIE_SECRET not set; using ephemeral per-boot secret')
if (!process.env.MEMORY_KEY) console.warn('[bff] MEMORY_KEY not set; using ephemeral per-boot salt (actorId not stable across restarts)')

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ??
    `http://127.0.0.1:${BFF_PORT},http://localhost:${BFF_PORT}`)
    .split(',').map(s => s.trim()).filter(Boolean),
)

const MODEL = { provider: 'amazon-bedrock', model: 'us.openai.gpt-5.6-sol' }

// ---- AWS clients ------------------------------------------------------------

const cognito = new CognitoIdentityProviderClient({ region: REGION })
const ddb = new DynamoDBClient({ region: REGION })
const agentcore = new BedrockAgentCoreClient({ region: REGION })

let CLIENT_SECRET // loaded at boot from Secrets Manager (or env override)
async function loadClientSecret() {
  // Trim in both branches: a value injected as an env var (e.g. an ECS secret)
  // is delivered verbatim, so a secret stored with a trailing newline would
  // otherwise corrupt the SECRET_HASH. The Secrets Manager branch below trims too.
  if (process.env.COGNITO_CLIENT_SECRET) return process.env.COGNITO_CLIENT_SECRET.trim()
  const sm = new SecretsManagerClient({ region: REGION })
  const out = await sm.send(new GetSecretValueCommand({ SecretId: COGNITO_SECRET_ARN }))
  const raw = (out.SecretString ?? '').trim()
  // The secret may be a raw string or a JSON object; accept either.
  try { const j = JSON.parse(raw); return j.clientSecret ?? j.client_secret ?? j.secret ?? Object.values(j)[0] }
  catch { return raw }
}

// ---- crypto / identity derivation (server-side only) -----------------------

const hmacHex = (key, msg) => createHmac('sha256', key).update(msg).digest('hex')
const hmacB64u = (key, msg) => createHmac('sha256', key).update(msg).digest('base64url')

// Cognito SECRET_HASH = base64(HMAC-SHA256(client_secret, username + client_id)).
const secretHash = (username) => createHmac('sha256', CLIENT_SECRET).update(username + COGNITO_CLIENT_ID).digest('base64')

const tenantHash = () => hmacHex(MEMORY_KEY, `tenant:${TENANT_ID}`).slice(0, 16)
// actorId = HMAC(memoryKey, tenantId + ":" + cognitoSub); userHash is its prefix.
const deriveActorId = (sub) => hmacHex(MEMORY_KEY, `${TENANT_ID}:${sub}`)
const userHashOf = (actorId) => actorId.slice(0, 16)
const workspaceHash = (workspaceId) => hmacHex(MEMORY_KEY, `ws:${workspaceId}`).slice(0, 16)
// runtimeSessionId: server-generated, >=33 chars, never sent to the browser.
const deriveRuntimeSessionId = (userHash, workspaceId) => `ses_${userHash}_${workspaceHash(workspaceId)}`

const ddbPk = (userHash) => `TENANT#${tenantHash()}#USER#${userHash}`
const ddbSk = (workspaceId) => `WORKSPACE#${workspaceId}`

// ---- server-side session store (browser holds only a signed cookie) --------

/** cookieSessionId -> { sub, actorId, userHash, csrf, exp } */
const serverSessions = new Map()

function signCookie(id) { return `${id}.${hmacB64u(SESSION_COOKIE_SECRET, id)}` }
function verifyCookie(value) {
  const dot = value.lastIndexOf('.')
  if (dot < 0) return undefined
  const id = value.slice(0, dot), sig = value.slice(dot + 1)
  const expected = hmacB64u(SESSION_COOKIE_SECRET, id)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  return id
}

function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Returns the authenticated server session for a request, or undefined. */
function authOf(req) {
  const value = parseCookies(req)[COOKIE_NAME]
  if (!value) return undefined
  const id = verifyCookie(value)
  if (!id) return undefined
  const sess = serverSessions.get(id)
  if (!sess) return undefined
  if (sess.exp <= Date.now()) { serverSessions.delete(id); return undefined }
  return sess
}

// Origin check for CSRF defense (paired with SameSite=Lax). A cross-site
// attacker's fetch/WS carries its own Origin (blocked); same-origin carries
// ours (allowed); non-browser tools omit Origin (no ambient cookie => allowed).
function originOk(req) {
  const origin = req.headers.origin
  if (!origin) return true
  return ALLOWED_ORIGINS.has(origin)
}

// ---- Session Directory (DynamoDB) ------------------------------------------

/** Owner lookup: authed user + public workspaceId -> the DDB item, or null. */
async function getWorkspace(userHash, workspaceId) {
  const out = await ddb.send(new GetItemCommand({
    TableName: DDB_TABLE,
    Key: marshall({ PK: ddbPk(userHash), SK: ddbSk(workspaceId) }),
  }))
  return out.Item ? unmarshall(out.Item) : null
}

/** Create a workspace owned by userHash; idempotent-ish (fails if exists). */
async function createWorkspace(userHash, workspaceId) {
  const item = {
    PK: ddbPk(userHash),
    SK: ddbSk(workspaceId),
    runtimeArn: RUNTIME_ARN,
    runtimeSessionId: deriveRuntimeSessionId(userHash, workspaceId),
    state: 'active',
    lastActivityAt: new Date().toISOString(),
    optimisticVersion: 1,
  }
  await ddb.send(new PutItemCommand({
    TableName: DDB_TABLE,
    Item: marshall(item),
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }))
  return item
}

/** Return the user's workspaces; create a default one if none exist. */
async function listOrSeedWorkspaces(userHash) {
  const out = await ddb.send(new QueryCommand({
    TableName: DDB_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: marshall({ ':pk': ddbPk(userHash), ':sk': 'WORKSPACE#' }),
  }))
  let items = (out.Items ?? []).map(unmarshall)
  if (items.length === 0) {
    const workspaceId = `wsp_${randomUUID()}`
    items = [await createWorkspace(userHash, workspaceId)]
  }
  return items
}

/** Bump lastActivityAt + optimisticVersion (best-effort optimistic lock). */
async function touchWorkspace(userHash, workspaceId, version) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: DDB_TABLE,
      Key: marshall({ PK: ddbPk(userHash), SK: ddbSk(workspaceId) }),
      UpdateExpression: 'SET lastActivityAt = :t, optimisticVersion = :nv',
      ConditionExpression: 'optimisticVersion = :v',
      ExpressionAttributeValues: marshall({ ':t': new Date().toISOString(), ':nv': version + 1, ':v': version }),
    }))
  } catch { /* concurrent update; non-fatal for a single-prompt turn */ }
}

// ---- per-user DSH session/event state (BFF-owned) --------------------------

/** sessionId -> { userHash, workspaceId, seq, events } */
const sessions = new Map()
/** userHash -> Set<sessionId>  (for host/session-added replay on WS connect) */
const userSessions = new Map()

const now = () => Date.now()

function ensureSession(sessionId, userHash, workspaceId) {
  let s = sessions.get(sessionId)
  if (s === undefined) {
    s = { userHash, workspaceId, seq: 0, events: [] }
    sessions.set(sessionId, s)
    if (!userSessions.has(userHash)) userSessions.set(userHash, new Set())
    userSessions.get(userHash).add(sessionId)
    hostBroadcast(userHash, { type: 'host/session-added', sessionId, blank: true })
    // Prime the mux subscription so the client's seq-gap guard accepts the
    // events this session will stream (lastSeq:-1 => next expected seq is 0).
    muxSend(userHash, { type: 'session/subscribed', sessionId, lastSeq: -1 })
  }
  return s
}

function appendEvent(session, type, data, surfaceOp) {
  const event = { type, seq: session.seq++, time: now(), data }
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  session.events.push(event)
  return event
}

// ---- downlink WebSocket carriers (scoped per authenticated user) -----------

const muxSockets = new Set() // each ws tagged with ws.userHash
const hostSockets = new Set()

function frame(payload) {
  return JSON.stringify({ type: 'server-request', rpcId: randomUUID(), method: payload.type, payload })
}

function muxSend(userHash, payload) {
  const text = frame(payload)
  for (const ws of muxSockets) if (ws.userHash === userHash && ws.readyState === ws.OPEN) ws.send(text)
}

function hostBroadcast(userHash, payload) {
  const text = frame(payload)
  for (const ws of hostSockets) if (ws.userHash === userHash && ws.readyState === ws.OPEN) ws.send(text)
}

// ---- prompt turn: browser session.prompt -> cloud Runtime -> mux events -----

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(p => p && p.type === 'text').map(p => p.text ?? '').join('')
}

/** Invoke the cloud AgentCore Runtime via SigV4 (SDK signs with the ambient
 *  credential chain: instance role locally, ECS task role in prod). */
async function invokeRuntime(runtimeSessionId, promptText) {
  const out = await agentcore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId,
    qualifier: RUNTIME_QUALIFIER,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: promptText })),
  }))
  const bodyText = await out.response.transformToString()
  const body = JSON.parse(bodyText || '{}')
  if (body.error) throw new Error(`${body.error.code ?? 'runtime'}: ${body.error.message ?? bodyText}`)
  return { response: body.response ?? '', finishReason: body.finishReason, toolCalls: body.toolCalls ?? [] }
}

async function runTurn(auth, sessionId, promptText) {
  const session = sessions.get(sessionId)
  // Authorization was already enforced by the caller (owner lookup); session
  // must belong to the authenticated user.
  if (!session || session.userHash !== auth.userHash) return
  const userHash = auth.userHash
  const workspaceId = session.workspaceId

  hostBroadcast(userHash, { type: 'host/session-status', sessionId, running: true })

  const userMessage = {
    id: randomUUID(), role: 'user',
    content: [{ type: 'text', text: promptText }], source: { kind: 'user' },
  }
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'user/message', userMessage, 'append') })

  const turn = session.events.filter(e => e.type === 'turn/start').length
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'turn/start', { turn }) })
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'step/start', { turn, step: 0 }) })

  let replyText, finishReason, toolCalls, error
  try {
    const ws = await getWorkspace(userHash, workspaceId)
    if (!ws) throw new Error('workspace not found for authenticated user')
    void touchWorkspace(userHash, workspaceId, ws.optimisticVersion ?? 1)
    const r = await invokeRuntime(ws.runtimeSessionId, promptText)
    replyText = r.response; finishReason = r.finishReason; toolCalls = r.toolCalls
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (error !== undefined) {
    hostBroadcast(userHash, { type: 'host/agent-error', sessionId, message: error })
    muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'step/end', { turn, step: 0 }) })
    muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'turn/end', { turn, reason: { kind: 'error', message: error } }) })
    hostBroadcast(userHash, { type: 'host/session-status', sessionId, running: false })
    return
  }

  const assistantMessage = {
    id: randomUUID(), role: 'assistant',
    content: [{ type: 'text', text: replyText }],
    source: { kind: 'model', provider: MODEL.provider, model: MODEL.model },
  }
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'assistant/message', { turn, step: 0, message: assistantMessage }, 'append') })
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'step/end', { turn, step: 0 }) })
  muxSend(userHash, { type: 'session/event', sessionId, event: appendEvent(session, 'turn/end', { turn, reason: { kind: 'completed', finishReason, toolCalls } }) })
  hostBroadcast(userHash, { type: 'host/session-status', sessionId, running: false })
}

// ---- upstream RPC dispatch (authenticated) ---------------------------------

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function wsView(item) {
  return {
    workspaceId: item.SK.slice('WORKSPACE#'.length),
    path: '/', // browser-facing placeholder; real cwd lives in the cloud runtime
    title: 'AgentCore BFF',
    sessionIds: [...(userSessions.get(userHashFromItem(item)) ?? [])]
      .filter(sid => sessions.get(sid)?.workspaceId === item.SK.slice('WORKSPACE#'.length)),
    createdAt: (item.lastActivityAt ?? new Date().toISOString()),
    updatedAt: (item.lastActivityAt ?? new Date().toISOString()),
  }
}
// The DDB item's PK encodes the userHash after "USER#".
function userHashFromItem(item) { const i = item.PK.indexOf('USER#'); return i < 0 ? '' : item.PK.slice(i + 5) }

function sessionSummary(sessionId) {
  const s = sessions.get(sessionId)
  return {
    sessionId, workspaceId: s?.workspaceId, updatedAt: now(),
    running: false, blank: (s?.events.length ?? 0) === 0, cwd: '/', agentPreset: 'standard',
  }
}

/** Returns an RpcResult value (ok branch value); throws RpcError for a
 *  business/authorization error. `auth` is the authenticated server session. */
async function dispatch(auth, method, payload) {
  const userHash = auth.userHash
  switch (method) {
    case 'workspace.list': {
      const items = await listOrSeedWorkspaces(userHash)
      return { items: items.map(wsView), archivedSessionIds: [] }
    }
    case 'session.create': {
      // A workspaceId must be supplied and owned by the caller (anti-IDOR).
      const workspaceId = payload?.workspaceId
      if (!workspaceId) throw new RpcError('invalid', 'workspaceId required')
      const ws = await getWorkspace(userHash, workspaceId)
      if (!ws) throw new RpcError('forbidden', 'workspace not found or not owned by caller')
      const sessionId = `bff-${randomUUID()}`
      ensureSession(sessionId, userHash, workspaceId)
      return { sessionId, workspaceId, agentPreset: 'standard' }
    }
    case 'session.list':
      return { items: [...(userSessions.get(userHash) ?? [])].map(sessionSummary) }
    case 'session.history': {
      const s = sessions.get(payload?.sessionId)
      if (s && s.userHash !== userHash) throw new RpcError('forbidden', 'not owner of session')
      return {
        events: (s?.events ?? []).map(event => ({ event })),
        hasMore: false,
        projections: { asOfSeq: s ? s.seq - 1 : -1, values: {} },
      }
    }
    case 'session.prompt': {
      const sessionId = payload?.sessionId
      const s = sessions.get(sessionId)
      if (!s) throw new RpcError('invalid', 'unknown session')
      if (s.userHash !== userHash) throw new RpcError('forbidden', 'not owner of session')
      // Owner lookup by (authed user + workspaceId derived from the owned session).
      const ws = await getWorkspace(userHash, s.workspaceId)
      if (!ws) throw new RpcError('forbidden', 'workspace not owned by caller')
      const promptText = textOf(payload?.content)
      // Fire-and-forget: the turn streams over mux; prompt returns accepted now.
      void runTurn(auth, sessionId, promptText)
      return { accepted: true }
    }
    case 'session.models':
      return {
        current: MODEL,
        // routable:true so the composer is active (the cloud runtime always has
        // a working Bedrock route). false shows "This model is unavailable".
        routable: true,
        groups: [{ id: MODEL.provider, name: 'Amazon Bedrock', models: [{ id: MODEL.model, name: MODEL.model }] }],
        failures: [],
      }
    case 'llm.providers':
      return { providers: [] }
    case 'llm.models':
      return { groups: [], failures: [] }
    case 'settings.describe':
      // Pre-acknowledge the ui-onboarding namespace so the "Internal Testing
      // Notice" welcome modal never gates the composer. The ack field/version
      // must match the client's onboarding-copy constants.
      return {
        writable: true, hasDocument: false,
        namespaces: [{ ns: 'ui-onboarding', schema: {}, value: { welcomeNoticeVersion: '2026-08-13.1' }, applies: 'live', secrets: [], revision: 1 }],
      }
    case 'settings.mutate':
      return { ns: payload?.ns ?? 'ui-onboarding', schema: {}, value: { welcomeNoticeVersion: '2026-08-13.1' }, applies: 'live', secrets: [], revision: 2 }
    case 'credentials.describe':
      return { credentials: {} }
    case 'agentPreset.list':
      return { presets: [], authorable: false, hasDocument: false }
    case 'skill.list':
      return { skills: [] }
    case 'host.describe':
      return { version: 'bff-1.0.0', cwd: '/', attachedSessions: 0, canOpenPath: false }
    case 'dynamicCordisRunner/inventory':
      // Fired on every connection bootstrap (connection/reset -> inventory.refresh).
      // The client validates the result against z.array(DynamicCordisInventoryRow);
      // an empty [] is the valid "no dynamic Cordis packages" inventory. Returning
      // {} (the default stub) fails the array schema => "rejected \"result\"" spam.
      return []
    case 'dynamicCordisRunner/syncInspectManifest':
      // Fired on bootstrap (connection/reset -> inspect.publish). The client
      // validates the result against z.literal(null): the value MUST be present
      // and exactly null (an omitted/void value deserializes to undefined and is
      // rejected). We accept the providers arg and ack with null.
      return null
    default:
      // Best-effort stub so an unlisted UI boot RPC does not 500. The value may
      // not match that method's schema; see README "remaining gaps".
      return {}
  }
}

// ---- HTTP server (auth + RPC + static UI proxy) ----------------------------

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function setSessionCookie(res, cookieSessionId) {
  const parts = [
    `${COOKIE_NAME}=${signCookie(cookieSessionId)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
  if (COOKIE_SECURE) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (COOKIE_SECURE) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

async function handleLogin(req, res) {
  if (!originOk(req)) return send(res, 403, { ok: false, error: 'bad origin' })
  let creds
  try { creds = JSON.parse(await readBody(req) || '{}') } catch { return send(res, 400, { ok: false, error: 'bad json' }) }
  const { username, password } = creds
  if (!username || !password) return send(res, 400, { ok: false, error: 'username and password required' })
  try {
    const out = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password, SECRET_HASH: secretHash(username) },
    }))
    const idToken = out.AuthenticationResult?.IdToken
    if (!idToken) return send(res, 401, { ok: false, error: 'authentication failed' })
    // The IdToken came directly from Cognito over TLS in response to our own
    // InitiateAuth call, so we trust it and read `sub` without extra JWKS
    // verification. (JWKS verification is needed only for tokens received from
    // an untrusted party.) The raw token is dropped immediately.
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString())
    const sub = claims.sub
    const actorId = deriveActorId(sub)
    const cookieSessionId = randomUUID()
    const csrf = randomBytes(16).toString('hex')
    serverSessions.set(cookieSessionId, {
      sub, actorId, userHash: userHashOf(actorId), csrf, exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    })
    setSessionCookie(res, cookieSessionId)
    return send(res, 200, { ok: true, csrfToken: csrf })
  } catch (e) {
    // Generic message: don't reveal whether username or password was wrong.
    console.warn('[bff] login failed:', e?.name ?? 'error')
    return send(res, 401, { ok: false, error: 'authentication failed' })
  }
}

function handleLogout(req, res) {
  const value = parseCookies(req)[COOKIE_NAME]
  if (value) { const id = verifyCookie(value); if (id) serverSessions.delete(id) }
  clearSessionCookie(res)
  return send(res, 200, { ok: true })
}

function handleMe(req, res) {
  const auth = authOf(req)
  return send(res, 200, { authenticated: !!auth })
}

async function handleApi(req, res, method) {
  const auth = authOf(req)
  if (!auth) return send(res, 401, { type: 'server-response', rpcId: randomUUID(), result: { ok: false, error: { code: 'unauthorized', message: 'login required', details: {} } } })
  if (!originOk(req)) return send(res, 403, { type: 'server-response', rpcId: randomUUID(), result: { ok: false, error: { code: 'forbidden', message: 'bad origin', details: {} } } })
  let rpcId = randomUUID()
  try {
    const msg = JSON.parse(await readBody(req) || '{}')
    rpcId = msg.rpcId ?? rpcId
    const value = await dispatch(auth, method, msg.payload)
    send(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
  } catch (e) {
    const code = e instanceof RpcError ? e.code : 'internal'
    const status = code === 'forbidden' ? 403 : code === 'unauthorized' ? 401 : 200
    send(res, status, {
      type: 'server-response', rpcId,
      result: { ok: false, error: { code, message: e instanceof Error ? e.message : String(e), details: {} } },
    })
  }
}

// GET /api/session.export?sessionId=<id>&includeDescendants=<bool>
// A browser-native download (the DSH client hands the URL to the browser), so it
// arrives as a top-level navigation without an Origin header — Origin is relaxed
// here, but a valid session cookie is still required. Ownership is enforced by
// userHash: a session that doesn't exist OR isn't owned by the caller returns 404
// (never reveal whether another user's session exists — anti-IDOR).
async function handleSessionExport(req, res, url) {
  const auth = authOf(req)
  if (!auth) { res.writeHead(401, { 'content-type': 'text/plain' }); return void res.end('login required') }
  const sessionId = url.searchParams.get('sessionId')
  const includeDescendants = url.searchParams.get('includeDescendants') === 'true'
  const s = sessions.get(sessionId)
  if (!s || s.userHash !== auth.userHash) {
    res.writeHead(404, { 'content-type': 'text/plain' }); return void res.end('not found')
  }
  const zip = new JSZip()
  zip.file('session.json', JSON.stringify({ sessionId, exportedAt: new Date().toISOString(), events: s.events }, null, 2))
  if (includeDescendants) {
    // Best-effort: include this user's child sessions (explicit parent link or
    // same workspace). The current session shape has no parentSessionId, so in
    // practice this pulls same-workspace siblings; harmless and owner-scoped.
    for (const [childId, cs] of sessions) {
      if (childId === sessionId || cs.userHash !== auth.userHash) continue
      if (cs.parentSessionId === sessionId || cs.workspaceId === s.workspaceId) {
        zip.file(`descendants/${childId}.json`, JSON.stringify({ sessionId: childId, events: cs.events }, null, 2))
      }
    }
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="dsh-session-${sessionId}.zip"`,
    'content-length': buf.length,
  })
  // HEAD is the DSH client's pre-download probe: same status + headers, no body.
  res.end(req.method === 'HEAD' ? undefined : buf)
}

const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><title>DSH BFF Login</title>
<style>body{font-family:system-ui;max-width:22rem;margin:5rem auto}input,button{display:block;width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}</style>
<h2>DSH AgentCore Login</h2>
<form id=f><input name=username placeholder=username autocomplete=username>
<input name=password type=password placeholder=password autocomplete=current-password>
<button>Sign in</button></form><p id=m></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const b={username:f.username.value,password:f.password.value};
const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
if(r.ok){location.href='/'}else{m.textContent='Login failed'}}</script>`

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon',
}

const STATIC_ROOT = resolve(STATIC_DIR)
const INDEX_HTML = join(STATIC_ROOT, 'index.html')

/** Serve the baked static UI closure. Traversal outside the root is 403; a miss
 *  falls back to index.html with 200 (SPA routing). Plugin bundles arrive as
 *  `/plugins/<id>/client.js?rev=...`; the query is dropped before the file map. */
async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const target = resolve(normalize(join(STATIC_ROOT, pathname)))
  if (target !== STATIC_ROOT && !target.startsWith(STATIC_ROOT + sep)) {
    res.writeHead(403); return void res.end()
  }
  const sendIndex = async () => {
    const body = await readFile(INDEX_HTML)
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(body)
  }
  if (target === STATIC_ROOT) return void sendIndex()
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { await sendIndex() }
}

// The DSH client's HMR row opens an EventSource on GET /plugins/events (a dev
// rebuild channel). Production ships no rebuilds; answer with a valid, idle
// event-stream so the browser connects once and never enters a 404 reconnect
// loop. No rebuild frame is ever emitted.
function serveHmrEvents(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': hmr disabled in production\n\n')
  const iv = setInterval(() => { try { res.write(': ping\n\n') } catch { /* socket closed */ } }, 30_000)
  res.on('close', () => clearInterval(iv))
}

// CloudFront->ALB shared-secret gate (see ORIGIN_VERIFY). Constant-time compare.
function originVerifyOk(req) {
  if (!ORIGIN_VERIFY) return true
  const h = req.headers['x-origin-verify']
  if (!h) return false
  const a = Buffer.from(String(h)), b = Buffer.from(ORIGIN_VERIFY)
  return a.length === b.length && timingSafeEqual(a, b)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? BFF_HOST}`)
  const { pathname } = url

  // Health check for the ALB target group: reachable without the CloudFront
  // shared-secret header (the ALB probes the task directly) and without auth.
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }); return void res.end('{"ok":true}')
  }
  // Everything else must arrive through CloudFront (carrying the shared secret).
  if (!originVerifyOk(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return void res.end('forbidden') }

  if (req.method === 'POST' && pathname === '/auth/login') return void handleLogin(req, res)
  if (req.method === 'POST' && pathname === '/auth/logout') return void handleLogout(req, res)
  if (req.method === 'GET' && pathname === '/auth/me') return void handleMe(req, res)
  if (req.method === 'GET' && pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return void res.end(LOGIN_PAGE)
  }

  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    return void handleApi(req, res, pathname.slice('/api/'.length))
  }
  // Download endpoint under /api/. The DSH client issues a HEAD (probe) then a
  // GET; both must be handled here, before the GET-only block and the SPA
  // static fallback (the POST /api/* RPC branch above only matches POST).
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/session.export') {
    return void handleSessionExport(req, res, url)
  }
  if (req.method === 'GET') {
    if (pathname === '/plugins/events') return void serveHmrEvents(res)
    // Redirect the unauthenticated app entry point to the login page.
    if (pathname === '/' && !authOf(req)) { res.writeHead(302, { location: '/login' }); return void res.end() }
    return void serveStatic(req, res)
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

// ---- downlink WS upgrade (authenticated; scoped per user) ------------------

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? BFF_HOST}`)
  if (pathname !== '/api/events.mux' && pathname !== '/api/events.host') return void socket.destroy()
  // WS upgrade must repeat the CloudFront shared-secret gate and auth + origin
  // checks (not just the HTTP layer).
  if (!originVerifyOk(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return void socket.destroy() }
  const auth = authOf(req)
  if (!auth || !originOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return void socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userHash = auth.userHash
    ws.on('message', () => ws.close(1008, 'downlink only')) // downlinks are server-push only
    // Keepalive: the ALB origin idle timeout is 60s, so a downlink with no
    // server->browser traffic for ~1min is torn down mid-connection and the
    // client logs "connection lost, retry". A protocol-level ping every 25s
    // keeps the socket active well inside that window (browsers auto-pong;
    // pings do not fire the 'message' guard above).
    const keepalive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping() }, 25_000)
    ws.on('close', () => clearInterval(keepalive))
    if (pathname === '/api/events.mux') {
      muxSockets.add(ws)
      for (const sid of userSessions.get(auth.userHash) ?? []) {
        const s = sessions.get(sid)
        ws.send(frame({ type: 'session/subscribed', sessionId: sid, lastSeq: (s?.seq ?? 0) - 1 }))
      }
      ws.on('close', () => muxSockets.delete(ws))
    } else {
      hostSockets.add(ws)
      for (const sid of userSessions.get(auth.userHash) ?? []) {
        ws.send(frame({ type: 'host/session-added', sessionId: sid, blank: (sessions.get(sid)?.events.length ?? 0) === 0 }))
      }
      ws.on('close', () => hostSockets.delete(ws))
    }
  })
})

// ---- boot -------------------------------------------------------------------

const booted = loadClientSecret()
  .then((s) => { CLIENT_SECRET = s })
  .then(() => new Promise((resolve) => server.listen(BFF_PORT, BFF_HOST, resolve)))
  .then(() => console.log(`dsh-web-bff: http://${BFF_HOST}:${BFF_PORT}  (runtime=cloud AgentCore, static=${STATIC_ROOT}, region=${REGION}, originVerify=${ORIGIN_VERIFY ? 'on' : 'off'})`))
  .catch((e) => { console.error('[bff] boot failed:', e); process.exit(1) })

export { booted }
