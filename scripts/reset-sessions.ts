import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.user.updateMany({
    data: { whatsappId: null, sessionExpiresAt: null },
  });
  console.log(`✅ Reset concluído: ${result.count} usuário(s) limpo(s).`);
}

main()
  .catch((e) => { console.error("Erro:", e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
