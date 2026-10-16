// telegram-bot.js — bot do Telegram que replica o fluxo do CLI (busca ->
// navegação -> seleção de vídeos -> destino -> download) via botões
// inline, mais tradução de título (AniList) e gerenciamento completo de
// séries no Sonarr (adicionar com configuração, listar, monitorar,
// deletar, ver espaço em disco).
//
// Variáveis de ambiente necessárias (veja README-bot.md):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS
//   SONARR_URL, SONARR_API_KEY (opcional: SONARR_ROOT_FOLDER, SONARR_QUALITY_PROFILE)
//   ANIME_BASE_DIR, FILME_BASE_DIR (opcionais, têm default — armazenamento interno)
//   SD_ANIME_BASE_DIR, SD_FILME_BASE_DIR (opcionais, têm default — cartão SD,
//     tem prioridade sobre o interno e deve encher primeiro)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const {
  humanSize,
  getDirectoryView,
  findAnimeMatches,
  findAnimeMatchesMulti,
  buildRenamedList,
} = require("./core");
const { translateTitle } = require("./anilist");
const downloadQueue = require("./download");
const sonarr = require("./sonarr");
const { startAutoRefresh } = require("./session");
const {
  pickDirWithSpace,
  assertHasSpace,
  totalSize,
  findExistingDestination,
  remainingBytes,
  isMountAlive,
} = require("./disk-space");
const {
  detectExistingDownload,
  pickLikelySeason,
  guessSeasonNumberFromPath,
} = require("./local-library");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Defina TELEGRAM_BOT_TOKEN no ambiente (fale com @BotFather pra gerar um).");
  process.exit(1);
}

const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_IDS.length === 0) {
  console.error(
    "Defina TELEGRAM_ALLOWED_IDS (seu user id numérico do Telegram, separado por vírgula " +
      "se for mais de um). Sem isso, QUALQUER pessoa que achar o bot poderia disparar " +
      "downloads e mexer no seu Sonarr — não vamos deixar o bot rodar sem essa trava."
  );
  process.exit(1);
}

// Cartão SD tem prioridade — deve encher antes do armazenamento interno.
// A ordem dos arrays é a ordem de prioridade: pickDirWithSpace tenta o
// primeiro, só cai pro próximo se não houver espaço.
const SD_ANIME_BASE_DIR = process.env.SD_ANIME_BASE_DIR || "/storage/B3EE-1A06/Download/Animes";
const SD_FILME_BASE_DIR = process.env.SD_FILME_BASE_DIR || "/storage/B3EE-1A06/Download/Filmes";
const ANIME_BASE_DIR = process.env.ANIME_BASE_DIR || "/storage/emulated/0/Downloads/Animes";
const FILME_BASE_DIR = process.env.FILME_BASE_DIR || "/storage/emulated/0/Downloads/Filmes";

// Mountpoint de rede (sshfs) — mesma prioridade do cartão SD (os dois
// devem encher antes do armazenamento interno). Como é uma montagem via
// rede, pode cair a qualquer momento; por isso ele só entra nas listas
// abaixo se `isMountAlive(MOUNT_POINT)` confirmar, na hora, que está
// ativo — senão é ignorado e cai pros outros destinos normalmente.
const MOUNT_POINT = process.env.MOUNT_POINT || "/mnt/celular2";
// Nomes das subpastas dentro do mount — se a pasta de lá tiver nome
// diferente ("Anime" no singular, por exemplo), ajuste via .env.
const MOUNT_ANIME_BASE_DIR = process.env.MOUNT_ANIME_BASE_DIR || path.join(MOUNT_POINT, "Animes");
const MOUNT_FILME_BASE_DIR = process.env.MOUNT_FILME_BASE_DIR || path.join(MOUNT_POINT, "Filmes");

/** Monta a lista de diretórios de anime na ordem de prioridade certa —
 * SD e mount (se estiver ativo agora) primeiro, interno por último —
 * recalculada a cada chamada porque o mount pode subir/cair entre uma
 * busca e outra. */
function getAnimeDirs() {
  const dirs = [SD_ANIME_BASE_DIR];
  if (isMountAlive(MOUNT_POINT)) dirs.push(MOUNT_ANIME_BASE_DIR);
  dirs.push(ANIME_BASE_DIR);
  return dirs;
}

function getFilmeDirs() {
  const dirs = [SD_FILME_BASE_DIR];
  if (isMountAlive(MOUNT_POINT)) dirs.push(MOUNT_FILME_BASE_DIR);
  dirs.push(FILME_BASE_DIR);
  return dirs;
}

