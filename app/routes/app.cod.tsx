import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect } from "react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { changeCodStatus, recordCodCall, syncCodOrder } from "../services/cod.server";
import { messageKinds, prepareCodMessage } from "../services/cod-messages.server";
import { CodMessagingToggle } from "../components/CodMessagingToggle";

const labels: Record<string, string> = { pending: "COD Pending", confirmed: "COD Confirmed", cancel_requested: "COD Cancel Requested", cancelled: "COD Cancelled" };
const outcomes: Record<string, string> = { no_answer: "No answer", confirmed: "Confirmed", declined: "Declined", callback: "Call back later" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = (url.searchParams.get("q") || "").slice(0, 100);
  const parsedPage = Number(url.searchParams.get("page") || 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 10000) : 1;
  const where = {
    shop: session.shop, ...(status in labels ? { status } : {}),
    ...(search ? { OR: [{ orderNumber: { contains: search } }, { customerName: { contains: search } }, { phone: { contains: search } }] } : {}),
  };
  const [orders, total, settings] = await Promise.all([
    db.codOrder.findMany({ where, orderBy: { createdAt: "desc" }, take: 25, skip: (page - 1) * 25,
      include: { calls: { orderBy: { attempt: "asc" } }, messages: true, events: { orderBy: { createdAt: "desc" }, take: 10 } } }),
    db.codOrder.count({ where }), db.settings.findUnique({ where: { shop: session.shop } }),
  ]);
  return { orders, total, page, search, status, enabled: settings?.codEnabled ?? false, shop: session.shop, now: Date.now() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const actor = session.onlineAccessInfo?.associated_user?.email || "Staff in app";
  try {
    if (intent === "toggle") {
      const enabled = form.get("enabled") === "true";
      if (enabled) {
        if (!process.env.WHATSAPP_APP_SECRET || !process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.SWEEP_SECRET) throw new Error("Configure the Meta app secret, WhatsApp phone number ID, and sweep secret before enabling COD.");
        if (!session.scope?.split(",").includes("write_orders")) throw new Error("Approve the app's write_orders permission before enabling COD.");
        const sample = { id: "preview", orderId: "123", customerName: "Customer", orderNumber: "#123", products: "Item", address: "Address" };
        for (const kind of messageKinds) await prepareCodMessage(sample as Parameters<typeof prepareCodMessage>[0], kind);
      }
      await db.settings.upsert({ where: { shop: session.shop }, update: { codEnabled: enabled }, create: { shop: session.shop, codEnabled: enabled } });
      return { ok: true, message: enabled ? "COD messaging enabled. New COD orders will be tracked and queued messages can resume." : "COD messaging disabled. New COD tracking and outgoing COD messages are paused. Messages already being sent may still arrive." };
    }
    const id = String(form.get("id") || "");
    const order = await db.codOrder.findFirst({ where: { id, shop: session.shop } });
    if (!order) throw new Error("Order not found.");
    if (intent === "status") {
      const status = String(form.get("status"));
      if (status !== "confirmed" && status !== "cancel_requested") throw new Error("Invalid status.");
      await changeCodStatus(id, session.shop, status, actor);
    } else if (intent === "call") {
      await recordCodCall(id, session.shop, Number(form.get("attempt")), String(form.get("outcome")), actor);
    } else if (intent === "sync") {
      await syncCodOrder(id);
    } else throw new Error("Unknown action.");
    return { ok: true, message: "Order updated. Check its message status below." };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Could not update the order." }; }
};

type Row = Awaited<ReturnType<typeof loader>>["orders"][number];
function formatDate(date: Date | string) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(date));
}

