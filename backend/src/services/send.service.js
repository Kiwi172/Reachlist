import crypto from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { prisma } from '../lib/prisma.js';
import { canSend, consumeDailyQuota, checkHealthAndMaybePause, suppress } from '../lib/compliance.js';

const PROVIDER = process.env.SEND_PROVIDER || 'console';
const FROM = process.env.SEND_FROM;
const FROM_NAME = process.env.SEND_FROM_NAME || '';
const REPLY_TO = process.env.SEND_REPLY_TO || '';
const POSTAL = process.env.SENDER_POSTAL_ADDRESS || '';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'http://localhost:4001';

let sesClient;
let smtpTransport;

function fromHeader() {
  return FROM_NAME ? `${FROM_NAME} <${FROM}>` : FROM;
}

/**
 * Appends the legally required footer.
 *
 * Done here rather than in the AI prompt or the review UI on purpose:
 * CAN-SPAM requires a functioning opt-out and a valid physical postal
 * address in every commercial message, and neither a language model nor a
 * user editing a draft should be able to drop them. There is no code path
 * that sends a body which has not been through this function.
 */
function withFooter(body, unsubscribeToken) {
  const url = `${API_PUBLIC_URL}/unsubscribe/${unsubscribeToken}`;
  const parts = [
    body.trim(),
    '',
    '---',
    `You received this because your business appeared in a public listing matching what we build. Reply STOP or use this link and you will never hear from us again: ${url}`,
  ];
  if (POSTAL) parts.push('', POSTAL);
  return parts.join('\n');
}

async function deliver({ to, subject, text, unsubscribeUrl }) {
  if (PROVIDER === 'ses') {
    sesClient ||= new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const res = await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: fromHeader(),
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: REPLY_TO ? [REPLY_TO] : undefined,
        ConfigurationSetName: process.env.SES_CONFIGURATION_SET || undefined,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
            // RFC 8058. Gmail and Yahoo both require one-click unsubscribe
            // headers from bulk senders; without them, delivery to those
            // providers degrades regardless of content quality.
            Headers: [
              { Name: 'List-Unsubscribe', Value: `<${unsubscribeUrl}>` },
              { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
            ],
          },
        },
      }),
    );
    return res.MessageId;
  }

  if (PROVIDER === 'smtp') {
    smtpTransport ||= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const info = await smtpTransport.sendMail({
      from: fromHeader(),
      to,
      replyTo: REPLY_TO || undefined,
      subject,
      text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    return info.messageId;
  }

  // console — the default. Nothing leaves the machine, so the whole
  // pipeline can be exercised end to end before a domain is ever at risk.
  console.log(`\n──── [dry run] would send ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n─────────────────────────────\n`);
  return `console-${crypto.randomUUID()}`;
}

/**
 * Send one approved draft. Returns { sent: true } or { sent: false, reason }.
 * Never throws for policy reasons — only for genuine infrastructure faults.
 */
export async function sendProspect({ campaign, prospect }) {
  const gate = await canSend({ campaign, prospect });
  if (!gate.ok) {
    if (gate.terminal && gate.status) {
      await prisma.prospect.update({
        where: { id: prospect.id },
        data: { status: gate.status },
      });
    }
    return { sent: false, reason: gate.reason, terminal: gate.terminal };
  }

  const draft = await prisma.draft.findUnique({ where: { prospectId: prospect.id } });
  if (!draft) return { sent: false, reason: 'No draft', terminal: true };
  if (!draft.approvedAt) return { sent: false, reason: 'Draft not approved', terminal: false };

  const subject = draft.editedSubject || draft.subject;
  const rawBody = draft.editedBody || draft.body;
  const unsubscribeToken = crypto.randomBytes(24).toString('base64url');
  const body = withFooter(rawBody, unsubscribeToken);
  const unsubscribeUrl = `${API_PUBLIC_URL}/unsubscribe/${unsubscribeToken}`;

  // Row is written before the network call so a crash mid-send leaves a
  // durable record instead of a silent double-send on the next run.
  const send = await prisma.send.create({
    data: {
      campaignId: campaign.id,
      prospectId: prospect.id,
      toEmail: prospect.email,
      subject,
      body,
      unsubscribeToken,
      status: 'queued',
    },
  });

  try {
    const providerId = await deliver({ to: prospect.email, subject, text: body, unsubscribeUrl });
    await consumeDailyQuota();
    await prisma.$transaction([
      prisma.send.update({
        where: { id: send.id },
        data: { status: 'sent', providerId, sentAt: new Date() },
      }),
      prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'sent' } }),
    ]);
    await checkHealthAndMaybePause(campaign.id);
    return { sent: true, sendId: send.id };
  } catch (err) {
    await prisma.$transaction([
      prisma.send.update({
        where: { id: send.id },
        data: { status: 'failed', errorMessage: String(err.message).slice(0, 500) },
      }),
      prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'failed' } }),
    ]);
    return { sent: false, reason: `Delivery failed: ${err.message}`, terminal: false };
  }
}

/** Called by the unsubscribe route and the bounce/complaint webhook. */
export async function recordUnsubscribe(token) {
  const send = await prisma.send.findUnique({ where: { unsubscribeToken: token } });
  if (!send) return false;
  await suppress(send.toEmail, 'unsubscribe');
  return true;
}

export async function recordBounce(email, type = 'bounce') {
  await suppress(email, type);
  const updated = await prisma.send.updateMany({
    where: { toEmail: email.toLowerCase(), status: 'sent' },
    data: { status: type === 'complaint' ? 'complained' : 'bounced' },
  });
  // A complaint against any campaign is a signal about all of them, but
  // pause only the ones that actually sent to this address.
  const affected = await prisma.send.findMany({
    where: { toEmail: email.toLowerCase() },
    select: { campaignId: true },
    distinct: ['campaignId'],
  });
  for (const { campaignId } of affected) await checkHealthAndMaybePause(campaignId);
  return updated.count;
}