/** Usado só pra pré-checagem local (achar a pasta certa por nome) — olha
 * as duas categorias porque, nesse ponto (logo após a busca), ainda não
 * sabemos se o usuário vai marcar como anime ou filme. */
function getAllLocalDirs() {
  return [...getAnimeDirs(), ...getFilmeDirs()];
}

const bot = new Telegraf(BOT_TOKEN);

// --- /id funciona mesmo sem estar na allowlist (é como você descobre seu
// próprio id pela primeira vez) ---
bot.command(["id", "getid"], (ctx) => ctx.reply(`Seu Telegram user id: ${ctx.from.id}`));

// --- Segurança: todo o resto só responde pra quem está na allowlist ---
bot.use((ctx, next) => {
  const id = String(ctx.from?.id || "");
  if (!ALLOWED_IDS.includes(id)) {
    console.log(`[bot] mensagem ignorada de id não autorizado: ${id}`);
    return; // não responde nada — nem confirma que o bot existe
  }
  return next();
});

// --- Estado por conversa (em memória — reinicia se o bot reiniciar) ---
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { stage: "idle" });
  }
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { stage: "idle" });
}

// ============================================================
// Fluxo de busca/download de anime
// ============================================================

async function handleBuscar(ctx, termo) {
  const chatId = ctx.chat.id;
  await ctx.reply(`Buscando "${termo}" (incluindo variações de título via AniList)...`);

  // Dispara a busca da query original (API oficial) e a tradução de
  // título (AniList) em paralelo — não faz sentido esperar a AniList
  // responder pra só então começar a buscar o que o usuário já digitou;
  // as duas requisições não dependem uma da outra.
  const [variants, ownResults] = await Promise.all([
    translateTitle(termo),
    findAnimeMatches(termo),
  ]);

  // Só busca as variações EXTRAS que a AniList trouxe (romaji, inglês,
  // sinônimos) — a query original já foi buscada acima, não precisa
  // repetir.
  const extraVariants = variants.filter((v) => v !== termo);
  const extraResults = extraVariants.length > 0 ? await findAnimeMatchesMulti(extraVariants) : [];

  const seen = new Map();
  for (const item of [...ownResults, ...extraResults]) {
    if (!seen.has(item.path)) seen.set(item.path, item);
  }
  const results = Array.from(seen.values());

  if (results.length === 0) {
    return ctx.reply("Nenhum resultado encontrado.");
  }

  const session = getSession(chatId);
  session.stage = "picking_result";
  session.searchResults = results.slice(0, 20);

  const buttons = session.searchResults.map((r, i) => [
    Markup.button.callback(r.name.slice(0, 60), `pick:${i}`),
  ]);
  await ctx.reply(
    `Encontrei ${results.length} resultado(s)${results.length > 20 ? " (mostrando os 20 primeiros)" : ""}:`,
    Markup.inlineKeyboard(buttons)
  );
}

function renderDirView(view) {
  const lines = [`📁 ${view.path}`];
  if (view.videos.length > 0) lines.push(`${view.videos.length} vídeo(s) nessa pasta.`);
  const buttons = view.folders.map((f, i) => [Markup.button.callback(`📁 ${f.name}`, `nav:${i}`)]);

  if (view.videos.length > 0) {
    buttons.push([Markup.button.callback(`🎬 Baixar vídeos daqui (${view.videos.length})`, "dl")]);
  }
  const navRow = [];
  if (view.parent) navRow.push(Markup.button.callback("⬅️ Voltar", "back"));
  navRow.push(Markup.button.callback("🏠 Início", "root"));
  buttons.push(navRow);

  return { text: lines.join("\n"), keyboard: Markup.inlineKeyboard(buttons) };
}

async function enterDirectory(ctx, session, remotePath, { edit = false } = {}) {
  const view = await getDirectoryView(remotePath);
  session.currentPath = remotePath;
  session.dirView = view;
  const { text, keyboard } = renderDirView(view);
  if (edit) {
    await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
  } else {
    await ctx.reply(text, keyboard);
  }
}

