// local-library.js — detecta o que já foi baixado localmente pra um
// anime (pasta + temporada + episódios já presentes), sem varrer o disco
// inteiro: olha só o nível de cima de cada base (pra achar a pasta certa
// por fuzzy match) e, no máximo, um nível dentro dela (as temporadas).
// Nada aqui toca em rede — é tudo fs síncrono, então roda em milissegundos.

const fs = require("fs");
const path = require("path");
const { fuzzyMatch } = require("./core");

/** Lista os nomes das subpastas de 1º nível de `dir` (sem recursão).
 * Nunca lança erro — pasta ausente ou sem permissão só conta como vazia. */
function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Procura, nas pastas-base fornecidas (ex: [...ANIME_DIRS, ...FILME_DIRS]),
 * uma pasta já existente cujo nome bate (fuzzy) com `name`. Só olha o
 * nível de cima de cada base — um readdir simples, não desce pra dentro
 * de cada anime. Não precisa de agrupamento por letra (como o site
 * remoto usa) pra ser rápido: mesmo com centenas de pastas, listar os
 * nomes de 1 nível é uma chamada só, não uma varredura recursiva.
 */
function findLocalFolderMatch(baseDirs, name) {
  for (const base of baseDirs) {
    const subdirs = listSubdirs(base);
    const match = subdirs.find((d) => fuzzyMatch(name, d));
    if (match) return { dir: path.join(base, match), name: match };
  }
  return null;
}

// Episódio dentro do nome do arquivo — bate com o padrão que o próprio
// bot usa pra renomear (buildRenamedList): "... - S01E05.mkv".
const EPISODE_RE = /S(\d+)E(\d+)/i;

/** Extrai {season, episode} do nome de um arquivo renomeado pelo bot, ou
 * null se não bater o padrão (ex: arquivo de filme, sem season/episode,
 * ou um arquivo com nome fora do padrão que o bot não gerou). */
function parseEpisode(fileName) {
  const m = fileName.match(EPISODE_RE);
  if (!m) return null;
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
}

/**
 * Dado o diretório de um anime já encontrado (findLocalFolderMatch),
 * lista as temporadas (subpastas "Season N") e, pra cada uma, separa os
 * episódios em dois grupos:
 *   - `episodes`: baixados por completo (arquivo de vídeo sem ".aria2"
 *     pendente do lado) — pode pular na hora de selecionar.
 *   - `incompleteEpisodes`: têm um arquivo ".aria2" pendente do lado
 *     (download que parou no meio — faltou espaço, conexão caiu etc.) —
 *     NÃO deve ser pulado; precisa continuar marcado pra ser baixado de
 *     novo (o aria2c já resume sozinho, contanto que o nome de saída
 *     bata, então nem precisa apagar o .aria2 manualmente).
 *
 * Só desce UM nível (as pastas de temporada) — não abre cada temporada
 * recursivamente além de listar os arquivos dela.
 */
function scanSeasons(animeDir) {
  const seasonDirs = listSubdirs(animeDir).filter((d) => /^Season\s+\d+/i.test(d));
  const seasons = [];

  for (const seasonName of seasonDirs) {
    const seasonPath = path.join(animeDir, seasonName);
    let files;
    try {
      files = fs.readdirSync(seasonPath);
    } catch {
      files = [];
    }
    const fileSet = new Set(files);
    const episodes = new Set();
    const incompleteEpisodes = new Set();

    for (const f of files) {
      // O próprio arquivo ".aria2" é só o controle do aria2c pro vídeo
      // correspondente — não é um episódio à parte, é tratado junto do
      // arquivo de vídeo dele (abaixo, via fileSet.has(...)).
      if (f.endsWith(".aria2")) continue;

      const parsed = parseEpisode(f);
      if (!parsed) continue;

      const hasPendingDownload = fileSet.has(`${f}.aria2`);
      if (hasPendingDownload) {
        incompleteEpisodes.add(parsed.episode);
      } else {
        episodes.add(parsed.episode);
      }
    }

    const seasonNumberMatch = seasonName.match(/(\d+)/);
    seasons.push({
      name: seasonName,
      dir: seasonPath,
      season: seasonNumberMatch ? parseInt(seasonNumberMatch[1], 10) : null,
      episodes,
      incompleteEpisodes,
    });
  }

  return seasons;
}

/**
 * Entre as temporadas já baixadas localmente, escolhe a mais provável de
 * ser a que está em andamento agora: a que tem mais episódios com algum
 * arquivo presente (completo OU incompleto — as duas coisas indicam
 * atividade nessa temporada). Em empate, a de número mais alto (a mais
 * recente). Usado só como ÚLTIMO recurso, quando não dá pra identificar
 * a temporada pelo nome da pasta remota (ver guessSeasonNumberFromPath)
 * — é uma heurística, pode errar se houver mais de uma temporada
 * parcialmente baixada ao mesmo tempo.
 */
function pickLikelySeason(seasons) {
  if (seasons.length === 0) return null;
  const activity = (s) => s.episodes.size + s.incompleteEpisodes.size;
  return seasons.reduce((best, s) => {
    if (!best) return s;
    if (activity(s) > activity(best)) return s;
    if (activity(s) === activity(best) && (s.season || 0) > (best.season || 0)) return s;
    return best;
  }, null);
}

/**
 * Tenta achar um número de temporada explícito no caminho remoto que o
 * usuário está navegando (ex: ".../Fullmetal Alchemist/Temporada 2" ou
 * ".../Season 2") — olha só os 2 últimos segmentos do caminho. Devolve
 * null se não achar nada (título sem indicação de temporada no nome da
 * pasta, ou anime com temporada única).
 */
function guessSeasonNumberFromPath(remotePath) {
  const segments = (remotePath || "").split("/").filter(Boolean).slice(-2);
  for (const seg of segments) {
    const m = seg.match(/(?:temporada|season|s)\s*0*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Função de alto nível: dado o nome do anime (vindo da busca) e as bases
 * locais a checar, devolve o que já existe (se existir) pronto pra usar:
 * nome real da pasta (pra manter consistência com o que já foi baixado
 * antes) e a lista de temporadas com seus episódios. Nunca lança erro —
 * na pior hipótese devolve null (nada encontrado), o que corresponde a
 * "baixa normalmente, sem nada pra pular".
 */
function detectExistingDownload(name, baseDirs) {
  const match = findLocalFolderMatch(baseDirs, name);
  if (!match) return null;

  const seasons = scanSeasons(match.dir);
  return {
    dir: match.dir,
    name: match.name,
    seasons,
  };
}

module.exports = {
  findLocalFolderMatch,
  scanSeasons,
  pickLikelySeason,
  guessSeasonNumberFromPath,
  detectExistingDownload,
  parseEpisode,
};
