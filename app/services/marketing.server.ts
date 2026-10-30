import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  sendWhatsAppTemplate,
  type WhatsAppTemplatePayload,
} from "./whatsapp.server";

export const MEMBERS_QUERY = `#graphql
  query marketingMembers($segmentId: ID, $after: String) {
    customerSegmentMembers(segmentId: $segmentId, first: 250, after: $after) {
      edges { node { id defaultPhoneNumber { phoneNumber } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const PHONES_QUERY = `#graphql
  query marketingPhones($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Customer { id defaultAddress { phone } } }
  }`;

export async function enqueueMarketing(
  shop: string,
  requestId: string,
  segmentId: string,
  template: WhatsAppTemplatePayload,
) {
  if (!requestId || requestId.length > 100)
    throw new Error("Please review the campaign again before sending.");
  const existing = await db.marketingCampaign.findUnique({
    where: { shop_requestId: { shop, requestId } },
  });
  if (existing) return existing;
  // One active campaign per shop; repeat submissions return the existing job.
  try {
    return await db.marketingCampaign.create({
      data: {
        shop,
        requestId,
        activeKey: shop,
        segmentId,
        template: JSON.stringify(template),
      },
    });
  } catch (error) {
    const duplicate = await db.marketingCampaign.findUnique({
      where: { shop_requestId: { shop, requestId } },
    });
    if (duplicate) return duplicate;
    throw new Error(
      "A campaign is already active. Wait for it to finish or resume it before starting another.",
      { cause: error },
    );
  }
}

export async function campaignProgress(shop: string) {
  const campaigns = await db.marketingCampaign.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return Promise.all(
    campaigns.map(async (campaign) => {
      const groups = await db.marketingRecipient.groupBy({
        by: ["state"],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      });
      const counts = Object.fromEntries(
        groups.map((group) => [group.state, group._count._all]),
      );
      return {
        id: campaign.id,
        templateName: (JSON.parse(campaign.template) as WhatsAppTemplatePayload)
          .name,
        state: campaign.state,
        error: campaign.error,
        counts,
        total: groups.reduce((sum, group) => sum + group._count._all, 0),
      };
    }),
  );
}

// Each tick claims just one bounded operation. The DB lease also protects multiple app processes.
export async function processMarketingTick() {
  const now = new Date();
  const job = await db.marketingCampaign.findFirst({
    where: {
      state: { in: ["collecting", "sending"] },
      OR: [{ lockUntil: null }, { lockUntil: { lt: now } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;
  const token = randomUUID();
  const claimed = await db.marketingCampaign.updateMany({
    where: {
      id: job.id,
      state: job.state,
      OR: [{ lockUntil: null }, { lockUntil: { lt: now } }],
    },
    data: { lockToken: token, lockUntil: new Date(Date.now() + 120_000) },
  });
  if (!claimed.count) return;
  try {
    // A previous process may have exited after Meta accepted a message but before saving its ID.
    // Never retry these automatically: doing so could send a duplicate.
    await db.marketingRecipient.updateMany({
      where: { campaignId: job.id, state: "sending" },
      data: {
        state: "unknown",
        error: "Send interrupted; check Meta delivery records before retrying.",
      },
    });
    if (job.state === "collecting") {
      const { admin } = await unauthenticated.admin(job.shop);
      const response = await admin.graphql(MEMBERS_QUERY, {
        variables: { segmentId: job.segmentId, after: job.cursor },
      });
      const json = await response.json();
      if (!json.data?.customerSegmentMembers)
        throw new Error("Could not load segment members from Shopify.");
      const page = json.data.customerSegmentMembers;
      if (
        page.pageInfo.hasNextPage &&
        (!page.pageInfo.endCursor || page.pageInfo.endCursor === job.cursor)
      )
        throw new Error("Shopify returned an invalid pagination cursor.");
      type Member = {
        node: {
          id: string;
          defaultPhoneNumber?: { phoneNumber?: string } | null;
        };
      };
      const members: Member[] = page.edges;
      const customerId = (id: string) =>
        `gid://shopify/Customer/${id.split("/").pop()}`;
      const missing = members.filter(
        (edge) => !edge.node.defaultPhoneNumber?.phoneNumber,
      );
      const fallback = new Map<string, string>();
      if (missing.length) {
        const response = await admin.graphql(PHONES_QUERY, {
          variables: { ids: missing.map((edge) => customerId(edge.node.id)) },
        });
        const json = await response.json();
        if (!json.data?.nodes)
          throw new Error("Could not load fallback customer phone numbers.");
        for (const node of json.data.nodes)
          if (node?.defaultAddress?.phone)
            fallback.set(node.id, node.defaultAddress.phone);
      }
      await db.$transaction(
        async (tx) => {
          // If the lease expired during Shopify I/O, this worker must not commit its stale page.
          const owned = await tx.marketingCampaign.updateMany({
            where: {
              id: job.id,
              lockToken: token,
              lockUntil: { gt: new Date() },
            },
            data: {
              cursor: page.pageInfo.endCursor,
              state: page.pageInfo.hasNextPage ? "collecting" : "sending",
            },
          });
          if (!owned.count) return;
          for (const edge of members) {
            const id = customerId(edge.node.id);
            const raw =
              edge.node.defaultPhoneNumber?.phoneNumber || fallback.get(id);
            const phone = raw?.replace(/\D/g, "") || null;
            // Shared phones get a single message within this campaign.
            const phoneKey = phone || `missing:${id}`;
            const existing = await tx.marketingRecipient.findFirst({
              where: {
                campaignId: job.id,
                OR: [{ customerId: id }, { phoneKey }],
              },
            });
            if (!existing)
              await tx.marketingRecipient.create({
                data: {
                  campaignId: job.id,
                  customerId: id,
                  phone,
                  phoneKey,
                  state: phone ? "queued" : "skipped",
                },
              });
          }
        },
        { timeout: 30_000 },
      );
      return;
    }
    const recipient = await db.marketingRecipient.findFirst({
      where: { campaignId: job.id, state: "queued" },
      orderBy: { id: "asc" },
    });
    if (!recipient) {
      await db.marketingCampaign.updateMany({
        where: { id: job.id, lockToken: token },
        data: { state: "complete", activeKey: null },
      });
      return;
    }
    const ready = await db.$transaction(async (tx) => {
      const owned = await tx.marketingCampaign.updateMany({
        where: { id: job.id, lockToken: token, lockUntil: { gt: new Date() } },
        data: { lockUntil: new Date(Date.now() + 120_000) },
      });
      if (!owned.count) return false;
      const result = await tx.marketingRecipient.updateMany({
        where: { id: recipient.id, state: "queued" },
        data: { state: "sending" },
      });
      return result.count === 1;
    });
    if (!ready) return;
    try {
      const result = await sendWhatsAppTemplate(
        recipient.phone!,
        JSON.parse(job.template),
      );
      await db.marketingRecipient.update({
        where: { id: recipient.id },
        data: {
          state: result.success ? "accepted" : "failed",
          messageId: result.data.messages?.[0]?.id ?? null,
          error: result.error ?? null,
        },
      });
    } catch {
      await db.marketingRecipient.update({
        where: { id: recipient.id },
        data: {
          state: "unknown",
          error:
            "Could not confirm acceptance. Not retried to prevent duplicates.",
        },
      });
    }
  } catch (error) {
    console.error("MARKETING WORKER:", error);
    await db.marketingCampaign.updateMany({
      where: { id: job.id, lockToken: token },
      data: {
        state: "paused",
        error:
          error instanceof Error
            ? error.message
            : "Campaign paused. Please resume.",
      },
    });
  } finally {
    await db.marketingCampaign.updateMany({
      where: { id: job.id, lockToken: token },
      data: { lockToken: null, lockUntil: null },
    });
  }
}

const worker = globalThis as typeof globalThis & {
  marketingTimer?: ReturnType<typeof setInterval>;
};
export function startMarketingWorker() {
  if (worker.marketingTimer || process.env.NODE_ENV === "test") return;
  let running = false;
  worker.marketingTimer = setInterval(() => {
    if (running) return;
    running = true;
    void processMarketingTick()
      .catch((error) => console.error("MARKETING WORKER:", error))
      .finally(() => {
        running = false;
      });
  }, 1000);
  worker.marketingTimer.unref();
}
