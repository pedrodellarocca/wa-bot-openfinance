import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import type { IMessagingProvider, IncomingMessage } from "../../core/ports/IMessagingProvider";

type MessageHandler = (msg: IncomingMessage) => Promise<string>;

export class WhatsAppWebAdapter implements IMessagingProvider {
  private client: Client;
  private handler: MessageHandler | null = null;

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async send(to: string, text: string): Promise<void> {
    await this.client.sendMessage(to, text);
  }

  async start(): Promise<void> {
    this.client.on("qr", (qr) => {
      console.log("\nEscaneie o QR Code abaixo com o WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("ready", () => {
      console.log("WhatsApp conectado e pronto!");
    });

    this.client.on("auth_failure", (msg) => {
      console.error("Falha na autenticação do WhatsApp:", msg);
    });

    this.client.on("message_create", async (msg) => {
      if (!this.handler) return;
      if (msg.fromMe) return;
      if (msg.isStatus) return;

      const contact = await msg.getContact();
      const from = contact.number;
      console.log(`[debug] mensagem recebida — from raw: "${msg.from}" → número: "${from}"`);
      const incoming: IncomingMessage = { from, body: msg.body };

      try {
        const reply = await this.handler(incoming);
        if (reply) {
          await msg.reply(reply);
        }
      } catch (err) {
        console.error("Erro ao processar mensagem:", err);
        await msg.reply("Desculpe, ocorreu um erro inesperado. Tente novamente.");
      }
    });

    await this.client.initialize();
  }
}
