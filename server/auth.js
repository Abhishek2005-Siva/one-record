// Stateless signed tokens, so sign-in works no matter which server instance answers.
// Set SESSION_SECRET in production. Without it a random secret is used per process (fine locally).
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
const mac = (s) => createHmac('sha256', SECRET).update(s).digest('base64url');

export function sign(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
