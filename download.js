// download.js — baixa os arquivos selecionados usando aria2c (com fallback
// para axios stream caso aria2c não esteja instalado).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const { ANITSU_BASE, getValidCookies, cookieHeader } = require("./session");

function hasAria2() {
  const { status } = require("child_process").spawnSync("which", ["aria2c"]);
  return status === 0;
}

/**
 * files: [{ remotePath, outName }]
 * finalDir: diretório de destino (já deve existir)
 */
async function downloadAll(files, finalDir) {
  fs.mkdirSync(finalDir, { recursive: true });
  const cookies = await getValidCookies();
  const cookieHdr = cookieHeader(cookies);

  if (hasAria2()) {
    return downloadWithAria2(files, finalDir, cookieHdr);
  }
  console.log("aria2c não encontrado, baixando com axios (sequencial)...");
  return downloadWithAxios(files, finalDir, cookieHdr);
}

function downloadWithAria2(files, finalDir, cookieHdr) {
  const inputPath = path.join(finalDir, `.aria2-input-${Date.now()}.txt`);
  const lines = [];
  for (const f of files) {
    const url = `${ANITSU_BASE}/api/download?path=${encodeURIComponent(f.remotePath)}`;
    lines.push(url);
    lines.push(`  dir=${finalDir}`);
    lines.push(`  out=${f.outName}`);
  }
  fs.writeFileSync(inputPath, lines.join("\n"));

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
        "--max-connection-per-server=16",
        "--min-split-size=2M",
        "--split=16",
        "--max-concurrent-downloads=5",
        // "prealloc" pode ser bem lento em armazenamento acessado via
        // FUSE/SAF (ex: /storage/emulated/0 no Android/Termux) — "none"
        // evita essa alocação prévia e costuma ser bem mais rápido aí.
        "--file-allocation=none",
        "--continue=true",
        "--console-log-level=notice",
        "--summary-interval=30",
      ],
      { stdio: "inherit" }
    );

    proc.on("close", (code) => {
      fs.rmSync(inputPath, { force: true });
      if (code === 0) resolve();
      else reject(new Error(`aria2c saiu com código ${code}`));
    });
  });
}

async function downloadWithAxios(files, finalDir, cookieHdr) {
  for (const f of files) {
    const url = `${ANITSU_BASE}/api/download?path=${encodeURIComponent(f.remotePath)}`;
    const outPath = path.join(finalDir, f.outName);
    console.log(`Baixando: ${f.outName}`);

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

module.exports = { downloadAll };
