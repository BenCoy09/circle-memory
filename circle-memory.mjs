#!/usr/bin/env node
// Circle Memory: shared group memory on Walrus Memory. Single file.
//
//   node circle-memory.mjs bot                      Telegram bot
//   node circle-memory.mjs seed [circle]            write 18 demo memories (sample data)
//   node circle-memory.mjs compare [circle] [q...]  memory off vs on, in the terminal
//   node circle-memory.mjs serve                    landing page on http://localhost:3000
//
// Install: npm i @mysten-incubation/memwal grammy dotenv @grpc/grpc-js @grpc/proto-loader   (+ @anthropic-ai/sdk only if you use Anthropic)
// Env (.env): MEMWAL_ACCOUNT_ID MEMWAL_SERVER_URL MEMWAL_PRIVATE_KEY
//             TELEGRAM_BOT_TOKEN
//             TATUM_API_KEY [TATUM_SUI_GRPC] [SUI_PROTO_DIR]   (Sui gRPC via Tatum; needs ~/sui-apis)
//             Free LLM: LLM_BASE_URL LLM_MODEL [LLM_API_KEY]   (defaults to local Ollama + gemma3)
//             Or paid: ANTHROPIC_API_KEY [ANTHROPIC_MODEL]

import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

// Load .env before any setting below is read.
try { await import("dotenv/config"); } catch { /* dotenv optional if env is already set */ }

const TYPES = ["expense", "promise", "payment", "decision"];
const RECEIPTS = new URL("./receipts.jsonl", import.meta.url);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

/* ------------------------------ memory layer ------------------------------ */

const clients = new Map();

// One Walrus Memory namespace per Circle. Nothing is shared across Circles.
const namespaceFor = (circleId) =>
  `circle-${String(circleId).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

async function client(circleId) {
  const { MEMWAL_ACCOUNT_ID, MEMWAL_SERVER_URL, MEMWAL_PRIVATE_KEY } = process.env;
  if (!MEMWAL_ACCOUNT_ID || !MEMWAL_SERVER_URL || !MEMWAL_PRIVATE_KEY)
    throw new Error("Missing MEMWAL_ACCOUNT_ID, MEMWAL_SERVER_URL or MEMWAL_PRIVATE_KEY in .env");
  const namespace = namespaceFor(circleId);
  if (!clients.has(namespace)) {
    const { MemWal } = await import("@mysten-incubation/memwal");
    clients.set(
      namespace,
      MemWal.create({ key: MEMWAL_PRIVATE_KEY, accountId: MEMWAL_ACCOUNT_ID, serverUrl: MEMWAL_SERVER_URL, namespace })
    );
  }
  return clients.get(namespace);
}

// One fact per memory, readable by a stranger with no context.
const format = ({ type, by, text, date }) =>
  `[${type}] ${text} (recorded by ${by} on ${date ?? new Date().toISOString().slice(0, 10)})`;

async function remember(circleId, entry) {
  if (!TYPES.includes(entry.type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
  const text = format(entry);
  const mw = await client(circleId);
  const accepted = await mw.remember(text);
  const done = await mw.waitForRememberJob(accepted.job_id, { timeoutMs: 300_000 });
  const receipt = { circle: namespaceFor(circleId), text, jobId: accepted.job_id, blobId: done.blob_id, at: new Date().toISOString() };
  await appendFile(RECEIPTS, JSON.stringify(receipt) + "\n").catch(() => {});
  return receipt;
}

async function recall(circleId, query, limit = 8) {
  const res = await (await client(circleId)).recall({ query });
  return [...res.results].sort((a, b) => a.distance - b.distance).slice(0, limit);
}

const closeAll = () => { for (const c of clients.values()) c.destroy(); clients.clear(); };

/* ------------------------------ Tatum Sui gRPC ----------------------------- */

// Sui retired JSON-RPC, so every on-chain read goes through Tatum's Sui gRPC gateway
// (x-api-key sent as gRPC metadata). It needs the official protos:
//   git clone https://github.com/MystenLabs/sui-apis ~/sui-apis
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "unknown");
let suiClient;

async function suiGrpc() {
  if (suiClient) return suiClient;
  const key = process.env.TATUM_API_KEY;
  if (!key) throw new Error("Missing TATUM_API_KEY in .env");
  const grpcMod = await import("@grpc/grpc-js");
  const loaderMod = await import("@grpc/proto-loader");
  const grpc = grpcMod.default ?? grpcMod;
  const loader = loaderMod.default ?? loaderMod;
  const dir = process.env.SUI_PROTO_DIR || `${process.env.HOME || "~"}/sui-apis/proto`;
  let def;
  try {
    def = loader.loadSync("sui/rpc/v2/ledger_service.proto", {
      keepCase: true, longs: String, enums: String, oneofs: true, includeDirs: [dir],
    });
  } catch (e) {
    throw new Error(`Couldn’t load the Sui protos from ${dir}. Run: git clone https://github.com/MystenLabs/sui-apis ~/sui-apis (${e.message})`);
  }
  const pkg = grpc.loadPackageDefinition(def);
  const host = process.env.TATUM_SUI_GRPC || "sui-mainnet-grpc.gateway.tatum.io:443";
  const ledger = new pkg.sui.rpc.v2.LedgerService(host, grpc.credentials.createSsl());
  const meta = new grpc.Metadata();
  meta.set("x-api-key", key);
  suiClient = { ledger, meta, host };
  return suiClient;
}

const suiCall = (c, method, req) =>
  new Promise((resolve, reject) =>
    c.ledger[method](req, c.meta, { deadline: Date.now() + 20_000 }, (err, res) =>
      err ? reject(new Error(`Tatum gRPC ${err.code ?? ""}: ${err.details || err.message}`)) : resolve(res)
    )
  );

