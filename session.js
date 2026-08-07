// session.js
//
// Responsável por:
//  1) Login manual único via Discord (janela visível do navegador).
//  2) Persistir a sessão do Discord num perfil local (userDataDir), para
//     que execuções futuras já estejam "logadas" no Discord.
//  3) Reabrir esse perfil em modo headless sempre que o cookie do anitsu
//     expirar, refazendo o handshake OAuth sem intervenção manual.
//
// IMPORTANTE — ajuste os seletores/URLs marcados com TODO conforme a
// estrutura real do site (inspecione com DevTools > Network/Elements,
// já que o site exige login e eu não consigo acessá-lo daqui).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");
const puppeteer = require("puppeteer-core");

const ANITSU_BASE = "https://nuvem.anitsu.moe";

// puppeteer-core não baixa Chromium sozinho — ele precisa de um binário já
// instalado no sistema. No Termux, instale com:
//   pkg install x11-repo && pkg install chromium
// Em Linux "normal" (Debian/Ubuntu/etc), instale com:
//   sudo apt install chromium ou chromium-browser
function findChromiumExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    // Termux (x11-repo)
    "/data/data/com.termux/files/usr/bin/chromium",
    "/data/data/com.termux/files/usr/bin/chromium-browser",
    // Linux comum
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Última tentativa: perguntar ao shell
  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const found = execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) return found;
    } catch {
      // não encontrado, tenta o próximo
    }
  }

  throw new Error(
    "Chromium não encontrado. No Termux, rode:\n" +
      "  pkg install x11-repo && pkg install chromium\n" +
      "Ou defina a variável PUPPETEER_EXECUTABLE_PATH apontando pro binário."
  );
}

// Não resolve no carregamento do módulo — só quando for realmente lançar o
// navegador, para não quebrar o `require` antes do Chromium existir.

// URL onde o botão "Entrar com Discord" realmente existe (domínio
// diferente do BASE da API/storage).
const LOGIN_URL = "https://anitsu.moe/login/";

// TODO: seletor do botão/link "Entrar com Discord" na página de login.
const DISCORD_LOGIN_SELECTOR = 'a[href*="discord"]';

// TODO: seletor do botão "Autorizar" na tela de consentimento OAuth do
// Discord (só aparece às vezes; o script já lida com a ausência dela).
const AUTHORIZE_SELECTOR = 'button[type="submit"]';

// Seletores do formulário de login do próprio Discord (discord.com/login).
// Esses são estáveis e não precisam de ajuste na maioria dos casos.
const DISCORD_EMAIL_SELECTOR = 'input[name="email"]';
const DISCORD_PASSWORD_SELECTOR = 'input[name="password"]';
const DISCORD_LOGIN_SUBMIT_SELECTOR = 'button[type="submit"]';
// Tela de código de dois fatores (TOTP) do Discord.
const DISCORD_MFA_SELECTOR = 'input[placeholder*="code" i], input[name="code"]';
// iframe típico de captcha (hCaptcha) que o Discord pode exibir em logins
// que parecem automatizados. Não tem como resolver isso via código.
const CAPTCHA_SELECTOR = 'iframe[src*="hcaptcha"], iframe[src*="captcha"]';

function askStdin(question) {
  // Sem terminal interativo (ex: rodando como serviço em background via
  // termux-services/tmux) não tem ninguém pra digitar nada — falha rápido
  // com uma mensagem clara em vez de travar o processo pra sempre.
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error(
        "Seria necessário digitar algo no terminal agora (2FA ou confirmação de login), " +
          "mas este processo está rodando sem terminal interativo (em background). " +
          "Pare o serviço e rode `npm run login:manual` (ou `npm run login`) manualmente " +
          "num terminal de verdade, depois suba o serviço de novo."
      )
    );
  }

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

// Endpoint leve e confiável pra testar se a sessão ainda é válida. Evite
// usar /api/search aqui — na prática esse endpoint se mostrou instável
// (ignora parâmetros, limita resultados), o que gerava falsos negativos.
const HEALTHCHECK_PATH = "/api/files";
const HEALTHCHECK_PARAMS = { path: "Animes" };

const DATA_DIR = __dirname;
const COOKIE_PATH = path.join(DATA_DIR, "cookies.json");
const PROFILE_DIR = path.join(DATA_DIR, ".browser-profile");

