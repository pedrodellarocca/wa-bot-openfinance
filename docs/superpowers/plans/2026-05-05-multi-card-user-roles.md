# Multi-card user roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable per-user role behavior on the WhatsApp bot — Pedro (admin) sees the full credit card consolidated; Beatriz (restricted) sees her personal card (final 9425) and the shared card (final 0114), with disambiguation prompts and 50/50 split presentation for the shared card.

**Architecture:** Augment the `User` table with `sharedCardLast4` (nullable) and `isAdmin` (default false). The Pluggy service exposes a `FetchMode` discriminated union (`all` / `personal` / `shared`) where the `shared` mode applies the 50% split inside the data layer. The LLM tool gains a `cartao` parameter (`"pessoal" | "compartilhado" | "todos"`); the system prompt is rendered per user so the LLM knows when to ask the disambiguation question and when to skip it.

**Tech Stack:** TypeScript, Prisma (Postgres/Supabase), Pluggy SDK, OpenRouter (z-ai/glm-5.1), Railway deploy.

**Spec:** `docs/superpowers/specs/2026-05-05-multi-card-user-roles-design.md`

**Testing approach:** This codebase has no automated test infrastructure. Verification is by `npx tsc --noEmit` for type safety + manual end-to-end test in WhatsApp after Railway redeploys (covered in Task 8).

---

## Task 0: Commit cleanup of pre-existing working-directory changes

Before starting feature work, get the tree clean. Two pre-existing edits accumulated during the diagnostic session: `scripts/setup-pluggy.ts` (sandbox filter hardening) and the new `docs/` directory containing the spec.

**Files:**
- Modified (already): `scripts/setup-pluggy.ts`
- Untracked (already): `docs/superpowers/specs/2026-05-05-multi-card-user-roles-design.md`, `docs/superpowers/plans/2026-05-05-multi-card-user-roles.md`

- [ ] **Step 1: Verify tree state**

Run: `git status`
Expected output includes:
```
modified:   scripts/setup-pluggy.ts
Untracked files:
  docs/
```

- [ ] **Step 2: Inspect the setup-pluggy.ts diff**

Run: `git diff scripts/setup-pluggy.ts`
Expected: changes adding `includeSandbox: false`, `countries: ['BR']`, `connectorTypes: ['PERSONAL_BANK']` to the `PluggyConnect` options, plus updated UI text warning to pick the real C6 (not the sandbox demo).

- [ ] **Step 3: Stage and commit setup-pluggy hardening**

```bash
git add scripts/setup-pluggy.ts
git commit -m "$(cat <<'EOF'
chore(setup-pluggy): hide sandbox connectors in Connect widget

Filters Pluggy Connect to PERSONAL_BANK Brazilian connectors only and
hides sandbox so the operator can't accidentally pick "Pluggy Bank"
(which previously left the bot pointing at fake data).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Stage and commit design + plan docs**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: spec + plan for multi-card user roles

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Task 1: Add `sharedCardLast4` and `isAdmin` to the Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Replace the `User` model (lines 10-19) with:

```prisma
model User {
  id               String    @id @default(cuid())
  phone            String    @unique
  whatsappId       String?   @unique
  itemId           String
  cardLast4        String
  sharedCardLast4  String?
  isAdmin          Boolean   @default(false)
  pinHash          String
  sessionExpiresAt DateTime?
  createdAt        DateTime  @default(now())
}
```

Keep the rest of the file untouched.

- [ ] **Step 2: Push schema to Supabase**

Run: `npx prisma db push`

Expected output ends with:
```
Your database is now in sync with your Prisma schema.
```

If it fails with an "invalid IPv6 address" or similar `DATABASE_URL` error: this is a known issue with the local `.env` (the URL contains placeholders like `[PASSWORD]`/`[HOST]`). In that case, ask the operator to either fix the local URL temporarily, or skip this step — Railway has the correct URL and `npx prisma db push` will be performed there as part of the deploy. If skipping, the operator must run a manual migration via the Supabase SQL Editor:

```sql
ALTER TABLE public."User" ADD COLUMN "sharedCardLast4" TEXT;
ALTER TABLE public."User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE;
```

- [ ] **Step 3: Regenerate Prisma client**

Run: `npx prisma generate`

Expected: `✔ Generated Prisma Client`. The `User` type in `node_modules/.prisma/client` now has `sharedCardLast4` and `isAdmin`.

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: PASS (no errors). The new fields exist on `User` but aren't used anywhere yet, so no type breakage.

---

## Task 2: Update existing DB rows for Pedro and Beatriz

This is a manual operator step in Supabase SQL Editor. The plan must include exact SQL.

**Files:** none (DB-only).

- [ ] **Step 1: Identify the two existing rows**

In Supabase SQL Editor, run:

```sql
SELECT id, phone, "cardLast4", "sharedCardLast4", "isAdmin"
FROM public."User";
```

Expected: 2 rows, both with `cardLast4` previously set, `sharedCardLast4 = NULL`, `isAdmin = false`. The operator identifies which `phone` belongs to Pedro vs Beatriz.

- [ ] **Step 2: Update Pedro's row (admin)**

Replace `<PEDRO_PHONE>` with the actual phone from Step 1.

```sql
UPDATE public."User"
SET "isAdmin" = TRUE
WHERE phone = '<PEDRO_PHONE>';
```

Expected: `UPDATE 1`.

- [ ] **Step 3: Update Beatriz's row (restricted)**

Replace `<BEATRIZ_PHONE>` with the actual phone from Step 1.

```sql
UPDATE public."User"
SET "cardLast4" = '9425',
    "sharedCardLast4" = '0114',
    "isAdmin" = FALSE
