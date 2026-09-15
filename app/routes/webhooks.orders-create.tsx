import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { sendWhatsAppMessage } from "app/services/whatsapp.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  if (payload.checkout_token) {
    await db.abandonedCheckout.updateMany({
      where: { checkoutToken: payload.checkout_token },
      data: { converted: true },
    });
  }
  const settings = await db.settings.findUnique({
    where: { shop },
  });

  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping message.");
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload;

  const address = order.shipping_address
    ? [
        order.shipping_address.address1,
        order.shipping_address.address2,
        order.shipping_address.city,
        order.shipping_address.province,
        order.shipping_address.zip,
        order.shipping_address.country,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  const productsList = (order.line_items ?? [])
    .map((item: any) => `${item.title} | ${item.variant_title ?? "-"}`)
    .join(" • ");

  const orderData = {
    orderId: order.id,
    orderNumber: order.name,
    customerName: order.customer
      ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
      : "Customer",
    phone: order.phone ?? order.customer?.phone ?? null,
    email: order.email ?? order.customer?.email ?? null,
    address: address,
    productsList,
  };

  if (orderData.phone) {
    await sendWhatsAppMessage(
      orderData.phone,
      orderData.customerName,
      orderData.orderNumber,
      orderData.productsList,
      orderData.address,
    );

    console.log("WHATSAPP SENT for ORDER CONFIRMATION");
  }

  return new Response();
};
