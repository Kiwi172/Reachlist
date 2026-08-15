import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Generic message either way — a distinct "already registered" reply
    // turns this endpoint into an account-existence oracle.
    if (existing) return res.status(400).json({ error: 'Could not create account with those details' });

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 12),
        name: name || null,
      },
    });
    res.json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = email ? await prisma.user.findUnique({ where: { email: email.toLowerCase() } }) : null;
    const ok = user && (await bcrypt.compare(password || '', user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name } });
});

export default router;
