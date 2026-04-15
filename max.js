const WebSocket = require("ws");
const sendToTelegram = require("./TelegramClient");
const MaxClient = require("./MaxClient");
const dotenv = require("dotenv");
dotenv.config();

const MAX_TOKEN = process.env.MAX_TOKEN;
const MAX_CHAT_IDS = (process.env.MAX_CHAT_IDS || "").split(",").map(x => parseInt(x));
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_CHAT_ID_OFP = process.env.TG_CHAT_ID_OFP;
const CHAT_NAMES = process.env.CHAT_NAMES ? JSON.parse(process.env.CHAT_NAMES) : {};
const OFP_CHAT_ID = parseInt(process.env.OFP_CHAT_ID, 10);

const client = new MaxClient(MAX_TOKEN);

client.on_connect(() => {
    const now = new Date();
    console.log(`[${now.toLocaleString()}] Bot is ready`);
});

client.on_message(async (payload) => {
    const { chatId, message } = payload;

    if (!MAX_CHAT_IDS.includes(chatId)) return;
    if (message.status === "REMOVED") return;

    let msgText = message.text || "";
    let msgAttaches = message.attaches || [];

    const chatName = CHAT_NAMES[String(chatId)] || String(chatId);
    let senderName = "Unknown";

    try {
        const user = await client.getUser({ id: message.sender });
        senderName = user?.names?.[0]?.name || "Unknown";
    } catch (err) {
        console.error("getUser error:", err.message);
    }
    console.log(JSON.stringify(message, null, 2));
    if (message?.link?.type) {
        const link = message?.link;

        if (link.type === "REPLY") {
            // TODO: обработка reply
        } else if (link.type === "FORWARD") {
            const fwdMsg = link.message;
            msgText = fwdMsg.text || "";
            msgAttaches = fwdMsg.attaches || [];
            try {
                const fwdAuthor = await client.getUser({ id: fwdMsg.sender });
                const fwdName = fwdAuthor?.names?.[0]?.name || "Unknown";
                senderName = `${senderName}\n(Forwarded: ${fwdName})`;
            } catch (err) {
                console.error("getUser (forwarded) error:", err.message);
            }
        }
    }

    if (msgText || msgAttaches.length > 0) {
        const msgToSend = msgText
            ? `<b>${chatName}</b>\n<b>${senderName}</b>\n${msgText}`
            : `<b><b>${chatName}</b>\n${senderName}</b>`;
        const targetTelegramChatId = chatId === OFP_CHAT_ID ? TG_CHAT_ID_OFP : TG_CHAT_ID;

        await sendToTelegram(TG_BOT_TOKEN, targetTelegramChatId, msgToSend, msgAttaches);
    }
});

client.connect();
