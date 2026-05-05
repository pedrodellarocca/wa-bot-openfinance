import "./config";
import { prisma } from "./db/prisma";
import { WhatsAppWebAdapter } from "./adapters/whatsapp-web/WhatsAppWebAdapter";
import { handleMessage } from "./core/orchestrator";
import { startQrServer } from "./qr-server";

async function main() {
  const adapter = new WhatsAppWebAdapter();
  startQrServer(() => adapter.getStatus());

  adapter.onReady(async () => {
    const users = await prisma.user.findMany({ where: { whatsappId: null } });
    for (const user of users) {
      const wid = await adapter.getWhatsAppId(user.phone);
      if (wid) {
        await prisma.user.update({ where: { id: user.id }, data: { whatsappId: wid } });
        console.log(`✅ ${user.phone} → ${wid}`);
      } else {
        console.warn(`⚠️  Número não encontrado no WhatsApp: ${user.phone}`);
      }
    }
  });

  adapter.onMessage(async (msg) => handleMessage(msg));

  console.log("Iniciando bot...");
  await adapter.start();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
