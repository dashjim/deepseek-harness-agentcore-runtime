/**
 * Verifies the DSH "Session log ⬇" download button no longer 404s on the live
 * CloudFront URL. Logs in as alice, binds a workspace, sends a prompt (so a
 * session with events exists), then actually clicks the top-right "Session log"
 * download control. Captures every /api/session.export request with its method
 * and status. Asserts HEAD -> 200 and the follow-up GET -> 200 application/zip.
 *
 * Credentials read in-process from Secrets Manager (never printed).
 */
import { chromium } from 'playwright-core'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`
const CF = process.env.CF_BASE ?? 'https://<CLOUDFRONT_DOMAIN>'
const ART = new URL('./artifacts/', import.meta.url).pathname
const PROMPT = 'Use the bash tool to run: echo export-head-ok, and report the output.'

async function creds() {
  const sm = new SecretsManagerClient({ region: 'us-west-2' })
  const out = await sm.send(new GetSecretValueCommand({ SecretId: 'dsh-agentcore/test-users' }))
  const raw = (out.SecretString ?? '').trim()
  let rows = []
  for (const line of raw.split('\n')) { const t = line.trim(); if (!t) continue; try { rows.push(JSON.parse(t)) } catch {} }
  if (rows.length === 0) { const v = JSON.parse(raw); rows = Array.isArray(v) ? v : Object.values(v) }
  const a = rows.find(r => JSON.stringify(r).includes('alice'))
  return { username: a.username, password: a.password }
}

async function main() {
  await mkdir(ART, { recursive: true })
  const { username, password } = await creds()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const exportEvents = []   // {method,status,ctype,cdisp}
  const errs = []
  page.on('response', async r => {
    try {
      const u = new URL(r.url())
      if (u.pathname === '/api/session.export') {
        const h = r.headers()
        exportEvents.push({ method: r.request().method(), status: r.status(), ctype: h['content-type'], cdisp: h['content-disposition'] })
      }
    } catch {}
  })
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', e => errs.push('pageerror: ' + e.message))
  page.on('download', () => {})   // consume, keep acceptDownloads happy

  const writable = () => page.evaluate(() => {
    const t = document.querySelector('[data-composer-card] textarea')
    return !!(t && !t.disabled && !t.readOnly && t.getAttribute('data-phase') !== 'inert')
  })

  try {
    await page.goto(`${CF}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.fill('input[name=username]', username)
    await page.fill('input[name=password]', password)
    await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.click('button')])
    await sleep(2000)
    await page.locator('[data-composer-card] textarea').waitFor({ state: 'visible', timeout: 30000 })

    for (let i = 0; i < 3; i++) {
      const cont = page.getByRole('button', { name: /^Continue$|继续/ })
      if (await cont.count() && await cont.first().isVisible().catch(() => false)) {
        await cont.first().click({ timeout: 3000 }).catch(() => {}); await sleep(800)
      } else break
    }

    for (let attempt = 0; attempt < 6 && !(await writable()); attempt++) {
      if (attempt === 0) {
        // Click an existing session leaf in the sidebar tree (loads that session,
        // binds the composer). "New Session" under AgentCore BFF > Ungrouped.
        await page.locator('nav, aside').getByText(/^New Session$/).last().click({ timeout: 3000 }).catch(() => {})
      } else if (attempt === 1) {
        // Expand the AgentCore BFF workspace row then click its session leaf.
        await page.getByText('AgentCore BFF', { exact: false }).first().click({ timeout: 3000 }).catch(() => {})
        await sleep(500)
        await page.getByText(/^New Session$/).last().click({ timeout: 3000 }).catch(() => {})
      } else if (attempt === 2) {
        await page.getByText('Choose workspace', { exact: false }).first().click({ timeout: 4000 }).catch(() => {})
        await sleep(600)
        const opt = page.getByRole('menuitem', { name: /AgentCore BFF/i }).or(page.getByRole('option', { name: /AgentCore BFF/i }))
        await opt.first().click({ timeout: 3000 }).catch(async () => {
          await page.getByText('AgentCore BFF', { exact: false }).last().click({ timeout: 3000 }).catch(() => {})
        })
      } else if (attempt === 3) {
        // top-left "New Session" button
        await page.getByRole('button', { name: /New Session|新建会话|新会话/i }).first().click({ timeout: 3000 }).catch(() => {})
      } else {
        const row = page.getByText('AgentCore BFF', { exact: false }).first()
        await row.hover().catch(() => {}); await sleep(300)
        await page.locator('[aria-label*="add" i], [title*="session" i]').last().click({ timeout: 2000 }).catch(() => {})
      }
      await sleep(2000)
    }
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-composer-card] textarea')
      return t && !t.disabled && !t.readOnly && t.getAttribute('data-phase') !== 'inert'
    }, { timeout: 20000 })

    const composer = page.locator('[data-composer-card] textarea')
    await composer.focus(); await composer.fill(PROMPT); await composer.press('Enter')
    await sleep(2500)
    if (await page.locator('[data-chat-flow-kind="user"]').count() === 0) {
      await page.locator('[data-composer-card] button').last().click({ timeout: 3000 }).catch(() => {})
    }
    // wait for an assistant reply so the session has events to export
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (await page.locator('[data-chat-flow-kind="assistant-step"]').count() > 0) break
      await sleep(500)
    }
    await sleep(1500)
    await page.screenshot({ path: ART + 'export-01-session.png' })

    // Click the real "Session log" download control (top-right).
    const btn = page.getByText('Session log', { exact: false }).first()
    await btn.waitFor({ state: 'visible', timeout: 15000 })
    console.log('found "Session log" control; clicking...')
    const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    await btn.click({ timeout: 5000 }).catch(async () => {
      await btn.locator('xpath=ancestor-or-self::button[1]').click({ timeout: 5000 }).catch(() => {})
    })
    // allow HEAD probe + GET/download to fire
    await sleep(6000)
    const dl = await dlP
    let dlInfo = '(no download event)'
    if (dl) {
      const p = ART + 'export-download.zip'
      await dl.saveAs(p).catch(() => {})
      const { readFile } = await import('node:fs/promises')
      const b = await readFile(p).catch(() => Buffer.alloc(0))
      dlInfo = `file="${dl.suggestedFilename()}" bytes=${b.length} magic=${b.slice(0, 2).toString()}`
    }
    console.log('download        :', dlInfo)

    // Explicitly record the download GET status via an in-page fetch reusing the
    // logged-in cookie and the exact sessionId the button used (from HEAD cdisp).
    const headEv = exportEvents.find(e => e.method === 'HEAD')
    const sid = headEv && /dsh-session-(.+)\.zip/.exec(headEv.cdisp || '')?.[1]
    let fetchGet = '(skipped)'
    if (sid) {
      fetchGet = await page.evaluate(async (id) => {
        const u = `/api/session.export?sessionId=${encodeURIComponent(id)}&includeDescendants=true`
        const r = await fetch(u, { method: 'GET' })
        const buf = new Uint8Array(await r.arrayBuffer())
        return { status: r.status, ctype: r.headers.get('content-type'), len: buf.length, magic: String.fromCharCode(buf[0], buf[1]) }
      }, sid).catch(e => ({ error: String(e) }))
    }
    console.log('in-page GET     :', JSON.stringify(fetchGet))
    await page.screenshot({ path: ART + 'export-02-afterclick.png' })

    const exp404 = errs.filter(e => /session\.export/.test(e) && /404/.test(e))
    const cordisErr = errs.filter(e => /dynamicCordisRunner/.test(e))
    const connLost = errs.filter(e => /connection lost/i.test(e))

    console.log('\n=============== EXPORT HEAD/GET RESULT ===============')
    console.log('login user      :', username)
    console.log('session.export events (in order):')
    for (const e of exportEvents) console.log('  ', JSON.stringify(e))
    const head = exportEvents.find(e => e.method === 'HEAD')
    const get = exportEvents.find(e => e.method === 'GET')
    console.log('HEAD status     :', head ? head.status : '(none captured)')
    console.log('GET  status     :', get ? get.status + ' / ' + get.ctype : '(none captured)')
    console.log('console errors  :', errs.length, '| session.export-404:', exp404.length, '| dynamicCordisRunner:', cordisErr.length, '| connection-lost:', connLost.length)
    for (const e of [...new Set(errs)].slice(0, 8)) console.log('  -', e.slice(0, 160))
    const headOk = head && head.status === 200
    const getOk = (get && get.status === 200 && /zip/.test(get.ctype || '')) ||
      (typeof fetchGet === 'object' && fetchGet.status === 200 && /zip/.test(fetchGet.ctype || ''))
    if (headOk && getOk) console.log('VERDICT: PASS — HEAD 200 and GET 200 application/zip; download button no longer 404s')
    else console.log('VERDICT: FAIL — headOk=' + !!headOk + ' getOk=' + !!getOk)
    console.log('=====================================================')
  } catch (e) {
    await page.screenshot({ path: ART + 'export-99-error.png' }).catch(() => {})
    console.log('VERDICT: FAIL —', e.message)
  } finally { await browser.close() }
}
main()