// Turn a Sui transaction into facts: who paid whom, how much, and when.
function parseTransaction(resp, digest, due) {
  const tx = resp.transaction ?? resp;
  if (tx.effects?.status?.success === false) throw new Error("That transaction did not succeed on Sui");
  const sender = tx.transaction?.sender;
  const secs = Number(tx.timestamp?.seconds);
  if (!secs) throw new Error("Sui returned no timestamp for that transaction");
  const at = new Date(secs * 1000);
  const gains = (tx.balance_changes || [])
    .filter((c) => /::sui::SUI$/.test(c.coin_type || "") && BigInt(c.amount) > 0n)
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  const top = gains[0];
  const amountSui = top ? Number(BigInt(top.amount)) / 1e9 : null;

  let timing = "";
  if (due) {
    const dueEnd = Date.parse(`${due}T23:59:59Z`);
    if (Number.isNaN(dueEnd)) throw new Error("Due date must look like 2026-11-01");
    const lateDays = Math.ceil((at.getTime() - dueEnd) / 86_400_000);
    timing = lateDays > 0 ? `, ${lateDays} day${lateDays === 1 ? "" : "s"} after its due date of ${due}` : `, on time for its due date of ${due}`;
  }
  const what = amountSui === null ? "a transaction" : `${amountSui} SUI`;
  const text = `Verified on Sui via Tatum: ${short(sender)} sent ${what}${top ? ` to ${short(top.address)}` : ""} on ${at.toISOString().slice(0, 16).replace("T", " ")} UTC${timing} (tx ${digest})`;
  return { digest, sender, to: top?.address, amountSui, at, text };
}

async function verifyPayment(digest, due) {
  const c = await suiGrpc();
  const resp = await suiCall(c, "GetTransaction", {
    digest,
    read_mask: { paths: ["digest", "transaction.sender", "effects.status", "timestamp", "balance_changes"] },
  });
  return parseTransaction(resp, digest, due);
}

/* -------------------------------- agent layer ------------------------------ */

const WITH_MEMORY = `You are the agent for a small group (a Circle: a household, friend group or team).
You are given numbered records from the Circle's shared memory. Base your advice on them.
Rules:
- Use only facts in the records. Never invent amounts, dates or behaviour.
- Cite the records you rely on like [2], [5].
- Count patterns carefully (e.g. late 4 of 5 times) and only state what the records support.
- If the records do not contain evidence for something, say so plainly.
- Records that start with "Verified on Sui via Tatum" were read from the blockchain, so they are more reliable than self-reported records. Prefer them, and say when a claim rests on one.
- Be short and concrete. Say what you would do and for whom.`;

const NO_MEMORY = `You are an assistant for a small group. You have no access to the group's history.
Answer helpfully and generically in two sentences or fewer. Do not invent details about the group.`;

