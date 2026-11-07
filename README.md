# Circle Memory

**Groups forget. Circle Memory doesn’t.**

Every group runs on promises made in chat: *I’ll pay by Friday*, *I’ll handle it*, *we agreed*. Then the chat scrolls and nobody remembers who owed what. Circle Memory is the missing layer. Tell it what happened in plain words and it keeps every promise, payment and decision with a name and a date, so anyone can ask "what’s still open?" and get an answer backed by records and, for payments, by the Sui chain.

Circle Memory is a shared memory for groups: households, friend groups and small teams. Members write what actually happens (expenses, promises, payments, decisions) into one memory on [Walrus Memory](https://docs.wal.app/walrus-memory). An agent reads that history before it answers, so its advice comes from what the group did, not what it said it would do.

- Telegram bot: [@CircleMemoryBot](https://t.me/CircleMemoryBot)
- Website: `<your deployed URL>`

## How people join

There is no sign-up. No email, no password, no verification code. Add the bot to a Telegram chat (or open a private chat with it) and send `/start`. That chat is now a Circle, and the bot reads only the commands sent to it.

Telegram already knows who each person is, so Circle Memory stores nothing beyond the first name Telegram shows, which is saved inside each memory as "recorded by".

## What it does

Talk to it in plain words: "Maya paid £84 for groceries, split 4 ways" or "Who should I remind about rent?". In a group, mention the bot or reply to it. Before anything is saved, the bot shows it back and waits for a tap on **Save to memory**. The commands below are shortcuts.

| Command | What it does |
| --- | --- |
| `/expense <text>` | Log a shared expense |
| `/promise <text>` | Log a promise someone made |
| `/payment <text>` | Log a payment and whether it was on time |
| `/decision <text>` | Log a group decision |
| `/paid <tx digest> [due YYYY-MM-DD]` | Read a Sui payment through Tatum RPC, check who paid, how much and whether it was late, then save it as a verified memory |
| `/open` | What promises are still open, who owes what, and what is overdue |
| `/brief` | Who pays on time, who pays late, and which promises are open |
| `/ask <question>` | Ask for advice, answered from the Circle’s memory |
| `/compare <question>` | Show the answer with memory off and with memory on |

Each save returns a Walrus blob ID, and every save is appended to `receipts.jsonl` as a record of the write.

## How it works

- **One namespace per Circle.** Each Telegram chat maps to its own Walrus Memory namespace (`circle-tg<id>`). Nothing is shared between Circles.
- **One fact per memory.** Entries are typed and carry who recorded them and when, written so a stranger could read them without context.
- **Read before answering.** The agent recalls the most relevant memories, passes them to the model as numbered records, and must cite the ones it uses. With memory off, the same model gets no history.
- **Any model.** The agent talks to any OpenAI-compatible endpoint (Groq, Ollama, Gemini, OpenRouter). If `ANTHROPIC_API_KEY` is set it uses Anthropic instead.

Everything lives in one file, `circle-memory.mjs`.

## Tatum on Sui

Self-reported memories can be wrong. `/paid` reads the transaction from Sui through Tatum’s Sui gRPC gateway (`LedgerService/GetTransaction`), takes the sender, recipient, amount and timestamp from the chain, compares the timestamp with the due date, and saves a memory that starts with "Verified on Sui via Tatum". The agent is told to prefer these records over self-reported ones, so "who pays late" is based on chain data, not claims.

Sui has retired JSON-RPC, so the app uses Tatum’s gRPC gateway with the official `sui-apis` protos. All Sui reads go through `suiGrpc` / `suiCall`, and the Tatum API key is sent as `x-api-key` metadata.

## Setup

```bash
npm init -y && npm pkg set type=module
npm i @mysten-incubation/memwal grammy dotenv @grpc/grpc-js @grpc/proto-loader
git clone https://github.com/MystenLabs/sui-apis ~/sui-apis
```

Create a `.env` file:

```
MEMWAL_ACCOUNT_ID=       # MemWal account ID from the Walrus Memory dashboard
MEMWAL_SERVER_URL=       # https://relayer.memory.walrus.xyz (mainnet) or https://relayer.dev.memwal.ai (testnet)
MEMWAL_PRIVATE_KEY=      # delegate key for that account; keep it secret
TELEGRAM_BOT_TOKEN=      # from @BotFather
TATUM_API_KEY=           # free key from the Tatum dashboard
TATUM_SUI_GRPC=          # optional; defaults to sui-mainnet-grpc.gateway.tatum.io:443
SUI_PROTO_DIR=           # optional; defaults to ~/sui-apis/proto
LLM_BASE_URL=            # e.g. https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=               # e.g. llama-3.3-70b-versatile
```

The account ID, key and relayer must all be from the same network (mainnet or testnet).

## Run

```bash
node circle-memory.mjs seed                 # write 18 demo memories to the flat-4b Circle
node circle-memory.mjs compare flat-4b "Can you handle rent reminders this month?"
DEMO_CIRCLE=flat-4b node circle-memory.mjs bot   # bot reads the seeded Circle
node circle-memory.mjs proof flat-4b        # write proof.json (blob IDs) for the website
node circle-memory.mjs chain                # check the Tatum Sui connection
node circle-memory.mjs verify <digest> [due YYYY-MM-DD]
node circle-memory.mjs serve                # serve the landing page on :3000
```

The seeded Circle is sample data about invented people, not real users. Every seed write is a real Walrus Memory write.

## Free hosting (Render)

`node circle-memory.mjs host` runs the bot in webhook mode with a small web server (`/healthz`, `/proof.json`, the landing page). On Render create a **Web Service** from this repo:

- Build command: `npm install && git clone --depth 1 https://github.com/MystenLabs/sui-apis sui-apis`
- Start command: `npm start` (set with `npm pkg set scripts.start="node circle-memory.mjs host"`)
- Environment: everything from `.env`, plus `SUI_PROTO_DIR=./sui-apis/proto` and optionally `PRIVATE_CIRCLE=flat-4b` so private chats open the demo Circle

Render sets `RENDER_EXTERNAL_URL` itself, and the bot registers its webhook on start. Do not run `bot` (polling) on your computer at the same time: it removes the webhook.

## Limits

- Everyone in a Telegram chat shares that Circle’s memory.
- Each write waits for Walrus to confirm, so saving takes a few seconds.
- Answers depend on the model you choose. Smaller models can miscount patterns, so check them against `receipts.jsonl` and your seed data.
- Not load-tested. Built for a hackathon and run by one person.
- For how Walrus Memory handles encryption and access, see its documentation.

## Layout

```
circle-memory.mjs     memory layer, agent, Telegram bot, seed, compare and landing page
receipts.jsonl        written on every save (blob IDs); keep out of git
.env                  secrets; keep out of git
```

Add `.env` and `receipts.jsonl` to `.gitignore`.
