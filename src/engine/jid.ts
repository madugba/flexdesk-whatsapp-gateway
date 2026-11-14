const PHONE = /^[1-9]\d{7,14}$/;
const PN_SERVER = '@s.whatsapp.net';
const LID_SERVER = '@lid';

export type Recipient = { jid: string; phone: string | null };

export function isPhoneNumber(value: string): boolean {
  return PHONE.test(value);
}

export function phoneToJid(phone: string): string {
  return `${phone}${PN_SERVER}`;
}

/** The phone number digits of a phone-number JID (ignoring the device suffix), else null. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid?.endsWith(PN_SERVER)) return null;
  const user = jid.slice(0, -PN_SERVER.length).split(':')[0] ?? '';
  return PHONE.test(user) ? user : null;
}

export function isUserJid(jid: string): boolean {
  return jid.endsWith(PN_SERVER) || jid.endsWith(LID_SERVER);
}

/**
 * Accepts a phone number in international digits ("2348012345678") or a user JID taken
 * from a webhook. Groups, broadcasts and anything else are rejected.
 */
export function parseRecipient(input: string): Recipient | null {
  const value = input.trim();
  if (PHONE.test(value)) return { jid: phoneToJid(value), phone: value };
  if (value.includes(':') || !isUserJid(value)) return null;
  const user = value.slice(0, value.indexOf('@'));
  if (!/^\d{5,30}$/.test(user)) return null;
  return { jid: value, phone: phoneFromJid(value) };
}
