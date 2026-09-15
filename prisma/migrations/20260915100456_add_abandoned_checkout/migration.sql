-- CreateTable
CREATE TABLE "AbandonedCheckout" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "checkoutToken" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "orderDetails" TEXT NOT NULL,
    "imageUrl" TEXT,
    "checkoutUrl" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted" BOOLEAN NOT NULL DEFAULT false,
    "messaged" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedCheckout_checkoutToken_key" ON "AbandonedCheckout"("checkoutToken");
