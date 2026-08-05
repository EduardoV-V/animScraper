// external-server.js — servidor HTTP pra gerar links de download
// temporários, usados por quem NÃO tem conta no anitsu (ex: amigos com
// quem você compartilha o celular via Tailscale).
//
// Como funciona: cada link tem um token aleatório, validade (TTL) e um
// número máximo de usos. Quando alguém abre o link, ESTE servidor busca o
// arquivo no anitsu usando a sessão já autenticada do bot (o cookie nunca
// é exposto a quem clicou) e repassa o conteúdo puro.
//
// Pensado pra ficar acessível só dentro da sua rede Tailscale — não expõe
// nada pra internet pública por si só (isso depende de você não fazer
// port-forward dessa porta pra fora).

const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const { ANITSU_BASE, getValidCookies, cookieHeader } = require("./session");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_USES = 3;

// token -> { remotePath, outName, expiresAt, usesLeft }
const links = new Map();

function createDownloadLink(remotePath, outName, { ttlMs = DEFAULT_TTL_MS, maxUses = DEFAULT_MAX_USES } = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  links.set(token, {
    remotePath,
    outName,
    expiresAt: Date.now() + ttlMs,
    usesLeft: maxUses,
  });
  return token;
}

function buildUrl(token) {
  const base = process.env.EXTERNAL_BASE_URL;
  if (!base) {
    throw new Error(
      "Defina EXTERNAL_BASE_URL no .env (ex: http://100.x.y.z:8787 — o IP " +
        "Tailscale deste celular, visível no app Tailscale)."
    );
  }
  return `${base.replace(/\/$/, "")}/dl/${token}`;
}

function cleanupExpired() {
  const now = Date.now();
  for (const [token, link] of links) {
    if (link.expiresAt < now || link.usesLeft <= 0) links.delete(token);
  }
}

async function handleDownload(req, res, token) {
  cleanupExpired();
  const link = links.get(token);

  if (!link) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Link inválido, expirado ou já usado o máximo de vezes.");
  }

  try {
    const cookies = await getValidCookies();
    const url = `${ANITSU_BASE}/api/download?path=${encodeURIComponent(link.remotePath)}`;

    const upstream = await axios.get(url, {
      headers: { Cookie: cookieHeader(cookies), "User-Agent": "Mozilla/5.0", Referer: ANITSU_BASE },
      responseType: "stream",
      timeout: 3600000,
      validateStatus: () => true,
    });

    if (upstream.status !== 200) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(`O anitsu recusou a requisição (status ${upstream.status}).`);
    }

    link.usesLeft -= 1;
    if (link.usesLeft <= 0) links.delete(token);

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(link.outName)}"`,
      ...(upstream.headers["content-length"]
        ? { "Content-Length": upstream.headers["content-length"] }
        : {}),
    });
    upstream.data.pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Erro interno: ${err.message}`);
  }
}

function startExternalServer(port = 8787) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/dl\/([a-f0-9]{32})$/);
    if (req.method === "GET" && match) {
      return handleDownload(req, res, match[1]);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Não encontrado.");
  });

  server.listen(port, () => {
    console.log(`Servidor de downloads externos ouvindo na porta ${port}.`);
  });

  return server;
}

module.exports = { startExternalServer, createDownloadLink, buildUrl };
