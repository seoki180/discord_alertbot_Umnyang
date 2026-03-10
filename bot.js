require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// 설정 (여기만 수정하세요)
// ─────────────────────────────────────────────
const NOTICE_CHANNEL_ID = process.env.NOTICE_CHANNEL_ID; // 공지 채널 ID
const CHECK_EMOJI = "✅"; // 읽음 확인 이모지
const CHECK_DELAY_MS = 24 * 60 * 60 * 1000; //24 시간 뒤 체크
const DATA_FILE = path.join(__dirname, "data.json"); // 공지 추적 데이터
const UMC10TH = process.env.ROLE_10TH;

const TARGET_ROLE_IDS = [UMC10TH];

const ADMIN_IDS = [process.env.ADMIN_ID]; //사용자 ID
const COMMAND_ALLOWED_ROLE_IDS = [UMC10TH]; //커맨드 사용 역할 ID

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ─── 데이터 관리 ──────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ─── 역할 필터 ────────────────────────────────────────────────────────────────
function isTargetMember(member) {
  if (TARGET_ROLE_IDS.length === 0) return true;
  return TARGET_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

function canUseCommand(member) {
  if (COMMAND_ALLOWED_ROLE_IDS.length === 0) return true;
  return COMMAND_ALLOWED_ROLE_IDS.some((roleId) =>
    member.roles.cache.has(roleId),
  );
}

// ─── 멤버 캐시 ────────────────────────────────────────────────────────────────
const memberFetchPromises = new Map();

async function fetchMembersOnce(guild) {
  if (memberFetchPromises.has(guild.id))
    return memberFetchPromises.get(guild.id);
  const promise = guild.members.fetch().finally(() => {
    setTimeout(() => memberFetchPromises.delete(guild.id), 30_000);
  });
  memberFetchPromises.set(guild.id, promise);
  return promise;
}

// ─── 슬래시 커맨드 등록 ───────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("공지등록")
      .setDescription("과거 공지 메시지를 읽음 추적 대상으로 등록합니다")
      .addStringOption((opt) =>
        opt
          .setName("메시지id")
          .setDescription("추적할 공지의 메시지 ID (메시지 우클릭 → ID 복사)")
          .setRequired(true),
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("Slash commands registered");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ─── 봇 준비 ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`Bot ready: ${c.user.tag}`);
  console.log(`Notice channel: ${NOTICE_CHANNEL_ID}`);
  console.log(
    `Target roles: ${TARGET_ROLE_IDS.length > 0 ? TARGET_ROLE_IDS.join(", ") : "(all members)"}`,
  );
  console.log(
    `Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(none)"}`,
  );
  await registerCommands();
  restoreTimers();
});

// ─── 슬래시 커맨드 처리 ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "공지등록") return;

  // 권한 체크
  if (!canUseCommand(interaction.member)) {
    await interaction.reply({
      content: "\u274C 이 커맨드를 사용할 권한이 없어요.",
      ephemeral: true,
    });
    return;
  }

  const messageId = interaction.options.getString("메시지id").trim();

  // 이미 등록된 공지인지 확인
  const data = loadData();
  if (data[messageId]) {
    await interaction.reply({
      content: `\u26A0\uFE0F 이미 추적 중인 공지예요. (등록 시각: ${new Date(data[messageId].postedAt).toLocaleString("ko-KR")})`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // 공지 채널에서 메시지 fetch
    const channel = await interaction.guild.channels.fetch(NOTICE_CHANNEL_ID);
    const message = await channel.messages.fetch(messageId);

    // 이미 ✅ 누른 유저 목록 수집
    const checkReaction = message.reactions.cache.get(CHECK_EMOJI);
    let reactedUsers = [];
    if (checkReaction) {
      const users = await checkReaction.users.fetch();
      reactedUsers = users.filter((u) => !u.bot).map((u) => u.id);
    }

    // 등록
    data[messageId] = {
      guildId: interaction.guild.id,
      channelId: NOTICE_CHANNEL_ID,
      content: message.content.slice(0, 100),
      postedAt: Date.now(), // 등록 시점부터 24시간 카운트
      notifiedAt: null,
      reactedUsers,
    };
    saveData(data);

    scheduleCheck(messageId, CHECK_DELAY_MS);

    await interaction.editReply(
      `\u2705 공지가 등록됐어요!\n\n` +
        `> ${data[messageId].content}${data[messageId].content.length >= 100 ? "..." : ""}\n\n` +
        `이미 ✅ 누른 인원: **${reactedUsers.length}명**\n` +
        `24시간 뒤 미읽음 멤버에게 DM을 발송합니다.`,
    );
    console.log(
      `Notice manually registered: ${messageId} by ${interaction.user.tag}`,
    );
  } catch (err) {
    console.error("공지등록 error:", err);
    await interaction.editReply(
      "\u274C 메시지를 찾을 수 없어요. 메시지 ID를 다시 확인해주세요.",
    );
  }
});

// ─── 읽음 처리 ────────────────────────────────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  if (reaction.message.partial) {
    try {
      await reaction.message.fetch();
    } catch {
      return;
    }
  }
  if (reaction.emoji.name !== CHECK_EMOJI) return;

  const data = loadData();
  const entry = data[reaction.message.id];
  if (!entry) return;

  if (!entry.reactedUsers.includes(user.id)) {
    entry.reactedUsers.push(user.id);
    saveData(data);
    console.log(`Read: ${user.tag} -> msg ${reaction.message.id}`);
  }
});