function renderVideoSelection(session) {
  const { dirView, selected } = session;
  const buttons = dirView.videos.map((v, i) => [
    Markup.button.callback(
      `${selected.has(i) ? "✅" : "⬜"} ${v.name} (${humanSize(v.size)})`,
      `vt:${i}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("Selecionar todos", "vall"),
    Markup.button.callback(`Baixar (${selected.size})`, "vconfirm"),
  ]);
  return Markup.inlineKeyboard(buttons);
}

function destinationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📺 Animes (com temporada)", "dest:animes")],
    [Markup.button.callback("🎬 Filmes", "dest:filmes")],
    [Markup.button.callback("✏️ Caminho manual", "dest:custom")],
    [Markup.button.callback("📝 Renomear", "rename")],
  ]);
}

async function startDestinationFlow(ctx, session) {
  session.stage = "awaiting_destination";
  // O nome já vem preenchido automaticamente desde a escolha do
  // resultado da busca (pick:) — se já existia pasta local, usamos o
  // nome real dela; senão, o nome que a busca trouxe. "Renomear" abre a
  // opção de digitar outro nome na hora, pra quem quiser ajustar.
  const note = session.localMatch
    ? " (já existe pasta com esse nome — mantendo consistência)"
    : " (nome detectado automaticamente pela busca)";
  await ctx.reply(`📛 Nome: "${session.padrao}"${note}\n\nDestino:`, destinationKeyboard());
}

async function triggerDownload(ctx, session) {
  const files = session.selectedFiles.map((f, i) => ({
    remotePath: `${session.currentPath}/${f.name}`,
    outName: session.renamed[i],
    size: f.size,
  }));
  const finalDir = session.finalDir;
  const chatId = ctx.chat.id;

  const statusBefore = downloadQueue.getStatus();
  const willQueue = Boolean(statusBefore.current); // já tem algo baixando agora?

  downloadQueue.enqueueDownload(files, finalDir, { label: session.padrao, chatId });

  await ctx.reply(
    willQueue
      ? `📥 "${session.padrao}" (${files.length} arquivo(s)) adicionado à fila — tem outro download em andamento. Use /status pra acompanhar.`
      : `⬇️ Baixando "${session.padrao}" (${files.length} arquivo(s)). Use /status pra acompanhar.`
  );

  // Libera a sessão (e o bot) imediatamente — o download roda em
  // background via a fila; os avisos de conclusão/erro chegam pelos
  // listeners de evento registrados mais abaixo (downloadQueue.events).
  resetSession(chatId);
}

// ============================================================
// Sonarr — adicionar série (com tela de configuração)
// ============================================================

const SERIES_TYPES = ["anime", "standard", "daily"];

function renderAddConfig(session) {
  const { chosen, config } = session.sonarrAdd;
  const rootLabel = config.rootFolderPath || "(nenhuma)";
  const qualityLabel =
    session.sonarrAdd.profiles.find((p) => p.id === config.qualityProfileId)?.name || "(nenhum)";

  const text =
    `Adicionar "${chosen.title}" (${chosen.year || "?"})\n\n` +
    `📁 Root folder: ${rootLabel}\n` +
    `🎚 Quality profile: ${qualityLabel}\n` +
    `🏷 Tipo: ${config.seriesType}\n` +
    `👁 Monitorado: ${config.monitored ? "sim" : "não"}\n` +
    `🔎 Buscar episódios agora: ${config.searchNow ? "sim" : "não"}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📁 Trocar root folder", "acfg:root")],
    [Markup.button.callback("🎚 Trocar quality profile", "acfg:quality")],
    [Markup.button.callback(`🏷 Tipo: ${config.seriesType} (trocar)`, "acfg:type")],
    [Markup.button.callback(`👁 Monitorado: ${config.monitored ? "sim" : "não"} (alternar)`, "acfg:monitor")],
    [Markup.button.callback(`🔎 Buscar agora: ${config.searchNow ? "sim" : "não"} (alternar)`, "acfg:search")],
    [Markup.button.callback("✅ Adicionar", "acfg:confirm"), Markup.button.callback("❌ Cancelar", "acfg:cancel")],
  ]);

  return { text, keyboard };
}

async function renderAddConfigMessage(ctx, session, { edit = false } = {}) {
  const { text, keyboard } = renderAddConfig(session);
  if (edit) {
    await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
  } else {
    await ctx.reply(text, keyboard);
  }
}

// ============================================================
// Comandos
// ============================================================

bot.start((ctx) =>
  ctx.reply(
    "Oi! Comandos disponíveis:\n\n" +
      "Anime/anitsu:\n" +
      "/buscar <nome> — busca e baixa anime\n\n" +
      "Sonarr:\n" +
      "/addserie <nome> — adiciona série (com tela de configuração)\n" +
      "/biblioteca — lista séries já cadastradas\n" +
      "/monitorar <nome> — liga/desliga monitoramento\n" +
      "/deletar <nome> — remove uma série da biblioteca\n" +
      "/espaco — espaço livre em disco (segundo o Sonarr)\n\n" +
      "/status — mostra o download atual e a fila\n" +
      "/cancelar ou /home — cancela qualquer coisa em andamento e volta ao início\n" +
      "/id — mostra seu Telegram user id"
  )
);

bot.command(["cancelar", "home"], (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply("🏠 Tudo cancelado. Pode mandar /buscar, /addserie, etc.");
});

bot.command("status", (ctx) => {
  const { current, queued } = downloadQueue.getStatus();

  if (!current && queued.length === 0) {
    return ctx.reply("Nenhum download em andamento ou na fila.");
  }

  const lines = [];
  if (current) {
    const pct = current.progressPercent;
    lines.push(
      `⬇️ Baixando agora: "${current.label}" (${current.fileCount} arquivo(s))` +
        (pct !== null ? ` — ${pct}%` : "")
    );
  }
  if (queued.length > 0) {
    lines.push("\nNa fila:");
    queued.forEach((j, i) => lines.push(`${i + 1}. "${j.label}" (${j.fileCount} arquivo(s))`));
  }
  ctx.reply(lines.join("\n"));
});

bot.command("buscar", (ctx) => {
  const termo = ctx.message.text.replace(/^\/buscar(@\w+)?\s*/, "").trim();
  if (!termo) return ctx.reply("Uso: /buscar nome do anime");
  handleBuscar(ctx, termo).catch((err) => ctx.reply(`Erro: ${err.message}`));
});

bot.command("addserie", async (ctx) => {
  const termo = ctx.message.text.replace(/^\/addserie(@\w+)?\s*/, "").trim();
  if (!termo) return ctx.reply("Uso: /addserie nome da série");

  try {
    const results = (await sonarr.lookupSeries(termo)).slice(0, 8);
    if (results.length === 0) return ctx.reply("Nenhuma série encontrada no TVDB.");

    const session = getSession(ctx.chat.id);
    session.stage = "picking_sonarr_add";
    session.sonarrLookup = results;

    const buttons = results.map((s, i) => [
      Markup.button.callback(`${s.title} (${s.year || "?"})`, `sadd:${i}`),
    ]);
    await ctx.reply("Escolha a série pra adicionar:", Markup.inlineKeyboard(buttons));
  } catch (err) {
    ctx.reply(`Erro consultando Sonarr: ${err.message}`);
  }
});

bot.command("monitorar", async (ctx) => {
  const termo = ctx.message.text.replace(/^\/monitorar(@\w+)?\s*/, "").trim();
  if (!termo) return ctx.reply("Uso: /monitorar nome da série (já cadastrada no Sonarr)");

  try {
    const matches = await sonarr.findLocalSeriesByTitle(termo);
    if (matches.length === 0) return ctx.reply("Nenhuma série encontrada na biblioteca do Sonarr.");

    const buttons = matches.slice(0, 10).map((s) => [
      Markup.button.callback(`${s.monitored ? "✅" : "⬜"} ${s.title}`, "noop"),
      Markup.button.callback("▶️ Monitorar", `smon:${s.id}:on`),
      Markup.button.callback("⏸ Parar", `smon:${s.id}:off`),
    ]);
    await ctx.reply("Séries encontradas:", Markup.inlineKeyboard(buttons));
  } catch (err) {
    ctx.reply(`Erro consultando Sonarr: ${err.message}`);
  }
});

bot.command("biblioteca", async (ctx) => {
  try {
    const all = await sonarr.listSeries();
    if (all.length === 0) return ctx.reply("Nenhuma série cadastrada no Sonarr ainda.");

    const sorted = [...all].sort((a, b) => a.title.localeCompare(b.title));
    const CHUNK = 40;
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const chunk = sorted.slice(i, i + CHUNK);
      const text = chunk
        .map((s) => `${s.monitored ? "▶️" : "⏸"} ${s.title} — ${s.statistics?.episodeFileCount ?? 0}/${s.statistics?.episodeCount ?? "?"} ep.`)
        .join("\n");
      await ctx.reply(text);
    }
    await ctx.reply(`Total: ${all.length} série(s).`);
  } catch (err) {
    ctx.reply(`Erro consultando Sonarr: ${err.message}`);
  }
});

