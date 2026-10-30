import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { changeCodStatus, recordCodCall, saveCodNotes, syncCodOrder } from "../services/cod.server";
import { messageKinds, prepareCodMessage } from "../services/cod-messages.server";
import { CodMessagingToggle } from "../components/CodMessagingToggle";
import styles from "../styles/cod.module.css";

const labels: Record<string, string> = { pending: "COD Pending", confirmed: "COD Confirmed", cancel_requested: "COD Cancel Requested", cancelled: "COD Cancelled" };
const outcomes: Record<string, string> = { no_answer: "No answer", not_connected: "Not connected", one_call: "1 call", two_calls: "2 calls" };
const legacyOutcomes: Record<string, string> = { confirmed: "Confirmed", declined: "Declined", callback: "Call back later" };
function orderTags(raw: string): string[] {
  try { const tags: unknown = JSON.parse(raw); return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : []; }
  catch { return []; }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = (url.searchParams.get("q") || "").slice(0, 100);
  const task = url.searchParams.get("task") === "calls" ? "calls" : "";
  const now = new Date();
  const callsWhere = {
    shop: session.shop, status: "pending",
    OR: [
      { reminderAt: { lte: now }, calls: { none: {} } },
      { AND: [{ calls: { some: { attempt: 1 } } }, { calls: { none: { attempt: 2 } } }] },
    ],
  };
  const parsedPage = Number(url.searchParams.get("page") || 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 10000) : 1;
  const where = {
    shop: session.shop, ...(Object.hasOwn(labels, status) ? { status } : {}),
    AND: [
      ...(task ? [callsWhere] : []),
      ...(search ? [{ OR: [{ orderNumber: { contains: search } }, { customerName: { contains: search } }, { phone: { contains: search } }] }] : []),
    ],
  };
  const [orders, total, settings, counts, callsDue, exportOrders] = await Promise.all([
    db.codOrder.findMany({ where, orderBy: { createdAt: "desc" }, take: 25, skip: (page - 1) * 25,
      include: { calls: { orderBy: { attempt: "asc" } }, messages: true, events: { orderBy: { createdAt: "desc" }, take: 10 } } }),
    db.codOrder.count({ where }), db.settings.findUnique({ where: { shop: session.shop } }),
    db.codOrder.groupBy({ by: ["status"], where: { shop: session.shop }, _count: { _all: true } }),
    db.codOrder.count({ where: callsWhere }),
    db.codOrder.findMany({
      where: { shop: session.shop },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      select: { orderNumber: true, status: true, tags: true },
    }),
  ]);
  const summary = Object.fromEntries(counts.map((count) => [count.status, count._count._all]));
  return { orders, total, page, search, status, task, summary, callsDue, exportOrders, enabled: settings?.codEnabled ?? false, shop: session.shop, now: now.getTime() };
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
    } else if (intent === "notes") {
      await saveCodNotes(id, session.shop, String(form.get("notes") || ""));
      return { ok: true, message: "Notes saved." };
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

function OrderNotes({ order }: { order: Row }) {
  const fetcher = useFetcher<typeof action>();
  const [notes, setNotes] = useState(order.notes);
  const busy = fetcher.state !== "idle";
  return <fetcher.Form method="post" className={styles.callForm}>
    <input type="hidden" name="id" value={order.id} /><input type="hidden" name="intent" value="notes" />
    <label className={styles.fieldLabel}>Notes
      <textarea className={styles.notes} name="notes" rows={3} maxLength={5000} value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} placeholder="Add specific details..." />
    </label>
    <button className={styles.secondaryButton} type="submit" disabled={busy || notes === order.notes}>{busy ? "Saving..." : "Save notes"}</button>
    <div aria-live="polite">{fetcher.data && <span className={fetcher.data.ok ? styles.successText : styles.errorLabel}>{fetcher.data.message}</span>}</div>
  </fetcher.Form>;
}

