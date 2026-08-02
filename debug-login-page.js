// debug-login-page.js
//
// Diagnóstico único: abre a LOGIN_URL em modo headless (reaproveitando o
// perfil já logado) e imprime todos os links e botões da página — texto,
// href, classe — para a gente identificar o seletor real do botão
// "Entrar com Discord" sem precisar adivinhar.
//
// Uso:
//   node debug-login-page.js

const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const LOGIN_URL = "https://anitsu.moe/login/";
const PROFILE_DIR = path.join(__dirname, ".browser-profile");

function findChromiumExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "/data/data/com.termux/files/usr/bin/chromium",
    "/data/data/com.termux/files/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error("Chromium não encontrado. Defina PUPPETEER_EXECUTABLE_PATH.");
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    userDataDir: PROFILE_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
    console.log(`URL atual: ${page.url()}`);
    console.log(`Título: ${await page.title()}\n`);

    const links = await page.$$eval("a", (els) =>
      els.map((el) => ({
        text: el.textContent.trim().slice(0, 60),
        href: el.getAttribute("href"),
        class: el.className,
        id: el.id,
      })).filter((l) => l.text || l.href)
    );

    const buttons = await page.$$eval("button", (els) =>
      els.map((el) => ({
        text: el.textContent.trim().slice(0, 60),
        class: el.className,
        id: el.id,
        type: el.getAttribute("type"),
      }))
    );

    console.log("=== LINKS (<a>) ===");
    links.forEach((l, i) => console.log(`[${i}] texto="${l.text}" href="${l.href}" class="${l.class}" id="${l.id}"`));

    console.log("\n=== BOTÕES (<button>) ===");
    buttons.forEach((b, i) => console.log(`[${i}] texto="${b.text}" class="${b.class}" id="${b.id}" type="${b.type}"`));

    // Também salva o HTML completo, caso o botão esteja dentro de um
    // componente que não seja <a> nem <button> (ex: <div onclick=...>).
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, "login-page.html"), html);
    console.log("\nHTML completo salvo em login-page.html (pode inspecionar se nada acima bater).");
  } finally {
    await browser.close();
  }
})();
