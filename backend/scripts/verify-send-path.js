/**
 * End-to-end check of the send path against the compliance rules, with no
 * external APIs involved. Seeds a campaign and a spread of prospects that
 * each should hit a different gate, sends, and asserts the outcomes.
 *
 * Run with SEND_PROVIDER=console. Safe — nothing leaves the machine.
 *
 *   docker run ... node scripts/verify-send-path.js
 */
import 'dotenv/config';

// compliance.js reads its limits into consts at module load, and ESM
// imports are hoisted above any assignment here — so the throttle has to be
// disabled before these modules are pulled in, via dynamic import. Without
// this the inter-send delay masks whichever rule the next case is testing.
process.env.MIN_SECONDS_BETWEEN_SENDS = '0';

const { prisma } = await import('../src/lib/prisma.js');
const { sendProspect, recordUnsubscribe } = await import('../src/services/send.service.js');
const { suppress } = await import('../src/lib/compliance.js');

const CASES = [
  {
    label: 'US role address',
    data: { name: 'Austin Barbers', domain: 'austinbarbers.test', email: 'hello@austinbarbers.test', emailSource: 'site_contact_page', countryCode: 'US', meta: { isRoleAddress: true } },
    expect: 'sent',
  },
  {
    label: 'UK company role inbox (PECR: corporate subscriber)',
    data: { name: 'Leeds Cuts Ltd', domain: 'leedscuts.test', email: 'info@leedscuts.test', emailSource: 'site_contact_page', countryCode: 'GB', meta: { isRoleAddress: true } },
    expect: 'sent',
  },
  {
    label: 'UK named individual (personal data under GDPR)',
    data: { name: 'York Salon', domain: 'yorksalon.test', email: 'jane.smith@yorksalon.test', emailSource: 'site_contact_page', countryCode: 'GB', meta: { isRoleAddress: false } },
    expect: 'blocked_region',
  },
  {
    label: 'Canada published role inbox (CASL implied consent)',
    data: { name: 'Toronto Trims', domain: 'torontotrims.test', email: 'contact@torontotrims.test', emailSource: 'site_mailto', countryCode: 'CA', meta: { isRoleAddress: true } },
    expect: 'sent',
  },
  {
    label: 'Already unsubscribed',
    data: { name: 'Optout Co', domain: 'optout.test', email: 'hello@optout.test', emailSource: 'site_contact_page', countryCode: 'US', meta: { isRoleAddress: true } },
    expect: 'suppressed',
    presuppress: true,
  },
  {
    label: 'No address found',
    data: { name: 'Ghost Shop', domain: 'ghost.test', email: null, emailSource: null, countryCode: 'US', meta: {} },
    expect: 'no_email',
  },
];

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'verify@example.test' },
    create: { email: 'verify@example.test', passwordHash: 'x', name: 'Verifier' },
    update: {},
  });
  const product = await prisma.product.create({
    data: { userId: user.id, name: 'SalonBook', description: 'Booking software for salons that reduces no-shows.' },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      productId: product.id,
      name: 'verify-run',
      status: 'ready',
      criteria: { valueProposition: 'Cut no-shows.' },
    },
  });

  console.log('\nCompliance gates\n');

  for (const c of CASES) {
    if (c.presuppress) await suppress(c.data.email, 'unsubscribe');

    const prospect = await prisma.prospect.create({
      data: { campaignId: campaign.id, ...c.data, status: 'approved' },
    });
    await prisma.draft.create({
      data: {
        prospectId: prospect.id,
        subject: 'quick question about bookings',
        body: 'Saw you take bookings by phone. We cut no-shows for salons. Worth a reply?',
        approvedAt: new Date(),
      },
    });

    await sendProspect({ campaign, prospect });
    const after = await prisma.prospect.findUnique({ where: { id: prospect.id } });
    check(c.label, after.status === c.expect, `expected ${c.expect}, got ${after.status}`);
  }

  console.log('\nFooter and unsubscribe\n');

  const send = await prisma.send.findFirst({
    where: { campaignId: campaign.id, status: 'sent' },
    orderBy: { createdAt: 'asc' },
  });

  check('Unsubscribe link present in body', send.body.includes(`/unsubscribe/${send.unsubscribeToken}`));
  check('Opt-out wording present', /never hear from us again/i.test(send.body));
  check('Token is unguessable (>=32 chars)', send.unsubscribeToken.length >= 32, `${send.unsubscribeToken.length} chars`);

  const ok = await recordUnsubscribe(send.unsubscribeToken);
  const sup = await prisma.suppression.findUnique({ where: { email: send.toEmail } });
  check('Unsubscribe token resolves', ok);
  check('Unsubscribe adds to suppression list', Boolean(sup), sup?.reason);

  // The critical property: a suppressed address must never send again.
  const repeat = await prisma.prospect.findFirst({
    where: { campaignId: campaign.id, email: send.toEmail },
  });
  await prisma.prospect.update({ where: { id: repeat.id }, data: { status: 'approved' } });
  const second = await sendProspect({ campaign, prospect: { ...repeat, status: 'approved' } });
  check('Re-send to unsubscribed address is refused', !second.sent, second.reason);

  console.log('\nDaily cap\n');

  const capProspects = [];
  for (let i = 0; i < 3; i++) {
    const p = await prisma.prospect.create({
      data: {
        campaignId: campaign.id,
        name: `Cap Test ${i}`,
        domain: `cap${i}.test`,
        email: `hello@cap${i}.test`,
        emailSource: 'site_contact_page',
        countryCode: 'US',
        meta: { isRoleAddress: true },
        status: 'approved',
      },
    });
    await prisma.draft.create({
      data: { prospectId: p.id, subject: 's', body: 'b', approvedAt: new Date() },
    });
    capProspects.push(p);
  }

  // Push the day's counter to the cap, then confirm the next send refuses.
  const day = new Date().toISOString().slice(0, 10);
  await prisma.sendQuota.upsert({
    where: { day },
    create: { day, count: Number(process.env.DAILY_SEND_CAP || 50) },
    update: { count: Number(process.env.DAILY_SEND_CAP || 50) },
  });
  const capped = await sendProspect({ campaign, prospect: capProspects[0] });
  check('Send refused once daily cap is reached', !capped.sent, capped.reason);
  check('Cap block is non-terminal (retryable tomorrow)', capped.terminal === false);

  // Cleanup so repeat runs start clean.
  await prisma.campaign.delete({ where: { id: campaign.id } });
  await prisma.product.delete({ where: { id: product.id } });
  await prisma.suppression.deleteMany({ where: { email: { endsWith: '.test' } } });
  await prisma.sendQuota.delete({ where: { day } }).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
