import "./config"; // valida env vars na inicialização
import { WhatsAppWebAdapter } from "./adapters/whatsapp-web/WhatsAppWebAdapter";
import { handleMessage } from "./core/orchestrator";

async function main() {
  const adapter = new WhatsAppWebAdapter();

  adapter.onMessage(async (msg) => {
    return handleMessage(msg);
  });

  console.log("Iniciando bot...");
  await adapter.start();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
