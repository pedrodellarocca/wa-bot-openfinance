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

        if (
          (mode.kind === "personal" || mode.kind === "shared") &&
          !cardNumber?.endsWith(mode.cardLast4)
        ) {
          continue;
        }

        const amount =
          mode.kind === "shared"
            ? Math.round(tx.amount * 50) / 100
            : tx.amount;

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
