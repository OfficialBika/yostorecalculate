// Yostore Calculator Bot 
// -------------------------------------------------------

require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { create, all } = require("mathjs");
const mongoose = require("mongoose");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");

const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const PORT = parseInt(process.env.PORT || "8080", 10);
const OWNER_IDS = String(process.env.OWNER_IDS || process.env.OWNER_ID || "")
  .split(",")
  .map(s => Number(String(s).trim()))
  .filter(n => Number.isFinite(n) && n > 0);

function isOwner(ctx) {
  return OWNER_IDS.includes(ctx.from?.id);
}
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");

const math = create(all, { number: "number" });
const bot = new Telegraf(BOT_TOKEN);

// -------------------- MongoDB Models --------------------
const userSchema = new mongoose.Schema(
  {
    userId: { type: Number, unique: true, index: true },
    firstName: String,
    lastName: String,
    username: String,
    languageCode: String,
    isBot: Boolean,
    isBlocked: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const groupSchema = new mongoose.Schema(
  {
    chatId: { type: Number, unique: true, index: true },
    title: String,
    type: String, // group / supergroup
    isActive: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const Group = mongoose.model("Group", groupSchema);

// -------------------- Runtime State --------------------
const startTime = Date.now();
const adminCache = new Map(); // chatId -> boolean
const state = new Map(); // chatId -> { expr, result, msgId }

// -------------------- Helper: Safe Eval --------------------
function safeEval(expr) {
  let s = String(expr || "").trim();
  s = s
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/—/g, "-")
    .replace(/−/g, "-")
    .replace(/,/g, "");

  const blocked =
    /(import|createUnit|evaluate|parse|simplify|derivative|compile|help|unit|format|typed|reviver|json|chain|matrix|ones|zeros|range|index|subset|concat|resize)/i;
  if (blocked.test(s)) throw new Error("Unsupported expression.");

  const allowed = /^[0-9+\-*/().\s^%piePIE]*$/;
  if (!allowed.test(s)) throw new Error("Invalid characters.");

  const result = math.evaluate(s);

  if (typeof result === "number") {
    if (!isFinite(result)) throw new Error("Result is not finite.");
    const rounded = Math.round((result + Number.EPSILON) * 1e12) / 1e12;
    return String(rounded);
  }
  return String(result);
}

// -------------------- Helper: Keyboard + UI --------------------
function kb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("7", "k:7"),
      Markup.button.callback("8", "k:8"),
      Markup.button.callback("9", "k:9"),
      Markup.button.callback("÷", "k:/"),
    ],
    [
      Markup.button.callback("4", "k:4"),
      Markup.button.callback("5", "k:5"),
      Markup.button.callback("6", "k:6"),
      Markup.button.callback("×", "k:*"),
    ],
    [
      Markup.button.callback("1", "k:1"),
      Markup.button.callback("2", "k:2"),
      Markup.button.callback("3", "k:3"),
      Markup.button.callback("-", "k:-"),
    ],
    [
      Markup.button.callback("0", "k:0"),
      Markup.button.callback(".", "k:."),
      Markup.button.callback("(", "k:("),
      Markup.button.callback(")", "k:)"),
    ],
    [
      Markup.button.callback("C", "k:C"),
      Markup.button.callback("⌫", "k:BS"),
      Markup.button.callback("+", "k:+"),
      Markup.button.callback("=", "k:="),
    ],
  ]);
}

function renderUI(expr, result) {
  const e = expr?.length ? expr : " ";
  const r = result?.length ? result : " ";
  return `🧮 Yo! Store Calculator\n\nExpr: ${e}\nResult: ${r}\n\nTip: Inline → Bot Username 12*(3+4)`;
}

