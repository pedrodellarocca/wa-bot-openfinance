# wa-bot-openfinance — contexto do projeto

Notas de contexto pra retomar trabalho em sessões futuras sem precisar redescobrir tudo. Ler este arquivo PRIMEIRO economiza muito token.

---

## O que o projeto é

Bot de WhatsApp pessoal de finanças. O usuário (Pedro) ou a noiva (Beatriz) mandam mensagens em PT-BR perguntando sobre fatura/gastos do cartão, e o bot busca os dados via Pluggy e responde com ajuda de uma LLM (OpenRouter, modelo `z-ai/glm-5.1`).

**Hospedado no Railway**, deploy automático ao push em `main`. Chromium roda no container (whatsapp-web.js usa Puppeteer).

## Stack

- TypeScript + Node 20 (ts-node em runtime, sem build prévio em prod — `package.json` "start" → `ts-node src/index.ts`)
- **whatsapp-web.js** (adapter `src/adapters/whatsapp-web/WhatsAppWebAdapter.ts`)
- **pluggy-sdk** (^0.85.2) — fala com `https://api.pluggy.ai`
- **openai** SDK apontando pra OpenRouter (`baseURL: https://openrouter.ai/api/v1`)
- **Prisma** + Postgres (Supabase) — `prisma/schema.prisma`
- bcrypt pra PIN
- qrcode pra servir o QR via HTTP (rota `/qr?token=...`)

## Layout

```
src/
  index.ts                                  bootstrap, monta adapter + ouve mensagens
  config.ts                                 zod-validated env vars
  qr-server.ts                              HTTP server pra QR (porta 8080)
  db/prisma.ts                              singleton PrismaClient
  core/
    orchestrator.ts                         autenticação por PIN + dispatch pra LLM
    ports/IMessagingProvider.ts             porta abstrata (hex arch)
  adapters/whatsapp-web/                    impl whatsapp-web.js da porta
  services/
    pluggy.ts                               getCardTransactions(itemId, FetchMode)
    llm.ts                                  processMessage(phone, body, user) com tool buscar_fatura
prisma/schema.prisma                        User + MessageHistory
scripts/
  setup-pluggy.ts                           widget Pluggy Connect local pra obter itemId
  seed-user.ts                              upsert das 2 linhas iniciais
  reset-sessions.ts                         zera sessionExpiresAt
docs/superpowers/{specs,plans}/             específicos da brainstorming/writing-plans
```

## Arquitetura do fluxo

```
WA msg → IMessagingProvider → handleMessage(orchestrator)
                              ├─ findUser(by whatsappId)
                              ├─ if !sessionActive: PIN flow
                              └─ processMessage(phone, body, user)
                                  ├─ messageHistory load (last 10)
                                  ├─ buildSystemPrompt(user)        ← per-role
                                  ├─ openai.chat.completions (tool: buscar_fatura)
                                  └─ executeBuscarFatura(args, user)
                                      └─ getCardTransactions(itemId, FetchMode)
                                          └─ Pluggy SDK (fetchAccounts CREDIT, fetchTransactions)
```

## Modelo `User` (atual)

```prisma
model User {
  id               String    @id @default(cuid())
  phone            String    @unique
  whatsappId       String?   @unique
  itemId           String                       // Pluggy item id
  cardLast4        String                       // cartão pessoal (não usado pra admin)
  sharedCardLast4  String?                      // cartão compartilhado
  isAdmin          Boolean   @default(false)    // pula filtros e disambiguation
  pinHash          String
  sessionExpiresAt DateTime?
  createdAt        DateTime  @default(now())
}
```

Atualmente:
| phone (whatsappId) | papel | cardLast4 | sharedCardLast4 | isAdmin |
|---|---|---|---|---|
| 5548984516922 | Pedro | 8634 | NULL | true |
| 5548984678502 | Beatriz | 9425 | 0114 | false |

`itemId` (ambos): `c250ae1b-976d-4bd2-8eff-02403d82e52f` (conector **MeuPluggy** id 200).

## Comportamento por role

### Pedro (admin)
System prompt diz: "use `cartao: 'todos'` sempre, nunca pergunte qual cartão". Tool retorna `{cartao: "todos", total, transacoes}` — todas as transações do mês na conta de crédito C6, sem filtro.

