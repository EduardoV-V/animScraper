// anitsu-cli — traduz um título digitado em português/inglês para as
// variações de nome (romaji, inglês, sinônimos) que a AniList conhece,
// já que o anitsu guarda as pastas com o nome romaji/japonês.
//
// API pública, sem necessidade de chave: https://anilist.co/graphql

const axios = require("axios");
const { normalize, fuzzyMatch } = require("./core");

const ANILIST_URL = "https://graphql.anilist.co";

const QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 5) {
    media(search: $search, type: ANIME) {
      title {
        romaji
        english
        native
      }
      synonyms
    }
  }
}
`;

/**
 * A busca da AniList em si é "fuzzy" do lado do servidor — quando a query
 * é um título TRUNCADO/incompleto e longo (ex: só as primeiras palavras
 * de um nome enorme), ela pode devolver candidatos que não têm nada a
 * ver com o que foi digitado. Se a gente aceitasse todos cegamente, essas
 * variações erradas iam poluir a busca local com resultados "estranhos"
 * — que é exatamente o problema relatado.
 *
 * Aqui só aceitamos um candidato da AniList se pelo menos UM dos títulos
 * dele (romaji/inglês/nativo/sinônimo) realmente contém — ou é contido
 * por — o que foi digitado. Isso cobre tanto "digitei o título certinho
 * mas incompleto" (query é prefixo do título real) quanto "digitei uma
 * abreviação/apelido" (título real é mais curto que a query).
 */
function isRelevantCandidate(query, candidateTitles) {
  return candidateTitles.some(
    (t) => t && (fuzzyMatch(query, t) || fuzzyMatch(t, query))
  );
}

/**
 * Retorna uma lista de variações de título pra tentar na busca do anitsu,
 * incluindo a query original. Nunca lança erro — se a AniList falhar ou
 * não achar nada relevante, devolve só a query original (a busca local
 * ainda funciona normalmente via substring/fuzzy direto, só sem a
 * tradução extra).
 */
async function translateTitle(query) {
  const variants = new Set([query]);

  try {
    const res = await axios.post(
      ANILIST_URL,
      { query: QUERY, variables: { search: query } },
      { headers: { "Content-Type": "application/json" }, timeout: 10000, validateStatus: () => true }
    );

    if (res.status !== 200) return Array.from(variants);

    const media = res.data?.data?.Page?.media || [];
    for (const m of media) {
      const candidateTitles = [
        m.title?.romaji,
        m.title?.english,
        m.title?.native,
        ...(m.synonyms || []),
      ].filter(Boolean);

      if (!isRelevantCandidate(query, candidateTitles)) {
        continue; // candidato da AniList não tem relação real com a busca — ignora
      }

      for (const t of candidateTitles) variants.add(t);
    }
  } catch {
    // Falha de rede/timeout na AniList — segue só com a query original.
  }

  return Array.from(variants).filter(Boolean);
}

module.exports = { translateTitle };