bot.command("espaco", async (ctx) => {
  try {
    const disks = await sonarr.getDiskSpace();
    if (disks.length === 0) return ctx.reply("Sonarr não retornou informação de disco.");

    const text = disks
      .map((d) => {
        const freePct = d.totalSpace ? ((d.freeSpace / d.totalSpace) * 100).toFixed(1) : "?";
        return `💾 ${d.path}\n   ${humanSize(d.freeSpace)} livres de ${humanSize(d.totalSpace)} (${freePct}%)`;
      })
      .join("\n\n");
    await ctx.reply(text);
  } catch (err) {
    ctx.reply(`Erro consultando Sonarr: ${err.message}`);
  }
});

bot.command("deletar", async (ctx) => {
  const termo = ctx.message.text.replace(/^\/deletar(@\w+)?\s*/, "").trim();
  if (!termo) return ctx.reply("Uso: /deletar nome da série (já cadastrada no Sonarr)");

  try {
    const matches = await sonarr.findLocalSeriesByTitle(termo);
    if (matches.length === 0) return ctx.reply("Nenhuma série encontrada na biblioteca do Sonarr.");

    const session = getSession(ctx.chat.id);
    session.sonarrDeleteCandidates = matches.slice(0, 15);

    const buttons = session.sonarrDeleteCandidates.map((s, i) => [
      Markup.button.callback(s.title, `sdel:${i}`),
    ]);
    await ctx.reply("Qual série você quer remover?", Markup.inlineKeyboard(buttons));
  } catch (err) {
    ctx.reply(`Erro consultando Sonarr: ${err.message}`);
  }
});

