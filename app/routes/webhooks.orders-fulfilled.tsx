import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { orderDeliveredMessage } from "app/services/whatsapp.server";

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
    phone: payload.customer?.phone,
  };

  console.log(orderData, payload);

  if (orderData.phone) {
    // await orderDeliveredMessage(
    //   orderData.phone,
    //   orderData.customerName,
    //   orderData.orderNumber,
    // );

    console.log("WHATSAPP SENT loop");
  }

  return new Response();
};
