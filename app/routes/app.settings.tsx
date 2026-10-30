import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { CodMessagingToggle } from "../components/CodMessagingToggle";
import {
  prepareWhatsAppTemplate,
  type WhatsAppTemplatePayload,
} from "app/services/whatsapp.server";
import { useEffect, useState } from "react";
import { randomUUID } from "node:crypto";
import {
  enqueueMarketing,
  campaignProgress,
  startMarketingWorker,
} from "../services/marketing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  startMarketingWorker();
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query getLatestOrderAndSegments {
      orders(first: 1, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            email
            phone
            customer {
              firstName
              lastName
              phone
            }
          }
        }
      }
      segments(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }`,
  );

  const responseJson = await response.json();
  const latestOrder = responseJson.data?.orders?.edges?.[0]?.node ?? null;

  const segments: Array<{ id: string; name: string }> =
    responseJson.data?.segments?.edges?.map(
      (edge: { node: { id: string; name: string } }) => ({
        id: edge.node.id,
        name: edge.node.name,
      }),
    ) ?? [];

  const settings = await db.settings.upsert({
    where: { shop: session.shop },
    update: {},
    create: {
      shop: session.shop,
      whatsappEnabled: false,
    },
  });

  return {
    campaigns: await campaignProgress(session.shop),
    latestOrder,
    whatsappEnabled: settings.whatsappEnabled,
    codEnabled: settings.codEnabled,
    segments,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "checkSegment") {
    const templateName = (formData.get("templateName") as string)?.trim();
    const segmentId = formData.get("segmentId") as string;
    const imageUrl = String(formData.get("imageUrl") ?? "").trim();

    if (!templateName || !segmentId) {
      return {
        intent: "checkSegment" as const,
        ok: false as const,
        message: "Template name and segment are required.",
      };
    }

    let template: WhatsAppTemplatePayload;
    try {
      template = await prepareWhatsAppTemplate(templateName, imageUrl);
    } catch (error) {
      return {
        intent: "checkSegment" as const,
        ok: false as const,
        message:
          error instanceof Error
            ? error.message
            : "Could not validate the WhatsApp template. Please try again.",
      };
    }

    const { admin } = await authenticate.admin(request);
    const countResponse = await admin.graphql(
      `#graphql
      query getSegmentCount($segmentId: ID) {
        customerSegmentMembers(segmentId: $segmentId, first: 1) {
          totalCount
        }
      }`,
      { variables: { segmentId } },
    );
    const countJson = await countResponse.json();
    const count = countJson.data?.customerSegmentMembers?.totalCount ?? 0;

    return {
      intent: "checkSegment" as const,
      ok: true as const,
      count,
      segmentId,
      templateName,
      imageUrl,
      language: template.language.code,
      requestId: randomUUID(),
    };
  }
  if (intent === "toggleWhatsapp") {
    const whatsappEnabled = formData.get("whatsappEnabled") === "true";
    await db.settings.upsert({
      where: { shop: session.shop },
      update: { whatsappEnabled },
      create: { shop: session.shop, whatsappEnabled },
    });
    return { intent: "toggleWhatsapp" as const, whatsappEnabled };
  }

  if (intent === "sendMarketing") {
    const templateName = (formData.get("templateName") as string)?.trim();
    const segmentId = formData.get("segmentId") as string;
    const imageUrl = String(formData.get("imageUrl") ?? "").trim();

    if (!templateName || !segmentId) {
      return {
        intent: "sendMarketing" as const,
        ok: false,
        message: "Template name and segment are required.",
      };
    }

    let template: WhatsAppTemplatePayload;
    try {
      template = await prepareWhatsAppTemplate(templateName, imageUrl);
    } catch (error) {
      return {
        intent: "sendMarketing" as const,
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Could not validate the WhatsApp template. Please try again.",
      };
    }

    try {
      const campaign = await enqueueMarketing(
        session.shop,
        String(formData.get("requestId") ?? ""),
        segmentId,
        template,
      );
      return {
        intent: "sendMarketing" as const,
        ok: true,
        message: `Campaign ${campaign.id} queued. Sending continues in the background; progress is shown below.`,
      };
    } catch (error) {
      return {
        intent: "sendMarketing" as const,
        ok: false,
        message:
          error instanceof Error ? error.message : "Could not queue campaign.",
      };
    }
  }
  if (intent === "resumeMarketing") {
    const id = String(formData.get("campaignId") ?? "");
    // A paused campaign only occurs during collection; sent/unknown recipients are never requeued.
    await db.marketingCampaign.updateMany({
      where: { id, shop: session.shop, state: "paused", lockToken: null },
      data: { state: "collecting", error: null },
    });
    return { intent: "resumeMarketing" as const };
  }

  return { intent: null };
};

export default function Index() {
  const { latestOrder, whatsappEnabled, codEnabled, segments, campaigns } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const marketingFetcher = useFetcher<typeof action>();
  const progressFetcher = useFetcher<{ campaigns: typeof campaigns }>();
  const progress = progressFetcher.data?.campaigns ?? campaigns;
  useEffect(() => {
    const timer = setInterval(() => {
      if (progressFetcher.state === "idle")
        progressFetcher.load(`/app/marketing-status${window.location.search}`);
    }, 3000);
    return () => clearInterval(timer);
  }, [progressFetcher]);

  const [dismissedPreview, setDismissedPreview] = useState("");
  const pendingSend =
    marketingFetcher.data?.intent === "checkSegment" &&
    marketingFetcher.data.ok &&
    marketingFetcher.data.requestId !== dismissedPreview
      ? marketingFetcher.data
      : null;

  const currentEnabled =
    fetcher.formData?.get("whatsappEnabled") === "true"
      ? true
      : fetcher.formData?.get("whatsappEnabled") === "false"
        ? false
        : whatsappEnabled;

  return (
    <s-page heading="Messaging & marketing">
      <s-section heading="Prepaid & shipping notifications">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text>
            Order notifications are currently{" "}
            <strong>{currentEnabled ? "ON" : "OFF"}</strong>
          </s-text>

          <button
            type="button"
            onClick={() => {
              const formData = new FormData();
              formData.append("intent", "toggleWhatsapp");
              formData.append(
                "whatsappEnabled",
                currentEnabled ? "false" : "true",
              );
              fetcher.submit(formData, { method: "POST" });
            }}
            style={{
              padding: "8px 16px",
              cursor: "pointer",
              borderRadius: "4px",
              border: "1px solid #ccc",
            }}
          >
            {fetcher.state !== "idle"
              ? "Saving..."
              : currentEnabled
                ? "Turn OFF"
                : "Turn ON"}
          </button>
        </s-stack>
      </s-section>

      <s-section heading="Cash on Delivery messages">
        <CodMessagingToggle enabled={codEnabled} />
        <s-link href="/app/cod">View COD orders</s-link>
      </s-section>

      <s-section heading="Latest Order">
        {latestOrder ? (
          <>
            <s-paragraph>Order: {latestOrder.name}</s-paragraph>

            <s-paragraph>
              Customer: {latestOrder.customer?.firstName}{" "}
              {latestOrder.customer?.lastName}
            </s-paragraph>

            <s-paragraph>
              Phone:{" "}
              {latestOrder.phone || latestOrder.customer?.phone || "No phone"}
            </s-paragraph>

            <s-paragraph>Email: {latestOrder.email || "No email"}</s-paragraph>
          </>
        ) : (
          <s-paragraph>No orders found yet in this store.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Campaign progress">
        <s-paragraph>
          Progress refreshes automatically. Accepted means WhatsApp received the
          request; delivery is confirmed separately. Counts are for unique phone
          numbers, with missing phones counted separately.
        </s-paragraph>
        {progress.length === 0 && (
          <s-paragraph>No campaigns queued yet.</s-paragraph>
        )}
        {progress.map((campaign) => (
          <div key={campaign.id}>
            <s-paragraph>
              {campaign.templateName}: {campaign.state}. Recipients collected:{" "}
              {campaign.total}.
            </s-paragraph>
            <s-paragraph>
              Queued: {campaign.counts.queued ?? 0}; Sending:{" "}
              {campaign.counts.sending ?? 0}; Accepted:{" "}
              {campaign.counts.accepted ?? 0}; Failed:{" "}
              {campaign.counts.failed ?? 0}; Skipped:{" "}
              {campaign.counts.skipped ?? 0}; Needs review:{" "}
              {campaign.counts.unknown ?? 0}.
            </s-paragraph>
            {campaign.error && <s-paragraph>{campaign.error}</s-paragraph>}
            {(campaign.counts.unknown ?? 0) > 0 && (
              <s-paragraph>
                Some sends could not be confirmed. Check Meta records before
                sending these again.
              </s-paragraph>
            )}
            {campaign.state === "paused" && (
              <s-button
                onClick={() =>
                  marketingFetcher.submit(
                    { intent: "resumeMarketing", campaignId: campaign.id },
                    { method: "POST" },
                  )
                }
              >
                Resume campaign
              </s-button>
            )}
          </div>
        ))}
      </s-section>

      <s-section heading="WhatsApp Marketing">
        <s-stack direction="block" gap="base">
          <s-select label="Customer segment" name="segmentId">
            <s-option value="">Select a segment</s-option>
            {segments.map((seg) => (
              <s-option key={seg.id} value={seg.id}>
                {seg.name}
              </s-option>
            ))}
          </s-select>

          <s-text-field
            label="Template name"
            name="templateName"
            placeholder="e.g. festive_clearance"
          />

          <s-text-field
            label="Header image URL"
            name="imageUrl"
            placeholder="https://your-store.com/sale-image.jpg"
          />
          <s-text>
            Required for templates with an image header. Use a public link to
            the image itself. The approved template language is selected
            automatically.
          </s-text>

          <s-button
            variant="primary"
            onClick={(e) => {
              setDismissedPreview(pendingSend?.requestId ?? "");
              const section = (e.currentTarget as HTMLElement).closest(
                "s-section",
              );
              if (!section) return;
              const fields = section.querySelectorAll("s-select, s-text-field");
              const data: Record<string, string> = { intent: "checkSegment" };
              fields.forEach((el) => {
                const field = el as HTMLElement & {
                  name: string;
                  value: string;
                };
                if (field.name) data[field.name] = field.value;
              });
              marketingFetcher.submit(data, { method: "POST" });
            }}
            {...(marketingFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Send Marketing Message
          </s-button>

          {marketingFetcher.data?.intent === "sendMarketing" && (
            <s-text tone={marketingFetcher.data.ok ? undefined : "critical"}>
              {marketingFetcher.data.message}
            </s-text>
          )}
          {marketingFetcher.data?.intent === "checkSegment" &&
            !marketingFetcher.data.ok && (
              <s-text tone="critical">{marketingFetcher.data.message}</s-text>
            )}
          {pendingSend && (
            <s-banner tone="warning">
              <s-stack direction="block" gap="small">
                <s-text>
                  This will queue &quot;{pendingSend.templateName}&quot; (
                  {pendingSend.language}) to{" "}
                  <strong>{pendingSend.count}</strong> customers. Shared phone
                  numbers receive one message per campaign. This cannot be
                  undone.
                </s-text>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="primary"
                    tone="critical"
                    onClick={() => {
                      marketingFetcher.submit(
                        {
                          intent: "sendMarketing",
                          requestId: pendingSend.requestId,
                          templateName: pendingSend.templateName,
                          segmentId: pendingSend.segmentId,
                          imageUrl: pendingSend.imageUrl,
                        },
                        { method: "POST" },
                      );
                      setDismissedPreview(pendingSend?.requestId ?? "");
                    }}
                  >
                    Confirm Send
                  </s-button>
                  <s-button
                    onClick={() => setDismissedPreview(pendingSend.requestId)}
                  >
                    Cancel
                  </s-button>
                </s-stack>
              </s-stack>
            </s-banner>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
