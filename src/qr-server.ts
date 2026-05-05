import http from "http";
import crypto from "crypto";
import QRCode from "qrcode";

interface QrStatus {
  ready: boolean;
  qr: string | null;
}

export function startQrServer(getStatus: () => QrStatus): void {
  const port = Number(process.env.PORT) || 3000;
  const token = process.env.QR_TOKEN || crypto.randomBytes(8).toString("hex");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname !== "/qr" && url.pathname !== "/qr.png" && url.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("token") !== token) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }

      const status = getStatus();

      if (url.pathname === "/qr.png") {
        if (!status.qr) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("No QR available");
          return;
        }
        const buf = await QRCode.toBuffer(status.qr, { width: 400, margin: 2 });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(buf);
        return;
      }

      const body = status.ready
        ? `<h1>WhatsApp conectado</h1>`
        : status.qr
          ? `<img src="/qr.png?token=${token}&t=${Date.now()}" alt="QR Code" /><p>Atualiza automaticamente a cada 5s.</p>`
          : `<p>Aguardando QR Code... a página recarrega sozinha.</p>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>WhatsApp QR</title><style>body{font-family:sans-serif;text-align:center;padding:24px;background:#111;color:#eee}img{background:#fff;padding:8px;border-radius:8px;max-width:90vw}</style></head><body>${body}</body></html>`,
      );
    } catch (err) {
      console.error("[qr-server] error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  });

  server.listen(port, () => {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    const base = domain ? `https://${domain}` : `http://localhost:${port}`;
    console.log(`[qr-server] escutando na porta ${port}`);
    console.log(`[qr-server] abra: ${base}/qr?token=${token}`);
  });
}