// ============================================================
// Callbacks — fluxo de busca/download de anime
// ============================================================

bot.action(/^pick:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  const result = session.searchResults?.[idx];
  if (!result) return ctx.reply("Essa busca expirou, faça /buscar de novo.");

  session.rootPath = result.path;
  session.stage = "browsing";

  // Detecção local (nome + pasta já existente) feita AQUI, antes de
  // qualquer navegação — é só leitura de disco local (fs.readdirSync em
  // no máximo 2 níveis), sem rede envolvida, então termina bem antes do
  // usuário sequer terminar de navegar pelas pastas remotas.
  session.localMatch = detectExistingDownload(result.name, getAllLocalDirs());
  // Nome automático: se já existe uma pasta local pra esse anime, usa o
  // nome REAL dela (mantém consistência com o que já foi baixado antes,
  // já que o "continuar download" depende do nome bater certinho). Sem
  // pasta existente, usa o nome que a própria busca trouxe.
  session.padrao = session.localMatch ? session.localMatch.name : result.name;

  await enterDirectory(ctx, session, result.path);
});

bot.action(/^nav:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  const folder = session.dirView?.folders?.[idx];
  if (!folder) return ctx.reply("Sessão de navegação expirou, faça /buscar de novo.");
  await enterDirectory(ctx, session, `${session.currentPath}/${folder.name}`, { edit: true });
});

bot.action("back", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.dirView?.parent) return;
  await enterDirectory(ctx, session, session.dirView.parent, { edit: true });
});

bot.action("root", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.rootPath) return;
  await enterDirectory(ctx, session, session.rootPath, { edit: true });
});

bot.action("dl", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.dirView?.videos?.length) return;
  session.stage = "selecting_videos";

  // Decide qual temporada local comparar: primeiro tenta achar um número
  // de temporada explícito no nome da pasta remota que o usuário está
  // navegando (bem mais confiável); só cai pra heurística ("a temporada
  // com mais episódios já baixados") se isso não for possível.
  let relevantSeason = null;
  let seasonGuessReason = null;
  if (session.localMatch?.seasons?.length) {
    const guessedNumber = guessSeasonNumberFromPath(session.currentPath);
    if (guessedNumber != null) {
      relevantSeason = session.localMatch.seasons.find((s) => s.season === guessedNumber) || null;
      if (relevantSeason) seasonGuessReason = "pela pasta que você abriu";
    }
    if (!relevantSeason) {
      relevantSeason = pickLikelySeason(session.localMatch.seasons);
      if (relevantSeason) seasonGuessReason = "heurística — a com mais episódios já baixados, pode não ser a certa";
    }
  }
  session.relevantLocalSeason = relevantSeason;

  const localEpisodes = relevantSeason?.episodes; // completos — pode pular
  const incompleteEpisodes = relevantSeason?.incompleteEpisodes; // .aria2 pendente — NÃO pula
  session.selected = new Set(
    session.dirView.videos.map((_, i) => i).filter((i) => {
      const epNum = i + 1;
      if (incompleteEpisodes?.has(epNum)) return true; // download parado no meio — mantém marcado pra retomar
      if (localEpisodes?.has(epNum)) return false; // já completo — desmarca
      return true; // nada local ainda — baixa normalmente
    })
  );

  let note = "";
  if (relevantSeason && ((localEpisodes?.size ?? 0) > 0 || (incompleteEpisodes?.size ?? 0) > 0)) {
    const totalVideos = session.dirView.videos.length;
    const completedCount = Array.from({ length: totalVideos }, (_, i) => i + 1).filter((ep) =>
      localEpisodes?.has(ep)
    ).length;
    const pendingCount = Array.from({ length: totalVideos }, (_, i) => i + 1).filter((ep) =>
      incompleteEpisodes?.has(ep)
    ).length;

    const bits = [];
    if (completedCount > 0) bits.push(`${completedCount} já completo(s) (desmarquei)`);
    if (pendingCount > 0) bits.push(`${pendingCount} com download incompleto (.aria2 pendente — mantive marcado pra retomar)`);

    if (bits.length > 0) {
      note = `\n\n📁 Em "${relevantSeason.name}" (${seasonGuessReason}): ${bits.join(", ")}. Confira antes de confirmar.`;
    }
  }

  await ctx.reply(`Selecione os vídeos (toque pra ligar/desligar):${note}`, renderVideoSelection(session));
});

