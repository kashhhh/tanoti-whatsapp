import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { campaignProgress } from "../services/marketing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return Response.json(
    { campaigns: await campaignProgress(session.shop) },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
