import axios from 'axios';
import { toDomain } from '../lib/url.js';

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

// Overpass has no text search, so free-text business types have to be mapped
// onto OSM tags. This covers the common local-business categories; anything
// unmatched falls back to a name regex, which is noisier but still useful.
const TAG_MAP = [
  [/dentist|dental/i, 'amenity=dentist'],
  [/doctor|clinic|gp|physician/i, 'amenity=doctors'],
  [/vet/i, 'amenity=veterinary'],
  [/pharmac/i, 'amenity=pharmacy'],
  [/gym|fitness|crossfit/i, 'leisure=fitness_centre'],
  [/restaurant|dining/i, 'amenity=restaurant'],
  [/cafe|coffee/i, 'amenity=cafe'],
  [/bar|pub/i, 'amenity=bar'],
  [/bakery/i, 'shop=bakery'],
  [/hairdress|salon|barber/i, 'shop=hairdresser'],
  [/beauty|spa|nail/i, 'shop=beauty'],
  [/garage|mechanic|auto repair/i, 'shop=car_repair'],
  [/car dealer|dealership/i, 'shop=car'],
  [/hotel|lodging/i, 'tourism=hotel'],
  [/florist/i, 'shop=florist'],
  [/butcher/i, 'shop=butcher'],
  [/laundr|dry clean/i, 'shop=laundry'],
  [/pet/i, 'shop=pet'],
  [/optic|eyewear/i, 'shop=optician'],
  [/lawyer|solicitor|attorney/i, 'office=lawyer'],
  [/account|bookkeep/i, 'office=accountant'],
  [/estate agent|realtor|real estate/i, 'office=estate_agent'],
  [/insurance/i, 'office=insurance'],
];

function tagFor(businessType) {
  for (const [re, tag] of TAG_MAP) {
    if (re.test(businessType)) return tag;
  }
  return null;
}

export const isConfigured = () => true; // keyless

/**
 * Free, keyless fallback for local-business discovery.
 *
 * Notably worse than Places: far fewer websites are tagged, there are no
 * ratings, and coverage varies wildly by region. It exists so the tool
 * still works before a Google billing account is set up.
 */
export async function search({ criteria, limitPerQuery = 25 }) {
  const out = [];

  for (const loc of criteria.locations) {
    for (const type of criteria.businessTypes) {
      const tag = tagFor(type);
      const selector = tag
        ? `nwr[${tag}](area.searchArea);`
        : `nwr[name~"${type.replace(/["\\]/g, '')}",i][website](area.searchArea);`;

      const query = `
[out:json][timeout:25];
area[name="${loc.label.split(',')[0].replace(/["\\]/g, '')}"]->.searchArea;
(${selector});
out center ${Math.min(limitPerQuery, 50)};`;

      let res;
      try {
        res = await axios.post(OVERPASS_URL, query, {
          headers: { 'Content-Type': 'text/plain' },
          timeout: 40_000,
        });
      } catch (err) {
        out.push({ __error: `Overpass query for "${type} in ${loc.label}" failed: ${err.message}` });
        continue;
      }

      for (const el of res.data?.elements || []) {
        const t = el.tags || {};
        if (!t.name) continue;

        const website = t.website || t['contact:website'] || null;
        const addr = [t['addr:housenumber'], t['addr:street'], t['addr:city'], t['addr:postcode']]
          .filter(Boolean)
          .join(' ');

        out.push({
          name: t.name,
          websiteUrl: website,
          domain: toDomain(website),
          phone: t.phone || t['contact:phone'] || null,
          address: addr || loc.label,
          countryCode: (t['addr:country'] || loc.countryCode || '').toUpperCase() || null,
          category: t.amenity || t.shop || t.office || t.leisure || type,
          rating: null,
          reviewCount: null,
          // OSM publishes contact emails directly, which saves a crawl.
          email: t.email || t['contact:email'] || null,
          emailSource: t.email || t['contact:email'] ? 'osm' : null,
          meta: { source: 'overpass', osmId: `${el.type}/${el.id}`, query: `${type} in ${loc.label}` },
        });
      }
    }
  }

  return out;
}
