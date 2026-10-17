/* eslint-env node, es2021 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import ts from "typescript";

let payload;
let tracked;
let registrationCalls;
let conversions;
let logged;
let codEnabled;
let whatsappEnabled;
let sends;
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalLog = console.log;
globalThis.__orderCreateTest = {
  authenticate: { webhook: async () => ({ payload, topic: "ORDERS_CREATE", shop: "test.myshopify.com" }) },
  db: {
    settings: { findUnique: async () => ({ codEnabled, whatsappEnabled }) },
    abandonedCheckout: { updateMany: async (args) => { conversions.push(args); } },
  },
  registerCodOrder: async () => { registrationCalls++; return tracked; },
  sendWhatsAppMessage: async (...args) => { sends.push(args); return { success: true }; },
};
const { outputText: rulesCode } = ts.transpileModule(readFileSync(new URL("../app/services/cod-rules.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const rulesUrl = `data:text/javascript;base64,${Buffer.from(rulesCode).toString("base64")}`;
const source = readFileSync(new URL("../app/routes/webhooks.orders-create.tsx", import.meta.url), "utf8")
  .replace('import { authenticate } from "../shopify.server";', 'const { authenticate } = globalThis.__orderCreateTest;')
  .replace('import db from "../db.server";', 'const { db } = globalThis.__orderCreateTest;')
  .replace('import { registerCodOrder } from "../services/cod.server";', 'const { registerCodOrder } = globalThis.__orderCreateTest;')
  .replace('from "../services/cod-rules"', `from "${rulesUrl}"`)
  .replace('import { sendWhatsAppMessage } from "../services/whatsapp.server";', 'const { sendWhatsAppMessage } = globalThis.__orderCreateTest;');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { action } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
beforeEach(() => {
  payload = { id: 123, payment_gateway_names: ["COD"], phone: "919000000000" };
  tracked = false; codEnabled = true; registrationCalls = 0; conversions = []; logged = [];
  whatsappEnabled = true; sends = [];
  globalThis.fetch = async () => { assert.fail("The paused legacy handler must not send messages"); };
  console.info = (...args) => logged.push(args);
  console.log = () => {};
});
after(() => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.log = originalLog;
  delete globalThis.__orderCreateTest;
});
const invoke = () => action({ request: new Request("https://example.com/webhooks/orders-create", { method: "POST" }) });

test("recognized COD orders run COD tracking without the legacy confirmation", async () => {
  tracked = true;
  assert.equal((await invoke()).status, 200);
  assert.equal(registrationCalls, 1);
  assert.equal(logged.length, 0);
  assert.equal(sends.length, 0);
});
test("unrecognized payment gateways cannot fall back to a confirmed message", async () => {
  payload.payment_gateway_names = ["Custom COD gateway"];
  assert.equal((await invoke()).status, 200);
  const detail = JSON.parse(logged[0][1]);
  assert.deepEqual(detail.paymentGateways, ["Custom COD gateway"]);
  assert.equal(detail.codEnabled, true);
  assert.equal(sends.length, 0);
});
test("disabled COD intake cannot fall back to a confirmed message", async () => {
  codEnabled = false;
  assert.equal((await invoke()).status, 200);
  assert.equal(JSON.parse(logged[0][1]).codEnabled, false);
  assert.equal(sends.length, 0);
});
test("prepaid notifications preserve checkout conversion tracking", async () => {
  payload.payment_gateway_names = ["shopify_payments"];
  payload.checkout_token = "test-checkout";
  await invoke();
  assert.deepEqual(conversions, [{ where: { checkoutToken: "test-checkout" }, data: { converted: true } }]);
});
test("invalid order IDs are rejected before COD tracking", async () => {
  delete payload.id;
  assert.equal((await invoke()).status, 400);
  assert.equal(registrationCalls, 0);
});
test("paid prepaid orders send the existing confirmation with order details", async () => {
  payload.payment_gateway_names = ["shopify_payments"];
  payload.financial_status = "paid";
  payload.name = "#123";
  payload.customer = { first_name: "Test", last_name: "Customer" };
  payload.line_items = [{ title: "Dress", variant_title: "Blue" }];
  payload.shipping_address = { address1: "12 Main Road", address2: "Flat 3", city: "Mumbai", province: "Maharashtra", zip: "400001", country: "India" };
  codEnabled = false;
  assert.equal((await invoke()).status, 200);
  assert.deepEqual(sends, [["919000000000", "Test Customer", "#123", "Dress | Blue", "12 Main Road, Flat 3, Mumbai, Maharashtra, 400001, India"]]);
});
test("prepaid confirmation respects the general WhatsApp notification switch", async () => {
  payload.payment_gateway_names = ["shopify_payments"];
  payload.financial_status = "paid";
  whatsappEnabled = false;
  await invoke();
  assert.equal(sends.length, 0);
});
test("unpaid online orders and COD orders cannot send a prepaid confirmation", async () => {
  payload.payment_gateway_names = ["shopify_payments"];
  payload.financial_status = "pending";
  await invoke();
  payload.payment_gateway_names = ["COD"];
  payload.financial_status = "paid";
  codEnabled = false;
  await invoke();
  assert.equal(sends.length, 0);
});
