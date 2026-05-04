import bcrypt from "bcrypt";
import { prisma } from "../db/prisma";
import { processMessage } from "../services/llm";
import type { IncomingMessage } from "./ports/IMessagingProvider";

const SESSION_HOURS = 12;

export async function handleMessage(msg: IncomingMessage): Promise<string> {
  const user = await prisma.user.findUnique({ where: { whatsappId: msg.from } });

  // Número não cadastrado — ignora silenciosamente
  if (!user) return "";

  const now = new Date();
  const sessionActive = user.sessionExpiresAt && user.sessionExpiresAt > now;

  if (!sessionActive) {
    const attempt = msg.body.trim();

    if (!/^\d{4,8}$/.test(attempt)) {
      return "🔐 Olá! Envie seu PIN para acessar suas informações financeiras:";
    }

    const valid = await bcrypt.compare(attempt, user.pinHash);
    if (!valid) return "❌ PIN incorreto. Tente novamente.";

    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
    await prisma.user.update({ where: { id: user.id }, data: { sessionExpiresAt: expiresAt } });
    return `✅ PIN correto! Sessão ativa por ${SESSION_HOURS}h. Como posso te ajudar?`;
  }

  try {
    return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
  } catch (err) {
    console.error("Erro no orquestrador:", err);
    return "Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.";
  }
}
