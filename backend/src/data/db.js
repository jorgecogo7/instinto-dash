const mysql = require('mysql2/promise');
const config = require('../config');

/**
 * Pool de conexões com o banco MySQL da Hostinger.
 *
 * Por que trocar o arquivo JSON por um banco de verdade: o arquivo
 * (accounts.json) vivia dentro da mesma pasta que o Git publica — e
 * toda vez que a Hostinger reimplanta o app a partir do repositório,
 * ela limpa arquivos que não estão no Git, apagando os clientes
 * cadastrados. Um banco de dados existe separado do código, então
 * nenhum deploy futuro consegue apagá-lo.
 */

let pool = null;
function getPool() {
  if (!pool) {
    if (!config.db.host) {
      throw new Error(
        'Banco de dados não configurado. Defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no .env ' +
        '(crie o banco em hPanel → Banco de dados).'
      );
    }
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(191) PRIMARY KEY,
        data JSON NOT NULL
      )
    `);
  }
  return tableReady;
}

// Tabela dos leads do módulo de Captação & CRM (funil comercial, separado
// da tabela "accounts" — que é só quem já é cliente pagante).
let leadsTableReady = null;
function ensureLeadsTable() {
  if (!leadsTableReady) {
    leadsTableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS leads (
        id VARCHAR(191) PRIMARY KEY,
        data JSON NOT NULL
      )
    `);
  }
  return leadsTableReady;
}

// Tabela dos contratos (módulo Contratos — vigência, renovação automática,
// alerta de vencimento). Separada de "accounts" porque um cliente pode, em
// tese, ter mais de um contrato ao longo do tempo (renegociação, upgrade).
let contractsTableReady = null;
function ensureContractsTable() {
  if (!contractsTableReady) {
    contractsTableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id VARCHAR(191) PRIMARY KEY,
        data JSON NOT NULL
      )
    `);
  }
  return contractsTableReady;
}

// Formulários próprios (estilo Typeform): definição, respostas e contadores
// diários (visitas, inícios, envios) pra taxa de conversão.
let formsTablesReady = null;
function ensureFormsTables() {
  if (!formsTablesReady) {
    const pool = getPool();
    formsTablesReady = Promise.all([
      pool.query(`
        CREATE TABLE IF NOT EXISTS forms (
          id VARCHAR(191) PRIMARY KEY,
          slug VARCHAR(191) NOT NULL UNIQUE,
          data JSON NOT NULL
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS form_responses (
          id VARCHAR(191) PRIMARY KEY,
          form_id VARCHAR(191) NOT NULL,
          created_at DATETIME NOT NULL,
          data JSON NOT NULL,
          INDEX idx_form_created (form_id, created_at)
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS form_stats (
          form_id VARCHAR(191) NOT NULL,
          day DATE NOT NULL,
          views INT NOT NULL DEFAULT 0,
          starts INT NOT NULL DEFAULT 0,
          completes INT NOT NULL DEFAULT 0,
          qualified INT NOT NULL DEFAULT 0,
          PRIMARY KEY (form_id, day)
        )
      `),
    ]);
  }
  return formsTablesReady;
}

// Relatórios automáticos (mensagem pronta por cliente e período).
let reportsTableReady = null;
function ensureReportsTable() {
  if (!reportsTableReady) {
    reportsTableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS reports (
        id VARCHAR(191) PRIMARY KEY,
        client_id VARCHAR(191) NOT NULL,
        period_key VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL,
        data JSON NOT NULL,
        UNIQUE KEY uniq_client_period (client_id, period_key)
      )
    `);
  }
  return reportsTableReady;
}

let healthTableReady = null;
// Saúde das contas (alertas de saldo, pagamento, reprovação, sem veicular).
function ensureHealthTable() {
  if (!healthTableReady) {
    healthTableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS account_health (
        client_id VARCHAR(191) PRIMARY KEY,
        checked_at DATETIME NOT NULL,
        data JSON NOT NULL
      )
    `);
  }
  return healthTableReady;
}

// CRM de cada cliente: funil (etapas) por cliente e os negócios/leads.
// Tudo indexado por client_id: toda consulta filtra pelo cliente, então um
// cliente nunca enxerga o CRM de outro.
let crmTablesReady = null;
function ensureCrmTables() {
  if (!crmTablesReady) {
    const pool = getPool();
    crmTablesReady = Promise.all([
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_pipelines (
          client_id VARCHAR(191) PRIMARY KEY,
          data JSON NOT NULL
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_deals (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          created_at DATETIME NOT NULL,
          data JSON NOT NULL,
          INDEX idx_crm_client (client_id, created_at)
        )
      `),
      // Configurações do CRM do cliente (etiquetas, WhatsApp).
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_settings (
          client_id VARCHAR(191) PRIMARY KEY,
          data JSON NOT NULL
        )
      `),
      // Contatos (pessoas). phone_key = só os dígitos do telefone, pra achar
      // o contato quando chega mensagem do WhatsApp.
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_contacts (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          phone_key VARCHAR(32) NULL,
          created_at DATETIME NOT NULL,
          data JSON NOT NULL,
          INDEX idx_crm_contacts_client (client_id, created_at),
          INDEX idx_crm_contacts_phone (client_id, phone_key)
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_conversations (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          contact_id VARCHAR(191) NOT NULL,
          last_at DATETIME NOT NULL,
          data JSON NOT NULL,
          INDEX idx_crm_conv_client (client_id, last_at),
          INDEX idx_crm_conv_contact (client_id, contact_id)
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_messages (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          conversation_id VARCHAR(191) NOT NULL,
          wa_id VARCHAR(191) NULL,
          created_at DATETIME(3) NOT NULL,
          data JSON NOT NULL,
          INDEX idx_crm_msg_conv (client_id, conversation_id, created_at),
          UNIQUE KEY uniq_crm_msg_wa (wa_id)
        )
      `),
      // Qual número de WhatsApp (phone_number_id da Meta) é de qual cliente.
      // Chave primária no número: um número só pode estar em um cliente.
      pool.query(`
        CREATE TABLE IF NOT EXISTS crm_wa_numbers (
          phone_number_id VARCHAR(64) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          INDEX idx_crm_wa_client (client_id)
        )
      `),
    ]);
  }
  return crmTablesReady;
}

// Campanhas (rascunhos que viram campanhas na Meta/Google depois da aprovação).
// Tudo indexado por client_id: toda consulta filtra pelo cliente.
// A coluna status existe fora do JSON pra permitir a troca atômica
// "aguardando aprovação" -> "publicando" (evita publicar duas vezes).
let campaignTablesReady = null;
function ensureCampaignTables() {
  if (!campaignTablesReady) {
    const pool = getPool();
    campaignTablesReady = Promise.all([
      pool.query(`
        CREATE TABLE IF NOT EXISTS campaign_drafts (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          status VARCHAR(32) NOT NULL,
          created_at DATETIME NOT NULL,
          data JSON NOT NULL,
          INDEX idx_campaign_client (client_id, created_at)
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS campaign_assets (
          id VARCHAR(191) PRIMARY KEY,
          client_id VARCHAR(191) NOT NULL,
          created_at DATETIME NOT NULL,
          mime VARCHAR(64) NOT NULL,
          name VARCHAR(191) NULL,
          size INT NOT NULL,
          data LONGBLOB NOT NULL,
          INDEX idx_asset_client (client_id)
        )
      `),
    ]);
  }
  return campaignTablesReady;
}

module.exports = { getPool, ensureTable, ensureLeadsTable, ensureContractsTable, ensureFormsTables, ensureReportsTable, ensureHealthTable, ensureCrmTables, ensureCampaignTables };
