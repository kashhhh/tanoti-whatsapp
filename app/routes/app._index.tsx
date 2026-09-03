import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getLatestOrder {
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
      }`,
  );

  const responseJson = await response.json();
  const latestOrder = responseJson.data?.orders?.edges?.[0]?.node ?? null;

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
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const whatsappEnabled = formData.get("whatsappEnabled") === "true";

  await db.settings.upsert({
    where: { shop: session.shop },
    update: {
      whatsappEnabled,
    },
    create: {
      shop: session.shop,
      whatsappEnabled,
    },
  });

  return { whatsappEnabled };
};

export default function Index() {
  const { latestOrder, whatsappEnabled } = useLoaderData<typeof loader>();
  const settingsFetcher = useFetcher<typeof action>();

  const currentEnabled =
    settingsFetcher.formData?.get("whatsappEnabled") === "true"
      ? true
      : settingsFetcher.formData?.get("whatsappEnabled") === "false"
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

          <s-button
            variant={currentEnabled ? "secondary" : "primary"}
            onClick={() => {
              settingsFetcher.submit(
                {
                  whatsappEnabled: currentEnabled ? "false" : "true",
                },
                { method: "POST" },
              );
            }}
            {...(settingsFetcher.state !== "idle" ? { loading: true } : {})}
          >
            {currentEnabled ? "Turn OFF" : "Turn ON"}
          </s-button>
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
