import { createHash } from 'node:crypto'
import { liveFetch } from './live-api'
import { logBroker } from './database'

// ============================================================
// Broker OAuth-style session creation (aligned with the
// straweb/hedging broker/*/api/auth_api.py flows).
//
// All three live brokers use an app-credential + session-exchange
// model — API key/secret (+ user id / client id) create a session
// token that the adapters then use for every data/order call:
//
//  ICICI DIRECT BREEZE
//    credentials: apiKey (AppKey) + apiSecret
//    1. user opens  https://api.icicidirect.com/apiuser/login?api_key=<key>
//    2. ICICI redirects to the registered URL with ?apisession=...
//    3. exchange at /breezeapi/api/v1/customerdetails
//       { SessionToken, AppKey } -> base64 "user_id:session_key"
//    => store sessionToken (= session_key), apiSession, userId
//
//  DHAN
//    credentials: appId (app_id) + appSecret + clientId (dhan client id)
//    1. POST auth.dhan.co/app/generate-consent?client_id=<id>
//       headers app_id/app_secret -> { consentAppId }
//    2. user opens auth.dhan.co/login/consentApp-login?consentAppId=...
//       and is redirected with ?tokenId=...
//    3. POST auth.dhan.co/app/consumeApp-consent?tokenId=...
//       -> { accessToken, dhanClientId, expiryTime }
//    (a direct JWT access-token paste is also accepted)
//    => store accessToken, clientId
//
//  SHOONYA (Noren)
//    credentials: userId + apiKey (app client_id) + apiSecret
//    OAuth:  prism login page ?api_key=... -> redirect ?code=...
//            POST NorenWClientAPI/GenAcsTok
//            jData={code, checksum=sha256(client_id+secret+code)}
//            -> { susertoken }
//    QuickAuth (direct): jData={uid,pwd,factor2(PAN/DOB),vc,appkey=
//            sha256(uid|secret),imei,source,totp?} -> { susertoken }
//    => store sessionId (= susertoken), userId, apiKey, apiSecret
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
const SHOONYA_API = 'https://api.shoonya.com/NorenWClientAPI'

// consent state kept in-memory per account (Dhan step-1 output)
const consentStore = new Map<string, string>()

function required(creds: Record<string, string> | null, keys: string[]): string | null {
  if (!creds) return null
  for (const k of keys) if (!creds[k]?.trim()) return null
  return keys.map(k => creds[k].trim()).join('|')
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
          'Paste that apisession token here — it is exchanged server-side at customerdetails for your session_key.',
        ],
        fieldsNeeded: ['apisession (from the redirect URL)'],
      }
    }
    case 'DHAN': {
      const ok = required(creds, ['appId', 'appSecret', 'clientId']) !== null
      return {
        loginUrl: null, // filled after generate-consent (async) — see dhanConsentUrl()
        instructions: ok
          ? [
              'Press "Generate consent" — the terminal calls auth.dhan.co/app/generate-consent with app_id + app_secret.',
              'Open the returned consentApp-login URL, log in, and copy the tokenId from the redirect (?tokenId=...).',
              'Paste the tokenId here — consumeApp-consent returns the accessToken + dhanClientId.',
              'Alternatively paste a direct JWT access token (from web.dhan.co) in the same box.',
            ]
          : ['Save the account with App ID + App Secret + Client ID first.'],
        fieldsNeeded: ok ? ['tokenId (redirect) OR a direct access token'] : ['appId', 'appSecret', 'clientId'],
      }
    }
    case 'SHOONYA': {
      const ok = required(creds, ['apiKey', 'apiSecret']) !== null
      return {
        loginUrl: ok ? `https://prism.shoonya.com/login?api_key=${encodeURIComponent(creds!.apiKey.trim())}` : null,
        instructions: [
          'Open the Shoonya prism login URL below (api_key = your app client_id).',
          'After login, Shoonya redirects to your registered redirect URL with ?code=...',
          'Paste that code here — GenAcsTok exchanges it (checksum sha256(client_id+secret+code)) for the susertoken.',
          'Direct mode: use QuickAuth with user id + password + PAN/DOB (+ TOTP) instead.',
        ],
        fieldsNeeded: ok ? ['code (from the redirect URL) — or QuickAuth password/factor2/TOTP'] : ['apiKey (client_id)', 'apiSecret'],
      }
    }
    default:
      return { loginUrl: null, instructions: ['Sim feed accounts need no broker session.'], fieldsNeeded: [] }
  }
}