function loadCookies() {
  if (!fs.existsSync(COOKIE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function isSessionValid(cookies) {
  if (!cookies || cookies.length === 0) return false;

  // Até 3 tentativas com espera curta — se a rede ainda não estabilizou
  // (comum logo depois do boot do Android), não queremos concluir "cookie
  // inválido" por causa disso e disparar um Chromium à toa.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(`${ANITSU_BASE}${HEALTHCHECK_PATH}`, {
        params: HEALTHCHECK_PARAMS,
        headers: { Cookie: cookieHeader(cookies) },
        validateStatus: () => true,
        timeout: 10000,
        maxRedirects: 0,
      });
      // Chegou resposta de verdade do servidor — aí sim confiamos nela.
      // Só consideramos inválida se o servidor claramente recusar a
      // autenticação. Redirect (3xx, geralmente para tela de login)
      // também conta como sessão inválida.
      return res.status < 300 && res.status !== 401 && res.status !== 403;
    } catch (err) {
      const isNetworkFailure = !err.response; // sem resposta = problema de rede/DNS/timeout, não de auth
      if (isNetworkFailure && attempt < 3) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (isNetworkFailure) {
        // Rede indisponível mesmo após retries — não temos como saber se
        // o cookie está bom ou não. Assumir "válido" evita lançar um
        // Chromium (caro em memória) só porque a rede caiu momentaneamente;
        // se o cookie realmente tiver expirado, a próxima requisição real
        // vai detectar isso via 401/403 e renovar normalmente.
        console.log("Healthcheck falhou por rede (não por autenticação) — assumindo sessão válida por ora.");
        return true;
      }
      return false;
    }
  }
  return false;
}

/**
 * Executa o fluxo de login via navegador.
 * headless=false -> abre janela visível (use só na primeira vez, ou se o
 *   Discord pedir 2FA/captcha e a renovação automática falhar).
 * headless=true  -> tenta renovar reaproveitando a sessão salva do Discord
 *   no PROFILE_DIR, sem qualquer interação.
 */
async function performLogin({ headless = true, manual = false } = {}) {
  // headless:false (manual ou não) precisa de $DISPLAY — só existe se você
  // estiver rodando com o Termux:X11 ativo no próprio aparelho.
  if (!headless && !process.env.DISPLAY) {
    throw new Error(
      "headless:false precisa de $DISPLAY (uma tela real). Ative o Termux:X11 " +
        "(veja o README) e rode `export DISPLAY=:0` antes de tentar de novo."
    );
  }

  const browser = await puppeteer.launch({
    executablePath: findChromiumExecutable(),
    headless,
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // Desliga subsistemas que a gente não usa — cada um economiza
      // memória/CPU, o que importa bastante num celular com recursos
      // limitados (suspeita principal de o Android matar o Termux
      // inteiro por pressão de memória durante o lançamento do Chromium).
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--renderer-process-limit=1",
      // Limita o heap do V8 — evita que uma página pesada infle o
      // consumo de memória do processo sem necessidade nesse uso.
      "--js-flags=--max-old-space-size=256",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
    console.log(`[debug] após abrir LOGIN_URL: ${page.url()} | título: "${await page.title()}"`);

    if (manual) {
      console.log("\n>> Faça o login inteiro manualmente na janela do navegador (clique em");
      console.log(">> 'Entrar com Discord', digite e-mail/senha, autorize o acesso).");
      console.log(">> Quando terminar e estiver de volta no site do anitsu, volte aqui");
      console.log(">> e pressione ENTER.\n");
      await askStdin("Pressione ENTER quando o login estiver concluído: ");

      await page.goto(ANITSU_BASE, { waitUntil: "networkidle2", timeout: 60000 });
      const cookies = await page.cookies();
      console.log(`[debug] cookies capturados: ${cookies.map((c) => c.name).join(", ") || "(nenhum)"}`);
      saveCookies(cookies);
      return cookies;
    }

    const discordBtn = await page.$(DISCORD_LOGIN_SELECTOR);
    console.log(`[debug] botão "Entrar com Discord" encontrado? ${!!discordBtn}`);

    const alreadyAuthenticated = !page.url().includes("/login");
    if (alreadyAuthenticated) {
      console.log(`[debug] a sessão salva no perfil já está autenticada (redirecionou pra ${page.url()}) — pulando fluxo de login.`);
    }

    if (!alreadyAuthenticated && discordBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
        discordBtn.click(),
      ]);
      console.log(`[debug] após clicar no botão Discord: ${page.url()}`);
    }

    // Se a sessão do Discord já estava salva no perfil (userDataDir), o
    // bloco abaixo inteiro é pulado — só entra aqui na primeira vez ou se
    // a sessão persistida tiver realmente expirado.
    if (!alreadyAuthenticated) {
      const emailField = await page.$(DISCORD_EMAIL_SELECTOR);
      console.log(`[debug] campo de e-mail do Discord encontrado? ${!!emailField}`);
      if (emailField) {
        const email = process.env.DISCORD_EMAIL;
        const password = process.env.DISCORD_PASSWORD;
        if (!email || !password) {
          throw new Error(
            "Formulário de login do Discord apareceu, mas DISCORD_EMAIL/" +
              "DISCORD_PASSWORD não estão definidos. Exporte as duas variáveis " +
              "de ambiente e rode `npm run login` de novo."
          );
        }

        await emailField.type(email, { delay: 20 });
        await page.type(DISCORD_PASSWORD_SELECTOR, password, { delay: 20 });

        const captcha = await page.$(CAPTCHA_SELECTOR);
        if (captcha) {
          throw new Error(
            "O Discord exibiu um captcha nesta tentativa de login automatizado. " +
              "Não tem como resolver isso via código — tente de novo mais tarde " +
              "(às vezes o captcha some após algumas tentativas ou trocando de rede)."
          );
        }

        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          page.click(DISCORD_LOGIN_SUBMIT_SELECTOR),
        ]);
        console.log(`[debug] após submeter e-mail/senha: ${page.url()}`);

        // Tela de código de dois fatores (se a conta tiver 2FA ativado).
        const mfaField = await page.$(DISCORD_MFA_SELECTOR);
        console.log(`[debug] campo de 2FA encontrado? ${!!mfaField}`);
        if (mfaField) {
          const code = await askStdin("Digite o código de autenticação de dois fatores do Discord: ");
          await mfaField.type(code, { delay: 20 });
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
            page.click(DISCORD_LOGIN_SUBMIT_SELECTOR),
          ]);
          console.log(`[debug] após submeter 2FA: ${page.url()}`);
        }
      }

      // Tela de consentimento OAuth ("Autorizar acesso"), se aparecer.
      try {
        await page.waitForSelector(AUTHORIZE_SELECTOR, { timeout: 5000 });
        console.log(`[debug] tela de autorização encontrada em: ${page.url()}`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          page.click(AUTHORIZE_SELECTOR),
        ]);
        console.log(`[debug] após clicar em Autorizar: ${page.url()}`);
      } catch {
        console.log(`[debug] sem tela de autorização extra em: ${page.url()}`);
      }
    }

    // Garante que terminamos numa página autenticada do próprio anitsu.
    await page.goto(ANITSU_BASE, { waitUntil: "networkidle2", timeout: 60000 });

    const cookies = await page.cookies();
    console.log(`[debug] cookies capturados: ${cookies.map((c) => c.name).join(", ") || "(nenhum)"}`);
    saveCookies(cookies);
    return cookies;
  } finally {
    await browser.close();
  }
}

