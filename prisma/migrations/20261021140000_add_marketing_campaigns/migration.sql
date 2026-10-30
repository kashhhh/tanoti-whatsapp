-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "activeKey" TEXT,
    "segmentId" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'collecting',
    "cursor" TEXT,
    "error" TEXT,
    "lockToken" TEXT,
    "lockUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketingRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "phone" TEXT,
    "phoneKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "messageId" TEXT,
    "error" TEXT,
    CONSTRAINT "MarketingRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_activeKey_key" ON "MarketingCampaign"("activeKey");

-- CreateIndex
CREATE INDEX "MarketingCampaign_state_createdAt_idx" ON "MarketingCampaign"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_shop_requestId_key" ON "MarketingCampaign"("shop", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingRecipient_messageId_key" ON "MarketingRecipient"("messageId");

-- CreateIndex
CREATE INDEX "MarketingRecipient_campaignId_state_idx" ON "MarketingRecipient"("campaignId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingRecipient_campaignId_customerId_key" ON "MarketingRecipient"("campaignId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingRecipient_campaignId_phoneKey_key" ON "MarketingRecipient"("campaignId", "phoneKey");


