import type { CodOrder } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { COD_TAGS, addBusinessMinutes, isBusinessTime, isCodOrder, normalizePhone, replyAction, type CodStatus } from "./cod-rules";
import { prepareCodMessage, submitCodMessage, type MessageKind } from "./cod-messages.server";

interface ShopifyOrderPayload {
  id: string | number;
  name?: string;
  payment_gateway_names?: string[];
  phone?: string | null;
  customer?: { first_name?: string | null; phone?: string | null } | null;
  shipping_address?: { first_name?: string | null; phone?: string | null; address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; zip?: string | null; country?: string | null } | null;
  line_items?: Array<{ title: string; variant_title?: string | null }>;
}
type IncomingReply = Parameters<typeof replyAction>[0] & {
  id?: string; from?: string; context?: { id?: string };
};
interface GraphqlResult {
  errors?: Array<{ message: string }>;
  data?: {
    order?: { id: string; tags: string[]; cancelledAt: string | null } | null;
    tagsAdd?: { userErrors: Array<{ message: string }> };
    tagsRemove?: { userErrors: Array<{ message: string }> };
  };
}

export const ORDER_QUERY = `#graphql
  query CodOrderState($id: ID!) {
    order(id: $id) { id tags cancelledAt }
  }`;
export const ADD_TAGS = `#graphql
  mutation CodAddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
export const REMOVE_TAGS = `#graphql
  mutation CodRemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

async function graphql(shop: string, query: string, variables: Record<string, unknown>) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(query, { variables });
  const json = await response.json() as GraphqlResult;
  const errors = [...(json.errors ?? []), ...(json.data?.tagsAdd?.userErrors ?? []), ...(json.data?.tagsRemove?.userErrors ?? [])];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  return json.data ?? {};
}

async function withOrder<T>(id: string, fn: (order: CodOrder) => Promise<T>): Promise<T> {
  const lockUntil = new Date(Date.now() + 120_000);
  const lock = await db.codOrder.updateMany({
    where: { id, OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] }, data: { lockUntil },
  });
  if (!lock.count) throw new Error("This order is being updated. Please try again shortly.");
  try { return await fn(await db.codOrder.findUniqueOrThrow({ where: { id } })); }
  finally { await db.codOrder.updateMany({ where: { id, lockUntil }, data: { lockUntil: null } }); }
}

async function record(id: string, detail: string) {
  await db.codEvent.create({ data: { codId: id, detail } });
}

async function setStatus(order: CodOrder, status: CodStatus, method: string) {
  const gid = `gid://shopify/Order/${order.orderId}`;
  const current = await graphql(order.shop, ORDER_QUERY, { id: gid });
  if (!current.order) throw new Error("Order not found.");
  const tags: string[] = current.order.tags;
  if (current.order.cancelledAt) {
    status = "cancelled";
    method = "Cancelled manually in Shopify";
  } else if (status !== "cancelled" && (order.status === "confirmed" || tags.includes(COD_TAGS.confirmed) || tags.includes("COD Confirmed – Phone"))) {
    status = "confirmed";
  }
  // Add the new tag before removing old workflow tags; preserve all unrelated tags.
  if (!tags.includes(COD_TAGS[status])) await graphql(order.shop, ADD_TAGS, { id: gid, tags: [COD_TAGS[status]] });
  const stale = Object.values(COD_TAGS).filter((tag) => tag !== COD_TAGS[status] && tags.includes(tag));
  if (stale.length) await graphql(order.shop, REMOVE_TAGS, { id: gid, tags: stale });
  const updatedTags = JSON.stringify([...new Set([...tags.filter((tag) => !stale.some((staleTag) => staleTag === tag)), COD_TAGS[status]])]);
  await db.codOrder.update({ where: { id: order.id }, data: { tags: updatedTags } });
  if (order.status !== status) {
    await db.codOrder.update({ where: { id: order.id }, data: { status, method } });
    await record(order.id, `${COD_TAGS[status]} — ${method}`);
  }
  order.status = status;
  if (status !== "pending") await db.codMessage.updateMany({
    where: { codId: order.id, kind: { in: ["request", "reminder"] }, state: "queued" }, data: { state: "superseded" },
  });
  return status;
}

