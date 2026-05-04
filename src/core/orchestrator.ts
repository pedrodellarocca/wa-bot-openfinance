import bcrypt from "bcrypt";
import { prisma } from "../db/prisma";
import { processMessage } from "../services/llm";
import type { IncomingMessage } from "./ports/IMessagingProvider";

const SESSION_HOURS = 12;

const MSG_NOT_LINKED =
  `🔐 Para ativar o bot, envie:\n\n*LINK [seu número] [PIN]*\n\nEx: LINK 5548984516922 1904`;
const MSG_WRONG_PIN    = "❌ PIN incorreto. Tente novamente.";
const MSG_ALREADY_LINKED = "❌ Número não encontrado ou já vinculado a outro dispositivo.";
const MSG_SESSION_OK   = `✅ Conta vinculada! Sessão ativa por ${SESSION_HOURS}h. Como posso te ajudar?`;
const MSG_ASK_PIN      = "🔐 Sessão expirada. Digite seu PIN para continuar.";
const MSG_PIN_OK       = `✅ PIN correto! Sessão ativa por ${SESSION_HOURS}h. Como posso te ajudar?`;

// Comando de primeiro acesso: LINK <telefone> <pin>
const LINK_REGEX = /^LINK\s+(\d+)\s+(\d{4,8})$/i;

export async function handleMessage(msg: IncomingMessage): Promise<string> {
  // Tenta encontrar pelo whatsappId (LID ou número c.us)
  let user = await prisma.user.findUnique({ where: { whatsappId: msg.from } });

  // Usuário ainda não vinculou este dispositivo
  if (!user) {
    const linkMatch = msg.body.trim().match(LINK_REGEX);

    if (!linkMatch) return MSG_NOT_LINKED;

    const [, phone, pin] = linkMatch;
    const candidate = await prisma.user.findUnique({ where: { phone } });

    if (!candidate || candidate.whatsappId) return MSG_ALREADY_LINKED;

    const valid = await bcrypt.compare(pin, candidate.pinHash);
    if (!valid) return MSG_WRONG_PIN;

    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: candidate.id },
      data: { whatsappId: msg.from, sessionExpiresAt: expiresAt },
    });

    return MSG_SESSION_OK;
  }

  // Usuário vinculado — verifica sessão
  const now = new Date();
  const sessionActive = user.sessionExpiresAt && user.sessionExpiresAt > now;

  if (!sessionActive) {
    const attempt = msg.body.trim();

    if (!/^\d{4,8}$/.test(attempt)) return MSG_ASK_PIN;

    const valid = await bcrypt.compare(attempt, user.pinHash);
    if (!valid) return MSG_WRONG_PIN;

    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionExpiresAt: expiresAt },
    });

    return MSG_PIN_OK;
  }

  try {
    return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
  } catch (err) {
    console.error("Erro no orquestrador:", err);
    return "Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.";
  }
}
