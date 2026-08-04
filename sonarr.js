// sonarr.js — wrapper fino sobre a API REST do Sonarr (v3).
//
// Variáveis de ambiente esperadas:
//   SONARR_URL              ex: http://192.168.1.10:8989 (sem /api no final)
//   SONARR_API_KEY          em Sonarr > Settings > General > Security
//   SONARR_ROOT_FOLDER      opcional — se não definido, usa a primeira
//                            pasta raiz configurada no Sonarr
//   SONARR_QUALITY_PROFILE  opcional — nome do perfil de qualidade a usar
//                            ao adicionar séries (ex: "HD-1080p"). Se não
//                            definido, usa o primeiro perfil disponível.

const axios = require("axios");

function client() {
  const baseURL = process.env.SONARR_URL;
  const apiKey = process.env.SONARR_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("SONARR_URL e SONARR_API_KEY precisam estar definidos no ambiente.");
  }
  return axios.create({
    baseURL: `${baseURL.replace(/\/$/, "")}/api/v3`,
    headers: { "X-Api-Key": apiKey },
    timeout: 20000,
  });
}

/** Busca séries no TVDB via Sonarr (pra achar antes de adicionar). */
async function lookupSeries(term) {
  const res = await client().get("/series/lookup", { params: { term } });
  return res.data || [];
}

/** Lista as séries já cadastradas na biblioteca do Sonarr. */
async function listSeries() {
  const res = await client().get("/series");
  return res.data || [];
}

/** Procura na biblioteca local (já adicionadas) por título aproximado. */
async function findLocalSeriesByTitle(term) {
  const { normalize } = require("./core");
  const all = await listSeries();
  const q = normalize(term);
  return all.filter((s) => normalize(s.title).includes(q));
}

async function getRootFolders() {
  const res = await client().get("/rootfolder");
  return res.data || [];
}

async function getQualityProfiles() {
  const res = await client().get("/qualityprofile");
  return res.data || [];
}

async function resolveDefaults() {
  const [rootFolders, profiles] = await Promise.all([getRootFolders(), getQualityProfiles()]);

  if (rootFolders.length === 0) throw new Error("Sonarr não tem nenhuma pasta raiz configurada.");
  if (profiles.length === 0) throw new Error("Sonarr não tem nenhum perfil de qualidade configurado.");

  const rootFolderPath =
    (process.env.SONARR_ROOT_FOLDER &&
      rootFolders.find((r) => r.path === process.env.SONARR_ROOT_FOLDER)?.path) ||
    rootFolders[0].path;

  const qualityProfileId =
    (process.env.SONARR_QUALITY_PROFILE &&
      profiles.find((p) => p.name === process.env.SONARR_QUALITY_PROFILE)?.id) ||
    profiles[0].id;

  return { rootFolderPath, qualityProfileId, rootFolders, profiles };
}

/**
 * Adiciona uma série ao Sonarr a partir de um resultado de lookupSeries
 * (precisa ter tvdbId, title, etc — passe o objeto inteiro retornado por
 * lookupSeries) com configuração explícita.
 */
async function addSeries(seriesLookupResult, config) {
  const {
    rootFolderPath,
    qualityProfileId,
    seriesType = "anime",
    monitored = true,
    searchNow = true,
  } = config;

  const payload = {
    ...seriesLookupResult,
    qualityProfileId,
    rootFolderPath,
    seriesType,
    monitored,
    addOptions: {
      searchForMissingEpisodes: searchNow,
      monitor: monitored ? "all" : "none",
    },
  };

  const res = await client().post("/series", payload);
  return res.data;
}

/** Liga/desliga o monitoramento de uma série já existente na biblioteca. */
async function setMonitored(seriesId, monitored) {
  const res = await client().get(`/series/${seriesId}`);
  const series = res.data;
  series.monitored = monitored;
  const updated = await client().put(`/series/${seriesId}`, series);
  return updated.data;
}

/** Remove uma série da biblioteca. deleteFiles=true também apaga os
 * arquivos de disco (episódios já baixados) — use com cuidado. */
async function deleteSeries(seriesId, { deleteFiles = false } = {}) {
  await client().delete(`/series/${seriesId}`, {
    params: { deleteFiles, addImportListExclusion: false },
  });
}

/** Espaço livre/total de cada disco/pasta que o Sonarr enxerga. */
async function getDiskSpace() {
  const res = await client().get("/diskspace");
  return res.data || [];
}

module.exports = {
  lookupSeries,
  listSeries,
  findLocalSeriesByTitle,
  getRootFolders,
  getQualityProfiles,
  resolveDefaults,
  addSeries,
  setMonitored,
  deleteSeries,
  getDiskSpace,
};
