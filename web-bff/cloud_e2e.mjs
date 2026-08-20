/**
 * Cloud end-to-end: a real headless Chromium hits the LIVE public CloudFront URL
 * (https, redirect-to-https, origin-verify secret injected by CloudFront), logs
 * in as a Cognito test user, binds a workspace, sends a prompt, and asserts the
 * reply from the cloud AgentCore Runtime renders in the conversation surface.
 *
 * Credentials are read in-process from Secrets Manager (never printed).
 * Screenshots land in artifacts/cloud-*.png.
 */
import { chromium } from 'playwright-core'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`
const CF = process.env.CF_BASE ?? 'https://<CLOUDFRONT_DOMAIN>'
const ART = new URL('./artifacts/', import.meta.url).pathname
const PROMPT = 'Use the bash tool to run: echo web-cloud-e2e-ok, and report the output.'

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const rpcs = new Set(); const errs = []
  page.on('request', r => { try { const u = new URL(r.url()); if (r.method() === 'POST' && u.pathname.startsWith('/api/')) rpcs.add(u.pathname.slice(5)) } catch {} })
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', e => errs.push('pageerror: ' + e.message))

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
    console.log('post-login url =', page.url())
    await page.locator('[data-composer-card] textarea').waitFor({ state: 'visible', timeout: 30000 })
    await page.screenshot({ path: ART + 'cloud-01-shell.png' })

    // Dismiss the "Internal Testing Notice" onboarding modal if present (it
    // overlays and would intercept the composer submit).
    for (let i = 0; i < 3; i++) {
      const cont = page.getByRole('button', { name: /^Continue$|继续/ })
      if (await cont.count() && await cont.first().isVisible().catch(() => false)) {
        await cont.first().click({ timeout: 3000 }).catch(() => {})
        await sleep(800)
      } else break
    }

    // Bind a workspace so the hero composer becomes writable.
    for (let attempt = 0; attempt < 4 && !(await writable()); attempt++) {
      if (attempt === 0) {
        await page.getByText('Choose workspace', { exact: false }).first().click({ timeout: 4000 }).catch(() => {})
        await sleep(600)
        // The opened menu lists workspaces; pick AgentCore BFF (menuitem/option, else last match).
        const opt = page.getByRole('menuitem', { name: /AgentCore BFF/i }).or(page.getByRole('option', { name: /AgentCore BFF/i }))
        await opt.first().click({ timeout: 3000 }).catch(async () => {
          await page.getByText('AgentCore BFF', { exact: false }).last().click({ timeout: 3000 }).catch(() => {})
        })
      } else if (attempt === 1) {
        await page.getByRole('button', { name: /New Session|新建会话|新会话/i }).first().click({ timeout: 3000 }).catch(() => {})
      } else {
        // hover the workspace row and click its add-session (+) control
        const row = page.getByText('AgentCore BFF', { exact: false }).first()
        await row.hover().catch(() => {})
        await sleep(300)
        await row.click({ timeout: 2000 }).catch(() => {})
      }
      await sleep(1800)
    }
    await page.screenshot({ path: ART + 'cloud-02-workspace.png' })
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-composer-card] textarea')
      return t && !t.disabled && !t.readOnly && t.getAttribute('data-phase') !== 'inert'
    }, { timeout: 20000 })
    console.log('COMPOSER WRITABLE')

    const composer = page.locator('[data-composer-card] textarea')
    await composer.focus(); await composer.fill(PROMPT); await composer.press('Enter')
    console.log('prompt submitted (Enter)')
    // If Enter did not register a user bubble, click the composer send button.
    await sleep(2500)
    if (await page.locator('[data-chat-flow-kind="user"]').count() === 0) {
      console.log('no user bubble yet; clicking send button')
      await page.locator('[data-composer-card] button').last().click({ timeout: 3000 }).catch(() => {})
    }

    const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
    let reply = ''
    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      if (await page.locator('[data-chat-flow-kind="assistant-step"]').count() > 0) {
        reply = (await assistant.innerText()).trim(); if (reply) break
      }
      await sleep(500)
    }
    await page.screenshot({ path: ART + 'cloud-03-reply.png', fullPage: false })
    const userText = (await page.locator('[data-chat-flow-kind="user"]').count())
      ? (await page.locator('[data-chat-flow-kind="user"]').last().innerText()).trim() : '(none)'

    console.log('\n=============== CLOUD E2E RESULT ===============')
    console.log('login user      :', username)
    console.log('RPCs fired      :', [...rpcs].sort().join(', '))
    console.log('user bubble     :', JSON.stringify(userText.slice(0, 160)))
    console.log('assistant reply :', JSON.stringify(reply.slice(0, 500)))
    console.log('console errors  :', errs.length)
    for (const e of [...new Set(errs)].slice(0, 6)) console.log('  -', e.slice(0, 160))
    console.log('screenshots     :', ART + 'cloud-01-shell.png, cloud-02-workspace.png, cloud-03-reply.png')
    if (!reply) console.log('VERDICT: FAIL — no assistant reply rendered')
    else if (reply.includes('web-cloud-e2e-ok')) console.log('VERDICT: PASS — reply rendered AND contains marker web-cloud-e2e-ok')
    else console.log('VERDICT: PARTIAL — reply rendered (marker not literally present; see text above)')
    console.log('===============================================')
  } catch (e) {
    await page.screenshot({ path: ART + 'cloud-99-error.png' }).catch(() => {})
    console.log('VERDICT: FAIL —', e.message)
  } finally { await browser.close() }
}
main()
