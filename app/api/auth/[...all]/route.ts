import { getAuth } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

const handle = async (request: Request) => (await getAuth()).handler(request)

export { handle as GET, handle as POST }