function OrderRow({ order, shop, now }: { order: Row; shop: string; now: number }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const terminal = ["confirmed", "cancelled"].includes(order.status);
  const reminder = order.messages.find((message) => message.kind === "reminder");
  const callDue = order.status === "pending" && new Date(order.reminderAt).getTime() <= now;
  return <s-table-row>
    <s-table-cell>
      <s-link href={`https://${shop}/admin/orders/${order.orderId}`} target="_blank">{order.orderNumber}</s-link>
      <s-paragraph>{formatDate(order.createdAt)}</s-paragraph>
      <s-text>{order.customerName}</s-text><s-paragraph>{order.phone || "No phone"}</s-paragraph>
    </s-table-cell>
    <s-table-cell>
      <s-badge tone={order.status === "confirmed" ? "success" : order.status === "pending" ? "warning" : "neutral"}>{labels[order.status]}</s-badge>
      {order.method && <s-paragraph>{order.method.startsWith("WhatsApp") ? "Confirmed / updated via WhatsApp" : order.method}</s-paragraph>}
      {!terminal && <fetcher.Form method="post">
        <input type="hidden" name="id" value={order.id} /><input type="hidden" name="intent" value="status" />
        <label>Change order tag <select name="status" defaultValue="" required disabled={busy}>
          <option value="" disabled>Select status</option><option value="confirmed">COD Confirmed</option><option value="cancel_requested">COD Cancel Requested</option>
        </select></label>{" "}<button disabled={busy} type="submit">Save tag</button>
      </fetcher.Form>}
      {order.status === "confirmed" && <s-paragraph>YES / NO replies locked</s-paragraph>}
      {order.status === "cancel_requested" && <s-paragraph>Awaiting manual cancellation in Shopify</s-paragraph>}
    </s-table-cell>
    <s-table-cell>
      {order.calls.map((call) => <s-paragraph key={call.id}>Call {call.attempt}: {outcomes[call.outcome]} · {formatDate(call.createdAt)}</s-paragraph>)}
      {!order.calls.length && <s-paragraph>No calls recorded</s-paragraph>}
      {!terminal && order.calls.length < 2 && <fetcher.Form method="post">
        <input type="hidden" name="id" value={order.id} /><input type="hidden" name="intent" value="call" />
        <input type="hidden" name="attempt" value={order.calls.length + 1} />
        <label>Call {order.calls.length + 1} outcome <select name="outcome" defaultValue="" required disabled={busy}>
          <option value="" disabled>Select outcome</option>{Object.entries(outcomes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>{" "}<button type="submit" disabled={busy}>Record call</button>
      </fetcher.Form>}
      {callDue && !order.calls.length && <s-badge tone="warning">First call due</s-badge>}
      {!terminal && order.calls.length === 1 && <s-paragraph>Second call to arrange</s-paragraph>}
      {!terminal && order.calls.length === 2 && <s-paragraph>Both calls recorded — review manually</s-paragraph>}
    </s-table-cell>
    <s-table-cell>
      {order.messages.map((message) => <s-paragraph key={message.id}>{message.kind}: {message.state === "accepted" ? "Accepted by WhatsApp" : message.state}{message.error ? ` — ${message.error}` : ""}</s-paragraph>)}
      {order.status === "pending" && !reminder && <s-paragraph>Reminder due {formatDate(order.reminderAt)}</s-paragraph>}
      <s-button disabled={busy} onClick={() => fetcher.submit({ id: order.id, intent: "sync" }, { method: "post" })}>Sync Shopify status</s-button>
      {fetcher.data && <s-paragraph tone={fetcher.data.ok ? "success" : "critical"}>{fetcher.data.message}</s-paragraph>}
      <details><summary>History</summary>{order.events.map((event) => <p key={event.id}>{formatDate(event.createdAt)} — {event.detail}</p>)}</details>
    </s-table-cell>
  </s-table-row>;
}

export default function CodOrders() {
  const { orders, total, page, search, status, enabled, shop, now } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate(); }, 30_000);
    return () => clearInterval(timer);
  }, [revalidator]);
  const pageUrl = (next: number) => `?${new URLSearchParams({ q: search, status, page: String(next) })}`;
  return <s-page heading="COD orders" inlineSize="large">
    <s-section heading="Confirmation and calling">
      <s-paragraph>Monday–Saturday · 10:00–18:30 India time · One reminder after 3 business hours. Cancellations are manual in Shopify.</s-paragraph>
      <s-stack direction="inline" gap="base">
        <s-button onClick={() => revalidator.revalidate()}>Refresh table</s-button>
      </s-stack>
      <CodMessagingToggle enabled={enabled} />
      <s-paragraph>Tracks new COD orders after enabling. Confirming an order sends a confirmation message and permanently disables its YES / NO actions.</s-paragraph>
    </s-section>
    <s-section heading={`${total} orders`}>
      <Form method="get" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <label>Search <input name="q" defaultValue={search} placeholder="Order, customer or phone" /></label>
        <label>Status <select name="status" defaultValue={status}><option value="">All statuses</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="submit">Filter</button>
      </Form>
      {!orders.length ? <s-paragraph>No matching COD orders yet.</s-paragraph> : <s-table>
        <s-table-header-row><s-table-header>Order / customer</s-table-header><s-table-header>Order tag</s-table-header><s-table-header>Call tracking</s-table-header><s-table-header>Messages / history</s-table-header></s-table-header-row>
        <s-table-body>{orders.map((order) => <OrderRow key={order.id} order={order} shop={shop} now={now} />)}</s-table-body>
      </s-table>}
      <div style={{ display: "flex", gap: 16, marginTop: 16 }}>{page > 1 && <Link to={pageUrl(page - 1)}>Previous</Link>}<span>Page {page}</span>{page * 25 < total && <Link to={pageUrl(page + 1)}>Next</Link>}</div>
    </s-section>
  </s-page>;
}
