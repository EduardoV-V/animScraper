// disk-space.js — escolhe automaticamente o diretório de destino entre
// vários candidatos (dando preferência ao cartão SD, que deve encher
// primeiro) e confere se há espaço livre suficiente antes de baixar.
//
// Usa `df` (já disponível no Termux e em qualquer Linux) em vez de
// depender de alguma lib nativa do Node, que costuma dar problema pra
// compilar em ambiente Termux/Android.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Margem além do tamanho exato dos arquivos — sobra espaço pro sistema,
// pros arquivos temporários do aria2 (.aria2) e evita cortar em cima da
// hora por causa de arredondamento de tamanho reportado pela API.
const SAFETY_MARGIN_BYTES = 512 * 1024 * 1024; // 512MB

/** Sobe os diretórios até achar um que já existe, pra poder rodar `df`
 * mesmo quando o diretório final (ex: .../Nome/Season 1) ainda não foi
 * criado. */
function nearestExistingAncestor(dirPath) {
  let current = path.resolve(dirPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break; // chegou na raiz sem achar nada
    current = parent;
  }
  return current;
}

/** Espaço livre (em bytes) no volume que contém dirPath. */
function getFreeBytes(dirPath) {
  const target = nearestExistingAncestor(dirPath);
  let output;
  try {
    // -P: formato POSIX estável entre versões do df; -k: blocos de 1024 bytes
    output = execFileSync("df", ["-Pk", target], { encoding: "utf8" });
  } catch (err) {
    throw new Error(`Falha ao rodar 'df' em ${target}: ${err.message}`);
  }
  const lines = output.trim().split("\n");
  const dataLine = lines[lines.length - 1]; // última linha = dados (ignora cabeçalho)
  const cols = dataLine.trim().split(/\s+/);
  // Filesystem  1024-blocks  Used  Available  Use%  Mounted-on
  const availableKB = parseInt(cols[3], 10);
  if (Number.isNaN(availableKB)) {
    throw new Error(`Não foi possível ler o espaço livre em ${target} (saída inesperada do df).`);
  }
  return availableKB * 1024;
}

/** Soma o tamanho esperado de uma lista de arquivos (mesmo formato usado
 * em download.js: { size }). Arquivos sem tamanho conhecido contam como 0
 * — nesse caso a checagem ainda roda, só que sem a margem daquele arquivo. */