WHERE phone = '<BEATRIZ_PHONE>';
```

Expected: `UPDATE 1`.

- [ ] **Step 4: Verify final state**

```sql
SELECT phone, "cardLast4", "sharedCardLast4", "isAdmin"
FROM public."User";
```

Expected:
- Pedro's row: `cardLast4` = (whatever it was), `sharedCardLast4` = NULL, `isAdmin` = TRUE
- Beatriz's row: `cardLast4` = '9425', `sharedCardLast4` = '0114', `isAdmin` = FALSE

---

## Task 3: Refactor `services/pluggy.ts` to support FetchMode

**Files:**
- Modify: `src/services/pluggy.ts` (full rewrite)

- [ ] **Step 1: Replace the file content**

Overwrite `src/services/pluggy.ts` with:

```typescript
import { PluggyClient } from "pluggy-sdk";
import { config } from "../config";

export interface Transaction {
  description: string;
  amount: number;
  date: string;
  category: string | null;
  cardNumber: string | null;
}

export type FetchMode =
  | { kind: "all" }
  | { kind: "personal"; cardLast4: string }
  | { kind: "shared"; cardLast4: string };

let client: PluggyClient | null = null;

function getClient(): PluggyClient {
  if (!client) {
    client = new PluggyClient({
      clientId: config.PLUGGY_CLIENT_ID,
      clientSecret: config.PLUGGY_CLIENT_SECRET,
    });
  }
  return client;
}

