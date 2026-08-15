import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is not set');

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, tv: user.tokenVersion },
    SECRET,
    { expiresIn: '7d', algorithm: 'HS256' },
  );
}

export function verifyToken(token) {
  // Algorithm is pinned — without it a token with alg:none is accepted.
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}
