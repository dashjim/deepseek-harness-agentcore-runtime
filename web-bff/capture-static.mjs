#!/usr/bin/env node
/**
 * capture-static.mjs — rebuild web-bff/static/ (the baked DSH Web UI closure).
 *
 * The BFF image serves the DSH Web UI as a static closure baked into
 * web-bff/static/ (Dockerfile: `COPY static/ ./static/`). That closure is a
 * DERIVED artifact (gitignored, ~15M / ~152 files) and has no source in git.
 * This script regenerates it deterministically so a fresh clone can rebuild
 * the image without hand-scraping `dsh web`.
 *
 * What it does:
 *   1. Start `dsh web` (a DSH-monorepo host that injects window.__DSH_BOOT__
 *      into GET / and serves /assets/* + /plugins/<id>/client.js). Skipped when
 *      BASE_URL points at an already-running host.
 *   2. GET / → save index.html; parse window.__DSH_BOOT__ for the client-plugin
 *      roster; parse <script src>/<link href> for the top-level asset + icon +
 *      manifest references.
 *   3. Breadth-first download the whole closure, following /assets/** references
 *      discovered inside JS/CSS (dynamic-import lang chunks, KaTeX fonts,
 *      sourceMappingURL) plus every /plugins/<id>/client.js from the boot
 *      manifest. Files land under OUT_DIR at their served path.
 *   4. Self-verify: index.html carries __DSH_BOOT__, every boot plugin has a
 *      non-empty client.js, every index-referenced asset exists, and a
 *      throwaway static server re-serves OUT_DIR with zero 404s. Optionally
 *      diff against a REFERENCE_DIR.
 *
 * Config (env; a few have --flag equivalents):
 *   DSH_REPO_ROOT   DSH monorepo checkout (required unless BASE_URL is set)
 *   PORT            port for the spawned dsh web         (default 3080)
 *   OUT_DIR         output closure dir                   (default <here>/static)
 *   BASE_URL        crawl this already-running host; do NOT spawn  (optional)
 *   DSH_WEB_CMD     command to launch dsh web; "{PORT}" is substituted
 *                   (default: "pnpm dsh web --port {PORT}", run in DSH_REPO_ROOT)
 *   READY_TIMEOUT_MS  how long to wait for GET / to answer 200   (default 90000)
 *   REFERENCE_DIR   compare the produced file set against this dir (optional)
 *   KEEP_OUT        "true" keeps OUT_DIR contents instead of wiping first
 *
 * Flags: --repo <dir> --port <n> --out <dir> --base-url <url> --reference <dir>
 *
 * Exit 0 on a verified closure; non-zero (with a printed reason) otherwise.
 * Progress is also appended to OUT_DIR/../capture-static.log so a killed run
 * still leaves a durable trace.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile, readFile, stat, readdir } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, extname, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---- args / config ---------------------------------------------------------
function flag(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
const DSH_REPO_ROOT = flag('--repo') ?? process.env.DSH_REPO_ROOT
const PORT = Number(flag('--port') ?? process.env.PORT ?? 3080)
const OUT_DIR = resolve(flag('--out') ?? process.env.OUT_DIR ?? join(HERE, 'static'))
const BASE_URL = (flag('--base-url') ?? process.env.BASE_URL ?? '').replace(/\/$/, '')
const DSH_WEB_CMD = process.env.DSH_WEB_CMD ?? 'pnpm dsh web --port {PORT}'
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 90_000)
const REFERENCE_DIR = flag('--reference') ?? process.env.REFERENCE_DIR
const KEEP_OUT = (process.env.KEEP_OUT ?? '') === 'true'

// Durable progress trace in the system temp dir (never pollutes the repo, and
// survives even if the process is killed mid-run).
const LOG_FILE = join(tmpdir(), 'capture-static.log')
function log(msg) {
  const line = `[capture ${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch { /* best effort */ }
}
function die(msg) { log(`FATAL: ${msg}`); process.exitCode = 1; throw new Error(msg) }

const MIME_EXT = new Set(['.js', '.mjs', '.css', '.map']) // text assets we scan for refs

