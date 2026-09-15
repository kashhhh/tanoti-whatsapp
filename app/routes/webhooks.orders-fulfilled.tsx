import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  orderDeliveredMessage,
  orderPackedMessage,
} from "app/services/whatsapp.server";

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
  const orderData = {
    orderNumber: payload.name,
    customerName: payload.customer?.first_name,
    phone: payload.customer?.default_address?.phone,
    trackingUrl: payload.fulfillments?.[0]?.tracking_url || "",
  };

  if (orderData.phone) {
    await orderPackedMessage(
      orderData.phone,
      orderData.customerName,
      orderData.orderNumber,
      orderData.trackingUrl,
    );

    console.log("WHATSAPP SENT  ORDER PACKED MESSAGE");
  }

  return new Response();
};