/** Dhan step 1 — generate consent, keep the consentAppId in memory. */
export async function dhanGenerateConsent(accountId: string, creds: Record<string, string> | null): Promise<{ ok: boolean; loginUrl?: string; message: string }> {
  const missing = required(creds, ['appId', 'appSecret', 'clientId'])
  if (!missing) return { ok: false, message: 'Dhan needs appId + appSecret + clientId saved on the account first' }
  const [appId, appSecret, clientId] = missing.split('|')
  const res = await liveFetch<{ status?: string; consentAppId?: string }>(
    `${DHAN_AUTH}/app/generate-consent?client_id=${encodeURIComponent(clientId)}`,
    { method: 'POST', headers: { app_id: appId, app_secret: appSecret }, timeoutMs: 8000 },
  )
  if (res.data?.status === 'success' && res.data.consentAppId) {
    consentStore.set(accountId, res.data.consentAppId)
    return { ok: true, loginUrl: `${DHAN_AUTH}/login/consentApp-login?consentAppId=${encodeURIComponent(res.data.consentAppId)}`, message: 'Consent generated — open the login URL' }
  }
  return { ok: false, message: `generate-consent failed — ${res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? res.status}` }
}

/** Exchange the redirect code/session for session tokens (per broker). */
export async function authComplete(brokerType: string, accountId: string, creds: Record<string, string> | null, code: string): Promise<AuthCompleteResult> {
  const c = (code ?? '').trim()
  if (!c) return { ok: false, message: 'Paste the redirect code/session token first' }
  try {
    switch (brokerType) {
      case 'ICICI_BREEZE': {
        if (!creds?.apiKey) return { ok: false, message: 'Save the account with its Breeze API key (AppKey) first' }
        // hedging flow: customerdetails exchange {SessionToken, AppKey}
        // (official SDK sends GET + body — Node fetch can't, so POST first,
        // then GET with query params as fallback)
        const body = { SessionToken: c, AppKey: creds.apiKey.trim() }
        let res = await liveFetch<{ Status?: number; Success?: { session_token?: string }; Error?: string }>(ICICI_CUSTOMER_DETAILS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: 10_000,
        })
        if (!res.data?.Success?.session_token) {
          res = await liveFetch<{ Status?: number; Success?: { session_token?: string }; Error?: string }>(
            `${ICICI_CUSTOMER_DETAILS}?SessionToken=${encodeURIComponent(c)}&AppKey=${encodeURIComponent(creds.apiKey.trim())}`,
            { method: 'GET', headers: { 'Content-Type': 'application/json' }, timeoutMs: 10_000 },
          )
        }
        const encoded = res.data?.Success?.session_token
        if (!encoded) return { ok: false, message: `customerdetails failed — ${res.data?.Error ?? res.error ?? res.status}` }
        let userId = '', sessionKey = ''
        try {
          const decoded = Buffer.from(encoded, 'base64').toString('ascii')
          const idx = decoded.indexOf(':')
          if (idx > 0) { userId = decoded.slice(0, idx).trim(); sessionKey = decoded.slice(idx + 1).trim() }
        } catch { /* fallthrough */ }
        if (!sessionKey) return { ok: false, message: 'ICICI returned an invalid session_token (base64 user:session expected)' }
        logBroker('ICICI_BREEZE', accountId, `OAuth session created for ${userId || 'user'}`)
        return {
          ok: true,
          message: `ICICI Breeze session active${userId ? ` — ${userId}` : ''}`,
          userId,
          credentials: { ...creds, sessionToken: sessionKey, apiSession: c, ...(userId ? { userId } : {}) },
        }
      }
      case 'DHAN': {
        if (!creds?.appId || !creds?.appSecret) return { ok: false, message: 'Save the account with Dhan App ID + App Secret first' }
        const headers = { app_id: creds.appId.trim(), app_secret: creds.appSecret.trim(), 'Content-Type': 'application/json' }
        // direct JWT paste (access tokens are long JWT strings)
        if (c.length > 100) {
          logBroker('DHAN', accountId, 'Direct access token saved')
          return { ok: true, message: 'Dhan access token saved', credentials: { ...creds, accessToken: c } }
        }
        const res = await liveFetch<{ accessToken?: string; dhanClientId?: string; dhanClientName?: string; expiryTime?: string }>(
          `${DHAN_AUTH}/app/consumeApp-consent?tokenId=${encodeURIComponent(c)}`,
          { method: 'POST', headers, timeoutMs: 8000 },
        )
        if (res.data?.accessToken) {
          const clientId = res.data.dhanClientId ?? creds.clientId ?? ''
          logBroker('DHAN', accountId, `OAuth session created for ${clientId}`)
          return {
            ok: true,
            message: `Dhan session active — ${clientId || 'client'}${res.data.expiryTime ? ` (expires ${res.data.expiryTime})` : ''}`,
            userId: clientId,
            credentials: { ...creds, accessToken: res.data.accessToken, clientId },
          }
        }
        return { ok: false, message: `consumeApp-consent failed — ${res.data ? JSON.stringify(res.data).slice(0, 160) : res.error ?? res.status}` }
      }
      case 'SHOONYA': {
        if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, message: 'Save the account with Shoonya api_key (client_id) + api_secret first' }
        const clientId = creds.apiKey.trim()
        // QuickAuth shorthand: "pwd:factor2(:totp)" → direct session without the browser
        if (c.includes(':') && !c.startsWith('jData')) {
          const [pwd, factor2, totp] = c.split(':').map(s => s.trim())
          if (pwd && factor2) {
            const merged = { ...creds, qaPassword: pwd, qaFactor2: factor2, ...(totp ? { qaTotp: totp } : {}) }
            if (!creds.userId) return { ok: false, message: 'Save User ID (login id) on the account for QuickAuth' }
            const appKey = createHash('sha256').update(`${creds.userId.trim()}|${creds.apiSecret.trim()}`).digest('hex')
            const payload: Record<string, string> = {
              apkversion: '1.0.0', uid: creds.userId.trim(), pwd, factor2,
              vc: `${creds.userId.trim()}_U`, appkey: appKey, imei: 'abc1234', source: 'WEB',
            }
            if (totp) payload.totp = totp
            const res2 = await liveFetch<{ stat?: string; susertoken?: string; emsg?: string }>(
              `${SHOONYA_API}/QuickAuth`,
              { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify(payload)}`, timeoutMs: 8000 },
            )
            if (res2.data?.stat === 'Ok' && res2.data.susertoken) {
              logBroker('SHOONYA', accountId, 'QuickAuth session created')
              return { ok: true, message: 'Shoonya session active (QuickAuth)', userId: creds.userId, credentials: { ...merged, sessionId: res2.data.susertoken } }
            }
            return { ok: false, message: `QuickAuth failed — ${res2.data?.emsg ?? res2.error ?? res2.status}` }
          }
        }
        // OAuth GenAcsTok when a redirect code is given
        const checksum = createHash('sha256').update(`${clientId}${creds.apiSecret.trim()}${c}`).digest('hex')
        const res = await liveFetch<{ stat?: string; access_token?: string; susertoken?: string; emsg?: string }>(
          `${SHOONYA_API}/GenAcsTok`,
          { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `jData=${JSON.stringify({ code: c, checksum })}`, timeoutMs: 8000 },
        )
        const token = res.data?.access_token ?? res.data?.susertoken
        if (res.data?.stat === 'Ok' && token) {
          logBroker('SHOONYA', accountId, 'OAuth (GenAcsTok) session created')
          return { ok: true, message: 'Shoonya session active (GenAcsTok)', userId: creds.userId ?? null, credentials: { ...creds, sessionId: token } }
        }
        return { ok: false, message: `GenAcsTok failed — ${res.data?.emsg ?? res.error ?? res.status} (or use QuickAuth: pwd:factor2)` }
      }
      default:
        return { ok: false, message: `Broker ${brokerType} has no live session flow (sim feed needs none)` }
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'auth failed' }
  }
}
