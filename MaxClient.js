const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

class MaxClient {
    constructor(token) {
        this.token = token;
        this.seq = 1;
        this.ws = null;

        this.connected = false;
        this.authenticated = false;

        this.pingInterval = null;
        this.pending = new Map();

        this.messageHandlers = [];
        this.connectHandler = null;

        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
    }

    // =========================
    // INTERNAL
    // =========================

    _nextSeq() {
        return this.seq++;
    }

    _send(opcode, payload) {
        const packet = {
            ver: 11,
            cmd: 0,
            seq: this._nextSeq(),
            opcode,
            payload
        };

        this.ws.send(JSON.stringify(packet));
        return packet.seq;
    }

    _startHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);

        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this._send(1, { interactive: false });
            }
        }, 25000);
    }

    _stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    // =========================
    // CONNECT
    // =========================

    connect() {
        this.ws = new WebSocket("wss://ws-api.oneme.ru/websocket", {
            headers: {
                Origin: "https://web.oneme.ru",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        this.ws.on("open", () => {
            console.log("✅ Connected to Max");

            // 1. User agent
            this._send(6, {
                userAgent: {
                    deviceType: "WEB",
                    locale: "en",
                    osVersion: "Windows",
                    deviceName: "WebMax",
                    headerUserAgent:
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    deviceLocale: "en",
                    appVersion: "4.8.42",
                    screen: "1920x1080 1.0x",
                    timezone: "UTC"
                },
                deviceId: uuidv4()
            });

            // 2. Auth
            this._send(19, {
                interactive: true,
                token: this.token,
                chatsSync: 0,
                contactsSync: 0,
                presenceSync: 0,
                draftsSync: 0,
                chatsCount: 40
            });

            this.connected = true;
        });

        this.ws.on("message", (data) => this._onMessage(data));

        this.ws.on("close", (code) => {
            console.error(`❌ Socket closed (${code}). Exiting for pm2 restart.`);

            this._stopHeartbeat();
            this._stopWsPing();

            //        this._reconnect();
            process.exit(1); // pm2 restart
        });

        this.ws.on("error", (err) => {
            console.error("WebSocket error:", err);
        });

        this.ws.on("pong", () => {
            //console.log("💚 pong");
        });

        this.ws.on("ping", () => {
            //console.log("Ping from max");
        });
    }

    _reconnect() {
        this.reconnectAttempts++;

        const delay = Math.min(
            1000 * 2 ** this.reconnectAttempts,
            this.maxReconnectDelay
        );

        console.log(`🔄 Reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    // =========================
    // MESSAGE ROUTER
    // =========================

    async _onMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }

        // 🔥 FIRST: resolve pending requests
        if (this.pending.has(msg.seq)) {
            const { resolve } = this.pending.get(msg.seq);
            this.pending.delete(msg.seq);
            resolve(msg);
            return;
        }

        // AUTH CONFIRM
        if (msg.opcode === 19) {
            this.authenticated = true;
            console.log("🎉 Authenticated");

            this._startHeartbeat();
            this._startWsPing();

            if (this.connectHandler) this.connectHandler();
            return;
        }

        // HEARTBEAT
        if (msg.opcode === 1) {
            console.log("Server heartbeat:", msg);
            return;
        }

        // NEW MESSAGE
        if (msg.opcode === 128) {
            for (const handler of this.messageHandlers) {
                try {
                    handler(msg.payload);
                } catch (e) {
                    console.error("Handler error:", e);
                }
            }
        }
    }

    // =========================
    // PUBLIC API
    // =========================

    on_connect(fn) {
        this.connectHandler = fn;
    }

    on_message(fn) {
        this.messageHandlers.push(fn);
    }

    async getUser({ id, phone } = {}) {
        return new Promise((resolve, reject) => {

            if (!id && !phone)
                return reject(new Error("Provide id or phone"));

            const seq = this._nextSeq();

            const packet = id
                ? { ver: 11, cmd: 0, seq, opcode: 32, payload: { contactIds: [id] } }
                : { ver: 11, cmd: 0, seq, opcode: 46, payload: { phone: String(phone) } };

            this.pending.set(seq, { resolve, reject });

            this.ws.send(JSON.stringify(packet));

            // timeout safety
            setTimeout(() => {
                if (this.pending.has(seq)) {
                    this.pending.delete(seq);
                    reject(new Error("getUser timeout"));
                }
            }, 10000);
        }).then(res => {
            const payload = res.payload;
            if (payload.error)
                throw new Error(payload.message || payload.error);

            const contact = payload.contacts
                ? payload.contacts[0]
                : payload.contact;

            return contact;
        });
    }

    _startWsPing() {
        if (this.wsPingInterval) clearInterval(this.wsPingInterval);

        this.wsPingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
                //console.log("🏓 ws ping");
            }
        }, 20000); // 20 сек
    }

    _stopWsPing() {
        if (this.wsPingInterval) {
            clearInterval(this.wsPingInterval);
            this.wsPingInterval = null;
        }
    }
}

module.exports = MaxClient;
