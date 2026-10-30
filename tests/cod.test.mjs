/* eslint-env node, es2021 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import ts from "typescript";

const asModule = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
const rulesUrl = asModule(readFileSync(new URL("../app/services/cod-rules.ts", import.meta.url), "utf8"));
const { addBusinessMinutes, isBusinessTime, validMetaSignature } = await import(rulesUrl);
const temp = mkdtempSync(join(tmpdir(), "tanoti-cod-test-"));
const databaseUrl = `file:${join(temp, "test.db").replaceAll("\\", "/")}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
for (const directory of readdirSync("prisma/migrations", { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const migration = readFileSync(`prisma/migrations/${directory.name}/migration.sql`, "utf8");
  for (const statement of migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").split(";").filter((sql) => sql.trim())) {
    await db.$executeRawUnsafe(statement);
  }
}
const shop = "test.myshopify.com";
let states = new Map();
let sends = [];
let sendMode = "accept";
let setupError = false;
globalThis.__codTest = {
  db,
  authenticate: { admin: async () => ({ session: { shop }, redirect: (location) => new Response(null, { status: 302, headers: { Location: location } }) }) },
  unauthenticated: { admin: async () => ({ admin: { graphql: async (query, { variables }) => {
    const state = states.get(variables.id.split("/").pop());
    if (query.includes("query CodOrderState")) return Response.json({ data: { order: state ? { ...state, tags: [...state.tags] } : null } });
    if (query.includes("mutation CodAddTags")) variables.tags.forEach((tag) => state.tags.add(tag));
    else if (query.includes("mutation CodRemoveTags")) variables.tags.forEach((tag) => state.tags.delete(tag));
    else throw new Error("Unexpected mutation: cancellation and fulfillment changes are prohibited in this feature.");
    return Response.json({ data: { mutation: { userErrors: [] } } });
  } } }) },
  prepareCodMessage: async (order, kind) => { if (setupError) throw new Error("Template not approved"); return { orderId: order.orderId, kind }; },
  submitCodMessage: async (phone, template) => {
    sends.push({ phone, ...template });
    if (sendMode === "unknown") throw new Error("timeout");
    return sendMode === "reject" ? { id: null, error: "Rejected" } : { id: `wamid-${sends.length}`, error: null };
  },
};
const source = readFileSync(new URL("../app/services/cod.server.ts", import.meta.url), "utf8")
  .replace('import db from "../db.server";', 'const db = globalThis.__codTest.db;')
  .replace('import { unauthenticated } from "../shopify.server";', 'const { unauthenticated } = globalThis.__codTest;')
  .replace('from "./cod-rules"', `from "${rulesUrl}"`)
  .replace(/import \{ prepareCodMessage[^\n]+/, 'const { prepareCodMessage, submitCodMessage } = globalThis.__codTest;');
const service = await import(asModule(source));
const dashboardSource = readFileSync(new URL("../app/routes/app.cod.tsx", import.meta.url), "utf8").split("export const action")[0]
  .replace('import db from "../db.server";', 'const db = globalThis.__codTest.db;')
  .replace('import { authenticate } from "../shopify.server";', 'const { authenticate } = globalThis.__codTest;');
const { loader: dashboardLoader } = await import(asModule(dashboardSource));
const homeSource = readFileSync(new URL("../app/routes/app._index.tsx", import.meta.url), "utf8")
  .replace('import { authenticate } from "../shopify.server";', 'const { authenticate } = globalThis.__codTest;');
const { loader: homeLoader } = await import(asModule(homeSource));
const oldNumber = process.env.WHATSAPP_PHONE_NUMBER_ID;
process.env.WHATSAPP_PHONE_NUMBER_ID = "business-number";
beforeEach(async () => {
  await db.codOrder.deleteMany();
  await db.settings.upsert({ where: { shop }, update: { codEnabled: true }, create: { shop, codEnabled: true } });
  states = new Map(); sends = []; sendMode = "accept"; setupError = false;
});
after(async () => {
  await db.$disconnect();
  rmSync(temp, { recursive: true, force: true }); // Exact directory created by mkdtemp above.
  delete globalThis.__codTest;
  if (oldNumber === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  else process.env.WHATSAPP_PHONE_NUMBER_ID = oldNumber;
});
async function create(id = "101", gateways = ["Cash on Delivery (COD)"]) {
  states.set(id, { id: `gid://shopify/Order/${id}`, tags: new Set(["VIP"]), cancelledAt: null });
  await service.registerCodOrder(shop, { id, name: `#${id}`, payment_gateway_names: gateways, shipping_address: { phone: "+91 90000 00000", first_name: "Test", address1: "12 Main Road", address2: "Flat 3", city: "Mumbai", province: "Maharashtra", zip: "400001", country: "India" } });
  return db.codOrder.findUnique({ where: { shop_orderId: { shop, orderId: id } } });
}
async function reply(order, action, overrides = {}) {
  const message = await db.codMessage.findUnique({ where: { codId_kind: { codId: order.id, kind: "request" } } });
  return service.receiveCodReply({ id: "incoming", from: "919000000000", context: { id: message.messageId }, button: { payload: `cod:${order.id}:${order.orderId}:${action}` }, ...overrides }, "business-number");
}

test("confirmations stay paused after the COD messaging switch is reenabled", async () => {
  const order = await create();
  assert.equal(sends.length, 1);
  await db.settings.update({ where: { shop }, data: { codEnabled: false } });
  await service.registerCodOrder(shop, { id: "202", payment_gateway_names: ["COD"] });
  assert.equal(await db.codOrder.count(), 1);
  await reply(order, "yes");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "confirmed");
  await service.syncCodOrder(order.id);
  await service.sweepCodOrders();
  assert.equal(sends.length, 1);
  assert.equal(await db.codMessage.findUnique({ where: { codId_kind: { codId: order.id, kind: "confirmed" } } }), null);
  await db.settings.update({ where: { shop }, data: { codEnabled: true } });
  await service.syncCodOrder(order.id);
  await service.syncCodOrder(order.id);
  assert.deepEqual(sends.map((send) => send.kind), ["request"]);
});

test("business calendar carries Saturday evening over Sunday and preserves minutes", () => {
  assert.equal(addBusinessMinutes(new Date("2026-10-17T12:30:00Z"), 180).toISOString(), "2026-10-19T07:00:00.000Z");
  assert.equal(addBusinessMinutes(new Date("2026-10-19T03:00:00Z"), 180).toISOString(), "2026-10-19T07:30:00.000Z");
  assert.equal(isBusinessTime(new Date("2026-10-18T06:00:00Z")), false);
  assert.equal(isBusinessTime(new Date("2026-10-19T13:00:00Z")), false);
});
test("Meta signature rejects modified bodies, malformed signatures and missing secret", () => {
  const raw = '{"messages":[]}';
  const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
  assert.equal(validMetaSignature(raw, signature, "secret"), true);
  assert.equal(validMetaSignature(raw + " ", signature, "secret"), false);
  assert.equal(validMetaSignature(raw, "sha256=bad", "secret"), false);
  assert.equal(validMetaSignature(raw, signature, undefined), false);
});
test("COD intake is gated and prepaid orders are excluded", async () => {
  assert.equal(await create("100", ["shopify_payments"]), null);
  await db.settings.update({ where: { shop }, data: { codEnabled: false } });
  assert.equal(await create(), null);
  assert.equal(sends.length, 0);
});
test("duplicate creation sends once and preserves unrelated Shopify tags", async () => {
  const order = await create();
  await service.registerCodOrder(shop, { id: "101", payment_gateway_names: ["COD"] });
  assert.equal(sends.length, 1);
  assert.equal(order.phone, "919000000000");
  assert.equal(order.address, "12 Main Road, Flat 3, Mumbai, Maharashtra, 400001, India");
  assert.deepEqual([...states.get("101").tags].sort(), ["COD Pending", "VIP"]);
});
test("Shopify cash_on_delivery gateway enters the COD request workflow", async () => {
  const order = await create("101", ["cash_on_delivery"]);
  assert.ok(order);
  assert.equal(order.status, "pending");
  assert.equal(states.get("101").tags.has("COD Pending"), true);
  assert.deepEqual(sends.map((send) => send.kind), ["request"]);
});
test("same-phone orders are isolated; confirmation locks subsequent YES/NO without sending", async () => {
  const first = await create(); const second = await create("102");
  await reply(first, "yes"); await reply(first, "yes"); await reply(first, "no");
  assert.equal((await db.codOrder.findUnique({ where: { id: first.id } })).status, "confirmed");
  assert.equal((await db.codOrder.findUnique({ where: { id: second.id } })).status, "pending");
  assert.equal(sends.filter((send) => send.kind === "confirmed").length, 0);
  assert.equal(states.get("101").tags.has("COD Pending"), false);
});
test("wrong sender, mismatched button, and unthreaded free text cannot update an order", async () => {
  const order = await create();
  await reply(order, "yes", { from: "other-phone" });
  await reply(order, "yes", { button: { payload: `cod:${order.id}:999:yes` } });
  await reply(order, "yes", { context: undefined, button: undefined, text: { body: "YES" } });
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "pending");
  await reply(order, "yes", { button: undefined, text: { body: "YES" } });
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "confirmed");
});
test("NO requests cancellation; only an actual Shopify cancellation closes the order", async () => {
  const order = await create();
  await reply(order, "no");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "cancel_requested");
  assert.equal(sends.filter((send) => send.kind === "cancelled").length, 0);
  states.get("101").cancelledAt = new Date().toISOString();
  await service.syncCodOrder(order.id); await reply(order, "yes");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "cancelled");
  assert.equal(sends.filter((send) => send.kind === "cancelled").length, 1);
  assert.equal(sends.filter((send) => send.kind === "confirmed").length, 0);
});
test("direct Shopify confirmation disables buttons even before its webhook is processed", async () => {
  const order = await create();
  states.get("101").tags.add("COD Confirmed");
  await reply(order, "no");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "confirmed");
  assert.equal(sends.filter((send) => send.kind === "confirmed").length, 0);
});
test("call attempts are ordered and no answer never confirms or cancels", async () => {
  const order = await create();
  await assert.rejects(service.recordCodCall(order.id, shop, 2, "no_answer", "Staff"), /first call/);
  await service.recordCodCall(order.id, shop, 1, "no_answer", "Staff");
  await service.recordCodCall(order.id, shop, 2, "no_answer", "Staff");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "pending");
  assert.equal(await db.codCall.count(), 2);
});
test("call outcomes are limited and never change order status", async () => {
  const order = await create();
  for (const outcome of ["confirmed", "declined", "callback", "invalid"]) {
    await assert.rejects(service.recordCodCall(order.id, shop, 1, outcome, "Staff"), /Invalid call outcome/);
  }
  await service.recordCodCall(order.id, shop, 1, "not_connected", "Staff");
  await service.recordCodCall(order.id, shop, 2, "two_calls", "Staff");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "pending");
  const second = await create("102");
  await service.recordCodCall(second.id, shop, 1, "one_call", "Staff");
  await service.recordCodCall(second.id, shop, 1, "one_call", "Staff");
  assert.equal(await db.codCall.count({ where: { codId: second.id } }), 1);
});

test("notes persist, clear, and enforce shop ownership and size", async () => {
  const order = await create();
  await service.saveCodNotes(order.id, shop, "Call after 5pm\nCheck address");
  await assert.rejects(service.saveCodNotes(order.id, "other.myshopify.com", "Overwrite"), /Order not found/);
  await assert.rejects(service.saveCodNotes(order.id, shop, "x".repeat(5001)), /5,000/);
  await service.syncCodOrder(order.id);
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).notes, "Call after 5pm\nCheck address");
  await service.saveCodNotes(order.id, shop, "");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).notes, "");
});

test("all tags refresh and export preserves risk tags after status changes", async () => {
  const order = await create();
  states.get("101").tags.add("High RTO Risk");
  states.get("101").tags.add("GoKwik");
  await service.syncCodOrder(order.id);
  let stored = await db.codOrder.findUnique({ where: { id: order.id } });
  assert.deepEqual(JSON.parse(stored.tags).sort(), ["COD Pending", "GoKwik", "High RTO Risk", "VIP"]);
  await service.changeCodStatus(order.id, shop, "confirmed", "Staff");
  stored = await db.codOrder.findUnique({ where: { id: order.id } });
  assert.deepEqual(JSON.parse(stored.tags).sort(), ["COD Confirmed", "GoKwik", "High RTO Risk", "VIP"]);
  const data = await dashboardLoader({ request: new Request("https://app.example/app/cod") });
  assert.equal(data.exportOrders[0].tags, stored.tags);
  states.get("101").tags.delete("High RTO Risk");
  await service.syncCodOrder(order.id);
  assert.equal(JSON.parse((await db.codOrder.findUnique({ where: { id: order.id } })).tags).includes("High RTO Risk"), false);
});
test("unknown message acceptance cannot produce automatic duplicate sends", async () => {
  sendMode = "unknown";
  const order = await create();
  await service.registerCodOrder(shop, { id: "101", payment_gateway_names: ["COD"] });
  assert.equal(sends.length, 1);
  assert.equal((await db.codMessage.findFirst({ where: { codId: order.id } })).state, "unknown");
});
test("previously queued confirmations stay paused through replies, sync and sweep", async () => {
  const order = await create(); setupError = true;
  await db.codMessage.create({ data: { codId: order.id, kind: "confirmed", state: "queued", error: "order_confirmation_test must have no buttons." } });
  await reply(order, "yes"); await reply(order, "no");
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "confirmed");
  setupError = false; await service.syncCodOrder(order.id);
  await service.sweepCodOrders();
  assert.equal(sends.filter((send) => send.kind === "confirmed").length, 0);
  assert.equal((await db.codMessage.findUnique({ where: { codId_kind: { codId: order.id, kind: "confirmed" } } })).state, "queued");
});
test("concurrent decisions serialize and tenant mismatch cannot change tags", async () => {
  const order = await create();
  await assert.rejects(service.changeCodStatus(order.id, "other.myshopify.com", "confirmed", "Staff"), /not found/);
  const results = await Promise.allSettled([
    service.changeCodStatus(order.id, shop, "confirmed", "Staff"),
    service.changeCodStatus(order.id, shop, "cancel_requested", "Staff"),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.ok(sends.filter((send) => send.kind === "confirmed").length <= 1);
});

test("reminder sends once during business hours and never automatically cancels", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T04:30:00Z") });
  t.after(() => t.mock.timers.reset());
  const order = await create();
  t.mock.timers.setTime(new Date("2026-10-19T07:29:00Z").getTime());
  await service.sweepCodOrders();
  assert.equal(sends.filter((send) => send.kind === "reminder").length, 0);
  t.mock.timers.setTime(new Date("2026-10-19T07:30:00Z").getTime());
  await service.sweepCodOrders(); await service.sweepCodOrders();
  assert.equal(sends.filter((send) => send.kind === "reminder").length, 1);
  t.mock.timers.setTime(new Date("2026-10-22T07:30:00Z").getTime());
  await service.sweepCodOrders();
  assert.equal((await db.codOrder.findUnique({ where: { id: order.id } })).status, "pending");
});

test("a delayed reminder waits through Sunday; confirmed orders skip reminders", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T04:30:00Z") });
  t.after(() => t.mock.timers.reset());
  const first = await create(); await create("102");
  await reply(first, "yes");
  t.mock.timers.setTime(new Date("2026-10-18T07:30:00Z").getTime());
  await service.sweepCodOrders();
  assert.equal(sends.filter((send) => send.kind === "reminder").length, 0);
  t.mock.timers.setTime(new Date("2026-10-19T04:30:00Z").getTime());
  await service.sweepCodOrders();
  assert.deepEqual(sends.filter((send) => send.kind === "reminder").map((send) => send.orderId), ["102"]);
});

test("app opens COD orders and preserves the embedded Shopify query parameters", async () => {
  const response = await homeLoader({ request: new Request("https://example.com/app?shop=test.myshopify.com&host=encoded-host&embedded=1") });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/app/cod?shop=test.myshopify.com&host=encoded-host&embedded=1");
});

test("dashboard counts, call queue and search remain scoped to the current shop", async () => {
  const first = await create("101"); const second = await create("102");
  const confirmed = await create("103"); const cancelled = await create("104");
  await service.recordCodCall(first.id, shop, 1, "no_answer", "Staff");
  await db.codOrder.update({ where: { id: second.id }, data: { reminderAt: new Date(Date.now() - 60_000) } });
  await reply(confirmed, "yes"); await reply(cancelled, "no");
  await db.codOrder.create({ data: { ...first, id: undefined, shop: "other.myshopify.com", orderId: "outside" } });
  const load = (query = "") => dashboardLoader({ request: new Request(`https://example.com/app/cod${query}`) });
  const all = await load();
  assert.equal(all.total, 4);
  assert.equal(all.summary.pending, 2);
  assert.equal(all.summary.confirmed, 1);
  assert.equal(all.summary.cancel_requested, 1);
  assert.equal(all.callsDue, 2);
  const calls = await load("?task=calls&q=102");
  assert.deepEqual(calls.orders.map((order) => order.orderId), ["102"]);
  assert.equal(calls.summary.pending, 2);
  assert.equal((await load("?status=confirmed")).total, 1);
  assert.equal((await load("?status=cancel_requested&task=calls")).total, 0);
  assert.equal((await load("?status=__proto__")).total, 4);
});
