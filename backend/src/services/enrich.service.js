import axios from 'axios';
import * as cheerio from 'cheerio';
import { toDomain } from '../lib/url.js';

/**
 * Finds a business's published contact address by reading its own website.
 *
 * This is deliberately the only email source in the pipeline. Guessing
 * patterns (first.last@domain) or buying lists produces addresses that were
 * never published for contact, which is both the main driver of hard
 * bounces and the part that has no defence under GDPR. An address the
 * business itself puts on its public contact page is the defensible case.
 */

const UA = 'OutreachBot/1.0 (+contact discovery; respects robots.txt)';
const TIMEOUT = 12_000;
const MAX_BYTES = 2 * 1024 * 1024;

// Ordered by how likely they are to be a real, monitored inbox.
const CONTACT_PATHS = ['/contact', '/contact-us', '/contacts', '/about', '/about-us', '/impressum', '/legal-notice'];

// Addresses that exist on nearly every site but reach nobody useful, plus
// the ones that are actively harmful to email (abuse@, postmaster@).
const JUNK_LOCALPARTS = new Set([
  'abuse', 'postmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'bounce', 'bounces', 'unsubscribe', 'privacy', 'dpo',
  'security', 'webmaster', 'root', 'admin@localhost', 'example', 'you',
  'name', 'email', 'your', 'someone', 'user', 'test',
]);

// Preference order: shared business inboxes first. A named individual's
// address is personal data under GDPR with a much narrower basis for
// processing, so it's used only as a last resort and flagged as such.
const ROLE_PRIORITY = [
  'hello', 'info', 'contact', 'enquiries', 'inquiries', 'office', 'mail',
  'sales', 'bookings', 'reception', 'team', 'support', 'admin', 'ask',
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

async function fetchText(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    timeout: TIMEOUT,
    maxRedirects: 3,
    maxContentLength: MAX_BYTES,
    responseType: 'text',
    // 404s on guessed contact paths are expected and shouldn't throw.
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) return null;
  const ctype = res.headers['content-type'] || '';
  if (!ctype.includes('html')) return null;
  return typeof res.data === 'string' ? res.data : null;
}

/**
 * Minimal robots.txt check for our own user-agent and `*`.
 *
 * Not a full RFC implementation — it handles the prefix-match Disallow
 * rules that make up essentially all real robots.txt files, and fails open
 * on a malformed or unreachable file, which matches how crawlers behave.
 */
async function loadRobots(origin) {
  let txt;
  try {
    txt = await fetchText(`${origin}/robots.txt`);
  } catch {
    return { disallow: [] };
  }
  if (!txt) return { disallow: [] };

  const disallow = [];
  let applies = false;
  for (const line of txt.split('\n').slice(0, 500)) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const [rawKey, ...rest] = clean.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase().includes('outreachbot');
    } else if (key === 'disallow' && applies && value) {
      disallow.push(value);
    }
  }
  return { disallow };
}

const isAllowed = (robots, path) => !robots.disallow.some((d) => path.startsWith(d));

function pickBest(candidates, siteDomain) {
  // Same-domain addresses first — a Gmail address scraped off a site is
  // usually a third party (the web designer, a stock template).
  const onDomain = candidates.filter((e) => e.endsWith(`@${siteDomain}`));
  const pool = onDomain.length ? onDomain : candidates;
  if (!pool.length) return null;

  for (const role of ROLE_PRIORITY) {
    const hit = pool.find((e) => e.split('@')[0].toLowerCase() === role);
    if (hit) return { email: hit, isRole: true };
  }
  return { email: pool[0], isRole: false };
}

function extractFrom(html, siteDomain) {
  const $ = cheerio.load(html);
  const found = new Set();
  let sawMailto = false;

  $('a[href^="mailto:"]').each((_, el) => {
    const raw = ($(el).attr('href') || '').slice(7).split('?')[0].trim();
    const m = raw.match(EMAIL_RE);
    if (m) {
      sawMailto = true;
      m.forEach((e) => found.add(e.toLowerCase()));
    }
  });

  // Scripts and styles are full of things that look like addresses
  // (version strings, CSS selectors, tracking ids). Strip before scanning.
  $('script, style, noscript').remove();
  const text = $('body').text();
  for (const m of text.match(EMAIL_RE) || []) found.add(m.toLowerCase());

  const cleaned = [...found].filter((e) => {
    const [local, dom] = e.split('@');
    if (!local || !dom) return false;
    if (JUNK_LOCALPARTS.has(local.toLowerCase())) return false;
    // Image filenames caught by the regex, e.g. logo@2x.png
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(e)) return false;
    if (/^(example|domain|yoursite|website)\./i.test(dom)) return false;
    if (e.length > 100) return false;
    return true;
  });

  return { candidates: cleaned, sawMailto };
}

/**
 * @returns {{email, source, isRole} | {email: null, reason: string}}
 */
export async function findContactEmail({ websiteUrl }) {
  const domain = toDomain(websiteUrl);
  if (!domain) return { email: null, reason: 'no website' };

  const origin = `https://${domain}`;
  let robots;
  try {
    robots = await loadRobots(origin);
  } catch {
    robots = { disallow: [] };
  }

  // Homepage first, then likely contact pages. Stops at the first page
  // yielding a usable address — this is capped at 8 requests per business.
  const paths = ['/', ...CONTACT_PATHS];
  let blockedAll = true;

  for (const path of paths) {
    if (!isAllowed(robots, path)) continue;
    blockedAll = false;

    let html;
    try {
      html = await fetchText(origin + path);
    } catch {
      continue;
    }
    if (!html) continue;

    const { candidates, sawMailto } = extractFrom(html, domain);
    const best = pickBest(candidates, domain);
    if (best) {
      return {
        email: best.email,
        isRole: best.isRole,
        source: sawMailto
          ? path === '/' ? 'site_mailto' : 'site_contact_page'
          : 'site_text',
      };
    }
  }

  if (blockedAll) return { email: null, reason: 'blocked by robots.txt' };
  return { email: null, reason: 'no published contact address found' };
}
