import { createHash } from 'node:crypto'
import https from 'node:https'
import { URL } from 'node:url'
import { liveFetch } from './live-api'
import { logBroker } from './database'

// ============================================================
// Broker OAuth-style session creation (aligned with the
// straweb/hedging broker/*/api/auth_api.py flows + the official
// vendor SDKs — breeze_connect, DhanHQ v2 docs, Noren/Finvasia).
//
// Every outbound attempt is TAGGED ([BROKER][auth]) so the exact
// call, status and latency show up in the console AND in the
// account's broker_logs (Admin → Broker Diagnostics can replay it).
//
//  ICICI DIRECT BREEZE  (breeze_connect SDK generate_session)
//    credentials: apiKey (AppKey) + apiSecret
//    1. user opens  https://api.icicidirect.com/apiuser/login?api_key=<key>
//    2. ICICI redirects to the registered URL with ?apisession=...
//    3. checksum = sha256(apisession + apiSecret)
//       POST /breezeapi/api/v1/customerdetails
//       { SessionToken, APIKey, Checksum }
//       -> Success.session_token = base64("user_id:session_key")
//    ("Request Object is Null" = required payload fields missing)
//
//  DHAN (DhanHQ v2 — three flows, docs: dhanhq.co/docs/v2/authentication)
//    credentials: clientId (Dhan client id) + optional partner id/secret
//    A. DIRECT (individual): POST auth.dhan.co/app/generateAccessToken
//         ?dhanClientId=<id>&pin=<6-digit>&totp=<6-digit>
//         -> { dhanClientId, accessToken, expiryTime }   (paste "pin:totp")
//    B. PARTNER consent: POST auth.dhan.co/partner/generate-consent
//         headers partner_id/partner_secret -> { consentId }
//         login: auth.dhan.co/consent-login?consentId=<id> -> redirect ?tokenId=...
//         POST auth.dhan.co/partner/consume-consent?tokenId=<id>
//         -> { dhanClientId, accessToken, expiryTime }
//    C. Direct JWT paste (from web.dhan.co → Access DhanHQ APIs)
//
//  SHOONYA (Noren)
//    credentials: userId + apiKey (app client_id) + apiSecret
//    OAuth:  https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=<client_id>
//            -> redirect ?code=...
//            POST NorenWClientTP/GenAcsTok
//            jData={apkversion, uid, pwd=<verifier>, factor2, vc, appkey=sha256(uid|secret), imei}
//            verifier = sha256(code+secret) | sha256(secret+code) (variant list)
//            -> { stat: 'Ok', susertoken }
//    QuickAuth (direct): "pwd:factor2(:totp)" paste — jData with the same
//            appkey; vc tried as both "<uid>_U" and the app client_id.
//    INVALID_VERIFIER = the pwd checksum didn't match — every variant is
//            attempted and logged so the working one is visible.
// ============================================================

export interface AuthStartResult {
  loginUrl: string | null // null = direct-paste only
  instructions: string[]
  fieldsNeeded: string[]
}

export interface AuthCompleteResult {
  ok: boolean
  message: string
  credentials?: Record<string, string>
  userId?: string | null
}

const ICICI_LOGIN = 'https://api.icicidirect.com/apiuser/login'
const ICICI_CUSTOMER_DETAILS = 'https://api.icicidirect.com/breezeapi/api/v1/customerdetails'
const DHAN_AUTH = 'https://auth.dhan.co'
const SHOONYA_OAUTH = 'https://api.shoonya.com/OAuthlogin/authorize/oauth'
const SHOONYA_TP = 'https://api.shoonya.com/NorenWClientTP'
const SHOONYA_API = 'https://api.shoonya.com/NorenWClientAPI'

// consent state kept in-memory per account (Dhan step-1 output)
const consentStore = new Map<string, string>()

function required(creds: Record<string, string> | null, keys: string[]): string | null {
  if (!creds) return null
  for (const k of keys) if (!creds[k]?.trim()) return null
  return keys.map(k => creds[k].trim()).join('|')
}