function OrderRow({ order, shop, now }: { order: Row; shop: string; now: number }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const terminal = ["confirmed", "cancelled"].includes(order.status);
  const reminder = order.messages.find((message) => message.kind === "reminder");
  const callDue = order.status === "pending" && new Date(order.reminderAt).getTime() <= now;
  const shopifyUrl = `https://${shop}/admin/orders/${order.orderId}`;
  const nextStep = order.status === "confirmed" ? "Ready for your team" : order.status === "cancelled" ? "Order closed" :
    order.status === "cancel_requested" ? "Cancel manually in Shopify" : order.calls.length >= 2 ? "Review after both calls" :
      order.calls.length === 1 ? "Arrange the second call" : callDue ? "First call due" : "Waiting for customer";
  const badgeLabels: Record<string, string> = { pending: "Pending", confirmed: "Confirmed", cancel_requested: "Cancel requested", cancelled: "Cancelled" };
  const messageLabels: Record<string, string> = { request: "Request", reminder: "Reminder", confirmed: "Confirmation", cancelled: "Cancellation" };
  const stateLabels: Record<string, string> = { accepted: "Accepted by WhatsApp", queued: "Waiting to send", sending: "Sending", rejected: "Not accepted", unknown: "Check acceptance", superseded: "No longer needed" };
  const request = order.messages.find((message) => message.kind === "request");
  const hasError = order.messages.some((message) => message.kind !== "confirmed" && Boolean(message.error));
  const setStatus = (status: "confirmed" | "cancel_requested") => fetcher.submit({ id: order.id, intent: "status", status }, { method: "post" });

  return <tr className={styles.orderRow}>
    <td>
      <a className={styles.orderLink} href={shopifyUrl} target="_blank" rel="noreferrer">{order.orderNumber}<span aria-hidden="true"> ↗</span></a>
      <div className={styles.customerName}>{order.customerName}</div>
      {order.phone ? <a className={styles.phone} href={`tel:+${order.phone}`}>+{order.phone}</a> : <span className={styles.muted}>No phone number</span>}
      <div className={styles.timestamp}>{formatDate(order.createdAt)}</div>
      <div className={styles.tags} aria-label="Order tags">{orderTags(order.tags).map((tag) => <span key={tag} className={styles.orderTag}>{tag}</span>)}</div>
      <OrderNotes key={order.notes} order={order} />
      <details className={styles.details}><summary>Order details</summary><p>{order.products || "No items recorded"}</p><p>{order.address || "No address recorded"}</p></details>
    </td>
    <td>
      <span className={`${styles.badge} ${styles[order.status]}`} title={labels[order.status]}>{badgeLabels[order.status]}</span>
      <p className={styles.nextStep}>{nextStep}</p>
      {order.method && <p className={styles.muted}>{order.method.startsWith("WhatsApp") ? "Via WhatsApp" : order.method.startsWith("Phone") ? "By phone" : "Updated by the team"}</p>}
      {order.status === "confirmed" && <p className={styles.muted}>YES / NO replies locked</p>}
    </td>
    <td>
      <div className={styles.callProgress} aria-label={`${order.calls.length} of 2 calls recorded`}>
        {[1, 2].map((attempt) => <span key={attempt} className={order.calls.some((call) => call.attempt === attempt) ? styles.callDone : styles.callOpen}>{attempt}</span>)}
        <span className={styles.muted}>{order.calls.length} of 2 recorded</span>
      </div>
      {order.calls.map((call) => <div className={styles.callResult} key={call.id}><strong>Call {call.attempt} · {outcomes[call.outcome] || legacyOutcomes[call.outcome] || call.outcome}</strong><span className={styles.timestamp}>{formatDate(call.createdAt)}</span></div>)}
      {!terminal && order.status === "pending" && order.calls.length < 2 && <fetcher.Form method="post" className={styles.callForm}>
        <input type="hidden" name="id" value={order.id} /><input type="hidden" name="intent" value="call" />
        <input type="hidden" name="attempt" value={order.calls.length + 1} />
        <label className={styles.fieldLabel}>Call {order.calls.length + 1} outcome
          <select key={order.calls.length} className={styles.select} name="outcome" defaultValue="" required disabled={busy}>
            <option value="" disabled>Select outcome…</option>{Object.entries(outcomes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <button className={styles.secondaryButton} type="submit" disabled={busy}>Save call result</button>
      </fetcher.Form>}
      {!order.calls.length && terminal && <p className={styles.muted}>No calls needed</p>}
    </td>
    <td>
      <div className={styles.messageLine}><span className={`${styles.dot} ${request?.state === "accepted" ? styles.dotSuccess : styles.dotNeutral}`} />{request ? stateLabels[request.state] || request.state : "No request recorded"}</div>
      {reminder && <p className={styles.muted}>Reminder · {stateLabels[reminder.state] || reminder.state}</p>}
      {order.status === "pending" && !reminder && <p className={styles.muted}>Reminder due {formatDate(order.reminderAt)}</p>}
      {hasError && <span className={styles.errorLabel}>Message needs attention</span>}
      <details className={styles.details}>
        <summary>Messages & history</summary>
        {order.messages.map((message) => <p key={message.id}>{messageLabels[message.kind]}: {message.kind === "confirmed" && message.state === "queued" ? "Paused" : stateLabels[message.state] || message.state}{message.error && message.kind !== "confirmed" ? ` — ${message.error}` : ""}</p>)}
        {order.events.length ? <ol className={styles.history}>{order.events.map((event) => <li key={event.id}><span className={styles.timestamp}>{formatDate(event.createdAt)}</span>{event.detail}</li>)}</ol> : <p>No status changes yet.</p>}
      </details>
    </td>
    <td>
      <div className={styles.rowActions}>
        {!terminal && <button className={styles.primaryButton} disabled={busy} onClick={() => setStatus("confirmed")}>Confirm order</button>}
        {!terminal && order.status !== "cancel_requested" && <button className={styles.cancelButton} disabled={busy} onClick={() => setStatus("cancel_requested")}>Request cancellation</button>}
        {order.status === "cancel_requested" && <a className={styles.cancelLink} href={shopifyUrl} target="_blank" rel="noreferrer">Cancel in Shopify ↗</a>}
        <button className={styles.textButton} disabled={busy} onClick={() => fetcher.submit({ id: order.id, intent: "sync" }, { method: "post" })}>{busy ? "Updating…" : "Sync with Shopify"}</button>
      </div>
      <div aria-live="polite">{fetcher.data && <p className={fetcher.data.ok ? styles.successText : styles.errorLabel}>{fetcher.data.ok ? "Order updated." : fetcher.data.message}</p>}</div>
    </td>
  </tr>;
}

export default function CodOrders() {
  const { orders, total, page, search, status, task, summary, callsDue, exportOrders, enabled, shop, now } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [copying, setCopying] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [manualExport, setManualExport] = useState("");
  const exportToClipboard = async () => {
    // Tabs and newlines paste directly into Google Sheets columns.
    const cell = (value: string) => {
      const cleaned = value.replace(/[\t\r\n]/g, " ");
      return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
    };
    const text = ["Order ID\tStatus\tTags", ...exportOrders.map((order) =>
      `${cell(order.orderNumber)}\t${cell(labels[order.status] || order.status)}\t${cell(orderTags(order.tags).join(" | "))}`,
    )].join("\n");
    setCopying(true);
    setManualExport("");
    try {
      await navigator.clipboard.writeText(text);
      setExportMessage(`Copied ${exportOrders.length} orders, newest first. Paste into Google Sheets.`);
    } catch {
      setManualExport(text);
      setExportMessage("Clipboard access was blocked. Copy the selected text below and paste into Google Sheets.");
    } finally {
      setCopying(false);
    }
  };
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate(); }, 30_000);
    return () => clearInterval(timer);
  }, [revalidator]);
  const pageUrl = (next: number) => `?${new URLSearchParams({ q: search, status, task, page: String(next) })}`;
  const views = [{ label: "All orders", status: "", task: "" }, { label: "Pending", status: "pending", task: "" },
    { label: "Calls to make", status: "", task: "calls" }, { label: "Cancel requests", status: "cancel_requested", task: "" },
    { label: "Confirmed", status: "confirmed", task: "" }, { label: "Cancelled", status: "cancelled", task: "" }];
  const filtered = Boolean(search || status || task);
  return <s-page heading="COD orders" inlineSize="large">
    <div className={styles.dashboard}>
      <div className={styles.metrics}>
        <Link to="?status=pending" className={`${styles.metric} ${styles.metricAmber}`}><span>Awaiting confirmation</span><strong>{summary.pending || 0}</strong><small>Review pending orders <span aria-hidden="true">↗</span></small></Link>
        <Link to="?task=calls" className={styles.metric}><span>Calls to make</span><strong>{callsDue}</strong><small>First calls due & second calls <span aria-hidden="true">↗</span></small></Link>
        <Link to="?status=confirmed" className={`${styles.metric} ${styles.metricGreen}`}><span>Confirmed orders</span><strong>{summary.confirmed || 0}</strong><small>Customer confirmations <span aria-hidden="true">↗</span></small></Link>
        <Link to="?status=cancel_requested" className={styles.metric}><span>Cancellation requests</span><strong>{summary.cancel_requested || 0}</strong><small>Needs a manual review <span aria-hidden="true">↗</span></small></Link>
      </div>

      <div className={styles.workInfo}><span>◷ Mon–Sat · 10:00–18:30 IST</span><span>One reminder after 3 business hours</span><span>Cancel orders manually in Shopify</span></div>

      <section className={styles.orderPanel} aria-label="COD order queue">
        <nav className={styles.tabs} aria-label="Order views">{views.map((view) => <Link key={view.label} to={`?${new URLSearchParams({ status: view.status, task: view.task, q: search })}`} className={`${styles.tab} ${status === view.status && task === view.task ? styles.activeTab : ""}`} aria-current={status === view.status && task === view.task ? "page" : undefined}>{view.label}</Link>)}</nav>
        <Form method="get" className={styles.filters}>
          <input type="hidden" name="status" value={status} /><input type="hidden" name="task" value={task} />
          <label className={styles.searchLabel}><span className={styles.srOnly}>Search by order, customer or phone</span><input className={styles.search} key={search} name="q" defaultValue={search} placeholder="Search order, customer or phone…" /></label>
          <button className={styles.secondaryButton} type="submit">Search</button>
          <button className={styles.secondaryButton} type="button" disabled={copying || !exportOrders.length} onClick={exportToClipboard} title="Copy the latest 100 COD orders across all views, newest first">{copying ? "Copying..." : "Export"}</button>
          {filtered && <Link className={styles.clearLink} to="/app/cod">Clear filters</Link>}
          <span className={styles.resultCount} aria-live="polite">{total} {total === 1 ? "order" : "orders"}</span>
        </Form>
        {exportMessage && <div className={styles.exportFeedback}>
          <p role="status">{exportMessage}</p>
          {manualExport && <textarea aria-label="Orders to copy" className={styles.search} value={manualExport} readOnly rows={5} ref={(element) => element?.select()} onFocus={(event) => event.currentTarget.select()} />}
        </div>}
        {!orders.length ? <div className={styles.emptyState}><div className={styles.emptyIcon} aria-hidden="true">☷</div><h2>{filtered ? "No orders match this view" : "Your COD queue starts here"}</h2><p>{filtered ? "Try another search or switch to all orders." : enabled ? "New COD orders will appear here automatically." : "Enable COD WhatsApp messages below to start tracking new orders."}</p>{filtered && <Link className={styles.clearLink} to="/app/cod">View all orders</Link>}</div> :
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus allows horizontal scrolling of the order table.
          <div className={styles.tableScroll} role="region" aria-label="COD orders" tabIndex={0}><table className={styles.table}><caption className={styles.srOnly}>COD orders with customer details, status, call tracking, messages, and actions</caption>
            <thead><tr><th scope="col">Order & customer</th><th scope="col">Status & next step</th><th scope="col">Call tracking</th><th scope="col">WhatsApp</th><th scope="col">Actions</th></tr></thead>
            <tbody>{orders.map((order) => <OrderRow key={order.id} order={order} shop={shop} now={now} />)}</tbody>
          </table></div>}
        <footer className={styles.tableFooter}><span>{total ? `Showing ${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total}` : "0 orders"} · Updates every 30 seconds</span><nav aria-label="Order pages" className={styles.pagination}>{page > 1 && <Link to={pageUrl(page - 1)}>← Previous</Link>}<span>Page {page}</span>{page * 25 < total && <Link to={pageUrl(page + 1)}>Next →</Link>}</nav></footer>
      </section>

      <details className={styles.messagingSettings}><summary>COD messaging settings <span>Manage automatic requests and reminders</span></summary><div className={styles.settingsContent}><CodMessagingToggle enabled={enabled} /><p className={styles.muted}>COD follow-up confirmation messages are paused. Prepaid order notifications are managed in <Link to="/app/settings">Messaging & marketing</Link>.</p></div></details>
    </div>
  </s-page>;
}
