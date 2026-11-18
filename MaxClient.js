const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { encodePacket, decodePackets, integerId } = require("./MaxProtocol");

const WS_URL = "wss://api.oneme.ru/websocket";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

class MaxClient {
    constructor(token) {
        this.token = token;
        this.proxyUrl = process.env.MAX_PROXY_URL;
        this.deviceId = uuidv4();
        this.seq = 1;
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
        this.pingInterval = null;
        this.wsPingInterval = null;
        this.pending = new Map();
        this.messageHandlers = [];
        this.connectHandler = null;
        this._connectPromise = null;
    }

    _nextSeq() {
        for (let i = 0; i < 65536; i++) {
            const seq = this.seq;
            this.seq = (this.seq + 1) & 0xffff;
            if (!this.pending.has(seq)) return seq;
        }
        throw new Error("All MAX request sequence numbers are in use");
    }

    _write(packet, onError) {
        if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("MAX socket is not open");
        this.ws.send(encodePacket(packet), { binary: true }, (error) => {
            if (error) {
                if (onError) onError(error);
                else console.error("MAX send error:", error.message);
            }
        });
    }

    _send(opcode, payload) {
        const seq = this._nextSeq();
        this._write({ cmd: 0, seq, opcode, payload });
        return seq;
    }

    _request(opcode, payload, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const seq = this._nextSeq();
            const finish = (callback, value) => {
                clearTimeout(timer);
                this.pending.delete(seq);
                callback(value);
            };
            const timer = setTimeout(() => {
                finish(reject, new Error(`MAX opcode ${opcode} timeout`));
            }, timeout);
            const pending = {
                opcode,
                resolve: (response) => finish(resolve, response),
                reject: (error) => finish(reject, error)
            };
            this.pending.set(seq, pending);
            try {
                this._write({ cmd: 0, seq, opcode, payload }, (error) => {
                    if (this.pending.get(seq) === pending) pending.reject(error);
                });
            } catch (error) {
                pending.reject(error);
            }
        });
    }

    _rejectPending(error) {
        for (const pending of this.pending.values()) pending.reject(error);
    }

    _responsePayload(response) {
        const payload = response.payload || {};
        if (response.cmd === 3 || payload.error) {
            const message = payload.localizedMessage || payload.message
                || (typeof payload.error === "string" ? payload.error : "MAX request failed");
            throw new Error(message);
        }
        return payload;
    }

    _sendInteractiveFalse() {
        return this._request(1, { interactive: false });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
                this._send(1, { interactive: false });
            }
        }, 25000);
    }

    _stopHeartbeat() {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
    }

    connect() {
        if (this._connectPromise) return this._connectPromise;
        if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
        this._connectPromise = this._connect().finally(() => {
            this._connectPromise = null;
        });
        return this._connectPromise;
    }

    async _connect() {
        const options = {
            handshakeTimeout: 20000,
            headers: {
                Origin: "https://web.max.ru",
                "User-Agent": USER_AGENT,
                Pragma: "no-cache",
                "Cache-Control": "no-cache"
            }
        };
        if (this.proxyUrl) {
            if (!this.proxyUrl.startsWith("socks://") && !this.proxyUrl.startsWith("socks5://")) {
                throw new Error("MAX_PROXY_URL must use socks:// or socks5://");
            }
            const { SocksProxyAgent } = await import("socks-proxy-agent");
            options.agent = new SocksProxyAgent(this.proxyUrl);
            console.log("Connecting to MAX through SOCKS proxy");
        }

        this.seq = 1;
        const ws = new WebSocket(WS_URL, options);
        this.ws = ws;
        return new Promise((resolve, reject) => {
            ws.on("message", (data, isBinary) => {
                if (!isBinary) {
                    console.error("Unexpected MAX text frame");
                    return;
                }
                this._onMessage(data).catch((error) => console.error("MAX message error:", error.message));
            });
            ws.on("close", (code) => {
                this.connected = false;
                this.authenticated = false;
                this._stopHeartbeat();
                this._stopWsPing();
                const error = new Error(`MAX socket closed (${code})`);
                this._rejectPending(error);
                reject(error);
                console.error(`${error.message}. Exiting for pm2 restart.`);
                process.exit(1);
            });
            ws.on("error", (error) => {
                this._rejectPending(error);
                reject(error);
                console.error("WebSocket error:", error.message);
            });
            ws.on("open", async () => {
                this.connected = true;
                try {
                    this._responsePayload(await this._request(6, {
                        userAgent: {
                            deviceType: "WEB",
                            pushDeviceType: "WEBPUSH",
                            locale: "ru",
                            deviceLocale: "ru",
                            osVersion: "Windows",
                            deviceName: "Chrome",
                            headerUserAgent: USER_AGENT,
                            isPwa: false,
                            appVersion: "26.11.9",
                            screen: "1080x1920 1.0x",
                            timezone: "Europe/Moscow"
                        },
                        deviceId: this.deviceId,
                        clientSessionId: Date.now()
                    }, 20000));
                    const payload = this._responsePayload(await this._request(19, {
                        interactive: true,
                        token: this.token,
                        chatsSync: 0,
                        contactsSync: 0,
                        presenceSync: 0,
                        draftsSync: 0,
                        chatsCount: 40
                    }, 20000));
                    if (!payload.profile) throw new Error("MAX login response does not contain a profile");
                    this.authenticated = true;
                    this._startHeartbeat();
                    this._startWsPing();
                    console.log("Authenticated to MAX (binary transport)");
                    resolve();
                } catch (error) {
                    this.connected = false;
                    this.authenticated = false;
                    reject(error);
                    ws.close();
                    return;
                }
                try {
                    if (this.connectHandler) await this.connectHandler();
                } catch (error) {
                    console.error("Connect handler error:", error);
                }
            });
        });
    }

    async _onMessage(data) {
        // Dispatch all replies before awaiting application callbacks, which can issue RPCs.
        const messages = [];
        for (const msg of decodePackets(data)) {
            const token = msg.payload?.tokenAttrs?.LOGIN?.token;
            if (token) this.token = token;
            const pending = this.pending.get(msg.seq);
            if (pending && pending.opcode === msg.opcode && (msg.cmd === 1 || msg.cmd === 3)) {
                pending.resolve(msg);
                continue;
            }
            if (msg.opcode === 1) {
                if (msg.cmd === 0) {
                    this._write({ cmd: 1, seq: msg.seq, opcode: 1, payload: msg.payload || {} });
                }
                continue;
            }
            if (msg.opcode === 128) messages.push(msg.payload);
        }
        for (const payload of messages) {
            for (const handler of this.messageHandlers) {
                try {
                    await handler(payload);
                } catch (error) {
                    console.error("Handler error:", error);
                }
            }
        }
    }

    on_connect(fn) {
        this.connectHandler = fn;
    }

    on_message(fn) {
        this.messageHandlers.push(fn);
    }

    async getUser({ id, phone } = {}) {
        if (id == null && !phone) throw new Error("Provide id or phone");
        const response = id != null
            ? await this._request(32, { contactIds: [integerId(id, "id")] })
            : await this._request(46, { phone: String(phone) });
        const payload = this._responsePayload(response);
        return payload.contacts ? payload.contacts[0] : payload.contact;
    }

    async requestFileDownloadUrl({ chatId, messageId, fileId, fileName = "", attachLocalId = "" }) {
        if (chatId == null || messageId == null || fileId == null) {
            throw new Error("requestFileDownloadUrl requires chatId, messageId and fileId");
        }
        const payload = {
            requestId: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            fileId: integerId(fileId, "fileId"),
            fileName: String(fileName || ""),
            messageId: String(messageId),
            chatId: integerId(chatId, "chatId")
        };
        if (attachLocalId) payload.attachLocalId = String(attachLocalId);
        const response = this._responsePayload(await this._request(88, payload));
        const url = response.url || response.c;
        if (!url) throw new Error("MAX response does not contain a file URL");
        return url;
    }

    _startWsPing() {
        this._stopWsPing();
        this.wsPingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, 20000);
    }

    _stopWsPing() {
        clearInterval(this.wsPingInterval);
        this.wsPingInterval = null;
    }
}

module.exports = MaxClient;
