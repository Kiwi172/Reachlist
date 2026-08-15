import axios from 'axios';
import { toDomain } from '../lib/url.js';

const KEY = process.env.GOOGLE_PLACES_API_KEY;

// Places API (New). The field mask is mandatory and is what you're billed
// on, so it lists only what the pipeline actually reads.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
].join(',');

export const isConfigured = () => Boolean(KEY);

/**
 * Text search, one query per (businessType x location) pair.
 * Returns raw prospect-shaped objects; dedupe happens in the caller.
 */
export async function search({ criteria, limitPerQuery = 20 }) {
  const out = [];

  for (const type of criteria.businessTypes) {
    for (const loc of criteria.locations) {
      const textQuery = `${type} in ${loc.label}`;
      let res;
      try {
        res = await axios.post(
          'https://places.googleapis.com/v1/places:searchText',
          { textQuery, maxResultCount: Math.min(limitPerQuery, 20) },
          {
            headers: {
              'X-Goog-Api-Key': KEY,
              'X-Goog-FieldMask': FIELD_MASK,
              'Content-Type': 'application/json',
            },
            timeout: 20_000,
          },
        );
      } catch (err) {
        // One bad query shouldn't abort a whole discovery run — a typo'd
        // location is common and the other pairs are still useful.
        out.push({ __error: `Places query "${textQuery}" failed: ${err.response?.data?.error?.message || err.message}` });
        continue;
      }

      for (const p of res.data?.places || []) {
        // CLOSED_PERMANENTLY businesses still surface in text search.
        if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;

        const country = (p.addressComponents || []).find((c) =>
          (c.types || []).includes('country'),
        );

        out.push({
          name: p.displayName?.text || 'Unknown',
          websiteUrl: p.websiteUri || null,
          domain: toDomain(p.websiteUri),
          phone: p.nationalPhoneNumber || null,
          address: p.formattedAddress || null,
          countryCode: country?.shortText || loc.countryCode || null,
          category: p.primaryTypeDisplayName?.text || type,
          rating: typeof p.rating === 'number' ? p.rating : null,
          reviewCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
          meta: { source: 'places', placeId: p.id, query: textQuery },
        });
      }
    }
  }

  return out;
}
