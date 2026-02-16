// index.js - Bot AquaFit (APENAS PIX: Payload Real + Segurança + Delay 15min + Cancelamento se Pago)
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import wwebjs from 'whatsapp-web.js';
import qrcode from "qrcode-terminal";

const { Client, LocalAuth, MessageMedia } = wwebjs;

// ======================= CONFIGURAÇÃO DE ARQUIVOS =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, ".data"); 

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const PERSISTENCE_FILE = path.join(DATA_DIR, "bot_state.json");
const STORE_FILE = path.join(DATA_DIR, "wpp_store.json");

// ======================= GEMINI SETUP =======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.0-flash"; 

// ======================= STORE LOCAL =======================
function makeLocalInMemoryStore() {
    const messages = {}; 
    return {
        messages,
        saveWppMessage(msg) {
            try {
                const remoteJid = msg.fromMe ? msg.to : msg.from;
                if (!remoteJid) return;
                
                const fakeMsg = {
                    key: { remoteJid, fromMe: msg.fromMe, id: msg.id.id },
                    message: { conversation: msg.body || "" },
                    pushName: msg._data?.notifyName || ""
                };

                if (!messages[remoteJid]) messages[remoteJid] = { array: [] };
                const exists = messages[remoteJid].array.some(m => m.key.id === fakeMsg.key.id);
                if (!exists) {
                    messages[remoteJid].array.push(fakeMsg);
                    if (messages[remoteJid].array.length > 50) messages[remoteJid].array.shift(); 
                }
                return fakeMsg;
            } catch (e) { return null; }
        },
        writeToFile(path) { try { fs.writeFileSync(path, JSON.stringify(messages)); } catch (e) {} },
        readFromFile(path) { 
            try { 
                if (fs.existsSync(path)) Object.assign(messages, JSON.parse(fs.readFileSync(path))); 
            } catch (e) {} 
        }
    };
}

const store = makeLocalInMemoryStore();
try { store.readFromFile(STORE_FILE); } catch(e) {}

setInterval(() => { store.writeToFile(STORE_FILE); }, 30000);

// ======================= HELPERS =======================
function appendHiddenTag(text, id) {
    if (!text || !id) return text;
    const idStr = id.toString();
    const encoded = idStr.split('').map(char => {
        const binary = char.charCodeAt(0).toString(2);
        return binary.replace(/0/g, '\u200B').replace(/1/g, '\u200C');
    }).join('\u2060'); 
    return `${text} \u200D${encoded}\u200D`;
}

function normalizeChatKey(jid) {
    if (!jid) return null;
    return jid.replace("@s.whatsapp.net", "").replace("@lid", "").replace("@c.us", "").replace(/\D/g, "");
}

function safeReadJSON(file, fallback) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback; } catch (e) { return fallback; }
}

function safeWriteJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ======================= ESTADO =======================
const conversationsByKey = new Map(); 
const lidCache = new Map(); 
const allowedChats = new Set(); 
const messageBuffers = new Map();
const pendingPixTimers = new Map(); 

function loadState() {
    const data = safeReadJSON(PERSISTENCE_FILE, { conversations: {}, lidCache: {}, allowed: [] });
    for (const [key, val] of Object.entries(data.conversations || {})) conversationsByKey.set(key, val);
    for (const [key, val] of Object.entries(data.lidCache || {})) lidCache.set(key, val);
    data.allowed?.forEach(k => allowedChats.add(k));
    console.log(`💾 Estado: ${conversationsByKey.size} vendas | ${lidCache.size} LIDs.`);
}

function persistState() {
    safeWriteJSON(PERSISTENCE_FILE, {
        conversations: Object.fromEntries(conversationsByKey),
        lidCache: Object.fromEntries(lidCache),
        allowed: [...allowedChats]
    });
}

function ensureConversation(key) {
    if (!conversationsByKey.has(key)) {
        conversationsByKey.set(key, { chatId: key, dadosCliente: {}, history: [] });
        persistState();
    }
    return conversationsByKey.get(key);
}

loadState();

// ======================= LID MATCHING =======================
async function resolveContactId(msg) {
    let rawId = msg.fromMe ? msg.to : msg.from;
    if (lidCache.has(rawId)) return lidCache.get(rawId);
    if (!rawId.includes("@lid")) return normalizeChatKey(rawId);

    try {
        const chat = await msg.getChat();
        const msgs = await chat.fetchMessages({ limit: 15 });
        const lastMsgByMe = msgs.reverse().find(m => m.fromMe);

        if (lastMsgByMe && lastMsgByMe.body) {
            const textSentInChat = lastMsgByMe.body.trim();
            for (const [phoneKey, convData] of conversationsByKey.entries()) {
                if (!allowedChats.has(phoneKey)) continue;
                const lastMemoryMsg = [...convData.history].reverse().find(m => m.role === 'model');
                if (lastMemoryMsg && lastMemoryMsg.parts && lastMemoryMsg.parts[0].text) {
                    const memoryText = lastMemoryMsg.parts[0].text.trim();
                    if (textSentInChat.includes(memoryText) || memoryText.includes(textSentInChat)) {
                        lidCache.set(rawId, phoneKey);
                        persistState();
                        return phoneKey;
                    }
                }
            }
        }
    } catch (e) { console.error("Erro LID:", e.message); }
    return null; 
}