// -------------------- Helper: Uptime format --------------------
function formatUptime(ms) {
  let sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  sec %= 86400;
  const hours = Math.floor(sec / 3600);
  sec %= 3600;
  const mins = Math.floor(sec / 60);
  sec %= 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

// -------------------- Helper: Track users/groups into DB --------------------
async function trackContext(ctx) {
  const ops = [];

  if (ctx.from && ctx.from.id) {
    const u = ctx.from;
    ops.push(
      User.findOneAndUpdate(
        { userId: u.id },
        {
          $set: {
            firstName: u.first_name || "",
            lastName: u.last_name || "",
            username: u.username || "",
            languageCode: u.language_code || "",
            isBot: u.is_bot || false,
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            isBlocked: false,
          },
        },
        { upsert: true, new: true }
      ).exec()
    );
  }

  if (
    ctx.chat &&
    (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
  ) {
    const c = ctx.chat;
    ops.push(
      Group.findOneAndUpdate(
        { chatId: c.id },
        {
          $set: {
            title: c.title || "",
            type: c.type,
            isActive: true,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true, new: true }
      ).exec()
    );
  }

  if (ops.length) {
    try {
      await Promise.all(ops);
    } catch (err) {
      console.error("trackContext error:", err.message);
    }
  }
}

// Non-blocking helper (speed up response)
function trackContextAsync(ctx) {
  trackContext(ctx).catch((err) => {
    console.error("trackContext async error:", err.message);
  });
}

// -------------------- Helper: Bot admin in group? --------------------
async function isBotAdminInChat(ctx) {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup"))
    return false;

  const chatId = chat.id;
  if (adminCache.has(chatId)) {
    return adminCache.get(chatId);
  }

  try {
    const me = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
    const isAdmin = me.status === "administrator" || me.status === "creator";
    adminCache.set(chatId, isAdmin);
    return isAdmin;
  } catch (err) {
    console.error("getChatMember failed:", err.message);
    adminCache.set(chatId, false);
    return false;
  }
}

// -------------------- Handle my_chat_member (join/leave groups) --------------------
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const status = ctx.myChatMember?.new_chat_member?.status;
  if (!status) return;

  try {
    if (status === "left" || status === "kicked") {
      await Group.findOneAndUpdate(
        { chatId: chat.id },
        { $set: { isActive: false, lastSeenAt: new Date() } }
      ).exec();
      adminCache.delete(chat.id);
    } else if (status === "member" || status === "administrator") {
      await Group.findOneAndUpdate(
        { chatId: chat.id },
        {
          $set: {
            title: chat.title || "",
            type: chat.type,
            isActive: true,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true }
      ).exec();
    }
  } catch (err) {
    console.error("my_chat_member handler error:", err.message);
  }
});

// -------------------- Commands --------------------

// /start => Bot အလုပ်လုပ်ပုံရှင်းပြ (UI မထည့်တော့)
bot.start(async (ctx) => {
  trackContextAsync(ctx);

  const text =
    "🧮 *Yo! Store Calculator Bot* မှ ကြိုဆိုပါတယ်!\n\n" +
    "ဒီ Bot လေးနဲ့ အောက်မှာလို လုပ်ဆောင်နိုင်ပါတယ် 👇\n\n" +
    "• bot ဆီကို မိမိတွက်ချက်ချင်တဲ့ ကိန်းဂဏန်း တိုက်ရိုက်ပို့လို့ရ\n" +
    "• `/calculator` – Calculator UI ဖွင့်ပြီး button နဲ့တွက်ချင်ရင်လဲရ\n" +
    "• `/calc 12*(3+4)` – Command နဲ့ တစ်ကြိမ်တည်း တွက်ချင်ရင်\n" +
    "• Group ထဲမှာ `4*5` လို ရေးပို့ရင် (bot ကို adminပေးထားရမယ်) => `4×5 = 20` လို့ auto ပြန်ပေးမယ်\n" +
    "• Inline mode: `မိမိပို့လိုတဲ့ private Chat မှာ @YoCalcuBot 12+3` လို ရိုက်ပြီး private chat ထဲသို့ ရလဒ် ပို့လို့ရမယ်\n\n" +
    "Admin (Owner Only) 🛡\n" +
    "• `/admin` – Bot Users, Groups, Uptime စတာတွေ ကြည့်ရန်\n" +
    "• `/broadcast Your message` – Bot အသုံးပြုနေသူတွေကို အကြောင်းကြားဖို့\n\n";
    
  return ctx.reply(text, { parse_mode: "Markdown" });
});

// /calculator => UI Calculator ဖွင့်မယ်
bot.command("calculator", async (ctx) => {
  trackContextAsync(ctx);

  const chatId = ctx.chat.id;
  const s = { expr: "", result: "", msgId: null };
  state.set(chatId, s);

  const msg = await ctx.reply(renderUI("", ""), kb());
  s.msgId = msg.message_id;
});

// /calc => quick calculate
bot.command("calc", async (ctx) => {
  trackContextAsync(ctx);
  const input = ctx.message.text.replace("/calc", "").trim();
  if (!input) return ctx.reply("Usage: /calc 12*(3+4)");

  try {
    const result = safeEval(input);
    return ctx.reply(`🧮 ${input}\n= ${result}`);
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
});

// Owner-only admin dashboard
bot.command("admin", async (ctx) => {
  trackContextAsync(ctx);

  if (!isOwner(ctx)) return ctx.reply("❌ Owner only command.");

  const [totalUsers, totalGroups, activeGroups] = await Promise.all([
    User.countDocuments({}).exec(),
    Group.countDocuments({}).exec(),
    Group.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .limit(30)
      .lean()
      .exec(),
  ]);

  const uptimeMs = Date.now() - startTime;
  const uptimeStr = formatUptime(uptimeMs);

  let groupList = "";
  activeGroups.forEach((g, idx) => {
    groupList += `\n${idx + 1}. ${g.title || "(no title)"} [${g.chatId}]`;
  });
  if (totalGroups > activeGroups.length) {
    groupList += `\n… and more (${totalGroups} groups total)`;
  }

  const text =
    `🔐 Yo! Store Calculator — Admin Dashboard\n\n` +
    `👤 Bot Users: ${totalUsers}\n` +
    `👥 Total Groups (all-time): ${totalGroups}\n` +
    `👥 Active Groups: ${activeGroups.length}\n` +
    `⏱ Uptime: ${uptimeStr}\n` +
    (activeGroups.length ? `\n📜 Active Group List:${groupList}` : "");

  return ctx.reply(text);
});

// Owner-only broadcast
bot.command("broadcast", async (ctx) => {
  trackContextAsync(ctx);

  if (!isOwner(ctx)) return ctx.reply("❌ Owner only command.");

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) {
    return ctx.reply("Usage: /broadcast Your message here");
  }

  const msg = `📢 [Yo! Store Calculator Broadcast]\n\n${args}`;

  const [userDocs, groupDocs] = await Promise.all([
    User.find({ isBlocked: { $ne: true } }).select("userId").lean().exec(),
    Group.find({ isActive: true }).select("chatId").lean().exec(),
  ]);

  let userOk = 0,
    userFail = 0;
  let groupOk = 0,
    groupFail = 0;

  for (const u of userDocs) {
    try {
      await ctx.telegram.sendMessage(u.userId, msg);
      userOk++;
    } catch (_) {
      userFail++;
    }
  }

  for (const g of groupDocs) {
    try {
      await ctx.telegram.sendMessage(g.chatId, msg);
      groupOk++;
    } catch (_) {
      groupFail++;
    }
  }

  return ctx.reply(
    `✅ Broadcast finished.\n\n` +
      `👤 Users: ${userOk} sent, ${userFail} failed.\n` +
      `👥 Groups: ${groupOk} sent, ${groupFail} failed.`
  );
});

// -------------------- Text (Group auto-calc + Private calc) --------------------
bot.on("text", async (ctx) => {
  trackContextAsync(ctx);

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return; // commands handled separately

  // GROUP MODE: auto calc only when bot is admin
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    const isAdmin = await isBotAdminInChat(ctx);
    if (!isAdmin) return;

    try {
      const result = safeEval(text);
      const prettyExpr = text.replace(/\*/g, "×").replace(/\//g, "÷");
      return ctx.reply(`${prettyExpr} = ${result}`);
    } catch (_) {
      return;
    }
  }

  // PRIVATE CHAT: normal calculator with error messages
  if (ctx.chat.type === "private") {
    try {
      const result = safeEval(text);
      return ctx.reply(`🧮 ${text}\n= ${result}`);
    } catch (e) {
      return ctx.reply(`❌ ${e.message}`);
    }
  }
});

// -------------------- Button UI actions --------------------
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.chat.id;
  const data = ctx.callbackQuery.data || "";
  const s = state.get(chatId) || { expr: "", result: "", msgId: null };
  state.set(chatId, s);

  if (!data.startsWith("k:")) return ctx.answerCbQuery();
  const key = data.slice(2);

  if (key === "C") {
    s.expr = "";
    s.result = "";
  } else if (key === "BS") {
    s.expr = s.expr.slice(0, -1);
  } else if (key === "=") {
    try {
      s.result = s.expr ? safeEval(s.expr) : "";
    } catch (e) {
      s.result = `Error: ${e.message}`;
    }
  } else {
    s.expr += key;
  }

  try {
    if (s.msgId) {
      await ctx.telegram.editMessageText(
        chatId,
        s.msgId,
        undefined,
        renderUI(s.expr, s.result),
        kb()
      );
    } else {
      const msg = await ctx.reply(renderUI(s.expr, s.result), kb());
      s.msgId = msg.message_id;
    }
  } catch (_) {
    const msg = await ctx.reply(renderUI(s.expr, s.result), kb());
    s.msgId = msg.message_id;
  }

  return ctx.answerCbQuery();
});

