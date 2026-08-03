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
const { listFiles } = require("./api");
const { downloadAll } = require("./download");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function humanSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

// --- Utilitários de busca (case-insensitive + fuzzy + filtro de diretório limpo) ---

/** Remove acentos e normaliza para comparação (case-insensitive, accent-insensitive). */
function normalize(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Distância de Levenshtein clássica (edições necessárias para transformar a em b). */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Compara a query com o nome do resultado: case-insensitive, ignora acentos,
 * aceita substring direta e também nomes "próximos" (erro de digitação) tipo
 * "natuto" -> "naruto".
 */
function fuzzyMatch(query, name) {
  const q = normalize(query);
  const t = normalize(name);
  if (!q) return true;
  if (t.includes(q)) return true;

  // Tolerância proporcional ao tamanho da query.
  const maxDist = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;

  // Compara contra o nome inteiro e também contra cada "palavra" dele,
  // pra pegar casos tipo "Naruto Shippuden" batendo com query "naruto".
  const tokens = t.split(/[^a-z0-9]+/i).filter(Boolean);
  const candidates = [t, ...tokens];

  // Exige que a primeira letra bata, pra "natuto" -> "naruto" passar mas
  // não confundir nomes parecidos e distintos (ex: "boruto" x "naruto").
  return candidates.some((c) => c[0] === q[0] && levenshtein(q, c) <= maxDist);
}

/**
 * Confere se o nome de uma pasta de "letra" (ex: "Letra N", "N") corresponde
 * à primeira letra normalizada da busca.
 */
function letterFolderMatches(folderName, letter) {
  if (!letter) return false;
  const norm = normalize(folderName);
  return (
    norm === letter ||
    norm === `letra ${letter}` ||
    norm.endsWith(` ${letter}`) ||
    norm.endsWith(`-${letter}`)
  );
}

/**
 * Busca os animes cujo nome bate (exato ou aproximado) com a query,
 * navegando direto pela árvore de pastas em vez de depender do
 * /api/search — que na prática ignora qualquer parâmetro além de "q",
 * limita a 50 resultados e não garante que o item certo apareça nem
 * esteja bem ranqueado (confirmado testando a API diretamente).
 *
 * Fluxo: lista "Animes/" -> acha a pasta da letra certa (pelo 1º
 * caractere da busca) -> lista o conteúdo dela -> filtra localmente.
 * Se não achar a pasta da letra esperada (estrutura pode variar),
 * cai pra uma varredura de todas as pastas de letra.
 */
async function findAnimeMatches(query) {
  const animesRoot = await listFiles("Animes");
  const letterFolders = (animesRoot.files || []).filter((f) => f.is_directory !== false);

  if (letterFolders.length === 0) {
    console.log('[debug] "Animes/" não retornou nenhuma subpasta. Estrutura recebida:');
    console.log(JSON.stringify(animesRoot, null, 2));
    return [];
  }

  const letter = normalize(query)[0];
  let candidateFolders = letterFolders.filter((f) => letterFolderMatches(f.name, letter));

  if (candidateFolders.length === 0) {
    // Não achamos a pasta esperada pra essa letra — varre todas como fallback.
    candidateFolders = letterFolders;
  }

  const matches = [];
  for (const folder of candidateFolders) {
    const folderPath = `Animes/${folder.name}`;
    const data = await listFiles(folderPath);
    const items = (data.files || []).filter((f) => f.is_directory !== false);
    for (const item of items) {
      if (fuzzyMatch(query, item.name)) {
        matches.push({ name: item.name, path: `${folderPath}/${item.name}` });
      }
    }
  }
  return matches;
}

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
