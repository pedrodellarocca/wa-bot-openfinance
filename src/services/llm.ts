import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../config";
import { prisma } from "../db/prisma";
import { getCardTransactions } from "./pluggy";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.OPENROUTER_API_KEY,
});

const MODEL = "z-ai/glm-5.1";
const HISTORY_LIMIT = 10;

function toWhatsAppMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")   // **bold** → *bold*
    .replace(/__(.*?)__/gs, "_$1_")        // __italic__ → _italic_
    .replace(/^#{1,6}\s+/gm, "")          // remove markdown headers
    .replace(/^[-*]\s/gm, "• ");          // - item → • item
}

const SYSTEM_PROMPT = `Você é um assistente financeiro pessoal simpático e objetivo.
Você ajuda a usuária a entender os gastos do cartão de crédito dela de forma clara e amigável.
Responda sempre em português brasileiro. Seja conciso mas completo.
Quando apresentar valores, use o formato R$ X.XXX,XX.
Quando listar transações, agrupe por categoria quando fizer sentido.

FORMATAÇÃO — use exclusivamente a sintaxe do WhatsApp:
- Negrito: *texto* (um asterisco de cada lado, sem espaço entre o asterisco e a palavra)
- Itálico: _texto_
- Nunca use ** (dois asteriscos), # ou outros marcadores de markdown.
- Para listas, use • como marcador.`;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "buscar_fatura",
      description:
        "Busca os gastos do cartão de crédito da usuária no período solicitado via Pluggy (Open Finance). Use esta ferramenta sempre que a usuária perguntar sobre gastos, compras, faturas ou transações.",
      parameters: {
        type: "object",
        properties: {
          periodo: {
            type: "string",
            description:
              "Período desejado pela usuária, ex: 'mês atual', 'últimos 7 dias', 'semana passada'",
          },
        },
        required: ["periodo"],
      },
    },
  },
];

export async function processMessage(
  phone: string,
  userMessage: string,
  itemId: string,
  cardLast4: string
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
    .slice(0, -1) // remove a mensagem que acabamos de salvar (já está em userMessage)
    .map((h) => ({ role: h.role as "user" | "assistant", content: h.content }));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...contextMessages,
    { role: "user", content: userMessage },
  ];

  let response = await openai.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
  });

  // Loop de Function Calling
  while (response.choices[0].finish_reason === "tool_calls") {
    const toolCalls = response.choices[0].message.tool_calls ?? [];
    messages.push(response.choices[0].message);

    for (const toolCall of toolCalls) {
      let toolResult: string;

      if (toolCall.function.name === "buscar_fatura") {
        try {
          const transactions = await getCardTransactions(itemId, cardLast4);
          toolResult = JSON.stringify(transactions);
        } catch (err) {
          // DEBUG: log the full error so we can see Pluggy SDK details
          console.error("[buscar_fatura] FAILED:", err);
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
    response.choices[0].message.content ?? "Desculpe, não consegui processar sua mensagem.";

  const assistantReply = toWhatsAppMarkdown(raw);

  await prisma.messageHistory.create({
    data: { phone, role: "assistant", content: assistantReply },
  });

  return assistantReply;
}
