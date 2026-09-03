import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  const settings = await db.settings.findUnique({
    where: { shop },
  });

  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping message.");
    return new Response();
  }
  console.log(`Received ${topic} webhook for ${shop}`);
  console.log("ORDER FULFILLED:");
  console.log({
    orderNumber: payload.name,
    customerName: payload.customer?.first_name,
    phone: payload.customer?.phone,
    trackingNumber: payload.fulfillments?.[0]?.tracking_number,
    trackingUrl: payload.fulfillments?.[0]?.tracking_url,
  });

  return new Response();
};