async function sendOnce(order: CodOrder, kind: MessageKind) {
  // Pause confirmation notices without reading or changing the existing template.
  // This also prevents previously queued confirmations from being sent on sync/sweep.
  if (kind === "confirmed") return;
  const row = await db.codMessage.upsert({ where: { codId_kind: { codId: order.id, kind } }, create: { codId: order.id, kind }, update: {} });
  if (row.state !== "queued") return;
  const settings = await db.settings.findUnique({ where: { shop: order.shop } });
  if (!settings?.codEnabled) return;
  // Validate before claiming a send. Setup failures remain safely retryable.
  let template;
  try {
    if (!order.phone) throw new Error("No phone number on this order.");
    template = await prepareCodMessage(order, kind);
  } catch (error) {
    await db.codMessage.update({ where: { id: row.id }, data: { error: error instanceof Error ? error.message : "Template setup required" } });
    return;
  }
  // Template preparation calls Meta; recheck in case staff paused during that call.
  if (!(await db.settings.findUnique({ where: { shop: order.shop } }))?.codEnabled) return;
  const claimed = await db.codMessage.updateMany({ where: { id: row.id, state: "queued" }, data: { state: "sending", error: null } });
  if (!claimed.count) return;
  try {
    const result = await submitCodMessage(order.phone, template);
    await db.codMessage.update({ where: { id: row.id }, data: {
      state: result.id ? "accepted" : "rejected", messageId: result.id, error: result.error,
    } });
    if (result.id && kind === "request") {
      await db.codOrder.update({ where: { id: order.id }, data: { reminderAt: addBusinessMinutes(new Date(), 180) } });
    }
  } catch {
    // A timeout may occur after Meta accepted the request: never automatically resend.
    await db.codMessage.update({ where: { id: row.id }, data: { state: "unknown", error: "Acceptance unknown. Inspect Meta before retrying; no automatic resend." } });
  }
}

async function reconcile(order: CodOrder) {
  const data = await graphql(order.shop, ORDER_QUERY, { id: `gid://shopify/Order/${order.orderId}` });
  if (!data.order) throw new Error("Order is no longer accessible in Shopify.");
  const tags: string[] = data.order.tags;
  await db.codOrder.update({ where: { id: order.id }, data: { tags: JSON.stringify(tags) } });
  if (data.order.cancelledAt || order.status === "cancelled") {
    await setStatus(order, "cancelled", "Cancelled manually in Shopify");
    await sendOnce(order, "cancelled");
  } else if (order.status === "confirmed" || tags.includes(COD_TAGS.confirmed) || tags.includes("COD Confirmed – Phone")) {
    await setStatus(order, "confirmed", order.method || "Shopify order tag");
    await sendOnce(order, order.status === "cancelled" ? "cancelled" : "confirmed");
  } else if (tags.includes(COD_TAGS.cancel_requested)) {
    await setStatus(order, "cancel_requested", "Shopify order tag");
  }
  return order;
}

export async function syncCodOrder(id: string) {
  return withOrder(id, reconcile);
}

export async function registerCodOrder(shop: string, payload: ShopifyOrderPayload) {
  if (!isCodOrder(payload.payment_gateway_names ?? [])) return false;
  const orderId = String(payload.id);
  const existing = await db.codOrder.findUnique({ where: { shop_orderId: { shop, orderId } } });
  const settings = await db.settings.findUnique({ where: { shop } });
  if (!existing && !settings?.codEnabled) return false;
  const order = existing ?? await db.codOrder.upsert({
    where: { shop_orderId: { shop, orderId } }, update: {},
    create: {
      shop, orderId, orderNumber: payload.name || `#${orderId}`,
      customerName: payload.customer?.first_name || payload.shipping_address?.first_name || "Customer",
      phone: normalizePhone(payload.phone || payload.shipping_address?.phone || payload.customer?.phone || ""),
      products: (payload.line_items ?? []).map((item) => `${item.title} ${item.variant_title || ""}`).join(" • "),
      address: [payload.shipping_address?.address1, payload.shipping_address?.address2, payload.shipping_address?.city, payload.shipping_address?.province, payload.shipping_address?.zip, payload.shipping_address?.country].filter(Boolean).join(", "),
      reminderAt: addBusinessMinutes(new Date(), 180),
    },
  });
  await withOrder(order.id, async (current) => {
    await reconcile(current);
    if (current.status === "pending") {
      const status = await setStatus(current, "pending", "New COD order");
      await sendOnce(current, status === "confirmed" ? "confirmed" : status === "cancelled" ? "cancelled" : "request");
    }
  });
  return true;
}

