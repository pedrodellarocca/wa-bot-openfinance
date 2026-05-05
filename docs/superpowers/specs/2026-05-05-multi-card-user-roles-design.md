# Multi-card user roles — design

**Data:** 2026-05-05
**Status:** Aprovado em design; aguardando review pra avançar pro plano de implementação.

## Contexto

O bot WhatsApp atualmente trata cada usuário como dono de um único cartão (`User.cardLast4`). Esse modelo não cobre a realidade do casal: Pedro tem acesso administrativo a toda a fatura do C6 BANDEIRADO; Beatriz tem um cartão pessoal (final `9425`) e compartilha o cartão final `0114` com Pedro, e quando ela pergunta sobre o compartilhado a resposta deve mostrar a parte dela (total dividido por 2).

Bug colateral encontrado durante o diagnóstico (`services/pluggy.ts:67`): o filtro `endsWith(cardLast4)` descartava 100% das transações porque o C6 BANDEIRADO é uma conta de crédito com 14 cartões físicos vinculados, e as transações vêm marcadas com o número do cartão físico usado, nunca com o "principal". Esse bug é resolvido pelo redesign abaixo (cada modo trata a filtragem de forma explícita).

## Objetivo

- Pedro (admin) pergunta qualquer coisa sobre fatura/gastos → bot responde com tudo somado, sem disambiguation.
- Beatriz (restricted) pergunta qualquer coisa sobre fatura/gastos → bot pergunta de qual cartão (pessoal `9425` ou compartilhado `0114`).
  - Resposta "pessoal" → só transações do `9425`, valores brutos.
  - Resposta "compartilhado" → transações do `0114`, apresentadas como total + parte dela (50% do total).

## Não-objetivos

- Suportar 3+ usuários no mesmo cartão compartilhado.
- Suportar múltiplos cartões pessoais por usuário.
- Suportar múltiplos cartões compartilhados.
- Configurar percentual de divisão diferente de 50/50.
- UI para o usuário gerenciar seus cartões (continuamos editando direto no DB por enquanto).

Caso esses cenários surjam no futuro, a abordagem (2) "tabela `UserCard`" passa a fazer sentido. Hoje seria YAGNI.

## Schema (Prisma)

```prisma
model User {
  id               String    @id @default(cuid())
  phone            String    @unique
  whatsappId       String?   @unique
  itemId           String
  cardLast4        String    // cartão pessoal (já existente)
  sharedCardLast4  String?   // novo — cartão compartilhado, opcional
  isAdmin          Boolean   @default(false)  // novo — admin pula filtros e disambiguation
  pinHash          String
  sessionExpiresAt DateTime?
  createdAt        DateTime  @default(now())
}
```

**Migração:** `npx prisma db push` (não há dados em conflito; ambos novos campos têm default seguro).

**Atualização manual das 2 linhas existentes (via SQL Editor do Supabase):**
```sql
-- Pedro (admin)
UPDATE public."User" SET "isAdmin" = true WHERE phone = '<phone-pedro>';

-- Beatriz (restricted)
UPDATE public."User"
SET "cardLast4" = '9425', "sharedCardLast4" = '0114', "isAdmin" = false
WHERE phone = '<phone-beatriz>';
```

(Os números de telefone serão verificados na hora de aplicar.)

## Arquitetura

### `services/pluggy.ts`

Refatorar `getCardTransactions` pra aceitar um `mode`:

```ts
type FetchMode =
  | { kind: "all" }
  | { kind: "personal"; cardLast4: string }
  | { kind: "shared"; cardLast4: string };  // valores divididos por 2 no retorno

export async function getCardTransactions(
  itemId: string,
  mode: FetchMode
): Promise<Transaction[]>;
```

Comportamento:
- `kind: "all"` → retorna todas as transações da conta de crédito, valores brutos.
- `kind: "personal"` → filtra `creditCardMetadata.cardNumber === mode.cardLast4`, valores brutos.
- `kind: "shared"` → filtra `creditCardMetadata.cardNumber === mode.cardLast4`, **mapeia `amount → amount / 2`** antes de retornar.

A divisão acontece dentro do Pluggy service (ponto único de verdade). O LLM nunca faz aritmética. O tipo `Transaction` ganha um campo opcional `note?: string` para o caller (LLM tool handler) anexar contexto como "valor já dividido por 2 (sua parte)" — útil pra renderização.

Alternativa considerada: deixar o `pluggy.ts` puro e dividir no tool handler. Rejeitada porque empurra estado de domínio (regra de split) pra duas camadas.

