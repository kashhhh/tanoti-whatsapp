import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { sendWhatsAppMessage } from "app/services/whatsapp.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const settings = await db.settings.findUnique({
    where: { id: shop },
  });

  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping message.");
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload;

  const orderData = {
    orderId: order.id,
    orderNumber: order.name,
    customerName: order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
      : "Customer",
    phone: order.phone ?? order.customer?.phone ?? null,
    email: order.email ?? order.customer?.email ?? null,
  };

  console.log("ORDER DATA:");
  console.log(orderData);

  console.log("Phone:", orderData.phone);

  console.log("ABOUT TO SEND WHATSAPP");

  if (orderData.phone) {
    await sendWhatsAppMessage(
      orderData.phone,
      orderData.customerName,
      orderData.orderNumber,
      "5-7 business days",
    );

    console.log("WHATSAPP SENT");
  }

  return new Response();
};