### Beatriz (restricted)
System prompt diz: "tem 2 cartões: pessoal 9425 e compartilhado 0114; quando ambíguo pergunta primeiro 'da sua ou da compartilhada?'; quando compartilhado os valores vêm pré-divididos por 2".

Tool result varia:
- `cartao: "pessoal"` → `{cartao, total, transacoes}` (sem split)
- `cartao: "compartilhado"` → `{cartao, total_bruto, sua_parte, transacoes}` (`total_bruto = 2 × sua_parte`, ambos arredondados a centavos no aggregate; per-tx amount já vem como `tx.amount/2` sem rounding)
- `cartao: "todos"` → bloqueado em runtime (defesa em profundidade) com `error` claro

## Pluggy — gotchas críticas

1. **`meu.pluggy.ai` ≠ produto separado.** É o mesmo ecossistema da Pluggy. Os items conectados lá são lidos via `api.pluggy.ai` com as credenciais da "demo application" do `dashboard.pluggy.ai` (mesmo login). A "API" anunciada na home do meu.pluggy.ai aponta pro dashboard.

2. **Trial mata `Connect widget` pra banco real.** Dashboard em trial → `TRIAL_CLIENT_ITEM_CREATE_NOT_ALLOWED` ao tentar conectar banco real via widget. Solução: conectar pelo meu.pluggy.ai (não passa pelo widget). O item gerado fica visível pelas creds da app trial.

3. **Conector "MeuPluggy" (id 200).** Connector especial que é a ponte com meu.pluggy.ai. Tem `oauth: true`, `isSandbox: false`. Os accounts/transações refletem todos os bancos conectados via meu.pluggy.ai.

4. **`creditCardMetadata.cardNumber` é o cartão FÍSICO usado, não o "principal".** O C6 BANDEIRADO tem 14 cartões físicos vinculados (`additionalCards`). Filtros devem usar `endsWith(cardLast4)` — strict equality também funciona se a Pluggy retornar bare last-4, mas `endsWith` é defensivo caso eles passem pra mascarar.

5. **`GET /items` retorna 401 em apps trial.** Workaround: usar `GET /items/{id}` (pega 1 item específico) ou `GET /accounts?itemId={id}` que funcionam.

6. **API key da Pluggy é JWT com TTL curto.** SDK auto-refresha via `isJwtExpired`, mas tem cache module-level — se rodar múltiplas instâncias, cada uma tem seu cache.

## Rota de setup pra novo banco/usuário

1. No `meu.pluggy.ai` o usuário conecta o banco (UI da Pluggy, com OAuth/credenciais).
2. Pega `itemId` via `GET https://api.pluggy.ai/items/{id}` ou direto na UI do dashboard.
3. Atualiza `User.itemId` no Supabase.
4. Próxima mensagem WhatsApp já usa o item novo (Prisma reconsulta a cada msg, sem cache).

`scripts/setup-pluggy.ts` ainda existe mas só serve pra apps já com production access (em trial dá erro). Está com `includeSandbox: false`, `countries: ['BR']`, `connectorTypes: ['PERSONAL_BANK']` pra evitar tropeçar no Pluggy Bank sandbox.

## Operação e deploy

- **Push pra `main`** = deploy automático no Railway. Sem CI gates.
- **Sem testes automatizados.** Verificação é tsc + manual no WhatsApp.
- **Migrações Prisma:** `npx prisma db push` local não funciona (DATABASE_URL no .env tem placeholders). Sempre rodar SQL manual no Supabase SQL Editor antes de pushar código que dependa de novas colunas, senão Prisma joga `P2022`.
- **Logs no Railway** podem cortar mensagens longas (visto: stack traces de `PrismaClientKnownRequestError` ficam ilegíveis). Quando precisar do erro completo, adicionar `console.error` específico.
- **Env vars no Railway são frágeis pra whitespace.** Já aconteceu: `PLUGGY_CLIENT_SECRET` colado com 3 chars extras → 401 em produção apesar de id/secret "iguais" ao local. Diagnóstico: logar `process.env.X.length` e `slice(-4)`. Fix: re-paste limpo.

## Histórico recente (commits no branch `worktree-multi-card-user-roles` mergeado em main)