// -------------------- ✅ Inline Mode (UPGRADED) --------------------
bot.on("inline_query", async (ctx) => {
  const q = (ctx.inlineQuery.query || "").trim();

  if (!q) {
    return ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: "hint",
          title: "Yo! Store Calculator Inline",
          description: "Example: 12*(3+4) or 5+6",
          input_message_content: {
            message_text:
              "🧮 Yo! Store Calculator Inline Mode\n\nType something like `12*(3+4)` after @YoCalcuBot to calculate.",
            parse_mode: "Markdown",
          },
        },
      ],
      { cache_time: 1 }
    );
  }

  let title;
  let description;
  let messageText;

  try {
    const r = safeEval(q);
    title = `🧮 ${q} = ${r}`;
    description = "Tap to send this result";
    messageText = `🧮 Yo! Store Calculator\n\n${q} = ${r}`;
  } catch (e) {
    title = `❌ Invalid expression`;
    description = e.message || "Error while calculating";
    messageText = `❌ Yo! Store Calculator\n\nExpression: ${q}\nError: ${description}`;
  }

  return ctx.answerInlineQuery(
    [
      {
        type: "article",
        id: "calc_" + Date.now(),
        title,
        description,
        input_message_content: {
          message_text: messageText,
        },
      },
    ],
    { cache_time: 1 }
  );
});

// -------------------- ✅ Webhook Server (Render) --------------------
const app = express();

app.get("/", (req, res) => res.status(200).send("OK - BIKA Calculator Bot"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.use(express.json());
app.use(bot.webhookCallback("/telegraf"));

async function start() {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
    });
    console.log("✅ MongoDB connected");

    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`🤖 Logged in as @${me.username}`);

    if (!WEBHOOK_URL) {
      await bot.launch();
      console.log("✅ Started with long polling (no WEBHOOK_URL)");
    } else {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegraf`);
      app.listen(PORT, () =>
        console.log(`✅ Webhook server running on ${PORT}`)
      );
    }
  } catch (err) {
    console.error("❌ Failed to start bot:", err);
  }
}

start();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
