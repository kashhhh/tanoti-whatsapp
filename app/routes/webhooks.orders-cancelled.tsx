import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  console.log("ORDER CANCELLED:");
  console.log({
    orderNumber: payload.name,
    customerName: payload.customer?.first_name,
    phone: payload.customer?.phone,
    cancelReason: payload.cancel_reason,
  });

  return new Response();
};
