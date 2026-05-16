# Essa vaga é pra mim? 🎯

App de análise de compatibilidade entre candidato e vaga, usando IA (Claude da Anthropic).

Criado por **Gabriel Gatto**

---

## Como colocar no ar (Vercel) — 5 minutos

### 1. Crie uma conta na Vercel
Acesse [vercel.com](https://vercel.com) e crie uma conta gratuita (pode entrar com o GitHub).

### 2. Faça upload do projeto
- Clique em **"Add New Project"**
- Escolha **"Import Git Repository"** OU clique em **"Deploy without Git"**
- Se usar "Deploy without Git": arraste a pasta `essa-vaga-app` inteira

### 3. Configure a variável de ambiente
Antes de confirmar o deploy, adicione a variável:
- **Nome:** `ANTHROPIC_API_KEY`
- **Valor:** sua chave da API Anthropic (obtida em [console.anthropic.com](https://console.anthropic.com))

### 4. Clique em Deploy
Pronto! Em 1-2 minutos seu app estará no ar em:
`https://essa-vaga-e-pra-mim.vercel.app`

---

## Estrutura do projeto

```
essa-vaga-app/
├── api/
│   └── analisar.js      # Backend: scraping da vaga + leitura do PDF + IA
├── public/
│   └── index.html       # Frontend completo
├── package.json
├── vercel.json
└── README.md
```

---

## Como obter a chave da API Anthropic

1. Acesse [console.anthropic.com](https://console.anthropic.com)
2. Crie uma conta (tem créditos gratuitos iniciais)
3. Vá em **API Keys** → **Create Key**
4. Cole a chave na variável `ANTHROPIC_API_KEY` da Vercel

---

## Sobre o app

O candidato cola o link da vaga (LinkedIn, Gupy, Indeed, Catho, Infojobs etc.), anexa o currículo (PDF, TXT, DOC) e recebe:

- **Score de compatibilidade** (0-100%)
- **Veredicto:** Aprovado / Atenção / Não Recomendado
- **Pontos fortes** do perfil em relação à vaga
- **Gaps** que precisam ser desenvolvidos
- **Cursos recomendados** com plataforma e motivo
- **Próximos passos** concretos

---

*Dados não são armazenados. Análise feita em tempo real.*
