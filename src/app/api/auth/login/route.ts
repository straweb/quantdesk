import { NextRequest, NextResponse } from 'next/server'
import { bootstrap, createSessionToken, login } from '@/lib/services/bootstrap-service'
import { SESSION_COOKIE } from '@/lib/api-auth'

export async function POST(req: NextRequest) {
  await bootstrap()
  const { username, password } = await req.json().catch(() => ({ username: '', password: '' }))
  const ok = await login(String(username || ''), String(password || ''))
  if (!ok) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
  const token = createSessionToken(String(username))
  const res = NextResponse.json({ ok: true, username })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}