// ======================= INTELIGÊNCIA ARTIFICIAL (GEMINI) =======================

const PROMPT_PIX = `
Você é a Carolina, atendente real da AquaFit Brasil.
OBJETIVO: Ajudar clientes com PIX não pago.
TOM DE VOZ: Educada, clara, objetiva e acolhedora.
- A primeira mensagem deve ser primeiro cumprimentando a cliente pelo nome dela "Olá (nome), tudo bem ?", se apresentar como Carolina atendente da AquaFit Brasil e agradecer a cliente pela compra, dizer que ficamos muito felizes de ter ela como cliente, mas que percebemos que o pagamento via pix não foi realizado. Pergunte se aconteceu algum problema, forneça a nossa chave pix para pagamento direto, diga que basta ela enviar o comprovante de pagamento pelo whatsapp mesmo e pergunte se ficou alguma dúvida.

REGRAS DE SEGURANÇA:
- Nunca peça senha, token ou print de cartão.
- Explique AppMax se houver desconfiança.
- Ofereça PIX direto no CNPJ se a cliente estiver insegura.
- Nunca invente nada sobre o envio das peças, do local de produção ou de qualquer outro assunto. 

DADOS PARA PIX DIRETO, para mandar na primeira mensagem, envie os dados exatamente assim:

*CNPJ:* 52757947000145
*Banco:* Itaú
*Recebedor:* JVL NEGÓCIOS DIGITAIS LTDA (Razão social da AquaFit Brasil - Conferir no rodapé da loja)
*Valor:* {VALOR_TOTAL_PEDIDO} (Substitua pelo valor exato que receber no contexto)


Depois que a cliente disser que já pagou, agradeça e diga que ela receberá a confirmação via e-mail e em breve o rastreamento.
`;

async function gerarRespostaGemini(historico, dados) {
    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });
        
        let systemInstruction = PROMPT_PIX;
        
        // Garante que o valor venha formatado ou usa o cru
        let valorFormatado = dados.valor;
        if (typeof dados.valor === 'number') {
            valorFormatado = `R$ ${dados.valor.toFixed(2).replace('.', ',')}`;
        }

        let promptUsuario = `
            Contexto PIX:
            Cliente: ${dados.nome}
            Valor Pedido: ${valorFormatado}
            Link Original: ${dados.link}
            
            Se for a primeira mensagem, gere EXATAMENTE a "Mensagem 1" do seu roteiro, substituindo a variável {VALOR_TOTAL_PEDIDO} por ${valorFormatado}.
            `;

        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: `Instrução do Sistema: ${systemInstruction}` }] },
                ...historico
            ]
        });

        let msgEnvio = "Gere a próxima resposta.";
        if (historico.length === 0) {
            msgEnvio = promptUsuario;
        }

        const result = await chat.sendMessage(msgEnvio);
        return result.response.text();
    } catch (error) {
        console.error("Erro Gemini:", error);
        return "Oi! Já te respondo, só um minuto.";
    }
}

// ======================= CLIENTE WHATSAPP =======================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot Online (APENAS PIX) com Cancelamento Automático!'));

client.on('message_create', async (msg) => {
    store.saveWppMessage(msg);
    if (msg.fromMe || msg.isStatus) return;

    const realKey = await resolveContactId(msg);
    if (!realKey || !allowedChats.has(realKey)) return;

    let buffer = messageBuffers.get(realKey);
    if (!buffer) {
        buffer = { texts: [], timer: null };
        messageBuffers.set(realKey, buffer);
    }
    buffer.texts.push(msg.body);

    if (buffer.timer) clearTimeout(buffer.timer);

    buffer.timer = setTimeout(async () => {
        messageBuffers.delete(realKey);
        const textoCompleto = buffer.texts.join("\n");

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch(e) {}

        await new Promise(r => setTimeout(r, 20000)); 

        const conv = ensureConversation(realKey);
        conv.history.push({ role: "user", parts: [{ text: textoCompleto }] });

        let resposta = await gerarRespostaGemini(conv.history, conv.dadosCliente);
        resposta = appendHiddenTag(resposta, realKey);

        const sentMsg = await client.sendMessage(msg.from, resposta);
        store.saveWppMessage(sentMsg);

        conv.history.push({ role: "model", parts: [{ text: resposta }] });
        persistState();

        try {
            const chat = await msg.getChat();
            await chat.clearState();
        } catch(e) {}

    }, 30000); 
});

client.initialize();

// ======================= WEBHOOK YAMPI =======================
const app = express();
app.use(express.json());
app.use(cors());

