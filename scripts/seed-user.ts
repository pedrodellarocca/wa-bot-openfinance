import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SANDBOX_ITEM_ID = "38c7f48a-0684-43d8-802e-9b4abc33577d";
const PIN = "1904";

const users = [
  {
    phone: "5548984516922",
    itemId: SANDBOX_ITEM_ID,
    cardLast4: "8634",
    label: "Dev (você)",
  },
  {
    phone: "5548984678502",
    itemId: SANDBOX_ITEM_ID,
    cardLast4: "9425",
    label: "Noiva",
  },
];

async function main() {
  const pinHash = await bcrypt.hash(PIN, 12);

  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { phone: u.phone },
      update: { itemId: u.itemId, cardLast4: u.cardLast4, pinHash },
      create: { phone: u.phone, itemId: u.itemId, cardLast4: u.cardLast4, pinHash },
    });

    console.log(`✅ ${u.label}:`);
    console.log(`   phone:     ${user.phone}`);
    console.log(`   itemId:    ${user.itemId}`);
    console.log(`   cardLast4: ${user.cardLast4}`);
    console.log(`   pinHash:   ${user.pinHash.slice(0, 20)}...`);
  }
}

main()
  .catch((err) => {
    console.error("❌ Erro:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
