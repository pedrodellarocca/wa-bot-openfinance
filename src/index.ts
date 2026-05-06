import "./config";
import { prisma } from "./db/prisma";
import { WhatsAppWebAdapter } from "./adapters/whatsapp-web/WhatsAppWebAdapter";
import { handleMessage } from "./core/orchestrator";
import { startQrServer } from "./qr-server";

async function main() {
  const adapter = new WhatsAppWebAdapter();
  const server = startQrServer(() => adapter.getStatus());

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

  // Railway sends SIGTERM to the old replica during a rolling deploy. Without
  // a handler, Node exits with code 143 and the npm wrapper reports "command
  // failed signal SIGTERM" — Railway then mistakes the normal lifecycle for
  // a crash and emails "Deploy Crashed!". Cleanly closing and exiting 0
  // suppresses the false alarm. Hard 8s timeout in case Chromium teardown hangs.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, cleaning up...`);

    const forceExit = setTimeout(() => {
      console.warn("[shutdown] cleanup timeout, forcing exit 0");
      process.exit(0);
    }, 8000);

    try {
      server.close();
      await adapter.stop();
      await prisma.$disconnect();
      console.log("[shutdown] clean");
    } catch (err) {
      console.error("[shutdown] error during cleanup:", err);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log("Iniciando bot...");
  await adapter.start();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
