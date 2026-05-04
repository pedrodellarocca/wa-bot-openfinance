import { PluggyClient } from "pluggy-sdk";
import { config } from "../config";

export interface Transaction {
  description: string;
  amount: number;
  date: string;
  category: string | null;
}

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
  cardLast4: string
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

    const allTransactions: Transaction[] = [];

    for (const account of accounts.results) {
      const txResponse = await pluggy.fetchTransactions(account.id, {
        from: startOfMonth(),
        to: today(),
      });

      const filtered = txResponse.results.filter((tx) =>
        tx.creditCardMetadata?.cardNumber?.endsWith(cardLast4)
      );

      allTransactions.push(
        ...filtered.map((tx) => ({
          description: tx.description,
          amount: tx.amount,
          date: tx.date.toISOString().split("T")[0],
          category: tx.category,
        }))
      );
    }

    return allTransactions;
  })();

  return Promise.race([fetchPromise, timeoutPromise]);
}
