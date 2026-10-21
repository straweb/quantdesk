import { NextRequest, NextResponse } from 'next/server'
import { bootstrap, createSessionToken, login } from '@/lib/services/bootstrap-service'
import { SESSION_COOKIE } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  let username = ''
  try {
    await bootstrap()
    const body = await req.json().catch(() => ({ username: '', password: '' }))
    username = String(body.username || '')
    const password = String(body.password || '')
    const ok = await login(username, password)
    if (!ok) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }
    const token = createSessionToken(username)
    const res = NextResponse.json({ ok: true, username })
    // Secure only when actually served over HTTPS (preview/gateway is HTTPS;
    // direct http://localhost access must still receive the cookie).
    const isHttps =
      req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https' ||
      new URL(req.url).protocol === 'https:'
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps,
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })
    return res
  } catch (e) {
    console.error('[auth/login] error:', e)
    return NextResponse.json({ error: 'Login temporarily unavailable — try again' }, { status: 503 })
  }
}
