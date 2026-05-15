const https = require('https');
const zlib = require('zlib');
const pdfParse = require('pdf-parse');

// ── Leitura de DOCX (ZIP + XML via zlib, sem dependências externas) ──
function lerDOCX(buffer) {
  try {
    // 1. Localizar End of Central Directory Record (assinatura 0x06054b50)
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

    // 2. Percorrer Central Directory procurando word/document.xml
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

    // 3. Converter XML em texto plano preservando quebras de parágrafo
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { vagaUrl, cvBase64, cvTipo } = JSON.parse(body);
      const buffer = Buffer.from(cvBase64 || '', 'base64');
      
      let cvTexto = '';
      try {
        if (cvTipo && cvTipo.includes('pdf')) {
          const data = await pdfParse(buffer);
          cvTexto = data.text.slice(0, 6000);
        } else if (cvTipo && (cvTipo.includes('word') || cvTipo.includes('docx') || cvTipo.includes('officedocument'))) {
          cvTexto = (lerDOCX(buffer) || '').slice(0, 6000);
        } else {
          cvTexto = buffer.toString('utf-8').slice(0, 6000);
        }
      } catch(e) {
        cvTexto = buffer.toString('utf-8').replace(/[^\x20-\x7E\u00C0-\u024F\n]/g, ' ').slice(0, 6000);
      }

      const prompt = `Você é especialista sênior em recrutamento com 20 anos de experiência.\n\nLINK DA VAGA: ${vagaUrl}\n\nCURRÍCULO:\n${cvTexto || 'não enviado'}\n\nRetorne SOMENTE este JSON:\n{"score":75,"veredicto":"ATENÇÃO","resumo":"frase 1. frase 2.","pontos_fortes":["p1","p2","p3"],"gaps":["g1","g2","g3"],"cursos":[{"nome":"curso","plataforma":"Alura","motivo":"motivo"}],"proximos_passos":["a1","a2","a3"]}`;

      const payload = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiRes = await new Promise((resolve, reject) => {
        const apiReq = https.request(options, r => {
          let data = '';
          r.on('data', chunk => data += chunk);
          r.on('end', () => resolve({ status: r.statusCode, data }));
        });
        apiReq.on('error', reject);
        apiReq.write(payload);
        apiReq.end();
      });

      const apiData = JSON.parse(apiRes.data);
      const text = apiData?.content?.[0]?.text || '';
      const resultado = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json(resultado);

    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
