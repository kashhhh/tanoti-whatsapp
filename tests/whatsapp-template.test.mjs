/* eslint-env node, es2021 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import ts from "typescript";

// Load the server helper without adding a TypeScript test runtime.
const source = readFileSync(new URL("../app/services/whatsapp.server.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { prepareWhatsAppTemplate, sendWhatsAppTemplate } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const originalFetch = globalThis.fetch;
const envKeys = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_PHONE_NUMBER_ID"];
const originalEnv = envKeys.map((key) => process.env[key]);
const festive = {
  name: "festive_clearance", status: "APPROVED", language: "en", category: "MARKETING",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Festive clearance sale" },
    { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.com/sale" }] },
  ],
};
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
const mockTemplate = (template = festive) => {
  globalThis.fetch = async () => reply({ data: [template] });
};

beforeEach(() => {
  envKeys.forEach((key) => { process.env[key] = "test-only"; });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  envKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
});

test("festive_clearance sends its approved language and required image header", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return options.method === "POST" ? reply({ messages: [{ id: "mock-message" }] }) : reply({ data: [festive] });
  };
  const template = await prepareWhatsAppTemplate("festive_clearance", " https://example.com/sale.png ");
  const result = await sendWhatsAppTemplate("919000000000", template);
  assert.equal(result.success, true);
  assert.match(calls[0].url, /fields=name,status,language,category,components/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    messaging_product: "whatsapp", to: "919000000000", type: "template",
    template: {
      name: "festive_clearance", language: { code: "en" },
      components: [{ type: "header", parameters: [{ type: "image", image: { link: "https://example.com/sale.png" } }] }],
    },
  });
});

test("image templates reject missing and non-HTTP image URLs before sending", async () => {
  mockTemplate();
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance"), /requires a public image URL/);
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance", "file:///sale.png"), /HTTP or HTTPS/);
});

test("simple templates continue to send without components", async () => {
  mockTemplate({ name: "hello_world", status: "APPROVED", language: "en_US", components: [{ type: "BODY", text: "Hello world" }] });
  assert.deepEqual(await prepareWhatsAppTemplate("hello_world"), {
    name: "hello_world", language: { code: "en_US" },
  });
});

test("unknown and unapproved templates cannot be sent", async () => {
  globalThis.fetch = async () => reply({ data: [] });
  await assert.rejects(prepareWhatsAppTemplate("missing"), /not found/);
  mockTemplate({ ...festive, status: "PENDING" });
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance"), /not approved/);
});

test("unsupported variables and media are rejected with useful errors", async () => {
  mockTemplate({ ...festive, components: [{ type: "BODY", text: "Hello {{1}}" }] });
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance"), /requires variable values/);
  mockTemplate({ ...festive, components: [{ type: "HEADER", format: "VIDEO" }] });
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance"), /does not support VIDEO/);
});

test("template lookup errors retain Meta's code and details", async () => {
  globalThis.fetch = async () => reply({ error: { code: 190, message: "Invalid OAuth access token" } }, 401);
  await assert.rejects(prepareWhatsAppTemplate("festive_clearance"), /Meta error 190: Invalid OAuth access token/);
});

test("send failures retain Meta's error details rather than only a failed count", async () => {
  globalThis.fetch = async () => reply({ error: { code: 132001, message: "Template error", error_data: { details: "Template does not exist in the specified language" } } }, 400);
  const result = await sendWhatsAppTemplate("919000000000", { name: "festive_clearance", language: { code: "en" } });
  assert.equal(result.success, false);
  assert.equal(result.error, "Meta error 132001: Template does not exist in the specified language");
});
