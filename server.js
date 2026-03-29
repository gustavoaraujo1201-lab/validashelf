const express    = require('express')
const sqlite3    = require('sqlite3').verbose()
const multer     = require('multer')
const fetch      = require('node-fetch')
const XLSX       = require('xlsx')
const nodemailer = require('nodemailer')
const crypto     = require('crypto')
const path       = require('path')
const fs         = require('fs')

const app      = express()
const PORT     = 3000
const DB_PATH  = path.join(__dirname, 'produtos.db')
const KEY_FILE = path.join(__dirname, 'api_key.txt')
const UPL_DIR  = path.join(__dirname, 'uploads')
const EMAIL_CFG= path.join(__dirname, 'email_config.json')

if (!fs.existsSync(UPL_DIR)) fs.mkdirSync(UPL_DIR)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
const upload = multer({ dest: UPL_DIR })

// ── Banco ─────────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH)
const run = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e?rej(e):res(this) }))
const get = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e?rej(e):res(r)))
const all = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,r) => e?rej(e):res(r)))

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_barras TEXT NOT NULL,
    nome TEXT DEFAULT '',
    marca TEXT DEFAULT '',
    categoria TEXT DEFAULT '',
    imagem_url TEXT DEFAULT '',
    quantidade INTEGER DEFAULT 0,
    validade TEXT DEFAULT '',
    alerta_dias INTEGER DEFAULT 30,
    criado_em TEXT DEFAULT (datetime('now','localtime')),
    atualizado_em TEXT DEFAULT (datetime('now','localtime'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    perfil TEXT DEFAULT 'operador',
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  )`)

  // Cria admin padrão se não existir
  db.get(`SELECT id FROM usuarios WHERE usuario='admin'`, [], (err, row) => {
    if (!row) {
      const hash = crypto.createHash('sha256').update('admin123').digest('hex')
      db.run(`INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?,?,?,?)`,
        ['Administrador', 'admin', hash, 'admin'])
      console.log('👤 Usuário admin criado — login: admin / senha: admin123')
    }
  })
})

// ── Sessões simples em memória ────────────────────────────────────────────────
const sessoes = {}

function gerarToken() {
  return crypto.randomBytes(32).toString('hex')
}

function autenticar(req, res, next) {
  const token = req.headers['x-session-token'] || req.cookies?.session
  if (token && sessoes[token]) {
    req.usuario = sessoes[token]
    return next()
  }
  res.status(401).json({ ok: false, erro: 'Não autenticado' })
}

// Parse de cookies simples
app.use((req, res, next) => {
  const raw = req.headers.cookie || ''
  req.cookies = {}
  raw.split(';').forEach(c => {
    const [k, v] = c.trim().split('=')
    if (k) req.cookies[k.trim()] = decodeURIComponent(v || '')
  })
  next()
})

// ── API Key ───────────────────────────────────────────────────────────────────
let API_KEY = fs.existsSync(KEY_FILE)
  ? fs.readFileSync(KEY_FILE, 'utf8').trim()
  : (() => { const k = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(KEY_FILE,k); return k })()

// ── Helpers gerais ────────────────────────────────────────────────────────────
function parseDate(v) {
  if (!v) return null
  v = String(v).split(' ')[0].trim()
  const fmts = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, m=>`${m[1]}-${m[2]}-${m[3]}`],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, m=>`${m[3]}-${m[2]}-${m[1]}`],
    [/^(\d{2})-(\d{2})-(\d{4})$/, m=>`${m[3]}-${m[2]}-${m[1]}`],
    [/^(\d{8})$/, ()=>`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`],
  ]
  for (const [re,fn] of fmts) { const m=v.match(re); if(m&&!isNaN(new Date(fn(m)))) return fn(m) }
  return null
}

const ALIASES = {
  codigo_barras: ['codigo_barras','codigo','ean','barcode','cod_barras'],
  nome:          ['nome','name','produto','descricao','description','desc'],
  marca:         ['marca','brand','fabricante'],
  categoria:     ['categoria','category','grupo'],
  quantidade:    ['quantidade','qty','qtd','estoque','saldo'],
  validade:      ['validade','vencimento','data_validade','dt_validade','expiry'],
  alerta_dias:   ['alerta_dias','alerta','dias_alerta'],
}
function gv(row, campo, def='') {
  for (const a of ALIASES[campo])
    for (const k of Object.keys(row))
      if (k.trim().toLowerCase()===a && row[k]!=null && row[k]!=='') return String(row[k]).trim()
  return def
}

function calcDias(produtos) {
  const hoje = new Date(); hoje.setHours(0,0,0,0)
  return produtos.map(p => ({
    ...p,
    dias_restantes: p.validade ? Math.round((new Date(p.validade+'T00:00:00')-hoje)/86400000) : null
  }))
}

function statusProduto(dias) {
  if (dias === null) return 'SEM DATA'
  if (dias < 0)     return 'VENCIDO'
  if (dias <= 7)    return 'CRÍTICO'
  if (dias <= 30)   return 'ATENÇÃO'
  return 'OK'
}

async function importarLista(rows) {
  let ok=0; const erros=[]
  for (let i=0;i<rows.length;i++) {
    const r=rows[i], linha=i+2
    try {
      const codigo=gv(r,'codigo_barras'), nome=gv(r,'nome')
      if (!codigo||!nome) { erros.push(`Linha ${linha}: código ou nome ausente`); continue }
      const val=parseDate(gv(r,'validade'))
      if (!val) { erros.push(`Linha ${linha}: validade inválida`); continue }
      const qtd=parseInt(gv(r,'quantidade','1'))||1
      const ald=parseInt(gv(r,'alerta_dias','30'))||30
      await run(`INSERT INTO produtos (codigo_barras,nome,marca,categoria,quantidade,validade,alerta_dias) VALUES (?,?,?,?,?,?,?)`,
        [codigo,nome,gv(r,'marca'),gv(r,'categoria'),qtd,val,ald])
      ok++
    } catch(e) { erros.push(`Linha ${linha}: ${e.message}`) }
  }
  return {ok,erros}
}

async function buscarOFF(codigo) {
  try {
    const r=await fetch(`https://world.openfoodfacts.org/api/v0/product/${codigo}.json`,{timeout:5000})
    const d=await r.json()
    if (d.status===1) {
      const p=d.product, cat=(p.categories_tags||[])[0]||''
      return { encontrado:true, nome:p.product_name_pt||p.product_name_br||p.product_name||'Produto sem nome',
        marca:p.brands||'', categoria:cat.replace(/^en:/,'').replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase()),
        imagem_url:p.image_url||'' }
    }
  } catch {}
  return {encontrado:false}
}