// Função auxiliar para encontrar o valor dentro de objetos aninhados
const getSafe = (obj, path) => {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

app.post('/webhook/yampi', async (req, res) => {
    try {
        const data = req.body;
        console.log("📥 Evento:", data.event); 

        const resource = data.resource || {};
        const orderId = resource.id;

        // --- 1. DETECÇÃO DE PAGAMENTO REALIZADO (CANCELAMENTO DE TIMER) ---
        if (data.event === "order.paid" || (data.event === "order.updated" && resource.paid)) {
            if (orderId && pendingPixTimers.has(orderId)) {
                console.log(`🎉 Pagamento CONFIRMADO para Pedido ${orderId}. CANCELANDO timer de cobrança!`);
                clearTimeout(pendingPixTimers.get(orderId));
                pendingPixTimers.delete(orderId);
                return res.status(200).send("Timer Cancelled");
            }
            return res.status(200).send("Paid - No timer");
        }

        // --- 2. VERIFICAÇÃO DE PEDIDO NOVO E NÃO PAGO ---
        if (data.event !== "order.created") {
            return res.status(200).send("Ignored event");
        }

        if (resource.paid === true) {
            console.log(`✅ Pedido ${orderId} já nasceu pago. Ignorando.`);
            return res.status(200).send("Already Paid");
        }

        // --- 3. DETECÇÃO ROBUSTA DE PIX ---
        const paymentsData = getSafe(resource, "payments.data") || resource.payments || [];
        const isPix = paymentsData.some(p => 
            p.is_pix === true || 
            (p.name && p.name.toLowerCase().includes("pix")) || 
            (p.alias && p.alias.toLowerCase().includes("pix"))
        );

        if (!isPix) {
            console.log(`🛑 Pedido ${orderId} criado, mas método NÃO é Pix.`);
            return res.status(200).send("Ignored - Not Pix");
        }

        // --- 4. EXTRAÇÃO DE DADOS DO CLIENTE ---
        let telefone = 
            getSafe(resource, "customer.data.phone.full_number") || 
            getSafe(resource, "customer.phone.full_number") || 
            getSafe(resource, "customer.phone.mobile") ||
            getSafe(resource, "shipping_address.data.phone.full_number") ||
            getSafe(resource, "shipping_address.phone.full_number") ||
            getSafe(resource, "spreadsheet.data.customer_phone") ||
            "";

        telefone = telefone.replace(/\D/g, "");
        
        if (!telefone) return res.status(400).send("Sem telefone");
        if (telefone.length <= 11) telefone = "55" + telefone;

        const chatIdProvisorio = `${telefone}@c.us`;
        let chatIdFinal = chatIdProvisorio;

        try {
            const contactId = await client.getNumberId(chatIdProvisorio);
            if (contactId && contactId._serialized) {
                chatIdFinal = contactId._serialized;
            }
        } catch (e) {
            console.error("Erro na validação do número:", e.message);
        }

        const systemKey = normalizeChatKey(chatIdFinal);

        const nomeCliente = 
            getSafe(resource, "customer.data.name") || 
            getSafe(resource, "customer.data.full_name") ||
            resource.customer_name || 
            "Cliente";

        const itemsList = getSafe(resource, "items.data") || resource.items || [];
        const produtosStr = Array.isArray(itemsList) ? itemsList.map(i => i.product_name || getSafe(i, "sku.data.title") || "Produto").join(", ") : "Produtos";

        const dados = {
            nome: nomeCliente,
            tipo: "Pix Pendente",
            produtos: produtosStr,
            link: resource.checkout_url || resource.status_url || "",
            // Garante que pegamos o valor total, seja direto ou em totalizers
            valor: resource.total_price || getSafe(resource, "totalizers.total") || 0
        };

        // --- 5. AGENDAMENTO DO ENVIO (15 MIN) ---
        console.log(`⏳ Pix Pendente detectado (${orderId}). Valor: ${dados.valor}. Agendando envio...`);
        res.status(200).send("Scheduled");

        const timer = setTimeout(async () => {
            pendingPixTimers.delete(orderId);
            console.log(`🚀 Executando envio para: ${dados.nome} - Tel: ${telefone}`);

            const conv = ensureConversation(systemKey);
            conv.dadosCliente = dados;
            conv.history = []; 
            allowedChats.add(systemKey);
            persistState();

            let msgInicial = await gerarRespostaGemini([], dados);
            msgInicial = appendHiddenTag(msgInicial, systemKey);

            const sentMsg = await client.sendMessage(chatIdFinal, msgInicial);
            store.saveWppMessage(sentMsg);

            conv.history.push({ role: "model", parts: [{ text: msgInicial }] });
            persistState();

        }, 15 * 60 * 1000); 

        if (orderId) {
            pendingPixTimers.set(orderId, timer);
        }

    } catch (e) {
        console.error("Erro Webhook:", e);
        if (!res.headersSent) res.status(500).send("Erro Interno");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`👂 Webhook na porta ${PORT}`));