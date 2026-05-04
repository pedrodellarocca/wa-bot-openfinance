/**
 * Script de setup único para conectar o C6 Bank na Pluggy e obter o itemId.
 * Execute com: npx ts-node scripts/setup-pluggy.ts
 *
 * O que faz:
 * 1. Gera um Connect Token via Pluggy SDK
 * 2. Sobe um servidor local na porta 3333
 * 3. Abre o browser com o widget da Pluggy
 * 4. Após você logar no C6 Bank, exibe o itemId na tela
 */

import "dotenv/config";
import http from "http";
import { exec } from "child_process";
import { PluggyClient } from "pluggy-sdk";

const PORT = 3333;

async function main() {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no arquivo .env");
    process.exit(1);
  }

  console.log("🔑 Gerando Connect Token na Pluggy...");
  const pluggy = new PluggyClient({ clientId, clientSecret });
  const { accessToken } = await pluggy.createConnectToken();
  console.log("✅ Connect Token gerado com sucesso.");

  const html = buildHtml(accessToken);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🌐 Abrindo o browser em ${url}`);
    console.log("   → Selecione o C6 Bank e faça o login.");
    console.log("   → Após conectar, o itemId aparecerá na tela — copie-o!\n");
    openBrowser(url);
  });
}

function openBrowser(url: string) {
  const commands: Record<string, string> = {
    win32: `start "" "${url}"`,
    darwin: `open "${url}"`,
    linux: `xdg-open "${url}"`,
  };
  const cmd = commands[process.platform] ?? commands.linux;
  exec(cmd);
}

function buildHtml(connectToken: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Setup Pluggy — OpenFinance Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #1e293b;
      border-radius: 16px;
      padding: 2.5rem;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
    }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: #f8fafc; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem; }
    button {
      background: #6366f1;
      color: white;
      border: none;
      padding: 0.85rem 2rem;
      border-radius: 10px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    button:hover { background: #4f46e5; }
    .result {
      display: none;
      margin-top: 1.5rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 1.25rem;
    }
    .result h2 { font-size: 1rem; color: #4ade80; margin-bottom: 0.5rem; }
    .result p { color: #94a3b8; margin-bottom: 0.75rem; font-size: 0.875rem; }
    .item-id {
      font-family: monospace;
      font-size: 0.9rem;
      background: #1e293b;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      word-break: break-all;
      color: #fbbf24;
      border: 1px solid #44403c;
    }
    .steps {
      margin-top: 1rem;
      padding: 1rem;
      background: #172033;
      border-radius: 8px;
      font-size: 0.8rem;
      color: #64748b;
      line-height: 1.8;
    }
    .steps code {
      background: #0f172a;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      color: #93c5fd;
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔗 Conectar C6 Bank na Pluggy</h1>
    <p>Clique no botão abaixo para abrir o widget da Pluggy, selecione o <strong>C6 Bank</strong> e faça login com suas credenciais.</p>
    <button id="btn-connect">Conectar minha conta no C6 Bank</button>

    <div class="result" id="result">
      <h2>✅ Conexão realizada com sucesso!</h2>
      <p>Copie o <strong>Item ID</strong> abaixo e salve no banco de dados (tabela <code>User</code>):</p>
      <div class="item-id" id="item-id-value"></div>
      <div class="steps">
        <strong>Próximos passos:</strong><br/>
        1. Rode <code>npm run db:studio</code> no terminal<br/>
        2. Abra a tabela <code>User</code> e crie um novo registro:<br/>
        &nbsp;&nbsp;&nbsp;• <code>phone</code>: número sem + (ex: 5511999999999)<br/>
        &nbsp;&nbsp;&nbsp;• <code>itemId</code>: o ID acima<br/>
        &nbsp;&nbsp;&nbsp;• <code>cardLast4</code>: 4 últimos dígitos do cartão<br/>
        3. Rode <code>npm run dev</code> e escaneie o QR Code
      </div>
    </div>
  </div>

  <script src="https://cdn.pluggy.ai/pluggy-connect/v2.0/pluggy-connect.js"></script>
  <script>
    document.getElementById('btn-connect').addEventListener('click', function () {
      const pluggyConnect = new PluggyConnect({
        connectToken: "${connectToken}",
        onSuccess: function (data) {
          const itemId = data.item.id;
          document.getElementById('item-id-value').textContent = itemId;
          document.getElementById('result').style.display = 'block';
          document.getElementById('btn-connect').textContent = '✅ Conectado!';
          document.getElementById('btn-connect').disabled = true;
        },
        onError: function (error) {
          alert('Erro ao conectar: ' + (error.message || JSON.stringify(error)));
        },
        onClose: function () {
          console.log('Widget fechado');
        }
      });
      pluggyConnect.init();
    });
  </script>
</body>
</html>`;
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