// ── E-mail ────────────────────────────────────────────────────────────────────
function getEmailCfg() {
  if (!fs.existsSync(EMAIL_CFG)) return null
  try { return JSON.parse(fs.readFileSync(EMAIL_CFG,'utf8')) } catch { return null }
}

function createTransporter(cfg) {
  const smtpMap = {
    gmail:   { host:'smtp.gmail.com',          port:587 },
    outlook: { host:'smtp-mail.outlook.com',   port:587 },
    custom:  { host:cfg.smtp_host||'',         port:parseInt(cfg.smtp_port)||587 },
  }
  const smtp = smtpMap[cfg.provider] || smtpMap.custom
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: false,
    auth: { user: cfg.email_usuario, pass: cfg.email_senha },
    tls: { rejectUnauthorized: false }
  })
}

// Gera Excel buffer com relatório
async function gerarExcel(produtos) {
  const hoje = new Date(); hoje.setHours(0,0,0,0)
  const com = calcDias(produtos)
  const emAlerta = com.filter(p => p.dias_restantes !== null && p.dias_restantes <= (p.alerta_dias||30))

  const wb = XLSX.utils.book_new()

  // Aba 1 — Em alerta
  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Código de Barras','Nome','Marca','Categoria','Quantidade','Validade','Dias Restantes','Status'],
    ...emAlerta.map(p => [p.codigo_barras,p.nome,p.marca,p.categoria,p.quantidade,
      p.validade,p.dias_restantes,statusProduto(p.dias_restantes)])
  ])
  ws1['!cols'] = [14,30,15,15,10,12,14,10].map(w=>({wch:w}))
  XLSX.utils.book_append_sheet(wb, ws1, 'Em Alerta')

  // Aba 2 — Todos
  const todos = await all('SELECT * FROM produtos ORDER BY validade ASC')
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['Código de Barras','Nome','Marca','Categoria','Quantidade','Validade','Dias Restantes','Status'],
    ...calcDias(todos).map(p => [p.codigo_barras,p.nome,p.marca,p.categoria,p.quantidade,
      p.validade,p.dias_restantes??'—',statusProduto(p.dias_restantes)])
  ])
  ws2['!cols'] = [14,30,15,15,10,12,14,10].map(w=>({wch:w}))
  XLSX.utils.book_append_sheet(wb, ws2, 'Todos os Produtos')

  return { buffer: XLSX.write(wb,{type:'buffer',bookType:'xlsx'}), emAlerta }
}

