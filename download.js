// download.js — fila de downloads via aria2c (com fallback axios), com:
//
//  1) aria2c rodando DESACOPLADO do terminal de controle (detached: true).
//     Isso é importante: se o terminal/SSH que iniciou o bot cair, o sinal
//     de desconexão (SIGHUP) é enviado pro grupo de processos inteiro —
//     sem "detached", o aria2c herda esse grupo e morre junto (é exatamente
//     o "Emergency shutdown sequence" que aparece nos logs quando isso
//     acontece; não tem relação com cookie/sessão expirada).
//  2) Fila real: um job por vez baixa de fato; os demais esperam. Consulte
//     o estado com getStatus().
//  3) Sessão é revalidada (getValidCookies) no INÍCIO de cada job da fila —
//     então mesmo que o cookie expire entre um job e outro, o próximo já
//     começa com um cookie fresco. Renovação NO MEIO de um download em
//     andamento não é tratada (o aria2c já está com os headers antigos);
//     na prática isso não deveria acontecer porque cada job já garante
//     sessão válida antes de começar.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const axios = require("axios");
const { ANITSU_BASE, getValidCookies, cookieHeader } = require("./session");

function hasAria2() {
  const { status } = spawnSync("which", ["aria2c"]);
  return status === 0;
}

// ------------------------------------------------------------------
// Fila
// ------------------------------------------------------------------

const events = new EventEmitter();
const queue = [];
let current = null;
let nextId = 1;

/**
 * files: [{ remotePath, outName, size }]  (size em bytes, opcional — só
 *   é usado pra calcular % de progresso; sem ele o status mostra só
 *   "baixando", sem percentual)
 * finalDir: diretório de destino
 * meta: { label, chatId } — usados pra identificar o job no /status e
 *   pra saber pra quem mandar o aviso de conclusão/erro
 */
function enqueueDownload(files, finalDir, meta = {}) {
  const job = {
    id: nextId++,
    files,
    finalDir,
    label: meta.label || path.basename(finalDir),
    chatId: meta.chatId || null,
    status: "queued",
    error: null,
    createdAt: Date.now(),
    startedAt: null,
  };
  queue.push(job);
  events.emit("queued", job);
  maybeStartNext();
  return job;
}

function maybeStartNext() {
  if (current || queue.length === 0) return;
  current = queue.shift();
  runJob(current).finally(() => {
    current = null;
    maybeStartNext();
  });
}

async function runJob(job) {
  job.status = "downloading";
  job.startedAt = Date.now();
  events.emit("started", job);

  try {
    fs.mkdirSync(job.finalDir, { recursive: true });
    // Revalida/renova a sessão no início DESTE job específico — garante
    // que cada download da fila começa com cookie fresco, mesmo que o
    // anterior tenha demorado o suficiente pro cookie expirar entre eles.
    const cookies = await getValidCookies();
    const cookieHdr = cookieHeader(cookies);

    if (hasAria2()) {
      await runAria2Job(job, cookieHdr);
    } else {
      await runAxiosJob(job, cookieHdr);
    }

    job.status = "done";
    events.emit("done", job);
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    events.emit("error", job, err);
  }
}

