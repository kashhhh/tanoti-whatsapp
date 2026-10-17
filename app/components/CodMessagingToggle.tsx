import { useFetcher } from "react-router";
import type { action } from "../routes/app.cod";

export function CodMessagingToggle({ enabled }: { enabled: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const checked = busy ? fetcher.formData?.get("enabled") === "true" : enabled;

  return <s-stack direction="block" gap="base">
    <s-switch
      key={`${enabled}-${fetcher.state}`}
      label="Enable COD WhatsApp messages"
      checked={checked}
      disabled={busy}
      onChange={(event) => fetcher.submit(
        { intent: "toggle", enabled: String(event.currentTarget.checked) },
        { method: "post", action: "/app/cod" },
      )}
      details="Send COD confirmation requests, reminders and order status messages. Turning this off pauses new COD tracking and outgoing COD messages for existing orders."
    />
    <s-paragraph>{busy ? "Saving…" : enabled ? "COD messaging is on." : "COD messaging is off."} Existing order history and customer replies are preserved.</s-paragraph>
    {fetcher.data && <s-paragraph tone={fetcher.data.ok ? "success" : "critical"}>{fetcher.data.message}</s-paragraph>}
  </s-stack>;
}