/** Login totalmente manual, headful — você clica em tudo, o script só captura os cookies. */
async function performManualLogin() {
  return performLogin({ headless: false, manual: true });
}

// Cache curto de validade + lock de renovação. Isso evita que N chamadas
// paralelas (ex: findAnimeMatches varrendo ~26 pastas de letra ao mesmo
// tempo) cada uma decida "a sessão expirou" e dispare seu próprio
// Puppeteer — todas esperam a MESMA renovação em andamento.
const VALIDITY_TTL_MS = 30000;
let cachedCookies = null;
let cachedAt = 0;
let renewalPromise = null;

/**
 * Retorna cookies válidos, renovando automaticamente se necessário.
 * - Se nunca logou (sem PROFILE_DIR), pede login manual (headless: false).
 * - Se já logou antes, tenta renovar sozinho em headless.
 * - Chamadas concorrentes reaproveitam a mesma renovação em andamento.
 */
async function getValidCookies() {
  const now = Date.now();
  if (cachedCookies && now - cachedAt < VALIDITY_TTL_MS) {
    return cachedCookies;
  }

  if (renewalPromise) {
    return renewalPromise;
  }

  renewalPromise = (async () => {
    try {
      let cookies = loadCookies();
      if (!cookies || !(await isSessionValid(cookies))) {
        console.log("Sessão ausente ou expirada. Renovando...");
        const firstRun = !fs.existsSync(PROFILE_DIR);
        cookies = await performLogin({ headless: !firstRun });
      }
      cachedCookies = cookies;
      cachedAt = Date.now();
      return cookies;
    } finally {
      renewalPromise = null;
    }
  })();

  return renewalPromise;
}

/** Invalida o cache em memória — usado quando uma requisição real (não o
 * healthcheck) descobre que o cookie caiu no meio do caminho. */
function invalidateCache() {
  cachedCookies = null;
  cachedAt = 0;
}

/**
 * Força renovação, também respeitando o lock (se já tiver uma renovação
 * rolando por causa de outra chamada concorrente, espera ela em vez de
 * abrir um segundo Puppeteer).
 */
async function getFreshCookies() {
  invalidateCache();
  return getValidCookies();
}

module.exports = {
  ANITSU_BASE,
  getValidCookies,
  getFreshCookies,
  performLogin,
  performManualLogin,
  cookieHeader,
  loadCookies,
  saveCookies,
};
