/**
 * Browser smoke: real headless chromium loads the DSH Web UI through the BFF,
 * types a prompt, submits, and asserts the assistant reply (routed through our
 * AgentCore adapter -> Bedrock) renders in the conversation surface.
 *
 * Preconditions (started by the caller / run_smoke orchestration):
 *   - adapter on ADAPTER_URL (default :8080)
 *   - dsh web on :3080 (static UI, reverse-proxied by the BFF)
 *   - BFF on BFF_BASE (default http://127.0.0.1:3090)
 *
 * Uses the cached playwright chromium (1228); never downloads a browser.
 * Selectors are the DSH UI's locale-independent data-* hooks:
 *   composer   = [data-composer-card] textarea
 *   assistant  = [data-chat-flow-kind="assistant-step"]
 *   user echo  = [data-chat-flow-kind="user"]
 * Enter submits (fires POST /api/session.prompt, mode 'queue').
 */
import { chromium } from 'playwright-core'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(here, 'artifacts')
const CHROME = process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`
const BFF = process.env.BFF_BASE ?? 'http://127.0.0.1:3090'
const PROMPT = process.env.SMOKE_PROMPT ??
  'Use the bash tool to run: echo hello-from-dsh-web, and report the output.'
const REPLY_DEADLINE_MS = Number(process.env.REPLY_DEADLINE_MS ?? 240_000)

function fail(msg) { console.error(`BROWSER SMOKE FAIL: ${msg}`); process.exitCode = 1 }

async function main() {
  await mkdir(ARTIFACTS, { recursive: true })
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

  const rpcs = []
  const consoleErrors = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (r.method() === 'POST' && u.pathname.startsWith('/api/')) rpcs.push(u.pathname.slice('/api/'.length))
  })
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  try {
    await page.goto(BFF, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // Wait for the app shell + composer. The seeded blank session should
    // auto-open into a usable composer; fall back to clicking "New session".
    const composer = page.locator('[data-composer-card] textarea')
    try {
      await composer.waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      const newBtn = page.getByRole('button', { name: /New session|新建会话|新会话/i }).first()
      await newBtn.click({ timeout: 5_000 }).catch(() => {})
      await composer.waitFor({ state: 'visible', timeout: 15_000 })
    }

    // Ensure the composer is actually the editable message input (session bound,
    // not the workspace-hero picker which is readonly / data-phase="inert" and
    // not the model-blocked inert state). Wait until it is truly writable.
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-composer-card] textarea')
      return t && !t.disabled && !t.readOnly && t.getAttribute('data-phase') !== 'inert'
    }, { timeout: 20_000 })

    await page.screenshot({ path: join(ARTIFACTS, '01-empty-session.png'), fullPage: false })
    console.log('[smoke] empty session rendered; composer visible')

    // Type the prompt and submit with Enter. Use fill()+focus rather than a
    // pointer click: the hero has a decorative presentation overlay that
    // intercepts clicks over the composer, but fill()/focus bypass hit-testing.
    await composer.focus()
    await composer.fill(PROMPT)
    await page.screenshot({ path: join(ARTIFACTS, '02-prompt-typed.png'), fullPage: false })
    await composer.press('Enter')
    console.log(`[smoke] prompt submitted: ${JSON.stringify(PROMPT)}`)

    // The user echo should appear quickly.
    const userMsg = page.locator('[data-chat-flow-kind="user"]').last()
    await userMsg.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})

    // Wait for an assistant-step with non-empty text.
    const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
    let replyText = ''
    const deadline = Date.now() + REPLY_DEADLINE_MS
    while (Date.now() < deadline) {
      const n = await page.locator('[data-chat-flow-kind="assistant-step"]').count()
      if (n > 0) {
        replyText = (await assistant.innerText()).trim()
        if (replyText.length > 0) break
      }
      await sleep(500)
    }

    await page.screenshot({ path: join(ARTIFACTS, '03-reply.png'), fullPage: false })

    const userText = (await page.locator('[data-chat-flow-kind="user"]').count())
      ? (await page.locator('[data-chat-flow-kind="user"]').last().innerText()).trim()
      : '(none)'

    console.log('\n================ BROWSER SMOKE RESULT ================')
    console.log(`RPCs fired: ${[...new Set(rpcs)].sort().join(', ')}`)
    console.log(`prompt RPC count (session.prompt): ${rpcs.filter(r => r === 'session.prompt').length}`)
    console.log(`user bubble DOM text: ${JSON.stringify(userText.slice(0, 200))}`)
    console.log(`assistant DOM text:   ${JSON.stringify(replyText.slice(0, 600))}`)
    console.log(`console errors (${consoleErrors.length}):`)
    for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  -', e.slice(0, 180))
    console.log(`screenshots: ${ARTIFACTS}/01-empty-session.png, 02-prompt-typed.png, 03-reply.png`)
    console.log('=====================================================')

    if (replyText.length === 0) fail('no assistant reply text rendered in the conversation surface')
    else {
      const marker = replyText.includes('hello-from-dsh-web')
      console.log(marker
        ? 'BROWSER SMOKE PASS: assistant reply rendered AND contains the echoed marker "hello-from-dsh-web".'
        : 'BROWSER SMOKE PASS: assistant reply rendered in the conversation surface (marker text not literally present; see DOM text above).')
    }
  } catch (e) {
    await page.screenshot({ path: join(ARTIFACTS, '99-error.png'), fullPage: false }).catch(() => {})
    fail(e instanceof Error ? e.stack ?? e.message : String(e))
  } finally {
    await browser.close()
  }
}

main()