```
6a54bb3 chore(debug): log credential fingerprint and full error  ← debug temporário, REMOVER
15e1926 fix(rounding): aggregate-then-round for shared card
2e70f6a fix: address code review on multi-card feature
9222c2b feat: per-user roles and shared-card split for fatura
ab15ab9 docs: spec + plan for multi-card user roles
9556291 chore(setup-pluggy): hide sandbox connectors
b172445 fix: clear stale Chromium SingletonLock on boot
```

Spec/plan da feature: `docs/superpowers/specs/2026-05-05-multi-card-user-roles-design.md` e `docs/superpowers/plans/2026-05-05-multi-card-user-roles.md`.

## Status atual (final da sessão)

✅ Pedro (admin) testado em prod — bot retorna fatura completa do C6 com transações reais, sem disambiguation.

⏳ Beatriz (restricted) **ainda não testada** end-to-end no WhatsApp. Lógica está no código + DB tá com `cardLast4=9425` + `sharedCardLast4=0114`, mas falta validar:
1. Bot pergunta "da sua ou da compartilhada?" quando ela manda algo ambíguo
2. Bot retorna apenas transações do `9425` quando responde "minha"
3. Bot retorna `total_bruto + sua_parte` quando responde "compartilhada"

## Próximos passos sugeridos (em ordem de prioridade)

1. **Reverter o commit de debug `6a54bb3`** — os `console.log` em `pluggy.ts:48-54` e `console.error` em `llm.ts:200` foram instrumentação temporária pra achar o bug do whitespace. Depois de confirmado, remover. Sugestão: `git revert 6a54bb3 --no-edit && git push origin HEAD:main`. Ou edição inline que tira só os logs e mantém o resto.

2. **Validar fluxo da Beatriz no WhatsApp** — ela precisa estar em sessão (PIN ativo). Mandar "quanto está a fatura?" e confirmar os 3 cenários (ambíguo, compartilhada, minha). Se algo escorregar, provavelmente é tweak no system prompt em `services/llm.ts:32-56`.

3. **Limpar `MessageHistory` periodicamente** — o LLM lê os últimos 10 turns. Quando o bot tem um período "ruim" (alucinando, ou Pluggy down), o histórico contamina respostas futuras mesmo após o problema resolver. Considerar: TTL no `MessageHistory` (ex: deletar entries > 24h) ou comando `/limpar` que zere histórico do user.

4. **Endurecer o tratamento de erro do Pluggy** — hoje qualquer 401/500/timeout chega ao LLM como `{error: "..."}`, e a LLM gera respostas ligeiramente diferentes a cada vez. Mapear códigos comuns (`401` → "reconectar no meu.pluggy.ai"; timeout → "tenta de novo") em texto fixo.

5. **Fixar estrutura JSON do tool result** (Code Review apontou) — `cartao: "todos"`/`"pessoal"` retornam `{total, transacoes}`, `"compartilhado"` retorna `{total_bruto, sua_parte, transacoes}`. LLM tem que aprender 2 formatos. Padronizar incluindo sempre `total_bruto` e opcionalmente `sua_parte`.

6. **Schema: nomes hardcoded no system prompt** — "Pedro", "Beatriz", "noivo Pedro" estão dentro de `buildSystemPrompt` em `services/llm.ts:36-56`. Se quiser permitir mais usuários sem deploy, adicionar `displayName String` e `partnerName String?` em `User`, e interpolar.

7. **Item refresh manual** — eventualmente a conexão MeuPluggy expira (`status: LOGIN_ERROR`). Hoje o usuário tem que abrir meu.pluggy.ai e reautenticar manualmente. Considerar: comando WhatsApp tipo `/reconectar` que retorna o link `meu.pluggy.ai` + instruções.

8. **Trial → Production no Pluggy** — dashboard mostrava "14 dias remaining". Quando expirar, validar se a leitura via MeuPluggy connector continua funcionando. Se não, completar Due Diligence ou achar workaround.

## Como retomar uma sessão

Quando abrir uma sessão nova (Claude Code) pra trabalhar nesse repo:
1. Mandar "leia `.claude/PROJECT_CONTEXT.md`" como primeira instrução, OU
2. Anexar este arquivo no input inicial.

Isso evita rebuscar arquitetura, gotchas da Pluggy, e estado dos usuários.