export async function changeCodStatus(id: string, shop: string, status: "confirmed" | "cancel_requested", actor: string) {
  return withOrder(id, async (order) => {
    if (order.shop !== shop) throw new Error("Order not found.");
    await reconcile(order);
    if (["confirmed", "cancelled"].includes(order.status)) return;
    await setStatus(order, status, actor);
    if (order.status === "confirmed") await sendOnce(order, "confirmed");
    if (order.status === "cancelled") await sendOnce(order, "cancelled");
  });
}

export async function recordCodCall(id: string, shop: string, attempt: number, outcome: string, actor: string) {
  if (![1, 2].includes(attempt) || !["no_answer", "not_connected", "one_call", "two_calls"].includes(outcome)) throw new Error("Invalid call outcome.");
  return withOrder(id, async (order) => {
    if (order.shop !== shop) throw new Error("Order not found.");
    await reconcile(order);
    if (["confirmed", "cancelled"].includes(order.status)) return;
    if (attempt === 2 && !await db.codCall.findUnique({ where: { codId_attempt: { codId: id, attempt: 1 } } })) throw new Error("Record the first call before the second.");
    const existing = await db.codCall.findUnique({ where: { codId_attempt: { codId: id, attempt } } });
    if (existing && existing.outcome !== outcome) throw new Error("This call is already recorded. Use the order status action for a later decision.");
    if (!existing) {
      await db.codCall.create({ data: { codId: id, attempt, outcome, actor } });
      await record(id, `Call ${attempt}: ${outcome} — ${actor}`);
    }
  });
}

export async function receiveCodReply(message: IncomingReply, phoneNumberId: string) {
  if (phoneNumberId !== process.env.WHATSAPP_PHONE_NUMBER_ID) return;
  const reply = replyAction(message);
  if (!reply) return;
  // Every action must reference a message we actually sent for this specific order.
  const sent = message.context?.id ? await db.codMessage.findUnique({ where: { messageId: message.context.id }, include: { order: true } }) : null;
  if (!sent || !["request", "reminder"].includes(sent.kind)) return;
  const order = sent.order;
  if ("codId" in reply && (reply.codId !== order.id || reply.orderId !== order.orderId)) return;
  if (normalizePhone(message.from || "") !== order.phone) return;
  await changeCodStatus(order.id, order.shop, reply.action === "yes" ? "confirmed" : "cancel_requested", `WhatsApp ${message.id}`);
}

export async function sweepCodOrders() {
  const orders = await db.codOrder.findMany({
    // Rotate through all tracked orders to recover missed Shopify update webhooks.
    orderBy: { updatedAt: "asc" }, take: 100,
  });
  let processed = 0;
  for (const order of orders) {
    try {
      await withOrder(order.id, async (current) => {
        await reconcile(current);
        if (current.status !== "pending") return;
        await setStatus(current, "pending", "COD tracking");
        if (current.status !== "pending") {
          await sendOnce(current, current.status === "cancelled" ? "cancelled" : "confirmed");
          return;
        }
        await sendOnce(current, "request");
        const fresh = await db.codOrder.findUniqueOrThrow({ where: { id: current.id } });
        const initial = await db.codMessage.findUnique({ where: { codId_kind: { codId: current.id, kind: "request" } } });
        if (initial?.state === "accepted" && fresh.reminderAt <= new Date() && isBusinessTime(new Date())) await sendOnce(current, "reminder");
      });
      processed++;
    } catch (error) { console.error("COD sweep order failed", order.id, error instanceof Error ? error.message : "Unknown error"); }
  }
  return processed;
}

export async function saveCodNotes(id: string, shop: string, notes: string) {
  if (notes.length > 5000) throw new Error("Notes must be 5,000 characters or fewer.");
  const result = await db.codOrder.updateMany({ where: { id, shop }, data: { notes } });
  if (!result.count) throw new Error("Order not found.");
}
