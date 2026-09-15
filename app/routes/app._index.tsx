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
  checkTemplateExists,
  checkTemplateExists,
  sendWhatsAppTemplateNoParams,
} from "app/services/whatsapp.server";

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

  if (intent === "toggleWhatsapp") {
    const whatsappEnabled = formData.get("whatsappEnabled") === "true";
    await db.settings.upsert({
      where: { shop: session.shop },
      update: { whatsappEnabled },
      create: { shop: session.shop, whatsappEnabled },
    });
    return { intent, whatsappEnabled };
  }

  if (intent === "sendMarketing") {
    const templateName = (formData.get("templateName") as string)?.trim();
    const segmentId = formData.get("segmentId") as string;

    if (!templateName || !segmentId) {
      return {
        intent,
        ok: false,
        message: "Template name and segment are required.",
      };
    }

    const { exists, approved } = await checkTemplateExists(templateName);
    if (!exists) {
      return {
        intent,
        ok: false,
        message: `Template "${templateName}" not found.`,
      };
    }
    if (!approved) {
      return {
        intent,
        ok: false,
        message: `Template "${templateName}" is not approved yet.`,
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

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const edge of members) {
      const phone = edge.node.defaultPhoneNumber?.phoneNumber;
      if (!phone) {
        skipped++;
        continue;
      }
      const result = await sendWhatsAppTemplateNoParams(phone, templateName);
      if (result.success) sent++;
      else failed++;
      await new Promise((r) => setTimeout(r, 300));
    }

    return {
      intent,
      ok: true,
      message: `Sent: ${sent}, Failed: ${failed}, Skipped (no phone): ${skipped}`,
    };
  }

  return { intent: null };
};

export default function Index() {
  const { latestOrder, whatsappEnabled, segments } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const marketingFetcher = useFetcher<typeof action>();

  const currentEnabled =
    fetcher.formData?.get("whatsappEnabled") === "true"
      ? true
      : fetcher.formData?.get("whatsappEnabled") === "false"
        ? false
        : whatsappEnabled;

  return (
    <s-page heading="Tanoti WhatsApp Notifications">
      <s-section heading="WhatsApp Notifications">
        <s-stack direction="inline" gap="base" align="center">
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
          <s-select
            label="Customer segment"
            name="segmentId"
            onChange={(e: any) =>
              marketingFetcher.formData?.set?.("segmentId", e.target.value)
            }
          >
            <option value="">Select a segment</option>
            {segments.map((seg: any) => (
              <option key={seg.id} value={seg.id}>
                {seg.name}
              </option>
            ))}
          </s-select>

          <s-text-field
            label="Template name"
            name="templateName"
            placeholder="e.g. abc-123"
          />

          <s-button
            variant="primary"
            onClick={(e: any) => {
              const form = e.target
                .closest("s-section")
                .querySelectorAll("input, select");
              const data: Record<string, string> = { intent: "sendMarketing" };
              form.forEach((el: any) => {
                if (el.name) data[el.name] = el.value;
              });
              marketingFetcher.submit(data, { method: "POST" });
            }}
            {...(marketingFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Send Marketing Message
          </s-button>

          {marketingFetcher.data?.intent === "sendMarketing" && (
            <s-text>{marketingFetcher.data.message}</s-text>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
