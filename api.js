// api.js — chamadas à API do anitsu, com renovação automática de sessão.
//
// Importante: getValidCookies()/getFreshCookies() (em session.js) já tomam
// conta de deduplicar renovações concorrentes. Aqui a gente só usa essas
// funções — nunca dispara login diretamente.

const axios = require("axios");
const {
  ANITSU_BASE,
  getValidCookies,
  getFreshCookies,
  cookieHeader,
} = require("./session");

async function request(endpoint, params = {}) {
  let cookies = await getValidCookies();

  let res = await axios.get(`${ANITSU_BASE}${endpoint}`, {
    params,
    headers: { Cookie: cookieHeader(cookies) },
    validateStatus: () => true,
    timeout: 20000,
  });

  if (res.status === 401 || res.status === 403) {
    console.log("Cookie expirou no meio da requisição. Renovando e tentando de novo...");
    cookies = await getFreshCookies();
    res = await axios.get(`${ANITSU_BASE}${endpoint}`, {
      params,
      headers: { Cookie: cookieHeader(cookies) },
      validateStatus: () => true,
      timeout: 20000,
    });
  }

  if (res.status !== 200) {
    throw new Error(`Falha na API (${res.status}) em ${endpoint}`);
  }

  return res.data;
}

function search(query) {
  return request("/api/search", { q: query });
}

function listFiles(remotePath) {
  return request("/api/files", { path: remotePath });
}

module.exports = { search, listFiles, ANITSU_BASE };
