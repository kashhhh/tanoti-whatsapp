import { createHmac, timingSafeEqual } from "node:crypto";

export const COD_TAGS = {
  pending: "COD Pending",
  confirmed: "COD Confirmed",
  cancel_requested: "COD Cancel Requested",
  cancelled: "COD Cancelled",
} as const;
export type CodStatus = keyof typeof COD_TAGS;
export const normalizePhone = (phone: string) => phone.replace(/\D/g, "");

export function isBusinessTime(date: Date) {
  const local = new Date(date.getTime() + 330 * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return local.getUTCDay() !== 0 && minute >= 600 && minute < 1110;
}

export function isCodOrder(gateways: string[]) {
  const configured = (process.env.COD_GATEWAY_NAMES || "Cash on Delivery (COD),Cash on Delivery,COD")
    .split(",").map((name) => name.trim().toLowerCase());
  return gateways.some((name) => configured.includes(name.trim().toLowerCase()));
}

// Business calendar is Monday–Saturday, 10:00–18:30 Asia/Kolkata (no DST).
export function addBusinessMinutes(start: Date, minutes: number) {
  const local = new Date(start.getTime() + 330 * 60_000);
  let remaining = minutes;
  while (remaining > 0) {
    if (local.getUTCDay() === 0 || local.getUTCHours() * 60 + local.getUTCMinutes() >= 1110) {
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(10, 0, 0, 0);
      continue;
    }
    if (local.getUTCHours() < 10) local.setUTCHours(10, 0, 0, 0);
    const close = new Date(local);
    close.setUTCHours(18, 30, 0, 0);
    const used = Math.min(remaining, (close.getTime() - local.getTime()) / 60_000);
    local.setTime(local.getTime() + used * 60_000);
    remaining -= used;
  }
  return new Date(local.getTime() - 330 * 60_000);
}

export function validMetaSignature(raw: string, signature: string | null, secret: string | undefined) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function replyAction(message: { button?: { payload?: string }; interactive?: { button_reply?: { id?: string } }; text?: { body?: string } }) {
  const payload = message.button?.payload ?? message.interactive?.button_reply?.id;
  if (payload) {
    const match = /^cod:([a-zA-Z0-9]+):(\d+):(yes|no)$/.exec(payload);
    return match ? { codId: match[1], orderId: match[2], action: match[3] as "yes" | "no" } : null;
  }
  const text = message.text?.body?.trim().toUpperCase();
  if (["YES", "CONFIRM", "NO", "CANCEL"].includes(text || "")) {
    return { action: (["YES", "CONFIRM"].includes(text!) ? "yes" : "no") as "yes" | "no" };
  }
  return null;
}
