ALTER TABLE "Settings" ADD COLUMN "codEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "CodOrder" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "orderId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL, "customerName" TEXT NOT NULL, "phone" TEXT NOT NULL,
  "products" TEXT NOT NULL, "address" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "method" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL, "reminderAt" DATETIME NOT NULL, "lockUntil" DATETIME
);
CREATE UNIQUE INDEX "CodOrder_shop_orderId_key" ON "CodOrder"("shop", "orderId");
CREATE INDEX "CodOrder_shop_createdAt_idx" ON "CodOrder"("shop", "createdAt");
CREATE INDEX "CodOrder_status_reminderAt_idx" ON "CodOrder"("status", "reminderAt");
CREATE TABLE "CodCall" (
  "id" TEXT NOT NULL PRIMARY KEY, "codId" TEXT NOT NULL, "attempt" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL, "actor" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodCall_codId_fkey" FOREIGN KEY ("codId") REFERENCES "CodOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CodCall_codId_attempt_key" ON "CodCall"("codId", "attempt");
CREATE TABLE "CodMessage" (
  "id" TEXT NOT NULL PRIMARY KEY, "codId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued', "messageId" TEXT, "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodMessage_codId_fkey" FOREIGN KEY ("codId") REFERENCES "CodOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CodMessage_messageId_key" ON "CodMessage"("messageId");
CREATE UNIQUE INDEX "CodMessage_codId_kind_key" ON "CodMessage"("codId", "kind");
CREATE TABLE "CodEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "codId" TEXT NOT NULL, "detail" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodEvent_codId_fkey" FOREIGN KEY ("codId") REFERENCES "CodOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