function startOfMonth(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

export async function getCardTransactions(
  itemId: string,
  mode: FetchMode
): Promise<Transaction[]> {
  const pluggy = getClient();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            "A consulta ao banco demorou demais. Tente novamente em instantes."
          )
        ),
      15_000
    )
  );

  const fetchPromise = (async () => {
    const accounts = await pluggy.fetchAccounts(itemId, "CREDIT");

    if (accounts.results.length === 0) {
      return [];
    }

    const all: Transaction[] = [];

    for (const account of accounts.results) {
      const txResponse = await pluggy.fetchTransactions(account.id, {
        from: startOfMonth(),
        to: today(),
      });

      for (const tx of txResponse.results) {
        const cardNumber = tx.creditCardMetadata?.cardNumber ?? null;

        if (mode.kind === "personal" && cardNumber !== mode.cardLast4) continue;
        if (mode.kind === "shared" && cardNumber !== mode.cardLast4) continue;

        const amount =
          mode.kind === "shared" ? tx.amount / 2 : tx.amount;

        all.push({
          description: tx.description,
          amount,
          date: tx.date.toISOString().split("T")[0],
          category: tx.category,
          cardNumber,
        });
      }
    }

    return all;
  })();

  return Promise.race([fetchPromise, timeoutPromise]);
}
```

Key changes vs. previous version:
- New exported `FetchMode` type.
- Function signature changes from `(itemId, cardLast4)` to `(itemId, mode)`.
- For `kind: "shared"`, `tx.amount` is divided by 2 inside this layer (single source of truth for the split rule).
- `Transaction` gains `cardNumber` so callers can audit which physical card produced each transaction.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: errors in `src/services/llm.ts` because it still calls `getCardTransactions(itemId, cardLast4)` with the old signature. That's expected — Task 4 fixes it. Don't commit yet.

---

## Task 4: Update tool definition, system prompt, and tool handler in `services/llm.ts`

**Files:**
- Modify: `src/services/llm.ts` (significant changes — full rewrite below)

- [ ] **Step 1: Replace the file content**

Overwrite `src/services/llm.ts` with:

```typescript
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
      error: "Modo 'todos' não disponível para esse usuário. Use 'pessoal' ou 'compartilhado'.",
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

  // cartao === "compartilhado"
  if (!user.sharedCardLast4) {
    return JSON.stringify({
      error: "Você não tem cartão compartilhado configurado.",
    });
  }

  const txs = await getCardTransactions(user.itemId, {
    kind: "shared",
    cardLast4: user.sharedCardLast4,
  });
  const userShare = sumAmounts(txs);
  return JSON.stringify({
    cartao: "compartilhado",
    total_bruto: userShare * 2,
    sua_parte: userShare,
    transacoes: txs,
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
```

Key changes:
- `processMessage` now takes the full `User` (not `itemId, cardLast4`).
- New `buildSystemPrompt(user)` renders admin vs restricted variants.
- Tool `buscar_fatura` gains required `cartao` param with enum.
- New `executeBuscarFatura` handles each mode, performs the defense-in-depth check that non-admins can't pass `cartao: "todos"`, and shapes the response object differently for "compartilhado" (total_bruto + sua_parte).
- `cardNumber` propagated through `Transaction` for completeness.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: error in `src/core/orchestrator.ts:33` because it still calls `processMessage(msg.from, msg.body, user.itemId, user.cardLast4)` with the old signature. Task 5 fixes it.

---

## Task 5: Update `core/orchestrator.ts` to pass full `User`

**Files:**
- Modify: `src/core/orchestrator.ts:33`

- [ ] **Step 1: Apply the change**

Replace line 33:
```typescript
return await processMessage(msg.from, msg.body, user.itemId, user.cardLast4);
```

With:
```typescript
return await processMessage(msg.from, msg.body, user);
```

No other lines change.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: PASS (zero errors).

---

## Task 6: Local build verification

**Files:** none (verification only).

- [ ] **Step 1: Build with TypeScript compiler**

Run: `npx tsc`

Expected: PASS (zero errors). A `dist/` directory is produced; this matches the production build (`npm run build`).

- [ ] **Step 2: Inspect the diff**

Run: `git diff --stat`

Expected: 4 files changed —
```
 prisma/schema.prisma           |  2 +
 src/core/orchestrator.ts       |  2 +-
 src/services/llm.ts            | NN ++++++--
 src/services/pluggy.ts         | NN ++++++---
```

- [ ] **Step 3: Skim the diff for surprises**

Run: `git diff`

Expected: only the changes described in Tasks 1, 3, 4, 5. No accidental edits elsewhere.

---

## Task 7: Commit and push

**Files:**
- All staged from Task 6.

- [ ] **Step 1: Stage and commit**

```bash
git add prisma/schema.prisma src/core/orchestrator.ts src/services/llm.ts src/services/pluggy.ts
git commit -m "$(cat <<'EOF'
feat: per-user roles and shared-card split for fatura queries

Adds isAdmin and sharedCardLast4 to the User model. Refactors the
Pluggy service with a FetchMode union ("all" / "personal" / "shared")
where the shared mode applies the 50% split inside the data layer.
The LLM tool gains a "cartao" parameter and the system prompt is
rendered per user, so Pedro (admin) gets answers without disambiguation
and Beatriz (restricted) is asked which card before each query, with
the shared card always presented as "Total + sua parte".

Also fixes the previous filter bug: cardLast4 endsWith() was discarding
all transactions because the C6 BANDEIRADO is a multi-card account
where transactions reference the physical card used (e.g. 0114),
never the "principal" 9490.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Push to origin**

```bash
git push origin main
```

Expected: pushed successfully. Railway watches `main` and starts a new deploy.

---

## Task 8: Verify Railway deploy and run manual test scenarios

**Files:** none (operator verification).

- [ ] **Step 1: Wait for Railway redeploy**

Open Railway → wa-bot-openfinance project → Deployments tab. Wait for the new commit's deployment to reach "Deployment successful" status. Typical time: 60-120 seconds.

- [ ] **Step 2: Confirm container is running**

In Railway, click "View logs" on the latest deployment. Expected log lines (in order):
```
Iniciando bot...
[chromium] removido lock obsoleto: ...
[qr-server] escutando em 0.0.0.0:8080
WhatsApp conectado e pronto!
```

If the bot needs QR re-pairing (rare — usually the persistent volume keeps the session), open the QR URL from logs and scan.

- [ ] **Step 3: Test scenario A — Pedro (admin) asks about fatura**

From Pedro's WhatsApp number, send: `quanto está a fatura?`

Expected: bot responds with the consolidated value across all cards (no disambiguation question). Should report something close to R$ 27.689,10 (the total balance from the diagnostic earlier this session) — exact value will reflect transactions from start of current month to today.

- [ ] **Step 4: Test scenario B — Beatriz asks ambiguously**

From Beatriz's WhatsApp number, send: `quanto está a fatura?`

Expected: bot responds with a question, e.g. "da sua ou da compartilhada?" or similar phrasing.

- [ ] **Step 5: Test scenario C — Beatriz answers "compartilhada"**

After scenario B, Beatriz replies: `compartilhada`

Expected: bot responds with both the total amount on card 0114 and her share (50%), e.g.: "Total: R$ X — sua parte: R$ X/2".

- [ ] **Step 6: Test scenario D — Beatriz answers "minha"**

Reset by sending a new question from Beatriz: `quanto gastei este mês?`. When the bot asks, reply: `meu cartão`.

Expected: bot returns only transactions from card 9425, with raw amounts.

- [ ] **Step 7: Test scenario E — defense in depth**

Optional: Beatriz sends an explicitly-scoped query that tries to bypass: `me mostra a fatura completa de tudo`.

Expected: the LLM either still asks her to clarify or chooses one of her allowed cards. If the model attempts `cartao: "todos"`, the tool handler returns the error "Modo 'todos' não disponível..." and the LLM should rephrase. The user-visible result must NOT include consolidated data she shouldn't see.

- [ ] **Step 8: Report**

Document any unexpected behavior. If a scenario fails, capture:
- The exact message sent
- The bot's reply
- Recent Railway logs (last ~30s)

Hand back to design discussion if behavior diverges from spec.

---

## Roll-back plan

If something breaks in production:

```bash
git revert HEAD --no-edit
git push origin main
```

(If Task 0 commits also need to revert, repeat for those SHAs.) Railway redeploys the previous build. The DB column additions are non-destructive — leaving `sharedCardLast4` and `isAdmin` in place doesn't affect the previous code path. If you want to fully roll the schema back:

```sql
ALTER TABLE public."User" DROP COLUMN "sharedCardLast4";
ALTER TABLE public."User" DROP COLUMN "isAdmin";
```

---

## Self-review checklist (executed before publishing this plan)

- **Spec coverage:** All 4 sections of the spec (Schema, services/pluggy.ts, services/llm.ts, orchestrator.ts) map to Tasks 1, 3, 4, 5 respectively. Examples from the spec ("Pedro pergunta..." / "Beatriz pergunta...") map to test scenarios in Task 8. The non-objectives (3+ users, multiple shared, 3-way splits) are honored: nothing in the plan supports those.
- **Placeholder scan:** `<PEDRO_PHONE>` and `<BEATRIZ_PHONE>` are documented placeholders (the operator's data — there's no way for the plan to know them). No "TBD"/"TODO"/"add appropriate error handling" left over.
- **Type consistency:** `Transaction.amount`, `FetchMode.kind`, `BuscarFaturaArgs.cartao`, `User.cardLast4`, `User.sharedCardLast4`, `User.isAdmin` are used consistently across Tasks 1, 3, 4, 5. The tool result shape for "compartilhado" (`total_bruto` + `sua_parte`) matches what the system prompt instructs the LLM to render.
