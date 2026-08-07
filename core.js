// core.js — lógica compartilhada entre o CLI (index.js) e o bot do
// Telegram (telegram-bot.js). Nada aqui depende de terminal/readline nem
// de Telegram — só recebe dados e devolve dados.

const { listFiles } = require("./api");

function humanSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

/** Roda `worker` sobre `items` com no máximo `limit` chamadas em paralelo
 * por vez, em vez de tudo de uma vez. Evita martelar a API/sessão com
 * dezenas de requisições simultâneas. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(runners);
  return results;
}

// --- Busca (case-insensitive + fuzzy) ---

/** Remove acentos, pontuação e espaços duplicados, deixando só
 * letras/números/espaço em minúsculo — pra comparar "Really, Really,"
 * (como a AniList escreve) com "really really" (como se digita ou como o
 * anitsu guarda nas pastas, sem pontuação) como a mesma coisa. */
function normalize(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
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
 * aceita substring direta (em qualquer posição do nome) e também nomes
 * "próximos" (erro de digitação) tipo "natuto" -> "naruto".
 */
function fuzzyMatch(query, name) {
  const q = normalize(query);
  const t = normalize(name);
  if (!q) return true;
  if (t.includes(q)) return true;

  const maxDist = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;

  const tokens = t.split(/[^a-z0-9]+/i).filter(Boolean);
  const candidates = [t, ...tokens];

  return candidates.some((c) => c[0] === q[0] && levenshtein(q, c) <= maxDist);
}

/**
 * Monta (com cache curto) a lista completa de itens dentro de "Animes/",
 * varrendo todas as pastas de letra uma única vez. Isso é reaproveitado
 * entre buscas — inclusive entre as várias variações de título do
 * AniList — em vez de relistar tudo a cada chamada.
 */
const INDEX_TTL_MS = 5 * 60 * 1000;
let indexCache = null;
let indexCachedAt = 0;
let indexBuildPromise = null;

async function getAnimeIndex({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && indexCache && now - indexCachedAt < INDEX_TTL_MS) {
    return indexCache;
  }
  if (indexBuildPromise) return indexBuildPromise;

  indexBuildPromise = (async () => {
    try {
      const animesRoot = await listFiles("Animes");
      const letterFolders = (animesRoot.files || []).filter((f) => f.is_directory !== false);

      const folderContents = await mapWithConcurrency(letterFolders, 5, async (folder) => {
        const folderPath = `Animes/${folder.name}`;
        try {
          const data = await listFiles(folderPath);
          return (data.files || [])
            .filter((f) => f.is_directory !== false)
            .map((item) => ({ name: item.name, path: `${folderPath}/${item.name}` }));
        } catch {
          return [];
        }
      });

      indexCache = folderContents.flat();
      indexCachedAt = Date.now();
      return indexCache;
    } finally {
      indexBuildPromise = null;
    }
  })();

  return indexBuildPromise;
}

/** Busca no índice (já cacheado) os itens cujo nome bate com a query. */
async function findAnimeMatches(query) {
  const index = await getAnimeIndex();
  return index.filter((item) => fuzzyMatch(query, item.name));
}

/**
 * Roda a busca pra várias variações de título (ex: nome digitado em
 * português + nome romaji vindo do AniList) contra o MESMO índice
 * (montado uma única vez), e devolve a união sem duplicar pelo `path`.
 */
async function findAnimeMatchesMulti(queries) {
  const index = await getAnimeIndex();
  const seen = new Map();
  for (const q of queries) {
    if (!q) continue;
    for (const item of index) {
      if (!seen.has(item.path) && fuzzyMatch(q, item.name)) {
        seen.set(item.path, item);
      }
    }
  }
  return Array.from(seen.values());
}

// --- Navegação de pastas ---

// Extensões de vídeo reconhecidas como "arquivo baixável".
const VIDEO_EXTENSIONS = /\.?(mkv|mp4|avi)$/i;

/**
 * Lista o conteúdo de uma pasta remota já separado em subpastas e vídeos.
 * É o equivalente a UMA iteração do loop de navegação do CLI, sem loop nem
 * leitura de teclado — quem decide pra onde ir em seguida é quem chama.
 */
async function getDirectoryView(remotePath) {
  const data = await listFiles(remotePath);
  const files = data.files || [];
  return {
    path: remotePath,
    parent: data.parent || null,
    folders: files.filter((f) => f.is_directory),
    videos: files.filter((f) => !f.is_directory && VIDEO_EXTENSIONS.test(f.extension || "")),
    allFiles: files,
  };
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

module.exports = {
  humanSize,
  mapWithConcurrency,
  normalize,
  fuzzyMatch,
  getAnimeIndex,
  findAnimeMatches,
  findAnimeMatchesMulti,
  VIDEO_EXTENSIONS,
  getDirectoryView,
  buildRenamedList,
};
