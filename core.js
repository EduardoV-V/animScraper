// core.js — lógica compartilhada entre o CLI (index.js) e o bot do
// Telegram (telegram-bot.js). Nada aqui depende de terminal/readline nem
// de Telegram — só recebe dados e devolve dados.

const { search: apiSearch, listFiles } = require("./api");

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
 * A API oficial de busca (`/api/search`) devolve até 50 resultados, com os
 * mais relevantes primeiro — mas quando não há 50 resultados realmente
 * parecidos com a query, ela PREENCHE o resto com itens vizinhos
 * alfabeticamente que não têm nada a ver (ex: buscar "one piece" também
 * traz "Obey Me!", "Obsolete"...). Esse filtro usa o fuzzyMatch local (o
 * mesmo usado antes pro índice inteiro) só pra descartar esse lixo de
 * preenchimento — bem mais barato que rodá-lo contra o catálogo inteiro,
 * já que agora só passa pelos ~50 itens que a API já filtrou.
 *
 * Se, por algum motivo, NENHUM resultado sobreviver ao filtro (ex: a API
 * devolveu só itens de preenchimento, sem nenhum de fato relevante),
 * devolve a lista de animes crua da API em vez de uma lista vazia — é
 * melhor mostrar candidatos "meio certos" do que não mostrar nada.
 */
function filterRelevantAnimes(query, results) {
  const animes = (results || []).filter((r) => r.kind === "anime");
  const relevant = animes.filter((r) => fuzzyMatch(query, r.name));
  return relevant.length > 0 ? relevant : animes;
}

/** Busca uma única query na API oficial do anitsu, já filtrada pra só
 * animes relevantes. Nunca lança erro — uma falha numa variação de
 * título (ex: timeout de rede) não deve derrubar a busca inteira quando
 * outras variações podem funcionar. */
async function searchAnimeOnce(query) {
  try {
    const data = await apiSearch(query);
    return filterRelevantAnimes(query, data?.results);
  } catch (err) {
    console.error(`Busca por "${query}" falhou: ${err.message}`);
    return [];
  }
}

/** Busca uma query direto na API oficial. */
async function findAnimeMatches(query) {
  const results = await searchAnimeOnce(query);
  return results.map((r) => ({ name: r.name, path: r.path }));
}

/**
 * Roda a busca pra várias variações de título (ex: nome digitado em
 * português + nome romaji/inglês/sinônimos vindos do AniList) — uma
 * requisição por variação, em paralelo (a API não tem tradução embutida,
 * então cada variação pode achar coisas diferentes) — e devolve a união
 * sem duplicar pelo `path`.
 */
async function findAnimeMatchesMulti(queries) {
  const valid = (queries || []).filter(Boolean);
  const perQuery = await mapWithConcurrency(valid, 5, searchAnimeOnce);

  const seen = new Map();
  for (const results of perQuery) {
    for (const item of results) {
      if (!seen.has(item.path)) {
        seen.set(item.path, { name: item.name, path: item.path });
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

/**
 * Monta os nomes finais de arquivo pra cada item selecionado.
 *
 * `episodeNumbers` (opcional): número de episódio REAL de cada item de
 * `selected`, na mesma ordem/posição. Sem isso, o episódio é inferido
 * pela posição dentro de `selected` (i+1) — o que é ERRADO sempre que
 * `selected` for um subconjunto filtrado da lista remota original (ex:
 * o usuário pulou o episódio 3 porque já tinha baixado antes): nesse
 * caso o episódio 4 viraria "E03" por engano, quebrando o nome que
 * deveria bater com o download anterior. Sempre que houver a
 * possibilidade de itens terem sido pulados no meio (como no fluxo do
 * bot do Telegram, que pré-desmarca episódios já baixados), passe
 * `episodeNumbers` com a posição real de cada um na listagem remota.
 */
function buildRenamedList(selected, padrao, isAnime, season, episodeNumbers) {
  if (isAnime) {
    return selected.map((f, i) => {
      const ext = f.name.split(".").pop();
      const epNumber = episodeNumbers ? episodeNumbers[i] : i + 1;
      const ep = String(epNumber).padStart(2, "0");
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
  findAnimeMatches,
  findAnimeMatchesMulti,
  VIDEO_EXTENSIONS,
  getDirectoryView,
  buildRenamedList,
};