// Free-first: any OpenAI-compatible endpoint works (Ollama, Gemini, Groq, OpenRouter).
// Set ANTHROPIC_API_KEY instead if you have Anthropic credits.
async function complete(system, user) {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const msg = await new Anthropic().messages.create({
      model: MODEL, max_tokens: 500, system, messages: [{ role: "user", content: user }],
    });
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  }
  const base = (process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gemma3";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY || "ollama"}` },
    body: JSON.stringify({
      model,
      max_tokens: 1500, // reasoning models spend part of this thinking
      ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()).choices?.[0]?.message?.content;
  if (!out) throw new Error("The AI model returned an empty answer. Try a different LLM_MODEL.");
  return out.trim();
}

async function advise(circleId, question, { useMemory = true, limit = 8 } = {}) {
  const reads = useMemory ? await recall(circleId, question, limit) : [];
  const context = reads.length ? reads.map((r, i) => `[${i + 1}] ${r.text}`).join("\n") : "(no records found)";
  const answer = await complete(
    useMemory ? WITH_MEMORY : NO_MEMORY,
    useMemory ? `Today is ${new Date().toISOString().slice(0, 10)}.\nCircle memory:\n${context}\n\nQuestion: ${question}` : question
  );
  return { answer, reads };
}

/* ------------------------------- demo seed data ---------------------------- */

// Sample records, not real people. Every write is a real Walrus Memory write.
const SEED = [
  ["promise", "dan", "2026-06-25", "Dan promised to pay his share of rent by the 1st"],
  ["payment", "dan", "2026-07-04", "Dan paid July rent on the 4th, 3 days after the due date"],
  ["expense", "maya", "2026-07-09", "Maya paid £84 for groceries, split 4 ways"],
  ["payment", "tobi", "2026-07-01", "Tobi paid July rent on the 1st, on time"],
  ["payment", "dan", "2026-08-06", "Dan paid August rent on the 6th, 5 days late"],
  ["payment", "maya", "2026-08-01", "Maya paid August rent on the 1st, on time"],
  ["decision", "maya", "2026-08-10", "The Circle agreed the shared fund tops up every Friday"],
  ["payment", "dan", "2026-09-04", "Dan paid September rent on the 4th, 3 days late"],
  ["expense", "tobi", "2026-09-12", "Tobi covered the internet bill, £32"],
  ["payment", "tobi", "2026-09-01", "Tobi paid September rent on the 1st, on time"],
  ["promise", "tobi", "2026-09-20", "Tobi promised to cover next month’s utilities"],
  ["payment", "dan", "2026-10-01", "Dan paid October rent on the 1st, on time"],
  ["payment", "dan", "2026-10-02", "Dan paid his share of the October electricity bill, 1 day late"],
  ["payment", "maya", "2026-10-01", "Maya paid October rent on the 1st, on time"],
  ["expense", "maya", "2026-10-15", "Maya paid £61 for cleaning supplies, split 4 ways"],
  ["decision", "tobi", "2026-10-18", "The Circle agreed reminders go out 2 days before a due date for anyone who paid late before"],
  ["promise", "dan", "2026-10-25", "Dan promised to pay November rent by the 1st"],
  ["payment", "dan", "2026-11-03", "Dan paid November rent on the 3rd, 2 days late"],
];

/* ------------------------------- telegram bot ------------------------------ */

const HELP = `Circle Memory keeps a shared memory for this chat and advises from it.

Record something:
/expense Groceries £84, split 4 ways
/promise I’ll pay rent by the 1st
/payment Paid rent today, 3 days late
/decision Shared fund tops up on Fridays

Verify on Sui (read via Tatum):
/paid <tx digest> [due YYYY-MM-DD]

Ask:
/ask Who should I remind about rent?
/compare Can you handle rent reminders?   (memory off vs on)`;

async function runBot({ webhook = false } = {}) {
  const { Bot, InlineKeyboard } = await import("grammy");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  const bot = new Bot(token);
  // Each group chat is its own Circle. PRIVATE_CIRCLE (optional) points private chats at a shared demo Circle.
  const circleOf = (ctx) =>
    process.env.DEMO_CIRCLE || (ctx.chat.type === "private" && process.env.PRIVATE_CIRCLE) || `tg${Math.abs(ctx.chat.id)}`;
  const nameOf = (ctx) => ctx.from?.first_name ?? "someone";
  const DIGEST_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/;
  const BRIEF_Q = "Give a short reliability brief for each person in this Circle: who pays on time, who pays late and how often, and any promises still open.";
  const OPEN_Q = "List every promise or commitment that is still open: who owes what, by when, and whether it is overdue today. A promise is closed if a later record shows it was done or paid. If nothing is open, say so.";
  const pending = new Map();
  let pendingSeq = 0;

  const menu = () =>
    new InlineKeyboard().text("Log something", "menu:log").text("Ask the Circle", "menu:ask").row()
      .text("What’s open", "menu:open").text("Circle brief", "menu:brief").row()
      .text("How it works", "menu:how");

  const welcomeBase = (name) =>
    `Hi ${name}. I’m Circle Memory.\n\nI keep one shared memory for this chat: expenses, promises, payments and decisions. Tell me what happened in plain words and I’ll remember it. Ask me anything and I’ll answer from what your group actually did, not what it said it would do.\n\nTry: “Maya paid £84 for groceries, split 4 ways”`;
  const welcome = (name) =>
    welcomeBase(name) +
    (process.env.PRIVATE_CIRCLE
      ? "\n\nThis private chat is the demo Circle, “Flat 4B”, with sample flatmates and some history already in it. Add me to a group to start a Circle of your own."
      : "");

  // Read a plain-language message and work out what the person wants.
  async function understand(text, name) {
    const today = new Date().toISOString().slice(0, 10);
    const weekday = new Date().toLocaleDateString("en-GB", { weekday: "long" });
    const out = await complete(
      `You read one chat message sent to a group-memory assistant. Reply with JSON only, no prose.
Schema: {"intent":"log"|"ask"|"other","type":"expense"|"promise"|"payment"|"decision"|null,"fact":string|null}
- "log": the message reports something that happened, was promised or was decided. "fact" is one clear sentence in the third person with names, amounts and dates (today is ${today}, a ${weekday}). If a promise or task has a deadline, state it as "due YYYY-MM-DD", turning words like "Friday" into a real date. Never invent details.
- "ask": the message asks a question or asks for advice.
- "other": greetings or anything else.`,
      `${name} wrote: ${text}`
    );
    try { return JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { return { intent: "other" }; }
  }

  async function answer(ctx, question, opts) {
    const { answer: a, reads } = await advise(circleOf(ctx), question, opts);
    await ctx.reply(`${a}\n\nRead ${reads.length} memor${reads.length === 1 ? "y" : "ies"}.`);
  }

  async function verifyAndSave(ctx, digest, due) {
    const v = await verifyPayment(digest, due);
    const r = await remember(circleOf(ctx), { type: "payment", by: nameOf(ctx), text: v.text });
    await ctx.reply(`Verified on Sui and saved to Walrus.\n\n${v.text}\n\nBlob: ${r.blobId}`);
  }

  bot.command(["start", "help", "join"], async (ctx) => {
    const kb = menu();
    if (ctx.chat.type === "private") kb.row().url("Add to a group", `https://t.me/${ctx.me.username}?startgroup=join`);
    await ctx.reply(welcome(nameOf(ctx)), { reply_markup: kb });
  });

  // Greet a group the moment the bot is added to it.
  bot.on("my_chat_member", async (ctx) => {
    const up = ctx.myChatMember;
    const joined = ["member", "administrator"].includes(up.new_chat_member.status) && !["member", "administrator"].includes(up.old_chat_member.status);
    if (joined && ["group", "supergroup"].includes(ctx.chat.type)) {
      await ctx.reply(`This chat is now a Circle. Everyone here shares one memory. Mention me with what happened, like “@${ctx.me.username} Dan paid rent, 3 days late”, and I’ll check with you before saving it.`, { reply_markup: menu() });
    }
  });

  for (const type of TYPES) {
    bot.command(type, async (ctx) => {
      const text = ctx.match?.trim();
      if (!text) return ctx.reply(`Usage: /${type} <what happened>`);
      try {
        const r = await remember(circleOf(ctx), { type, by: nameOf(ctx), text });
        await ctx.reply(`Saved to Walrus.\nBlob: ${r.blobId}`);
      } catch (e) {
        await ctx.reply(`Couldn’t save that: ${e.message}`);
      }
    });
  }

  bot.command("paid", async (ctx) => {
    const [digest, due] = (ctx.match || "").trim().split(/\s+/);
    if (!digest) return ctx.reply("Usage: /paid <tx digest> [due date YYYY-MM-DD]");
    if (!DIGEST_RE.test(digest)) return ctx.reply("That doesn’t look like a Sui transaction digest.");
    try { await verifyAndSave(ctx, digest, due); } catch (e) { await ctx.reply(`Couldn’t verify that: ${e.message}`); }
  });

  bot.command("ask", async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /ask <question>");
    try { await answer(ctx, q); } catch (e) { await ctx.reply(`Something went wrong: ${e.message}`); }
  });

  bot.command("brief", async (ctx) => {
    try { await answer(ctx, BRIEF_Q, { limit: 20 }); } catch (e) { await ctx.reply(`Something went wrong: ${e.message}`); }
  });

  bot.command("open", async (ctx) => {
    try { await answer(ctx, OPEN_Q, { limit: 30 }); } catch (e) { await ctx.reply(`Something went wrong: ${e.message}`); }
  });

  bot.command("compare", async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /compare <question>");
    try {
      const [off, on] = await Promise.all([advise(circleOf(ctx), q, { useMemory: false }), advise(circleOf(ctx), q)]);
      await ctx.reply(`Memory off:\n${off.answer}\n\nMemory on (${on.reads.length} read):\n${on.answer}`);
    } catch (e) {
      await ctx.reply(`Something went wrong: ${e.message}`);
    }
  });

  // Plain language: no commands needed. In groups, mention the bot or reply to it.
  bot.on("message:text", async (ctx) => {
    let text = ctx.msg.text.trim();
    if (text.startsWith("/")) return;
    const me = ctx.me.username;
    const priv = ctx.chat.type === "private";
    const mentioned = text.toLowerCase().includes(`@${me.toLowerCase()}`);
    const replied = ctx.msg.reply_to_message?.from?.id === ctx.me.id;
    if (!priv && !mentioned && !replied) return;
    text = text.replace(new RegExp(`@${me}`, "ig"), "").trim();
    if (!text) return ctx.reply("I’m here. Tell me what happened, or ask a question.", { reply_markup: menu() });

    await ctx.replyWithChatAction("typing");
    try {
      const digest = text.match(DIGEST_RE)?.[0];
      if (digest) return await verifyAndSave(ctx, digest, text.match(/\d{4}-\d{2}-\d{2}/)?.[0]);

      const u = await understand(text, nameOf(ctx));
      if (u.intent === "log" && u.fact && TYPES.includes(u.type)) {
        const id = String(++pendingSeq);
        pending.set(id, { circle: circleOf(ctx), by: nameOf(ctx), userId: ctx.from.id, type: u.type, text: u.fact });
        if (pending.size > 200) pending.delete(pending.keys().next().value);
        return await ctx.reply(`Save this to the Circle’s memory?\n\n${u.type.toUpperCase()} · ${u.fact}`, {
          reply_markup: new InlineKeyboard().text("Save to memory", `save:${id}`).text("Discard", `drop:${id}`),
        });
      }
      if (u.intent === "ask") return await answer(ctx, text);
      await ctx.reply("I can remember what happens in this Circle, or answer from what it has already recorded. Tell me what happened, or ask a question.", { reply_markup: menu() });
    } catch (e) {
      await ctx.reply(`Something went wrong: ${e.message}`);
    }
  });

  bot.callbackQuery(/^save:(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    const p = pending.get(id);
    if (!p) return ctx.answerCallbackQuery({ text: "That one expired. Send it again." });
    if (p.userId !== ctx.from.id) return ctx.answerCallbackQuery({ text: `Only ${p.by} can confirm this.` });
    await ctx.answerCallbackQuery({ text: "Saving to Walrus…" });
    try {
      const r = await remember(p.circle, { type: p.type, by: p.by, text: p.text });
      pending.delete(id);
      await ctx.editMessageText(`Saved to Walrus.\n\n${p.type.toUpperCase()} · ${p.text}\n\nBlob: ${r.blobId}`);
    } catch (e) {
      await ctx.editMessageText(`Couldn’t save that: ${e.message}`);
    }
  });

  bot.callbackQuery(/^drop:(\d+)$/, async (ctx) => {
    pending.delete(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Discarded." });
    await ctx.editMessageText("Discarded. Nothing was saved.");
  });

  bot.callbackQuery("menu:log", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Just tell me what happened, in your own words.\n\n“Dan paid his share of rent today, 3 days late”\n“Tobi promised to cover next month’s utilities”\n“We agreed the shared fund tops up every Friday”");
  });
  bot.callbackQuery("menu:ask", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Ask me anything about your group.\n\n“Who should I remind about rent?”\n“Has anyone been covering the bills?”\n“What did we agree about the shared fund?”");
  });
  bot.callbackQuery("menu:open", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking what’s still open…" });
    try { await answer(ctx, OPEN_Q, { limit: 30 }); } catch (e) { await ctx.reply(`Something went wrong: ${e.message}`); }
  });
  bot.callbackQuery("menu:brief", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Reading the Circle’s memory…" });
    try { await answer(ctx, BRIEF_Q, { limit: 20 }); } catch (e) { await ctx.reply(`Something went wrong: ${e.message}`); }
  });
  bot.callbackQuery("menu:how", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Every chat is its own Circle with its own memory on Walrus. When you tell me something, I show it back to you first, and it’s only saved when you confirm. When you ask a question, I read the Circle’s history before I answer and say how many records I used.\n\nPaste a Sui transaction digest and I’ll read it from the chain through Tatum, check who paid, how much and when, and save it as a verified payment.");
  });

  bot.catch((err) => console.error("bot error:", err.error ?? err));

  // Set up the bot's profile and command menu automatically, so BotFather isn't needed.
  async function configureProfile() {
    try {
      await bot.api.setMyName("Circle Memory");
      await bot.api.setMyShortDescription("A shared memory for your group.");
      await bot.api.setMyDescription("Circle Memory keeps one shared memory for your group: expenses, promises, payments and decisions. Tap Start, tell me what happened in plain words, and ask me anything. I answer from what your group actually did.");
      await bot.api.setMyCommands([
        { command: "start", description: "Start Circle Memory in this chat" },
        { command: "ask", description: "Ask a question about your Circle" },
        { command: "open", description: "What promises are still open" },
        { command: "brief", description: "Who pays on time, who doesn’t" },
        { command: "compare", description: "Answer with memory off vs on" },
        { command: "paid", description: "Verify a Sui payment by its digest" },
        { command: "expense", description: "Log a shared expense" },
        { command: "promise", description: "Log a promise" },
        { command: "payment", description: "Log a payment" },
        { command: "decision", description: "Log a group decision" },
      ]);
    } catch (e) {
      console.warn("Skipped bot profile setup:", e.message);
    }
  }

  if (!webhook) {
    await bot.start({ onStart: async (me) => { console.log(`Circle Memory bot running as @${me.username}`); await configureProfile(); } });
    return;
  }

  // Webhook mode for free hosting: the service can sleep and Telegram wakes it with each message.
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Set PUBLIC_URL to this service’s https address (Render sets RENDER_EXTERNAL_URL itself)");
  const secret = createHash("sha256").update(token).digest("hex");
  const { readFile } = await import("node:fs/promises");
  await bot.init();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/telegram") {
        if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return void res.writeHead(401).end();
        let body = "";
        for await (const chunk of req) body += chunk;
        res.writeHead(200).end("ok"); // answer Telegram at once; the work continues in the background
        bot.handleUpdate(JSON.parse(body)).catch((e) => console.error("update error:", e));
        return;
      }
      if (req.url === "/healthz") return void res.writeHead(200).end("ok");
      if (req.url === "/proof.json") {
        try { return void res.writeHead(200, { "content-type": "application/json" }).end(await readFile(new URL("./proof.json", import.meta.url))); }
        catch { return void res.writeHead(404).end(); }
      }
      if (req.url === "/" || req.url === "/index.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LANDING);
      res.writeHead(404).end("Not found");
    } catch (e) {
      console.error(e);
      res.writeHead(500).end();
    }
  });
  server.listen(Number(process.env.PORT) || 3000, async () => {
    await bot.api.setWebhook(`${base}/telegram`, { secret_token: secret, allowed_updates: ["message", "callback_query", "my_chat_member"] });
    console.log(`Webhook set: ${base}/telegram`);
    await configureProfile();
  });
}

