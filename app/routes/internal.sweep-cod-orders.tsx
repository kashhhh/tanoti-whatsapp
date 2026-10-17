import type { ActionFunctionArgs } from "react-router";
import { sweepCodOrders } from "../services/cod.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!process.env.SWEEP_SECRET || request.headers.get("x-sweep-secret") !== process.env.SWEEP_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json({ processed: await sweepCodOrders() });
};
