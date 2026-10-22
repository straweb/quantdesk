import { PrismaClient } from '@prisma/client'

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