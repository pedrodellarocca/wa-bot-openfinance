import bcrypt from "bcrypt";
import { prisma } from "../db/prisma";
import { processMessage } from "../services/llm";
import type { IncomingMessage } from "./ports/IMessagingProvider";

const SESSION_HOURS = 12;

const MSG_ASK_PIN =
  "🔐 Olá! Digite seu PIN para acessar suas informações financeiras.";
const MSG_WRONG_PIN =
  "❌ PIN incorreto. Tente novamente.";
const MSG_SESSION_OK = `✅ PIN correto! Sessão ativa por ${SESSION_HOURS} horas. Como posso te ajudar?`;

export async function handleMessage(msg: IncomingMessage): Promise<string> {
  const user = await prisma.user.findUnique({ where: { phone: msg.from } });

  if (!user) return "";

  const now = new Date();
  const sessionActive = user.sessionExpiresAt && user.sessionExpiresAt > now;

  if (!sessionActive) {
    const attempt = msg.body.trim();

    // Qualquer mensagem que não seja um PIN numérico pede o PIN
    if (!/^\d{4,8}$/.test(attempt)) {
      return MSG_ASK_PIN;
    }

    const valid = await bcrypt.compare(attempt, user.pinHash);

    if (!valid) return MSG_WRONG_PIN;

    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
    await prisma.user.update({
      where: { phone: msg.from },
      data: { sessionExpiresAt: expiresAt },
    });

    return MSG_SESSION_OK;
  }

  try {
    return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
  } catch (err) {
    console.error("Erro no orquestrador:", err);
    return "Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.";
  }
}
