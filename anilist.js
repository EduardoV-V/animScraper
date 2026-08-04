// anilist.js — traduz um título digitado em português/inglês para as
// variações de nome (romaji, inglês, sinônimos) que a AniList conhece,
// já que o anitsu guarda as pastas com o nome romaji/japonês.
//
// API pública, sem necessidade de chave: https://anilist.co/graphql

const axios = require("axios");

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
 * Retorna uma lista de variações de título pra tentar na busca do anitsu,
 * incluindo a query original. Nunca lança erro — se a AniList falhar ou
 * não achar nada, devolve só a query original (a busca local ainda
 * funciona normalmente, só sem a tradução).
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
      if (m.title?.romaji) variants.add(m.title.romaji);
      if (m.title?.english) variants.add(m.title.english);
      if (m.title?.native) variants.add(m.title.native);
      for (const syn of m.synonyms || []) variants.add(syn);
    }
  } catch {
    // Falha de rede/timeout na AniList — segue só com a query original.
  }

  return Array.from(variants).filter(Boolean);
}

module.exports = { translateTitle };
