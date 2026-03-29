# 📦 ValidaShelf 2.0 — Node.js

Sistema de validação de produtos via código de barras. Reescrito em **Node.js + Express + SQLite**.

## 🚀 Instalação e execução

### Pré-requisito
Ter o **Node.js** instalado → https://nodejs.org (baixe a versão LTS)

### 1. Instalar dependências
```bash
npm install
```

### 2. Iniciar o servidor
```bash
node server.js
```

Ou com **auto-reload** (reinicia ao salvar arquivos):
```bash
npm run dev
```

### 3. Acessar no navegador
```
http://localhost:3000
```

---

## 📁 Estrutura

```
validashelf_node/
├── server.js           ← Servidor principal (Express + rotas + SQLite)
├── package.json        ← Dependências do projeto
├── produtos.db         ← Banco de dados (criado automaticamente)
├── api_key.txt         ← Chave de integração (gerada automaticamente)
├── uploads/            ← Arquivos temporários de importação
└── public/
    └── index.html      ← Interface web
```

---

## 🔌 API REST para integração externa

Acesse `http://localhost:3000/api/integracao/info` para ver:
- Sua API Key
- Endpoints disponíveis
- Exemplo de cURL pronto para copiar

---

## 📦 Dependências

| Pacote | Para que serve |
|---|---|
| express | Servidor HTTP / rotas |
| better-sqlite3 | Banco SQLite (síncrono, rápido) |
| multer | Upload de arquivos |
| xlsx | Leitura/escrita de Excel e CSV |
| node-fetch | Busca na API Open Food Facts |
