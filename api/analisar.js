const https = require('https');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

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
        } else if (cvTipo && (cvTipo.includes('word') || cvTipo.includes('docx') || cvTipo.includes('doc'))) {
          const result = await mammoth.extractRawText({ buffer });
          cvTexto = result.value.slice(0, 6000);
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