bot.action(/^vt:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  if (!session.selected) return;
  if (session.selected.has(idx)) session.selected.delete(idx);
  else session.selected.add(idx);
  await ctx.editMessageReplyMarkup(renderVideoSelection(session).reply_markup);
});

bot.action("vall", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.selected = new Set(session.dirView.videos.map((_, i) => i));
  await ctx.editMessageReplyMarkup(renderVideoSelection(session).reply_markup);
});

bot.action("vconfirm", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  // Guarda o índice ORIGINAL (posição na listagem remota) de cada vídeo
  // marcado — é isso que vira o número do episódio de verdade. Se
  // pegássemos só a posição dentro da lista já filtrada, pular um
  // episódio no meio (ex: o 3, porque já foi baixado antes) faria o
  // episódio 4 virar "E03" por engano.
  const selectedIndices = session.dirView.videos.map((_, i) => i).filter((i) => session.selected.has(i));
  if (selectedIndices.length === 0) return ctx.reply("Nenhum vídeo selecionado.");
  session.selectedFiles = selectedIndices.map((i) => session.dirView.videos[i]);
  session.episodeNumbers = selectedIndices.map((i) => i + 1);
  await startDestinationFlow(ctx, session);
});

bot.action("noop", (ctx) => ctx.answerCbQuery());

bot.action("rename", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.stage = "awaiting_name";
  await ctx.reply("Digite o nome que quer usar pra essa série/filme:");
});

// ============================================================
// Callbacks — Sonarr: adicionar série (tela de configuração)
// ============================================================

bot.action(/^sadd:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  const chosen = session.sonarrLookup?.[idx];
  if (!chosen) return ctx.reply("Essa busca expirou, faça /addserie de novo.");

  try {
    const { rootFolderPath, qualityProfileId, rootFolders, profiles } = await sonarr.resolveDefaults();
    session.stage = "configuring_add";
    session.sonarrAdd = {
      chosen,
      rootFolders,
      profiles,
      config: {
        rootFolderPath,
        qualityProfileId,
        seriesType: "anime",
        monitored: true,
        searchNow: true,
      },
    };
    await renderAddConfigMessage(ctx, session);
  } catch (err) {
    ctx.reply(`Erro carregando opções do Sonarr: ${err.message}`);
  }
});

bot.action("acfg:root", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  const folders = session.sonarrAdd.rootFolders;
  const buttons = folders.map((f, i) => [Markup.button.callback(f.path, `acfgroot:${i}`)]);
  buttons.push([Markup.button.callback("⬅️ Voltar", "acfg:back")]);
  await ctx.editMessageText("Escolha a root folder:", Markup.inlineKeyboard(buttons));
});

bot.action(/^acfgroot:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  session.sonarrAdd.config.rootFolderPath = session.sonarrAdd.rootFolders[idx].path;
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:quality", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  const profiles = session.sonarrAdd.profiles;
  const buttons = profiles.map((p, i) => [Markup.button.callback(p.name, `acfgquality:${i}`)]);
  buttons.push([Markup.button.callback("⬅️ Voltar", "acfg:back")]);
  await ctx.editMessageText("Escolha o quality profile:", Markup.inlineKeyboard(buttons));
});

bot.action(/^acfgquality:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  session.sonarrAdd.config.qualityProfileId = session.sonarrAdd.profiles[idx].id;
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:back", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:type", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  const cur = SERIES_TYPES.indexOf(session.sonarrAdd.config.seriesType);
  session.sonarrAdd.config.seriesType = SERIES_TYPES[(cur + 1) % SERIES_TYPES.length];
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:monitor", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.sonarrAdd.config.monitored = !session.sonarrAdd.config.monitored;
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:search", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.sonarrAdd.config.searchNow = !session.sonarrAdd.config.searchNow;
  await renderAddConfigMessage(ctx, session, { edit: true });
});

