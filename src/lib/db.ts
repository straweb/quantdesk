import { PrismaClient } from '@prisma/client'
import { mkdirSync } from 'fs'
import { join } from 'path'

// ============================================================
// Fresh-clone safety: a checkout without .env makes PrismaClient
// throw "Environment variable not found: DATABASE_URL" on the
// first query and login answered a bare 503. Fall back to the
// documented default location (db/custom.db) instead.
// ============================================================
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:' + join(process.cwd(), 'db', 'custom.db')
  console.warn('[db] DATABASE_URL not set — using default', process.env.DATABASE_URL)
}
// SQLite creates the database FILE but never its directory.
try {
  mkdirSync(join(process.cwd(), 'db'), { recursive: true })
} catch { /* exists */ }

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // query-level logging spams megabytes into dev.log every minute
    // (per-second polls) — that single file grew to 76MB and broke the
    // platform workspace archiver. Keep warn/error only.
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
