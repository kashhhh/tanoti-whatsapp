const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { PrismaClient } = require("@prisma/client");

const template = { name: "sale", language: { code: "en" } };
const member = (id, phone = `919000${String(id).padStart(6, "0")}`) => ({
  node: {
    id: `gid://shopify/CustomerSegmentMember/${id}`,
    defaultPhoneNumber: phone ? { phoneNumber: phone } : null,
  },
});

async function fixture(t, pages, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-test-"));
  const db = new PrismaClient({
    datasourceUrl: `file:${path.join(dir, "test.sqlite").replaceAll("\\", "/")}`,
  });
  const sql = fs.readFileSync(
    "prisma/migrations/20261021140000_add_marketing_campaigns/migration.sql",
    "utf8",
  );
  for (const statement of sql.split(";"))
    if (statement.trim()) await db.$executeRawUnsafe(statement);
  t.after(async () => {
    await db.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const queries = [];
  const exports = {};
  const code = ts.transpileModule(
    fs.readFileSync("app/services/marketing.server.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    exports,
    process: { env: { NODE_ENV: "test" } },
    console,
    require(name) {
      if (name === "../db.server") return { default: db, __esModule: true };
      if (name === "../shopify.server")
        return {
          unauthenticated: {
            admin: async () => ({
              admin: {
                graphql: async (query, { variables }) => {
                  queries.push(variables);
                  if (variables.ids)
                    return {
                      json: async () => ({
                        data: {
                          nodes: variables.ids.map((id) => ({
                            id,
                            defaultAddress: null,
                          })),
                        },
                      }),
                    };
                  const index = variables.after ? Number(variables.after) : 0;
                  const edges = pages[index] ?? [];
                  return {
                    json: async () => ({
                      data: {
                        customerSegmentMembers: {
                          edges,
                          pageInfo: {
                            hasNextPage: index + 1 < pages.length,
                            endCursor: String(index + 1),
                          },
                        },
                      },
                    }),
                  };
                },
              },
            }),
          },
        };
      if (name === "./whatsapp.server")
        return {
          sendWhatsAppTemplate: async (phone) => {
            calls.push(phone);
            return send
              ? send(phone)
              : {
                  success: true,
                  data: { messages: [{ id: `message-${calls.length}` }] },
                };
          },
        };
      return require(name);
    },
  });
  return { db, api: exports, calls, queries };
}

test("331 recipients span two pages and every recipient is attempted once", async (t) => {
  const members = Array.from({ length: 331 }, (_, i) => member(i));
  const { db, api, calls, queries } = await fixture(t, [
    members.slice(0, 250),
    members.slice(250),
  ]);
  const campaign = await api.enqueueMarketing(
    "test.myshopify.com",
    "request-1",
    "segment",
    template,
  );
  const repeated = await api.enqueueMarketing(
    "test.myshopify.com",
    "request-1",
    "segment",
    template,
  );
  assert.equal(repeated.id, campaign.id);
  await assert.rejects(
    api.enqueueMarketing(
      "test.myshopify.com",
      "request-2",
      "segment",
      template,
    ),
  );
  await api.processMarketingTick();
  assert.equal(calls.length, 0, "collect all pages before sending");
  await api.processMarketingTick();
  assert.equal(await db.marketingRecipient.count(), 331);
  assert.equal(queries[1].after, "1");
  for (let i = 0; i < 332; i++) await api.processMarketingTick();
  assert.equal(calls.length, 331);
  assert.equal(new Set(calls).size, 331);
  const job = await db.marketingCampaign.findUnique({
    where: { id: campaign.id },
  });
  assert.equal(job.state, "complete");
  assert.equal(job.activeKey, null);
  assert.equal(
    (await api.campaignProgress("test.myshopify.com"))[0].counts.accepted,
    331,
  );
  assert.equal((await api.campaignProgress("other.myshopify.com")).length, 0);
});

test("shared phones deduplicate and missing phone numbers are skipped", async (t) => {
  const { db, api, calls } = await fixture(t, [
    [member(1, "+91 9000000001"), member(2, "919000000001"), member(3, null)],
  ]);
  await api.enqueueMarketing("test", "dedup", "segment", template);
  await api.processMarketingTick();
  for (let i = 0; i < 3; i++) await api.processMarketingTick();
  assert.equal(calls.length, 1);
  assert.equal(
    await db.marketingRecipient.count({ where: { state: "skipped" } }),
    1,
  );
});

test("restart does not retry an interrupted send, and a held lease blocks a second worker", async (t) => {
  const { db, api, calls } = await fixture(t, [[member(1), member(2)]]);
  const job = await api.enqueueMarketing(
    "test",
    "restart",
    "segment",
    template,
  );
  await api.processMarketingTick();
  const recipient = await db.marketingRecipient.findFirst();
  await db.marketingRecipient.update({
    where: { id: recipient.id },
    data: { state: "sending" },
  });
  await db.marketingCampaign.update({
    where: { id: job.id },
    data: {
      lockToken: "other-worker",
      lockUntil: new Date(Date.now() + 60000),
    },
  });
  await api.processMarketingTick();
  assert.equal(calls.length, 0);
  await db.marketingCampaign.update({
    where: { id: job.id },
    data: { lockUntil: new Date(0) },
  });
  await api.processMarketingTick();
  assert.equal(calls.length, 1);
  assert.equal(
    (await db.marketingRecipient.findUnique({ where: { id: recipient.id } }))
      .state,
    "unknown",
  );
  await api.processMarketingTick();
  assert.equal(calls.length, 1);
});

test("transport errors remain unknown and API rejections are not retried", async (t) => {
  let n = 0;
  const { db, api, calls } = await fixture(
    t,
    [[member(1), member(2)]],
    async () => {
      if (++n === 1) throw new Error("connection lost");
      return { success: false, data: {}, error: "rejected" };
    },
  );
  await api.enqueueMarketing("test", "failed", "segment", template);
  for (let i = 0; i < 5; i++) await api.processMarketingTick();
  assert.equal(calls.length, 2);
  assert.equal(
    await db.marketingRecipient.count({ where: { state: "unknown" } }),
    1,
  );
  assert.equal(
    await db.marketingRecipient.count({ where: { state: "failed" } }),
    1,
  );
});

test("a collection failure pauses and resumes from the committed cursor before sending", async (t) => {
  let unavailable = true;
  const pages = [[member(1)], []];
  Object.defineProperty(pages, 1, {
    get() {
      if (unavailable) throw new Error("Shopify temporarily unavailable");
      return [member(2)];
    },
  });
  const { db, api, calls } = await fixture(t, pages);
  const job = await api.enqueueMarketing("test", "paused", "segment", template);
  await api.processMarketingTick();
  await api.processMarketingTick();
  const paused = await db.marketingCampaign.findUnique({
    where: { id: job.id },
  });
  assert.equal(paused.state, "paused");
  assert.equal(paused.cursor, "1");
  assert.equal(calls.length, 0);
  unavailable = false;
  await db.marketingCampaign.update({
    where: { id: job.id },
    data: { state: "collecting", error: null },
  });
  await api.processMarketingTick();
  assert.equal(await db.marketingRecipient.count(), 2);
  for (let i = 0; i < 3; i++) await api.processMarketingTick();
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls).size, 2);
});