// Gera HTML do relatório (base para PDF via impressão)
function gerarHtmlRelatorio(emAlerta, todos) {
  const hoje = new Date().toLocaleDateString('pt-BR')
  const corStatus = { VENCIDO:'#ff3860', CRÍTICO:'#ff3860', ATENÇÃO:'#ffd60a', OK:'#00e5a0' }

  const linhas = (lista) => lista.map(p => {
    const s = statusProduto(p.dias_restantes)
    const cor = corStatus[s]||'#6b7590'
    return `<tr>
      <td style="font-family:monospace;font-size:11px;">${p.codigo_barras}</td>
      <td><strong>${p.nome}</strong><br><small style="color:#666">${p.marca||''}</small></td>
      <td>${p.categoria||'—'}</td>
      <td style="text-align:center">${p.quantidade}</td>
      <td>${p.validade||'—'}</td>
      <td style="text-align:center"><strong>${p.dias_restantes??'—'}</strong></td>
      <td><span style="background:${cor}22;color:${cor};border:1px solid ${cor}44;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">${s}</span></td>
    </tr>`
  }).join('')

  const tabela = (titulo, lista, cor) => `
    <h3 style="color:${cor};margin:24px 0 8px;">${titulo} (${lista.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">Código</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">Produto</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">Categoria</th>
        <th style="padding:8px;text-align:center;border-bottom:2px solid #ddd;">Qtd</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">Validade</th>
        <th style="padding:8px;text-align:center;border-bottom:2px solid #ddd;">Dias</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">Status</th>
      </tr></thead>
      <tbody>${linhas(lista)}</tbody>
    </table>`

  const vencidos  = emAlerta.filter(p=>statusProduto(p.dias_restantes)==='VENCIDO')
  const criticos  = emAlerta.filter(p=>statusProduto(p.dias_restantes)==='CRÍTICO')
  const atencao   = emAlerta.filter(p=>statusProduto(p.dias_restantes)==='ATENÇÃO')

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body{font-family:Arial,sans-serif;margin:0;padding:24px;color:#222;}
    h1{color:#00b37a;} h2{color:#444;border-bottom:2px solid #eee;padding-bottom:8px;}
    .resumo{display:flex;gap:16px;margin:16px 0;}
    .card{flex:1;padding:14px;border-radius:8px;text-align:center;}
    .card .num{font-size:28px;font-weight:bold;} .card .label{font-size:11px;opacity:.8;}
    tr:nth-child(even) td{background:#fafafa;} td{padding:7px 8px;border-bottom:1px solid #eee;}
    @media print{body{padding:0;} h1{font-size:18px;}}
  </style></head><body>
  <h1>📦 ValidaShelf — Relatório de Validade</h1>
  <p style="color:#666;">Gerado em: <strong>${hoje}</strong> &nbsp;|&nbsp; Total em alerta: <strong>${emAlerta.length}</strong> produto(s)</p>
  <div class="resumo">
    <div class="card" style="background:#ff386015;border:1px solid #ff386040;color:#cc1f3f">
      <div class="num">${vencidos.length}</div><div class="label">VENCIDOS</div>
    </div>
    <div class="card" style="background:#ff386015;border:1px solid #ff386040;color:#cc1f3f">
      <div class="num">${criticos.length}</div><div class="label">CRÍTICOS ≤7d</div>
    </div>
    <div class="card" style="background:#ffd60a15;border:1px solid #ffd60a40;color:#997a00">
      <div class="num">${atencao.length}</div><div class="label">ATENÇÃO</div>
    </div>
    <div class="card" style="background:#00e5a015;border:1px solid #00e5a040;color:#007a55">
      <div class="num">${todos.length}</div><div class="label">TOTAL ESTOQUE</div>
    </div>
  </div>
  ${vencidos.length  ? tabela('🔴 Vencidos',  calcDias(vencidos),  '#ff3860') : ''}
  ${criticos.length  ? tabela('🟡 Críticos',  calcDias(criticos),  '#ff3860') : ''}
  ${atencao.length   ? tabela('🟠 Atenção',   calcDias(atencao),   '#ffd60a') : ''}
  ${emAlerta.length===0 ? '<p style="color:#00b37a;font-size:16px;margin-top:32px;">✅ Nenhum produto próximo ao vencimento!</p>' : ''}
  </body></html>`
}

// Envia e-mail com Excel + PDF (HTML como anexo imprimível)
async function enviarAlerta(cfg, produto=null, manual=false) {
  const transporter = createTransporter(cfg)
  const todos = await all('SELECT * FROM produtos ORDER BY validade ASC')
  const todosComDias = calcDias(todos)
  const emAlerta = todosComDias.filter(p => p.dias_restantes !== null && p.dias_restantes <= (p.alerta_dias||30))

  const { buffer: xlsxBuf } = await gerarExcel(todos)
  const htmlRelatorio = gerarHtmlRelatorio(emAlerta, todosComDias)
  const hoje = new Date().toLocaleDateString('pt-BR')

  let assunto, intro
  if (produto && !manual) {
    const dias = produto.dias_restantes
    const s = statusProduto(dias)
    assunto = `⚠ ValidaShelf — Produto ${s}: ${produto.nome} (${dias}d restantes)`
    intro = `<p>O produto <strong>${produto.nome}</strong> foi cadastrado/editado e está com validade próxima:</p>
      <div style="background:#ffd60a18;border:1px solid #ffd60a44;border-radius:8px;padding:14px;margin:12px 0;">
        <strong style="color:#997a00">⚠ ${produto.nome}</strong><br>
        Validade: <strong>${produto.validade}</strong> &nbsp;|&nbsp; Dias restantes: <strong>${dias}</strong><br>
        Status: <strong style="color:${dias<0?'#ff3860':dias<=7?'#ff3860':'#ffd60a'}">${s}</strong>
      </div>`
  } else {
    assunto = `📦 ValidaShelf — Relatório Manual (${hoje})`
    intro = `<p>Segue o relatório completo de produtos com validade próxima gerado em ${hoje}.</p>`
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#0d0f14;padding:20px 24px;border-radius:10px 10px 0 0;">
        <h2 style="color:#00e5a0;margin:0;">📦 ValidaShelf</h2>
        <p style="color:#6b7590;margin:4px 0 0;font-size:13px;">Sistema de Controle de Validade</p>
      </div>
      <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-radius:0 0 10px 10px;">
        ${intro}
        <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:14px;margin:16px 0;">
          <strong>📊 Resumo do estoque:</strong><br>
          🔴 Vencidos: <strong>${emAlerta.filter(p=>p.dias_restantes<0).length}</strong> &nbsp;
          🟡 Críticos: <strong>${emAlerta.filter(p=>p.dias_restantes>=0&&p.dias_restantes<=7).length}</strong> &nbsp;
          🟠 Atenção: <strong>${emAlerta.filter(p=>p.dias_restantes>7).length}</strong> &nbsp;
          📦 Total: <strong>${todos.length}</strong>
        </div>
        <p style="color:#666;font-size:12px;">📎 Anexos: relatório Excel (.xlsx) e relatório PDF (.html imprimível)</p>
        <p style="color:#999;font-size:11px;">ValidaShelf — ${hoje}</p>
      </div>
    </div>`

  await transporter.sendMail({
    from: `"ValidaShelf" <${cfg.email_usuario}>`,
    to: cfg.email_destino,
    subject: assunto,
    html,
    attachments: [
      {
        filename: `relatorio_${hoje.replace(/\//g,'-')}.xlsx`,
        content: xlsxBuf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      },
      {
        filename: `relatorio_${hoje.replace(/\//g,'-')}.html`,
        content: htmlRelatorio,
        contentType: 'text/html'
      }
    ]
  })

  console.log(`✅ E-mail enviado para ${cfg.email_destino}`)
}

// Verifica se produto precisa de alerta e envia se sim
async function verificarEEnviarAlerta(produto) {
  const cfg = getEmailCfg()
  if (!cfg || !cfg.email_usuario || !cfg.email_senha) return
  const hoje = new Date(); hoje.setHours(0,0,0,0)
  if (!produto.validade) return
  const dias = Math.round((new Date(produto.validade+'T00:00:00') - hoje) / 86400000)
  produto.dias_restantes = dias
  if (dias <= (produto.alerta_dias || 30)) {
    setImmediate(async () => {
      try { await enviarAlerta(cfg, produto, false) }
      catch(e) { console.error('❌ Erro ao enviar alerta:', e.message) }
    })
  }
}

// ── Gera código interno sequencial ───────────────────────────────────────────
async function gerarCodigoInterno() {
  const row = await get(`SELECT codigo_barras FROM produtos WHERE codigo_barras LIKE 'INT-%' ORDER BY id DESC LIMIT 1`)
  if (!row) return 'INT-00001'
  const num = parseInt(row.codigo_barras.replace('INT-','')) || 0
  return 'INT-' + String(num + 1).padStart(5, '0')
}

// ── Rotas públicas (login) ────────────────────────────────────────────────────
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')))
app.get('/login', (req,res) => res.sendFile(path.join(__dirname,'public','login.html')))

app.post('/api/login', async (req,res) => {
  const { usuario, senha } = req.body
  if (!usuario || !senha) return res.json({ ok:false, erro:'Preencha usuário e senha' })
  const hash = crypto.createHash('sha256').update(senha).digest('hex')
  const user = await get(`SELECT * FROM usuarios WHERE usuario=? AND senha_hash=?`, [usuario, hash])
  if (!user) return res.json({ ok:false, erro:'Usuário ou senha incorretos' })
  const token = gerarToken()
  sessoes[token] = { id:user.id, nome:user.nome, usuario:user.usuario, perfil:user.perfil }
  res.json({ ok:true, token, nome:user.nome, perfil:user.perfil })
})

app.post('/api/logout', (req,res) => {
  const token = req.headers['x-session-token']
  if (token) delete sessoes[token]
  res.json({ ok:true })
})

app.get('/api/me', autenticar, (req,res) => {
  res.json({ ok:true, usuario:req.usuario })
})

// ── Rotas de usuários (apenas admin) ─────────────────────────────────────────
function apenasAdmin(req, res, next) {
  if (req.usuario?.perfil !== 'admin') return res.status(403).json({ ok:false, erro:'Acesso restrito ao administrador' })
  next()
}

app.get('/api/usuarios', autenticar, apenasAdmin, async (req,res) => {
  const lista = await all(`SELECT id, nome, usuario, perfil, criado_em FROM usuarios ORDER BY id ASC`)
  res.json({ ok:true, usuarios:lista })
})

app.post('/api/usuarios', autenticar, apenasAdmin, async (req,res) => {
  const { nome, usuario, senha, perfil } = req.body
  if (!nome || !usuario || !senha) return res.json({ ok:false, erro:'Preencha nome, usuário e senha' })
  const hash = crypto.createHash('sha256').update(senha).digest('hex')
  try {
    await run(`INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?,?,?,?)`,
      [nome, usuario, hash, perfil||'operador'])
    res.json({ ok:true })
  } catch(e) {
    res.json({ ok:false, erro:'Usuário já existe' })
  }
})

app.put('/api/usuarios/:id', autenticar, apenasAdmin, async (req,res) => {
  const { nome, senha, perfil } = req.body
  const atual = await get(`SELECT * FROM usuarios WHERE id=?`, [req.params.id])
  if (!atual) return res.json({ ok:false, erro:'Não encontrado' })
  const hash = senha ? crypto.createHash('sha256').update(senha).digest('hex') : atual.senha_hash
  await run(`UPDATE usuarios SET nome=?, senha_hash=?, perfil=? WHERE id=?`,
    [nome||atual.nome, hash, perfil||atual.perfil, req.params.id])
  res.json({ ok:true })
})

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, async (req,res) => {
  if (parseInt(req.params.id) === req.usuario.id) return res.json({ ok:false, erro:'Não pode excluir seu próprio usuário' })
  await run(`DELETE FROM usuarios WHERE id=?`, [req.params.id])
  res.json({ ok:true })
})

// Gera e retorna um novo código interno disponível
app.get('/api/codigo-interno', autenticar, async (req,res) => {
  const codigo = await gerarCodigoInterno()
  res.json({ codigo })
})

app.get('/api/buscar/:codigo', autenticar, async (req,res) => {
  const [local, api_info] = await Promise.all([
    all('SELECT * FROM produtos WHERE codigo_barras=? ORDER BY validade ASC',[req.params.codigo]),
    buscarOFF(req.params.codigo)
  ])
  res.json({ fonte:local.length?'local':'api', produtos:local, api_info })
})

app.post('/api/produto', autenticar, async (req,res) => {
  const d=req.body
  const info=await run(
    `INSERT INTO produtos (codigo_barras,nome,marca,categoria,imagem_url,quantidade,validade,alerta_dias) VALUES (?,?,?,?,?,?,?,?)`,
    [d.codigo_barras,d.nome,d.marca||'',d.categoria||'',d.imagem_url||'',d.quantidade||1,d.validade,d.alerta_dias||30]
  )
  const novo = await get('SELECT * FROM produtos WHERE id=?',[info.lastID])
  verificarEEnviarAlerta(novo)
  res.json({ok:true, id:info.lastID})
})

app.put('/api/produto/:id', autenticar, async (req,res) => {
  const {id}=req.params, d=req.body
  const atual=await get('SELECT * FROM produtos WHERE id=?',[id])
  if (!atual) return res.status(404).json({ok:false,erro:'Não encontrado'})
  const nome      = (d.nome      !== undefined && d.nome      !== '') ? d.nome      : atual.nome
  const marca     = d.marca     !== undefined ? d.marca     : atual.marca
  const categoria = d.categoria !== undefined ? d.categoria : atual.categoria
  const quantidade  = d.quantidade  ?? atual.quantidade
  const validade    = d.validade    || atual.validade
  const alerta_dias = d.alerta_dias || atual.alerta_dias
  await run(
    `UPDATE produtos SET nome=?,marca=?,categoria=?,quantidade=?,validade=?,alerta_dias=?,atualizado_em=datetime('now','localtime') WHERE id=?`,
    [nome,marca,categoria,quantidade,validade,alerta_dias,id]
  )
  const atualizado = await get('SELECT * FROM produtos WHERE id=?',[id])
  verificarEEnviarAlerta(atualizado)
  res.json({ok:true, produto:atualizado})
})

app.delete('/api/produto/:id', autenticar, async (req,res) => {
  await run('DELETE FROM produtos WHERE id=?',[req.params.id])
  res.json({ok:true})
})

app.get('/api/dashboard', autenticar, async (req,res) => {
  const todos = calcDias(await all('SELECT * FROM produtos ORDER BY validade ASC'))
  const vencidos=[],criticos=[],atencao=[],ok=[]
  for (const p of todos) {
    const d=p.dias_restantes
    if (d===null) ok.push(p)
    else if (d<0)  vencidos.push(p)
    else if (d<=7) criticos.push(p)
    else if (d<=p.alerta_dias) atencao.push(p)
    else ok.push(p)
  }
  res.json({totais:{vencidos:vencidos.length,criticos:criticos.length,atencao:atencao.length,ok:ok.length},
    vencidos,criticos,atencao,ok})
})

app.get('/api/exportar', autenticar, async (req,res) => {
  const produtos=await all('SELECT * FROM produtos ORDER BY validade ASC')
  const header='Código de Barras,Nome,Marca,Categoria,Quantidade,Validade,Alerta (dias)'
  const rows=calcDias(produtos).map(p=>[p.codigo_barras,`"${p.nome}"`,`"${p.marca}"`,`"${p.categoria}"`,
    p.quantidade,p.validade,p.alerta_dias].join(','))
  const ts=new Date().toISOString().slice(0,16).replace(/[T:]/g,'-')
  res.setHeader('Content-Type','text/csv; charset=utf-8')
  res.setHeader('Content-Disposition',`attachment; filename="produtos_${ts}.csv"`)
  res.send('\uFEFF'+[header,...rows].join('\n'))
})

// ── Relatórios para download ──────────────────────────────────────────────────
app.get('/api/relatorio/excel', autenticar, async (req,res) => {
  const todos=await all('SELECT * FROM produtos ORDER BY validade ASC')
  const {buffer}=await gerarExcel(todos)
  const hoje=new Date().toLocaleDateString('pt-BR').replace(/\//g,'-')
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition',`attachment; filename="relatorio_${hoje}.xlsx"`)
  res.send(buffer)
})

app.get('/api/relatorio/pdf', autenticar, async (req,res) => {
  const todos=await all('SELECT * FROM produtos ORDER BY validade ASC')
  const todosComDias=calcDias(todos)
  const emAlerta=todosComDias.filter(p=>p.dias_restantes!==null&&p.dias_restantes<=(p.alerta_dias||30))
  const html=gerarHtmlRelatorio(emAlerta,todosComDias)
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(html + `<script>window.onload=()=>window.print()</script>`)
})

// ── Importação ────────────────────────────────────────────────────────────────
app.post('/api/importar/csv', autenticar, upload.single('arquivo'), async (req,res) => {
  if (!req.file) return res.json({ok:false,erro:'Nenhum arquivo enviado'})
  try {
    const wb=XLSX.readFile(req.file.path,{raw:false})
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''})
    fs.unlinkSync(req.file.path)
    const {ok,erros}=await importarLista(rows)
    res.json({ok:true,importados:ok,erros,total:rows.length})
  } catch(e) { res.json({ok:false,erro:e.message}) }
})

app.post('/api/importar/excel', autenticar, upload.single('arquivo'), async (req,res) => {
  if (!req.file) return res.json({ok:false,erro:'Nenhum arquivo enviado'})
  try {
    const wb=XLSX.readFile(req.file.path,{cellDates:true})
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''})
    fs.unlinkSync(req.file.path)
    const {ok,erros}=await importarLista(rows)
    res.json({ok:true,importados:ok,erros,total:rows.length})
  } catch(e) { res.json({ok:false,erro:e.message}) }
})