// ─── 읽음 취소 ────────────────────────────────────────────────────────────────
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  if (reaction.emoji.name !== CHECK_EMOJI) return;

  const data = loadData();
  const entry = data[reaction.message.id];
  if (!entry) return;

  entry.reactedUsers = entry.reactedUsers.filter((id) => id !== user.id);
  saveData(data);
  console.log(`Unread: ${user.tag} -> msg ${reaction.message.id}`);
});

// ─── 관리자 DM ────────────────────────────────────────────────────────────────
async function notifyAdmins(
  entry,
  messageId,
  sentSoFar,
  totalUnread,
  totalCount,
) {
  if (ADMIN_IDS.length === 0) return;

  const messageLink = `https://discord.com/channels/${entry.guildId}/${entry.channelId}/${messageId}`;
  const unreadList = sentSoFar
    .map((m, i) => `${i + 1}. ${m.displayName} (@${m.user.username})`)
    .join("\n");

  const msg =
    `\uD83D\uDEA8 **공지 미읽음 현황** (${sentSoFar.length} / ${totalUnread}명 처리 중)\n\n` +
    `> ${entry.content}${entry.content.length >= 100 ? "..." : ""}\n` +
    `\uD83D\uDD17 ${messageLink}\n\n` +
    `\u274C 미읽음: **${totalUnread}명** / 전체 ${totalCount}명\n\n` +
    `**미읽음 목록 (현재까지)**\n${unreadList}`;

  for (const adminId of ADMIN_IDS) {
    try {
      const adminUser = await client.users.fetch(adminId);
      await adminUser.send(msg);
      console.log(
        `Admin DM sent: ${adminUser.tag} (${sentSoFar.length}/${totalUnread})`,
      );
      await sleep(300);
    } catch (err) {
      console.warn(`Admin DM failed (${adminId}): ${err.message}`);
    }
  }
}

// ─── 미읽음 체크 및 DM 발송 ───────────────────────────────────────────────────
async function checkAndNotify(messageId) {
  const data = loadData();
  const entry = data[messageId];
  if (!entry || entry.notifiedAt) return;

  console.log(`Checking notice: ${messageId}`);

  try {
    const guild = await client.guilds.fetch(entry.guildId);
    const channel = await guild.channels.fetch(entry.channelId);

    await fetchMembersOnce(guild);

    const members = channel.members.filter(
      (m) => !m.user.bot && isTargetMember(m),
    );
    const reactedSet = new Set(entry.reactedUsers);
    const unreadMembers = [
      ...members.filter((m) => !reactedSet.has(m.id)).values(),
    ];

    console.log(
      `Target: ${members.size} | Read: ${reactedSet.size} | Unread: ${unreadMembers.length}`,
    );

    const messageLink = `https://discord.com/channels/${entry.guildId}/${entry.channelId}/${messageId}`;
    let ok = 0,
      fail = 0;
    const sentSoFar = [];

    for (const member of unreadMembers) {
      try {
        // await member.send(
        //   `\uD83D\uDCE2 **읽지 않은 공지가 있어요!**\n\n` +
        //     `아래 공지를 아직 확인하지 않으셨어요.\n` +
        //     `${CHECK_EMOJI} 이모지를 눌러 읽음 처리해주세요!\n\n` +
        //     `> ${entry.content}${entry.content.length >= 100 ? "..." : ""}\n\n` +
        //     `\uD83D\uDD17 공지 바로가기: ${messageLink}`,
        // );
        console.log(`DM sent: ${member.user.tag}`);
        ok++;
      } catch {
        console.warn(`DM failed: ${member.user.tag}`);
        fail++;
      }

      sentSoFar.push(member);

      await sleep(500);
    }

    // await notifyAdmins(
    //   entry,
    //   messageId,
    //   sentSoFar,
    //   unreadMembers.length,
    //   members.size,
    // );

    entry.notifiedAt = Date.now();
    saveData(data);
    console.log(`Done: success=${ok}, fail=${fail}`);
  } catch (err) {
    console.error(`checkAndNotify error:`, err);
  }
}

// ─── 타이머 ───────────────────────────────────────────────────────────────────
function scheduleCheck(messageId, delayMs) {
  const delay = Math.max(delayMs, 0);
  console.log(`Scheduled: ${messageId} in ${Math.round(delay / 60000)}min`);
  setTimeout(() => checkAndNotify(messageId), delay);
}

async function restoreTimers() {
  const data = loadData();
  const now = Date.now();
  const expired = [],
    pending = [];

  for (const [messageId, entry] of Object.entries(data)) {
    if (entry.notifiedAt) continue;
    const remaining = CHECK_DELAY_MS - (now - entry.postedAt);
    if (remaining <= 0) expired.push(messageId);
    else pending.push({ messageId, remaining });
  }

  for (const messageId of expired) {
    console.log(`Running expired: ${messageId}`);
    await checkAndNotify(messageId);
  }
  for (const { messageId, remaining } of pending) {
    scheduleCheck(messageId, remaining);
  }

  if (expired.length + pending.length > 0) {
    console.log(
      `Timers restored: ${expired.length} expired, ${pending.length} pending`,
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

client.login(process.env.DISCORD_TOKEN);