/* ------------------------------ landing page ------------------------------- */

const LANDING = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Circle Memory</title>
<meta name="description" content="Circle Memory is a shared memory for groups. An agent reads what your group actually did before it answers."><meta name="theme-color" content="#070c2b"><meta property="og:title" content="Circle Memory"><meta property="og:description" content="Groups forget. Circle Memory doesn’t."><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23070c2b'/%3E%3Cg fill='none' stroke='%23ebe8e1' stroke-width='6'%3E%3Ccircle cx='60' cy='42' r='30'/%3E%3Ccircle cx='42' cy='73' r='30'/%3E%3Ccircle cx='78' cy='73' r='30'/%3E%3C/g%3E%3Ccircle cx='60' cy='62' r='8' fill='%23ff9fc8'/%3E%3C/svg%3E">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#070c2b;--fg:#ebe8e1;--mut:#7f86a8;--line:rgba(235,232,225,.14);--acc:#ff9fc8;
--sans:'Space Grotesk',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;
box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color-scheme:dark}
html{scroll-padding-top:env(safe-area-inset-top,0px);scroll-behavior:smooth}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font:400 17px/1.55 var(--sans);overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
.mono{font:400 12px/1.5 var(--mono);letter-spacing:.02em;color:var(--mut)}
.mono b{color:var(--fg);font-weight:500}

