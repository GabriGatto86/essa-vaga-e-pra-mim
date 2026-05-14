const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Scraping da vaga ──────────────────────────────────────────
async function scraperVaga(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(data);

    // remover scripts, styles e elementos desnecessários
    $('script, style, nav, footer, header, aside, iframe, img, svg').remove();

    // tentar pegar o conteúdo específico de vagas por plataforma
    let texto = '';

    // LinkedIn
    if (url.includes('linkedin.com')) {
      texto = $('.description__text').text() ||
              $('.show-more-less-html__markup').text() ||
              $('.jobs-description').text();
    }

    // Gupy
    if (url.includes('gupy.io') || url.includes('gupy.com')) {
      texto = $('[class*="job-description"]').text() ||
              $('[class*="JobDescription"]').text() ||
              $('main').text();
    }

    // Indeed
    if (url.includes('indeed.com') || url.includes('indeed.com.br')) {
      texto = $('#jobDescriptionText').text() ||
              $('[class*="jobsearch-jobDescriptionText"]').text();
    }

    // Catho
    if (url.includes('catho.com')) {
      texto = $('[class*="job-description"]').text() ||
              $('[class*="description"]').text();
    }

    // Fallback genérico
    if (!texto || texto.length < 100) {
      texto = $('main').text() || $('article').text() || $('body').text();
    }

    // limpar espaços em excesso
    texto = texto.replace(/\s+/g, ' ').trim().slice(0, 6000);

    return texto.length > 80 ? texto : null;

  } catch (e) {
    console.error('Scraping error:', e.message);
    return null;
  }
}

// ── Leitura do PDF ────────────────────────────────────────────
async function lerPDF(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text.slice(0, 8000);
  } catch (e) {
    return null;
  }
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    // Parsear multipart/form-data manualmente
    const contentType = req.headers['content-type'] || '';
    
    let vagaUrl = '';
    let cvTexto = '';
    let cvBase64 = '';
    let cvTipo = '';

    if (contentType.includes('application/json')) {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
      });
      vagaUrl = body.vagaUrl || '';
      cvTexto = body.cvTexto || '';
      cvBase64 = body.cvBase64 || '';
      cvTipo = body.cvTipo || '';
    }

    if (!vagaUrl) {
      return res.status(400).json({ error: 'Link da vaga não informado' });
    }

    // 1. Scraping da vaga
    console.log('Scraping:', vagaUrl);
    const vagaTexto = await scraperVaga(vagaUrl);

    // 2. Processar currículo
    let curriculoFinal = cvTexto;
    
    if (!curriculoFinal && cvBase64) {
      if (cvTipo === 'application/pdf') {
        const buffer = Buffer.from(cvBase64, 'base64');
        curriculoFinal = await lerPDF(buffer);
      } else {
        // TXT, DOC em texto
        curriculoFinal = Buffer.from(cvBase64, 'base64').toString('utf-8').slice(0, 8000);
      }
    }

    // 3. Montar prompt
    const vagaSection = vagaTexto
      ? `CONTEÚDO DA VAGA (extraído do link):\n${vagaTexto}`
      : `LINK DA VAGA: ${vagaUrl}\n[Não foi possível extrair o conteúdo — analise com base na URL e no currículo]`;

    const cvSection = curriculoFinal
      ? `CURRÍCULO DO CANDIDATO:\n${curriculoFinal}`
      : `[Currículo não pôde ser extraído — faça análise parcial baseada na vaga]`;

    const prompt = `Você é um especialista sênior em recrutamento e seleção com 20 anos de experiência no mercado brasileiro. Analise a compatibilidade com profundidade e honestidade.

${vagaSection}

${cvSection}

Retorne SOMENTE um JSON válido, sem texto antes ou depois, sem markdown, sem explicações:
{
  "score": [número inteiro de 0 a 100],
  "veredicto": "APROVADO" | "ATENÇÃO" | "NÃO RECOMENDADO",
  "resumo": "[2 frases diretas e honestas sobre a compatibilidade do candidato com a vaga]",
  "pontos_fortes": ["ponto forte específico 1", "ponto forte específico 2", "ponto forte específico 3"],
  "gaps": ["gap específico 1", "gap específico 2", "gap específico 3"],
  "cursos": [
    {"nome": "nome real do curso", "plataforma": "Coursera|Alura|LinkedIn Learning|YouTube|Udemy|DataTalks|dio.me", "motivo": "por que esse curso resolve o gap"},
    {"nome": "nome real do curso 2", "plataforma": "plataforma", "motivo": "motivo específico"}
  ],
  "proximos_passos": ["ação concreta e específica 1", "ação concreta e específica 2", "ação concreta e específica 3"]
}`;

    // 4. Chamar Claude
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.text || '';
    let resultado;
    try {
      resultado = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Erro ao processar resposta da IA. Tente novamente.' });
    }

    // adicionar metadados úteis
    resultado.vaga_lida = !!vagaTexto;
    resultado.cv_lido = !!curriculoFinal;

    return res.status(200).json(resultado);

  } catch (e) {
    console.error('Erro geral:', e);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em alguns instantes.' });
  }
};