function totalSize(files) {
  return (files || []).reduce((sum, f) => sum + (f.size || 0), 0);
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

/**
 * Escolhe o primeiro diretório de `candidates` (em ordem de prioridade)
 * que tenha espaço livre suficiente para `requiredBytes`. Usado pra dar
 * preferência ao cartão SD: passe o SD primeiro na lista.
 *
 * Lança erro (com mensagem pronta pra mostrar ao usuário) se nenhum
 * candidato tiver espaço.
 */
function pickDirWithSpace(candidates, requiredBytes, label = "download") {
  const needed = requiredBytes + SAFETY_MARGIN_BYTES;
  const checked = [];

  for (const dir of candidates) {
    let free;
    try {
      free = getFreeBytes(dir);
    } catch (err) {
      checked.push(`${dir} → erro ao checar (${err.message})`);
      continue;
    }
    if (free >= needed) {
      return dir;
    }
    checked.push(`${dir} → livre: ${humanBytes(free)}`);
  }

  throw new Error(
    `Espaço insuficiente para "${label}" (necessário ~${humanBytes(needed)} incluindo margem de segurança). ` +
      `Nenhum destino disponível tem espaço:\n` +
      checked.map((c) => `  • ${c}`).join("\n")
  );
}

/** Confere se um diretório específico (ex: caminho digitado manualmente)
 * tem espaço suficiente. Lança erro se não tiver. */
function assertHasSpace(dir, requiredBytes, label = "download") {
  const needed = requiredBytes + SAFETY_MARGIN_BYTES;
  const free = getFreeBytes(dir);
  if (free < needed) {
    throw new Error(
      `Espaço insuficiente em ${dir} para "${label}" ` +
        `(necessário ~${humanBytes(needed)} incluindo margem de segurança, livre ${humanBytes(free)}).`
    );
  }
}

// ------------------------------------------------------------------
// Retomar download já iniciado antes (ex: faltou espaço no meio de um
// download anterior e sobraram episódios pra baixar).
// ------------------------------------------------------------------

/**
 * Procura, em cada `baseDirs` (na mesma ordem de prioridade usada pelo
 * pickDirWithSpace — SD primeiro), se já existe uma pasta em
 * `<base>/<subPath>`. Devolve o caminho completo da primeira que existir,
 * ou null se essa combinação (anime/temporada) nunca foi baixada em
 * nenhum dos destinos.
 */
function findExistingDestination(baseDirs, subPath) {
  for (const base of baseDirs) {
    const candidate = path.join(base, subPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Bytes já presentes em disco pra um arquivo de saída específico dentro
 * de `dir` (0 se ainda não existe). */
function bytesOnDisk(dir, outName) {
  try {
    return fs.statSync(path.join(dir, outName)).size;
  } catch {
    return 0;
  }
}

/**
 * Quanto ainda falta baixar, em bytes, considerando o que já está em
 * disco em `dir` pra cada arquivo (mesmo formato usado em download.js:
 * { outName, size }). Arquivo já completo (ou o aria2 vai só confirmar
 * isso rapidinho) conta 0; arquivo parcial conta só o restante; arquivo
 * sem `size` conhecido conta 0 (não dá pra saber quanto falta).
 */
function remainingBytes(files, dir) {
  return (files || []).reduce((sum, f) => {
    const expected = f.size || 0;
    if (!expected) return sum;
    const onDisk = bytesOnDisk(dir, f.outName);
    return sum + Math.max(0, expected - onDisk);
  }, 0);
}

// ------------------------------------------------------------------
// Mountpoint de rede (ex: sshfs) — precisa confirmar que está ativo
// antes de usá-lo, já que pode cair a qualquer momento (perda de rede,
// SSH derrubado etc).
// ------------------------------------------------------------------

const MOUNT_CHECK_TTL_MS = 30 * 1000; // evita rechecar várias vezes no mesmo fluxo de download
const mountAliveCache = new Map(); // mountPath -> { alive, checkedAt }

/**
 * Confere se `mountPath` está montado e respondendo, rodando `df` nele
 * com timeout (a própria opção `timeout` do execFileSync mata o
 * processo se travar — importante pra sshfs, que em vez de dar erro na
 * hora pode simplesmente travar a chamada se a rede cair no meio).
 * `df` com sucesso já confirma as duas coisas de uma vez: que tem algo
 * montado ali E que está respondendo (não só "a pasta existe").
 *
 * Resultado cacheado por MOUNT_CHECK_TTL_MS — não faz sentido rechecar a
 * cada etapa do mesmo fluxo de download (busca -> seleção -> destino).
 */
function isMountAlive(mountPath, { timeoutMs = 4000, useCache = true } = {}) {
  if (useCache) {
    const cached = mountAliveCache.get(mountPath);
    if (cached && Date.now() - cached.checkedAt < MOUNT_CHECK_TTL_MS) {
      return cached.alive;
    }
  }

  let alive;
  try {
    execFileSync("df", ["-Pk", mountPath], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"], // não deixa o erro do df (esperado quando o mount tá fora do ar) poluir o log
    });
    alive = true;
  } catch {
    alive = false;
  }

  mountAliveCache.set(mountPath, { alive, checkedAt: Date.now() });
  return alive;
}

module.exports = {
  getFreeBytes,
  totalSize,
  humanBytes,
  pickDirWithSpace,
  assertHasSpace,
  findExistingDestination,
  remainingBytes,
  isMountAlive,
  SAFETY_MARGIN_BYTES,
};