/* welcome */
body:not(.go){overflow:hidden}
#pre{position:fixed;inset:0;z-index:50;display:grid;place-items:center;cursor:pointer}
#pre.gone{visibility:hidden;pointer-events:none}
#pre .h{position:absolute;left:0;right:0;height:50.3%;background:var(--bg);transition:transform 1.05s cubic-bezier(.77,0,.18,1)}
#pre .h1{top:0;border-bottom:1px solid var(--line)}#pre .h2{bottom:0}
#pre.out .h1{transform:translateY(-101%)}#pre.out .h2{transform:translateY(101%)}
#pre .c,#pre .m{position:relative;transition:opacity .45s}
#pre.out .c,#pre.out .m{opacity:0}
#pre .c{text-align:center;padding:0 24px}
#pre svg{width:128px;height:128px;display:block;margin:0 auto 26px;overflow:visible}
.d{fill:none;stroke:var(--fg);stroke-width:1.6;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.2s cubic-bezier(.65,0,.25,1) forwards}
.d:nth-child(2){animation-delay:.3s}.d:nth-child(3){animation-delay:.6s}
.f{fill:var(--acc);opacity:0;transform-origin:60px 62px;animation:pop .5s 1.7s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pop{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:none}}
@keyframes fadein{to{opacity:1;transform:none}}
#pw{font:700 clamp(26px,5vw,38px)/1 var(--sans);letter-spacing:-.035em;min-height:1em}
#pw span{display:inline-block;opacity:0;transform:translateY(.5em);animation:fadein .5s forwards}
.tg{margin-top:16px;font:400 15px var(--mono);color:var(--mut)}
.tg span{display:block;opacity:0;animation:fadein .6s forwards}
.tg span:nth-child(1){animation-delay:2.3s}.tg span:nth-child(2){animation-delay:2.9s;color:var(--acc)}
#pre .m{position:absolute;bottom:calc(24px + env(safe-area-inset-bottom,0px))}
#pre .cnt{left:24px}#pre .sk{right:24px}
/* nav */
nav{display:flex;align-items:center;justify-content:space-between;height:64px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font:700 17px var(--sans);letter-spacing:-.02em}
.brand svg{width:22px;height:22px}
nav .r{display:flex;gap:28px;font:400 13px var(--mono)}
nav .r a{color:var(--mut)}nav .r a:hover{color:var(--fg)}

