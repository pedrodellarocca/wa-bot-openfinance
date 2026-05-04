import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { phone: "5548984678502" },
    update: {
      itemId: "38c7f48a-0684-43d8-802e-9b4abc33577d",
      cardLast4: "9425",
    },
    create: {
      phone: "5548984678502",
      itemId: "38c7f48a-0684-43d8-802e-9b4abc33577d",
      cardLast4: "9425",
    },
  });

  console.log("✅ Usuário inserido com sucesso:");
  console.log(`   phone:     ${user.phone}`);
  console.log(`   itemId:    ${user.itemId}`);
  console.log(`   cardLast4: ${user.cardLast4}`);
}

main()
  .catch((err) => {
    console.error("❌ Erro:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