// ---- dsh web child ----------------------------------------------------------
let child = null
function startDshWeb() {
  if (!DSH_REPO_ROOT) die('DSH_REPO_ROOT is required (or pass BASE_URL for an already-running dsh web)')
  const cmd = DSH_WEB_CMD.replaceAll('{PORT}', String(PORT))
  log(`starting dsh web: (cwd=${DSH_REPO_ROOT}) ${cmd}`)
  // detached so we can kill the whole process group (dsh spawns helpers).
  child = spawn('bash', ['-lc', cmd], {
    cwd: DSH_REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }, // do NOT force DSH_TOOLS_MODE='' (breaks plugin load)
  })
  const tap = (buf) => { for (const l of String(buf).split('\n')) if (l.trim()) log(`  dsh> ${l}`) }
  child.stdout.on('data', tap)
  child.stderr.on('data', tap)
  child.on('exit', (code, sig) => log(`dsh web exited code=${code} sig=${sig}`))
}
function stopDshWeb() {
  if (!child || child.killed) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  log('sent SIGTERM to dsh web process group')
}

// ---- http helpers -----------------------------------------------------------
async function fetchPath(base, urlPath) {
  // urlPath may carry a query (e.g. plugin client.js?rev=...); keep it on the wire.
  const res = await fetch(base + urlPath)
  if (!res.ok) throw new Error(`GET ${urlPath} -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { buf, contentType: res.headers.get('content-type') ?? '' }
}
async function waitReady(base) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/')
      if (r.ok) { log(`host ready: GET / -> ${r.status}`); return }
      last = `status ${r.status}`
    } catch (e) { last = e.message }
    await sleep(500)
  }
  die(`dsh web did not become ready within ${READY_TIMEOUT_MS}ms (last: ${last})`)
}

// ---- path handling ----------------------------------------------------------
export function stripQuery(p) { const i = p.indexOf('?'); return i >= 0 ? p.slice(0, i) : p }
async function saveFile(urlPath, buf) {
  const rel = stripQuery(urlPath).replace(/^\//, '')
  const dest = join(OUT_DIR, rel)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  return dest
}

// ---- reference extraction ---------------------------------------------------
/** Pull window.__DSH_BOOT__ JSON out of the served index.html. */
export function parseBoot(html) {
  const m = html.match(/window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (!m) die('index.html has no window.__DSH_BOOT__ manifest (is this really `dsh web`?)')
  let json = m[1].trim().replace(/;$/, '')
  try { return JSON.parse(json) } catch (e) { die(`failed to parse __DSH_BOOT__ JSON: ${e.message}`) }
}
/** Top-level asset/icon/manifest refs from index.html <script>/<link>. */
export function indexRefs(html) {
  const out = new Set()
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const v = m[1]
    if (v.startsWith('/')) out.add(v)
  }
  return [...out]
}
/**
 * Asset references buried in a JS/CSS/map file. Canonicalised to absolute
 * served paths under the host root. Handles the shapes DSH's Vite build emits:
 *   "/assets/x.js"  "assets/langs/c-*.js"  "./langs/c-*.js"  "fonts/*.woff2"
 *   //# sourceMappingURL=index-*.js.map   (relative to the referrer's dir)
 */
export function assetRefs(text, referrerPath) {
  const found = new Set()
  const refDir = posix.dirname(referrerPath) // e.g. /assets

  const push = (raw) => {
    let t = raw.trim().replace(/^['"`]+|['"`]+$/g, '')
    if (/\s/.test(t)) return // a real path token has no embedded whitespace
    if (!t || t.startsWith('http') || t.startsWith('data:')) return
    const ai = t.indexOf('assets/')
    let abs
    if (t.startsWith('/')) abs = t
    else if (ai >= 0) abs = '/' + t.slice(ai)
    else if (t.startsWith('langs/') || t.startsWith('fonts/')) abs = '/assets/' + t
    else abs = posix.normalize(posix.join(refDir, t)) // relative (sourceMappingURL etc.)
    // langs/fonts chunks live under /assets/; a ref that captured a leading "/"
    // off "assets/langs/..." lands at "/langs/..." — re-root it under /assets.
    if (/^\/(langs|fonts)\//.test(abs)) abs = '/assets' + abs
    found.add(stripQuery(abs))
  }

  // /assets/... and bare assets/... with a file extension
  for (const m of text.matchAll(/(?:\.{0,2}\/)?assets\/[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+/g)) push(m[0])
  // ./langs|fonts/... or bare langs|fonts/... chunks
  for (const m of text.matchAll(/(?:\.{0,2}\/)?(?:langs|fonts)\/[A-Za-z0-9_.\-]+\.[A-Za-z0-9]+/g)) push(m[0])
  // sourceMappingURL comments (JS + CSS). Exclude backslash so an escaped "\n"
  // embedded in a minified string literal doesn't bleed into the captured path.
  for (const m of text.matchAll(/sourceMappingURL=([^\s'"*\\]+)/g)) push(m[1])
  return [...found]
}

// ---- crawl ------------------------------------------------------------------
async function crawl(base) {
  log(`output dir: ${OUT_DIR}`)
  if (!KEEP_OUT) { await rm(OUT_DIR, { recursive: true, force: true }); log('wiped OUT_DIR (idempotent rebuild)') }
  await mkdir(OUT_DIR, { recursive: true })

  // 1) index.html
  const { buf: indexBuf } = await fetchPath(base, '/')
  await saveFile('/index.html', indexBuf)
  const html = indexBuf.toString('utf8')
  const boot = parseBoot(html)
  const pluginEntries = Array.isArray(boot.entries) ? boot.entries : []
  log(`__DSH_BOOT__ rev=${boot.rev ?? '?'} plugins=${pluginEntries.length}`)

  // 2) seed queue: index.html asset/icon/manifest refs + plugin client.js urls
  const queue = []
  const seen = new Set()
  const enqueue = (p) => { const k = stripQuery(p); if (!seen.has(k)) { seen.add(k); queue.push(p) } }
  for (const r of indexRefs(html)) enqueue(r)
  const pluginPaths = new Set()
  for (const e of pluginEntries) {
    if (typeof e.url === 'string') { enqueue(e.url); pluginPaths.add(stripQuery(e.url)) }
  }

  // 3) BFS download; scan text assets for more refs
  let count = 0
  const missing = []   // fatal: a real asset failed to download
  let softMisses = 0   // non-fatal: an optional .map sourcemap the host doesn't ship
  while (queue.length) {
    const urlPath = queue.shift()
    try {
      const { buf } = await fetchPath(base, urlPath)
      await saveFile(urlPath, buf)
      count++
      if (MIME_EXT.has(extname(stripQuery(urlPath)))) {
        for (const ref of assetRefs(buf.toString('utf8'), stripQuery(urlPath))) enqueue(ref)
      }
    } catch (e) {
      // sourcemaps are optional; JS bundles may point sourceMappingURL at a
      // .map the host does not serve (e.g. plugin client.js.map). Skipping it
      // is not a closure defect — only a real asset miss is fatal.
      if (extname(stripQuery(urlPath)) === '.map') { softMisses++; continue }
      missing.push(`${urlPath}: ${e.message}`)
      log(`  MISS ${e.message}`)
    }
  }
  log(`downloaded ${count} files; fatal-misses=${missing.length}; skipped optional sourcemaps=${softMisses}`)
  return { boot, pluginEntries, pluginPaths, missing }
}

// ---- verify -----------------------------------------------------------------
async function dirFiles(root) {
  const out = []
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else out.push(p.slice(root.length + 1))
    }
  }
  await walk(root)
  return out.sort()
}
async function fileSize(p) { try { return (await stat(p)).size } catch { return -1 } }

/** Re-serve OUT_DIR with a tiny static server and assert boot + plugins + assets load 404-free. */
async function selfServeCheck(pluginEntries) {
  const root = OUT_DIR
  const srv = createServer(async (req, res) => {
    const p = stripQuery(decodeURIComponent(new URL(req.url, 'http://x').pathname))
    const file = join(root, p === '/' ? 'index.html' : p.replace(/^\//, ''))
    try { const b = await readFile(file); res.writeHead(200); res.end(b) }
    catch { res.writeHead(404); res.end('nf') }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const problems = []
  try {
    const idx = await (await fetch(base + '/')).text()
    if (!idx.includes('__DSH_BOOT__')) problems.push('served index.html missing __DSH_BOOT__')
    for (const e of pluginEntries) {
      const r = await fetch(base + e.url)
      const len = r.ok ? (await r.arrayBuffer()).byteLength : 0
      if (!r.ok || len === 0) problems.push(`plugin ${e.id}: status ${r.status} len ${len}`)
    }
    for (const ref of indexRefs(idx)) {
      const r = await fetch(base + ref)
      if (!r.ok) problems.push(`asset ${ref}: status ${r.status}`)
    }
  } finally { srv.close() }
  return problems
}

async function verify(res) {
  const { pluginEntries, missing } = res
  const problems = [...missing.map((m) => `download miss: ${m}`)]

  // index + boot
  const indexPath = join(OUT_DIR, 'index.html')
  const indexHtml = await readFile(indexPath, 'utf8').catch(() => '')
  if (!indexHtml.includes('__DSH_BOOT__')) problems.push('OUT_DIR/index.html missing __DSH_BOOT__')

  // every boot plugin has a non-empty client.js on disk
  for (const e of pluginEntries) {
    const f = join(OUT_DIR, stripQuery(e.url).replace(/^\//, ''))
    const sz = await fileSize(f)
    if (sz <= 0) problems.push(`plugin ${e.id}: missing/empty at ${f} (size ${sz})`)
  }

  // every index-referenced asset exists
  for (const ref of indexRefs(indexHtml)) {
    const f = join(OUT_DIR, stripQuery(ref).replace(/^\//, ''))
    if ((await fileSize(f)) < 0) problems.push(`index ref ${ref}: not on disk`)
  }

  // live re-serve, assert no 404
  const serveProblems = await selfServeCheck(pluginEntries)
  problems.push(...serveProblems)

  // totals
  const files = await dirFiles(OUT_DIR)
  let bytes = 0
  for (const f of files) bytes += await fileSize(join(OUT_DIR, f))
  log(`closure: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`)
  log(`  index.html:${files.includes('index.html')} assets:${files.filter((f) => f.startsWith('assets/')).length}` +
      ` plugins:${files.filter((f) => f.startsWith('plugins/')).length}`)

  // optional reference diff
  if (REFERENCE_DIR) {
    const ref = await dirFiles(resolve(REFERENCE_DIR)).catch(() => null)
    if (!ref) { log(`REFERENCE_DIR ${REFERENCE_DIR} not readable; skipping diff`) }
    else {
      const a = new Set(files), b = new Set(ref)
      const onlyNew = files.filter((f) => !b.has(f))
      const onlyRef = ref.filter((f) => !a.has(f))
      log(`reference diff vs ${REFERENCE_DIR}: produced=${files.length} reference=${ref.length}` +
          ` only-in-new=${onlyNew.length} only-in-reference=${onlyRef.length}`)
      for (const f of onlyRef.slice(0, 25)) log(`  MISSING vs reference: ${f}`)
      for (const f of onlyNew.slice(0, 25)) log(`  extra vs reference: ${f}`)
      if (onlyRef.length) problems.push(`${onlyRef.length} file(s) present in reference but not captured`)
    }
  }

  if (problems.length) {
    log(`VERIFY FAILED (${problems.length}):`)
    for (const p of problems.slice(0, 40)) log(`  - ${p}`)
    die('closure verification failed')
  }
  log('VERIFY OK: index carries __DSH_BOOT__, all plugins + assets present, re-serve is 404-free')
}

// ---- main -------------------------------------------------------------------
async function main() {
  log(`capture-static start (port=${PORT}, base=${BASE_URL || '(spawn)'})`)
  const base = BASE_URL || `http://127.0.0.1:${PORT}`
  if (!BASE_URL) { startDshWeb(); await waitReady(base) }
  else log(`using already-running host at ${base}`)
  const res = await crawl(base)
  await verify(res)
  log('DONE: web-bff/static/ rebuilt and verified')
}

let exiting = false
async function shutdown() { if (exiting) return; exiting = true; stopDshWeb() }

// Run only when executed directly (`node capture-static.mjs`), not when imported
// for unit-testing the pure extraction helpers above.
const executedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (executedDirectly) {
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(130)) })
  process.on('SIGTERM', () => { shutdown().finally(() => process.exit(143)) })
  try { await main() }
  catch (e) { log(`ERROR: ${e?.stack ?? e}`); process.exitCode ||= 1 }
  finally { await shutdown(); if (child) await sleep(300) }
}