/* hero */
.hero{position:relative;padding:84px 0 72px;border-bottom:1px solid var(--line);
background:linear-gradient(var(--line),var(--line)) 33.33% 0/1px 100% no-repeat,linear-gradient(var(--line),var(--line)) 66.66% 0/1px 100% no-repeat}
.eyebrow{margin-bottom:26px}
h1{font:500 clamp(46px,8.4vw,112px)/.94 var(--sans);letter-spacing:-.045em;max-width:9.5em}
h1 span{color:var(--mut)}
.lead{max-width:470px;margin-top:34px;color:#c9c6bf}
.cta{display:flex;gap:14px;flex-wrap:wrap;margin-top:34px}
.btn{font:500 14px var(--mono);padding:14px 20px;border:1px solid var(--fg);border-radius:2px;transition:background .15s,color .15s}
.btn.p{background:var(--acc);border-color:var(--acc);color:#14091a}
.btn:hover{background:var(--fg);color:var(--bg);border-color:var(--fg)}

/* 3D wireframe mark */
.stage{position:absolute;right:24px;top:56px;width:230px;perspective:800px;text-align:center}
.tilt{width:190px;height:190px;margin:0 auto 14px;transform-style:preserve-3d;transform:rotateX(var(--rx,-16deg)) rotateY(var(--ry,0deg));transition:transform .3s ease-out}
.gyro{position:relative;width:100%;height:100%;transform-style:preserve-3d;animation:spin 22s linear infinite}
.ring{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(235,232,225,.7);transform-style:preserve-3d}
.ring:nth-child(2){transform:rotateY(60deg)}.ring:nth-child(3){transform:rotateY(120deg)}
.ring::after{content:"";position:absolute;left:50%;top:-4px;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--fg)}
.ring:nth-child(1)::after{background:var(--acc)}
.core{position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px;border-radius:50%;background:var(--acc)}
@keyframes spin{to{transform:rotateY(360deg) rotateZ(360deg)}}

/* sections */
.sec{display:grid;grid-template-columns:1fr 2fr;gap:40px;padding:72px 0;border-bottom:1px solid var(--line)}
h2{font:500 clamp(28px,3.6vw,44px)/1.05 var(--sans);letter-spacing:-.035em;max-width:11em}
.sec .l p{margin-top:16px;color:var(--mut);max-width:300px;font-size:15px}

table{width:100%;border-collapse:collapse;font:400 13px/1.4 var(--mono)}
th{text-align:left;font-weight:400;color:var(--mut);padding:0 12px 12px 0;border-bottom:1px solid var(--line)}
td{padding:13px 12px 13px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child,td:nth-child(3){color:var(--mut);white-space:nowrap}
td .t{color:var(--acc)}
tr.new td{animation:row .5s both}
@keyframes row{from{opacity:0;transform:translateY(-6px)}}

.cmp{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line)}
.cmp>div{padding:26px}
.cmp>div+div{border-left:1px solid var(--line)}
.cmp h3{font:400 12px var(--mono);color:var(--mut);margin-bottom:20px;display:flex;justify-content:space-between}
.q{font:400 13px var(--mono);color:var(--mut);margin-bottom:16px}
.cmp .a{font:500 20px/1.3 var(--sans);letter-spacing:-.02em;min-height:130px}
.trace{margin-top:22px;padding-top:14px;border-top:1px dashed var(--line)}
.on h3 span:last-child{color:var(--acc)}

.steps div{display:grid;grid-template-columns:64px 160px 1fr;gap:12px;padding:22px 0;border-bottom:1px solid var(--line)}
.steps div:first-child{padding-top:0}
.steps b{font:500 20px var(--sans);letter-spacing:-.02em}
.steps p{color:#c9c6bf;font-size:15px}

.final{padding:96px 0 80px;border-bottom:1px solid var(--line)}
.final h2{font-size:clamp(36px,6vw,76px);max-width:10em}
footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:24px 0 40px}

@media(max-width:860px){
.stage{position:static;margin:0 0 30px;width:150px;text-align:left}.tilt{width:130px;height:130px;margin:0 0 10px}
.hero{padding-top:40px;background:none}.sec{grid-template-columns:1fr;gap:24px}
.cmp{grid-template-columns:1fr}.cmp>div+div{border-left:0;border-top:1px solid var(--line)}
.steps div{grid-template-columns:40px 1fr}.steps p{grid-column:2}
td:nth-child(3){display:none}nav .r a:not(:last-child){display:none}}
@media(prefers-reduced-motion:reduce){.gyro,.d,.f,#pre .w,#pre .mono::after,tr.new td{animation:none!important}.d{stroke-dashoffset:0}.f,#pre .w{opacity:1}}

/* ux layer */
:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
::selection{background:var(--acc);color:#14091a}
#bar{position:fixed;top:0;left:0;right:0;height:2px;background:var(--acc);transform:scaleX(0);transform-origin:0 50%;z-index:40}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:19}
nav{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;background:rgba(7,12,43,.82);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.brand svg{transition:transform .6s cubic-bezier(.2,.8,.2,1)}.brand:hover svg{transform:rotate(120deg)}
nav .r a{position:relative}nav .r a::after{content:"";position:absolute;left:0;right:0;bottom:-4px;height:1px;background:var(--acc);transform:scaleX(0);transform-origin:0 50%;transition:transform .3s}
nav .r a:hover::after{transform:scaleX(1)}
.btn::after{content:" \2192";display:inline-block;transition:transform .2s}.btn:hover::after{transform:translateX(4px)}
h1 .ln{display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.1em;color:var(--fg)}
h1 .ln.mu{color:var(--mut)}
h1 .ln i{display:inline-block;font-style:normal;transform:translateY(112%);transition:transform 1.1s cubic-bezier(.2,.8,.2,1)}
.go h1 .ln i{transform:none}.go h1 .ln.mu i{transition-delay:.14s}
.eyebrow,.lead,.cta,.stage{opacity:0;transform:translateY(16px);transition:opacity .9s,transform .9s cubic-bezier(.2,.8,.2,1)}
.go .eyebrow,.go .lead,.go .cta,.go .stage{opacity:1;transform:none}
.go .eyebrow{transition-delay:.05s}.go .lead{transition-delay:.35s}.go .cta{transition-delay:.5s}.go .stage{transition-delay:.7s}
.rv{opacity:0;transform:translateY(24px);transition:opacity .9s,transform .9s cubic-bezier(.2,.8,.2,1)}.rv.in{opacity:1;transform:none}
tbody tr:hover td{background:rgba(235,232,225,.035)}
.steps div{transition:padding-left .3s}.steps div:hover{padding-left:12px}
@media(prefers-reduced-motion:reduce){.rv,.eyebrow,.lead,.cta,.stage,h1 .ln i{opacity:1!important;transform:none!important;transition:none!important}}
</style>
</head>
<body>

<div id="bar"></div>
<div id="pre" role="dialog" aria-label="Welcome to Circle Memory">
  <div class="h h1"></div><div class="h h2"></div>
  <div class="c">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="d" pathLength="1" cx="60" cy="42" r="30"/>
      <circle class="d" pathLength="1" cx="42" cy="73" r="30"/>
      <circle class="d" pathLength="1" cx="78" cy="73" r="30"/>
      <circle class="f" cx="60" cy="62" r="6"/>
    </svg>
    <p id="pw" aria-label="Circle Memory"></p>
    <p class="tg"><span>Groups forget.</span><span>Circle Memory doesn’t.</span></p>
  </div>
  <span class="mono m cnt" id="cn">000</span><span class="mono m sk">Click to enter</span>
</div>

<div class="wrap">
  <nav>
    <a class="brand" href="#top">
      <svg viewBox="0 0 120 120" aria-hidden="true"><g fill="none" stroke="#ebe8e1" stroke-width="6"><circle cx="60" cy="42" r="30"/><circle cx="42" cy="73" r="30"/><circle cx="78" cy="73" r="30"/></g><circle cx="60" cy="62" r="8" fill="#ff9fc8"/></svg>
      Circle Memory
    </a>
    <div class="r"><a href="#log">Log</a><a href="#diff">Memory on/off</a><a href="https://t.me/CircleMemoryBot" target="_blank" rel="noopener">Start a Circle →</a></div>
  </nav>

  <header class="hero" id="top">
    <div class="stage" id="stage" aria-hidden="true">
      <div class="tilt" id="tilt"><div class="gyro"><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="core"></div></div></div>
      <span class="mono">fig. 1: one circle, three people</span>
    </div>
    <p class="mono eyebrow">For every group that has said “I thought you were handling that”</p>
    <h1><span class="ln"><i>Groups forget.</i></span> <span class="ln mu"><i>Circle Memory doesn’t.</i></span></h1>
    <p class="lead">Tell it what happened in plain words. Every expense, promise and payment goes into a memory the whole group shares, and an agent reads that history before it answers, so its advice comes from what your group actually did.</p>
    <div class="cta"><a class="btn p" href="https://t.me/CircleMemoryBot" target="_blank" rel="noopener">Start a Circle</a><a class="btn" href="#diff">See what changes</a></div>
  </header>

  <section class="sec" id="log">
    <div class="l"><h2>An append-only log of what happened.</h2><p>Each entry records who, when and what came next. Sample data shown.</p></div>
    <div>
      <table><thead><tr><th>time</th><th>type</th><th>by</th><th>record</th></tr></thead><tbody id="tl"></tbody></table>
      <p class="mono" style="margin-top:14px">circle: flat-4b · entries: <b id="cnt">0</b></p>
    </div>
  </section>

  <section class="sec" id="diff">
    <div class="l"><h2>Same question, different answer.</h2><p>The right column shows the records the agent read before replying.</p></div>
    <div class="cmp">
      <div>
        <h3><span>Without memory</span><span>reads: 0</span></h3>
        <p class="q">&gt; Can you handle rent reminders this month?</p>
        <p class="a">Sure. I’ll send everyone a reminder on the 1st.</p>
        <p class="mono trace">No context. Same message to everyone.</p>
      </div>
      <div class="on">
        <h3><span>With memory</span><span>reads: 5</span></h3>
        <p class="q">&gt; Can you handle rent reminders this month?</p>
        <p class="a">Dan has paid late four of the last five months, so I’ll remind him on the 28th and everyone else on the 1st. Tobi’s promise to cover utilities is still open.</p>
        <p class="mono trace">payment × 4 (late) · promise × 1 (open)</p>
      </div>
    </div>
    <p class="mono" style="grid-column:2;margin-top:-20px">Illustrative example.</p>
  </section>

  <section class="sec">
    <div class="l"><h2>No accounts. Join and go.</h2><p>Add the bot to a chat and start talking. Nothing to sign up for.</p></div>
    <div class="steps">
      <div><span class="mono">01</span><b>Join</b><p>Add @CircleMemoryBot to a Telegram chat. That chat becomes a Circle with its own memory.</p></div>
      <div><span class="mono">02</span><b>Tell it</b><p>Say what happened in your own words. The bot shows what it understood and saves it only when you tap confirm.</p></div>
      <div><span class="mono">03</span><b>Verify</b><p>Paste a Sui transaction digest. The bot reads it from the chain through Tatum, so who paid and when is proven, not claimed.</p></div>
      <div><span class="mono">04</span><b>Ask</b><p>The agent reads the Circle’s history first and cites the records it used.</p></div>
    </div>
  </section>

  <section class="sec" id="proof" hidden>
    <div class="l"><h2>Receipts, not promises.</h2><p>Every memory is a real write to Walrus. Verified payments were read from the Sui chain through Tatum.</p></div>
    <div>
      <table><thead><tr><th>type</th><th>record</th><th>walrus blob</th></tr></thead><tbody id="pf"></tbody></table>
      <p class="mono" style="margin-top:14px" id="pfn"></p>
    </div>
  </section>

  <section class="final" id="join">
    <h2>Give your group a memory.</h2>
    <div class="cta"><a class="btn p" href="https://t.me/CircleMemoryBot" target="_blank" rel="noopener">Start a Circle</a><a class="btn" href="https://t.me/CircleMemoryBot" target="_blank" rel="noopener">Open Telegram bot</a></div>
  </section>

  <footer class="mono"><span>© 2026 Circle Memory</span><span>Built on Walrus Memory and Tatum</span></footer>
</div>

<script>
(function(){
  var el=document.getElementById('pre'),pw=document.getElementById('pw'),cn=document.getElementById('cn'),fin=false,seen=false,rm=matchMedia('(prefers-reduced-motion:reduce)').matches;
  try{seen=sessionStorage.getItem('cm')==='1'}catch(e){}
  "Circle Memory".split('').forEach(function(c,i){var s=document.createElement('span');s.textContent=c===' '?'\u00a0':c;s.style.animationDelay=(1.5+i*.045)+'s';pw.appendChild(s)});
  function close(){
    if(fin)return;fin=true;el.classList.add('out');document.body.classList.add('go');
    setTimeout(function(){el.classList.add('gone')},1150);
    try{sessionStorage.setItem('cm','1')}catch(e){}
  }
  if(seen||rm){el.classList.add('gone');document.body.classList.add('go');fin=true}
  else{
    var t0=performance.now();
    (function tick(t){var p=Math.min(1,(t-t0)/4200);cn.textContent=('00'+Math.round(p*100)).slice(-3);if(fin)return;if(p<1)requestAnimationFrame(tick);else close()})(t0);
    el.addEventListener('click',close);
    addEventListener('keydown',function(e){if(e.key==='Enter'||e.key==='Escape')close()});
  }

  fetch('proof.json').then(function(r){return r.ok?r.json():null}).then(function(d){
    if(!d||!d.items||!d.items.length)return;
    var tb=document.getElementById('pf');
    d.items.slice().reverse().forEach(function(it){
      var m=/^\[(\w+)\]\s*/.exec(it.text),tr=document.createElement('tr');
      [m?m[1]:'',it.text.replace(/^\[\w+\]\s*/,''),it.blobId?it.blobId.slice(0,10)+'\u2026':''].forEach(function(v,i){
        var td=document.createElement('td');
        if(i===0){var sp=document.createElement('span');sp.className='t';sp.textContent=v;td.appendChild(sp)}else td.textContent=v;
        if(i===2){td.title=it.blobId||'';td.style.whiteSpace='nowrap'}
        tr.appendChild(td)});
      tb.appendChild(tr)});
    document.getElementById('pfn').textContent=d.items.length+' writes from a demo Circle with sample people'+(d.verified?' \u00b7 '+d.verified+' verified on Sui via Tatum':'');
    document.getElementById('proof').hidden=false;
  }).catch(function(){});
  var bar=document.getElementById('bar');
  addEventListener('scroll',function(){var h=document.documentElement;bar.style.transform='scaleX('+(h.scrollTop/(h.scrollHeight-h.clientHeight||1))+')'},{passive:true});
  var rvs=document.querySelectorAll('.sec>*,.final>*,.panel');
  [].forEach.call(rvs,function(n){n.classList.add('rv')});
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.12});
    [].forEach.call(rvs,function(n){io.observe(n)});
  }else{[].forEach.call(rvs,function(n){n.classList.add('in')})}

  var data=[
    ['expense','maya','Groceries £84, split 4 ways'],
    ['promise','dan','Rent by the 1st'],
    ['payment','dan','Rent paid on the 4th (+3 days)'],
    ['decision','circle','Shared fund tops up on Fridays'],
    ['expense','tobi','Internet bill £32'],
    ['payment','dan','Rent paid on the 5th (+4 days)'],
    ['promise','tobi','Will cover utilities next month'],
    ['decision','agent','Remind dan on the 28th']
  ],tl=document.getElementById('tl'),cnt=document.getElementById('cnt'),i=0,h=9,m=12;
  function add(){
    var d=data[i%data.length],r=document.createElement('tr');r.className='new';
    r.innerHTML='<td>'+('0'+h).slice(-2)+':'+('0'+m).slice(-2)+'</td><td><span class="t">'+d[0]+'</span></td><td>'+d[1]+'</td><td>'+d[2]+'</td>';
    tl.insertBefore(r,tl.firstChild);
    while(tl.children.length>6)tl.removeChild(tl.lastChild);
    m+=7+i%5;if(m>59){m-=60;h++}
    i++;cnt.textContent=i;
  }
  for(var k=0;k<5;k++)add();setInterval(add,2600);

  var st=document.getElementById('stage'),t=document.getElementById('tilt');
  document.addEventListener('pointermove',function(e){
    var r=st.getBoundingClientRect(),x=(e.clientX-(r.left+r.width/2))/innerWidth,y=(e.clientY-(r.top+r.height/2))/innerHeight;
    t.style.setProperty('--ry',(x*50)+'deg');t.style.setProperty('--rx',(-16-y*40)+'deg');
  });
})();
</script>
</body>
</html>
`;

function runServe() {
  const port = Number(process.env.PORT) || 3000;
  createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LANDING);
    } else {
      res.writeHead(404).end("Not found");
    }
  }).listen(port, () => console.log(`Landing page on http://localhost:${port}`));
}

