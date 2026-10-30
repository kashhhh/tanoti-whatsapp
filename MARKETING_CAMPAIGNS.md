# Marketing campaigns

Marketing on **Messaging & marketing** now queues a campaign instead of sending
inside the browser request. A worker in the app process collects every page of
the segment, saves recipients, and submits one message at a time. Keep the Node
service running; no additional worker service or cron job is required.

## Deploy on the VPS

After pulling this change, run from the app directory as the deployment user:

```sh
export NODE_OPTIONS="--max-old-space-size=1024"
sudo systemctl stop tanoti-whatsapp
npx prisma migrate deploy &&
npx prisma generate &&
npm run build &&
sudo systemctl start tanoti-whatsapp &&
sudo systemctl status tanoti-whatsapp --no-pager
```

No dependencies were added, so a dependency reinstall is not needed for this
change. The migration creates two new tables without changing existing records.
The deployment user needs write permission to the SQLite database and its parent
directory. If any command fails, leave the service stopped and fix the error
before starting it with an incompatible build/schema.

## Progress and recovery

- The page refreshes progress every three seconds. Closing it does not cancel
  the campaign. Collection completes before sending begins.
- Phone numbers shared by several customers are sent once per campaign. Missing
  phone numbers are skipped. Progress totals therefore may differ from the
  segment's customer count.
- A preview provides a unique submission ID. Repeated confirmation of that
  preview returns the same campaign. Only one campaign per shop can be active.
- Queued recipients survive process restarts. DB leases coordinate app processes.
- An interrupted or timed-out submission becomes **Needs review** rather than
  being automatically resent, since Meta may already have accepted it. Inspect
  Meta delivery records and the saved recipient record before manually sending
  again. Known rejections are also not automatically retried.
- Collection errors pause the campaign. **Resume campaign** continues pagination
  from the saved cursor without requeuing previously recorded recipients.
- **Accepted** is API acceptance, not confirmed delivery. Delivery/read/failure
  updates continue to appear in the existing signed WhatsApp webhook logs.
- A completed campaign can include failed or uncertain sends; completion means
  the queue was processed, not that every customer received a message.

## Existing 250-customer campaign

This change cannot import or identify previous sends automatically. The old
campaign did not save customer IDs or full recipient phones; logs contain only
phone suffixes. Starting a new campaign for the same segment will send again to
previously attempted customers. Prepare a verified segment excluding those
customers before sending the remaining customers. Do not assume that skipping
the first 250 in a fresh query identifies the remainder: segment membership and
ordering can change.

## Local checks

```sh
npx prisma generate
node --test tests/marketing.test.cjs
npm run build
```

The tests use a temporary SQLite database and mock Shopify and WhatsApp; they
never send messages or modify the app database.
