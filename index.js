#!/usr/bin/env node
// index.js — CLI interativo.
//
// Fluxo replicado do script bash original:
//   pesquisar -> escolher resultado -> navegar pastas -> selecionar .mkv(s)
//   -> escolher destino -> baixar com aria2.
//
// As funções principais (searchAndBrowse, chooseAndDownload) ficam expostas
// para reuso futuro por um bot de mensagens (ex: Telegram), sem precisar
// depender do readline abaixo.

const path = require("path");
const readline = require("readline");
const { search, listFiles } = require("./api");
const { downloadAll } = require("./download");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function humanSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

// Categorias de busca que a gente considera "conteúdo de vídeo" e mantém
// na lista. Ajuste aqui se quiser incluir Mangás, Filmes etc de novo.
const ALLOWED_CATEGORIES = ["Animes"];

function classify(itemPath) {
  if (itemPath.startsWith("Animes/")) return "ANIME";
  if (itemPath.startsWith("Mangás/")) return "MANGÁ";
  return "DESCONHECIDO";
}

async function pickSearchResult(query) {
  const data = await search(query);
  const allResults = data.results || [];

  const results = allResults.filter((r) => {
    const type = classify(r.path);
    if (!ALLOWED_CATEGORIES.includes(r.path.split("/")[0])) return false;
    // Se a API informar is_directory, garante que só pastas passem.
    if (r.is_directory === false) return false;
    return type !== "DESCONHECIDO";
  });

  if (results.length === 0) {
    console.log("Nenhum resultado encontrado.");
    return null;
  }

  console.log("\nResultados encontrados:");
  results.forEach((r, i) => {
    console.log(`[${i + 1}] [${classify(r.path)}] ${r.name}`);
  });

  const choice = await ask("\nEscolha uma opção: ");
  const idx = parseInt(choice, 10) - 1;
  return results[idx] ? results[idx].path : null;
}

// Extensões de vídeo que o navegador de pastas reconhece como "arquivo
// baixável". Ajuste aqui se quiser incluir mais formatos.
const VIDEO_EXTENSIONS = /\.?(mkv|mp4|avi)$/i;

/** Navega pelas pastas remotas até o usuário escolher baixar os vídeos de um diretório. */
async function browseFiles(rootPath) {
  let currentPath = rootPath;

  while (true) {
    const data = await listFiles(currentPath);
    const files = data.files || [];
    const videos = files.filter((f) => !f.is_directory && VIDEO_EXTENSIONS.test(f.extension || ""));

    console.log(`\nDiretório remoto: ${currentPath}`);
    console.log(
      videos.length > 0
        ? "Comandos: [b] voltar | [r] início | [d] baixar vídeos | [q] sair"
        : "Comandos: [b] voltar | [r] início | [q] sair"
    );
    console.log("----------------------------------------");

    files.forEach((f, i) => {
      if (f.is_directory) {
        console.log(`[${i + 1}] ${f.name}/`);
      } else {
        console.log(`[${i + 1}] ${f.name} (${humanSize(f.size)})`);
      }
    });

    const choice = (await ask("\nEscolha: ")).trim();

    if (choice === "q") return null;
    if (choice === "r") {
      currentPath = rootPath;
      continue;
    }
    if (choice === "d" && videos.length > 0) {
      return { targetPath: currentPath, mkvs: videos };
    }
    if (choice === "b") {
      if (data.parent) currentPath = data.parent;
      continue;
    }

    const idx = parseInt(choice, 10) - 1;
    const target = files[idx];
    if (!target) continue;

    if (target.is_directory) {
      currentPath = `${currentPath}/${target.name}`;
    } else {
      console.log(`(Arquivo único selecionado: ${target.name})`);
      return { targetPath: currentPath, mkvs: [target] };
    }
  }
}

async function chooseDestination(padrao) {
  console.log("\n[1] Animes\n[2] Filmes\n[3] Digitar caminho manual");
  const dest = await ask("Destino: ");

  let baseDir, isAnime = false;
  if (dest === "1") {
    baseDir = "/mnt/e/Animes";
    isAnime = true;
  } else if (dest === "2") {
    baseDir = "/mnt/e/Filmes";
  } else if (dest === "3") {
    baseDir = (await ask("Diretório base: ")).replace(/^~/, process.env.HOME || "");
  } else {
    throw new Error("Opção inválida.");
  }

  let season = null;
  let finalDir;
  if (isAnime) {
    season = await ask("Temporada: ");
    finalDir = path.join(baseDir, padrao, `Season ${season}`);
  } else {
    finalDir = path.join(baseDir, padrao);
  }

  return { finalDir, isAnime, season };
}

function buildRenamedList(selected, padrao, isAnime, season) {
  if (isAnime) {
    return selected.map((f, i) => {
      const ext = f.name.split(".").pop();
      const ep = String(i + 1).padStart(2, "0");
      const s = String(season).padStart(2, "0");
      return `${padrao} - S${s}E${ep}.${ext}`;
    });
  }
  const ext = selected[0].name.split(".").pop();
  return [`${padrao}.${ext}`];
}

async function main() {
  const query = await ask("Pesquisar: ");
  const initialPath = await pickSearchResult(query);
  if (!initialPath) return rl.close();

  const browseResult = await browseFiles(initialPath);
  if (!browseResult) return rl.close();

  const { targetPath, mkvs } = browseResult;

  console.log("\nArquivos disponíveis:");
  mkvs.forEach((f, i) => console.log(`[${i + 1}] ${f.name} (${humanSize(f.size)})`));

  const mode = await ask("\nBaixar (a) todos ou (s) selecionar? ");
  let selected;
  if (mode === "a") {
    selected = mkvs;
  } else {
    const nums = (await ask("Digite os números: ")).trim().split(/\s+/);
    selected = nums.map((n) => mkvs[parseInt(n, 10) - 1]).filter(Boolean);
  }

  if (selected.length === 0) {
    console.log("Nenhum arquivo selecionado.");
    return rl.close();
  }

  const padrao = await ask("\nNome padrão: ");
  const { finalDir, isAnime, season } = await chooseDestination(padrao);
  const renamed = buildRenamedList(selected, padrao, isAnime, season);

  const files = selected.map((f, i) => ({
    remotePath: `${targetPath}/${f.name}`,
    outName: renamed[i],
  }));

  console.log(`\nBaixando ${files.length} arquivo(s) para ${finalDir}...`);
  await downloadAll(files, finalDir);
  console.log("Downloads finalizados.");

  rl.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Erro:", err.message);
    rl.close();
    process.exit(1);
  });
}

module.exports = { pickSearchResult, browseFiles, chooseDestination, buildRenamedList };
