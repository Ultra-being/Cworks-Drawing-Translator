import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

const keyByUserOrIp = (req: Request) => {
  const userId = (req.session as any)?.userId;
  if (userId) return String(userId);
  return ipKeyGenerator(req.ip ?? '');
};

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  keyGenerator: keyByUserOrIp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// Public vendor intake — unauthenticated, so throttle aggressively per IP.
export const vendorUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: keyByUserOrIp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'ai_rate_limited' },
});
