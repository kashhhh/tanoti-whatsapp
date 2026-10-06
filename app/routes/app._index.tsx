import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  prepareWhatsAppTemplate,
  sendWhatsAppTemplate,
  type WhatsAppTemplatePayload,
} from "app/services/whatsapp.server";
import { useEffect, useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
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

  const segments =
    responseJson.data?.segments?.edges?.map((edge: any) => ({
      id: edge.node.id,
      name: edge.node.name,
    })) ?? [];

  const settings = await db.settings.upsert({
    where: { shop: session.shop },
    update: {},
    create: {
      shop: session.shop,
      whatsappEnabled: false,
    },
  });

  return {
    latestOrder,
    whatsappEnabled: settings.whatsappEnabled,
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
        message: error instanceof Error ? error.message : "Could not validate the WhatsApp template. Please try again.",
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

    return { intent: "checkSegment" as const, ok: true as const, count, segmentId, templateName, imageUrl, language: template.language.code };
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
        message: error instanceof Error ? error.message : "Could not validate the WhatsApp template. Please try again.",
      };
    }

    const { admin } = await authenticate.admin(request);

    const membersResponse = await admin.graphql(
      `#graphql
      query getSegmentMembers($segmentId: ID) {
        customerSegmentMembers(segmentId: $segmentId, first: 250) {
          edges {
            node {
              id
              defaultPhoneNumber {
                phoneNumber
              }
            }
          }
        }
      }`,
      { variables: { segmentId } },
    );
    const membersJson = await membersResponse.json();
    const members = membersJson.data?.customerSegmentMembers?.edges ?? [];

    // Fallback: fetch address phone for members missing defaultPhoneNumber
    const needsFallback = members.filter(
      (e: any) => !e.node.defaultPhoneNumber?.phoneNumber,
    );
    const fallbackMap: Record<string, string> = {};

    if (needsFallback.length > 0) {
      const ids = needsFallback.map(
        (e: any) => `gid://shopify/Customer/${e.node.id.split("/").pop()}`,
      );
      const custResponse = await admin.graphql(
        `#graphql
        query getFallbackPhones($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Customer {
              id
              defaultAddress {
                phone
              }
            }
          }
        }`,
        { variables: { ids } },
      );
      const custJson = await custResponse.json();
      for (const node of custJson.data?.nodes ?? []) {
        if (node?.defaultAddress?.phone) {
          fallbackMap[node.id] = node.defaultAddress.phone;
        }
      }
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors = new Set<string>();

    for (const edge of members) {
      const customerId = `gid://shopify/Customer/${edge.node.id.split("/").pop()}`;
      const phone =
        edge.node.defaultPhoneNumber?.phoneNumber ?? fallbackMap[customerId];

      if (!phone) {
        skipped++;
        continue;
      }

      try {
        const result = await sendWhatsAppTemplate(phone, template);
        if (result.success) sent++;
        else {
          failed++;
          errors.add(result.error ?? "WhatsApp request failed.");
        }
      } catch (error) {
        failed++;
        errors.add(error instanceof Error ? error.message : "Could not contact WhatsApp.");
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    return {
      intent: "sendMarketing" as const,
      ok: failed === 0,
      message: `Accepted by WhatsApp: ${sent}, Failed: ${failed}, Skipped (no phone): ${skipped}. ${[...errors].slice(0, 3).join(" ")}${sent > 0 ? " Delivery is confirmed separately by WhatsApp status updates." : ""}`,
    };
  }

  return { intent: null };
};

export default function Index() {
  const { latestOrder, whatsappEnabled, segments } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const marketingFetcher = useFetcher<typeof action>();

  const [pendingSend, setPendingSend] = useState<{
    segmentId: string;
    templateName: string;
    imageUrl: string;
    language: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (
      marketingFetcher.data?.intent === "checkSegment" &&
      marketingFetcher.data.ok
    ) {
      setPendingSend({
        segmentId: marketingFetcher.data.segmentId,
        templateName: marketingFetcher.data.templateName,
        imageUrl: marketingFetcher.data.imageUrl,
        language: marketingFetcher.data.language,
        count: marketingFetcher.data.count,
      });
    }
  }, [marketingFetcher.data]);

  const currentEnabled =
    fetcher.formData?.get("whatsappEnabled") === "true"
      ? true
      : fetcher.formData?.get("whatsappEnabled") === "false"
        ? false
        : whatsappEnabled;

  return (
    <s-page heading="Tanoti WhatsApp Notifications">
      <s-section heading="WhatsApp Notifications">
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

      <s-section heading="WhatsApp Marketing">
        <s-stack direction="block" gap="base">
          <s-select label="Customer segment" name="segmentId">
            <s-option value="">Select a segment</s-option>
            {segments.map((seg: any) => (
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
            Required for templates with an image header. Use a public link to the image itself.
            The approved template language is selected automatically.
          </s-text>

          <s-button
            variant="primary"
            onClick={(e: any) => {
              setPendingSend(null);
              const fields = e.target
                .closest("s-section")
                .querySelectorAll("s-select, s-text-field");
              const data: Record<string, string> = { intent: "checkSegment" };
              fields.forEach((el: any) => {
                if (el.name) data[el.name] = el.value;
              });
              marketingFetcher.submit(data, { method: "POST" });
            }}
            {...(marketingFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Send Marketing Message
          </s-button>

          {marketingFetcher.data?.intent === "sendMarketing" && (
            <s-text tone={marketingFetcher.data.ok ? undefined : "critical"}>{marketingFetcher.data.message}</s-text>
          )}
          {marketingFetcher.data?.intent === "checkSegment" &&
            !marketingFetcher.data.ok && (
              <s-text tone="critical">{marketingFetcher.data.message}</s-text>
            )}
          {pendingSend && (
            <s-banner tone="warning">
              <s-stack direction="block" gap="small">
                <s-text>
                  This will send "{pendingSend.templateName}" ({pendingSend.language}) to{" "}
                  <strong>{pendingSend.count}</strong> customers. This cannot be
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
                          templateName: pendingSend.templateName,
                          segmentId: pendingSend.segmentId,
                          imageUrl: pendingSend.imageUrl,
                        },
                        { method: "POST" },
                      );
                      setPendingSend(null);
                    }}
                  >
                    Confirm Send
                  </s-button>
                  <s-button onClick={() => setPendingSend(null)}>
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
