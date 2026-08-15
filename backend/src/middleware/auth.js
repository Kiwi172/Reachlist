import { verifyToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  // tokenVersion mismatch means the user's sessions were revoked after this
  // token was issued (password change, explicit logout-everywhere).
  if (!user || user.tokenVersion !== payload.tv) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.user = user;
  next();
}
