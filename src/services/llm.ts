import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { User } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db/prisma";
import { getCardTransactions, type Transaction } from "./pluggy";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.OPENROUTER_API_KEY,
});

const MODEL = "z-ai/glm-5.1";
const HISTORY_LIMIT = 10;

function toWhatsAppMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/__(.*?)__/gs, "_$1_")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s/gm, "• ");
}

const BASE_PROMPT = `Você é um assistente financeiro pessoal simpático e objetivo.
Você ajuda a usuária a entender os gastos do cartão de crédito dela de forma clara e amigável.
Responda sempre em português brasileiro. Seja conciso mas completo.
Quando apresentar valores, use o formato R$ X.XXX,XX.
Quando listar transações, agrupe por categoria quando fizer sentido.

FORMATAÇÃO — use exclusivamente a sintaxe do WhatsApp:
- Negrito: *texto* (um asterisco de cada lado, sem espaço entre o asterisco e a palavra)
- Itálico: _texto_
- Nunca use ** (dois asteriscos), # ou outros marcadores de markdown.
- Para listas, use • como marcador.`;

function buildSystemPrompt(user: User): string {
  if (user.isAdmin) {
    return `${BASE_PROMPT}

Você está atendendo Pedro, que é admin. Use sempre cartao: "todos" ao chamar a tool buscar_fatura. Não pergunte sobre cartão. Apresente valores brutos.`;
  }

  const shared = user.sharedCardLast4
    ? `- Compartilhado final ${user.sharedCardLast4} (com o noivo Pedro) → use cartao: "compartilhado"`
    : `- (sem cartão compartilhado configurado)`;

  return `${BASE_PROMPT}

Você está atendendo Beatriz. Ela tem dois cartões:
- Pessoal final ${user.cardLast4} → use cartao: "pessoal"
${shared}

Quando ela perguntar sobre fatura, gastos, compras ou transações sem especificar o cartão, pergunte primeiro: "da sua ou da compartilhada?"

Quando o cartão for compartilhado, os valores que a tool retorna já estão divididos por 2 (a parte dela). Apresente sempre o total bruto junto com a parte dela, no formato: "Total: R$ 1.000,00 — sua parte: R$ 500,00".`;
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "buscar_fatura",
      description:
        "Busca os gastos do cartão de crédito do usuário no período solicitado via Pluggy. Use sempre que perguntarem sobre fatura, gastos, compras ou transações.",
      parameters: {
        type: "object",
        properties: {
          periodo: {
            type: "string",
            description:
              "Período desejado, ex: 'mês atual', 'últimos 7 dias', 'semana passada'.",
          },
          cartao: {
            type: "string",
            enum: ["pessoal", "compartilhado", "todos"],
            description:
              "Qual cartão consultar. 'pessoal' = cartão pessoal do usuário; 'compartilhado' = cartão compartilhado (valores retornados já divididos por 2); 'todos' = consolidado, restrito a admins.",
          },
        },
        required: ["periodo", "cartao"],
      },
    },
  },
];

interface BuscarFaturaArgs {
  periodo: string;
  cartao: "pessoal" | "compartilhado" | "todos";
}

function sumAmounts(txs: Transaction[]): number {
  return txs.reduce((acc, t) => acc + t.amount, 0);
}

async function executeBuscarFatura(
  args: BuscarFaturaArgs,
  user: User
): Promise<string> {
  if (args.cartao === "todos" && !user.isAdmin) {
    return JSON.stringify({
      error:
        "Modo 'todos' não disponível para esse usuário. Use 'pessoal' ou 'compartilhado'.",
    });
  }

  if (args.cartao === "todos") {
    const txs = await getCardTransactions(user.itemId, { kind: "all" });
    return JSON.stringify({
      cartao: "todos",
      total: sumAmounts(txs),
      transacoes: txs,
    });
  }

  if (args.cartao === "pessoal") {
    const txs = await getCardTransactions(user.itemId, {
      kind: "personal",
      cardLast4: user.cardLast4,
    });
    return JSON.stringify({
      cartao: "pessoal",
      total: sumAmounts(txs),
      transacoes: txs,
    });
  }

  if (args.cartao === "compartilhado") {
    if (!user.sharedCardLast4) {
      return JSON.stringify({
        error: "Você não tem cartão compartilhado configurado.",
      });
    }

    const txs = await getCardTransactions(user.itemId, {
      kind: "shared",
      cardLast4: user.sharedCardLast4,
    });
    // Aggregate, then round once. txs[].amount is the unrounded half of each
    // raw transaction. total_bruto = 2× that sum, rounded to cents (recovers
    // the exact original total). sua_parte rounds the user's half to cents.
    const rawUserShare = sumAmounts(txs);
    return JSON.stringify({
      cartao: "compartilhado",
      total_bruto: Math.round(rawUserShare * 200) / 100,
      sua_parte: Math.round(rawUserShare * 100) / 100,
      transacoes: txs,
    });
  }

  return JSON.stringify({
    error: `Cartão inválido: ${String(args.cartao)}. Use 'pessoal', 'compartilhado' ou 'todos'.`,
  });
}

export async function processMessage(
  phone: string,
  userMessage: string,
  user: User
): Promise<string> {
  await prisma.messageHistory.create({
    data: { phone, role: "user", content: userMessage },
  });

  const history = await prisma.messageHistory.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  const contextMessages: ChatCompletionMessageParam[] = history
    .reverse()
    .slice(0, -1)
    .map((h) => ({ role: h.role as "user" | "assistant", content: h.content }));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(user) },
    ...contextMessages,
    { role: "user", content: userMessage },
  ];

  let response = await openai.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
  });

  while (response.choices[0].finish_reason === "tool_calls") {
    const toolCalls = response.choices[0].message.tool_calls ?? [];
    messages.push(response.choices[0].message);

    for (const toolCall of toolCalls) {
      let toolResult: string;

      if (toolCall.function.name === "buscar_fatura") {
        try {
          const args = JSON.parse(toolCall.function.arguments) as BuscarFaturaArgs;
          toolResult = await executeBuscarFatura(args, user);
        } catch (err) {
          toolResult = JSON.stringify({
            error: err instanceof Error ? err.message : "Erro ao buscar transações.",
          });
        }
      } else {
        toolResult = JSON.stringify({ error: "Ferramenta desconhecida." });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }

    response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });
  }

  const raw =
    response.choices[0].message.content ??
    "Desculpe, não consegui processar sua mensagem.";

  const assistantReply = toWhatsAppMarkdown(raw);

  await prisma.messageHistory.create({
    data: { phone, role: "assistant", content: assistantReply },
  });

  return assistantReply;
}