bot.action("acfg:cancel", async (ctx) => {
  await ctx.answerCbQuery();
  resetSession(ctx.chat.id);
  await ctx.editMessageText("Cancelado.");
});

bot.action("acfg:confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  const { chosen, config } = session.sonarrAdd;
  try {
    const added = await sonarr.addSeries(chosen, config);
    await ctx.editMessageText(`✅ "${added.title}" adicionada ao Sonarr.`);
  } catch (err) {
    const msg = err.response?.data?.[0]?.errorMessage || err.message;
    await ctx.editMessageText(`❌ Erro ao adicionar: ${msg}`);
  }
  resetSession(ctx.chat.id);
});

// ============================================================
// Callbacks — Sonarr: monitorar / deletar
// ============================================================

bot.action(/^smon:(\d+):(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, id, onoff] = ctx.match;
  try {
    const updated = await sonarr.setMonitored(Number(id), onoff === "on");
    await ctx.reply(`"${updated.title}" agora está ${updated.monitored ? "monitorada ▶️" : "sem monitoramento ⏸"}.`);
  } catch (err) {
    await ctx.reply(`❌ Erro: ${err.message}`);
  }
});

bot.action(/^sdel:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  const chosen = session.sonarrDeleteCandidates?.[idx];
  if (!chosen) return ctx.reply("Essa lista expirou, faça /deletar de novo.");

  session.sonarrDeleteChosen = chosen;
  await ctx.editMessageText(
    `Tem certeza que quer remover "${chosen.title}" do Sonarr?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🗑 Remover (mantém arquivos)", "sdelconfirm:keep")],
      [Markup.button.callback("🗑💥 Remover E apagar arquivos", "sdelconfirm:files")],
      [Markup.button.callback("❌ Cancelar", "sdelconfirm:cancel")],
    ])
  );
});

bot.action(/^sdelconfirm:(keep|files|cancel)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const mode = ctx.match[1];
  const session = getSession(ctx.chat.id);
  const chosen = session.sonarrDeleteChosen;

  if (mode === "cancel" || !chosen) {
    resetSession(ctx.chat.id);
    return ctx.editMessageText("Cancelado.");
  }

  try {
    await sonarr.deleteSeries(chosen.id, { deleteFiles: mode === "files" });
    await ctx.editMessageText(`✅ "${chosen.title}" removida${mode === "files" ? " (arquivos apagados)" : ""}.`);
  } catch (err) {
    await ctx.editMessageText(`❌ Erro ao remover: ${err.message}`);
  }
  resetSession(ctx.chat.id);
});

// ============================================================
// Texto livre (nome padrão / temporada / caminho manual) e botões de destino
// ============================================================

bot.on("text", async (ctx, next) => {
  const session = getSession(ctx.chat.id);

  // Nunca trata uma mensagem que começa com "/" como resposta de texto
  // livre (nome padrão, temporada etc) — mesmo que o comando não exista.
  // Sem isso, um comando digitado no meio de um fluxo (ex: querendo
  // abortar) seria engolido como se fosse o valor esperado, e o bot
  // parecia "não responder a outros comandos".
  if (ctx.message.text.startsWith("/")) {
    return next();
  }

  if (session.stage === "awaiting_name") {
    session.padrao = ctx.message.text.trim();
    session.stage = "awaiting_destination";
    return ctx.reply("Destino:", destinationKeyboard());
  }

  if (session.stage === "awaiting_season") {
    session.season = ctx.message.text.trim();
    session.renamed = buildRenamedList(
      session.selectedFiles,
      session.padrao,
      true,
      session.season,
      session.episodeNumbers
    );

    const subPath = path.join(session.padrao, `Season ${String(session.season).padStart(2, "0")}`);
    const animeDirs = getAnimeDirs();
    const existingDir = findExistingDestination(animeDirs, subPath);
    const filesWithNames = session.selectedFiles.map((f, i) => ({
      outName: session.renamed[i],
      size: f.size,
    }));

    try {
      if (existingDir) {
        // Já existe pasta com esse anime/temporada em algum dos destinos
        // (SD, mount ou interno) — provavelmente um download anterior
        // que não terminou por falta de espaço. Continua nela em vez de
        // criar outra, e só cobra espaço pelo que realmente falta.
        assertHasSpace(existingDir, remainingBytes(filesWithNames, existingDir), session.padrao);
        session.finalDir = existingDir;
        await ctx.reply(`📁 Já existe download de "${session.padrao}" em ${existingDir} — continuando nele.`);
      } else {
        const requiredBytes = totalSize(session.selectedFiles);
        const baseDir = pickDirWithSpace(animeDirs, requiredBytes, session.padrao);
        session.finalDir = path.join(baseDir, subPath);
      }
    } catch (err) {
      resetSession(ctx.chat.id);
      return ctx.reply(`❌ ${err.message}`);
    }
    return triggerDownload(ctx, session);
  }

  if (session.stage === "awaiting_custom_dir") {
    const baseDir = ctx.message.text.trim();
    session.renamed = buildRenamedList(session.selectedFiles, session.padrao, false, null);

    const finalDir = path.join(baseDir, session.padrao);
    const filesWithNames = session.selectedFiles.map((f, i) => ({
      outName: session.renamed[i],
      size: f.size,
    }));
    const alreadyExists = fs.existsSync(finalDir);

    try {
      if (alreadyExists) {
        assertHasSpace(finalDir, remainingBytes(filesWithNames, finalDir), session.padrao);
        await ctx.reply(`📁 Já existe download de "${session.padrao}" em ${finalDir} — continuando nele.`);
      } else {
        assertHasSpace(finalDir, totalSize(session.selectedFiles), session.padrao);
      }
    } catch (err) {
      resetSession(ctx.chat.id);
      return ctx.reply(`❌ ${err.message}`);
    }
    session.finalDir = finalDir;
    return triggerDownload(ctx, session);
  }

  return next();
});

bot.action("dest:animes", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.stage = "awaiting_season";
  await ctx.reply("Digite o número da temporada:");
});

bot.action("dest:filmes", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.renamed = buildRenamedList(session.selectedFiles, session.padrao, false, null);

  const filmeDirs = getFilmeDirs();
  const existingDir = findExistingDestination(filmeDirs, session.padrao);
  const filesWithNames = session.selectedFiles.map((f, i) => ({
    outName: session.renamed[i],
    size: f.size,
  }));

  try {
    if (existingDir) {
      assertHasSpace(existingDir, remainingBytes(filesWithNames, existingDir), session.padrao);
      session.finalDir = existingDir;
      await ctx.reply(`📁 Já existe download de "${session.padrao}" em ${existingDir} — continuando nele.`);
    } else {
      const requiredBytes = totalSize(session.selectedFiles);
      const baseDir = pickDirWithSpace(filmeDirs, requiredBytes, session.padrao);
      session.finalDir = path.join(baseDir, session.padrao);
    }
  } catch (err) {
    resetSession(ctx.chat.id);
    return ctx.reply(`❌ ${err.message}`);
  }
  await triggerDownload(ctx, session);
});

bot.action("dest:custom", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  session.stage = "awaiting_custom_dir";
  await ctx.reply("Digite o caminho base completo:");
});

// Qualquer coisa começando com "/" que não bateu em nenhum comando acima
// (nem foi engolida pelo fluxo de texto livre) cai aqui.
bot.on("text", (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    return ctx.reply("Comando não reconhecido. Envie /start pra ver a lista, ou /home pra cancelar o que estiver rolando.");
  }
});

// ============================================================
// Eventos da fila de download — avisa o chat que pediu quando o job
// começar/terminar/falhar (mesmo que o usuário já tenha saído do fluxo).
// ============================================================

downloadQueue.events.on("started", (job) => {
  if (!job.chatId) return;
  bot.telegram
    .sendMessage(job.chatId, `▶️ Começando a baixar "${job.label}" (${job.files.length} arquivo(s))...`)
    .catch(() => {});
});

downloadQueue.events.on("done", (job) => {
  if (!job.chatId) return;
  bot.telegram
    .sendMessage(job.chatId, `✅ "${job.label}" — download concluído (${job.files.length} arquivo(s)).`)
    .catch(() => {});
});

downloadQueue.events.on("error", (job, err) => {
  if (!job.chatId) return;
  bot.telegram
    .sendMessage(job.chatId, `❌ Erro baixando "${job.label}": ${err.message}`)
    .catch(() => {});
});

bot.catch((err, ctx) => {
  console.error(`[bot] erro não tratado:`, err);
  ctx.reply(`Ocorreu um erro inesperado: ${err.message}`).catch(() => {});
});

bot.launch().then(() => console.log("Bot do Telegram rodando."));

// Liga a renovação de cookie em background — assim que o bot sobe, já
// garante (e depois vai mantendo sozinho) que o cookie está fresco, sem
// depender de alguém disparar uma busca pra descobrir que expirou.
startAutoRefresh();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