app.get('/api/template/csv', (req,res) => {
  res.setHeader('Content-Type','text/csv')
  res.setHeader('Content-Disposition','attachment; filename="template.csv"')
  res.send('\uFEFF'+'codigo_barras,nome,marca,categoria,quantidade,validade,alerta_dias\n7891000100103,Leite Ninho,Nestlé,Laticínios,50,2025-12-01,30')
})

app.get('/api/template/excel', (req,res) => {
  const wb=XLSX.utils.book_new()
  const ws=XLSX.utils.aoa_to_sheet([
    ['codigo_barras','nome','marca','categoria','quantidade','validade','alerta_dias'],
    ['7891000100103','Leite Ninho','Nestlé','Laticínios',50,'2025-12-01',30]
  ])
  XLSX.utils.book_append_sheet(wb,ws,'Produtos')
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition','attachment; filename="template.xlsx"')
  res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))
})

// ── Config e-mail ─────────────────────────────────────────────────────────────
app.get('/api/email/config', autenticar, (req,res) => {
  const cfg=getEmailCfg()
  if (!cfg) return res.json({ok:true,configurado:false})
  const {email_senha,...safe}=cfg
  res.json({ok:true,configurado:true,config:{...safe,email_senha:''}})
})

app.post('/api/email/config', autenticar, (req,res) => {
  const cfg=req.body
  if (!cfg.email_usuario||!cfg.email_destino) return res.json({ok:false,erro:'Preencha e-mail remetente e destinatário'})
  fs.writeFileSync(EMAIL_CFG,JSON.stringify(cfg,null,2))
  res.json({ok:true})
})

