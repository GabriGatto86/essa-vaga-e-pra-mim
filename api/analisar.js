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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
    }

    const { vagaUrl, cvBase64, cvTipo } = await lerBody(req);
    if (!vagaUrl) return res.status(400).json({ error: 'Link da vaga não informado.' });

    const buffer = Buffer.from(cvBase64 || '', 'base64');
    const tipo = (cvTipo || '').toLowerCase();

    let cvTexto = '';
    try {
      if (tipo.includes('pdf')) {
        const data = await pdfParse(buffer);
        cvTexto = (data.text || '').slice(0, 6000);
      } else if (tipo.includes('officedocument') || tipo.includes('word') || tipo.includes('docx')) {
        cvTexto = (lerDOCX(buffer) || '').slice(0, 6000);
      } else {
        cvTexto = buffer.toString('utf-8').slice(0, 6000);
      }
    } catch (e) {
      cvTexto = buffer.toString('utf-8').replace(/[^\x20-\x7EÀ-ɏ\n]/g, ' ').slice(0, 6000);
    }

    const prompt = `Você é especialista sênior em recrutamento com 20 anos de experiência.\n\nLINK DA VAGA: ${vagaUrl}\n\nCURRÍCULO:\n${cvTexto || 'não enviado'}\n\nRetorne SOMENTE este JSON:\n{"score":75,"veredicto":"ATENÇÃO","resumo":"frase 1. frase 2.","pontos_fortes":["p1","p2","p3"],"gaps":["g1","g2","g3"],"cursos":[{"nome":"curso","plataforma":"Alura","motivo":"motivo"}],"proximos_passos":["a1","a2","a3"]}`;

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const apiRes = await new Promise((resolve, reject) => {
      const apiReq = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve({ status: r.statusCode, data }));
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });

    let apiData;
    try { apiData = JSON.parse(apiRes.data); } catch { apiData = {}; }

    if (apiRes.status !== 200) {
      return res.status(502).json({ error: apiData?.error?.message || `Anthropic respondeu ${apiRes.status}` });
    }

    const text = apiData?.content?.[0]?.text || '';
    let resultado;
    try {
      resultado = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Resposta da IA não pôde ser interpretada. Tente novamente.' });
    }
    return res.status(200).json(resultado);

  } catch (e) {
    console.error('Erro no handler:', e);
    return res.status(500).json({ error: e.message || 'Erro interno.' });
  }
};
