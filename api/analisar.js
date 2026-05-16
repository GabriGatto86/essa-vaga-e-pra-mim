const https = require('https');
const zlib = require('zlib');
const pdfParse = require('pdf-parse');

// ── Leitura de DOCX (ZIP + XML via zlib, sem dependências externas) ──
function lerDOCX(buffer) {
  try {
    const eocdMin = Math.max(0, buffer.length - 65557);
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= eocdMin; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return null;

    const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    let offset = cdOffset;
    let documentXml = null;

    for (let i = 0; i < cdEntries; i++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const compMethod = buffer.readUInt16LE(offset + 10);
      const compSize = buffer.readUInt32LE(offset + 20);
      const fnameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const fname = buffer.slice(offset + 46, offset + 46 + fnameLen).toString('utf-8');

      if (fname === 'word/document.xml') {
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
        const lhFnameLen = buffer.readUInt16LE(localOffset + 26);
        const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lhFnameLen + lhExtraLen;
        const compressed = buffer.slice(dataStart, dataStart + compSize);

        if (compMethod === 0) {
          documentXml = compressed.toString('utf-8');
        } else if (compMethod === 8) {
          documentXml = zlib.inflateRawSync(compressed).toString('utf-8');
        } else {
          return null;
        }
        break;
      }

      offset += 46 + fnameLen + extraLen + commentLen;
    }

    if (!documentXml) return null;

    const texto = documentXml
      .replace(/<w:tab\s*\/?>/g, '\t')
      .replace(/<w:br\s*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]*\n+/g, '\n')
      .trim();

    return texto.length > 0 ? texto : null;
  } catch (e) {
    return null;
  }
}

// Lê o body de forma robusta: usa req.body se Vercel já parseou,
// senão lê o stream manualmente.
function lerBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  const log = (...args) => console.log(`[${Date.now() - t0}ms]`, ...args);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    log('start', req.headers['content-length'], 'bytes');

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
    }

    const { vagaTexto: vagaTextoInput, cvBase64, cvTipo } = await lerBody(req);
    log('body parsed, cvBase64 len:', (cvBase64 || '').length, 'tipo:', cvTipo, 'vagaTexto:', (vagaTextoInput || '').length);

    if (!vagaTextoInput || vagaTextoInput.trim().length < 100) {
      return res.status(400).json({ error: 'Cole o texto completo da descrição da vaga (mínimo 100 caracteres) — requisitos, responsabilidades e atribuições.' });
    }

    if ((cvBase64 || '').length > 4_500_000) {
      return res.status(413).json({ error: 'Arquivo muito grande. Envie um arquivo de até 3MB.' });
    }

    const buffer = Buffer.from(cvBase64 || '', 'base64');
    const tipo = (cvTipo || '').toLowerCase();

    let cvTexto = '';
    try {
      if (tipo.includes('pdf')) {
        const data = await pdfParse(buffer);
        cvTexto = (data.text || '').slice(0, 20000);
      } else if (tipo.includes('officedocument') || tipo.includes('word') || tipo.includes('docx')) {
        cvTexto = (lerDOCX(buffer) || '').slice(0, 20000);
      } else {
        cvTexto = buffer.toString('utf-8').slice(0, 20000);
      }
    } catch (e) {
      cvTexto = buffer.toString('utf-8').replace(/[^\x20-\x7EÀ-ɏ\n]/g, ' ').slice(0, 20000);
    }

    const vagaTextoFinal = vagaTextoInput.trim().slice(0, 20000);
    log('cv:', cvTexto.length, 'vaga:', vagaTextoFinal.length);

    const prompt = `Você é especialista sênior em recrutamento. Avalie HONESTAMENTE a compatibilidade entre o currículo e a vaga.

REGRAS OBRIGATÓRIAS:
1. Se a vaga e o currículo são de ÁREAS PROFISSIONAIS DIFERENTES (ex: RH vs TI, Marketing vs Engenharia, Vendas vs Jurídico), score ≤ 20 e veredicto "NÃO RECOMENDADO". Explique no resumo que são áreas distintas.
2. Score ≥ 70 SÓ se o candidato atende a maioria dos requisitos técnicos/experiência específicos da vaga.
3. Pontos fortes devem citar requisitos da VAGA que o CV atende. Gaps devem citar requisitos da VAGA que o CV NÃO atende.
4. Cursos e próximos passos devem MIRAR NOS GAPS DA VAGA, não enriquecer a área atual do candidato. Se a vaga é de Recursos Humanos, recomende cursos de RH (não de TI), mesmo que o candidato seja de TI.
5. Seja explícito sobre incompatibilidades. NÃO infle scores.

DESCRIÇÃO DA VAGA:
${vagaTextoFinal}

CURRÍCULO DO CANDIDATO:
${cvTexto || '[NÃO FORNECIDO]'}

Retorne SOMENTE este JSON, sem markdown, sem comentários (use os tipos indicados):
{
  "score": <inteiro 0-100>,
  "veredicto": "APROVADO" | "ATENÇÃO" | "NÃO RECOMENDADO",
  "resumo": "<2-3 frases honestas sobre o match real entre vaga e CV>",
  "pontos_fortes": ["<requisito da vaga que o CV atende>", "<idem>", "<idem>"],
  "gaps": ["<requisito da vaga que falta no CV>", "<idem>", "<idem>"],
  "cursos": [
    {"nome": "<curso real>", "plataforma": "Coursera|Alura|LinkedIn Learning|Udemy|YouTube|dio.me", "motivo": "<como fecha um gap específico desta vaga>"},
    {"nome": "<curso real>", "plataforma": "<>", "motivo": "<>"}
  ],
  "proximos_passos": ["<ação concreta pra atender ESTA vaga>", "<>", "<>"]
}`;

    const payload = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });

    log('calling groq, payload size:', payload.length);
    const apiRes = await new Promise((resolve, reject) => {
      const apiReq = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve({ status: r.statusCode, data }));
      });
      apiReq.on('error', reject);
      apiReq.on('timeout', () => { apiReq.destroy(new Error('A IA demorou para responder (mais de 25s). Tente novamente em alguns segundos.')); });
      apiReq.write(payload);
      apiReq.end();
    });
    log('groq responded, status:', apiRes.status);

    let apiData;
    try { apiData = JSON.parse(apiRes.data); } catch { apiData = {}; }

    if (apiRes.status !== 200) {
      log('groq error:', apiData?.error);
      const msg = apiData?.error?.message || `Groq respondeu ${apiRes.status}`;
      if (apiRes.status === 429) {
        return res.status(429).json({ error: 'Muitas análises em pouco tempo. Aguarde 1 minuto e tente novamente.' });
      }
      return res.status(502).json({ error: msg });
    }

    const text = apiData?.choices?.[0]?.message?.content || '';
    let resultado;
    try {
      resultado = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      log('JSON parse failed, raw:', text.slice(0, 200));
      return res.status(500).json({ error: 'Resposta da IA não pôde ser interpretada. Tente novamente.' });
    }
    resultado.vaga_lida = vagaTextoFinal.length > 0;
    resultado.cv_lido = cvTexto.length > 50;
    log('success, vaga_lida:', resultado.vaga_lida);
    return res.status(200).json(resultado);

  } catch (e) {
    log('handler error:', e.message, e.stack?.split('\n')[1]);
    return res.status(500).json({ error: e.message || 'Erro interno.' });
  }
};