/* ----------------------------------- cli ----------------------------------- */

const USAGE = `Usage:
  node circle-memory.mjs bot                      Telegram bot on this computer
  node circle-memory.mjs host                     Telegram bot for free hosting (webhook)
  node circle-memory.mjs seed [circle]
  node circle-memory.mjs compare [circle] [question...]
  node circle-memory.mjs doctor                   check every connection at once
  node circle-memory.mjs proof [circle]           write proof.json for the website
  node circle-memory.mjs chain                    check the Tatum Sui connection
  node circle-memory.mjs verify <digest> [due]   read a Sui payment through Tatum
  node circle-memory.mjs serve`;

async function main() {
  try { await import("dotenv/config"); } catch { /* dotenv optional if env is already set */ }
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "serve") return runServe();
  if (cmd === "bot") return runBot();
  if (cmd === "host") return runBot({ webhook: true });

  if (cmd === "seed") {
    const circle = args[0] || "flat-4b";
    for (const [i, [type, by, date, text]] of SEED.entries()) {
      const r = await remember(circle, { type, by, date, text });
      console.log(`${i + 1}/${SEED.length} ${type.padEnd(8)} blob ${r.blobId}`);
    }
    closeAll();
    return console.log("Done. Receipts are in receipts.jsonl");
  }

  if (cmd === "compare") {
    const circle = args[0] || "flat-4b";
    const question = args.slice(1).join(" ") || "Can you handle rent reminders this month?";
    const off = await advise(circle, question, { useMemory: false });
    const on = await advise(circle, question);
    console.log(`\nQ: ${question}\n\n--- MEMORY OFF ---\n${off.answer}`);
    console.log(`\n--- MEMORY ON (${on.reads.length} records read) ---\n${on.answer}\n`);
    on.reads.forEach((r, i) => console.log(`[${i + 1}] ${r.text}`));
    return closeAll();
  }

  if (cmd === "doctor") {
    const ok = (m) => console.log(`  ok    ${m}`);
    const bad = (m, e) => console.log(`  FAIL  ${m}: ${e?.message || e}`);
    const need = ["MEMWAL_ACCOUNT_ID", "MEMWAL_SERVER_URL", "MEMWAL_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "TATUM_API_KEY"];
    const missing = need.filter((k) => !process.env[k]);
    console.log("Circle Memory check\n");
    missing.length ? bad("settings", `missing ${missing.join(", ")}`) : ok("settings present");
    try { await recall(args[0] || "flat-4b", "rent", 1); ok("Walrus Memory: can read the demo Circle"); } catch (e) { bad("Walrus Memory", e); }
    try { const t = await complete("Reply with the single word OK.", "ping"); ok(`AI model replied: ${t.slice(0, 20)}`); } catch (e) { bad("AI model", e); }
    try {
      const c = await suiGrpc();
      const r = await suiCall(c, "GetCheckpoint", { read_mask: { paths: ["sequence_number"] } });
      ok(`Tatum Sui gRPC: latest checkpoint ${r.checkpoint?.sequence_number ?? r.sequence_number}`);
    } catch (e) { bad("Tatum Sui gRPC", e); }
    try {
      const j = await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)).json();
      j.ok ? ok(`Telegram: bot @${j.result.username} is reachable`) : bad("Telegram", j.description);
    } catch (e) { bad("Telegram", e); }
    closeAll();
    return process.exit(0);
  }

  if (cmd === "proof") {
    const { readFile, writeFile } = await import("node:fs/promises");
    const circle = args[0] || "flat-4b";
    let rows;
    try { rows = (await readFile(RECEIPTS, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return console.log("No receipts.jsonl yet. Run the seed first."); }
    const items = rows.filter((r) => r.circle === namespaceFor(circle)).slice(-24).map((r) => ({ text: r.text, blobId: r.blobId, at: r.at }));
    const verified = items.filter((i) => i.text.includes("Verified on Sui via Tatum")).length;
    await writeFile(new URL("./proof.json", import.meta.url), JSON.stringify({ circle, updated: new Date().toISOString(), verified, items }, null, 2));
    return console.log(`Wrote proof.json with ${items.length} writes for ${circle} (${verified} verified on Sui). Commit it next to index.html.`);
  }

  if (cmd === "chain") {
    const c = await suiGrpc();
    console.log(`Tatum Sui gRPC gateway: ${c.host}`);
    const r = await suiCall(c, "GetCheckpoint", { read_mask: { paths: ["sequence_number", "digest"] } });
    console.log("Latest checkpoint:", r.checkpoint?.sequence_number ?? r.sequence_number);
    return;
  }

  if (cmd === "verify") {
    const [digest, due] = args;
    if (!digest) return console.log("Usage: node circle-memory.mjs verify <tx digest> [due YYYY-MM-DD]");
    return console.log((await verifyPayment(digest, due)).text);
  }

  console.log(USAGE);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
