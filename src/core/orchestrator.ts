import { prisma } from "../db/prisma";
import { processMessage } from "../services/llm";
import type { IncomingMessage } from "./ports/IMessagingProvider";

export async function handleMessage(msg: IncomingMessage): Promise<string> {
  const user = await prisma.user.findUnique({ where: { phone: msg.from } });

  if (!user) {
    // Número não autorizado — retorna string vazia para o adapter ignorar
    return "";
  }

  try {
    return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
  } catch (err) {
    console.error("Erro no orquestrador:", err);
    return "Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.";
  }
}
