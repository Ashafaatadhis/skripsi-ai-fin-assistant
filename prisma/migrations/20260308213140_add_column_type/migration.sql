-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "description" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'EXPENSE',
ALTER COLUMN "merchant" DROP NOT NULL;
