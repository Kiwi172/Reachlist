import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { recordUnsubscribe, recordBounce } from '../services/send.service.js';
import { generateCriteria, GeminiError } from '../services/gemini.service.js';
import { normalizeCriteria } from '../lib/criteria.js';
import { discover } from '../discovery/index.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// --- unsubscribe ------------------------------------------------------------

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6;color:#111}
h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#555}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}
</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

/**
 * RFC 8058 one-click unsubscribe. Gmail and Yahoo send an unauthenticated
 * POST here, so it must work with no session, no confirmation step and no
 * JavaScript. GET is the human-clickable equivalent and is treated the
 * same — a confirmation page that requires a second click gets reported as
 * spam instead of completing.
 */
async function handleUnsubscribe(req, res) {
  const ok = await recordUnsubscribe(req.params.token);
  if (req.method === 'POST') return res.status(ok ? 200 : 404).end();
  res
    .status(ok ? 200 : 404)
    .send(
      ok
        ? page('You have been unsubscribed', 'Your address has been added to our permanent do-not-contact list. You will not receive further messages from us.')
        : page('Link not recognised', 'This unsubscribe link is invalid or has already been used.'),
    );
}

router.get('/unsubscribe/:token', handleUnsubscribe);
router.post('/unsubscribe/:token', handleUnsubscribe);

// --- bounce / complaint webhook --------------------------------------------

/**
 * Amazon SES notifications, delivered over SNS.
 *
 * Bounces and complaints are the only reliable signal that a list is bad,
 * and SES suspends accounts that ignore them, so every notification lands
 * in the suppression list immediately.
 */
router.post('/webhooks/ses', async (req, res, next) => {
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // SNS subscription handshake.
    if (raw?.Type === 'SubscriptionConfirmation' && raw.SubscribeURL) {
      // Only confirm URLs that are genuinely SNS endpoints — this route is
      // public, so an attacker could otherwise use it as a blind SSRF.
      if (/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//.test(raw.SubscribeURL)) {
        await axios.get(raw.SubscribeURL, { timeout: 10_000 });
      }
      return res.json({ ok: true });
    }

    const message = typeof raw?.Message === 'string' ? JSON.parse(raw.Message) : raw;

    if (message?.notificationType === 'Bounce' || message?.eventType === 'Bounce') {
      const bounce = message.bounce || {};
      // Soft bounces (mailbox full, out of office) shouldn't permanently
      // suppress an otherwise-valid address.
      if (bounce.bounceType === 'Permanent') {
        for (const r of bounce.bouncedRecipients || []) {
          await recordBounce(r.emailAddress, 'bounce');
        }
      }
    } else if (message?.notificationType === 'Complaint' || message?.eventType === 'Complaint') {
      for (const r of message.complaint?.complainedRecipients || []) {
        await recordBounce(r.emailAddress, 'complaint');
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- free public lead finder (the ad-supported site) ------------------------

/**
 * The whole public tier: describe a product, get criteria and a short list
 * of matching businesses. Deliberately read-only — it discovers, but has no
 * path to enrichment or sending. That keeps the anonymous surface free of
 * anything that could be pointed at a mailbox, and it is also the natural
 * upgrade boundary for the signed-in product.
 */
const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'Free preview limit reached. Try again in an hour.' },
});

router.post('/public/preview', publicLimiter, async (req, res, next) => {
  try {
    const { description, locationHint } = req.body || {};
    if (!description || description.length < 30) {
      return res.status(400).json({ error: 'Describe your product in at least 30 characters.' });
    }

    let criteria;
    try {
      criteria = normalizeCriteria(
        await generateCriteria({
          productName: 'Product',
          productDescription: description.slice(0, 2000),
          locationHint: locationHint?.slice(0, 200),
        }),
      );
    } catch (err) {
      if (err instanceof GeminiError) return res.status(502).json({ error: err.message });
      throw err;
    }

    // Trimmed to one business type and one location so a free preview
    // can't burn the whole month of Places or Brave quota in one request.
    const trimmed = {
      ...criteria,
      businessTypes: criteria.businessTypes.slice(0, 1),
      locations: criteria.locations.slice(0, 1),
      searchQueries: criteria.searchQueries.slice(0, 2),
    };

    let sample = [];
    try {
      const { prospects } = await discover({ criteria: trimmed, mode: criteria.discoveryMode, limitPerQuery: 10 });
      sample = prospects.slice(0, 8).map((p) => ({
        name: p.name,
        websiteUrl: p.websiteUrl,
        address: p.address,
        category: p.category,
        rating: p.rating,
        reviewCount: p.reviewCount,
      }));
    } catch (err) {
      // Preview still has value with criteria alone if discovery is
      // unconfigured or rate-limited.
      console.error('Public preview discovery failed:', err.message);
    }

    res.json({ criteria, sample, sampleTruncated: true });
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

export default router;
