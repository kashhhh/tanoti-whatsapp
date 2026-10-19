import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { redirect } = await authenticate.admin(request);
  return redirect(`/app/cod${new URL(request.url).search}`);
};

export default function AppHome() {
  return null;
}