### `services/llm.ts`

#### Tool

```ts
buscar_fatura(periodo: string, cartao: "pessoal" | "compartilhado" | "todos")
```

#### System prompt — renderizado por usuário

O orquestrador injeta um bloco de contexto no system prompt baseado no perfil:

**Para admin (Pedro):**
> Você atende Pedro, que é admin. Use sempre `cartao: "todos"` ao chamar a tool. Não pergunte sobre cartão. Apresente valores brutos.

**Para restricted (Beatriz):**
> Você atende Beatriz. Ela tem dois cartões:
> - Pessoal final 9425 → use `cartao: "pessoal"`
> - Compartilhado final 0114 (com o noivo Pedro) → use `cartao: "compartilhado"`
>
> Quando ela perguntar sobre fatura, gastos, compras ou transações sem especificar o cartão, pergunte primeiro: "da sua ou da compartilhada?"
>
> Quando o cartão for compartilhado, os valores que a tool retorna **já estão divididos por 2** (a parte dela). Apresente sempre o **total** original junto com a **parte dela**, no formato: "Total: R$ 1.000,00 — sua parte: R$ 500,00".

Pra apresentar o "total" no caso compartilhado, a tool precisa devolver tanto o valor dividido quanto o total. Solução simples: `Transaction` para `kind: "shared"` carrega `{ amount: dividido, totalAmount: original }`. Ou: a tool devolve um objeto `{ transactions, totalRaw, totalUserShare }` em vez de apenas array.

Pra simplicidade, escolhemos **a segunda**: o tool result pra `compartilhado` será um objeto:
```json
{
  "cartao": "compartilhado",
  "total_bruto": 1000.0,
  "sua_parte": 500.0,
  "transacoes": [{ "description": "...", "amount": 250.0, "date": "..." }, ...]
}
```
(`amount` em cada transação já vem dividido por 2.)

Pra `pessoal` e `todos`:
```json
{
  "cartao": "pessoal" | "todos",
  "total": 1000.0,
  "transacoes": [...]
}
```

### `orchestrator.ts`

Atualmente:
```ts
return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
```

Mudar pra passar o objeto `user` inteiro (assim `processMessage` tem acesso a `isAdmin`, `cardLast4`, `sharedCardLast4`):
```ts
return await processMessage(msg.from, msg.body, user);
```

`processMessage` em `llm.ts` muda a assinatura e usa `user.isAdmin` pra escolher o system prompt e validar (defesa em profundidade) o `cartao` que o LLM passa: se Beatriz tentar `cartao: "todos"`, o tool handler retorna erro.

## Fluxo de exemplo

**Beatriz:** "quanto está a fatura?"
**Bot:** "Da sua ou da compartilhada?"
**Beatriz:** "compartilhada"
**Bot (após chamar tool com `cartao: "compartilhado"`):** "Fatura compartilhada: total R$ 1.250,00 — sua parte: R$ 625,00 🍔"

**Beatriz:** "quanto gastei com comida este mês?"
**Bot:** "Da sua ou da compartilhada?"
**Beatriz:** "minha"
**Bot (tool com `cartao: "pessoal"`):** "Em comida você gastou R$ 320,00 este mês 🍕"

**Pedro:** "quanto está a fatura?"
**Bot (tool direto com `cartao: "todos"`, sem perguntar):** "Fatura atual: R$ 27.689,10. Maior categoria: Alimentação."

## Testing

- Manual no WhatsApp após deploy:
  - Pedro: pergunta direta retorna soma total, sem disambiguation.
  - Beatriz: pergunta sem especificar → bot pergunta qual cartão.
  - Beatriz → "compartilhada" → resposta mostra `total` + `sua parte`.
  - Beatriz → "minha" → só transações do 9425.
- Defesa em profundidade: se o LLM (Beatriz) tentar `cartao: "todos"`, o tool handler retorna erro estruturado e o LLM deve se ajustar.

## Plano de implementação (resumo)

A ser detalhado pelo skill `writing-plans` após review deste spec. Esqueleto:

1. Atualizar `prisma/schema.prisma` com os 2 novos campos.
2. Rodar `npx prisma db push` + `npx prisma generate`.
3. Atualizar as 2 linhas existentes no Supabase via SQL Editor.
4. Refatorar `services/pluggy.ts` com `FetchMode`.
5. Atualizar tool e system prompt em `services/llm.ts`.
6. Atualizar `orchestrator.ts` pra passar `user` completo.
7. Commitar, fazer push, aguardar redeploy do Railway.
8. Testar manualmente os 3 cenários acima.