function runAria2Job(job, cookieHdr) {
  const inputPath = path.join(job.finalDir, `.aria2-input-${job.id}.txt`);
  const logPath = path.join(job.finalDir, `.aria2-log-${job.id}.txt`);

  const lines = [];
  for (const f of job.files) {
    const url = `${ANITSU_BASE}/api/download?path=${encodeURIComponent(f.remotePath)}`;
    lines.push(url);
    lines.push(`  dir=${job.finalDir}`);
    lines.push(`  out=${f.outName}`);
  }
  fs.writeFileSync(inputPath, lines.join("\n"));

  const logFd = fs.openSync(logPath, "a");

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "aria2c",
      [
        `--input-file=${inputPath}`,
        `--header=Cookie: ${cookieHdr}`,
        "--header=User-Agent: Mozilla/5.0",
        `--header=Referer: ${ANITSU_BASE}`,
        "--check-certificate=false",
        "--max-tries=5",
        "--retry-wait=3",
        "--timeout=60",
        "--connect-timeout=30",
        // Como só roda 1 job por vez (a fila garante isso), dá pra ser
        // mais agressivo com paralelismo sem o risco de somar conexões
        // de vários downloads simultâneos.
        "--max-connection-per-server=16",
        "--min-split-size=2M",
        "--split=16",
        "--max-concurrent-downloads=5",
        // Pré-aloca o espaço em disco pro tamanho final do arquivo antes
        // de começar a escrever — evita fragmentação e realocações
        // durante o download.
        "--file-allocation=prealloc",
        "--continue=true",
        "--console-log-level=notice",
        "--summary-interval=10",
      ],
      {
        // Processo próprio, fora do grupo/terminal de controle do
        // processo pai — não recebe SIGHUP/SIGINT do terminal que
        // iniciou o bot (essa era a causa do "Emergency shutdown").
        detached: true,
        stdio: ["ignore", logFd, logFd],
      }
    );

    // Não seguramos o event loop do Node esperando esse processo morrer
    // por conta própria — só nos importa o evento "close" pra saber
    // quando terminou.
    proc.unref();

    proc.on("error", (err) => {
      fs.closeSync(logFd);
      reject(err);
    });

    proc.on("close", (code) => {
      fs.closeSync(logFd);
      fs.rmSync(inputPath, { force: true });
      fs.rmSync(logPath, { force: true });
      if (code === 0) resolve();
      else reject(new Error(`aria2c saiu com código ${code} (veja ${logPath} se ainda existir)`));
    });
  });
}

async function runAxiosJob(job, cookieHdr) {
  for (const f of job.files) {
    const url = `${ANITSU_BASE}/api/download?path=${encodeURIComponent(f.remotePath)}`;
    const outPath = path.join(job.finalDir, f.outName);

    const res = await axios.get(url, {
      headers: { Cookie: cookieHdr, "User-Agent": "Mozilla/5.0", Referer: ANITSU_BASE },
      responseType: "stream",
      timeout: 3600000,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outPath);
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  }
}

// ------------------------------------------------------------------
// Status / progresso
// ------------------------------------------------------------------

/** % baixado de um job, calculado olhando o tamanho atual dos arquivos no
 * disco vs o tamanho esperado (se conhecido). Retorna null se não tiver
 * tamanho esperado pra comparar. */
function computeProgressPercent(job) {
  const totalExpected = job.files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (!totalExpected) return null;

  let totalOnDisk = 0;
  for (const f of job.files) {
    const p = path.join(job.finalDir, f.outName);
    try {
      totalOnDisk += fs.statSync(p).size;
    } catch {
      // arquivo ainda não existe / não começou
    }
  }
  return Math.min(100, Math.round((totalOnDisk / totalExpected) * 100));
}

function summarize(job) {
  return {
    id: job.id,
    label: job.label,
    fileCount: job.files.length,
    status: job.status,
    progressPercent: job.status === "downloading" ? computeProgressPercent(job) : null,
  };
}

function getStatus() {
  return {
    current: current ? summarize(current) : null,
    queued: queue.map(summarize),
  };
}

// ------------------------------------------------------------------
// Compat: uso "bloqueante" (CLI) — enfileira e espera esse job específico
// ------------------------------------------------------------------

function waitForJob(job) {
  return new Promise((resolve, reject) => {
    const onDone = (j) => {
      if (j.id !== job.id) return;
      cleanup();
      resolve();
    };
    const onError = (j, err) => {
      if (j.id !== job.id) return;
      cleanup();
      reject(err);
    };
    function cleanup() {
      events.off("done", onDone);
      events.off("error", onError);
    }
    events.on("done", onDone);
    events.on("error", onError);
  });
}

async function downloadAllAndWait(files, finalDir, meta) {
  const job = enqueueDownload(files, finalDir, meta);
  await waitForJob(job);
}

module.exports = {
  events,
  enqueueDownload,
  waitForJob,
  downloadAllAndWait,
  getStatus,
};
