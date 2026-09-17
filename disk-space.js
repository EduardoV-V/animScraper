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

module.exports = {
  getFreeBytes,
  totalSize,
  humanBytes,
  pickDirWithSpace,
  assertHasSpace,
  SAFETY_MARGIN_BYTES,
};
