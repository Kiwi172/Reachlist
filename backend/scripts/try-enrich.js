/** Ad-hoc check of the contact crawler against real sites. */
import 'dotenv/config';
import { findContactEmail } from '../src/services/enrich.service.js';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.log('usage: node scripts/try-enrich.js <url> [url...]');
  process.exit(1);
}
for (const url of urls) {
  const t = Date.now();
  try {
    const r = await findContactEmail({ websiteUrl: url });
    console.log(`${url.padEnd(30)} -> ${r.email || `(none: ${r.reason})`} ${r.email ? `[${r.source}, role=${r.isRole}]` : ''} ${Date.now() - t}ms`);
  } catch (e) {
    console.log(`${url.padEnd(30)} -> ERROR ${e.message}`);
  }
}
