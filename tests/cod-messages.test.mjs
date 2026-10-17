/* eslint-env node, es2021 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import ts from "typescript";
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
const whatsappUrl = moduleUrl(readFileSync(new URL("../app/services/whatsapp.server.ts", import.meta.url), "utf8"));
const source = readFileSync(new URL("../app/services/cod-messages.server.ts", import.meta.url), "utf8").replace('from "./whatsapp.server"', `from "${whatsappUrl}"`);
const { prepareCodMessage, submitCodMessage } = await import(moduleUrl(source));
const order = { id: "cod123", orderId: "123", customerName: "Test", orderNumber: "#123", products: "Dress", address: "Address" };
const env = { ...process.env };
const originalFetch = globalThis.fetch;
let template;
beforeEach(() => {
  process.env.WHATSAPP_ACCESS_TOKEN = "test";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test";
  template = { name: "cod_request", status: "APPROVED", language: "en", components: [
    { type: "BODY", text: "Hi {{1}}, confirm order {{2}}. Items: {{3}}. Delivery address: {{4}}." },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "YES" }, { type: "QUICK_REPLY", text: "NO" }] },
  ] };
  globalThis.fetch = async () => Response.json({ data: [template] });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
test("COD buttons carry order identity and use approved language", async () => {
  const payload = await prepareCodMessage(order, "request");
  assert.equal(payload.language.code, "en");
  assert.deepEqual(payload.components[0].parameters, ["Test", "#123", "Dress", "Address"].map((text) => ({ type: "text", text })));
  assert.equal(payload.components[1].parameters[0].payload, "cod:cod123:123:yes");
  assert.equal(payload.components[2].parameters[0].payload, "cod:cod123:123:no");
});
test("reversed or missing buttons cannot silently invert the customer choice", async () => {
  template.components[1].buttons.reverse();
  await assert.rejects(prepareCodMessage(order, "request"), /button labels/);
  template.components.pop();
  await assert.rejects(prepareCodMessage(order, "request"), /two quick-reply/);
});
test("confirmation reuses order_confirmation_test with its existing four variables and no buttons", async () => {
  template = { name: "order_confirmation_test", status: "APPROVED", language: "en_US", components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} is confirmed. Items: {{3}}. Address: {{4}}." }] };
  const payload = await prepareCodMessage(order, "confirmed");
  assert.equal(payload.name, "order_confirmation_test");
  assert.deepEqual(payload.components, [{ type: "body", parameters: ["Test", "#123", "Dress", "Address"].map((text) => ({ type: "text", text })) }]);
});
test("wrong variable counts and unapproved templates are rejected", async () => {
  template.components[0].text = "Hi {{1}}, confirm {{2}}?";
  await assert.rejects(prepareCodMessage(order, "request"), /numbered body variables/);
  template.status = "PENDING";
  await assert.rejects(prepareCodMessage(order, "request"), /approved/);
});
test("reminder and cancellation use their submitted names and variable order", async () => {
  template.name = "cod_reminder";
  const reminder = await prepareCodMessage(order, "reminder");
  assert.equal(reminder.name, "cod_reminder");
  assert.deepEqual(reminder.components[0].parameters.map((parameter) => parameter.text), ["Test", "#123", "Dress", "Address"]);
  template = { name: "cod_cancelled", status: "APPROVED", language: "en_US", components: [{ type: "BODY", text: "Hi {{1}}, your Cash on Delivery order {{2}} with Tanoti has been cancelled, and no payment is due." }] };
  const cancellation = await prepareCodMessage(order, "cancelled");
  assert.equal(cancellation.name, "cod_cancelled");
  assert.deepEqual(cancellation.components, [{ type: "body", parameters: [{ type: "text", text: "Test" }, { type: "text", text: "#123" }] }]);
});
test("legacy environment template names and params cannot override the submitted templates", async () => {
  process.env.COD_REQUEST_TEMPLATE = "old_template";
  process.env.COD_REQUEST_PARAMS = "not JSON";
  const payload = await prepareCodMessage(order, "request");
  assert.equal(payload.name, "cod_request");
  assert.equal(payload.components[0].parameters.length, 4);
});
test("send uses the prepared order template and returns its message ID", async () => {
  const payload = await prepareCodMessage(order, "request");
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.to, "919000000000");
    assert.deepEqual(body.template, payload);
    return Response.json({ messages: [{ id: "wamid-test" }] });
  };
  assert.equal((await submitCodMessage("919000000000", payload)).id, "wamid-test");
});
