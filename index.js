#!/usr/bin/env node
// index.js — CLI interativo.
//
// Fluxo: pesquisar -> escolher resultado -> navegar pastas -> selecionar
// vídeo(s) -> escolher destino -> baixar com aria2.
//
// A lógica de busca/navegação em si vive em core.js (compartilhada com o
// bot do Telegram). Aqui só tem a camada de terminal (readline).

const path = require("path");
const readline = require("readline");
const { downloadAllAndWait } = require("./download");
const { pickDirWithSpace, assertHasSpace, totalSize } = require("./disk-space");
const {
  humanSize,
  findAnimeMatches,
  getDirectoryView,
  buildRenamedList,
} = require("./core");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function pickSearchResult(query) {
  const results = await findAnimeMatches(query);

  if (results.length === 0) {
    console.log("Nenhum resultado encontrado.");
    return null;
  }

  console.log("\nResultados encontrados:");
  results.forEach((r, i) => {
    console.log(`[${i + 1}] ${r.name}`);
  });

  const choice = await ask("\nEscolha uma opção: ");
  const idx = parseInt(choice, 10) - 1;
  return results[idx] ? results[idx].path : null;
}

/** Navega pelas pastas remotas até o usuário escolher baixar os vídeos de um diretório. */
async function browseFiles(rootPath) {
  let currentPath = rootPath;

  while (true) {
    const view = await getDirectoryView(currentPath);

    console.log(`\nDiretório remoto: ${currentPath}`);
    console.log(
      view.videos.length > 0
        ? "Comandos: [b] voltar | [r] início | [d] baixar vídeos | [q] sair"
        : "Comandos: [b] voltar | [r] início | [q] sair"
    );
    console.log("----------------------------------------");

    view.allFiles.forEach((f, i) => {
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
    if (choice === "d" && view.videos.length > 0) {
      return { targetPath: currentPath, mkvs: view.videos };
    }
    if (choice === "b") {
      if (view.parent) currentPath = view.parent;
      continue;
    }

    const idx = parseInt(choice, 10) - 1;
    const target = view.allFiles[idx];
    if (!target) continue;

    if (target.is_directory) {
      currentPath = `${currentPath}/${target.name}`;
    } else {
      console.log(`(Arquivo único selecionado: ${target.name})`);
      return { targetPath: currentPath, mkvs: [target] };
    }
  }
}

// Mesma prioridade usada no bot: cartão SD primeiro (deve encher antes
// do armazenamento interno).
const SD_ANIME_BASE_DIR = process.env.SD_ANIME_BASE_DIR || "/storage/B3EE-1A06/Download/Animes";
const SD_FILME_BASE_DIR = process.env.SD_FILME_BASE_DIR || "/storage/B3EE-1A06/Download/Filmes";
const ANIME_BASE_DIR = process.env.ANIME_BASE_DIR || "/storage/emulated/0/Downloads/Animes";
const FILME_BASE_DIR = process.env.FILME_BASE_DIR || "/storage/emulated/0/Downloads/Filmes";

const ANIME_DIRS = [SD_ANIME_BASE_DIR, ANIME_BASE_DIR];
const FILME_DIRS = [SD_FILME_BASE_DIR, FILME_BASE_DIR];

async function chooseDestination(padrao, selectedFiles) {
  console.log("\n[1] Animes\n[2] Filmes\n[3] Digitar caminho manual");
  const dest = await ask("Destino: ");

  const requiredBytes = totalSize(selectedFiles);

  let baseDir, isAnime = false;
  if (dest === "1") {
    baseDir = pickDirWithSpace(ANIME_DIRS, requiredBytes, padrao);
    isAnime = true;
  } else if (dest === "2") {
    baseDir = pickDirWithSpace(FILME_DIRS, requiredBytes, padrao);
  } else if (dest === "3") {
    baseDir = (await ask("Diretório base: ")).replace(/^~/, process.env.HOME || "");
    assertHasSpace(baseDir, requiredBytes, padrao);
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
  const { finalDir, isAnime, season } = await chooseDestination(padrao, selected);
  const renamed = buildRenamedList(selected, padrao, isAnime, season);

  const files = selected.map((f, i) => ({
    remotePath: `${targetPath}/${f.name}`,
    outName: renamed[i],
    size: f.size,
  }));

  console.log(`\nBaixando ${files.length} arquivo(s) para ${finalDir}...`);
  await downloadAllAndWait(files, finalDir, { label: padrao });
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

module.exports = { pickSearchResult, browseFiles, chooseDestination };