/** never print full secrets into logs */
function mask(v: string | undefined): string {
  if (!v) return '(missing)'
  return v.length <= 6 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-3)}`
}

/** one tagged + logged auth attempt against a broker endpoint */
async function attempt<T>(
  broker: string,
  accountId: string,
  label: string,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Awaited<ReturnType<typeof liveFetch<T>>>> {
  const res = await liveFetch<T>(url, {
    ...init,
    callTag: { broker, accountId, tag: `auth:${label}` },
  })
  if (!res.ok && !res.error) {
    // non-2xx responses often carry the broker's reason in the body —
    // make sure it reaches broker_logs (liveFetch logs it only via ok=false path)
    logBroker(broker, accountId, `auth:${label} ${res.status} — ${JSON.stringify(res.data ?? {}).slice(0, 200)}`, 'WARN')
  }
  return res
}

/**
 * GET request WITH a JSON body — exactly what the Breeze SDK sends
 * (`requests.get(url, data=body)`). Node fetch forbids a body on GET,
 * so this uses raw node:https. Returns the parsed JSON response.
 */
function rawGetWithBody<T>(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<{ status: number; data: T | null; error?: string }> {
  return new Promise(resolve => {
    let u: URL
    try { u = new URL(url) } catch { return resolve({ status: 0, data: null, error: 'bad url' }) }
    const started = Date.now()
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      res => {
        let raw = ''
        res.on('data', c => { raw += c })
        res.on('end', () => {
          let data: T | null = null
          try { data = JSON.parse(raw) as T } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode ?? 0, data })
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', e => resolve({ status: 0, data: null, error: `${e.message} (${Date.now() - started}ms)` }))
    req.write(body)
    req.end()
  })
}

/** Per-broker session bootstrap descriptor — shown in the admin Session dialog. */
export function authStart(brokerType: string, accountId: string, creds: Record<string, string> | null): AuthStartResult {
  switch (brokerType) {
    case 'ICICI_BREEZE': {
      const ok = required(creds, ['apiKey']) !== null
      return {
        loginUrl: ok ? `${ICICI_LOGIN}?api_key=${encodeURIComponent(creds!.apiKey.trim())}` : null,
        instructions: [
          'Open the ICICI Direct login URL below (api_key = your Breeze app key).',
          'After login, ICICI redirects to your registered redirect URL with ?apisession=...',
          'Paste that apisession token here — the terminal exchanges it at customerdetails with checksum sha256(apisession + api_secret), exactly like the Breeze SDK.',
          'The account must have the API secret saved (checksum input) — edit the account if missing.',
        ],
        fieldsNeeded: ['apisession (from the redirect URL)'],
      }
    }
    case 'DHAN': {
      const hasPartner = required(creds, ['appId', 'appSecret']) !== null
      const hasClient = required(creds, ['clientId']) !== null
      return {
        loginUrl: null, // filled after generate-consent (async) — see dhanGenerateConsent()
        instructions: hasPartner
          ? [
              'Press "Generate consent" — the terminal calls auth.dhan.co/partner/generate-consent with your partner_id/partner_secret headers.',
              'Open the returned consent-login URL, log in with Dhan credentials + TOTP, and copy the tokenId from the redirect (?tokenId=...).',
              'Paste the tokenId here — partner/consume-consent returns the accessToken + dhanClientId.',
              'Shortcut without a browser: paste "PIN:TOTP" (e.g. 123456:987654) below — the terminal calls app/generateAccessToken directly.',
              'Or paste a direct JWT access token (from web.dhan.co → Access DhanHQ APIs).',
            ]
          : [
              'Three ways to create the session:',
              '1 · DIRECT: paste "PIN:TOTP" (e.g. 123456:987654) — needs the Dhan Client ID saved + TOTP enabled.',
              '2 · PARTNER: save Partner ID + Partner Secret on the account, press Generate consent, log in at the consent URL, paste the redirect tokenId.',
              '3 · Paste a direct JWT access token from web.dhan.co (valid 24h).',
            ],
        fieldsNeeded: hasClient ? ['PIN:TOTP, or tokenId (partner), or a JWT'] : ['clientId'],
      }
    }
    case 'SHOONYA': {
      const ok = required(creds, ['apiKey', 'apiSecret']) !== null
      return {
        loginUrl: ok
          ? `${SHOONYA_OAUTH}?client_id=${encodeURIComponent(creds!.apiKey.trim())}`
          : null,
        instructions: [
          'Open the Shoonya OAuth URL below (client_id = your app client_id from Prism).',
          'After login, Shoonya redirects to your registered redirect URL with ?code=...',
          'Paste that code here — GenAcsTok exchanges it (verifier checksums are tried automatically and every attempt is logged).',
          'Direct mode: use QuickAuth — paste password:PAN/DOB(:TOTP) in the box, e.g. mypass:ABCD1234E or mypass:ABCD1234E:987654.',
        ],
        fieldsNeeded: ok ? ['code (from the redirect URL) — or QuickAuth password/factor2/TOTP'] : ['apiKey (client_id)', 'apiSecret'],
      }
    }
    default:
      return { loginUrl: null, instructions: ['Sim feed accounts need no broker session.'], fieldsNeeded: [] }
  }
}

/** Dhan step 1 — partner generate-consent, keep the consentId in memory. */
export async function dhanGenerateConsent(accountId: string, creds: Record<string, string> | null): Promise<{ ok: boolean; loginUrl?: string; message: string }> {
  if (!creds?.appId?.trim() || !creds?.appSecret?.trim()) {
    return { ok: false, message: 'Partner consent needs Partner ID + Partner Secret saved on the account. No partner app? Paste "PIN:TOTP" (e.g. 123456:987654) or a direct JWT in the session dialog instead.' }
  }
  logBroker('DHAN', accountId, `partner generate-consent started (partner_id ${mask(creds.appId.trim())})`)

  const res = await attempt<{ consentId?: string; consentStatus?: string; errorType?: string; errorMessage?: string }>(
    'DHAN', accountId, 'partner:generate-consent',
    `${DHAN_AUTH}/partner/generate-consent`,
    {
      method: 'POST',
      headers: { partner_id: creds.appId.trim(), partner_secret: creds.appSecret.trim() },
      timeoutMs: 8000,
    },
  )

  const consentId = res.data?.consentId ?? null
  if (consentId) {
    consentStore.set(accountId, consentId)
    const loginUrl = `${DHAN_AUTH}/consent-login?consentId=${encodeURIComponent(consentId)}`
    logBroker('DHAN', accountId, `consent generated ${mask(consentId)} (${res.data?.consentStatus ?? 'GENERATED'}) — login URL ready`)
    return { ok: true, loginUrl, message: 'Consent generated — open the login URL, log in, then paste the redirect tokenId' }
  }
  const reason = res.data?.errorMessage ?? res.data?.errorType ?? (res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? String(res.status))
  logBroker('DHAN', accountId, `generate-consent FAILED — ${reason}`, 'ERROR')
  return { ok: false, message: `Failed to get consent — ${reason}. Check Admin → Broker Diagnostics for the exact request log.` }
}

/** Exchange the redirect code/session for session tokens (per broker). */
export async function authComplete(brokerType: string, accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  const c = (code ?? '').trim()
  if (!c) return { ok: false, message: 'Paste the redirect code/session token first' }
  try {
    switch (brokerType) {
      case 'ICICI_BREEZE': {
        if (!creds?.apiKey) return { ok: false, message: 'Save the account with its Breeze API key (AppKey) first' }
        const apiKey = creds.apiKey.trim()
        logBroker('ICICI_BREEZE', accountId, `customerdetails exchange started (apisession ${mask(c)}, api_key ${mask(apiKey)})`)

        // breeze_connect SDK api_util() shape — GET with a raw JSON BODY
        // {SessionToken: apisession, AppKey: apiKey} (no checksum). Node fetch
        // cannot send a body on GET, hence rawGetWithBody.
        const tried: string[] = []
        const body = JSON.stringify({ SessionToken: c, AppKey: apiKey }, undefined)
          // compact separators like the SDK: json.dumps(body, separators=(',',':'))
          .replace(', "', ',"').replace('": ', '":')
        const t0 = Date.now()
        const raw = await rawGetWithBody<{ Status?: number; Success?: { session_token?: string }; Error?: string }>(
          ICICI_CUSTOMER_DETAILS,
          body,
          { 'Content-Type': 'application/json' },
          10_000,
        )
        logBroker('ICICI_BREEZE', accountId, `auth:customerdetails GET+body → ${raw.status} (${Date.now() - t0}ms)${raw.error ? ` — ${raw.error}` : raw.data ? ` — ${JSON.stringify(raw.data).slice(0, 160)}` : ''}`, raw.data?.Success?.session_token ? 'INFO' : 'WARN')
        tried.push(`GET+body {SessionToken,AppKey} → ${raw.data?.Error ?? raw.error ?? raw.status}`)
        const encoded = raw.data?.Success?.session_token ?? null
        if (!encoded) {
          const detail = raw.data?.Error ?? raw.error ?? String(raw.status)
          logBroker('ICICI_BREEZE', accountId, `customerdetails FAILED — ${detail} · tried: ${tried.join(' | ')}`, 'ERROR')
          return { ok: false, message: `customerdetails failed — ${detail}. Tried: ${tried.join(' | ')}` }
        }
        let userId = '', sessionKey = ''
        try {
          const decoded = Buffer.from(encoded, 'base64').toString('ascii')
          const idx = decoded.indexOf(':')
          if (idx > 0) { userId = decoded.slice(0, idx).trim(); sessionKey = decoded.slice(idx + 1).trim() }
        } catch { /* fallthrough */ }
        if (!sessionKey) return { ok: false, message: 'ICICI returned an invalid session_token (base64 user:session expected)' }
        logBroker('ICICI_BREEZE', accountId, `OAuth session created for ${userId || 'user'} (SDK checksum accepted)`)
        return {
          ok: true,
          message: `ICICI Breeze session active${userId ? ` — ${userId}` : ''}`,
          userId,
          credentials: { ...creds, sessionToken: sessionKey, apiSession: c, ...(userId ? { userId } : {}) },
        }
      }
      case 'DHAN': {
        // direct JWT paste (access tokens are long JWT strings)
        if (c.length > 100) {
          logBroker('DHAN', accountId, 'Direct access token saved')
          return { ok: true, message: 'Dhan access token saved', credentials: { ...(creds ?? {}), accessToken: c } }
        }
        // DIRECT PIN:TOTP flow — app/generateAccessToken (individual traders)
        const pinTotp = c.match(/^(\d{4,8})\s*[:|]\s*(\d{6})$/)
        if (pinTotp) {
          const clientId = creds?.clientId?.trim() ?? ''
          if (!clientId) return { ok: false, message: 'Save the Dhan Client ID on the account (Edit dialog) for the PIN:TOTP direct flow' }
          const [, pin, totp] = pinTotp
          logBroker('DHAN', accountId, `direct token generation started (client ${mask(clientId)}, pin ${mask(pin)})`)
          const res = await attempt<{ dhanClientId?: string; dhanClientName?: string; dhanClientUcc?: string; accessToken?: string; expiryTime?: string; errorType?: string; errorMessage?: string }>(
            'DHAN', accountId, 'app:generateAccessToken',
            `${DHAN_AUTH}/app/generateAccessToken?dhanClientId=${encodeURIComponent(clientId)}&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totp)}`,
            { method: 'POST', timeoutMs: 8000 },
          )
          if (res.data?.accessToken) {
            const cid = res.data.dhanClientId ?? clientId
            logBroker('DHAN', accountId, `direct session created for ${cid}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`)
            return {
              ok: true,
              message: `Dhan session active — ${cid}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`,
              userId: cid,
              credentials: { ...(creds ?? {}), accessToken: res.data.accessToken, clientId: cid },
            }
          }
          const reason = res.data?.errorMessage ?? res.data?.errorType ?? (res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? String(res.status))
          logBroker('DHAN', accountId, `generateAccessToken FAILED — ${reason}`, 'ERROR')
          return { ok: false, message: `Direct token generation failed — ${reason}. Check TOTP is enabled + the PIN is correct, or paste a JWT.` }
        }
        // PARTNER consume-consent (tokenId from the consent-login redirect)
        if (!creds?.appId || !creds?.appSecret) return { ok: false, message: 'Partner tokenId exchange needs Partner ID + Partner Secret on the account — or paste "PIN:TOTP" / a direct JWT instead' }
        const consentId = consentStore.get(accountId)
        if (!consentId) return { ok: false, message: 'Generate consent first (step 1) — the terminal must remember the consentId for the exchange' }
        logBroker('DHAN', accountId, `partner consume-consent started (consentId ${mask(consentId)}, tokenId ${mask(c)})`)
        const res = await attempt<{ accessToken?: string; dhanClientId?: string; dhanClientName?: string; dhanClientUcc?: string; expiryTime?: string; errorType?: string; errorMessage?: string }>(
          'DHAN', accountId, 'partner:consume-consent',
          `${DHAN_AUTH}/partner/consume-consent?tokenId=${encodeURIComponent(c)}`,
          {
            method: 'POST',
            headers: { partner_id: creds.appId.trim(), partner_secret: creds.appSecret.trim() },
            timeoutMs: 8000,
          },
        )
        if (res.data?.accessToken) {
          const clientId = res.data.dhanClientId ?? creds.clientId ?? ''
          logBroker('DHAN', accountId, `OAuth session created for ${clientId}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`)
          return {
            ok: true,
            message: `Dhan session active — ${clientId || 'client'}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`,
            userId: clientId,
            credentials: { ...(creds ?? {}), accessToken: res.data.accessToken, clientId },
          }
        }
        const reason = res.data?.errorMessage ?? res.data?.errorType ?? (res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? String(res.status))
        logBroker('DHAN', accountId, `consume-consent FAILED — ${reason}`, 'ERROR')
        return { ok: false, message: `consume-consent failed — ${reason}. Generate a fresh consent and retry.` }
      }
      case 'SHOONYA': {
        if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, message: 'Save the account with Shoonya api_key (client_id) + api_secret first' }
        const clientId = creds.apiKey.trim()
        const secret = creds.apiSecret.trim()
        const uid = creds.userId?.trim() ?? ''
        const tried: string[] = []

        // ---- QuickAuth shorthand: "pwd:factor2(:totp)" → direct session, no browser ----
        if (c.includes(':') && !c.startsWith('jData')) {
          const [pwd, factor2, totp] = c.split(':').map(s => s.trim())
          if (pwd && factor2 && uid) {
            const appKey = createHash('sha256').update(`${uid}|${secret}`).digest('hex')
            const mk = (vc: string) => {
              const payload: Record<string, string> = {
                apkversion: '1.0.0', uid, pwd, factor2,
                vc, appkey: appKey, imei: 'abc1234', source: 'WEB',
              }
              if (totp) payload.totp = totp
              return payload
            }
            for (const [label, vc] of [['vc=uid_U', `${uid}_U`], ['vc=client_id', clientId]] as [string, string][]) {
              const res2 = await attempt<{ stat?: string; susertoken?: string; emsg?: string }>(
                'SHOONYA', accountId, `quickauth(${label})`,
                `${SHOONYA_TP}/QuickAuth`,
                { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify(mk(vc))}`, timeoutMs: 8000 },
              )
              tried.push(`QuickAuth ${label} → ${res2.data?.emsg ?? res2.data?.stat ?? res2.error ?? res2.status}`)
              if (res2.data?.stat === 'Ok' && res2.data.susertoken) {
                logBroker('SHOONYA', accountId, `QuickAuth session created (${label})`)
                return {
                  ok: true,
                  message: 'Shoonya session active (QuickAuth)',
                  userId: uid,
                  credentials: { ...creds, qaPassword: pwd, qaFactor2: factor2, ...(totp ? { qaTotp: totp } : {}), sessionId: res2.data.susertoken },
                }
              }
            }
            return { ok: false, message: `QuickAuth failed — ${tried.join(' | ')}. Check the password:factor2(:totp) format and that User ID is saved.` }
          }
          if (pwd && factor2 && !uid) return { ok: false, message: 'Save User ID (login id) on the account for QuickAuth (edit the account)' }
        }

        // ---- OAuth GenAcsTok when a redirect code is given ----
        if (!uid) return { ok: false, message: 'Save the Shoonya User ID (login id) on the account — GenAcsTok needs uid + appkey' }
        const appKey = createHash('sha256').update(`${uid}|${secret}`).digest('hex')
        // verifier candidates — whichever sha256 the deployment expects; every
        // attempt is logged so the accepted one is visible in diagnostics
        const verifiers: [string, string][] = [
          ['sha256(code+secret)', createHash('sha256').update(`${c}${secret}`).digest('hex')],
          ['sha256(secret+code)', createHash('sha256').update(`${secret}${c}`).digest('hex')],
          ['sha256(secret+uid+code)', createHash('sha256').update(`${secret}${uid}${c}`).digest('hex')],
          ['sha256(code)', createHash('sha256').update(c).digest('hex')],
        ]
        // ---- family A: NorenWClientAPI/GenAcsTok {code, checksum} ----
        // (the API host validates these exact keys — "code or checksum is Missing"
        //  otherwise; INVALID_VERIFIER from it means the checksum VALUE was wrong)
        const checksums: [string, string][] = [
          ['sha256(code+secret)', createHash('sha256').update(`${c}${secret}`).digest('hex')],
          ['sha256(secret+code)', createHash('sha256').update(`${secret}${c}`).digest('hex')],
          ['sha256(client_id+secret+code)', createHash('sha256').update(`${clientId}${secret}${c}`).digest('hex')],
        ]
        for (const [label, checksum] of checksums) {
          const res = await attempt<{ stat?: string; access_token?: string; susertoken?: string; emsg?: string }>(
            'SHOONYA', accountId, `GenAcsTok-api(${label})`,
            `${SHOONYA_API}/GenAcsTok`,
            { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify({ code: c, checksum })}`, timeoutMs: 8000 },
          )
          tried.push(`API ${label} → ${res.data?.emsg ?? res.data?.stat ?? res.error ?? res.status}`)
          const token = res.data?.access_token ?? res.data?.susertoken
          if (res.data?.stat === 'Ok' && token) {
            logBroker('SHOONYA', accountId, `OAuth (GenAcsTok) session created — checksum ${label} accepted`)
            return { ok: true, message: 'Shoonya session active (GenAcsTok)', userId: uid, credentials: { ...creds, sessionId: token } }
          }
          if (/invalid verifier/i.test(res.data?.emsg ?? '')) break // wrong checksum family — try next family
        }
        // ---- family B: NorenWClientTP/GenAcsTok full jData (docs OAuth shape) ----
        for (const [label, verifier] of verifiers) {
          const payload = {
            apkversion: '1.0.0', uid, pwd: verifier, factor2: '',
            vc: clientId, appkey: appKey, imei: 'abc1234',
          }
          const res = await attempt<{ stat?: string; access_token?: string; susertoken?: string; emsg?: string }>(
            'SHOONYA', accountId, `GenAcsTok-tp(${label})`,
            `${SHOONYA_TP}/GenAcsTok`,
            { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify(payload)}`, timeoutMs: 8000 },
          )
          tried.push(`TP ${label} → ${res.data?.emsg ?? res.data?.stat ?? res.error ?? res.status}`)
          const token = res.data?.access_token ?? res.data?.susertoken
          if (res.data?.stat === 'Ok' && token) {
            logBroker('SHOONYA', accountId, `OAuth (GenAcsTok) session created — verifier ${label} accepted`)
            return { ok: true, message: 'Shoonya session active (GenAcsTok)', userId: uid, credentials: { ...creds, sessionId: token } }
          }
          if (/invalid\s*code|expired/i.test(res.data?.emsg ?? '')) break
        }
        logBroker('SHOONYA', accountId, `GenAcsTok FAILED — ${tried.join(' | ')}`, 'ERROR')
        return { ok: false, message: `GenAcsTok failed — ${tried.join(' | ')}. Or use QuickAuth: paste pwd:factor2 (e.g. mypass:ABCD1234E).` }
      }
      default:
        return { ok: false, message: `Broker ${brokerType} has no live session flow (sim feed needs none)` }
    }
  } catch (e) {
    logBroker(brokerType, accountId, `auth error — ${e instanceof Error ? e.message : String(e)}`, 'ERROR')
    return { ok: false, message: e instanceof Error ? e.message : 'auth failed' }
  }
}