app.post('/api/email/testar', autenticar, async (req,res) => {
  const cfg=getEmailCfg()
  if (!cfg) return res.json({ok:false,erro:'Configure o e-mail primeiro'})
  try { await enviarAlerta(cfg,null,true); res.json({ok:true}) }
  catch(e) { res.json({ok:false,erro:e.message}) }
})

app.post('/api/email/enviar', autenticar, async (req,res) => {
  const cfg=getEmailCfg()
  if (!cfg) return res.json({ok:false,erro:'Configure o e-mail primeiro'})
  try { await enviarAlerta(cfg,null,true); res.json({ok:true}) }
  catch(e) { res.json({ok:false,erro:e.message}) }
})

// ── API externa ───────────────────────────────────────────────────────────────
function checkKey(req,res,next) {
  if (req.headers['x-api-key']!==API_KEY) return res.status(401).json({ok:false,erro:'API Key inválida'})
  next()
}
app.post('/api/integracao/produtos', checkKey, async (req,res) => {
  let data=req.body; if (!data) return res.json({ok:false,erro:'Body vazio'})
  if (!Array.isArray(data)) data=[data]
  const {ok,erros}=await importarLista(data)
  res.json({ok:true,importados:ok,erros,total:data.length})
})
app.get('/api/integracao/produtos', checkKey, async (req,res) => {
  res.json({ok:true,produtos:await all('SELECT * FROM produtos ORDER BY validade ASC')})
})
app.get('/api/integracao/info', (req,res) => {
  res.json({api_key:API_KEY,base_url:`http://localhost:${PORT}`,
    endpoints:{'POST /api/integracao/produtos':'Envia produtos','GET /api/integracao/produtos':'Lista produtos'}})
})

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ValidaShelf rodando em http://localhost:${PORT}`)
  console.log(`🔑 API Key: ${API_KEY}\n`)
})
