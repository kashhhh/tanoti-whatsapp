import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { orderDeliveredMessage } from "app/services/whatsapp.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop, admin } = await authenticate.webhook(request);

  const settings = await db.settings.findUnique({
    where: { shop },
  });

  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping message.");
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  if (payload.status !== "delivered") {
    console.log(
      `Fulfillment event status is "${payload.status}", not delivered. Skipping.`,
    );
    return new Response();
  }

  const orderGid = `gid://shopify/Order/${payload.order_id}`;

  const response = await admin.graphql(
    `#graphql
    query getOrder($id: ID!) {
      order(id: $id) {
        name
        customer {
          firstName
        }
        phone
        shippingAddress {
          phone
        }
      }
    }`,
    { variables: { id: orderGid } },
  );

  const { data } = await response.json();
  const order = data?.order;

  if (!order) {
    console.log("Could not fetch order for id:", payload.order_id);
    return new Response();
  }

  const orderData = {
    orderNumber: order.name,
    customerName: order.customer?.firstName,
    phone: order.phone || order.shippingAddress?.phone,
  };

  if (orderData.phone) {
    await orderDeliveredMessage(orderData.phone, orderData.orderNumber);
    console.log("WHATSAPP SENT — ORDER DELIVERED MESSAGE");
  }

  return new Response();
};
