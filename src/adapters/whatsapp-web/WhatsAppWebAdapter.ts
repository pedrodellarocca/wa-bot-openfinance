import fs from "fs";
import path from "path";
import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import type { IMessagingProvider, IncomingMessage } from "../../core/ports/IMessagingProvider";

const AUTH_DIR = "./.wwebjs_auth";

// Container restarts can leave a stale Chromium SingletonLock pointing at the
// old hostname; the new container then refuses to launch. Strip them on boot.
function clearChromiumSingletonLocks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearChromiumSingletonLocks(full);
    } else if (entry.name.startsWith("Singleton")) {
      fs.unlinkSync(full);
      console.log(`[chromium] removido lock obsoleto: ${full}`);
    }
  }
}

type MessageHandler = (msg: IncomingMessage) => Promise<string>;
type ReadyHandler = () => Promise<void>;

export class WhatsAppWebAdapter implements IMessagingProvider {
  private client: Client;
  private handler: MessageHandler | null = null;
  private readyHandler: ReadyHandler | null = null;
  private latestQr: string | null = null;
  private ready = false;

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onReady(handler: ReadyHandler): void {
    this.readyHandler = handler;
  }

  async send(to: string, text: string): Promise<void> {
    await this.client.sendMessage(to, text);
  }

  // Resolve o WhatsApp ID (LID ou c.us) a partir de um número de telefone
  async getWhatsAppId(phone: string): Promise<string | null> {
    const numberId = await this.client.getNumberId(phone);
    if (!numberId) return null;
    return numberId._serialized.replace(/@c\.us$/, "").replace(/@lid$/, "");
  }

  getStatus(): { ready: boolean; qr: string | null } {
    return { ready: this.ready, qr: this.latestQr };
  }

  async start(): Promise<void> {
    clearChromiumSingletonLocks(AUTH_DIR);

    this.client.on("qr", (qr) => {
      this.latestQr = qr;
      console.log(`\n[${new Date().toLocaleTimeString()}] Novo QR Code gerado:\n`);
      qrcode.generate(qr, { small: true });
    });

    this.client.on("ready", async () => {
      this.ready = true;
      this.latestQr = null;
      console.log("WhatsApp conectado e pronto!");
      if (this.readyHandler) await this.readyHandler();
    });

    this.client.on("auth_failure", (msg) => {
      console.error("Falha na autenticação do WhatsApp:", msg);
    });

    this.client.on("message_create", async (msg) => {
      if (!this.handler) return;
      if (msg.fromMe) return;
      if (msg.isStatus) return;

      const from = msg.from.replace(/@c\.us$/, "").replace(/@lid$/, "");
      console.log(`[msg] from: "${from}" → "${msg.body}"`);
      const incoming: IncomingMessage = { from, body: msg.body };

      try {
        const reply = await this.handler(incoming);
        if (reply) await msg.reply(reply);
      } catch (err) {
        console.error("Erro ao processar mensagem:", err);
        await msg.reply("Desculpe, ocorreu um erro inesperado. Tente novamente.");
      }
    });

    await this.client.initialize();
  }
}
