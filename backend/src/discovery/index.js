import * as places from './places.js';
import * as overpass from './overpass.js';
import * as web from './web.js';
import { toDomain } from '../lib/url.js';

/**
 * Routes a campaign to a discovery adapter and returns deduped candidates.
 *
 * `mode` is the campaign's discoveryMode (AI-chosen, user-overridable).
 * Within "places", Google is preferred and OSM is the keyless fallback, so
 * the tool is usable before any billing setup exists.
 */
export function resolveAdapter(mode) {
  if (mode === 'web') {
    if (!web.isConfigured()) {
      throw new Error(
        'Web discovery needs BRAVE_SEARCH_API_KEY. Sign up at https://api-dashboard.search.brave.com/ — new accounts get a small monthly credit rather than an open free tier.',
      );
    }
    return { name: 'brave', adapter: web };
  }
  if (places.isConfigured()) return { name: 'google-places', adapter: places };
  return { name: 'openstreetmap', adapter: overpass };
}

export async function discover({ criteria, mode, limitPerQuery }) {
  const { name, adapter } = resolveAdapter(mode);
  const raw = await adapter.search({ criteria, limitPerQuery });

  const warnings = [];
  const byKey = new Map();

  for (const item of raw) {
    if (item.__error) {
      warnings.push(item.__error);
      continue;
    }

    // Domain is the dedupe key when present. Chains and franchises share a
    // domain across branches, so fall back to name+address to keep those
    // as distinct prospects rather than collapsing a whole chain into one.
    const domain = item.domain || toDomain(item.websiteUrl);
    const key = domain
      ? `d:${domain}`
      : `n:${item.name.toLowerCase()}|${(item.address || '').toLowerCase()}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, domain });
      continue;
    }
    // Same business seen twice — keep whichever record is more complete.
    byKey.set(key, {
      ...existing,
      email: existing.email || item.email,
      emailSource: existing.emailSource || item.emailSource,
      phone: existing.phone || item.phone,
      address: existing.address || item.address,
      websiteUrl: existing.websiteUrl || item.websiteUrl,
      rating: existing.rating ?? item.rating,
      reviewCount: existing.reviewCount ?? item.reviewCount,
    });
  }

  return { source: name, prospects: [...byKey.values()], warnings };
}
