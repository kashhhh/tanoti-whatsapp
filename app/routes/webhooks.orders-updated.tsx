import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncCodOrder } from "../services/cod.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const order = await db.codOrder.findUnique({ where: { shop_orderId: { shop, orderId: String(payload.id) } } });
  if (order) await syncCodOrder(order.id);
  return new Response();
};
